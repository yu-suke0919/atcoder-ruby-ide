use std::io;
use std::process::Child;

#[cfg(windows)]
pub struct ProcessTree(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl ProcessTree {
    pub fn attach(child: &Child) -> io::Result<Self> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::*;
        // The owned job closes once the run finishes; Windows also releases redirected descendants.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = OwnedHandle::from_raw_handle(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            if AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(job))
        }
    }
    pub fn kill(&self) {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0.as_raw_handle(), 1);
        }
    }
}

#[cfg(unix)]
pub struct ProcessTree(i32);
#[cfg(unix)]
impl ProcessTree {
    pub fn attach(child: &Child) -> io::Result<Self> {
        Ok(Self(child.id() as i32))
    }
    pub fn kill(&self) {
        unsafe {
            libc::kill(-self.0, libc::SIGKILL);
        }
    }
}

/// Isolate every Ruby process from the caller's Ruby/Bundler environment.
pub(crate) fn ruby_command(ruby: &std::path::Path) -> std::process::Command {
    let mut command = std::process::Command::new(ruby);
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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

#[cfg(unix)]
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
