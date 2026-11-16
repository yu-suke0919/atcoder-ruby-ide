//! A task's samples, limits and input format, read from its AtCoder page.
use crate::navigation::TaskKey;
use crate::ProblemSample;
use scraper::{ElementRef, Html, Node, Selector};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// What the app keeps from a task page. The statement itself is read in the browser.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub url: String,
    pub samples: Vec<ProblemSample>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_limit_ms: Option<u32>,
    #[serde(rename = "memoryLimitMiB", skip_serializing_if = "Option::is_none")]
    pub memory_limit_mib: Option<u32>,
    /// The input section's `pre`, each variable as `$TeX$`. Pages read before U4 have none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_format: Option<String>,
    /// The constraints, one item each, variables as in `input_format`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub constraints: Vec<String>,
}

impl Task {
    /// The code a new file of this task starts with: reading its input, or nothing.
    pub(crate) fn input_code(&self) -> String {
        self.input_format
            .as_deref()
            .and_then(|format| crate::input_code(format, &self.constraints))
            .unwrap_or_default()
    }
    pub(crate) fn reading_forms(&self) -> Vec<[String; 2]> {
        self.input_format
            .as_deref()
            .map(|format| crate::reading_forms(format, &self.constraints))
            .unwrap_or_default()
    }
    pub(crate) fn graph_form(&self) -> Option<crate::GraphForm> {
        crate::graph_form(self.input_format.as_deref()?, &self.constraints)
    }
}

pub(crate) fn validate(task: &Task, key: &TaskKey) -> Result<(), String> {
    if task.url != key.url {
        return Err("問題データのURLが不正です。".into());
    }
    if task.time_limit_ms == Some(0) || task.memory_limit_mib == Some(0) {
        return Err("問題の制限値が不正です。".into());
    }
    if task.samples.len() > 100 {
        return Err("サンプルは100件以下にしてください。".into());
    }
    if task
        .input_format
        .as_ref()
        .is_some_and(|f| f.len() > 64 * 1024)
        || task.constraints.len() > 200
        || task.constraints.iter().any(|item| item.len() > 4096)
    {
        return Err("入力形式・制約が長すぎます。".into());
    }
    if task.samples.is_empty() {
        Ok(())
    } else {
        crate::samples::validate_problem_samples(&task.samples)
    }
}
fn selector(value: &str) -> Selector {
    Selector::parse(value).unwrap()
}

fn milliseconds(value: &str) -> Option<u32> {
    let (seconds, fraction) = value.split_once('.').unwrap_or((value, "0"));
    if fraction.len() > 3
        || [seconds, fraction]
            .iter()
            .any(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    seconds
        .parse::<u32>()
        .ok()?
        .checked_mul(1000)?
        .checked_add(fraction.parse::<u32>().ok()? * 10_u32.pow(3 - fraction.len() as u32))
}

fn parse_limits(task: ElementRef<'_>) -> Result<(Option<u32>, Option<u32>), String> {
    let (mut time, mut memory) = (None, None);
    let invalid = || "問題の制限値が不正です。".to_string();
    for paragraph in task
        .prev_siblings()
        .filter_map(ElementRef::wrap)
        .filter(|element| element.value().name() == "p")
    {
        let text = paragraph.text().collect::<String>();
        for part in text.split('/') {
            let part = part.trim();
            let (target, unit, value) = if let Some(value) = part
                .strip_prefix("実行時間制限")
                .or_else(|| part.strip_prefix("Time Limit"))
            {
                (&mut time, "sec", value)
            } else if let Some(value) = part
                .strip_prefix("メモリ制限")
                .or_else(|| part.strip_prefix("Memory Limit"))
            {
                (&mut memory, "MiB", value)
            } else {
                continue;
            };
            let value = value.trim_start().strip_prefix(':').ok_or_else(invalid)?;
            let mut words = value.split_whitespace();
            let number = words.next().ok_or_else(invalid)?;
            if target.is_some() || words.next() != Some(unit) || words.next().is_some() {
                return Err(invalid());
            }
            let value = if unit == "sec" {
                milliseconds(number).ok_or_else(invalid)?
            } else {
                number.parse::<u32>().map_err(|_| invalid())?
            };
            if value == 0 {
                return Err(invalid());
            }
            *target = Some(value);
        }
    }
    Ok((time, memory))
}

/// A heading's own text: the loaded page adds a Copy button inside sample headings.
fn own_text(element: ElementRef<'_>) -> String {
    element
        .children()
        .filter_map(|node| node.value().as_text().map(|text| text.to_string()))
        .collect::<String>()
        .trim()
        .to_string()
}

/// Text with each variable as `$TeX$`. The loaded page draws variables with KaTeX, which keeps
/// the original TeX in an annotation; a page fetched again has the TeX as the variable's text.
fn tex_text(element: ElementRef<'_>, text: &mut String) {
    for child in element.children() {
        match child.value() {
            Node::Text(value) => text.push_str(value),
            Node::Element(e) if e.name() == "br" => text.push('\n'),
            Node::Element(e) if e.name() == "var" => {
                let var = ElementRef::wrap(child).unwrap();
                let tex = var
                    .select(&selector(r#"annotation[encoding="application/x-tex"]"#))
                    .next()
                    .unwrap_or(var)
                    .text()
                    .collect::<String>();
                text.push('$');
                text.push_str(tex.trim());
                text.push('$');
            }
            Node::Element(_) => tex_text(ElementRef::wrap(child).unwrap(), text),
            _ => {}
        }
    }
}

/// The first element named `name` after the heading `titles`, before the next heading.
fn after_heading<'a>(body: ElementRef<'a>, titles: &[&str], name: &str) -> Option<ElementRef<'a>> {
    let heading = body
        .select(&selector("h3"))
        .find(|h| titles.contains(&own_text(*h).as_str()))?;
    heading
        .next_siblings()
        .filter_map(ElementRef::wrap)
        .take_while(|e| e.value().name() != "h3")
        .find(|e| e.value().name() == name)
}

/// The input section's first `pre`. With test cases (D2), the format of one test case follows
/// in the `pre` after the paragraph that says so, and is added after it.
fn input_format(body: ElementRef<'_>) -> Option<String> {
    let pre = after_heading(body, &["入力", "Input"], "pre")?;
    let format = |pre: ElementRef<'_>| {
        let mut text = String::new();
        tex_text(pre, &mut text);
        let lines: Vec<_> = text.lines().map(str::trim).collect();
        lines.join("\n").trim().to_string()
    };
    let mut parts = vec![format(pre)];
    let mut said = false;
    for element in pre.next_siblings().filter_map(ElementRef::wrap) {
        match element.value().name() {
            "h3" => break,
            "p" => {
                let text = element.text().collect::<String>();
                said = text.contains("テストケース") || text.to_lowercase().contains("test case");
            }
            "pre" if said => {
                parts.push(format(element));
                break;
            }
            _ => {}
        }
    }
    let format = parts.join("\n").trim().to_string();
    (!format.is_empty()).then_some(format)
}

fn constraints(body: ElementRef<'_>) -> Vec<String> {
    let Some(list) = after_heading(body, &["制約", "Constraints"], "ul") else {
        return Vec::new();
    };
    list.select(&selector("li"))
        .map(|item| {
            let mut text = String::new();
            tex_text(item, &mut text);
            text.split_whitespace().collect::<Vec<_>>().join(" ")
        })
        .collect()
}

/// Reads samples and limits from a task page. A page without a task statement (not logged in,
/// not registered, or missing) is an error so the caller can ask the user to log in or register.
pub fn parse_task(url: &str, html: &str) -> Result<Task, String> {
    let key = TaskKey::parse(url)?;
    if html.len() > crate::http::MAX_HTML_BYTES {
        return Err("問題ページは4 MiB以下にしてください。".into());
    }
    let doc = Html::parse_document(html);
    let task = doc.select(&selector("#task-statement")).next().ok_or(
        "問題文が見つかりません。ブラウザでログインし、開催中のコンテストは参加登録してください。",
    )?;
    let body = task
        .select(&selector(".lang-ja"))
        .next()
        .or_else(|| task.select(&selector(".lang-en")).next())
        .unwrap_or(task);
    let mut inputs = BTreeMap::new();
    let mut outputs = BTreeMap::new();
    let mut pending = None;
    // Older tasks put h3 outside section. Pair each heading with its next pre
    // in document order, without crossing another heading.
    for element in body.select(&selector("h3, pre")) {
        if element.value().name() == "h3" {
            if pending.is_some() {
                return Err("サンプル本文がありません。".into());
            }
            let heading = own_text(element);
            let heading = heading.as_str();
            let (number, is_input) = if let Some(n) = heading
                .strip_prefix("入力例")
                .or_else(|| heading.strip_prefix("Sample Input"))
            {
                (n, true)
            } else if let Some(n) = heading
                .strip_prefix("出力例")
                .or_else(|| heading.strip_prefix("Sample Output"))
            {
                (n, false)
            } else {
                continue;
            };
            let number: usize = number
                .trim()
                .parse()
                .map_err(|_| "サンプル番号が不正です。")?;
            pending = Some((number, is_input));
            continue;
        }
        let Some((number, is_input)) = pending.take() else {
            continue;
        };
        let target = if is_input { &mut inputs } else { &mut outputs };
        let mut value = String::new();
        // HTML entities are decoded by the parser; pre whitespace is retained.
        for node in element.descendants() {
            match node.value() {
                Node::Text(text) => value.push_str(text),
                Node::Element(e) if e.name() == "br" => value.push('\n'),
                _ => {}
            }
        }
        if number == 0 || target.insert(number, value).is_some() {
            return Err("サンプル番号が不正または重複しています。".into());
        }
    }
    if pending.is_some() {
        return Err("サンプル本文がありません。".into());
    }
    if inputs.keys().ne(outputs.keys()) {
        return Err("対応するサンプル入出力が見つかりません。".into());
    }
    let samples = inputs
        .into_iter()
        .map(|(number, stdin)| ProblemSample {
            stdin,
            expected_output: outputs.remove(&number).unwrap(),
        })
        .collect();
    let (time_limit_ms, memory_limit_mib) = parse_limits(task)?;
    let task = Task {
        url: key.url.clone(),
        samples,
        time_limit_ms,
        memory_limit_mib,
        input_format: input_format(body),
        constraints: constraints(body),
    };
    validate(&task, &key)?;
    Ok(task)
}
