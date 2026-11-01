//! The solution files of a workspace: `files/<name>.rb`, one per editor tab.
use crate::files::{read_limited, MAX_TEXT_BYTES};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};

const FILES: &str = "files";
const NAME_LIMIT: usize = 40;

/// The part of a name before `_<n>`: the task's label with only the characters names may hold.
fn prefix(label: &str) -> String {
    let prefix: String = label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(NAME_LIMIT - 4)
        .collect();
    if prefix.is_empty() {
        "file".into()
    } else {
        prefix
    }
}

/// Orders names as people read them: numbers by value (`A_2` before `A_10`), letters
/// without regard to case.
fn natural(a: &str, b: &str) -> Ordering {
    fn chunks(name: &str) -> Vec<(bool, &str)> {
        let mut chunks = Vec::new();
        let mut start = 0;
        for (index, c) in name.char_indices().skip(1) {
            let previous = name[..index].chars().last().unwrap();
            if previous.is_ascii_digit() != c.is_ascii_digit() {
                chunks.push((previous.is_ascii_digit(), &name[start..index]));
                start = index;
            }
        }
        if !name.is_empty() {
            let last = name[start..].starts_with(|c: char| c.is_ascii_digit());
            chunks.push((last, &name[start..]));
        }
        chunks
    }
    for (x, y) in chunks(a).into_iter().zip(chunks(b)) {
        let order = match (x, y) {
            ((true, x), (true, y)) => {
                let (x, y) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
                x.len().cmp(&y.len()).then(x.cmp(y))
            }
            ((_, x), (_, y)) => x.to_ascii_lowercase().cmp(&y.to_ascii_lowercase()),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    a.len().cmp(&b.len()).then(a.cmp(b))
}

pub(crate) fn validate_name(name: &str) -> Result<(), String> {
    let reserved = ["CON", "PRN", "AUX", "NUL"]
        .iter()
        .any(|device| name.eq_ignore_ascii_case(device))
        || (name.len() == 4
            && ["COM", "LPT"]
                .iter()
                .any(|device| name[..3].eq_ignore_ascii_case(device))
            && name.as_bytes()[3].is_ascii_digit());
    if name.is_empty()
        || name.len() > NAME_LIMIT
        || reserved
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("ファイル名は英数字・_・-の1〜40文字にしてください。".into());
    }
    Ok(())
}

pub(crate) fn path(workspace: &Path, name: &str) -> Result<PathBuf, String> {
    validate_name(name)?;
    Ok(workspace.join(FILES).join(format!("{name}.rb")))
}

/// The file names in tab order.
pub(crate) fn list(workspace: &Path) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(workspace.join(FILES))
        .map_err(|e| format!("ファイルの一覧を読めません: {e}"))?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().into_string().ok();
        if let Some(name) = name.as_deref().and_then(|name| name.strip_suffix(".rb")) {
            if validate_name(name).is_ok() && entry.path().is_file() {
                names.push(name.to_string());
            }
        }
    }
    names.sort_by(|a, b| natural(a, b));
    Ok(names)
}

/// Makes `files/` on first use: `<label>_1` holds the old `solution.rb` (or nothing) and
/// `<label>_2` starts empty. The files are written to a temporary folder that becomes `files/`
/// only when complete, so a failure leaves the workspace as it was, `solution.rb` included.
pub(crate) fn ensure(workspace: &Path, label: &str) -> Result<(), String> {
    let files = workspace.join(FILES);
    if files.exists() {
        return Ok(());
    }
    let solution = workspace.join("solution.rb");
    let first = if solution.try_exists().map_err(|e| e.to_string())? {
        read_limited(&solution, MAX_TEXT_BYTES)
            .map_err(|e| format!("solution.rb を変換できません（元のまま残します）: {e}"))?
    } else {
        Vec::new()
    };
    let temporary = tempfile::Builder::new()
        .prefix(".files-")
        .tempdir_in(workspace)
        .map_err(|e| format!("作業領域を作成できません: {e}"))?;
    let prefix = prefix(label);
    for (number, data) in [(1, first.as_slice()), (2, &[][..])] {
        std::fs::write(temporary.path().join(format!("{prefix}_{number}.rb")), data)
            .map_err(|e| format!("作業領域を作成できません: {e}"))?;
    }
    std::fs::rename(temporary.path(), &files)
        .map_err(|e| format!("作業領域を作成できません: {e}"))?;
    // The folder is now files/; dropping the handle would try to remove the old path only.
    let _ = temporary.keep();
    Ok(())
}

/// Adds an empty file with the next free `<label>_<n>` name.
pub(crate) fn create(workspace: &Path, label: &str) -> Result<String, String> {
    let names = list(workspace)?;
    let prefix = prefix(label);
    let name = (1..)
        .map(|number| format!("{prefix}_{number}"))
        .find(|name| !names.iter().any(|used| used.eq_ignore_ascii_case(name)))
        .unwrap();
    crate::task::create_if_missing(&path(workspace, &name)?, b"")?;
    Ok(name)
}

pub(crate) fn rename(workspace: &Path, from: &str, to: &str) -> Result<(PathBuf, PathBuf), String> {
    let (old, new) = (path(workspace, from)?, path(workspace, to)?);
    let names = list(workspace)?;
    if !names.iter().any(|name| name == from) {
        return Err("名前を変えるファイルがありません。".into());
    }
    if names
        .iter()
        .any(|name| name != from && name.eq_ignore_ascii_case(to))
    {
        return Err(format!("「{to}」はすでにあります。"));
    }
    std::fs::rename(&old, &new).map_err(|e| format!("名前を変えられません: {e}"))?;
    Ok((old, new))
}

pub(crate) fn delete(workspace: &Path, name: &str, open: Option<&Path>) -> Result<(), String> {
    let path = path(workspace, name)?;
    let names = list(workspace)?;
    if !names.iter().any(|used| used == name) {
        return Err("削除するファイルがありません。".into());
    }
    if names.len() == 1 {
        return Err("最後のファイルは削除できません。".into());
    }
    if open == Some(path.as_path()) {
        return Err("開いているファイルは削除できません。".into());
    }
    std::fs::remove_file(&path).map_err(|e| format!("削除できません: {e}"))
}
