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
