//! Downloading and registering the app's own WSL distribution. A shell script stands in for
//! wsl.exe and records each call, and a local HTTP server stands in for the GitHub release, so
//! Linux checks the same steps that Windows runs (docs/architecture.md#wslのエージェント).
#![cfg(unix)]
use atcoder_ruby_ide::wsl::{agent_command, download, ensure_distribution, DISTRIBUTION};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const LIMIT: Duration = Duration::from_secs(20);

/// Lists AtCoderRubyIDE when `registered` exists, prints its version for `cat`, and imports by
/// copying the image (a text file holding its version) into `registered`.
const FAKE_WSL: &str = r#"#!/bin/sh
echo "$*" >>"$STATE/calls"
case "$1" in
  -l) [ -f "$STATE/registered" ] && echo AtCoderRubyIDE; echo Ubuntu; exit 0 ;;
  -d) [ -f "$STATE/registered" ] || { echo "There is no distribution with the supplied name."; exit 1; }
      shift 3; [ "$1 $2" = "cat /etc/atcoder-ruby-ide-version" ] && cat "$STATE/registered"; exit 0 ;;
  --unregister) rm -f "$STATE/registered"; exit 0 ;;
  --import) [ -f "$STATE/fail-import" ] && { echo "The operation could not be started because a required feature is not installed."; exit 1; }
      [ -d "$3" ] || exit 2; cp "$4" "$STATE/registered"; exit 0 ;;
esac
exit 3
"#;

struct Fake {
    directory: tempfile::TempDir,
    image: PathBuf,
    location: PathBuf,
}

impl Fake {
    fn new(registered: Option<&str>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("wsl");
        std::fs::write(&script, FAKE_WSL).unwrap();
        assert!(Command::new("chmod")
            .arg("+x")
            .arg(&script)
            .status()
            .unwrap()
            .success());
        // A Japanese folder name and a space, like a Windows user folder.
        let image = directory
            .path()
            .join("配布 物")
            .join("atcoder-linux.tar.gz");
        std::fs::create_dir_all(image.parent().unwrap()).unwrap();
        std::fs::write(&image, "v2\n").unwrap();
        if let Some(version) = registered {
            std::fs::write(directory.path().join("registered"), format!("{version}\n")).unwrap();
        }
        let location = directory.path().join("データ").join("wsl");
        Self {
            directory,
            image,
            location,
        }
    }
    fn wsl(&self) -> impl Fn() -> Command + '_ {
        move || {
            let mut command = Command::new(self.directory.path().join("wsl"));
            command.env("STATE", self.directory.path());
            command
        }
    }
    /// Registers with the fake image, recording where the download was asked to go.
    fn ensure(&self) -> Result<(), String> {
        let fetched = self.directory.path().join("fetched");
        ensure_distribution(
            self.wsl(),
            |file: &Path| {
                std::fs::write(&fetched, file.to_str().unwrap()).unwrap();
                std::fs::copy(&self.image, file)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            },
            "v2",
            &self.location,
            LIMIT,
        )
    }
    fn fetched(&self) -> Option<PathBuf> {
        std::fs::read_to_string(self.directory.path().join("fetched"))
            .ok()
            .map(PathBuf::from)
    }
    fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(self.directory.path().join("calls"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }
    fn registered(&self) -> Option<String> {
        std::fs::read_to_string(self.directory.path().join("registered")).ok()
    }
}

fn path(path: &Path) -> &str {
    path.to_str().unwrap()
}

#[test]
fn a_missing_distribution_is_downloaded_imported_into_the_app_data_folder_and_the_file_removed() {
    let fake = Fake::new(None);
    fake.ensure().unwrap();
    assert_eq!(fake.registered().as_deref(), Some("v2\n"));
    let image = fake.location.join("atcoder-linux.tar.gz");
    assert_eq!(fake.fetched(), Some(image.clone()));
    assert_eq!(
        fake.calls(),
        [
            "-l -q".to_string(),
            format!(
                "--import {DISTRIBUTION} {} {}",
                path(&fake.location),
                path(&image)
            ),
        ]
    );
    assert!(!image.exists());
}

#[test]
fn the_registered_distribution_of_the_same_version_is_used_as_it_is() {
    let fake = Fake::new(Some("v2"));
    fake.ensure().unwrap();
    assert_eq!(fake.fetched(), None, "nothing is downloaded");
    assert_eq!(
        fake.calls(),
        [
            "-l -q".to_string(),
            format!("-d {DISTRIBUTION} -e cat /etc/atcoder-ruby-ide-version"),
        ]
    );
}

#[test]
fn another_version_is_unregistered_and_imported_again() {
    let fake = Fake::new(Some("v1"));
    fake.ensure().unwrap();
    assert_eq!(fake.registered().as_deref(), Some("v2\n"));
    let calls = fake.calls();
    assert_eq!(calls[2], format!("--unregister {DISTRIBUTION}"));
    assert!(calls[3].starts_with(&format!("--import {DISTRIBUTION} ")));
}

#[test]
fn a_failed_import_shows_wsl_s_message_and_how_to_prepare_wsl() {
    let fake = Fake::new(None);
    std::fs::write(fake.directory.path().join("fail-import"), "").unwrap();
    let error = fake.ensure().unwrap_err();
    assert!(!fake.location.join("atcoder-linux.tar.gz").exists());
    assert!(
        error.contains("required feature is not installed"),
        "{error}"
    );
    assert!(error.contains("wsl --install --no-distribution"), "{error}");
}

#[test]
fn a_missing_wsl_explains_how_to_prepare_it() {
    let fake = Fake::new(None);
    let error = ensure_distribution(
        || Command::new("/nonexistent/wsl.exe"),
        |_: &Path| Ok(()),
        "v2",
        &fake.location,
        LIMIT,
    )
    .unwrap_err();
    assert!(error.contains("wsl --install --no-distribution"), "{error}");
}

#[test]
fn the_agent_runs_in_the_app_distribution_with_its_ruby_and_lsp() {
    let command = agent_command(Command::new("wsl.exe"));
    let args: Vec<_> = command
        .get_args()
        .map(|arg| arg.to_str().unwrap())
        .collect();
    assert_eq!(
        args,
        [
            "-d",
            DISTRIBUTION,
            "-e",
            "/opt/atcoder-ruby-ide/atcoder-ruby-agent",
            "/opt/atcoder-ruby-ide/ruby/bin/ruby",
            "/opt/atcoder-ruby-ide/ruby-lsp",
        ]
    );
}

#[test]
fn a_failed_download_is_reported_without_importing() {
    let fake = Fake::new(None);
    let error = ensure_distribution(
        fake.wsl(),
        |_: &Path| Err("HTTP 404".to_string()),
        "v2",
        &fake.location,
        LIMIT,
    )
    .unwrap_err();
    assert!(error.contains("HTTP 404"), "{error}");
    assert!(fake
        .calls()
        .iter()
        .all(|call| !call.starts_with("--import")));
}

/// One response of the stand-in release server: a path, and what to answer for it.
enum Answer {
    /// The body in chunks, with a pause after each one.
    Body(Vec<u8>, usize, Duration),
    Redirect(&'static str),
    Status(u16),
}

/// Serves `answers` by path on 127.0.0.1 and returns its origin and the paths it was asked for.
fn serve(answers: Vec<(&'static str, Answer)>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let asked = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&asked);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut line = String::new();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            reader.read_line(&mut line).unwrap();
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).unwrap() <= 2 {
                    break;
                }
            }
            let target = line.split_whitespace().nth(1).unwrap_or("").to_string();
            log.lock().unwrap().push(target.clone());
            let _ = match answers.iter().find(|(path, _)| *path == target).map(|(_, a)| a) {
                Some(Answer::Body(body, chunk, pause)) => (|| {
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len())?;
                    for part in body.chunks(*chunk) {
                        stream.write_all(part)?;
                        stream.flush()?;
                        std::thread::sleep(*pause);
                    }
                    Ok::<_, std::io::Error>(())
                })(),
                Some(Answer::Redirect(to)) => write!(stream, "HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                Some(Answer::Status(code)) => write!(stream, "HTTP/1.1 {code} Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                None => write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
            };
        }
    });
    (origin, asked)
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

const STALL: Duration = Duration::from_secs(1);

#[test]
fn the_image_is_downloaded_through_a_redirect_with_progress_and_checked() {
    let image: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let (origin, asked) = serve(vec![
        (
            "/release/atcoder-linux.tar.gz",
            Answer::Redirect("/storage/image"),
        ),
        // 1.2 seconds in all, longer than STALL: only a pause in receiving counts.
        (
            "/storage/image",
            Answer::Body(image.clone(), 100_000, Duration::from_millis(400)),
        ),
    ]);
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("データ").join("atcoder-linux.tar.gz");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let mut progress = Vec::new();
    download(
        &format!("{origin}/release/atcoder-linux.tar.gz"),
        &sha256(&image),
        &file,
        STALL,
        |received, total| progress.push((received, total)),
    )
    .unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), image);
    assert_eq!(
        *asked.lock().unwrap(),
        ["/release/atcoder-linux.tar.gz", "/storage/image"]
    );
    assert_eq!(progress.last(), Some(&(300_000, Some(300_000))));
    assert!(
        progress.windows(2).all(|pair| pair[0].0 <= pair[1].0),
        "{progress:?}"
    );
    assert!(progress.len() >= 2, "{progress:?}");
}

/// Downloads `answer` and returns the error, checking that no file is left behind.
fn failed_download(answer: Answer, sha: &str) -> String {
    let (origin, _) = serve(vec![("/image", answer)]);
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("atcoder-linux.tar.gz");
    let error = download(&format!("{origin}/image"), sha, &file, STALL, |_, _| {}).unwrap_err();
    assert_eq!(
        std::fs::read_dir(directory.path()).unwrap().count(),
        0,
        "{error}"
    );
    error
}

#[test]
fn a_different_sha256_is_rejected_and_nothing_is_left() {
    let error = failed_download(
        Answer::Body(b"other image".to_vec(), 1024, Duration::ZERO),
        &sha256(b"image"),
    );
    assert!(error.contains("SHA-256"), "{error}");
}

#[test]
fn a_network_failure_says_what_to_do_without_the_long_url() {
    let directory = tempfile::tempdir().unwrap();
    let url =
        "http://127.0.0.1:1/releases/download/wsl-images/atcoder-linux-0123456789abcdef.tar.gz";
    let error = download(
        url,
        &sha256(b"image"),
        &directory.path().join("image"),
        STALL,
        |_, _| {},
    )
    .unwrap_err();
    assert!(
        error.starts_with("Linuxのイメージを取得できません（"),
        "{error}"
    );
    assert!(
        error.contains(
            "ネットワークにつながっているか確かめてから、「Ruby を再確認」を押してください。"
        ),
        "{error}"
    );
    assert!(!error.contains("0123456789abcdef"), "{error}");
}

#[test]
fn an_http_error_is_reported() {
    let error = failed_download(Answer::Status(404), &sha256(b"image"));
    assert!(error.contains("404"), "{error}");
}

#[test]
fn a_download_that_stops_sending_fails() {
    let error = failed_download(
        Answer::Body(vec![0; 2000], 1000, Duration::from_secs(3)),
        &sha256(&[0; 2000]),
    );
    assert!(!error.is_empty());
}
