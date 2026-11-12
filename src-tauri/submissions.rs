//! The user's submissions, read from the submission list shown in the right column, and the color
//! of each task: AC, judging or other (docs/problem-library.md#提出一覧の読み取りu5a).
use crate::contests::ContestKey;
use crate::files::{read_limited, write_atomic};
use crate::navigation::{contest_url, ATCODER_ORIGIN};
use crate::task::TaskKey;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use url::Url;

const MAX_SUBMISSIONS: usize = 10_000;
const MAX_SUBMISSIONS_BYTES: usize = 4 * 1024 * 1024;
/// Every webview reads its submission list on its own thread: records are read, merged and saved
/// one at a time so no submission is lost (docs/review.md, R6).
static RECORDS: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Submission {
    id: u64,
    task: String,
    result: String,
    judging: bool,
}
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    submissions: Vec<Submission>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskResult {
    Ac,
    Judging,
    Other,
}

/// What a read of the submission list gives the screen: the contest's colors, and whether a
/// submission is still being judged, so the list is read again.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionUpdate {
    pub contest: String,
    pub states: HashMap<String, TaskResult>,
    pub judging: bool,
}

/// The contest URL when `url` is the user's submission list, `/contests/<id>/submissions/me`.
pub fn submissions_page(url: &Url) -> Option<String> {
    let parts: Vec<_> = url.path().trim_end_matches('/').split('/').collect();
    if !crate::is_atcoder(url)
        || parts.len() != 5
        || parts[1] != "contests"
        || parts[3..] != ["submissions", "me"]
    {
        return None;
    }
    ContestKey::parse(&contest_url(parts[2]))
        .ok()
        .map(|key| key.url)
}

fn parse(contest: &ContestKey, html: &str) -> Vec<Submission> {
    let document = Html::parse_document(html);
    let selector = |css| Selector::parse(css).unwrap();
    let (rows, task, label, details, judging) = (
        selector("tbody tr"),
        selector("td a[href*='/tasks/']"),
        selector("span.label"),
        selector("a.submission-details-link"),
        selector("td.waiting-judge"),
    );
    document
        .select(&rows)
        .filter_map(|row| {
            let task = TaskKey::parse(&format!(
                "{ATCODER_ORIGIN}{}",
                row.select(&task).next()?.attr("href")?
            ))
            .ok()?;
            let id = row
                .select(&details)
                .next()?
                .attr("href")?
                .rsplit('/')
                .next()?
                .parse()
                .ok()?;
            let result = row
                .select(&label)
                .next()?
                .text()
                .collect::<String>()
                .trim()
                .to_string();
            (task.contest == contest.id && !result.is_empty()).then(|| Submission {
                id,
                task: task.url,
                result,
                judging: row.select(&judging).next().is_some(),
            })
        })
        .collect()
}

fn states(submissions: &[Submission]) -> HashMap<String, TaskResult> {
    let mut states = HashMap::new();
    for submission in submissions {
        let state = if submission.judging {
            TaskResult::Judging
        } else if submission.result == "AC" {
            TaskResult::Ac
        } else {
            TaskResult::Other
        };
        let rank = |state: &TaskResult| match state {
            TaskResult::Ac => 2,
            TaskResult::Judging => 1,
            TaskResult::Other => 0,
        };
        let entry = states.entry(submission.task.clone()).or_insert(state);
        if rank(&state) > rank(entry) {
            *entry = state;
        }
    }
    states
}

pub struct Submissions {
    root: PathBuf,
}
impl Submissions {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    fn path(&self, contest: &ContestKey) -> PathBuf {
        self.root
            .join("submissions")
            .join(format!("{}.json", contest.id))
    }
    /// The record of the contest; none yet is empty, an unreadable one is an error and kept.
    fn load(&self, path: &Path) -> Result<Record, String> {
        if !path.exists() {
            return Ok(Record::default());
        }
        let data = read_limited(path, MAX_SUBMISSIONS_BYTES)
            .map_err(|e| format!("提出結果を読み込めません: {e}"))?;
        serde_json::from_slice(&data)
            .map_err(|e| format!("提出結果が不正です（{}）: {e}", path.display()))
    }
    /// Records the submissions of a loaded list at `page_url` and returns the contest's colors.
    pub fn read_page(&self, page_url: &str, html: &str) -> Result<SubmissionUpdate, String> {
        let contest = Url::parse(page_url)
            .ok()
            .and_then(|url| submissions_page(&url))
            .ok_or("自分の提出一覧のページではありません。")?;
        let key = ContestKey::parse(&contest)?;
        let path = self.path(&key);
        let _guard = RECORDS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut record = self.load(&path)?;
        let read = parse(&key, html);
        let judging = read.iter().any(|submission| submission.judging);
        if !read.is_empty() {
            let mut by_id: BTreeMap<u64, Submission> =
                record.submissions.into_iter().map(|s| (s.id, s)).collect();
            by_id.extend(read.into_iter().map(|s| (s.id, s)));
            record.submissions = by_id.into_values().collect();
            let excess = record.submissions.len().saturating_sub(MAX_SUBMISSIONS);
            record.submissions.drain(..excess);
            std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            let data = serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?;
            write_atomic(&path, &data).map_err(|e| format!("提出結果を保存できません: {e}"))?;
        }
        Ok(SubmissionUpdate {
            contest: key.url,
            states: states(&record.submissions),
            judging,
        })
    }
    /// Follows a judging submission whose list is hidden or left (U5b): every `interval` until
    /// `until`, fetches the list at `page_url`, records it and reports the read, stopping once
    /// nothing is judging. A failed fetch is tried again at the next interval.
    pub fn follow_judging(
        &self,
        page_url: &str,
        interval: Duration,
        until: Instant,
        mut fetch: impl FnMut() -> Result<String, String>,
        mut report: impl FnMut(Result<SubmissionUpdate, String>),
    ) {
        while Instant::now() + interval <= until {
            std::thread::sleep(interval);
            let Ok(html) = fetch() else { continue };
            let read = self.read_page(page_url, &html);
            let judging = read.as_ref().is_ok_and(|update| update.judging);
            report(read);
            if !judging {
                return;
            }
        }
    }
    /// The colors of the contest's tasks from the submissions read so far.
    pub fn states(&self, contest: &str) -> Result<HashMap<String, TaskResult>, String> {
        let key = ContestKey::parse(contest)?;
        Ok(states(&self.load(&self.path(&key))?.submissions))
    }
}
