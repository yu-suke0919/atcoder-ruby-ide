//! Reading code for a task's input format. The format is the input section's `pre` with each
//! variable as `$TeX$`; the constraints tell which variables are strings. Formats this does not
//! understand give no code, so a new file never starts with code that reads the input wrongly.
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Item {
    /// A variable: its name without TeX wrappers and its subscript parts.
    Var { name: String, index: Vec<String> },
    /// `\ldots` and other horizontal ellipses.
    Ellipsis,
    /// `\vdots` or `:`, the rows in between.
    Rows,
}

#[derive(Debug)]
pub(crate) struct Line {
    pub(crate) items: Vec<Item>,
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
        // `{\rm Query}`: a name in roman type written as a group (D2).
        let roman = rest.strip_prefix('{').and_then(|inner| {
            let end = inner.find('}')?;
            let name = inner[..end].trim().strip_prefix("\\rm")?.trim();
            name.chars()
                .all(|c| c.is_ascii_alphabetic())
                .then(|| (name.to_string(), &inner[end + 1..]))
                .filter(|(name, _)| !name.is_empty())
        });
        let (name, after) = if let Some(roman) = roman {
            roman
        } else if let Some(wrapper) = WRAPPERS.iter().find(|w| rest.starts_with(**w)) {
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

pub(crate) fn line(text: &str) -> Option<Line> {
    let mut items_of_line = Vec::new();
    let mut joined = false;
    let mut rest = text;
    let mut groups = 0;
    while let Some(start) = rest.find('$') {
        for word in rest[..start].split_whitespace() {
            items_of_line.extend(items(word)?);
        }
        // `$S_{1,1}$$S_{1,2}$`: groups with nothing between them are joined too (D2).
        joined |= groups > 0 && start == 0;
        groups += 1;
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
        // A choice of letters or symbols, `$X$ は A、B、C のいずれか`, is a string; a choice of
        // numbers, `$c$ は $1$, $2$ のいずれか`, stays an integer (D2).
        let letters = item.contains("いずれか")
            && item.split_once('は').is_some_and(|(_, choices)| {
                choices
                    .split('$')
                    .step_by(2)
                    .any(|text| text.chars().any(|c| c.is_ascii_graphic() && c != ','))
            });
        if !letters
            && ![
                "文字列",
                "英小文字",
                "英大文字",
                "文字",
                "または",
                "からなる",
                // Decimals are read as strings, left to the user to convert (docs/review.md, R8).
                "小数",
                "実数",
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
pub(crate) fn local(name: &str) -> Option<String> {
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
pub(crate) fn tuple(line: &Line) -> Option<(Vec<String>, String)> {
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
pub(crate) fn list(line: &Line) -> Option<String> {
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
    // A line of only an ellipsis has no variable to read.
    name.filter(|_| ellipsis).cloned()
}

/// How many rows a block has: written out (1, 2, 3, ...) or ended after `\vdots` by the last
/// row's index. Returns the count and the number of lines the block used.
pub(crate) fn block<T: PartialEq>(
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
    // Some tasks write `\dots` where the rows in between are meant (D2).
    let rows = lines
        .get(used)
        .is_some_and(|line| line.items == [Item::Rows] || line.items == [Item::Ellipsis]);
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
    read_into(types, names, &locals)
}
/// Reads one line into the locals given, one per variable `names`, converting only the integers.
fn read_into(types: &Types, names: &[String], locals: &[String]) -> Option<Vec<String>> {
    let mixed = names.iter().any(|n| types.string(n)) && names.iter().any(|n| !types.string(n));
    if !mixed {
        return Some(vec![format!(
            "{} = {}",
            locals.join(", "),
            types.line(names)?
        )]);
    }
    let mut code = vec![format!("{} = gets.split", locals.join(", "))];
    for (name, local) in names.iter().zip(locals) {
        if !types.string(name) {
            code.push(format!("{local} = {local}.to_i"));
        }
    }
    Some(code)
}

/// Rows read one by one in a loop: `n.times do ... end`. The body may hold blocks of lines.
fn rows_loop(rows: &str, body: &[String]) -> String {
    let count = if rows.contains(' ') {
        format!("({rows})")
    } else {
        rows.to_string()
    };
    format!("{count}.times do\n{}\nend", indent(&body.join("\n")))
}
fn indent(code: &str) -> String {
    code.lines()
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// One line of numbered values such as `X_1 Y_1 R_1 X_2 Y_2 R_2`, `P_x P_y Q_x Q_y` or
/// `N_1 N_2 M` (D2): each variable with its number or letter, read into locals like `x1`.
pub(crate) fn numbered(line: &Line) -> Option<Vec<(String, String)>> {
    let values = line
        .items
        .iter()
        .map(|item| match item {
            Item::Var { name, index } => match index.as_slice() {
                [] => Some((name.clone(), String::new())),
                [number] if number.chars().all(|c| c.is_ascii_alphanumeric()) => {
                    Some((name.clone(), number.to_ascii_lowercase()))
                }
                _ => None,
            },
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    // The same number throughout is one row of a block, such as `t_1 x_1 y_1`.
    values
        .iter()
        .any(|(_, number)| *number != values[0].1)
        .then_some(values)
}

/// A row that starts with its length, `K_i A_{i,1} A_{i,2} ... A_{i,K_i}` (D2): the length's
/// variable, the list's variable and the row.
fn counted(line: &Line) -> Option<((String, String), String)> {
    let [Item::Var { name: count, index }, rest @ ..] = line.items.as_slice() else {
        return None;
    };
    let [row] = index.as_slice() else {
        return None;
    };
    let mut list = None;
    let mut ellipsis = false;
    for item in rest {
        match item {
            Item::Ellipsis => ellipsis = true,
            Item::Var { name, index } if index.len() == 2 && index[0] == *row => {
                if *list.get_or_insert(name) != name {
                    return None;
                }
            }
            _ => return None,
        }
    }
    let list = list.filter(|_| ellipsis)?;
    Some(((count.clone(), list.clone()), row.clone()))
}

/// The reading code: its blocks of lines, and the rows' loop and array forms to switch between.
#[derive(Default)]
struct Reading {
    code: Vec<String>,
    forms: Vec<[String; 2]>,
}

fn read_lines(lines: &[Line], types: &Types) -> Option<Reading> {
    let mut reading = Reading::default();
    let rows_block = |reading: &mut Reading, rows: &str, body: Vec<String>, array: String| {
        let code = rows_loop(rows, &body);
        reading.forms.push([code.clone(), array]);
        reading.code.push(code);
    };
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
            reading.code.extend(read_values(types, &names)?);
            at += 1;
        } else if let Some(values) = numbered(current) {
            let names: Vec<_> = values.iter().map(|(name, _)| name.clone()).collect();
            let locals = values
                .iter()
                .map(|(name, number)| Some(format!("{}{number}", local(name)?)))
                .collect::<Option<Vec<_>>>()?;
            reading.code.extend(read_into(types, &names, &locals)?);
            at += 1;
        } else if let Some(name) = list(current) {
            let read = types.split(types.string(&name));
            reading.code.push(format!("{} = {read}", local(&name)?));
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
            let array = format!("{name} = Array.new({rows}) {{ {read} }}");
            rows_block(&mut reading, &rows, vec![format!("{name} = {read}")], array);
            at += used;
        } else if let Some(((count, list), _)) = counted(current).filter(|(_, r)| r == "1") {
            let (rows, used) = block(&lines[at..], &(count.clone(), list.clone()), counted)?;
            let read = types.split(types.string(&list));
            let (count, list) = (local(&count)?, local(&list)?);
            let array = format!("{count}{list} = Array.new({rows}) {{ {read} }}");
            rows_block(
                &mut reading,
                &rows,
                vec![format!("{count}, *{list} = {read}")],
                array,
            );
            at += used;
        } else if let Some((names, _)) = tuple(current).filter(|(_, index)| index == "1") {
            let (rows, used) = block(&lines[at..], &names, tuple)?;
            if names.iter().any(|name| {
                ["case", "test", "testcase"].contains(&name.to_ascii_lowercase().as_str())
            }) {
                // Test cases (D2): the lines after them are the format of one test case, read
                // inside the loop. Without them (pages read before D2) there is no code.
                let case = read_lines(&lines[at + used..], types)?;
                reading.code.push(rows_loop(&rows, &case.code));
                reading.forms.extend(
                    case.forms
                        .into_iter()
                        .map(|[code, array]| [indent(&code), indent(&array)]),
                );
                at = lines.len();
                continue;
            }
            let target = match names.as_slice() {
                [name] if Types::query(name) => "queries".to_string(),
                _ => names
                    .iter()
                    .map(|n| local(n))
                    .collect::<Option<Vec<_>>>()?
                    .concat(),
            };
            let array = format!("{target} = Array.new({rows}) {{ {} }}", types.line(&names)?);
            rows_block(&mut reading, &rows, read_values(types, &names)?, array);
            at += used;
        } else {
            return None;
        }
    }
    (!reading.code.is_empty()).then_some(reading)
}

fn parse(format: &str, constraints: &[String]) -> Option<Reading> {
    let lines = format
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(line)
        .collect::<Option<Vec<_>>>()?;
    let (strings, all_integers) = types(constraints);
    read_lines(
        &lines,
        &Types {
            strings,
            all_integers,
        },
    )
}

/// The reading code for an input format, or None when some line is not understood. Rows are
/// read in a loop, so they can be used as they are read.
pub fn input_code(format: &str, constraints: &[String]) -> Option<String> {
    Some(parse(format, constraints)?.code.join("\n") + "\n")
}

/// The rows of the reading code as `[loop, array]`: the editor switches one for the other.
pub fn reading_forms(format: &str, constraints: &[String]) -> Vec<[String; 2]> {
    parse(format, constraints)
        .map(|reading| reading.forms)
        .unwrap_or_default()
}
