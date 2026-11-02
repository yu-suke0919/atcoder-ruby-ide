//! Reading code for a task's input format. The format is the input section's `pre` with each
//! variable as `$TeX$`; the constraints tell which variables are strings. Formats this does not
//! understand give no code, so a new file never starts with code that reads the input wrongly.
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq)]
enum Item {
    /// A variable: its name without TeX wrappers and its subscript parts.
    Var { name: String, index: Vec<String> },
    /// `\ldots` and other horizontal ellipses.
    Ellipsis,
    /// `\vdots` or `:`, the rows in between.
    Rows,
}

#[derive(Debug)]
struct Line {
    items: Vec<Item>,
    /// Two variables in one `$...$` without a space between them: characters of one string.
    joined: bool,
}

const ELLIPSES: [&str; 5] = ["\\ldots", "\\cdots", "\\dots", "...", "…"];
const ROWS: [&str; 4] = ["\\vdots", ":", "⋮", "︙"];
const WRAPPERS: [&str; 6] = [
    "\\operatorname",
    "\\mathrm",
    "\\mathtt",
    "\\textrm",
    "\\text",
    "\\mathit",
];

/// The subscript after `_`: `{1,N}` or a single character, as parts split by commas.
fn subscript(tex: &str) -> Option<(Vec<String>, &str)> {
    let tex = tex.trim_start();
    let (body, rest) = if let Some(inner) = tex.strip_prefix('{') {
        let end = inner.find('}')?;
        (&inner[..end], &inner[end + 1..])
    } else {
        let c = tex.chars().next()?;
        (&tex[..c.len_utf8()], &tex[c.len_utf8()..])
    };
    Some((
        body.split(',')
            .map(|part| part.trim().to_string())
            .collect(),
        rest,
    ))
}

/// The items of one `$...$`, or None when it holds something else.
fn items(tex: &str) -> Option<Vec<Item>> {
    let mut items = Vec::new();
    let mut rest = tex.trim();
    while !rest.is_empty() {
        if let Some(found) = ELLIPSES.iter().find(|e| rest.starts_with(**e)) {
            items.push(Item::Ellipsis);
            rest = rest[found.len()..].trim_start();
            continue;
        }
        if let Some(found) = ROWS.iter().find(|e| rest.starts_with(**e)) {
            items.push(Item::Rows);
            rest = rest[found.len()..].trim_start();
            continue;
        }
        let (name, after) = if let Some(wrapper) = WRAPPERS.iter().find(|w| rest.starts_with(**w)) {
            let inner = rest[wrapper.len()..].trim_start().strip_prefix('{')?;
            let end = inner.find('}')?;
            (inner[..end].trim().to_string(), &inner[end + 1..])
        } else {
            let c = rest.chars().next()?;
            if !c.is_ascii_alphabetic() {
                return None;
            }
            (c.to_string(), &rest[1..])
        };
        let after = after.trim_start();
        let (index, after) = match after.strip_prefix('_') {
            Some(after) => subscript(after)?,
            None => (Vec::new(), after),
        };
        items.push(Item::Var { name, index });
        rest = after.trim_start();
    }
    Some(items)
}

fn line(text: &str) -> Option<Line> {
    let mut items_of_line = Vec::new();
    let mut joined = false;
    let mut rest = text;
    while let Some(start) = rest.find('$') {
        for word in rest[..start].split_whitespace() {
            items_of_line.extend(items(word)?);
        }
        let end = rest[start + 1..].find('$')? + start + 1;
        let group = items(&rest[start + 1..end])?;
        joined |= group
            .iter()
            .filter(|item| matches!(item, Item::Var { .. }))
            .count()
            > 1;
        items_of_line.extend(group);
        rest = &rest[end + 1..];
    }
    for word in rest.split_whitespace() {
        items_of_line.extend(items(word)?);
    }
    Some(Line {
        items: items_of_line,
        joined,
    })
}

/// Variables the constraints describe as strings, and whether they say every value is an integer.
fn types(constraints: &[String]) -> (HashSet<String>, bool) {
    let mut strings = HashSet::new();
    let mut all_integers = false;
    for item in constraints {
        if item.contains("整数") {
            all_integers |= item.contains("すべて") || item.contains("全て");
            continue;
        }
        if ![
            "文字列",
            "英小文字",
            "英大文字",
            "文字",
            "または",
            "からなる",
        ]
        .iter()
        .any(|word| item.contains(word))
        {
            continue;
        }
        let Some((subject, _)) = item.split_once('は') else {
            continue;
        };
        for group in subject.split('$').skip(1).step_by(2) {
            for part in group.split(',') {
                if let Some(Item::Var { name, .. }) = items(part).and_then(|i| i.into_iter().next())
                {
                    strings.insert(name);
                }
            }
        }
    }
    (strings, all_integers)
}

/// A Ruby local name for a variable, or None when it cannot be one.
fn local(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let valid = lower.starts_with(|c: char| c.is_ascii_lowercase())
        && lower
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    valid.then_some(lower)
}

/// A count in Ruby: a variable, a number or `variable ± number`.
fn count(index: &str) -> Option<String> {
    let index: String = index.chars().filter(|c| !c.is_whitespace()).collect();
    if index.bytes().all(|b| b.is_ascii_digit()) && !index.is_empty() {
        return Some(index);
    }
    for sign in ['-', '+'] {
        if let Some((name, number)) = index.split_once(sign) {
            if !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()) {
                return Some(format!("{} {sign} {number}", local(name)?));
            }
        }
    }
    local(&index)
}

struct Types {
    strings: HashSet<String>,
    all_integers: bool,
}

impl Types {
    fn string(&self, name: &str) -> bool {
        self.strings.contains(name)
    }
    fn query(name: &str) -> bool {
        name.eq_ignore_ascii_case("query")
    }
    /// Reads the values of one line, one variable each, into the names given.
    fn line(&self, names: &[String]) -> Option<String> {
        let locals = names.iter().map(|n| local(n)).collect::<Option<Vec<_>>>()?;
        Some(match names {
            [name] if Self::query(name) => self.split(!self.all_integers),
            [name] if self.string(name) => "gets.chomp".into(),
            [_] => "gets.to_i".into(),
            _ if names.iter().all(|n| !self.string(n)) => "gets.split.map(&:to_i)".into(),
            _ if names.iter().all(|n| self.string(n)) => "gets.split".into(),
            _ => {
                let converted = names
                    .iter()
                    .zip(&locals)
                    .map(|(name, local)| {
                        if self.string(name) {
                            local.clone()
                        } else {
                            format!("{local}.to_i")
                        }
                    })
                    .collect::<Vec<_>>();
                format!(
                    "{} = gets.split; [{}]",
                    locals.join(", "),
                    converted.join(", ")
                )
            }
        })
    }
    fn split(&self, strings: bool) -> String {
        if strings {
            "gets.split".into()
        } else {
            "gets.split.map(&:to_i)".into()
        }
    }
}

/// The variables of a line that reads one value per variable with the same one-part index,
/// such as `t_1 x_1 y_1`.
fn tuple(line: &Line) -> Option<(Vec<String>, String)> {
    let mut names = Vec::new();
    let mut index = None;
    for item in &line.items {
        let Item::Var { name, index: parts } = item else {
            return None;
        };
        let [part] = parts.as_slice() else {
            return None;
        };
        if *index.get_or_insert(part) != part {
            return None;
        }
        names.push(name.clone());
    }
    Some((names, index?.clone()))
}

/// One row of a table `A_{r,1} ... A_{r,W}` (or written out without an ellipsis): the
/// variable, the row and whether its values are characters without spaces.
fn row(line: &Line) -> Option<(String, String, bool)> {
    let mut name = None;
    let mut row = None;
    let mut columns = 0;
    for item in &line.items {
        match item {
            Item::Ellipsis => {}
            Item::Var { name: n, index } => {
                let [r, _] = index.as_slice() else {
                    return None;
                };
                if *name.get_or_insert(n) != n || *row.get_or_insert(r) != r {
                    return None;
                }
                columns += 1;
            }
            Item::Rows => return None,
        }
    }
    (columns >= 2).then(|| (name.unwrap().clone(), row.unwrap().clone(), line.joined))
}

/// A list on one line, `A_1 A_2 ... A_N`.
fn list(line: &Line) -> Option<String> {
    let mut name = None;
    let mut ellipsis = false;
    for item in &line.items {
        match item {
            Item::Ellipsis => ellipsis = true,
            Item::Var { name: n, index } if index.len() == 1 => {
                if *name.get_or_insert(n) != n {
                    return None;
                }
            }
            _ => return None,
        }
    }
    ellipsis.then(|| name.unwrap().clone())
}

/// How many rows a block has: written out (1, 2, 3, ...) or ended after `\vdots` by the last
/// row's index. Returns the count and the number of lines the block used.
fn block<T: PartialEq>(
    lines: &[Line],
    first: &T,
    part: impl Fn(&Line) -> Option<(T, String)>,
) -> Option<(String, usize)> {
    let mut used = 1;
    let mut written = 1;
    while let Some((same, index)) = lines.get(used).and_then(&part) {
        if same != *first || index != (written + 1).to_string() {
            break;
        }
        written += 1;
        used += 1;
    }
    let rows = lines
        .get(used)
        .is_some_and(|line| line.items == [Item::Rows]);
    if !rows {
        return Some((written.to_string(), used));
    }
    let (same, last) = part(lines.get(used + 1)?)?;
    (same == *first).then_some(())?;
    Some((count(&last)?, used + 2))
}

/// Reads one line into one local per variable, converting only the integers.
fn read_values(types: &Types, names: &[String]) -> Option<Vec<String>> {
    let locals = names.iter().map(|n| local(n)).collect::<Option<Vec<_>>>()?;
    let mixed = names.iter().any(|n| types.string(n)) && names.iter().any(|n| !types.string(n));
    if !mixed {
        return Some(vec![format!(
            "{} = {}",
            locals.join(", "),
            types.line(names)?
        )]);
    }
    let mut code = vec![format!("{} = gets.split", locals.join(", "))];
    for (name, local) in names.iter().zip(&locals) {
        if !types.string(name) {
            code.push(format!("{local} = {local}.to_i"));
        }
    }
    Some(code)
}

/// Rows read one by one in a loop: `n.times do ... end`.
fn rows_loop(rows: &str, body: Vec<String>) -> String {
    let count = if rows.contains(' ') {
        format!("({rows})")
    } else {
        rows.to_string()
    };
    let body: Vec<_> = body.iter().map(|line| format!("  {line}")).collect();
    format!("{count}.times do\n{}\nend", body.join("\n"))
}

/// A part of the reading code. Rows also have an array form to switch to.
struct Block {
    code: String,
    array: Option<String>,
}

fn blocks(format: &str, constraints: &[String]) -> Option<Vec<Block>> {
    let lines = format
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(line)
        .collect::<Option<Vec<_>>>()?;
    let (strings, all_integers) = types(constraints);
    let types = Types {
        strings,
        all_integers,
    };
    let mut blocks = Vec::new();
    let mut at = 0;
    while at < lines.len() {
        let current = &lines[at];
        let scalars = current
            .items
            .iter()
            .map(|item| match item {
                Item::Var { name, index } if index.is_empty() => Some(name.clone()),
                _ => None,
            })
            .collect::<Option<Vec<_>>>();
        if let Some(names) = scalars.filter(|names| !names.is_empty()) {
            for code in read_values(&types, &names)? {
                blocks.push(Block { code, array: None });
            }
            at += 1;
        } else if let Some(name) = list(current) {
            let read = types.split(types.string(&name));
            blocks.push(Block {
                code: format!("{} = {read}", local(&name)?),
                array: None,
            });
            at += 1;
        } else if let Some((name, _, joined)) = row(current).filter(|(_, r, _)| r == "1") {
            let (rows, used) = block(&lines[at..], &name, |line| {
                row(line).map(|(name, row, _)| (name, row))
            })?;
            let read = if joined {
                "gets.chomp".to_string()
            } else {
                types.split(types.string(&name))
            };
            let name = local(&name)?;
            blocks.push(Block {
                code: rows_loop(&rows, vec![format!("{name} = {read}")]),
                array: Some(format!("{name} = Array.new({rows}) {{ {read} }}")),
            });
            at += used;
        } else if let Some((names, _)) = tuple(current).filter(|(_, index)| index == "1") {
            if names.iter().any(|name| {
                ["case", "test", "testcase"].contains(&name.to_ascii_lowercase().as_str())
            }) {
                return None;
            }
            let (rows, used) = block(&lines[at..], &names, tuple)?;
            let target = match names.as_slice() {
                [name] if Types::query(name) => "queries".to_string(),
                _ => names
                    .iter()
                    .map(|n| local(n))
                    .collect::<Option<Vec<_>>>()?
                    .concat(),
            };
            blocks.push(Block {
                code: rows_loop(&rows, read_values(&types, &names)?),
                array: Some(format!(
                    "{target} = Array.new({rows}) {{ {} }}",
                    types.line(&names)?
                )),
            });
            at += used;
        } else {
            return None;
        }
    }
    (!blocks.is_empty()).then_some(blocks)
}

/// The reading code for an input format, or None when some line is not understood. Rows are
/// read in a loop, so they can be used as they are read.
pub fn input_code(format: &str, constraints: &[String]) -> Option<String> {
    let blocks = blocks(format, constraints)?;
    Some(
        blocks
            .iter()
            .map(|block| block.code.as_str())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
}

/// The rows of the reading code as `[loop, array]`: the editor switches one for the other.
pub fn reading_forms(format: &str, constraints: &[String]) -> Vec<[String; 2]> {
    blocks(format, constraints)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|block| Some([block.code, block.array?]))
        .collect()
}
