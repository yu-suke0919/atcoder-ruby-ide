//! Which pages the right-hand browser may open.
use url::Url;

/// Origins the browser may open. A setting may add more later.
pub const ALLOWED_ORIGINS: &[&str] = &["https://atcoder.jp"];

/// Whether a URL belongs to an allowed origin.
pub fn is_allowed(url: &Url) -> bool {
    ALLOWED_ORIGINS
        .iter()
        .any(|origin| Url::parse(origin).is_ok_and(|origin| origin.origin() == url.origin()))
}

/// Parses what was typed in the URL field. A missing scheme means HTTPS.
pub fn browser_target(input: &str) -> Result<Url, String> {
    let input = input.trim();
    let url = if input.contains("://") {
        Url::parse(input)
    } else {
        Url::parse(&format!("https://{input}"))
    };
    url.ok().filter(is_allowed).ok_or_else(|| {
        format!(
            "開けるのは {} のページだけです。",
            ALLOWED_ORIGINS.join("、")
        )
    })
}
