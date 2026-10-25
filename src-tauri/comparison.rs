pub fn compare_output(actual: &str, expected: &str) -> bool {
    fn normalize(text: &str) -> String {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        text.strip_suffix('\n').unwrap_or(&text).to_owned()
    }
    normalize(actual) == normalize(expected)
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
