use atcoder_ruby_ide::{RubyLsp, RunRequest, Runner};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

fn ruby() -> PathBuf {
    std::env::var_os("RUBY_PATH")
        .unwrap_or_else(|| "ruby".into())
        .into()
}

fn resources() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/ruby-lsp")
}

fn has_label(result: &Value, label: &str) -> bool {
    result
        .as_array()
        .or_else(|| result["items"].as_array())
        .unwrap()
        .iter()
        .any(|item| item["label"].as_str().is_some_and(|s| s.starts_with(label)))
}

#[test]
fn real_lsp_syncs_unsaved_utf16_code_and_restarts_without_affecting_competition_gems() {
    let lsp = RubyLsp::default();
    let info = lsp.start(&ruby(), &resources()).unwrap();
    assert_eq!(info.position_encoding, "utf-16");
    assert_eq!(lsp.start(&ruby(), &resources()).unwrap().pid, info.pid);
    let code =
        "limit = 10\nclass IdeUnsaved; def unique_ide_method; end; end\nIdeUnsaved.new.unique_ide_";
    let result = lsp.complete(code, 2, 26).unwrap();
    assert!(has_label(&result, "unique_ide_method"), "{result}");
    let code = "limit = 20\nclass IdeChanged; def changed_ide_method; end; end\n\"😀日本語\"; IdeChanged.new.changed_ide_";
    let character = code.lines().nth(2).unwrap().encode_utf16().count() as u32;
    let result = lsp.complete(code, 2, character).unwrap();
    assert!(has_label(&result, "changed_ide_method"), "{result}");
    let items = result
        .as_array()
        .or_else(|| result["items"].as_array())
        .unwrap();
    let edit = &items
        .iter()
        .find(|item| item["label"] == "changed_ide_method")
        .unwrap()["textEdit"];
    assert_eq!(edit["range"]["end"]["character"], character);
    assert_eq!(
        edit["range"]["start"]["character"],
        character - "changed_ide_".len() as u32
    );
    assert!(!has_label(&result, "unique_ide_method"), "{result}");
    let removed = "limit = 30\nclass IdeChanged; end\nIdeChanged.new.changed_ide_";
    let result = lsp
        .complete(
            removed,
            2,
            removed.lines().last().unwrap().encode_utf16().count() as u32,
        )
        .unwrap();
    assert!(!has_label(&result, "changed_ide_method"), "{result}");
    assert!(lsp.complete(code, 2, 2).is_err()); // Inside the surrogate pair.
    assert!(lsp.complete(code, 5, 0).is_err());
    assert!(lsp.complete(&"a".repeat(1048577), 0, 0).is_err());
    // Invalid caller input must leave the running session usable.
    assert!(has_label(
        &lsp.complete(code, 2, character).unwrap(),
        "changed_ide_method"
    ));
    let runner = Runner::new(Duration::from_secs(5), 16384);
    let result = runner.prepare(RunRequest {
        code: "require 'ac-library-rb/dsu'; begin; require 'ruby-lsp'; raise 'LSP leaked'; rescue LoadError; puts 'isolated'; end".into(),
        ..Default::default()
    }).unwrap().execute(&ruby(), |_| {}).unwrap();
    assert_eq!(result.stdout, "isolated\n");
    assert_eq!(result.status, "completed", "{}", result.stderr);
    assert!(lsp.stop());
    assert!(!lsp.stop());
    assert!(lsp.complete(code, 2, character).is_err());
    let next = lsp.start(&ruby(), &resources()).unwrap();
    assert_ne!(next.pid, info.pid);
    // Simulate the language server crashing, independently of the application.
    let status = std::process::Command::new(ruby())
        .args([
            "-e",
            "Process.kill('KILL', ARGV[0].to_i)",
            &next.pid.to_string(),
        ])
        .status()
        .unwrap();
    assert!(status.success());
    assert!(lsp.complete(code, 2, character).is_err());
    assert!(lsp.start(&ruby(), &resources()).is_ok());
    assert!(lsp.stop());
}

#[test]
fn missing_lsp_resources_fail_cleanly_and_can_retry() {
    let lsp = RubyLsp::default();
    let root = tempfile::tempdir().unwrap();
    assert!(lsp.start(&ruby(), root.path()).is_err());
    assert!(!lsp.stop());
    assert!(lsp.start(&ruby(), &resources()).is_ok());
}
