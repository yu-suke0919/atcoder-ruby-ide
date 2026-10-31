fn normalize(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    text.strip_suffix('\n').unwrap_or(&text).to_owned()
}

/// Independent 1-based columns and normalized lines. Columns count Unicode scalar values;
/// a missing line is None, while an empty line is Some("").
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDifference {
    pub line: usize,
    pub column: usize,
    pub expected_column: usize,
    pub actual_line: Option<String>,
    pub expected_line: Option<String>,
}

/// Locate the first difference after normalizing line endings and one trailing newline.
pub fn first_difference(
    actual: &str,
    expected: &str,
    tolerance: Option<f64>,
) -> Option<OutputDifference> {
    let actual = normalize(actual);
    let expected = normalize(expected);
    let mut actual_lines = actual.split('\n');
    let mut expected_lines = expected.split('\n');
    let mut line = 1;
    loop {
        match (actual_lines.next(), expected_lines.next()) {
            (None, None) => return None,
            (actual_line, expected_line) => {
                let positions = match (actual_line, expected_line) {
                    (Some(actual), Some(expected)) => line_difference(actual, expected, tolerance),
                    _ => Some((1, 1)),
                };
                let Some((column, expected_column)) = positions else {
                    line += 1;
                    continue;
                };
                return Some(OutputDifference {
                    line,
                    column,
                    expected_column,
                    actual_line: actual_line.map(str::to_owned),
                    expected_line: expected_line.map(str::to_owned),
                });
            }
        }
    }
}

fn chunks(mut text: &str) -> impl Iterator<Item = &str> {
    std::iter::from_fn(move || {
        let whitespace = text.chars().next()?.is_whitespace();
        let end = text
            .char_indices()
            .find(|(_, c)| c.is_whitespace() != whitespace)
            .map_or(text.len(), |(index, _)| index);
        let (chunk, rest) = text.split_at(end);
        text = rest;
        Some(chunk)
    })
}

fn numeric_equal(actual: &str, expected: &str, epsilon: f64) -> bool {
    let Ok(actual) = actual.parse::<f64>() else {
        return false;
    };
    let Ok(expected) = expected.parse::<f64>() else {
        return false;
    };
    if !actual.is_finite() || !expected.is_finite() {
        return false;
    }
    let difference = (actual - expected).abs();
    difference <= epsilon
        || (expected != 0.0 && {
            let relative = if difference.is_finite() {
                difference / expected.abs()
            } else {
                // Opposite-signed finite values can overflow subtraction; use their ratio instead.
                (actual / expected - 1.0).abs()
            };
            relative <= epsilon
        })
}

fn line_difference(actual: &str, expected: &str, tolerance: Option<f64>) -> Option<(usize, usize)> {
    if actual == expected {
        return None;
    }
    let (mut actual, mut expected) = (chunks(actual), chunks(expected));
    let (mut actual_column, mut expected_column) = (1, 1);
    loop {
        match (actual.next(), expected.next()) {
            (None, None) => return None,
            (Some(a), Some(e))
                if a == e || tolerance.is_some_and(|epsilon| numeric_equal(a, e, epsilon)) =>
            {
                actual_column += a.chars().count();
                expected_column += e.chars().count();
            }
            (Some(a), Some(e)) => {
                let common = a.chars().zip(e.chars()).take_while(|(a, e)| a == e).count();
                return Some((actual_column + common, expected_column + common));
            }
            _ => return Some((actual_column, expected_column)),
        }
    }
}

pub fn decode_output(bytes: &[u8], truncated: bool) -> String {
    let mut end = bytes.len();
    if truncated {
        if let Some(last) = bytes.utf8_chunks().last() {
            let invalid = last.invalid();
            if !invalid.is_empty()
                && std::str::from_utf8(invalid)
                    .unwrap_err()
                    .error_len()
                    .is_none()
            {
                end -= invalid.len();
            }
        }
    }
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::{first_difference, normalize, OutputDifference};

    #[test]
    fn tolerance_accepts_only_numeric_tokens_and_preserves_separators() {
        for (actual, expected, epsilon, matched) in [
            ("1.125", "1", 0.125, true),
            ("1.125001", "1", 0.125, false),
            ("1152", "1024", 0.125, true),
            ("1152.001", "1024", 0.125, false),
            ("-1152", "-1024", 0.125, true),
            ("0.125", "0", 0.125, true),
            ("0.126", "0", 0.125, false),
            ("1e0\t+.5\r\n", "1\t0.5000000\n", 1e-6, true),
            ("1.0  x", "1 x", 1e-6, false),
            ("1.0\tx", "1 x", 1e-6, false),
            ("x=1.0", "x=1", 1e-6, false),
            ("NaN", "nan", 1e-6, false),
            ("NaN", "NaN", 1e-6, true),
            ("inf", "1e400", 1e-6, false),
            ("1e400", "2e400", 1e-6, false),
            ("1e308", "-1e308", 1.0, false),
            ("1e308", "-1e308", 2.0, true),
        ] {
            assert_eq!(
                first_difference(actual, expected, Some(epsilon)).is_none(),
                matched,
                "{actual:?} / {expected:?}"
            );
        }
        assert!(first_difference("1.0", "1", None).is_some());
    }

    #[test]
    fn tolerated_tokens_keep_independent_unicode_columns_and_line_endings() {
        let difference = first_difference("0.500 日😀A", "0.5 日😀B", Some(1e-6)).unwrap();
        assert_eq!(
            (
                difference.line,
                difference.column,
                difference.expected_column
            ),
            (1, 9, 7)
        );
        let difference = first_difference("1.0  x", "1 x", Some(1e-6)).unwrap();
        assert_eq!((difference.column, difference.expected_column), (5, 3));
        let difference = first_difference("1.0\n\n", "1\n", Some(1e-6)).unwrap();
        assert_eq!(
            (
                difference.line,
                difference.column,
                difference.expected_column
            ),
            (2, 1, 1)
        );
        assert_eq!(difference.actual_line.as_deref(), Some(""));
        assert_eq!(difference.expected_line, None);
        let actual = format!("{}x", "1.000 ".repeat(100_000));
        let expected = format!("{}y", "1 ".repeat(100_000));
        let difference = first_difference(&actual, &expected, Some(1e-6)).unwrap();
        assert_eq!(
            (difference.column, difference.expected_column),
            (600_001, 200_001)
        );
    }

    fn difference(
        line: usize,
        column: usize,
        actual: Option<&str>,
        expected: Option<&str>,
    ) -> Option<OutputDifference> {
        Some(OutputDifference {
            line,
            column,
            expected_column: column,
            actual_line: actual.map(str::to_owned),
            expected_line: expected.map(str::to_owned),
        })
    }

    #[test]
    fn equivalent_output_has_no_difference() {
        for (actual, expected) in [
            ("", ""),
            ("\n", ""),
            ("a\r\nb\r\n", "a\nb"),
            ("a\rb\r", "a\nb"),
            ("日😀\n", "日😀"),
        ] {
            assert_eq!(
                first_difference(actual, expected, None),
                None,
                "{actual:?} / {expected:?}"
            );
        }
    }

    #[test]
    fn returns_the_first_differing_line_and_character() {
        assert_eq!(
            first_difference("6 test\n", "6 tast\n", None),
            difference(1, 4, Some("6 test"), Some("6 tast"))
        );
        assert_eq!(
            first_difference(
                "same\nfirst mismatch\nlater",
                "same\nfirst MISMATCH\nother",
                None
            ),
            difference(2, 7, Some("first mismatch"), Some("first MISMATCH"))
        );
        assert_eq!(
            first_difference("YES", "Yes", None),
            difference(1, 2, Some("YES"), Some("Yes"))
        );
    }

    #[test]
    fn significant_whitespace_and_line_prefixes_have_exact_columns() {
        for (actual, expected, column) in [
            (" value", "value", 1),
            ("value ", "value", 6),
            ("a\tb", "a b", 2),
            ("ab", "abcd", 3),
            ("abcd", "ab", 3),
        ] {
            assert_eq!(
                first_difference(actual, expected, None),
                difference(1, column, Some(actual), Some(expected))
            );
        }
    }

    #[test]
    fn missing_lines_are_distinct_from_empty_lines() {
        for (actual, expected, wanted) in [
            ("a", "a\n\n", difference(2, 1, None, Some(""))),
            ("a\n\n", "a", difference(2, 1, Some(""), None)),
            ("a\nb", "a\nb\nc", difference(3, 1, None, Some("c"))),
            ("a\nb\nc", "a\nb", difference(3, 1, Some("c"), None)),
            ("a\n\nc", "a\nb\nc", difference(2, 1, Some(""), Some("b"))),
        ] {
            assert_eq!(first_difference(actual, expected, None), wanted);
        }
    }

    #[test]
    fn empty_output_and_leading_blank_lines_are_reported() {
        assert_eq!(
            first_difference("", "text", None),
            difference(1, 1, Some(""), Some("text"))
        );
        assert_eq!(
            first_difference("text", "", None),
            difference(1, 1, Some("text"), Some(""))
        );
        assert_eq!(
            first_difference("\ntext", "text", None),
            difference(1, 1, Some(""), Some("text"))
        );
        assert_eq!(
            first_difference("\n\n", "", None),
            difference(2, 1, Some(""), None)
        );
    }

    #[test]
    fn positions_count_unicode_scalars_after_normalizing_newlines() {
        for (actual, expected, wanted) in [
            (
                "日😀A",
                "日😀B",
                difference(1, 3, Some("日😀A"), Some("日😀B")),
            ),
            (
                "e\u{301}x",
                "e\u{301}y",
                difference(1, 3, Some("e\u{301}x"), Some("e\u{301}y")),
            ),
            (
                "ok\r\n日😀A\r\n",
                "ok\n日😀B",
                difference(2, 3, Some("日😀A"), Some("日😀B")),
            ),
            (
                "日😀",
                "日😀A",
                difference(1, 3, Some("日😀"), Some("日😀A")),
            ),
        ] {
            assert_eq!(first_difference(actual, expected, None), wanted);
        }
    }

    #[test]
    fn details_agree_with_the_existing_boolean_comparison() {
        let outputs = [
            "",
            "\n",
            "\n\n",
            " ",
            "a",
            "a\n",
            "a\n\n",
            "a\r\n",
            "a\rb",
            "a\nb",
            "a\n\nb",
            "\ta",
            "日本語",
            "😀",
            "e\u{301}",
        ];
        for actual in outputs {
            for expected in outputs {
                assert_eq!(
                    first_difference(actual, expected, None).is_none(),
                    normalize(actual) == normalize(expected),
                    "{actual:?} / {expected:?}"
                );
            }
        }
    }

    #[test]
    fn finds_a_difference_at_the_end_of_a_one_mib_utf8_line() {
        let prefix = "あ".repeat(349525);
        let actual = format!("{prefix}x");
        let expected = format!("{prefix}y");
        assert_eq!(actual.len(), 1048576);
        assert_eq!(
            first_difference(&actual, &expected, None),
            difference(1, 349526, Some(&actual), Some(&expected))
        );
    }
}
