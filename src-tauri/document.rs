use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Default)]
pub struct DocumentStore {
    file_path: Option<PathBuf>,
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
    pub fn reset(&mut self) {
        self.file_path = None;
    }

    pub fn open(&mut self, selected: Option<PathBuf>) -> Result<DocumentResult, String> {
        let Some(path) = selected else {
            return Ok(DocumentResult {
                canceled: true,
                ..Default::default()
            });
        };
        let code =
            std::fs::read_to_string(&path).map_err(|e| format!("ファイルを読み込めません: {e}"))?;
        let code = code.strip_prefix('\u{feff}').unwrap_or(&code).to_owned();
        self.file_path = Some(path.clone());
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
        std::fs::write(&path, code).map_err(|e| format!("ファイルを保存できません: {e}"))?;
        self.file_path = Some(path.clone());
        Ok(DocumentResult {
            canceled: false,
            file_path: Some(path.to_string_lossy().into()),
            code: None,
        })
    }
}
