//! Registered contests and problem sets with their official task lists.
use crate::files::{read_limited, write_atomic};
use crate::task::{TaskKey, MAX_HTML_BYTES};
use reqwest::blocking::Client;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use url::Url;

const MAX_CONTEST_BYTES: usize = 2 * 1024 * 1024;

/// A contest URL, or a task URL whose contest is registered and whose task is opened.
pub struct ContestKey {
    pub url: String,
    pub id: String,
    pub task: Option<String>,
}
impl ContestKey {
    pub fn parse(value: &str) -> Result<Self, String> {
        let parsed = Url::parse(value.trim())
            .map_err(|_| "コンテストまたは問題のURLを入力してください。")?;
        let parts: Vec<_> = parsed.path().trim_end_matches('/').split('/').collect();
        let invalid =
            || "https://atcoder.jp/contests/<id> または問題のURLを入力してください。".to_string();
        if parts.len() < 3 || parts[1] != "contests" {
            return Err(invalid());
        }
        // Reuse the origin, credential and identifier rules of task URLs.
        let mut probe = parsed.clone();
        let task = match parts.len() {
            3 => None,
            4 if parts[3] == "tasks" => None,
            5 if parts[3] == "tasks" => Some(parts[4]),
            _ => return Err(invalid()),
        };
        probe.set_path(&format!(
            "/contests/{}/tasks/{}",
            parts[2],
            task.unwrap_or("probe")
        ));
        let key = TaskKey::parse(probe.as_str())?;
        Ok(Self {
            url: format!("https://atcoder.jp/contests/{}", key.contest),
            id: key.contest,
            task: task.map(|_| key.url),
        })
    }
    fn path(&self, root: &Path) -> PathBuf {
        root.join("contests").join(format!("{}.json", self.id))
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContestTask {
    pub label: String,
    pub title: String,
    pub url: String,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contest {
    pub url: String,
    pub title: String,
    pub hidden: bool,
    /// Empty for a contest joined before its start, whose task list cannot be seen yet.
    pub tasks: Vec<ContestTask>,
    /// Added or updated from a registration seen in the browser, until hidden a day after its end
    /// (docs/problem-library.md#参加登録の読み取りu6a).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub joined: bool,
    /// The times as the contest's top page writes them, `2026-11-07T21:00:00+09:00`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_time: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredContest {
    pub contest: Contest,
    pub task: Option<String>,
}

fn text(element: scraper::ElementRef<'_>) -> String {
    element
        .text()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
const DAY_SECONDS: i64 = 24 * 60 * 60;

/// Unix time of `2026-11-07T21:00:00+09:00`, the only form the contest pages use.
fn unix_time(value: &str) -> Option<i64> {
    let b = value.as_bytes();
    let shape = "dddd-dd-ddTdd:dd:dd+dd:dd".as_bytes();
    if b.len() != shape.len()
        || !b.iter().zip(shape).all(|(c, s)| match s {
            b'd' => c.is_ascii_digit(),
            b'+' => *c == b'+' || *c == b'-',
            _ => c == s,
        })
    {
        return None;
    }
    let number = |range: std::ops::Range<usize>| value[range].parse::<i64>().unwrap();
    let (year, month, day) = (number(0..4), number(5..7), number(8..10));
    let (hour, minute, second) = (number(11..13), number(14..16), number(17..19));
    let offset = (number(20..22) * 60 + number(23..25)) * if b[19] == b'-' { -1 } else { 1 };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&month)
        || !(1..=days_in_month[month as usize - 1]).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    // Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's days_from_civil).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(days * DAY_SECONDS + hour * 3600 + minute * 60 + second - offset * 60)
}

/// The current Unix time, which `Contests::join` and `Contests::hide_ended` compare with.
pub fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64)
}

/// The contest URL when `url` is a contest's top page, `/contests/<id>`.
pub fn contest_top(url: &Url) -> Option<String> {
    let parts: Vec<_> = url.path().trim_end_matches('/').split('/').collect();
    if !crate::is_atcoder(url) || parts.len() != 3 || parts[1] != "contests" {
        return None;
    }
    ContestKey::parse(&format!("https://atcoder.jp/contests/{}", parts[2]))
        .ok()
        .map(|key| key.url)
}

/// What a contest's top page says: its name, whether the user is registered and its times.
struct ContestTop {
    title: String,
    contestant: bool,
    start_time: String,
    end_time: String,
}
fn parse_contest_top(html: &str) -> Option<ContestTop> {
    let document = Html::parse_document(html);
    let select = |value: &str| Selector::parse(value).unwrap();
    let title = text(document.select(&select("a.contest-title")).next()?);
    // The user menu reads "<name> (Contestant)" once registered and "<name> (Guest)" before.
    let contestant = document
        .select(&select(".navbar .dropdown-toggle"))
        .any(|menu| text(menu).ends_with("(Contestant)"));
    let time = |name: &str| {
        let start = format!("var {name} = moment(\"");
        let rest = &html[html.find(&start)? + start.len()..];
        Some(rest[..rest.find('"')?].to_string())
    };
    Some(ContestTop {
        title,
        contestant,
        start_time: time("startTime")?,
        end_time: time("endTime")?,
    })
}

fn validate(contest: &Contest, key: &ContestKey) -> Result<(), String> {
    if contest.url != key.url
        || contest.title.trim().is_empty()
        || contest.title.len() > 1024
        || contest.tasks.len() > 1000
    {
        return Err("コンテストの名前・URL・問題数が不正です（最大1,000問）。".into());
    }
    match (&contest.start_time, &contest.end_time) {
        (None, None) => {}
        (Some(start), Some(end))
            if unix_time(start)
                .zip(unix_time(end))
                .is_some_and(|(s, e)| s <= e) => {}
        _ => return Err("コンテストの開始・終了の時刻が不正です。".into()),
    }
    let mut urls = BTreeSet::new();
    let mut labels = BTreeSet::new();
    for task in &contest.tasks {
        let task_key = TaskKey::parse(&task.url)?;
        if task_key.contest != key.id
            || task_key.url != task.url
            || task.label.trim().is_empty()
            || task.label.len() > 64
            || task.title.trim().is_empty()
            || task.title.len() > 1024
            || !urls.insert(&task.url)
            || !labels.insert(&task.label)
        {
            return Err("問題一覧に不正な問題・別コンテストのURL・重複があります。".into());
        }
    }
    Ok(())
}

/// Reads the name and the official task order from `/contests/<id>/tasks`.
pub fn parse_task_list(url: &str, html: &str) -> Result<Contest, String> {
    let key = ContestKey::parse(url)?;
    if html.len() > MAX_HTML_BYTES {
        return Err("問題一覧は4 MiB以下にしてください。".into());
    }
    let document = Html::parse_document(html);
    let select = |value: &str| Selector::parse(value).unwrap();
    let title = document
        .select(&select("a.contest-title"))
        .next()
        .map(text)
        .ok_or("コンテスト名が見つかりません。")?;
    let base = Url::parse(&format!("{}/tasks", key.url)).unwrap();
    let mut tasks = Vec::new();
    for row in document.select(&select("table tbody tr")) {
        let cells: Vec<_> = row.select(&select("td")).collect();
        if cells.len() < 2 {
            return Err("問題一覧の形式が不正です。".into());
        }
        let link = select("a[href]");
        let (Some(a), Some(b)) = (cells[0].select(&link).next(), cells[1].select(&link).next())
        else {
            return Err("問題一覧の形式が不正です。".into());
        };
        let resolve = |anchor: scraper::ElementRef<'_>| -> Result<String, String> {
            let joined = base
                .join(anchor.value().attr("href").unwrap())
                .map_err(|e| e.to_string())?;
            Ok(TaskKey::parse(joined.as_str())?.url)
        };
        let url = resolve(a)?;
        if resolve(b)? != url {
            return Err("問題番号と問題名のURLが一致しません。".into());
        }
        tasks.push(ContestTask {
            label: text(a),
            title: text(b),
            url,
        });
    }
    if tasks.is_empty() {
        return Err("問題一覧が見つかりません。ブラウザでログインし、開催中のコンテストは参加登録してください。".into());
    }
    let contest = Contest {
        url: key.url.clone(),
        title,
        hidden: false,
        tasks,
        joined: false,
        start_time: None,
        end_time: None,
    };
    validate(&contest, &key)?;
    Ok(contest)
}

pub fn http_client() -> Result<Client, String> {
    Client::builder()
        .use_native_tls()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("AtCoder-Ruby-IDE/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// Fetches a page with the browser's cookies. Login redirects and missing permissions are
/// reported as a request to log in or register in the browser.
pub fn fetch_page(client: &Client, url: &str, cookie: &str) -> Result<String, String> {
    let mut request = client.get(url);
    if !cookie.is_empty() {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    let response = request
        .send()
        .map_err(|e| format!("AtCoderに接続できません: {e}"))?;
    let status = response.status();
    if status.is_redirection()
        || status == reqwest::StatusCode::NOT_FOUND
        || status == reqwest::StatusCode::FORBIDDEN
    {
        return Err(format!(
            "問題一覧を取得できません（HTTP {}）。ブラウザでログインし、開催中のコンテストは参加登録してください。",
            status.as_u16()
        ));
    }
    if !status.is_success() {
        return Err(format!(
            "問題一覧を取得できません（HTTP {}）。時間をおいて再試行してください。",
            status.as_u16()
        ));
    }
    let mut bytes = Vec::new();
    response
        .take((MAX_HTML_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("問題一覧の読み込みに失敗しました: {e}"))?;
    if bytes.len() > MAX_HTML_BYTES {
        return Err("問題一覧は4 MiB以下にしてください。".into());
    }
    String::from_utf8(bytes).map_err(|_| "問題一覧がUTF-8ではありません。".into())
}

pub struct Contests {
    root: PathBuf,
}
impl Contests {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    fn load(&self, key: &ContestKey) -> Result<Contest, String> {
        let data = read_limited(&key.path(&self.root), MAX_CONTEST_BYTES)
            .map_err(|e| format!("登録したコンテストを読み込めません: {e}"))?;
        let contest: Contest = serde_json::from_slice(&data)
            .map_err(|e| format!("登録したコンテストが不正です: {e}"))?;
        validate(&contest, key)?;
        Ok(contest)
    }
    fn save(&self, contest: &Contest) -> Result<(), String> {
        let key = ContestKey::parse(&contest.url)?;
        validate(contest, &key)?;
        let path = key.path(&self.root);
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let data = serde_json::to_vec_pretty(contest).map_err(|e| e.to_string())?;
        write_atomic(&path, &data).map_err(|e| format!("コンテストを保存できません: {e}"))
    }
    /// Registered contests sorted by id. Unreadable files are skipped and left untouched.
    pub fn list(&self) -> Result<Vec<Contest>, String> {
        let directory = self.root.join("contests");
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(error) => return Err(format!("登録したコンテストを読み込めません: {error}")),
        };
        let mut contests = Vec::new();
        for entry in entries {
            let name = entry.map_err(|e| e.to_string())?.file_name();
            let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
                continue;
            };
            let Ok(key) = ContestKey::parse(&format!("https://atcoder.jp/contests/{id}")) else {
                continue;
            };
            if let Ok(contest) = self.load(&key) {
                contests.push(contest);
            }
        }
        contests.sort_by(|a, b| a.url.cmp(&b.url));
        Ok(contests)
    }
    /// Registers a contest from its task list, keeping the hidden state, the registration and the
    /// times of an earlier registration.
    pub fn register(
        &self,
        url: &str,
        fetch: impl FnOnce(&str) -> Result<String, String>,
    ) -> Result<RegisteredContest, String> {
        let key = ContestKey::parse(url)?;
        let html = fetch(&format!("{}/tasks?lang=ja", key.url))?;
        let mut contest = parse_task_list(&key.url, &html)?;
        if let Ok(old) = self.load(&key) {
            contest.hidden = old.hidden;
            contest.joined = old.joined;
            contest.start_time = old.start_time;
            contest.end_time = old.end_time;
        }
        if let Some(task) = &key.task {
            if !contest.tasks.iter().any(|item| &item.url == task) {
                return Err("問題がコンテストの問題一覧にありません。".into());
            }
        }
        self.save(&contest)?;
        Ok(RegisteredContest {
            contest,
            task: key.task,
        })
    }
    /// Adds or updates the contest of a loaded top page at `page_url` when the user is registered
    /// and it ended less than a day before `now` (Unix time). Returns the contest when it changed.
    pub fn join(&self, page_url: &str, html: &str, now: i64) -> Result<Option<Contest>, String> {
        let key = Url::parse(page_url)
            .ok()
            .and_then(|url| contest_top(&url))
            .ok_or_else(|| "コンテストのトップではありません。".to_string())
            .and_then(|url| ContestKey::parse(&url))?;
        let Some(top) = parse_contest_top(html).filter(|top| top.contestant) else {
            return Ok(None);
        };
        if !unix_time(&top.end_time).is_some_and(|end| now < end + DAY_SECONDS) {
            return Ok(None);
        }
        let old = if key.path(&self.root).exists() {
            Some(self.load(&key)?)
        } else {
            None
        };
        let contest = Contest {
            title: top.title,
            joined: true,
            start_time: Some(top.start_time),
            end_time: Some(top.end_time),
            ..old.clone().unwrap_or(Contest {
                url: key.url.clone(),
                title: String::new(),
                hidden: false,
                tasks: vec![],
                joined: false,
                start_time: None,
                end_time: None,
            })
        };
        if old.as_ref() == Some(&contest) {
            return Ok(None);
        }
        self.save(&contest)?;
        Ok(Some(contest))
    }
    /// Hides the joined contests that ended a day before `now` (Unix time) and returns them. They
    /// are no longer joined, so a contest the user shows again stays shown.
    pub fn hide_ended(&self, now: i64) -> Result<Vec<Contest>, String> {
        let mut hidden = Vec::new();
        for mut contest in self.list()? {
            let ended = contest
                .end_time
                .as_deref()
                .and_then(unix_time)
                .is_some_and(|end| now >= end + DAY_SECONDS);
            if contest.joined && ended {
                contest.hidden = true;
                contest.joined = false;
                self.save(&contest)?;
                hidden.push(contest);
            }
        }
        Ok(hidden)
    }
    pub fn set_hidden(&self, url: &str, hidden: bool) -> Result<Contest, String> {
        let key = ContestKey::parse(url)?;
        let mut contest = self.load(&key)?;
        contest.hidden = hidden;
        self.save(&contest)?;
        Ok(contest)
    }
}
