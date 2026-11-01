use crate::{RunRequest, Runner};
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

#[derive(Serialize)]
pub struct RubyInfo {
    pub version: String,
}

pub fn ruby_info(path: &Path) -> Result<RubyInfo, String> {
    let result = Runner::new(Duration::from_secs(5), 16384)
        .prepare(RunRequest {
            code: "puts RUBY_DESCRIPTION".into(),
            ..Default::default()
        })?
        .execute(path, |_| {})?;
    if result.status != "completed" {
        return Err(format!("Ruby を起動できません: {}", result.stderr));
    }
    Ok(RubyInfo {
        version: result.stdout.trim().into(),
    })
}
