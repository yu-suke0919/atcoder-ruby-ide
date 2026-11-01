use crate::files::{read_limited, write_atomic, MAX_TEXT_BYTES};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The solution file of the opened problem. Saving only ever writes back to it.
#[derive(Default)]
pub struct DocumentStore {
    file_path: Option<PathBuf>,
    revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentResult {
    pub file_path: String,
    pub code: String,
}

impl DocumentStore {
    pub fn path(&self) -> Option<&Path> {
        self.file_path.as_deref()
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn reset(&mut self) {
        self.file_path = None;
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn open(&mut self, path: PathBuf) -> Result<DocumentResult, String> {
        let data = read_limited(&path, MAX_TEXT_BYTES)
            .map_err(|e| format!("ファイルを読み込めません（上限 1 MiB）: {e}"))?;
        let code = String::from_utf8(data)
            .map_err(|e| format!("ファイルは UTF-8 で保存してください: {e}"))?;
        let code = code.strip_prefix('\u{feff}').unwrap_or(&code).to_owned();
        let file_path = path.to_string_lossy().into();
        self.file_path = Some(path);
        self.revision = self.revision.wrapping_add(1);
        Ok(DocumentResult { file_path, code })
    }

    pub fn save(&self, code: &str) -> Result<(), String> {
        let path = self
            .file_path
            .as_deref()
            .ok_or("問題を開いてから保存してください。")?;
        if code.len() > MAX_TEXT_BYTES {
            return Err("コードは 1 MiB 以下にしてください。".into());
        }
        write_atomic(path, code.as_bytes()).map_err(|e| format!("ファイルを保存できません: {e}"))
    }
}
