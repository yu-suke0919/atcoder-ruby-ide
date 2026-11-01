use crate::files::{read_limited, write_atomic, MAX_TEXT_BYTES};
use serde::{Deserialize, Serialize};
use std::path::Path;

const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProblemSample {
    pub stdin: String,
    pub expected_output: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SampleCase {
    pub stdin: String,
    pub expected_output: String,
    pub compare: bool,
}

/// A workspace's samples: `samples.json`. The tolerance applies to every compared sample;
/// without one, outputs are compared strictly.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Samples {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tolerance: Option<f64>,
    pub cases: Vec<SampleCase>,
}

impl From<&ProblemSample> for SampleCase {
    fn from(sample: &ProblemSample) -> Self {
        Self {
            stdin: sample.stdin.clone(),
            expected_output: sample.expected_output.clone(),
            compare: true,
        }
    }
}

fn validate(samples: &Samples) -> Result<(), String> {
    validate_texts(
        samples
            .cases
            .iter()
            .map(|item| (item.stdin.as_str(), item.expected_output.as_str())),
    )?;
    validate_tolerance(samples.tolerance)
}

pub(crate) fn validate_problem_samples(samples: &[ProblemSample]) -> Result<(), String> {
    validate_texts(
        samples
            .iter()
            .map(|item| (item.stdin.as_str(), item.expected_output.as_str())),
    )
}

pub(crate) fn validate_tolerance(tolerance: Option<f64>) -> Result<(), String> {
    if tolerance.is_some_and(|value| !value.is_finite() || value <= 0.0) {
        return Err("許容誤差は0より大きい有限の数にしてください。".into());
    }
    Ok(())
}

fn validate_texts<'a>(
    mut texts: impl ExactSizeIterator<Item = (&'a str, &'a str)>,
) -> Result<(), String> {
    if !(1..=100).contains(&texts.len()) {
        return Err("ケースは 1〜100 件にしてください。".into());
    }
    if texts
        .any(|(stdin, expected)| stdin.len() > MAX_TEXT_BYTES || expected.len() > MAX_TEXT_BYTES)
    {
        return Err("各ケースの入力・期待出力は 1 MiB 以下にしてください。".into());
    }
    Ok(())
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let data = read_limited(path, MAX_FILE_BYTES)
        .map_err(|e| format!("サンプルを読み込めません（上限 16 MiB）: {e}"))?;
    let data = data.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&data);
    serde_json::from_slice(data).map_err(|e| format!("サンプル JSON が不正です: {e}"))
}

pub fn load_samples(path: &Path) -> Result<Samples, String> {
    let samples: Samples = read_json(path)?;
    validate(&samples)?;
    Ok(samples)
}

/// Reads the `cases.json` of U3a and before, where each sample had its own tolerance. The
/// first tolerance found becomes the problem's. Used once, to write `samples.json`.
pub(crate) fn convert_cases(path: &Path) -> Result<Samples, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct OldCase {
        stdin: String,
        expected_output: String,
        compare: bool,
        tolerance: Option<f64>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct OldFile {
        cases: Vec<OldCase>,
    }
    let old: OldFile = read_json(path)?;
    let samples = Samples {
        tolerance: old.cases.iter().find_map(|case| case.tolerance),
        cases: old
            .cases
            .into_iter()
            .map(|case| SampleCase {
                stdin: case.stdin,
                expected_output: case.expected_output,
                compare: case.compare,
            })
            .collect(),
    };
    validate(&samples)?;
    Ok(samples)
}

pub fn save_samples(samples: Samples, path: &Path) -> Result<(), String> {
    validate(&samples)?;
    let data = serde_json::to_vec_pretty(&samples).map_err(|e| e.to_string())?;
    if data.len() > MAX_FILE_BYTES {
        return Err("JSON は 16 MiB 以下にしてください。".into());
    }
    write_atomic(path, &data).map_err(|e| format!("サンプルを保存できません: {e}"))
}
