//! Public GitHub repository metadata only. No playlist endpoints, credentials,
//! authorization headers, redirects, or raw response bodies in failure output.
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
pub const BODY_LIMIT: usize = 2 * 1024 * 1024;
/// Repeated discovery within this window reuses the response without network.
pub const CACHE_FRESH: Duration = Duration::from_secs(15 * 60);
/// A refused/unavailable directory may fall back to a copy at most this old.
pub const CACHE_STALE_LIMIT: Duration = Duration::from_secs(24 * 60 * 60);
const CACHE_ENTRIES: usize = 128;
const CACHE_BYTES: usize = 16 * 1024 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DirectoryCode {
    EndpointRefused,
    HttpRateLimited,
    HttpForbidden,
    HttpUnavailable,
    BodyTooLarge,
    BodyInvalidUtf8,
    BodyInvalidJson,
    Canceled,
    TransportUnavailable,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryFailure {
    pub code: DirectoryCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<String>,
    /// GitHub `x-ratelimit-reset` epoch seconds, digits only, when exhausted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limit_reset: Option<String>,
}
impl DirectoryFailure {
    fn new(code: DirectoryCode) -> Self {
        Self {
            code,
            http_status: None,
            retry_after: None,
            rate_limit_reset: None,
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryResponse {
    pub http_status: u16,
    pub json: Value,
    /// network, fresh-cache, revalidated or stale-cache. Never a body or URL.
    pub cache: &'static str,
}
struct CacheEntry {
    etag: Option<String>,
    body: Arc<Vec<u8>>,
    stored: Instant,
}
/// Bounded per-process directory cache. Bodies are already admitted JSON.
#[derive(Default)]
pub struct DirectoryCache {
    entries: HashMap<String, CacheEntry>,
    bytes: usize,
}
#[derive(Debug, PartialEq)]
pub enum CacheLookup {
    Fresh(Arc<Vec<u8>>),
    Revalidate(String),
    Miss,
}
impl DirectoryCache {
    pub fn lookup(&self, key: &str, now: Instant) -> CacheLookup {
        match self.entries.get(key) {
            Some(entry) if now.saturating_duration_since(entry.stored) < CACHE_FRESH => {
                CacheLookup::Fresh(entry.body.clone())
            }
            Some(CacheEntry {
                etag: Some(etag), ..
            }) => CacheLookup::Revalidate(etag.clone()),
            _ => CacheLookup::Miss,
        }
    }
    /// A 304 for the exact stored validator renews the stored body.
    pub fn revalidated(&mut self, key: &str, etag: &str, now: Instant) -> Option<Arc<Vec<u8>>> {
        let entry = self.entries.get_mut(key)?;
        if entry.etag.as_deref() != Some(etag) {
            return None;
        }
        entry.stored = now;
        Some(entry.body.clone())
    }
    pub fn stale(&self, key: &str, now: Instant) -> Option<Arc<Vec<u8>>> {
        self.entries
            .get(key)
            .filter(|entry| now.saturating_duration_since(entry.stored) < CACHE_STALE_LIMIT)
            .map(|entry| entry.body.clone())
    }
    pub fn store(&mut self, key: &str, etag: Option<&str>, body: Vec<u8>, now: Instant) {
        if body.len() > BODY_LIMIT || key.len() > 16_384 {
            return;
        }
        if let Some(old) = self.entries.remove(key) {
            self.bytes -= old.body.len() + key.len();
        }
        while !self.entries.is_empty()
            && (self.entries.len() >= CACHE_ENTRIES
                || self.bytes + body.len() + key.len() > CACHE_BYTES)
        {
            // Oldest-first eviction keeps both count and byte bounds exact.
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.stored)
                .map(|(key, _)| key.clone())
                .expect("nonempty cache");
            let entry = self.entries.remove(&oldest).expect("present");
            self.bytes -= entry.body.len() + oldest.len();
        }
        let etag = etag
            .filter(|v| {
                !v.is_empty() && v.len() <= 1024 && v.is_ascii() && !v.chars().any(char::is_control)
            })
            .map(str::to_owned);
        self.bytes += body.len() + key.len();
        self.entries.insert(
            key.to_owned(),
            CacheEntry {
                etag,
                body: Arc::new(body),
                stored: now,
            },
        );
    }
    #[cfg(test)]
    pub fn len_and_bytes(&self) -> (usize, usize) {
        (self.entries.len(), self.bytes)
    }
}
static CACHE: LazyLock<Mutex<DirectoryCache>> =
    LazyLock::new(|| Mutex::new(DirectoryCache::default()));
fn decoded(raw: &str) -> Option<String> {
    let input = raw.as_bytes();
    let mut bytes = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'%' {
            if i + 2 >= input.len() {
                return None;
            }
            let hi = (input[i + 1] as char).to_digit(16)?;
            let lo = (input[i + 2] as char).to_digit(16)?;
            bytes.push((hi * 16 + lo) as u8);
            i += 3
        } else {
            bytes.push(input[i]);
            i += 1
        }
    }
    String::from_utf8(bytes).ok()
}
fn component(raw: &str, limit: usize, slash: bool) -> bool {
    decoded(raw).is_some_and(|s| {
        !s.is_empty()
            && s.len() <= limit
            && s != "."
            && s != ".."
            && (!slash
                || s.split('/')
                    .all(|part| !part.is_empty() && part != "." && part != ".."))
            && !s.chars().any(|c| {
                c.is_control()
                    || c.is_whitespace()
                    || matches!(c, '\\' | '?' | '#')
                    || (!slash && c == '/')
            })
    })
}
fn integer(raw: &str, max: u32) -> bool {
    !raw.is_empty()
        && raw.bytes().all(|b| b.is_ascii_digit())
        && !raw.starts_with('0')
        && raw.parse::<u32>().is_ok_and(|n| (1..=max).contains(&n))
}
pub fn validate_endpoint(raw: &str) -> Result<(), DirectoryFailure> {
    let refuse = || DirectoryFailure::new(DirectoryCode::EndpointRefused);
    if raw.len() > 16384
        || !raw.starts_with("https://api.github.com/")
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
        || raw.contains('\\')
    {
        return Err(refuse());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| refuse())?;
    if url.scheme() != "https"
        || url.host_str() != Some("api.github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(refuse());
    }
    let raw_path = raw
        .strip_prefix("https://api.github.com")
        .ok_or_else(refuse)?
        .split('?')
        .next()
        .ok_or_else(refuse)?;
    if url.path() != raw_path || raw_path.ends_with('/') {
        return Err(refuse());
    }
    let path: Vec<_> = url.path().split('/').skip(1).collect();
    let mode = if path.len() == 2 && path[0] == "repositories" {
        if !path[1].bytes().all(|b| b.is_ascii_digit())
            || path[1].starts_with('0')
            || !path[1]
                .parse::<u64>()
                .is_ok_and(|n| (1..=9_007_199_254_740_991).contains(&n))
        {
            return Err(refuse());
        }
        "repo"
    } else if path == ["search", "repositories"] {
        "search"
    } else {
        if path.len() < 3
            || path[0] != "repos"
            || !component(path[1], 100, false)
            || !path[1]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
            || !component(path[2], 100, false)
        {
            return Err(refuse());
        }
        match path.len() {
            3 => "repo",
            4 if path[3] == "readme" => "ref",
            5 if path[3] == "git" && path[4] == "trees" => return Err(refuse()),
            6 if path[3] == "git" && path[4] == "trees" && component(path[5], 256, true) => "tree",
            _ if path[3] == "contents"
                && path.len() >= 5
                && path[4..].iter().all(|p| component(p, 256, false)) =>
            {
                "ref"
            }
            _ => return Err(refuse()),
        }
    };
    if url
        .query()
        .is_some_and(|q| q.is_empty() || decoded(q).is_none())
    {
        return Err(refuse());
    }
    let mut keys = HashSet::new();
    let mut q = false;
    for (key, value) in url.query_pairs() {
        if !keys.insert(key.to_string()) || value.chars().any(char::is_control) {
            return Err(refuse());
        }
        let valid = match (mode, key.as_ref()) {
            ("search", "q") => {
                q = true;
                !value.trim().is_empty() && value.len() <= 512
            }
            ("search", "sort") => matches!(
                value.as_ref(),
                "stars" | "forks" | "help-wanted-issues" | "updated"
            ),
            ("search", "order") => matches!(value.as_ref(), "asc" | "desc"),
            ("search", "per_page") => integer(&value, 100),
            ("search", "page") => integer(&value, 1000),
            ("tree", "recursive") => value == "1",
            ("ref", "ref") => {
                !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
            }
            _ => false,
        };
        if !valid {
            return Err(refuse());
        }
    }
    if mode == "search" && !q {
        return Err(refuse());
    }
    Ok(())
}
pub fn decode_body(bytes: &[u8]) -> Result<Value, DirectoryFailure> {
    if bytes.len() > BODY_LIMIT {
        return Err(DirectoryFailure::new(DirectoryCode::BodyTooLarge));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| DirectoryFailure::new(DirectoryCode::BodyInvalidUtf8))?;
    let json: Value = serde_json::from_str(text)
        .map_err(|_| DirectoryFailure::new(DirectoryCode::BodyInvalidJson))?;
    if !json.is_object() && !json.is_array() {
        return Err(DirectoryFailure::new(DirectoryCode::BodyInvalidJson));
    }
    Ok(json)
}
#[cfg(test)]
pub fn check_status(status: u16, retry_after: Option<&str>) -> Result<(), DirectoryFailure> {
    check_status_limits(status, retry_after, None, None)
}
/// GitHub reports an exhausted primary limit as 403 with `x-ratelimit-remaining: 0`.
pub fn check_status_limits(
    status: u16,
    retry_after: Option<&str>,
    remaining: Option<&str>,
    reset: Option<&str>,
) -> Result<(), DirectoryFailure> {
    if status == 200 {
        return Ok(());
    }
    let exhausted = remaining.is_some_and(|v| v.trim() == "0");
    let code = match status {
        429 => DirectoryCode::HttpRateLimited,
        403 if exhausted => DirectoryCode::HttpRateLimited,
        403 => DirectoryCode::HttpForbidden,
        _ => DirectoryCode::HttpUnavailable,
    };
    Err(DirectoryFailure {
        code,
        http_status: Some(status),
        retry_after: retry_after
            .filter(|v| {
                !v.is_empty() && v.len() <= 128 && v.is_ascii() && !v.chars().any(char::is_control)
            })
            .map(str::to_owned),
        rate_limit_reset: reset
            .filter(|v| {
                code == DirectoryCode::HttpRateLimited
                    && !v.is_empty()
                    && v.len() <= 12
                    && v.bytes().all(|b| b.is_ascii_digit())
            })
            .map(str::to_owned),
    })
}
fn canceled(flag: &AtomicBool) -> Result<(), DirectoryFailure> {
    if flag.load(Ordering::SeqCst) {
        Err(DirectoryFailure::new(DirectoryCode::Canceled))
    } else {
        Ok(())
    }
}
fn cached(body: &[u8], cache: &'static str) -> Result<DirectoryResponse, DirectoryFailure> {
    Ok(DirectoryResponse {
        http_status: 200,
        json: decode_body(body)?,
        cache,
    })
}
/// Unavailable or refused directories may reuse a bounded recent copy; the
/// original failure is returned when no admitted copy exists.
fn stale_or(raw: &str, failure: DirectoryFailure) -> Result<DirectoryResponse, DirectoryFailure> {
    if matches!(
        failure.code,
        DirectoryCode::HttpRateLimited
            | DirectoryCode::HttpForbidden
            | DirectoryCode::HttpUnavailable
            | DirectoryCode::TransportUnavailable
    ) {
        let stale = CACHE
            .lock()
            .ok()
            .and_then(|cache| cache.stale(raw, Instant::now()));
        if let Some(body) = stale {
            return cached(&body, "stale-cache");
        }
    }
    Err(failure)
}
pub async fn fetch_directory(
    raw: &str,
    flag: &AtomicBool,
) -> Result<DirectoryResponse, DirectoryFailure> {
    validate_endpoint(raw)?;
    canceled(flag)?;
    let lookup = CACHE
        .lock()
        .map(|cache| cache.lookup(raw, Instant::now()))
        .unwrap_or(CacheLookup::Miss);
    let validator = match lookup {
        CacheLookup::Fresh(body) => return cached(&body, "fresh-cache"),
        CacheLookup::Revalidate(etag) => Some(etag),
        CacheLookup::Miss => None,
    };
    let mut response = match crate::network::response_directory(raw, validator.as_deref()).await {
        Ok(response) => response,
        Err(_) => {
            canceled(flag)?;
            return stale_or(
                raw,
                DirectoryFailure::new(DirectoryCode::TransportUnavailable),
            );
        }
    };
    canceled(flag)?;
    let status = response.status().as_u16();
    if status == 304 {
        if let Some(etag) = validator.as_deref() {
            let renewed = CACHE
                .lock()
                .ok()
                .and_then(|mut cache| cache.revalidated(raw, etag, Instant::now()));
            if let Some(body) = renewed {
                return cached(&body, "revalidated");
            }
        }
        return Err(DirectoryFailure {
            http_status: Some(304),
            ..DirectoryFailure::new(DirectoryCode::HttpUnavailable)
        });
    }
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    if let Err(failure) = check_status_limits(
        status,
        header("retry-after").as_deref(),
        header("x-ratelimit-remaining").as_deref(),
        header("x-ratelimit-reset").as_deref(),
    ) {
        return stale_or(raw, failure);
    }
    let etag = header("etag");
    if response
        .content_length()
        .is_some_and(|n| n > BODY_LIMIT as u64)
    {
        return Err(DirectoryFailure::new(DirectoryCode::BodyTooLarge));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| DirectoryFailure::new(DirectoryCode::TransportUnavailable))?
    {
        canceled(flag)?;
        if chunk.len() > BODY_LIMIT.saturating_sub(bytes.len()) {
            return Err(DirectoryFailure::new(DirectoryCode::BodyTooLarge));
        }
        bytes.extend_from_slice(&chunk);
    }
    canceled(flag)?;
    let json = decode_body(&bytes)?;
    canceled(flag)?;
    if let Ok(mut cache) = CACHE.lock() {
        cache.store(raw, etag.as_deref(), bytes, Instant::now());
    }
    Ok(DirectoryResponse {
        http_status: status,
        json,
        cache: "network",
    })
}
#[cfg(test)]
#[path = "source_directory_tests.rs"]
mod tests;
