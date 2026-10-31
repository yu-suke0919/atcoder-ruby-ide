use std::io;
use std::process::{Child, Command};

#[cfg(windows)]
pub struct ProcessTree {
    job: std::os::windows::io::OwnedHandle,
    completion: Option<std::os::windows::io::OwnedHandle>,
}

#[cfg(windows)]
impl ProcessTree {
    pub fn spawn(command: &mut Command, memory_limit: Option<usize>) -> io::Result<(Child, Self)> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::System::JobObjects::*;
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        use windows_sys::Win32::System::IO::CreateIoCompletionPort;
        // Configure the Job before any Ruby code can run or spawn descendants.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = OwnedHandle::from_raw_handle(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Some(bytes) = memory_limit {
                info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
                info.JobMemoryLimit = bytes;
            }
            if SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let completion = if memory_limit.is_some() {
                let port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1);
                if port.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let port = OwnedHandle::from_raw_handle(port);
                let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
                    CompletionKey: std::ptr::null_mut(),
                    CompletionPort: port.as_raw_handle(),
                };
                if SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectAssociateCompletionPortInformation,
                    (&association as *const JOBOBJECT_ASSOCIATE_COMPLETION_PORT).cast(),
                    std::mem::size_of_val(&association) as u32,
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Some(port)
            } else {
                None
            };
            let mut child = command
                .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)
                .spawn()?;
            let assigned =
                if AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) == 0 {
                    Err(io::Error::last_os_error())
                } else {
                    resume_main_thread(child.id())
                };
            if let Err(error) = assigned {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            Ok((child, Self { job, completion }))
        }
    }

    pub fn memory_limit_reached(&self) -> io::Result<bool> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
        use windows_sys::Win32::System::SystemServices::JOB_OBJECT_MSG_JOB_MEMORY_LIMIT;
        use windows_sys::Win32::System::IO::GetQueuedCompletionStatus;
        let Some(port) = &self.completion else {
            return Ok(false);
        };
        loop {
            let mut message = 0;
            let mut key = 0;
            let mut overlapped = std::ptr::null_mut();
            if unsafe {
                GetQueuedCompletionStatus(
                    port.as_raw_handle(),
                    &mut message,
                    &mut key,
                    &mut overlapped,
                    0,
                )
            } == 0
            {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(WAIT_TIMEOUT as i32) {
                    Ok(false)
                } else {
                    Err(error)
                };
            }
            if message == JOB_OBJECT_MSG_JOB_MEMORY_LIMIT {
                return Ok(true);
            }
        }
    }
    pub fn kill(&self) {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job.as_raw_handle(), 1);
        }
    }

    #[cfg(test)]
    pub(crate) fn post_memory_limit_notification(&self) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::SystemServices::JOB_OBJECT_MSG_JOB_MEMORY_LIMIT;
        use windows_sys::Win32::System::IO::PostQueuedCompletionStatus;
        // Exercise the real completion port without depending on OS limit-event delivery.
        if unsafe {
            PostQueuedCompletionStatus(
                self.completion.as_ref().unwrap().as_raw_handle(),
                JOB_OBJECT_MSG_JOB_MEMORY_LIMIT,
                0,
                std::ptr::null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
fn resume_main_thread(pid: u32) -> io::Result<()> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    // Stable Rust does not expose Child's main thread handle. A newly created,
    // suspended process has not run its loader or created additional threads yet.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snapshot = OwnedHandle::from_raw_handle(snapshot);
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut found = Thread32First(snapshot.as_raw_handle(), &mut entry);
        while found != 0 {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if thread.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let thread = OwnedHandle::from_raw_handle(thread);
                if ResumeThread(thread.as_raw_handle()) == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                return Ok(());
            }
            found = Thread32Next(snapshot.as_raw_handle(), &mut entry);
        }
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            "Rubyのメインスレッドが見つかりません。",
        ))
    }
}

#[cfg(unix)]
pub struct ProcessTree(i32);
#[cfg(unix)]
impl ProcessTree {
    pub fn spawn(command: &mut Command, _memory_limit: Option<usize>) -> io::Result<(Child, Self)> {
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
