//! The app's own WSL distribution: downloads the Linux image (Ruby, gems, Ruby LSP and the agent),
//! registers it with `wsl --import` and builds the command that starts the agent in it.
//! See docs/architecture.md#wslのエージェント.
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const DISTRIBUTION: &str = "AtCoderRubyIDE";
const HOME: &str = "/opt/atcoder-ruby-ide";
const VERSION_FILE: &str = "/etc/atcoder-ruby-ide-version";

/// How to prepare WSL, appended to every failure to start or register the distribution.
pub const GUIDANCE: &str = "WSL2を準備してください：管理者のPowerShellで「wsl --install --no-distribution」を実行して再起動します。CPUの仮想化機能が無効な場合は、BIOS/UEFIで有効にしてください。";

/// Makes sure the app's distribution is registered with `version`. When it is missing or another
/// version, `fetch` writes the image into `location`, which is imported there and then removed.
/// `wsl` builds a fresh `wsl.exe` command; each command may take `limit`.
pub fn ensure_distribution(
    wsl: impl Fn() -> Command,
    fetch: impl FnOnce(&Path) -> Result<(), String>,
    version: &str,
    location: &Path,
    limit: Duration,
) -> Result<(), String> {
    let fail = |reason: String| format!("WSLを準備できません: {reason}\n{GUIDANCE}");
    let run = |mut command: Command| run(&mut command, limit).map_err(fail);
    let mut list = wsl();
    list.args(["-l", "-q"]);
    // With no distribution at all wsl.exe fails; that only means ours is missing too.
    let registered =
        run(list).is_ok_and(|(_, output)| output.lines().any(|name| name.trim() == DISTRIBUTION));
    if registered {
        let mut read = wsl();
        read.args(["-d", DISTRIBUTION, "-e", "cat", VERSION_FILE]);
        let (success, output) = run(read)?;
        if success && output.trim() == version {
            return Ok(());
        }
    }
    std::fs::create_dir_all(location).map_err(|e| fail(e.to_string()))?;
    let image = location.join(IMAGE);
    // Downloaded first, so a failed download keeps the registered distribution.
    fetch(&image)?;
    let imported = (|| {
        if registered {
            let mut unregister = wsl();
            unregister.args(["--unregister", DISTRIBUTION]);
            expect_success(run(unregister)?).map_err(fail)?;
        }
        let mut import = wsl();
        import
            .args(["--import", DISTRIBUTION])
            .arg(location)
            .arg(&image);
        expect_success(run(import)?).map_err(fail)
    })();
    let _ = std::fs::remove_file(&image);
    imported
}

const IMAGE: &str = "atcoder-linux.tar.gz";

/// Downloads `url` into `file` and checks its SHA-256, following redirects and the system's proxy.
/// While receiving it writes `file`.part and reports the bytes received and the total; it fails
/// when nothing arrives for `stall`, and then leaves no file.
pub fn download(
    url: &str,
    sha256: &str,
    file: &Path,
    stall: Duration,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<(), String> {
    let mut part = file.as_os_str().to_owned();
    part.push(".part");
    let part = std::path::PathBuf::from(part);
    let received = (|| {
        let client = reqwest::blocking::Client::builder()
            .use_native_tls()
            .connect_timeout(Duration::from_secs(15))
            .timeout(stall)
            .user_agent(concat!("AtCoder-Ruby-IDE/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        // The URL is long and in runtime.json already; the reason is enough on the screen.
        let mut response = client
            .get(url)
            .send()
            .map_err(|e| e.without_url().to_string())?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        let total = response.content_length();
        let mut output = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = vec![0; 1 << 16];
        let mut received = 0;
        loop {
            let count = response.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
            output
                .write_all(&buffer[..count])
                .map_err(|e| e.to_string())?;
            received += count as u64;
            progress(received, total);
        }
        output.sync_all().map_err(|e| e.to_string())?;
        let actual: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if !actual.eq_ignore_ascii_case(sha256) {
            return Err("取得したイメージのSHA-256が一致しません".into());
        }
        std::fs::rename(&part, file).map_err(|e| e.to_string())
    })();
    if received.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    received.map_err(|e| {
        format!("Linuxのイメージを取得できません（{e}）。ネットワークにつながっているか確かめてから、「Ruby を再確認」を押してください。")
    })
}

fn expect_success((success, output): (bool, String)) -> Result<(), String> {
    if success {
        Ok(())
    } else {
        Err(output.trim().to_string())
    }
}

/// Runs `command` for up to `limit`; wsl.exe reports its own failures on stdout.
fn run(command: &mut Command, limit: Duration) -> Result<(bool, String), String> {
    let deadline = Instant::now() + limit;
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
