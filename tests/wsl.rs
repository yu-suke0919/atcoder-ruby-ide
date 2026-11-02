//! Registering the app's own WSL distribution. A shell script stands in for wsl.exe and records
//! each call, so Linux checks the same steps that Windows runs (docs/architecture.md#wslのエージェント).
#![cfg(unix)]
use atcoder_ruby_ide::wsl::{agent_command, ensure_distribution, DISTRIBUTION};
use std::path::{Path, PathBuf};
use std::process::Command;
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
    fn ensure(&self) -> Result<(), String> {
        ensure_distribution(self.wsl(), &self.image, "v2", &self.location, LIMIT)
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
fn a_missing_distribution_is_imported_into_the_app_data_folder() {
    let fake = Fake::new(None);
    fake.ensure().unwrap();
    assert_eq!(fake.registered().as_deref(), Some("v2\n"));
    assert_eq!(
        fake.calls(),
        [
            "-l -q".to_string(),
            format!(
                "--import {DISTRIBUTION} {} {}",
                path(&fake.location),
                path(&fake.image)
            ),
        ]
    );
}

#[test]
fn the_registered_distribution_of_the_same_version_is_used_as_it_is() {
    let fake = Fake::new(Some("v2"));
    fake.ensure().unwrap();
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
        &fake.image,
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
