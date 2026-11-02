//! Placing the bundled runtime inside WSL. The placement script is plain `sh`, so Linux runs
//! it directly; Windows runs the same script through `wsl.exe -e`.
#![cfg(unix)]
use atcoder_ruby_ide::wsl::{agent_command, place};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const LIMIT: Duration = Duration::from_secs(20);

struct Fixture {
    _directory: tempfile::TempDir,
    home: PathBuf,
    archive: String,
    sha256: String,
}

/// A runtime archive with an agent script and a Ruby folder, like the real one.
fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    std::fs::create_dir_all(source.join("ruby/bin")).unwrap();
    std::fs::write(
        source.join("atcoder-ruby-agent"),
        "#!/bin/sh\necho agent \"$@\"\n",
    )
    .unwrap();
    std::fs::write(source.join("ruby/bin/ruby"), "#!/bin/sh\n").unwrap();
    for file in ["atcoder-ruby-agent", "ruby/bin/ruby"] {
        let status = Command::new("chmod")
            .arg("+x")
            .arg(source.join(file))
            .status()
            .unwrap();
        assert!(status.success());
    }
    // A Japanese folder name and a space, like a Windows user folder.
    let archive = directory
        .path()
        .join("配布 物")
        .join("atcoder-runtime.tar.gz");
    std::fs::create_dir_all(archive.parent().unwrap()).unwrap();
    let status = Command::new("tar")
        .arg("-czf")
        .arg(&archive)
        .arg("-C")
        .arg(&source)
        .args(["atcoder-ruby-agent", "ruby"])
        .status()
        .unwrap();
    assert!(status.success());
    let output = Command::new("sha256sum").arg(&archive).output().unwrap();
    let sha256 = String::from_utf8(output.stdout).unwrap()[..64].to_string();
    let home = directory.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    Fixture {
        archive: archive.to_str().unwrap().into(),
        _directory: directory,
        home,
        sha256,
    }
}

fn shell(home: &Path) -> Command {
    let mut command = Command::new("env");
    command.env("HOME", home);
    command
}

fn entries(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

#[test]
fn the_runtime_is_placed_once_under_its_hash_and_reused() {
    let f = fixture();
    let placed = place(shell(&f.home), &f.archive, &f.sha256, LIMIT).unwrap();
    let root = f.home.join(".atcoder-ruby-ide");
    assert_eq!(PathBuf::from(&placed), root.join(&f.sha256));
    assert!(root.join(&f.sha256).join("atcoder-ruby-agent").is_file());
    std::fs::write(root.join(&f.sha256).join("marker"), "").unwrap();
    assert_eq!(
        place(shell(&f.home), &f.archive, &f.sha256, LIMIT).unwrap(),
        placed
    );
    assert!(
        root.join(&f.sha256).join("marker").exists(),
        "reused, not extracted again"
    );
    assert_eq!(entries(&root), [f.sha256.clone()]);
}

#[test]
fn other_versions_and_left_over_temporary_folders_are_removed() {
    let f = fixture();
    let root = f.home.join(".atcoder-ruby-ide");
    for old in ["0".repeat(64), ".tmp-left".into()] {
        std::fs::create_dir_all(root.join(old).join("ruby")).unwrap();
    }
    place(shell(&f.home), &f.archive, &f.sha256, LIMIT).unwrap();
    assert_eq!(entries(&root), [f.sha256.clone()]);
}

#[test]
fn a_damaged_archive_is_not_placed() {
    let f = fixture();
    let wrong = "f".repeat(64);
    let error = place(shell(&f.home), &f.archive, &wrong, LIMIT).unwrap_err();
    assert!(error.contains("配置"), "{error}");
    let root = f.home.join(".atcoder-ruby-ide");
    assert!(entries(&root).is_empty(), "{:?}", entries(&root));
}

#[test]
fn a_missing_wsl_explains_how_to_prepare_it() {
    let f = fixture();
    let error = place(
        Command::new("/nonexistent/wsl.exe"),
        &f.archive,
        &f.sha256,
        LIMIT,
    )
    .unwrap_err();
    assert!(error.contains("wsl --install"), "{error}");
}

#[test]
fn the_agent_runs_from_the_placed_folder_with_its_ruby_and_lsp() {
    let f = fixture();
    let placed = place(shell(&f.home), &f.archive, &f.sha256, LIMIT).unwrap();
    let output = agent_command(Command::new("env"), &placed)
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("agent {placed}/ruby/bin/ruby {placed}/ruby-lsp\n")
    );
}
