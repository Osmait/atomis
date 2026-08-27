//! Optional OS sandbox for the processes a session spawns (compilers,
//! instrumenters and the user's program alike).
//!
//! Linux implementation: a Landlock ruleset built in the PARENT (allocation
//! is safe there) whose file descriptor is handed to the child, which only
//! issues two syscalls between fork and exec — `prctl(PR_SET_NO_NEW_PRIVS)`
//! and `landlock_restrict_self`. Building the ruleset after fork would
//! allocate, which can deadlock in a multi-threaded process.
//!
//! The policy is an allowlist: read+execute on toolchains and system paths,
//! read+write on the session workspace only, and — where the kernel
//! supports it (ABI 4+, Linux 6.7) — no TCP. Everything else (the user's
//! home, other sessions, /etc secrets) is invisible.
//!
//! Known gap: Landlock's network rules only cover TCP bind and connect, so
//! UDP (DNS included) is NOT restricted; closing that needs a seccomp
//! filter. It raises the bar a lot; it is not a virtual machine. Kernel
//! bugs and side channels are out of scope.

use std::path::{Path, PathBuf};

/// What the running kernel can actually enforce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxSupport {
    /// Filesystem allowlist plus TCP denial (Landlock ABI 4+).
    FilesAndNetwork,
    /// Filesystem allowlist only (Landlock ABI 1-3).
    FilesOnly,
    /// No enforcement available.
    Unsupported,
}

impl SandboxSupport {
    pub fn as_str(self) -> &'static str {
        match self {
            SandboxSupport::FilesAndNetwork => "files+network",
            SandboxSupport::FilesOnly => "files",
            SandboxSupport::Unsupported => "unsupported",
        }
    }

    pub fn available(self) -> bool {
        self != SandboxSupport::Unsupported
    }
}

/// Landlock ABI level of the running kernel (0 when unavailable).
#[cfg(target_os = "linux")]
fn landlock_abi() -> i64 {
    // create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION) reports the
    // supported ABI without creating anything.
    let abi = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<libc::c_void>(),
            0usize,
            1u32,
        )
    };
    abi.max(0)
}

#[cfg(not(target_os = "linux"))]
fn landlock_abi() -> i64 {
    0
}

pub fn detect_support() -> SandboxSupport {
    static CACHED: std::sync::OnceLock<SandboxSupport> = std::sync::OnceLock::new();
    *CACHED.get_or_init(|| match landlock_abi() {
        0 => SandboxSupport::Unsupported,
        1..=3 => SandboxSupport::FilesOnly,
        _ => SandboxSupport::FilesAndNetwork,
    })
}

/// Paths a sandboxed process may touch. Built per session; the same policy
/// is reused for every process that session spawns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxPolicy {
    /// The session workspace: the only writable tree.
    pub workspace: PathBuf,
    /// Full access (the workspace and anything else the session may write).
    pub read_write: Vec<PathBuf>,
    /// Read and execute (toolchains, shared libraries, our runtime templates).
    pub read_only: Vec<PathBuf>,
    /// Character devices every toolchain writes to (`/dev/null` above all).
    /// Granted read+write on the FILE only, so the rest of /dev — raw disks
    /// included — stays invisible.
    pub devices: Vec<PathBuf>,
    /// The real user home, kept so toolchain roots can still be pointed at.
    pub home: Option<PathBuf>,
    /// What the process may do with the network. Binding is never allowed
    /// in any mode: a confined process may call out, never serve.
    pub network: NetworkAccess,
}

/// Outbound network a sandboxed process is granted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetworkAccess {
    /// No TCP at all — the default for everything Atomis runs.
    None,
    /// Outbound TCP to these ports only, for dependency installs.
    Ports(Vec<u16>),
    /// Any outbound TCP, for user code that asks for it. Listening stays
    /// denied, so a program can call an API but never accept a connection.
    Outbound,
}

/// System locations every toolchain needs to exec and load libraries from.
const SYSTEM_READ_ONLY: &[&str] = &[
    "/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/etc", "/nix", "/var/lib", "/proc", "/sys",
];

/// The character devices a build pipeline legitimately writes to. `/dev`
/// itself is never granted: raw block devices must stay out of reach.
const DEVICES: &[&str] = &[
    "/dev/null",
    "/dev/zero",
    "/dev/full",
    "/dev/random",
    "/dev/urandom",
    "/dev/tty",
];

/// Per-user toolchain homes (rustup, cargo, go, zig managers, pyenv…).
const HOME_READ_ONLY: &[&str] = &[
    ".cargo", ".rustup", ".zvm", ".zig", "go", ".local", ".pyenv", ".nvm", ".volta", ".asdf",
    ".cache",
];

/// Assembles the allowlist for one session. Pure: paths are not touched
/// here, `prepare` filters out the ones that do not exist.
pub fn policy_for(workspace: &Path, project_root: &Path, home: Option<&Path>) -> SandboxPolicy {
    let mut read_only: Vec<PathBuf> = SYSTEM_READ_ONLY.iter().map(PathBuf::from).collect();
    read_only.push(project_root.to_path_buf());
    if let Some(home) = home {
        for entry in HOME_READ_ONLY {
            read_only.push(home.join(entry));
        }
    }
    SandboxPolicy {
        workspace: workspace.to_path_buf(),
        read_write: vec![workspace.to_path_buf()],
        read_only,
        devices: DEVICES.iter().map(PathBuf::from).collect(),
        home: home.map(Path::to_path_buf),
        network: NetworkAccess::None,
    }
}

/// Resolves `program` the way exec will: an absolute or relative path as
/// given, a bare name through PATH. Symlinks are followed, because what the
/// ruleset must name is the file the kernel ends up opening.
fn resolve_program(program: &str) -> Option<PathBuf> {
    let direct = Path::new(program);
    if direct.components().count() > 1 {
        return direct.canonicalize().ok();
    }
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(program))
            .find_map(|candidate| candidate.canonicalize().ok())
    })
}

/// The same policy, plus read+execute on the directory the program lives
/// in.
///
/// The allowlist above covers toolchains installed by a package manager or
/// by the usual per-user managers, and misses every other arrangement — a
/// tarball unpacked into a scratch directory, which is exactly how CI
/// runners install Zig. The failure is silent and unhelpful: exec is denied,
/// so the build dies in milliseconds with nothing on stderr. Granting the
/// directory of whatever we are about to run costs nothing and covers every
/// layout, including the `lib/` sitting next to the binary that Zig, Go and
/// clang all read their standard library from.
pub fn with_program(policy: &SandboxPolicy, program: &str) -> SandboxPolicy {
    let Some(directory) = resolve_program(program).and_then(|path| path.parent().map(Path::to_path_buf))
    else {
        return policy.clone();
    };
    // A toolchain laid out as `<prefix>/bin/thing` keeps its standard
    // library in `<prefix>/lib` (Zig, Go and clang all do), so the prefix is
    // what has to be reachable — but never when the prefix is the home
    // itself, which would hand over everything a `~/bin` user owns.
    let grant = match directory.file_name() {
        Some(name) if name == "bin" => match directory.parent() {
            Some(prefix)
                if prefix.parent().is_some()
                    && policy.home.as_deref() != Some(prefix) =>
            {
                prefix.to_path_buf()
            }
            _ => directory,
        },
        _ => directory,
    };
    if policy
        .read_only
        .iter()
        .any(|allowed| grant.starts_with(allowed))
    {
        return policy.clone();
    }
    let mut next = policy.clone();
    next.read_only.push(grant);
    next
}

/// Ports a dependency fetch needs: HTTPS, plus plain HTTP for the
/// redirects some registries still serve.
pub const FETCH_PORTS: &[u16] = &[443, 80];

/// The same policy with outbound HTTPS opened, for the one step that needs
/// it: installing dependencies. Everything else — the filesystem, binding a
/// port, every other port — stays exactly as restricted.
pub fn with_fetch_network(policy: &SandboxPolicy) -> SandboxPolicy {
    SandboxPolicy {
        network: NetworkAccess::Ports(FETCH_PORTS.to_vec()),
        ..policy.clone()
    }
}

/// The same policy with outbound TCP opened for the program itself, which
/// is what "Allow network" grants: HTTP clients work, the filesystem stays
/// confined to the workspace, and nothing can listen.
pub fn with_outbound_network(policy: &SandboxPolicy) -> SandboxPolicy {
    SandboxPolicy {
        network: NetworkAccess::Outbound,
        ..policy.clone()
    }
}

/// Environment that keeps toolchains from needing anything outside the
/// workspace. Without it zig, cargo and friends try to write their global
/// caches under the (read-only) user home and fail. Applied before the
/// runner's own variables, so a runner can still override any of them.
pub fn child_env(policy: &SandboxPolicy) -> Vec<(String, String)> {
    let at = |name: &str| {
        policy
            .workspace
            .join(name)
            .to_string_lossy()
            .into_owned()
    };
    let mut env = vec![
        // A private HOME catches every stray ~/.something write.
        ("HOME".to_string(), at("")),
        ("XDG_CACHE_HOME".to_string(), at(".cache")),
        ("TMPDIR".to_string(), at(".tmp")),
        ("ZIG_GLOBAL_CACHE_DIR".to_string(), at(".zig-global-cache")),
        ("ZIG_LOCAL_CACHE_DIR".to_string(), at(".zig-cache")),
        ("CARGO_HOME".to_string(), at(".cargo-home")),
        ("GOPATH".to_string(), at(".gopath")),
        ("GOMODCACHE".to_string(), at(".gomodcache")),
        ("PYTHONPYCACHEPREFIX".to_string(), at(".pycache")),
    ];
    // HOME moved, so rustup can no longer find its toolchains by default.
    if let Some(home) = &policy.home {
        env.push((
            "RUSTUP_HOME".to_string(),
            home.join(".rustup").to_string_lossy().into_owned(),
        ));
    }
    env
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{NetworkAccess, SandboxPolicy, SandboxSupport};
    use landlock::{
        path_beneath_rules, Access, AccessFs, AccessNet, CompatLevel, Compatible, NetPort, Ruleset,
        RulesetAttr, RulesetCreatedAttr, RulesetError, ABI,
    };
    use std::os::fd::{AsRawFd, OwnedFd};

    fn abi_for(support: SandboxSupport) -> ABI {
        match support {
            SandboxSupport::FilesAndNetwork => ABI::V4,
            _ => ABI::V1,
        }
    }

    /// Builds the ruleset in the parent and returns its file descriptor.
    /// `None` means "nothing to enforce" (unsupported kernel).
    pub fn prepare(
        policy: &SandboxPolicy,
        support: SandboxSupport,
    ) -> Result<Option<OwnedFd>, String> {
        if !support.available() {
            return Ok(None);
        }
        let abi = abi_for(support);
        let existing = |paths: &[std::path::PathBuf]| -> Vec<std::path::PathBuf> {
            paths.iter().filter(|path| path.exists()).cloned().collect()
        };
        // Best effort: on kernels below the requested ABI the unsupported
        // access rights are dropped instead of failing the whole ruleset.
        let mut ruleset = Ruleset::default()
            .set_compatibility(CompatLevel::BestEffort)
            .handle_access(AccessFs::from_all(abi))
            .map_err(|error| error.to_string())?;
        // Handling an access with no rule denies it. Outbound access is
        // therefore granted by NOT handling ConnectTcp at all, while
        // BindTcp stays handled and ruleless in every mode.
        let mut connect_ports: Vec<u16> = Vec::new();
        if support == SandboxSupport::FilesAndNetwork {
            let handled = match &policy.network {
                NetworkAccess::Outbound => AccessNet::BindTcp.into(),
                NetworkAccess::Ports(ports) => {
                    connect_ports = ports.clone();
                    AccessNet::from_all(abi)
                }
                NetworkAccess::None => AccessNet::from_all(abi),
            };
            ruleset = ruleset
                .handle_access(handled)
                .map_err(|error| error.to_string())?;
        }
        let created = ruleset
            .create()
            .map_err(|error| error.to_string())?
            .add_rules(path_beneath_rules(
                existing(&policy.read_write),
                AccessFs::from_all(abi),
            ))
            .map_err(|error| error.to_string())?
            .add_rules(path_beneath_rules(
                existing(&policy.read_only),
                AccessFs::from_read(abi),
            ))
            .map_err(|error| error.to_string())?
            .add_rules(path_beneath_rules(
                existing(&policy.devices),
                AccessFs::ReadFile | AccessFs::WriteFile | AccessFs::Truncate,
            ))
            .map_err(|error| error.to_string())?
            // Only the listed ports, and only outbound: AccessNet::BindTcp
            // stays handled with no rule, so nothing can listen.
            .add_rules(
                connect_ports
                    .iter()
                    .map(|port| Ok(NetPort::new(*port, AccessNet::ConnectTcp))),
            )
            .map_err(|error: RulesetError| error.to_string())?;
        // No network rules are added, so with AccessNet handled every TCP
        // bind and connect is denied (UDP is outside Landlock's scope).
        let fd: Option<OwnedFd> = created.into();
        Ok(fd)
    }

    /// Child side: the only two syscalls issued between fork and exec.
    /// Must stay allocation free — malloc after fork can deadlock.
    pub fn restrict(fd: &OwnedFd) -> std::io::Result<()> {
        // SAFETY: plain syscalls with no shared state; both are
        // async-signal-safe and the fd outlives the call.
        unsafe {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::syscall(libc::SYS_landlock_restrict_self, fd.as_raw_fd(), 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok(())
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::{SandboxPolicy, SandboxSupport};
    use std::os::fd::OwnedFd;

    pub fn prepare(
        _policy: &SandboxPolicy,
        _support: SandboxSupport,
    ) -> Result<Option<OwnedFd>, String> {
        Ok(None)
    }

    pub fn restrict(_fd: &OwnedFd) -> std::io::Result<()> {
        Ok(())
    }
}

pub use imp::{prepare, restrict};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_grants_the_workspace_and_toolchains_only() {
        let policy = policy_for(
            Path::new("/tmp/atomis/abc"),
            Path::new("/srv/atomis"),
            Some(Path::new("/home/dev")),
        );
        assert_eq!(policy.read_write, vec![PathBuf::from("/tmp/atomis/abc")]);
        assert_eq!(policy.workspace, PathBuf::from("/tmp/atomis/abc"));
        // The project root ships instrumenters, runtimes and templates.
        assert!(policy.read_only.contains(&PathBuf::from("/srv/atomis")));
        assert!(policy.read_only.contains(&PathBuf::from("/home/dev/.cargo")));
        assert!(policy.read_only.contains(&PathBuf::from("/usr")));
        // Toolchains write to /dev/null, but /dev itself stays closed so
        // raw block devices are unreachable.
        assert!(policy.devices.contains(&PathBuf::from("/dev/null")));
        assert!(!policy.read_only.contains(&PathBuf::from("/dev")));
        // The home itself is never readable: only the toolchain subtrees.
        assert!(!policy.read_only.contains(&PathBuf::from("/home/dev")));
        // Nor is another session's workspace.
        assert!(!policy.read_only.contains(&PathBuf::from("/tmp/atomis")));
    }

    #[test]
    fn policy_without_a_home_still_covers_system_paths() {
        let policy = policy_for(Path::new("/w"), Path::new("/root"), None);
        assert!(policy.read_only.contains(&PathBuf::from("/usr")));
        assert!(policy
            .read_only
            .iter()
            .all(|path| !path.starts_with("/home")));
    }

    /// Runs `argv` under the policy and reports whether it exited zero.
    #[cfg(target_os = "linux")]
    fn run_sandboxed(policy: &SandboxPolicy, argv: &[&str]) -> bool {
        use std::os::unix::process::CommandExt;
        let support = detect_support();
        let Ok(Some(fd)) = prepare(policy, support) else {
            return true;
        };
        let mut command = std::process::Command::new(argv[0]);
        command.args(&argv[1..]);
        command.stdout(std::process::Stdio::null());
        command.stderr(std::process::Stdio::null());
        unsafe {
            command.pre_exec(move || restrict(&fd));
        }
        command
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    /// A toolchain unpacked outside every allowlisted prefix — how CI
    /// runners install Zig, and how anyone using a tarball installs
    /// anything — must still be runnable, or the build dies in
    /// milliseconds with nothing on stderr to say why.
    #[test]
    #[cfg(target_os = "linux")]
    fn a_toolchain_outside_the_allowlist_can_still_be_executed() {
        if !detect_support().available() {
            eprintln!("landlock unavailable: skipping enforcement test");
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "atomis-toolchain-test-{}",
            std::process::id()
        ));
        let toolchain = root.join("some-lang-1.2.3");
        std::fs::create_dir_all(&toolchain).expect("toolchain dir");
        let program = toolchain.join("lang");
        std::fs::copy("/bin/true", &program).expect("copy");
        let mut permissions =
            std::fs::metadata(&program).expect("metadata").permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o755);
        std::fs::set_permissions(&program, permissions).expect("chmod");
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).expect("workspace");

        let policy = policy_for(&workspace, Path::new("/nonexistent"), None);
        let path = program.to_string_lossy().into_owned();
        assert!(
            !run_sandboxed(&policy, &[&path]),
            "the bare policy should not reach a toolchain it never heard of"
        );
        let granted = with_program(&policy, &path);
        assert!(
            run_sandboxed(&granted, &[&path]),
            "granting the program's own directory should make it runnable"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bin_directory_grants_the_prefix_but_never_a_home() {
        let root = std::env::temp_dir()
            .join(format!("atomis-prefix-test-{}", std::process::id()))
            .canonicalize()
            .unwrap_or_else(|_| {
                let path = std::env::temp_dir()
                    .join(format!("atomis-prefix-test-{}", std::process::id()));
                std::fs::create_dir_all(&path).expect("root");
                path.canonicalize().expect("canonical root")
            });
        let install = |dir: &Path| {
            std::fs::create_dir_all(dir).expect("bin dir");
            let program = dir.join("lang");
            std::fs::copy("/bin/true", &program).expect("copy");
            program
        };

        // <prefix>/bin/thing needs <prefix>, where lib/ lives.
        let prefix = root.join("lang-1.0");
        let program = install(&prefix.join("bin"));
        let policy = policy_for(&root.join("ws"), Path::new("/nonexistent"), None);
        let granted = with_program(&policy, &program.to_string_lossy());
        assert!(granted.read_only.iter().any(|path| path == &prefix));

        // ~/bin/thing must not drag the whole home along.
        let home = root.join("fakehome");
        let home_program = install(&home.join("bin"));
        let home_policy =
            policy_for(&root.join("ws"), Path::new("/nonexistent"), Some(&home));
        let home_granted =
            with_program(&home_policy, &home_program.to_string_lossy());
        assert!(!home_granted.read_only.iter().any(|path| path == &home));
        assert!(home_granted
            .read_only
            .iter()
            .any(|path| path == &home.join("bin")));

        // Nothing to resolve, nothing to add.
        assert_eq!(
            with_program(&policy, "definitely-not-a-real-binary"),
            policy
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn the_sandbox_confines_reads_to_the_allowlist() {
        if !detect_support().available() {
            eprintln!("landlock unavailable: skipping enforcement test");
            return;
        }
        let workspace = std::env::temp_dir().join(format!(
            "atomis-sandbox-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&workspace).expect("workspace");
        let inside = workspace.join("inside.txt");
        std::fs::write(&inside, "ok").expect("write inside");
        let outside = std::env::temp_dir().join(format!(
            "atomis-sandbox-outside-{}.txt",
            std::process::id()
        ));
        std::fs::write(&outside, "secret").expect("write outside");

        let policy = policy_for(&workspace, Path::new("/usr"), None);
        assert!(
            run_sandboxed(&policy, &["/bin/cat", inside.to_str().expect("path")]),
            "the workspace must stay readable"
        );
        assert!(
            !run_sandboxed(&policy, &["/bin/cat", outside.to_str().expect("path")]),
            "files outside the workspace must be denied"
        );
        // Writing outside is denied too, even in a directory we own.
        assert!(
            !run_sandboxed(
                &policy,
                &[
                    "/bin/sh",
                    "-c",
                    &format!("echo x > {}", outside.to_str().expect("path")),
                ],
            ),
            "writes outside the workspace must be denied"
        );

        // Toolchains need /dev/null; the rest of /dev stays unreachable.
        assert!(
            run_sandboxed(&policy, &["/bin/sh", "-c", "echo probe > /dev/null"]),
            "/dev/null must be writable or every compiler breaks"
        );
        assert!(
            !run_sandboxed(&policy, &["/bin/sh", "-c", "head -c 1 /dev/mem"]),
            "raw devices must stay unreachable"
        );

        std::fs::remove_dir_all(&workspace).ok();
        std::fs::remove_file(&outside).ok();
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn the_sandbox_denies_the_network_when_the_kernel_can() {
        if detect_support() != SandboxSupport::FilesAndNetwork {
            eprintln!("landlock ABI < 4: skipping network test");
            return;
        }
        let workspace = std::env::temp_dir().join(format!(
            "atomis-sandbox-net-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&workspace).expect("workspace");
        let policy = policy_for(&workspace, Path::new("/usr"), None);
        // A TCP listener is the shape the e2e suite exercises from user code.
        let listen = "import socket;s=socket.socket();s.bind(('127.0.0.1',0))";
        assert!(
            !run_sandboxed(&policy, &["python3", "-c", listen]),
            "binding a socket must be denied"
        );
        std::fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn child_env_redirects_every_toolchain_cache_into_the_workspace() {
        let policy = policy_for(
            Path::new("/tmp/atomis/abc"),
            Path::new("/srv"),
            Some(Path::new("/home/dev")),
        );
        let env: std::collections::HashMap<_, _> = child_env(&policy).into_iter().collect();
        // Every cache lands inside the only writable tree…
        for key in [
            "HOME",
            "XDG_CACHE_HOME",
            "TMPDIR",
            "ZIG_GLOBAL_CACHE_DIR",
            "CARGO_HOME",
            "GOPATH",
            "PYTHONPYCACHEPREFIX",
        ] {
            assert!(
                env[key].starts_with("/tmp/atomis/abc"),
                "{key} escapes the workspace: {}",
                env[key]
            );
        }
        // …except the rustup root, which must keep pointing at the real
        // home now that HOME moved (it is read-only anyway).
        assert_eq!(env["RUSTUP_HOME"], "/home/dev/.rustup");
    }

    /// Pins the exact network boundary Landlock gives us, including its
    /// gap: TCP bind/connect are denied, UDP is NOT covered by any Landlock
    /// ABI. If a future kernel or crate changes that, this fails loudly and
    /// the documented guarantee gets updated with it.
    #[test]
    #[cfg(target_os = "linux")]
    fn the_network_rules_cover_tcp_but_not_udp() {
        if detect_support() != SandboxSupport::FilesAndNetwork {
            eprintln!("landlock ABI < 4: skipping network boundary test");
            return;
        }
        let workspace = std::env::temp_dir().join(format!(
            "atomis-sandbox-udp-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&workspace).expect("workspace");
        let policy = policy_for(&workspace, Path::new("/usr"), None);
        assert!(
            !run_sandboxed(
                &policy,
                &[
                    "python3",
                    "-c",
                    "import socket;s=socket.socket();s.connect(('1.1.1.1',80))",
                ],
            ),
            "TCP connect must be denied"
        );
        assert!(
            run_sandboxed(
                &policy,
                &[
                    "python3",
                    "-c",
                    "import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.sendto(b'x',('1.1.1.1',53))",
                ],
            ),
            "UDP is outside Landlock's scope: the docs must keep saying so"
        );
        std::fs::remove_dir_all(&workspace).ok();
    }

    /// Persistent workspaces live under ~/.local/share, and ~/.local is in
    /// the read-only allowlist. Landlock resolves by the closest matching
    /// rule, so the workspace rule must win over the enclosing one — if it
    /// ever stops winning, persistent workspaces silently become read-only.
    #[test]
    #[cfg(target_os = "linux")]
    fn a_workspace_inside_a_read_only_tree_stays_writable() {
        if !detect_support().available() {
            return;
        }
        let home = std::env::temp_dir().join(format!("atomis-home-{}", std::process::id()));
        let workspace = home.join(".local/share/atomis/workspaces/w1");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let mut policy = policy_for(&workspace, Path::new("/usr"), Some(&home));
        // policy_for only lists toolchain subtrees; add the enclosing
        // read-only rule this test is about.
        policy.read_only.push(home.join(".local"));
        assert!(
            run_sandboxed(
                &policy,
                &[
                    "/bin/sh",
                    "-c",
                    &format!("echo ok > {}/file.txt", workspace.to_str().expect("path")),
                ],
            ),
            "the workspace rule must override the read-only ancestor"
        );
        assert!(
            !run_sandboxed(
                &policy,
                &[
                    "/bin/sh",
                    "-c",
                    &format!("echo x > {}/.local/share/atomis/other", home.to_str().expect("path")),
                ],
            ),
            "the rest of the read-only tree must stay read-only"
        );
        std::fs::remove_dir_all(&home).ok();
    }

    /// The fetch grant must be exactly that: outbound HTTPS and nothing
    /// else. If it ever widened, a dependency install would become a hole.
    #[test]
    #[cfg(target_os = "linux")]
    fn the_fetch_grant_opens_https_and_nothing_else() {
        if detect_support() != SandboxSupport::FilesAndNetwork {
            eprintln!("landlock ABI < 4: skipping fetch-grant test");
            return;
        }
        let workspace = std::env::temp_dir().join(format!(
            "atomis-sandbox-fetch-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&workspace).expect("workspace");
        let base = policy_for(&workspace, Path::new("/usr"), None);
        let fetching = with_fetch_network(&base);
        let connect = |port: u16| {
            format!("import socket;s=socket.socket();s.settimeout(3);s.connect(('1.1.1.1',{port}))")
        };
        assert!(
            run_sandboxed(&fetching, &["python3", "-c", &connect(443)]),
            "HTTPS must be reachable while installing"
        );
        assert!(
            !run_sandboxed(&fetching, &["python3", "-c", &connect(22)]),
            "every other port stays closed"
        );
        assert!(
            !run_sandboxed(
                &fetching,
                &[
                    "python3",
                    "-c",
                    "import socket;s=socket.socket();s.bind(('127.0.0.1',0))",
                ],
            ),
            "a fetching process still may not listen"
        );
        // And the base policy is untouched: no network at all.
        assert!(
            !run_sandboxed(&base, &["python3", "-c", &connect(443)]),
            "the grant must not leak into the normal policy"
        );
        assert_eq!(
            base.network,
            NetworkAccess::None,
            "with_fetch_network must not mutate the policy it copies"
        );

        // "Allow network" is broader on purpose — any outbound port, since
        // an API can live anywhere — but still cannot listen.
        let outbound = with_outbound_network(&base);
        assert!(
            run_sandboxed(&outbound, &["python3", "-c", &connect(443)]),
            "outbound HTTPS must work for user code"
        );
        assert!(
            !run_sandboxed(
                &outbound,
                &[
                    "python3",
                    "-c",
                    "import socket;s=socket.socket();s.bind(('127.0.0.1',0))",
                ],
            ),
            "granting outbound access must not let a program listen"
        );
        assert!(
            !run_sandboxed(
                &outbound,
                &[
                    "/bin/cat",
                    workspace.parent().expect("parent").to_str().expect("path"),
                ],
            ),
            "the filesystem stays confined even with the network open"
        );
        std::fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn support_levels_map_to_stable_names() {
        assert_eq!(SandboxSupport::FilesAndNetwork.as_str(), "files+network");
        assert_eq!(SandboxSupport::FilesOnly.as_str(), "files");
        assert_eq!(SandboxSupport::Unsupported.as_str(), "unsupported");
        assert!(SandboxSupport::FilesOnly.available());
        assert!(!SandboxSupport::Unsupported.available());
    }
}
