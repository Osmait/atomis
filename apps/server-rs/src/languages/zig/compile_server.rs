//! Zig's compiler kept running between runs, rebuilding incrementally.
//!
//! `zig build` starts a compiler that analyses the whole program from
//! scratch on every run: ~600 ms and over a CPU-second for a one-line edit,
//! by far the most expensive run of any language here. The compiler also
//! has a server mode (`--listen=-`, what `zig build --watch` uses): it stays
//! up, keeps its analysis in memory, and on each `update` message redoes
//! only what the edit touched. Measured on a session workspace: 3-15 ms per
//! update after a ~450 ms first build, with probe output byte-identical to
//! a full rebuild across every edit tried.
//!
//! Two constraints decide when this path is taken (`eligible`):
//!
//! * Incremental linking against libc is not finished in Zig 0.16 (the
//!   binary fails with "undefined symbol: main"), so the server builds
//!   without libc. The runtime only ever needed libc for one `write`, which
//!   it now issues directly on Linux; elsewhere libc is mandatory and the
//!   classic build stays. A program that wants libc itself is detected
//!   from the compiler's answer and sent back to the classic build.
//! * The server compiles one module, so package dependencies — wired into
//!   the module by `build.zig` — keep a session on `zig build`. Tests do
//!   not: they get a second server (`zig test` with the session's test
//!   runner), built in parallel with the program.
//!
//! Anything unexpected — a crash, a protocol error, a timeout — kills the
//! server and the run falls back to `zig build`, so the worst case is the
//! old speed. A server costs ~120 MB while it lives; one unused for
//! `IDLE` is stopped and the next run starts a new one.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::exec::sandbox::SandboxPolicy;

/// What a server builds: the instrumented program, or the test binary.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Program,
    Tests,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Program => "atomis-session",
            Kind::Tests => "atomis-tests",
        }
    }

    /// The compiler invocation, the same build `build.zig` describes.
    fn args(self, root: &Path) -> Vec<String> {
        let path = |file: &str| root.join(file).to_string_lossy().into_owned();
        let mut args: Vec<String> = match self {
            Kind::Program => vec!["build-exe".into(), format!("-Mroot={}", path("generated/main.zig"))],
            Kind::Tests => vec![
                "test".into(),
                format!("-Mroot={}", path("test_root.zig")),
                "--test-runner".into(),
                path("runzig_test_runner.zig"),
            ],
        };
        args.extend(
            ["-ODebug", "-fincremental", "--listen=-", "--cache-dir", ".zig-cache", "--name", self.name()]
                .map(String::from),
        );
        args
    }
}
/// Same ceiling as the classic compile.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long an unused server keeps its memory.
pub const IDLE: Duration = Duration::from_secs(600);

// Client → compiler and compiler → client message tags (std/zig/Client.zig
// and std/zig/Server.zig).
const CLIENT_EXIT: u32 = 0;
const CLIENT_UPDATE: u32 = 1;
const SERVER_ZIG_VERSION: u32 = 0;
const SERVER_ERROR_BUNDLE: u32 = 1;
const SERVER_EMIT_DIGEST: u32 = 2;
/// Larger messages mean a confused stream, not a real answer.
const MAX_MESSAGE: usize = 64 * 1024 * 1024;

struct Server {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    /// Whatever must stay the same for this server to be reusable: the
    /// sandbox it was confined with.
    key: String,
    last_used: Instant,
}

/// A session's server, empty between a failure and the next run.
type Slot = Arc<Mutex<Option<Server>>>;

static SERVERS: LazyLock<Mutex<HashMap<String, Slot>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Sessions whose program needs libc: the classic build for those.
static NEEDS_LIBC: LazyLock<std::sync::Mutex<HashSet<String>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashSet::new()));

pub enum Update {
    /// The program compiled; this is the executable.
    Built(PathBuf),
    /// It did not; the errors, in the compiler's own text format.
    Failed(String),
}

/// Whether this session's run can use the server at all.
pub async fn eligible(session_id: &str, root: &Path) -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    if std::env::var("ATOMIS_ZIG_INCREMENTAL").is_ok_and(|value| value.trim() == "0") {
        return false;
    }
    if NEEDS_LIBC
        .lock()
        .is_ok_and(|sessions| sessions.contains(session_id))
    {
        return false;
    }
    let manifest = tokio::fs::read_to_string(root.join("build.zig.zon"))
        .await
        .unwrap_or_default();
    !declares_dependencies(&manifest)
}

/// A manifest whose `.dependencies` names any package (by `.url` or
/// `.path`): those are wired into the module by `build.zig`.
fn declares_dependencies(manifest: &str) -> bool {
    manifest.split_once(".dependencies").is_some_and(|(_, rest)| {
        rest.contains(".url") || rest.contains(".path") || rest.contains(".hash")
    })
}

/// The compiler refuses a program that needs libc when it was not asked
/// to link it; this is how a session discovers it needs the classic build.
fn wants_libc(errors: &str) -> bool {
    errors.contains("dependency on libc must be explicitly specified")
        || errors.contains("requires libc")
}

/// Runs one build of `root/generated/main.zig`. `None` means "use the
/// classic build instead" — the server failed, or the program needs libc —
/// and the caller should fall back without reporting anything.
pub async fn update(
    session_id: &str,
    kind: Kind,
    root: &Path,
    sandbox: Option<&Arc<SandboxPolicy>>,
    cancel: &CancellationToken,
) -> Option<Update> {
    let key = sandbox.map_or_else(|| "none".to_string(), |policy| format!("{:?}", policy.as_ref()));
    let slot = {
        let mut servers = SERVERS.lock().await;
        Arc::clone(servers.entry(slot_key(session_id, kind)).or_default())
    };
    let mut slot = slot.lock().await;
    if slot.as_ref().is_some_and(|server| server.key != key) {
        if let Some(server) = slot.take() {
            shut_down(server).await;
        }
    }
    if slot.is_none() {
        match spawn(kind, root, sandbox, key).await {
            Ok(server) => *slot = Some(server),
            Err(error) => {
                tracing::warn!(%error, "zig compile server failed to start");
                return None;
            }
        }
    }
    let server = slot.as_mut()?;
    server.last_used = Instant::now();
    let answer = tokio::select! {
        answer = tokio::time::timeout(UPDATE_TIMEOUT, request_update(server)) => answer,
        () = cancel.cancelled() => {
            // Mid-update the stream cannot be resynchronised; start over.
            if let Some(server) = slot.take() {
                shut_down(server).await;
            }
            return None;
        }
    };
    match answer {
        Ok(Ok(BuildAnswer::Built(digest))) => Some(Update::Built(
            root.join(".zig-cache/o").join(digest).join(kind.name()),
        )),
        Ok(Ok(BuildAnswer::Failed(errors))) => {
            if wants_libc(&errors) {
                if let Ok(mut sessions) = NEEDS_LIBC.lock() {
                    sessions.insert(session_id.to_string());
                }
                if let Some(server) = slot.take() {
                    shut_down(server).await;
                }
                return None;
            }
            Some(Update::Failed(errors))
        }
        Ok(Err(error)) => {
            tracing::warn!(%error, "zig compile server failed; falling back to zig build");
            if let Some(server) = slot.take() {
                shut_down(server).await;
            }
            None
        }
        Err(_) => {
            tracing::warn!("zig compile server timed out; falling back to zig build");
            if let Some(server) = slot.take() {
                shut_down(server).await;
            }
            None
        }
    }
}

fn slot_key(session_id: &str, kind: Kind) -> String {
    format!("{session_id}:{kind:?}")
}

/// Stops the session's servers, when its session goes.
pub async fn forget(session_id: &str) {
    for kind in [Kind::Program, Kind::Tests] {
        let slot = SERVERS.lock().await.remove(&slot_key(session_id, kind));
        if let Some(slot) = slot {
            if let Some(server) = slot.lock().await.take() {
                shut_down(server).await;
            }
        }
    }
    if let Ok(mut sessions) = NEEDS_LIBC.lock() {
        sessions.remove(session_id);
    }
}

/// Stops servers nobody has built with for `idle`. One mid-build is busy,
/// not idle, and is skipped.
pub async fn reap_idle(idle: Duration) -> usize {
    let slots: Vec<Slot> = SERVERS.lock().await.values().cloned().collect();
    let mut stopped = 0;
    for slot in slots {
        let Ok(mut slot) = slot.try_lock() else { continue };
        if slot.as_ref().is_some_and(|server| server.last_used.elapsed() >= idle) {
            if let Some(server) = slot.take() {
                shut_down(server).await;
                stopped += 1;
            }
        }
    }
    stopped
}

/// Live servers, for the metrics endpoint.
pub async fn count() -> usize {
    let slots: Vec<Slot> = SERVERS.lock().await.values().cloned().collect();
    let mut live = 0;
    for slot in slots {
        // A slot locked mid-build certainly holds a server.
        live += slot.try_lock().map_or(1, |slot| usize::from(slot.is_some()));
    }
    live
}

async fn spawn(kind: Kind, root: &Path, sandbox: Option<&Arc<SandboxPolicy>>, key: String) -> Result<Server, String> {
    let mut command = tokio::process::Command::new("zig");
    crate::exec::supervisor::scrub_bundle_env(&mut command);
    command
        .args(kind.args(root))
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(policy) = sandbox {
        // The same confinement and cache redirection as the classic build,
        // which runs `zig` through the supervisor.
        for (name, value) in crate::exec::sandbox::child_env(policy) {
            command.env(name, value);
        }
        let policy = crate::exec::sandbox::with_program(policy, "zig");
        match crate::exec::sandbox::prepare(&policy, crate::exec::sandbox::detect_support()) {
            Ok(Some(ruleset)) => unsafe {
                command.pre_exec(move || crate::exec::sandbox::restrict(&ruleset));
            },
            Ok(None) => {}
            Err(error) => return Err(format!("sandbox setup failed: {error}")),
        }
    }
    // The server outlives runs, so it must not outlive us.
    #[cfg(target_os = "linux")]
    unsafe {
        command.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    // The first message is always the compiler's version.
    let (tag, _) = tokio::time::timeout(Duration::from_secs(10), read_message(&mut stdout))
        .await
        .map_err(|_| "no greeting from the compiler".to_string())??;
    if tag != SERVER_ZIG_VERSION {
        return Err(format!("unexpected greeting tag {tag}"));
    }
    Ok(Server { child, stdin, stdout, key, last_used: Instant::now() })
}

async fn shut_down(mut server: Server) {
    let _ = server.stdin.write_all(&header(CLIENT_EXIT)).await;
    let _ = server.stdin.flush().await;
    if tokio::time::timeout(Duration::from_millis(500), server.child.wait())
        .await
        .is_err()
    {
        let _ = server.child.start_kill();
    }
}

enum BuildAnswer {
    Built(String),
    Failed(String),
}

fn header(tag: u32) -> [u8; 8] {
    let mut bytes = [0u8; 8];
    bytes[..4].copy_from_slice(&tag.to_le_bytes());
    bytes
}

async fn request_update(server: &mut Server) -> Result<BuildAnswer, String> {
    server
        .stdin
        .write_all(&header(CLIENT_UPDATE))
        .await
        .map_err(|error| error.to_string())?;
    server.stdin.flush().await.map_err(|error| error.to_string())?;
    // An update answers with any number of messages and always ends with
    // an error bundle — empty when the build succeeded, after the digest.
    let mut digest: Option<String> = None;
    loop {
        let (tag, body) = read_message(&mut server.stdout).await?;
        match tag {
            SERVER_EMIT_DIGEST => {
                // One flags byte, then the 16-byte cache directory digest.
                if body.len() == 17 {
                    digest = Some(body[1..].iter().map(|byte| format!("{byte:02x}")).collect());
                }
            }
            SERVER_ERROR_BUNDLE => {
                let errors = render_error_bundle(&body)?;
                return match (errors.is_empty(), digest) {
                    (true, Some(digest)) => Ok(BuildAnswer::Built(digest)),
                    (true, None) => Err("build finished without an executable".to_string()),
                    (false, _) => Ok(BuildAnswer::Failed(errors)),
                };
            }
            _ => {}
        }
    }
}

async fn read_message(stdout: &mut ChildStdout) -> Result<(u32, Vec<u8>), String> {
    let mut head = [0u8; 8];
    stdout.read_exact(&mut head).await.map_err(|error| format!("compiler stream: {error}"))?;
    let tag = u32::from_le_bytes(head[..4].try_into().unwrap_or_default());
    let len = u32::from_le_bytes(head[4..].try_into().unwrap_or_default()) as usize;
    if len > MAX_MESSAGE {
        return Err(format!("compiler message of {len} bytes"));
    }
    let mut body = vec![0u8; len];
    stdout.read_exact(&mut body).await.map_err(|error| format!("compiler stream: {error}"))?;
    Ok((tag, body))
}

/// Renders an ErrorBundle (std/zig/ErrorBundle.zig) the way the compiler
/// prints one — `path:line:col: error: message`, then its notes, then its
/// reference trace — so the diagnostics parser the classic build uses reads
/// it unchanged. The reference trace matters: an error raised inside the
/// standard library (a bad format string, say) is located in the user's
/// code only by its `referenced by:` lines.
///
/// Layout: a header `{extra_len: u32, string_bytes_len: u32}`, then
/// `extra_len` u32s, then the string table. `extra[0..3]` is the message
/// list `{len, start, compile_log_text}`; `extra[start..start+len]` index the
/// root messages `{msg, count, src_loc, notes_len}`, each followed by its
/// notes' indices. A source location is `{src_path, line, column,
/// span_start, span_main, span_end, source_line, reference_trace_len}`,
/// zero-based, followed by that many `{decl_name, src_loc}` references.
/// Strings are offsets of NUL-terminated text.
fn render_error_bundle(body: &[u8]) -> Result<String, String> {
    let word = |at: usize| -> Option<u32> {
        body.get(at..at + 4).map(|w| u32::from_le_bytes(w.try_into().unwrap_or_default()))
    };
    let malformed = || "malformed error bundle".to_string();
    let extra_len = word(0).ok_or_else(malformed)? as usize;
    let strings_len = word(4).ok_or_else(malformed)? as usize;
    if extra_len == 0 {
        return Ok(String::new());
    }
    let extra_end = 8 + extra_len * 4;
    let strings = body.get(extra_end..extra_end + strings_len).ok_or_else(malformed)?;
    let bundle = Bundle {
        extra: &|index: u32| {
            word(8 + index as usize * 4)
                .filter(|_| (index as usize) < extra_len)
                .ok_or_else(malformed)
        },
        strings,
    };
    let mut out = String::new();
    let (count, start) = (bundle.at(0)?, bundle.at(1)?);
    for i in 0..count {
        bundle.render(bundle.at(start + i)?, "error", &mut out, 0)?;
    }
    Ok(out)
}

struct Bundle<'a> {
    extra: &'a dyn Fn(u32) -> Result<u32, String>,
    strings: &'a [u8],
}

impl Bundle<'_> {
    fn at(&self, index: u32) -> Result<u32, String> {
        (self.extra)(index)
    }

    fn text(&self, offset: u32) -> String {
        let tail = self.strings.get(offset as usize..).unwrap_or_default();
        let end = tail.iter().position(|byte| *byte == 0).unwrap_or(tail.len());
        String::from_utf8_lossy(&tail[..end]).into_owned()
    }

    fn location(&self, loc: u32) -> Result<String, String> {
        Ok(format!(
            "{}:{}:{}",
            self.text(self.at(loc)?),
            self.at(loc + 1)? + 1,
            self.at(loc + 2)? + 1
        ))
    }

    /// One message, its notes, then its reference trace, as
    /// `ErrorBundle.renderErrorMessage` orders them.
    fn render(&self, index: u32, kind: &str, out: &mut String, depth: u32) -> Result<(), String> {
        // Notes do not nest in practice; a cycle in a corrupt bundle must
        // not recurse forever.
        if depth > 8 {
            return Err("error bundle nests too deep".to_string());
        }
        let message = self.text(self.at(index)?);
        let loc = self.at(index + 2)?;
        let notes = self.at(index + 3)?;
        if loc == 0 {
            out.push_str(&format!("{kind}: {message}\n"));
        } else {
            out.push_str(&format!("{}: {kind}: {message}\n", self.location(loc)?));
        }
        for n in 0..notes {
            self.render(self.at(index + 4 + n)?, "note", out, depth + 1)?;
        }
        if loc != 0 {
            let references = self.at(loc + 7)?;
            if references > 0 {
                out.push_str("referenced by:\n");
                for r in 0..references {
                    let entry = loc + 8 + r * 2;
                    let (name, src) = (self.at(entry)?, self.at(entry + 1)?);
                    if src != 0 {
                        out.push_str(&format!("    {}: {}\n", self.text(name), self.location(src)?));
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Location<'a> = Option<(&'a str, u32, u32)>;
    type Message<'a> = (&'a str, Location<'a>, &'a [(&'a str, Location<'a>)]);

    /// Appends a source location whose reference trace points at `refs`.
    fn with_references(body: &[u8], refs: &[(&str, &str, u32, u32)]) -> Vec<u8> {
        // Rebuild: parse the simple bundle back into extra + strings, then
        // append the references to the first message's location.
        let extra_len = u32::from_le_bytes(body[0..4].try_into().unwrap()) as usize;
        let strings_len = u32::from_le_bytes(body[4..8].try_into().unwrap()) as usize;
        let mut extra: Vec<u32> = (0..extra_len)
            .map(|i| u32::from_le_bytes(body[8 + i * 4..12 + i * 4].try_into().unwrap()))
            .collect();
        let mut strings = body[8 + extra_len * 4..8 + extra_len * 4 + strings_len].to_vec();
        let first = extra[extra[1] as usize] as usize;
        let loc = extra[first + 2] as usize;
        // Move the location to the end so its trailing references fit.
        let moved = extra.len() as u32;
        let copy: Vec<u32> = extra[loc..loc + 8].to_vec();
        extra.extend(copy);
        extra[first + 2] = moved;
        extra[moved as usize + 7] = refs.len() as u32;
        let mut ref_locs = Vec::new();
        let mut pending = Vec::new();
        for (decl, path, line, column) in refs {
            let decl_at = strings.len() as u32;
            strings.extend_from_slice(decl.as_bytes());
            strings.push(0);
            let path_at = strings.len() as u32;
            strings.extend_from_slice(path.as_bytes());
            strings.push(0);
            pending.push((decl_at, path_at, *line, *column));
        }
        let refs_start = extra.len();
        extra.extend(std::iter::repeat_n(0, pending.len() * 2));
        for (i, (decl_at, path_at, line, column)) in pending.into_iter().enumerate() {
            let at = extra.len() as u32;
            extra.extend([path_at, line, column, 0, 0, 0, 0, 0]);
            extra[refs_start + i * 2] = decl_at;
            extra[refs_start + i * 2 + 1] = at;
            ref_locs.push(at);
        }
        let mut out = Vec::new();
        out.extend((extra.len() as u32).to_le_bytes());
        out.extend((strings.len() as u32).to_le_bytes());
        for value in extra {
            out.extend(value.to_le_bytes());
        }
        out.extend(strings);
        out
    }

    /// Builds a bundle the way the compiler serialises one.
    fn bundle(messages: &[Message<'_>]) -> Vec<u8> {
        let mut strings: Vec<u8> = vec![0];
        let mut intern = |text: &str| -> u32 {
            let at = strings.len() as u32;
            strings.extend_from_slice(text.as_bytes());
            strings.push(0);
            at
        };
        let mut extra: Vec<u32> = vec![0, 0, 0];
        let location = |extra: &mut Vec<u32>, loc: Location<'_>, intern: &mut dyn FnMut(&str) -> u32| -> u32 {
            let Some((path, line, column)) = loc else { return 0 };
            let at = extra.len() as u32;
            extra.extend([intern(path), line, column, 0, 0, 0, 0, 0]);
            at
        };
        let mut roots = Vec::new();
        for (text, loc, notes) in messages {
            let mut note_indices = Vec::new();
            for (note, note_loc) in *notes {
                let src = location(&mut extra, *note_loc, &mut intern);
                let at = extra.len() as u32;
                extra.extend([intern(note), 1, src, 0]);
                note_indices.push(at);
            }
            let src = location(&mut extra, *loc, &mut intern);
            let at = extra.len() as u32;
            extra.extend([intern(text), 1, src, note_indices.len() as u32]);
            extra.extend(&note_indices);
            roots.push(at);
        }
        let start = extra.len() as u32;
        extra.extend(&roots);
        extra[0] = roots.len() as u32;
        extra[1] = start;
        let mut body = Vec::new();
        body.extend((extra.len() as u32).to_le_bytes());
        body.extend((strings.len() as u32).to_le_bytes());
        for value in extra {
            body.extend(value.to_le_bytes());
        }
        body.extend(strings);
        body
    }

    #[test]
    fn each_kind_builds_what_build_zig_describes() {
        let root = Path::new("/s");
        let program = Kind::Program.args(root);
        assert_eq!(program[0], "build-exe");
        assert!(program.contains(&"-Mroot=/s/generated/main.zig".to_string()));
        assert!(program.windows(2).any(|w| w == ["--name", "atomis-session"]));
        let tests = Kind::Tests.args(root);
        assert_eq!(tests[0], "test");
        assert!(tests.contains(&"-Mroot=/s/test_root.zig".to_string()));
        assert!(tests.windows(2).any(|w| w == ["--test-runner", "/s/runzig_test_runner.zig"]));
        // Neither links libc: Zig 0.16 cannot link it incrementally.
        assert!(!program.contains(&"-lc".to_string()) && !tests.contains(&"-lc".to_string()));
    }

    #[test]
    fn an_empty_bundle_means_success() {
        assert_eq!(render_error_bundle(&[0; 8]).unwrap(), "");
    }

    #[test]
    fn errors_render_like_the_command_line_with_their_notes() {
        let body = bundle(&[
            (
                "expected type 'u8', found '*const [2:0]u8'",
                Some(("generated/main.zig", 26, 37)),
                &[("parameter type declared here", Some(("generated/main.zig", 3, 4)))],
            ),
            ("no location", None, &[]),
        ]);
        assert_eq!(
            render_error_bundle(&body).unwrap(),
            "generated/main.zig:27:38: error: expected type 'u8', found '*const [2:0]u8'\n\
             generated/main.zig:4:5: note: parameter type declared here\n\
             error: no location\n"
        );
    }

    #[test]
    fn an_error_inside_std_keeps_the_trace_back_to_the_user_code() {
        // `std.debug.print("{hello}", .{})`: the error is raised in std's
        // Writer, and only the reference trace says where the call is.
        let body = with_references(
            &bundle(&[("too few arguments", Some(("/usr/lib/zig/std/Io/Writer.zig", 716, 12)), &[])]),
            &[("print", "/usr/lib/zig/std/debug.zig", 210, 4), ("main", "generated/main.zig", 2, 19)],
        );
        assert_eq!(
            render_error_bundle(&body).unwrap(),
            "/usr/lib/zig/std/Io/Writer.zig:717:13: error: too few arguments\n\
             referenced by:\n    print: /usr/lib/zig/std/debug.zig:211:5\n    main: generated/main.zig:3:20\n"
        );
        // And the classic build's parser maps that to the user's line.
        let diagnostics = crate::languages::zig::diagnostics::parse_compiler_diagnostics(
            &render_error_bundle(&body).unwrap(),
            "/s/generated/main.zig",
        );
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].path.as_deref(), Some("src/main.zig"));
        assert_eq!((diagnostics[0].line, diagnostics[0].column), (3, 20));
    }

    #[test]
    fn a_truncated_bundle_is_an_error_not_a_panic() {
        let body = bundle(&[("boom", Some(("generated/main.zig", 0, 0)), &[])]);
        assert!(render_error_bundle(&body[..body.len() - 6]).is_err());
        assert!(render_error_bundle(&body[..20]).is_err());
    }

    #[test]
    fn dependencies_and_libc_are_recognised() {
        assert!(!declares_dependencies(".{ .name = .s, .paths = .{\"src\"} }"));
        assert!(!declares_dependencies(".{ .dependencies = .{}, }"));
        assert!(declares_dependencies(
            ".{ .dependencies = .{ .zap = .{ .url = \"https://x\", .hash = \"1220\" } } }"
        ));
        assert!(wants_libc("main.zig:1:1: error: dependency on libc must be explicitly specified in the build command"));
        assert!(!wants_libc("main.zig:1:1: error: expected expression"));
    }
}
