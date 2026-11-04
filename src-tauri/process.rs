//! Starting Ruby in its own process group and stopping the group. Ruby runs only in the agent,
//! on Linux (docs/architecture.md#wslのエージェント).
use std::io;
use std::process::{Child, Command};

/// Ruby's process group, started by `ruby_command`, which the runner and LSP stop as a whole.
pub struct ProcessTree(i32);
impl ProcessTree {
    pub fn spawn(command: &mut Command) -> io::Result<(Child, Self)> {
        let child = command.spawn()?;
        let tree = Self(child.id() as i32);
        Ok((child, tree))
    }
    pub fn kill(&self) {
        unsafe {
            libc::kill(-self.0, libc::SIGKILL);
        }
    }
    /// The memory in use (RSS) of every process in the group, from /proc, which WSL1 has too.
    pub fn resident_bytes(&self) -> u64 {
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as u64;
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return 0;
        };
        let in_group = |path: &std::path::Path| {
            // The process group is the fifth field of stat: the third after the name in parentheses.
            std::fs::read_to_string(path.join("stat"))
                .ok()
                .and_then(|stat| {
                    stat.rsplit_once(')')?
                        .1
                        .split_whitespace()
                        .nth(2)?
                        .parse::<i32>()
                        .ok()
                })
                == Some(self.0)
        };
        let pages: u64 = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit()))
            })
            .filter(|path| in_group(path))
            .filter_map(|path| {
                let statm = std::fs::read_to_string(path.join("statm")).ok()?;
                statm.split_whitespace().nth(1)?.parse::<u64>().ok()
            })
            .sum();
        pages * page
    }
}

/// Whether Ruby runs with --jit: not on WSL1, whose kernel release ends with "Microsoft" and where
/// starting YJIT took about 8 seconds (docs/atcoder-runtime.md#jitc5).
pub(crate) fn jit() -> bool {
    static JIT: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *JIT.get_or_init(|| {
        !std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .is_ok_and(|release| release.trim_end().ends_with("Microsoft"))
    })
}

/// Raises the native stack (the soft RLIMIT_STACK) to `bytes`, or the hard limit if that is lower,
/// in the started process; Ruby's main thread gets it, and children inherit it.
pub(crate) fn raise_stack_limit(command: &mut Command, bytes: u64) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(move || {
            let mut limit = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            if libc::getrlimit(libc::RLIMIT_STACK, &mut limit) != 0 {
                return Err(io::Error::last_os_error());
            }
            limit.rlim_cur = if limit.rlim_max == libc::RLIM_INFINITY {
                bytes as libc::rlim_t
            } else {
                (bytes as libc::rlim_t).min(limit.rlim_max)
            };
            if libc::setrlimit(libc::RLIMIT_STACK, &limit) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// Isolate every Ruby process from the caller's Ruby/Bundler environment.
/// With `limit`, GNU timeout leads the process group on Linux and kills the whole group 2 seconds
/// after the limit, which the runner enforces itself, so Ruby stops even if the agent is killed.
pub(crate) fn ruby_command(
    ruby: &std::path::Path,
    limit: Option<std::time::Duration>,
) -> std::process::Command {
    // A missing Ruby is left to fail when it is started, as it does without timeout.
    let mut command = match limit.zip(executable(ruby)) {
        Some((limit, ruby)) => {
            let limit = limit + std::time::Duration::from_secs(2);
            let mut command = std::process::Command::new("timeout");
            command
                .args(["-s", "KILL"])
                .arg(format!("{}.{:03}", limit.as_secs(), limit.subsec_millis()))
                .arg(ruby);
            command
        }
        None => std::process::Command::new(ruby),
    };
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy().to_ascii_uppercase();
        if matches!(
            name.as_str(),
            "RUBYOPT" | "RUBYLIB" | "GEM_HOME" | "GEM_PATH" | "RUBYGEMS_GEMDEPS"
        ) || name.starts_with("BUNDLE_")
            || name.starts_with("BUNDLER_ORIG_")
        {
            command.env_remove(key);
        }
    }
    command.args(["--disable=rubyopt", "-EUTF-8:UTF-8"]);
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    command
}

/// The executable file `program` runs: a path, or a name looked up in PATH.
fn executable(program: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let runnable = |path: &std::path::Path| {
        path.metadata()
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    };
    if program.components().count() > 1 {
        return runnable(program).then(|| program.to_path_buf());
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|directory| directory.join(program))
        .find(|path| runnable(path))
}

pub(crate) fn nonblocking(pipe: &impl std::os::fd::AsRawFd) -> io::Result<()> {
    let fd = pipe.as_raw_fd();
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}
