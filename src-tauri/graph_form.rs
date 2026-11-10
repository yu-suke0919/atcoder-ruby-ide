//! Where a task's sample input holds a graph (D4): the edges or the parents, found from the input
//! format and the constraints. The screen reads the graph from the sample input by this form.
//! Only formats whose lines before the graph are one line each are judged, so a line of the
//! format is a line of the input.
use crate::input_code::{block, line, list, local, numbered, tuple, Item, Line};
use serde::Serialize;

/// A value of the sample input: the `column`th value of line `line` (from 0), plus `offset`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct At {
    pub line: usize,
    pub column: usize,
    pub offset: i64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GraphForm {
    /// Rows `u_i v_i` (or `u_i v_i w_i`, weighted) from line `line`, as many as `edges`.
    Edges {
        line: usize,
        vertices: At,
        edges: At,
        weighted: bool,
    },
    /// `P_2 … P_N` on line `line`: vertex `i`'s parent is `P_i`.
    Parents { line: usize, vertices: At },
}

/// The graph form of an input format, or None when it holds no graph this understands.
pub fn graph_form(format: &str, constraints: &[String]) -> Option<GraphForm> {
    let lines = format
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(line)
        .collect::<Option<Vec<_>>>()?;
    // The values read so far, by name.
    let mut values: Vec<(String, At)> = Vec::new();
    for (at, current) in lines.iter().enumerate() {
        if let Some(names) = scalars(current) {
            for (column, name) in names.into_iter().enumerate() {
                let place = At {
                    line: at,
                    column,
                    offset: 0,
                };
                values.push((name, place));
            }
        } else if let Some(vertices) = parents(current, &values) {
            return Some(GraphForm::Parents { line: at, vertices });
        } else if let Some((names, index)) = tuple(current) {
            return (index == "1")
                .then(|| edges(&lines[at..], &names, &values, constraints))
                .flatten()
                .map(|(vertices, edges)| GraphForm::Edges {
                    line: at,
                    vertices,
                    edges,
                    weighted: names.len() == 3,
                });
        } else if numbered(current).is_none() && list(current).is_none() {
            return None;
        }
    }
    None
}

/// The names of a line of plain values, such as `N M`.
fn scalars(line: &Line) -> Option<Vec<String>> {
    let names = line
        .items
        .iter()
        .map(|item| match item {
            Item::Var { name, index } if index.is_empty() => Some(name.clone()),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    (!names.is_empty()).then_some(names)
}

/// `P_2 P_3 … P_N`: one variable numbered from 2 up to a value read before, the vertices.
fn parents(line: &Line, values: &[(String, At)]) -> Option<At> {
    let vars: Vec<_> = line
        .items
        .iter()
        .filter_map(|item| match item {
            Item::Var { name, index } => Some((name, index.as_slice())),
            _ => None,
        })
        .collect();
    let (name, [first]) = *vars.first()? else {
        return None;
    };
    let (_, [last]) = *vars.last()? else {
        return None;
    };
    let one_list = vars.iter().all(|(n, index)| *n == name && index.len() == 1);
    let ellipsis = line.items.contains(&Item::Ellipsis);
    if !one_list || !ellipsis || first != "2" {
        return None;
    }
    value(values, last)
}

/// Edge rows `u_i v_i (w_i)`: the vertices, which the constraints bound both ends by, and the
/// rows, as many as a value read before (`M`, `N-1`) that is not the queries' `Q`.
fn edges(
    lines: &[Line],
    names: &[String],
    values: &[(String, At)],
    constraints: &[String],
) -> Option<(At, At)> {
    let ends = names.get(..2).filter(|_| names.len() <= 3)?;
    // `L_i R_i` are intervals.
    if ends
        .iter()
        .any(|n| ["l", "r"].contains(&n.to_ascii_lowercase().as_str()))
    {
        return None;
    }
    let (rows, _) = block(lines, &names.to_vec(), tuple)?;
    let (name, offset) = match rows.split_once(' ') {
        Some((name, sign_number)) => {
            let number: i64 = sign_number.replace(' ', "").parse().ok()?;
            (name.to_string(), number)
        }
        None => (rows, 0),
    };
    if name == "q" {
        return None;
    }
    let count = values
        .iter()
        .find(|(n, _)| local(n).as_deref() == Some(&name))?
        .1;
    let vertices = bound(constraints, ends, values)?;
    Some((
        vertices,
        At {
            offset: count.offset + offset,
            ..count
        },
    ))
}

/// The value read before that a constraint on both ends bounds them by: `1 \leq u_i, v_i \leq N`.
fn bound(constraints: &[String], ends: &[String], values: &[(String, At)]) -> Option<At> {
    constraints.iter().find_map(|constraint| {
        let compact: String = constraint.chars().filter(|c| !c.is_whitespace()).collect();
        if !ends.iter().all(|end| compact.contains(&format!("{end}_"))) {
            return None;
        }
        values.iter().find_map(|(name, at)| {
            let bounded = ["\\leq", "\\le", "\\lt", "<", "≤"].iter().any(|op| {
                compact
                    .match_indices(&format!("{op}{name}"))
                    .any(|(i, found)| {
                        !compact[i + found.len()..]
                            .starts_with(|c: char| c.is_alphanumeric() || "_^{".contains(c))
                    })
            });
            bounded.then_some(*at)
        })
    })
}

fn value(values: &[(String, At)], name: &str) -> Option<At> {
    values.iter().find(|(n, _)| n == name).map(|(_, at)| *at)
}
