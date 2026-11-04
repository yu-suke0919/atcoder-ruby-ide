use crate::{RunRequest, Runner};
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

#[derive(Serialize)]
pub struct RubyInfo {
    pub version: String,
    /// Whether runs use --jit; not on WSL1.
    pub jit: bool,
}

pub fn ruby_info(path: &Path) -> Result<RubyInfo, String> {
    let result = Runner::new(Duration::from_secs(5), 16384)
        .prepare(RunRequest {
            code: "puts RUBY_DESCRIPTION".into(),
            ..Default::default()
        })?
        .execute(path, |_| {})?;
    if result.status != "completed" {
        return Err(format!(
            "Ruby を起動できません（{}、終了コード{:?}）: {}",
            result.status, result.exit_code, result.stderr
        ));
    }
    Ok(RubyInfo {
        version: result.stdout.trim().into(),
        jit: crate::process::jit(),
    })
}
