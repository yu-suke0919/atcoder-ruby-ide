//! Places the bundled runtime (agent, Ruby, gems, Ruby LSP) inside WSL and builds the command
//! that starts the agent. See docs/architecture.md#wslのエージェント.
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How to prepare WSL, appended to every failure to start or place the runtime.
pub const GUIDANCE: &str = "WSL2とUbuntuを準備してください：管理者のPowerShellで「wsl --install」を実行して再起動し、Ubuntuの初回設定（ユーザー名とパスワード）を済ませます。CPUの仮想化機能が無効な場合は、BIOS/UEFIで有効にしてください。";

/// `sh` script: `$1` the archive (a Windows path is converted with wslpath), `$2` its SHA-256.
/// Prints the folder that holds the runtime.
const PLACE: &str = r#"set -eu
archive=$1
if command -v wslpath >/dev/null 2>&1; then archive=$(wslpath -a "$1"); fi
root="$HOME/.atcoder-ruby-ide"
target="$root/$2"
mkdir -p "$root"
if [ ! -x "$target/atcoder-ruby-agent" ]; then
  temporary=$(mktemp -d "$root/.tmp-XXXXXX")
  trap 'rm -rf "$temporary"' EXIT
  echo "$2  $archive" | sha256sum -c --status - || { echo "同梱物のSHA-256が一致しません: $archive" >&2; exit 1; }
  tar -xzf "$archive" -C "$temporary"
  rm -rf "$target"
  mv "$temporary" "$target"
  trap - EXIT
fi
for old in "$root"/* "$root"/.tmp-*; do
  if [ -e "$old" ] && [ "$old" != "$target" ]; then rm -rf "$old"; fi
done
printf '%s\n' "$target""#;

/// Runs the placement through `prefix` (`wsl.exe -e` on Windows) and returns the folder.
pub fn place(
    mut prefix: Command,
    archive: &str,
    sha256: &str,
    limit: Duration,
) -> Result<String, String> {
    let fail = |reason: String| format!("WSLにRubyを配置できません: {reason}\n{GUIDANCE}");
    let mut child = prefix
        .args(["sh", "-c", PLACE, "sh", archive, sha256])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| fail(e.to_string()))?;
    let (mut stdout, mut stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let output = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + limit;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| fail(e.to_string()))? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(fail(format!(
                "{}秒以内に終わりませんでした。",
                limit.as_secs()
            )));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let (output, errors) = (
        output.join().unwrap_or_default(),
        errors.join().unwrap_or_default(),
    );
    // wsl.exe reports its own failures (no distribution, virtualization off) on stdout.
    if !status.success() {
        return Err(fail(format!("{}{}", errors.trim(), output.trim())));
    }
    output
        .lines()
        .last()
        .map(str::to_string)
        .filter(|folder| folder.starts_with('/'))
        .ok_or_else(|| fail(format!("配置先を読み取れません: {output}")))
}

/// The agent in `folder`, started through `prefix`, with the Ruby and Ruby LSP next to it.
pub fn agent_command(mut prefix: Command, folder: &str) -> Command {
    prefix
        .arg(format!("{folder}/atcoder-ruby-agent"))
        .arg(format!("{folder}/ruby/bin/ruby"))
        .arg(format!("{folder}/ruby-lsp"));
    prefix
}

/// `wsl.exe -e` for the default distribution, without a console window and with UTF-8 output.
#[cfg(windows)]
pub fn wsl() -> Command {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("wsl.exe");
    command
        .env("WSL_UTF8", "1")
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .arg("-e");
    command
}
