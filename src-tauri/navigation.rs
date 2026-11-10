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

/// Origins the るりま window may open (D3): the reference, and the search engine that searches
/// its full text.
pub const RURIMA_ORIGINS: &[&str] = &["https://docs.ruby-lang.org", "https://www.google.com"];
/// The first page of the るりま window: the reference of Ruby 3.4, the Ruby AtCoder uses.
pub const RURIMA_HOME: &str = "https://docs.ruby-lang.org/ja/3.4/doc/index.html";
/// Added after the words. Every version's pages name the latest version's page as the canonical
/// one, so Google lists only those; `rurima_page` opens them as Ruby 3.4's.
const RURIMA_SEARCH: &str = "site:docs.ruby-lang.org/ja/latest/";
const RURIMA_LATEST: &str = "/ja/latest/";
const RURIMA_VERSION: &str = "/ja/3.4/";
const MAX_SEARCH_CHARS: usize = 200;

/// Whether the るりま window may open a URL.
pub fn is_rurima_page(url: &Url) -> bool {
    RURIMA_ORIGINS
        .iter()
        .any(|origin| Url::parse(origin).is_ok_and(|origin| origin.origin() == url.origin()))
}

/// The Ruby 3.4 page, AtCoder's Ruby, for a page of the latest version of the reference.
pub fn rurima_page(url: &Url) -> Option<Url> {
    if url.origin() != Url::parse(RURIMA_ORIGINS[0]).ok()?.origin() {
        return None;
    }
    let rest = url.path().strip_prefix(RURIMA_LATEST)?;
    let mut page = url.clone();
    page.set_path(&format!("{RURIMA_VERSION}{rest}"));
    Some(page)
}

/// What the るりま window opens for text typed or selected: a page of the reference or of the
/// search as it is (a missing scheme means HTTPS), or else the full-text search for the words.
pub fn rurima_target(input: &str) -> Result<Url, String> {
    let words = input.split_whitespace().collect::<Vec<_>>().join(" ");
    if words.is_empty() {
        return Err("検索する語を入れてください。".into());
    }
    let page = if words.contains("://") {
        Some(Url::parse(&words).ok())
    } else if !words.contains(' ')
        && RURIMA_ORIGINS
            .iter()
            .any(|origin| words.starts_with(origin.trim_start_matches("https://")))
    {
        Some(Url::parse(&format!("https://{words}")).ok())
    } else {
        None
    };
    if let Some(page) = page {
        return page
            .filter(is_rurima_page)
            .map(|page| rurima_page(&page).unwrap_or(page))
            .ok_or_else(|| {
                format!(
                    "るりまの窓で開けるのは {} のページだけです。",
                    RURIMA_ORIGINS.join("、")
                )
            });
    }
    let words: String = words.chars().take(MAX_SEARCH_CHARS).collect();
    Url::parse_with_params(
        "https://www.google.com/search",
        &[("q", format!("{words} {RURIMA_SEARCH}"))],
    )
    .map_err(|e| e.to_string())
}
