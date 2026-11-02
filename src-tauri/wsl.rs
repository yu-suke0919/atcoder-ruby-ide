//! The app's own WSL distribution: registers the bundled Linux (Ruby, gems, Ruby LSP and the agent)
//! with `wsl --import` and builds the command that starts the agent in it.
//! See docs/architecture.md#wslのエージェント.
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const DISTRIBUTION: &str = "AtCoderRubyIDE";
const HOME: &str = "/opt/atcoder-ruby-ide";
const VERSION_FILE: &str = "/etc/atcoder-ruby-ide-version";

/// How to prepare WSL, appended to every failure to start or register the distribution.
pub const GUIDANCE: &str = "WSL2を準備してください：管理者のPowerShellで「wsl --install --no-distribution」を実行して再起動します。CPUの仮想化機能が無効な場合は、BIOS/UEFIで有効にしてください。";

/// Makes sure the app's distribution is registered with `version`, importing `image` into
/// `location` when it is missing or another version. `wsl` builds a fresh `wsl.exe` command.
pub fn ensure_distribution(
    wsl: impl Fn() -> Command,
    image: &Path,
    version: &str,
    location: &Path,
    limit: Duration,
) -> Result<(), String> {
    let fail = |reason: String| format!("WSLを準備できません: {reason}\n{GUIDANCE}");
    let deadline = Instant::now() + limit;
    let run = |mut command: Command| run(&mut command, deadline).map_err(fail);
    let mut list = wsl();
    list.args(["-l", "-q"]);
    // With no distribution at all wsl.exe fails; that only means ours is missing too.
    let registered = run(list).map_or(false, |(_, output)| {
        output.lines().any(|name| name.trim() == DISTRIBUTION)
    });
    if registered {
        let mut read = wsl();
        read.args(["-d", DISTRIBUTION, "-e", "cat", VERSION_FILE]);
        let (success, output) = run(read)?;
        if success && output.trim() == version {
            return Ok(());
        }
        let mut unregister = wsl();
        unregister.args(["--unregister", DISTRIBUTION]);
        expect_success(run(unregister)?).map_err(fail)?;
    }
    std::fs::create_dir_all(location).map_err(|e| fail(e.to_string()))?;
    let mut import = wsl();
    import
        .args(["--import", DISTRIBUTION])
        .arg(location)
        .arg(image);
    expect_success(run(import)?).map_err(fail)
}

fn expect_success((success, output): (bool, String)) -> Result<(), String> {
    if success {
        Ok(())
    } else {
        Err(output.trim().to_string())
    }
}

/// Runs `command` until `deadline`; wsl.exe reports its own failures on stdout.
fn run(command: &mut Command, deadline: Instant) -> Result<(bool, String), String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let read = |mut stream: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stream.read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes).replace('\0', "")
        })
    };
    let stdout = read(Box::new(child.stdout.take().unwrap()));
    let stderr = read(Box::new(child.stderr.take().unwrap()));
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("時間内に終わりませんでした。".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let output = stdout.join().unwrap_or_default() + &stderr.join().unwrap_or_default();
    Ok((status.success(), output))
}

/// The agent in the app's distribution, with the Ruby and Ruby LSP next to it.
pub fn agent_command(mut wsl: Command) -> Command {
    wsl.args(["-d", DISTRIBUTION, "-e"])
        .arg(format!("{HOME}/atcoder-ruby-agent"))
        .arg(format!("{HOME}/ruby/bin/ruby"))
        .arg(format!("{HOME}/ruby-lsp"));
    wsl
}

/// `wsl.exe` without a console window and with UTF-8 output.
#[cfg(windows)]
pub fn wsl() -> Command {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("wsl.exe");
    command
        .env("WSL_UTF8", "1")
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    command
}
