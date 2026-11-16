use std::io::{self, Read, Write};
use std::path::Path;

pub(crate) const MAX_TEXT_BYTES: usize = 1024 * 1024;

pub(crate) fn read_limited(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let mut data = Vec::new();
    std::fs::File::open(path)?
        .take((limit + 1) as u64)
        .read_to_end(&mut data)?;
    if data.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ファイルサイズが上限を超えています。",
        ));
    }
    Ok(data)
}

pub(crate) fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(data)?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

/// Writes `data` to `path` unless a file is already there, never replacing one.
pub(crate) fn create_if_missing(path: &Path, data: &[u8]) -> Result<(), String> {
    if path.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    temporary.write_all(data).map_err(|e| e.to_string())?;
    match temporary.persist_noclobber(path) {
        Ok(_) => Ok(()),
        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(format!("作業領域を作成できません: {e}")),
    }
}
