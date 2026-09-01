//! Process supervision mirrored from apps/server/src/processes/
//! ProcessSupervisor.ts: spawn with an optional extra pipe on fd 3 for probe
//! NDJSON, stream stdout/stderr with byte caps, enforce timeouts, and kill
//! the whole process group on cancel/limit.

#![allow(dead_code)]

use std::os::fd::{FromRawFd, OwnedFd};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

/// After the main process exits, how long surviving descendants may keep
/// the output pipes open before the run stops waiting for them. Long enough
/// for a backgrounded child to flush its last words, short enough that a
/// setsid() escapee — unreachable by the group kill — cannot pin the run.
pub const DESCENDANT_DRAIN_MS: u64 = 1500;

pub struct ProcessLimits {
    pub timeout_ms: u64,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
    pub probe_bytes: usize,
}

impl ProcessLimits {
    pub fn new(timeout_ms: u64, stdout_bytes: usize, stderr_bytes: usize) -> Self {
        ProcessLimits {
            timeout_ms,
            stdout_bytes,
            stderr_bytes,
            probe_bytes: 1024 * 1024,
        }
    }
}

#[derive(Debug, Default)]
pub struct ProcessResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub limit: Option<&'static str>,
    pub duration_ms: f64,
}

pub type TextSink<'a> = Box<dyn FnMut(&str) + Send + 'a>;
pub type BytesSink<'a> = Box<dyn FnMut(&[u8]) + Send + 'a>;

#[derive(Default)]
pub struct StreamCallbacks<'a> {
    pub stdout: Option<TextSink<'a>>,
    pub stderr: Option<TextSink<'a>>,
    pub probe: Option<BytesSink<'a>>,
}

pub struct RunOptions<'a> {
    pub cwd: std::path::PathBuf,
    pub limits: ProcessLimits,
    pub cancel: CancellationToken,
    pub probe_fd: bool,
    pub env: Vec<(String, String)>,
    /// When set, the child is confined to the policy's allowlist before it
    /// execs. Every process a session spawns carries the same policy:
    /// build.zig, cargo build scripts and proc-macros are user code too.
    pub sandbox: Option<std::sync::Arc<crate::exec::sandbox::SandboxPolicy>>,
    pub callbacks: StreamCallbacks<'a>,
}

fn signal_name(code: i32) -> String {
    match code {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        15 => "SIGTERM",
        _ => return format!("SIG{code}"),
    }
    .to_string()
}

fn kill_group(pid: i32, signal: i32) {
    unsafe {
        libc::kill(-pid, signal);
    }
}

/// Strips the variables an AppImage points at its own bundle.
///
/// The AppImage runtime exports PYTHONHOME, PERLLIB, LD_LIBRARY_PATH and a
/// dozen more so the bundled GUI finds its libraries, and every process we
/// spawn inherits them. A system toolchain that reads one then looks for its
/// own files inside our bundle: python dies with "Failed to import encodings
/// module" before running a line. Variables pointing into the bundle are
/// dropped; a colon-separated list keeps whatever entries point elsewhere.
pub(crate) fn scrub_bundle_env(command: &mut tokio::process::Command) {
    let Some(bundle) = std::env::var_os("APPDIR") else {
        return;
    };
    let bundle = bundle.to_string_lossy().into_owned();
    if bundle.is_empty() {
        return;
    }
    for (key, value) in std::env::vars() {
        match scrub_value(&value, &bundle) {
            Scrubbed::Untouched => {}
            Scrubbed::Remove => {
                command.env_remove(&key);
            }
            Scrubbed::Replace(kept) => {
                command.env(&key, kept);
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Scrubbed {
    /// Nothing in the value points into the bundle.
    Untouched,
    /// Everything did: the variable has no meaning outside the bundle.
    Remove,
    /// A path list with entries worth keeping.
    Replace(String),
}

fn scrub_value(value: &str, bundle: &str) -> Scrubbed {
    if !value.contains(bundle) {
        return Scrubbed::Untouched;
    }
    let kept: Vec<&str> = value
        .split(':')
        .filter(|entry| !entry.is_empty() && !entry.contains(bundle))
        .collect();
    if kept.is_empty() {
        Scrubbed::Remove
    } else {
        Scrubbed::Replace(kept.join(":"))
    }
}


pub async fn run(command: &str, args: &[String], options: RunOptions<'_>) -> ProcessResult {
    let started = Instant::now();
    let mut result = ProcessResult::default();

    let mut cmd = tokio::process::Command::new(command);
    // Before anything else: an inherited bundle path breaks system tools.
    scrub_bundle_env(&mut cmd);
    cmd.args(args)
        .current_dir(&options.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    // Sandboxed children get their toolchain caches redirected into the
    // workspace first; the runner's own variables still win.
    if let Some(policy) = &options.sandbox {
        for (key, value) in crate::exec::sandbox::child_env(policy) {
            cmd.env(key, value);
        }
    }
    for (key, value) in &options.env {
        cmd.env(key, value);
    }

    // fd 3: a plain pipe the instrumented runtimes write NDJSON to.
    let mut probe_reader: Option<tokio::net::unix::pipe::Receiver> = None;
    let mut probe_writer_keepalive: Option<OwnedFd> = None;
    if options.probe_fd {
        let mut fds = [0i32; 2];
        // pipe2 is Linux-only; macOS needs pipe + FD_CLOEXEC via fcntl.
        #[cfg(target_os = "linux")]
        let ok = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } == 0;
        #[cfg(not(target_os = "linux"))]
        let ok = unsafe {
            libc::pipe(fds.as_mut_ptr()) == 0
                && libc::fcntl(fds[0], libc::F_SETFD, libc::FD_CLOEXEC) == 0
                && libc::fcntl(fds[1], libc::F_SETFD, libc::FD_CLOEXEC) == 0
        };
        if !ok {
            result.stderr = "failed to create probe pipe".into();
            result.exit_code = None;
            return result;
        }
        let (read_fd, write_fd) = (fds[0], fds[1]);
        let write_raw = write_fd;
        unsafe {
            cmd.pre_exec(move || {
                if libc::dup2(write_raw, 3) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let owned_read = unsafe { OwnedFd::from_raw_fd(read_fd) };
        let owned_write = unsafe { OwnedFd::from_raw_fd(write_fd) };
        match tokio::net::unix::pipe::Receiver::from_owned_fd(owned_read) {
            Ok(receiver) => probe_reader = Some(receiver),
            Err(error) => {
                result.stderr = format!("probe pipe: {error}");
                return result;
            }
        }
        probe_writer_keepalive = Some(owned_write);
    }

    if let Some(policy) = &options.sandbox {
        // The ruleset is built here, in the parent: the child may only run
        // allocation-free syscalls between fork and exec. Whatever we are
        // about to exec has to be reachable, wherever it was installed.
        let policy = crate::exec::sandbox::with_program(policy, command);
        match crate::exec::sandbox::prepare(&policy, crate::exec::sandbox::detect_support()) {
            Ok(Some(ruleset)) => unsafe {
                cmd.pre_exec(move || crate::exec::sandbox::restrict(&ruleset));
            },
            Ok(None) => {}
            Err(error) => {
                result.stderr = format!("sandbox setup failed: {error}");
                result.exit_code = None;
                return result;
            }
        }
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            result.stderr = error.to_string();
            result.duration_ms = started.elapsed().as_secs_f64() * 1000.0;
            return result;
        }
    };
    // Close the parent's copy of the probe write end so EOF arrives.
    drop(probe_writer_keepalive);

    let pid = child.id().map(|p| p as i32).unwrap_or(0);
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let mut callbacks = options.callbacks;
    let mut stdout_bytes = 0usize;
    let mut stderr_bytes = 0usize;
    let mut probe_bytes = 0usize;
    let mut terminating = false;
    let mut exited: Option<std::process::ExitStatus> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(options.limits.timeout_ms);
    let mut stdout_buf = [0u8; 16 * 1024];
    let mut stderr_buf = [0u8; 16 * 1024];
    let mut probe_buf = [0u8; 16 * 1024];
    let mut stdout_done = stdout.is_none();
    let mut stderr_done = stderr.is_none();
    let mut probe_done = probe_reader.is_none();
    // A multibyte character split between two reads must not become two
    // U+FFFDs: the carry joins it back up across the boundary.
    let mut stdout_decoder = crate::util::Utf8Carry::new();
    let mut stderr_decoder = crate::util::Utf8Carry::new();
    // Over the limit, reads continue (to drain the pipe) but nothing more is
    // accumulated or streamed: the cap is a cap, not a suggestion.
    let mut stdout_capped = false;
    let mut stderr_capped = false;
    let mut probe_capped = false;
    // EOF requires every copy of the pipe's write end to close, and a
    // descendant that outlives the main process holds one. Waiting on it
    // forever pins the run task — a setsid() escapee is not even reachable
    // by the group kill — so exit starts a countdown instead.
    let mut drain_deadline: Option<tokio::time::Instant> = None;
    let finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    let terminate = |terminating: &mut bool| {
        if *terminating || pid == 0 {
            return;
        }
        *terminating = true;
        kill_group(pid, libc::SIGTERM);
        let kill_pid = pid;
        let finished = std::sync::Arc::clone(&finished);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(250)).await;
            // Once the run has fully wound down every pipe was closed, so
            // the group is in all likelihood gone — and its id may already
            // name someone else's processes. Only stragglers get the kill.
            if !finished.load(std::sync::atomic::Ordering::SeqCst) {
                kill_group(kill_pid, libc::SIGKILL);
            }
        });
    };

    loop {
        tokio::select! {
            biased;
            _ = options.cancel.cancelled(), if !result.cancelled => {
                result.cancelled = true;
                terminate(&mut terminating);
            }
            _ = tokio::time::sleep_until(deadline), if !result.timed_out && !terminating => {
                result.timed_out = true;
                terminate(&mut terminating);
            }
            _ = async { tokio::time::sleep_until(drain_deadline.expect("drain armed")).await }, if drain_deadline.is_some() => {
                // The main process is gone but something it left behind
                // still holds an output pipe. Sweep the group and stop
                // reading; dropping our ends follows at return, and an
                // escapee that writes again dies of EPIPE on its own.
                terminate(&mut terminating);
                stdout_done = true;
                stderr_done = true;
                probe_done = true;
            }
            read = async { stdout.as_mut().expect("stdout").read(&mut stdout_buf).await }, if !stdout_done => {
                match read {
                    Ok(0) | Err(_) => stdout_done = true,
                    Ok(n) => {
                        stdout_bytes += n;
                        if !stdout_capped {
                            let text = stdout_decoder.decode(&stdout_buf[..n]);
                            result.stdout.push_str(&text);
                            if let Some(cb) = callbacks.stdout.as_mut() {
                                cb(&text);
                            }
                            if stdout_bytes > options.limits.stdout_bytes {
                                stdout_capped = true;
                                result.limit = Some("stdout");
                                terminate(&mut terminating);
                            }
                        }
                    }
                }
            }
            read = async { stderr.as_mut().expect("stderr").read(&mut stderr_buf).await }, if !stderr_done => {
                match read {
                    Ok(0) | Err(_) => stderr_done = true,
                    Ok(n) => {
                        stderr_bytes += n;
                        if !stderr_capped {
                            let text = stderr_decoder.decode(&stderr_buf[..n]);
                            result.stderr.push_str(&text);
                            if let Some(cb) = callbacks.stderr.as_mut() {
                                cb(&text);
                            }
                            if stderr_bytes > options.limits.stderr_bytes {
                                stderr_capped = true;
                                result.limit = Some("stderr");
                                terminate(&mut terminating);
                            }
                        }
                    }
                }
            }
            read = async { probe_reader.as_mut().expect("probe").read(&mut probe_buf).await }, if !probe_done => {
                match read {
                    Ok(0) | Err(_) => probe_done = true,
                    Ok(n) => {
                        probe_bytes += n;
                        if !probe_capped {
                            if let Some(cb) = callbacks.probe.as_mut() {
                                cb(&probe_buf[..n]);
                            }
                            if probe_bytes > options.limits.probe_bytes {
                                probe_capped = true;
                                result.limit = Some("probes");
                                terminate(&mut terminating);
                            }
                        }
                    }
                }
            }
            status = child.wait(), if exited.is_none() => {
                use std::os::unix::process::ExitStatusExt;
                exited = Some(
                    status.unwrap_or_else(|_| std::process::ExitStatus::from_raw(0)),
                );
                drain_deadline = Some(
                    tokio::time::Instant::now() + Duration::from_millis(DESCENDANT_DRAIN_MS),
                );
            }
        }
        if exited.is_some() && stdout_done && stderr_done && probe_done {
            break;
        }
    }
    finished.store(true, std::sync::atomic::Ordering::SeqCst);
    if !stdout_capped {
        let tail = stdout_decoder.finish();
        if !tail.is_empty() {
            result.stdout.push_str(&tail);
            if let Some(cb) = callbacks.stdout.as_mut() {
                cb(&tail);
            }
        }
    }
    if !stderr_capped {
        let tail = stderr_decoder.finish();
        if !tail.is_empty() {
            result.stderr.push_str(&tail);
            if let Some(cb) = callbacks.stderr.as_mut() {
                cb(&tail);
            }
        }
    }

    if let Some(status) = exited {
        use std::os::unix::process::ExitStatusExt;
        result.exit_code = status.code();
        result.signal = status.signal().map(signal_name);
    }
    result.duration_ms = started.elapsed().as_secs_f64() * 1000.0;
    result
}

#[cfg(test)]
mod tests {
    use super::{run, scrub_value, ProcessLimits, RunOptions, Scrubbed, StreamCallbacks};
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;

    const BUNDLE: &str = "/tmp/.mount_atomisAbCdEf";

    fn options(timeout_ms: u64, stdout_bytes: usize) -> RunOptions<'static> {
        RunOptions {
            cwd: std::env::temp_dir(),
            limits: ProcessLimits::new(timeout_ms, stdout_bytes, 512 * 1024),
            cancel: CancellationToken::new(),
            probe_fd: false,
            env: Vec::new(),
            sandbox: None,
            callbacks: StreamCallbacks::default(),
        }
    }

    fn have(command: &str) -> bool {
        std::process::Command::new("sh")
            .args(["-c", &format!("command -v {command}")])
            .stdout(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[tokio::test]
    async fn a_setsid_escapee_cannot_pin_the_run() {
        if !have("setsid") {
            return;
        }
        // The escapee leaves the process group, so the group kill misses it,
        // and it inherits stdout, so EOF never comes. The run must still end.
        let script = "setsid sleep 30 & exit 7";
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            run("sh", &["-c".into(), script.into()], options(30_000, 1024 * 1024)),
        )
        .await
        .expect("the run must not hang on an escaped descendant");
        assert_eq!(result.exit_code, Some(7));
        assert!(!result.timed_out, "a clean exit is not a timeout");
    }

    #[tokio::test]
    async fn a_backgrounded_child_ends_the_run_at_the_drain_window() {
        // Same group this time: the drain window closes the run and the
        // group sweep takes the straggler with it, without a false timeout.
        let script = "sleep 30 & exit 0";
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            run("sh", &["-c".into(), script.into()], options(30_000, 1024 * 1024)),
        )
        .await
        .expect("the run must not wait for the background child");
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
    }

    #[tokio::test]
    async fn the_output_limit_is_a_hard_cap() {
        // `yes` writes forever; the run must stop it and keep only about the
        // limit, not everything that arrived while dying.
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            run("yes", &[], options(30_000, 10_000)),
        )
        .await
        .expect("the limit must end the run");
        assert_eq!(result.limit, Some("stdout"));
        assert!(
            result.stdout.len() <= 10_000 + 16 * 1024,
            "kept {} bytes for a 10000-byte limit",
            result.stdout.len()
        );
    }

    #[tokio::test]
    async fn split_multibyte_output_survives_the_chunk_boundary() {
        if !have("python3") {
            return;
        }
        // Two explicit writes that cut the ñ in half, so the halves are
        // guaranteed to arrive in different reads.
        let script = "import os\nos.write(1, b'a' * 100 + b'\\xc3')\nos.write(1, b'\\xb1ok')\n";
        let result = run(
            "python3",
            &["-c".into(), script.into()],
            options(10_000, 1024 * 1024),
        )
        .await;
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, format!("{}ñok", "a".repeat(100)));
    }

    #[test]
    fn a_variable_that_only_names_the_bundle_is_dropped() {
        // What actually broke Python: PYTHONHOME pointed at the AppImage,
        // where no standard library lives.
        assert_eq!(
            scrub_value("/tmp/.mount_atomisAbCdEf/usr/", BUNDLE),
            Scrubbed::Remove
        );
        assert_eq!(
            scrub_value("/tmp/.mount_atomisAbCdEf/usr/share/pyshared/:", BUNDLE),
            Scrubbed::Remove
        );
    }

    #[test]
    fn a_path_list_keeps_the_entries_pointing_elsewhere() {
        assert_eq!(
            scrub_value(
                "/tmp/.mount_atomisAbCdEf/usr/bin:/usr/bin:/home/dev/.cargo/bin",
                BUNDLE
            ),
            Scrubbed::Replace("/usr/bin:/home/dev/.cargo/bin".to_string())
        );
    }

    #[test]
    fn everything_else_is_left_alone() {
        assert_eq!(scrub_value("/usr/bin:/bin", BUNDLE), Scrubbed::Untouched);
        assert_eq!(scrub_value("", BUNDLE), Scrubbed::Untouched);
    }
}
