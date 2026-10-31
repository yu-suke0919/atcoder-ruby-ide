use crate::files::{read_limited, write_atomic, MAX_TEXT_BYTES};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProblemSample {
    pub stdin: String,
    pub expected_output: String,
    pub compare: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SampleCase {
    pub stdin: String,
    pub expected_output: String,
    pub compare: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tolerance: Option<f64>,
}

impl From<&ProblemSample> for SampleCase {
    fn from(sample: &ProblemSample) -> Self {
        Self {
            stdin: sample.stdin.clone(),
            expected_output: sample.expected_output.clone(),
            compare: sample.compare,
            tolerance: None,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SampleFile {
    cases: Vec<SampleCase>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleResult {
    pub canceled: bool,
    pub file_path: Option<String>,
    pub cases: Option<Vec<SampleCase>>,
}

pub(crate) fn validate(cases: &[SampleCase]) -> Result<(), String> {
    validate_texts(
        cases
            .iter()
            .map(|item| (item.stdin.as_str(), item.expected_output.as_str())),
    )?;
    for case in cases {
        validate_tolerance(case.tolerance)?;
    }
    Ok(())
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

pub fn load_samples(selected: Option<PathBuf>) -> Result<SampleResult, String> {
    let Some(path) = selected else {
        return Ok(SampleResult {
            canceled: true,
            ..Default::default()
        });
    };
    let data = read_limited(&path, MAX_FILE_BYTES)
        .map_err(|e| format!("サンプルを読み込めません（上限 16 MiB）: {e}"))?;
    let data = data.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&data);
    let file: SampleFile =
        serde_json::from_slice(data).map_err(|e| format!("サンプル JSON が不正です: {e}"))?;
    validate(&file.cases)?;
    Ok(SampleResult {
        file_path: Some(path.to_string_lossy().into()),
        cases: Some(file.cases),
        ..Default::default()
    })
}

pub fn save_samples(
    cases: Vec<SampleCase>,
    selected: Option<PathBuf>,
) -> Result<SampleResult, String> {
    let Some(path) = selected else {
        return Ok(SampleResult {
            canceled: true,
            ..Default::default()
        });
    };
    validate(&cases)?;
    let data = serde_json::to_vec_pretty(&SampleFile { cases }).map_err(|e| e.to_string())?;
    if data.len() > MAX_FILE_BYTES {
        return Err("JSON は 16 MiB 以下にしてください。".into());
    }
    write_atomic(&path, &data).map_err(|e| format!("サンプルを保存できません: {e}"))?;
    Ok(SampleResult {
        file_path: Some(path.to_string_lossy().into()),
        ..Default::default()
    })
}
