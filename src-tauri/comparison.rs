fn normalize(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    text.strip_suffix('\n').unwrap_or(&text).to_owned()
}

/// A 1-based position and normalized lines. Columns count Unicode scalar values;
/// a missing line is None, while an empty line is Some("").
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDifference {
    pub line: usize,
    pub column: usize,
    pub actual_line: Option<String>,
    pub expected_line: Option<String>,
}

/// Locate the first difference after normalizing line endings and one trailing newline.
pub fn first_difference(actual: &str, expected: &str) -> Option<OutputDifference> {
    let actual = normalize(actual);
    let expected = normalize(expected);
    let mut actual_lines = actual.split('\n');
    let mut expected_lines = expected.split('\n');
    let mut line = 1;
    loop {
        match (actual_lines.next(), expected_lines.next()) {
            (None, None) => return None,
            (Some(actual), Some(expected)) if actual == expected => line += 1,
            (actual_line, expected_line) => {
                let column = match (actual_line, expected_line) {
                    (Some(actual), Some(expected)) => {
                        actual
                            .chars()
                            .zip(expected.chars())
                            .take_while(|(actual, expected)| actual == expected)
                            .count()
                            + 1
                    }
                    _ => 1,
                };
                return Some(OutputDifference {
                    line,
                    column,
                    actual_line: actual_line.map(str::to_owned),
                    expected_line: expected_line.map(str::to_owned),
                });
            }
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

    fn difference(
        line: usize,
        column: usize,
        actual: Option<&str>,
        expected: Option<&str>,
    ) -> Option<OutputDifference> {
        Some(OutputDifference {
            line,
            column,
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
                first_difference(actual, expected),
                None,
                "{actual:?} / {expected:?}"
            );
        }
    }

    #[test]
    fn returns_the_first_differing_line_and_character() {
        assert_eq!(
            first_difference("6 test\n", "6 tast\n"),
            difference(1, 4, Some("6 test"), Some("6 tast"))
        );
        assert_eq!(
            first_difference("same\nfirst mismatch\nlater", "same\nfirst MISMATCH\nother"),
            difference(2, 7, Some("first mismatch"), Some("first MISMATCH"))
        );
        assert_eq!(
            first_difference("YES", "Yes"),
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
                first_difference(actual, expected),
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
            assert_eq!(first_difference(actual, expected), wanted);
        }
    }

    #[test]
    fn empty_output_and_leading_blank_lines_are_reported() {
        assert_eq!(
            first_difference("", "text"),
            difference(1, 1, Some(""), Some("text"))
        );
        assert_eq!(
            first_difference("text", ""),
            difference(1, 1, Some("text"), Some(""))
        );
        assert_eq!(
            first_difference("\ntext", "text"),
            difference(1, 1, Some(""), Some("text"))
        );
        assert_eq!(
            first_difference("\n\n", ""),
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
            assert_eq!(first_difference(actual, expected), wanted);
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
                    first_difference(actual, expected).is_none(),
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
            first_difference(&actual, &expected),
            difference(1, 349526, Some(&actual), Some(&expected))
        );
    }
}
