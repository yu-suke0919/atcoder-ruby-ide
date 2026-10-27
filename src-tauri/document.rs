use crate::files::{read_limited, write_atomic, MAX_TEXT_BYTES};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Default)]
pub struct DocumentStore {
    file_path: Option<PathBuf>,
    revision: u64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentResult {
    pub canceled: bool,
    pub file_path: Option<String>,
    pub code: Option<String>,
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

    pub fn open(&mut self, selected: Option<PathBuf>) -> Result<DocumentResult, String> {
        let Some(path) = selected else {
            return Ok(DocumentResult {
                canceled: true,
                ..Default::default()
            });
        };
        let data = read_limited(&path, MAX_TEXT_BYTES)
            .map_err(|e| format!("ファイルを読み込めません（上限 1 MiB）: {e}"))?;
        let code = String::from_utf8(data)
            .map_err(|e| format!("ファイルは UTF-8 で保存してください: {e}"))?;
        let code = code.strip_prefix('\u{feff}').unwrap_or(&code).to_owned();
        self.file_path = Some(path.clone());
        self.revision = self.revision.wrapping_add(1);
        Ok(DocumentResult {
            canceled: false,
            file_path: Some(path.to_string_lossy().into()),
            code: Some(code),
        })
    }

    pub fn save(
        &mut self,
        code: &str,
        selected: Option<PathBuf>,
    ) -> Result<DocumentResult, String> {
        let Some(path) = selected else {
            return Ok(DocumentResult {
                canceled: true,
                ..Default::default()
            });
        };
        if code.len() > MAX_TEXT_BYTES {
            return Err("コードは 1 MiB 以下にしてください。".into());
        }
        write_atomic(&path, code.as_bytes())
            .map_err(|e| format!("ファイルを保存できません: {e}"))?;
        self.file_path = Some(path.clone());
        self.revision = self.revision.wrapping_add(1);
        Ok(DocumentResult {
            canceled: false,
            file_path: Some(path.to_string_lossy().into()),
            code: None,
        })
    }
}
