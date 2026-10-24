// Copyright 2026 Doug Trier
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use reqwest::{redirect::Policy, Url};
use std::time::Duration;

const MAX_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug)]
struct DnsFailure;
impl std::fmt::Display for DnsFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DNS resolution failed")
    }
}
impl std::error::Error for DnsFailure {}
/// Name lookups, remembered briefly (owner design, October 21, 2026): a scan
/// asks for the same few hundred sites thousands of times, and every request
/// builds its own client. Answers last five minutes, failures ten seconds.
struct DnsCache {
    entries:
        std::collections::HashMap<String, (std::time::Instant, Option<Vec<std::net::SocketAddr>>)>,
}
const DNS_TTL: Duration = Duration::from_secs(300);
const DNS_FAILURE_TTL: Duration = Duration::from_secs(10);
const DNS_CACHE_LIMIT: usize = 4096;
impl DnsCache {
    /// Some(None) is a remembered failure; None means ask the resolver.
    fn get(
        &mut self,
        name: &str,
        now: std::time::Instant,
    ) -> Option<Option<Vec<std::net::SocketAddr>>> {
        let (at, value) = self.entries.get(name)?;
        let ttl = if value.is_some() {
            DNS_TTL
        } else {
            DNS_FAILURE_TTL
        };
        if now.saturating_duration_since(*at) < ttl {
            Some(value.clone())
        } else {
            self.entries.remove(name);
            None
        }
    }
    fn put(
        &mut self,
        name: &str,
        now: std::time::Instant,
        value: Option<Vec<std::net::SocketAddr>>,
    ) {
        if self.entries.len() >= DNS_CACHE_LIMIT && !self.entries.contains_key(name) {
            self.entries.clear();
        }
        self.entries.insert(name.to_ascii_lowercase(), (now, value));
    }
}
fn dns_cache() -> &'static std::sync::Mutex<DnsCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<DnsCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        std::sync::Mutex::new(DnsCache {
            entries: Default::default(),
        })
    })
}
/// A name's addresses (port 0) through the cache; None when it does not resolve.
async fn resolve_cached(name: &str) -> Option<Vec<std::net::SocketAddr>> {
    let key = name.to_ascii_lowercase();
    let remembered = dns_cache()
        .lock()
        .ok()
        .and_then(|mut cache| cache.get(&key, std::time::Instant::now()));
    if let Some(remembered) = remembered {
        return remembered;
    }
    let looked_up = tokio::net::lookup_host((key.clone(), 0))
        .await
        .map(|found| found.collect::<Vec<_>>())
        .ok()
        .filter(|found| !found.is_empty());
    if let Ok(mut cache) = dns_cache().lock() {
        cache.put(&key, std::time::Instant::now(), looked_up.clone());
    }
    looked_up
}
/// Playback lookups (owner request, October 22, 2026): a channel start reuses
/// a remembered answer instead of asking the resolver again (cold lookups cost
/// 0.3-0.5 s per provider host on the Streamer). A remembered failure is asked
/// again, and only answers are remembered, so a viewer's retry never waits out
/// a failure.
pub(crate) async fn resolve_for_playback(name: &str) -> Option<Vec<std::net::SocketAddr>> {
    let key = name.to_ascii_lowercase();
    let remembered = dns_cache()
        .lock()
        .ok()
        .and_then(|mut cache| cache.get(&key, std::time::Instant::now()))
        .flatten();
    if remembered.is_some() {
        return remembered;
    }
    let looked_up = tokio::net::lookup_host((key.clone(), 0))
        .await
        .map(|found| found.collect::<Vec<_>>())
        .ok()
        .filter(|found| !found.is_empty());
    if let (Some(found), Ok(mut cache)) = (&looked_up, dns_cache().lock()) {
        cache.put(&key, std::time::Instant::now(), Some(found.clone()));
    }
    looked_up
}
struct PlatformResolver;
impl reqwest::dns::Resolve for PlatformResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        // Same OS resolver/address ordering as the default GAI path. No detached
        // application tasks or DNS/IP admission policy are introduced.
        Box::pin(async move {
            let addresses = resolve_cached(name.as_str())
                .await
                .ok_or_else(|| Box::new(DnsFailure) as Box<dyn std::error::Error + Send + Sync>)?;
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// Connect gate (owner design, October 21, 2026): in a triaged scan the
/// server must accept a plain connection within `within`, before any TLS is
/// started. Our own name lookup is not counted against the server. The
/// connection is closed at once; the check then makes its own. Errors:
/// "dns-failure", "connectivity-failure", or "slow-connect" past `within`.
pub(crate) async fn connect_gate(url: &Url, within: Duration) -> Result<(), &'static str> {
    let port = url.port_or_known_default().ok_or("invalid-url")?;
    let host = url.host_str().ok_or("invalid-url")?;
    let literal = host.trim_start_matches('[').trim_end_matches(']');
    let addresses: Vec<std::net::IpAddr> = match literal.parse::<std::net::IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => resolve_cached(host)
            .await
            .ok_or("dns-failure")?
            .into_iter()
            .map(|address| address.ip())
            .collect(),
    };
    let attempt = async {
        for ip in addresses {
            if tokio::net::TcpStream::connect((ip, port)).await.is_ok() {
                return Ok(());
            }
        }
        Err("connectivity-failure")
    };
    tokio::time::timeout(within, attempt)
        .await
        .map_err(|_| "slow-connect")?
}

fn validate(url: &Url, allow_http: bool) -> bool {
    (url.scheme() == "https" || (allow_http && url.scheme() == "http"))
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn category(error: reqwest::Error) -> String {
    error_category(&error).into()
}

pub(crate) fn error_category(error: &reqwest::Error) -> &'static str {
    // Never return reqwest Display: it embeds provider URLs and signed query values.
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        known_cause(error).unwrap_or("connectivity-failure")
    } else if error.is_redirect() {
        "redirect-refused"
    } else {
        "network-failure"
    }
}

fn known_cause(mut error: &(dyn std::error::Error + 'static)) -> Option<&'static str> {
    for _ in 0..16 {
        if error.downcast_ref::<DnsFailure>().is_some() {
            return Some("dns-failure");
        }
        if error.downcast_ref::<rustls::Error>().is_some() {
            return Some("tls-failure");
        }
        #[cfg(windows)]
        if error
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::raw_os_error)
            .is_some_and(|code| matches!(code, 11001..=11004))
        {
            return Some("dns-failure");
        }
        // io::Error::source may skip its custom payload; inspect nested typed
        // payloads directly instead of recognizing their Display strings.
        if let Some(inner) = error
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::get_ref)
        {
            error = inner;
            continue;
        }
        match error.source() {
            Some(next) => error = next,
            None => return None,
        }
    }
    None
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FailureEnvelope {
    category: String,
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after: Option<String>,
}
fn failure(code: &str, phase: &'static str, structured: bool) -> String {
    if !structured {
        return code.into();
    }
    serde_json::to_string(&FailureEnvelope {
        category: code.into(),
        phase,
        status: None,
        retry_after: None,
    })
    .unwrap_or_else(|_| "network-failure".into())
}
fn request_failure(
    error: reqwest::Error,
    observed_phase: &'static str,
    structured: bool,
) -> String {
    let phase = if observed_phase == "body" {
        "body"
    } else if error.is_connect() {
        "connect"
    } else if error.is_redirect() {
        "headers"
    } else {
        "unknown"
    };
    failure(&category(error), phase, structured)
}
fn http_failure(response: &reqwest::Response, structured: bool) -> String {
    if !structured {
        return format!("http-{}", response.status().as_u16());
    }
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 128 && !value.chars().any(char::is_control))
        .map(str::to_owned);
    serde_json::to_string(&FailureEnvelope {
        category: "http".into(),
        phase: "headers",
        status: Some(response.status().as_u16()),
        retry_after,
    })
    .unwrap_or_else(|_| "network-failure".into())
}

pub async fn fetch(raw: &str, allow_http: bool) -> Result<String, String> {
    let mut response = response(raw, allow_http, None).await?;
    if !response.status().is_success() {
        return Err(format!("http-{}", response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err("playlist-too-large".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(category)? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("playlist-too-large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "playlist-invalid-utf8".into())
}

pub(crate) async fn response(
    raw: &str,
    allow_http: bool,
    range: Option<String>,
) -> Result<reqwest::Response, String> {
    response_options(
        raw,
        allow_http,
        range,
        Duration::from_secs(20),
        Duration::from_secs(5),
        Duration::from_secs(5),
        false,
    )
    .await
}

fn build_client(
    allow_http: bool,
    conditional: bool,
    connect: Duration,
    read: Duration,
    total: Duration,
) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .dns_resolver(std::sync::Arc::new(PlatformResolver))
        .user_agent("TMG-TV/0.1")
        .connect_timeout(connect)
        .read_timeout(read)
        .timeout(total)
        .redirect(Policy::custom(move |attempt| {
            if conditional || attempt.previous().len() >= 5 || !validate(attempt.url(), allow_http)
            {
                attempt.error("redirect-policy-refused")
            } else {
                attempt.follow()
            }
        }))
        .build()
}

/// One client for a whole media check (owner request, October 21, 2026): the
/// check's playlist, variant and segment requests to the same site reuse one
/// connection and TLS session instead of a new handshake each. The limits are
/// those of [`response_with_budget`]; the client is dropped with the check, so
/// no idle connection outlives it.
pub(crate) fn check_client(allow_http: bool, budget_ms: u64) -> Result<reqwest::Client, String> {
    if !matches!(budget_ms, 20_000 | 45_000 | 60_000) {
        return Err("invalid-health-budget".into());
    }
    let total = Duration::from_millis(budget_ms);
    build_client(
        allow_http,
        false,
        total.min(Duration::from_secs(10)),
        total,
        total,
    )
    .map_err(|error| request_failure(error, "unknown", false))
}

/// [`response_with_budget`] on a check's own client (see [`check_client`]).
pub(crate) async fn response_with_client(
    client: &reqwest::Client,
    raw: &str,
    allow_http: bool,
    range: Option<String>,
) -> Result<reqwest::Response, String> {
    if raw.len() > 16_384 {
        return Err("invalid-url".into());
    }
    let url = Url::parse(raw).map_err(|_| "invalid-url".to_string())?;
    if !validate(&url, allow_http) {
        return Err("url-policy-refused".into());
    }
    let mut request = client.get(url);
    if let Some(range) = range {
        request = request.header(reqwest::header::RANGE, range);
    }
    request
        .send()
        .await
        .map_err(|error| request_failure(error, "unknown", false))
}

pub(crate) async fn response_with_budget(
    raw: &str,
    allow_http: bool,
    range: Option<String>,
    budget_ms: u64,
) -> Result<reqwest::Response, String> {
    if !matches!(budget_ms, 20_000 | 45_000 | 60_000) {
        return Err("invalid-health-budget".into());
    }
    let total = Duration::from_millis(budget_ms);
    response_options(
        raw,
        allow_http,
        range,
        total,
        total.min(Duration::from_secs(10)),
        total,
        false,
    )
    .await
}

async fn response_options(
    raw: &str,
    allow_http: bool,
    range: Option<String>,
    total: Duration,
    connect: Duration,
    read: Duration,
    structured: bool,
) -> Result<reqwest::Response, String> {
    response_options_headers(
        raw,
        allow_http,
        (range, None),
        total,
        connect,
        read,
        structured,
    )
    .await
}

/// Fixed HTTP cache validators only. Conditional redirects are refused so
/// opaque validators cannot be forwarded to a different resource or origin.
pub(crate) async fn response_conditional(
    raw: &str,
    allow_http: bool,
    etag: Option<&str>,
    last_modified: Option<&str>,
) -> Result<reqwest::Response, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in [
        (reqwest::header::IF_NONE_MATCH, etag),
        (reqwest::header::IF_MODIFIED_SINCE, last_modified),
    ] {
        if let Some(value) = value {
            if value.len() > 1024 || !value.is_ascii() || value.chars().any(char::is_control) {
                return Err("guide-validator-invalid".into());
            }
            headers.insert(
                name,
                reqwest::header::HeaderValue::from_str(value)
                    .map_err(|_| "guide-validator-invalid")?,
            );
        }
    }
    let headers = (!headers.is_empty()).then_some(headers);
    response_options_headers(
        raw,
        allow_http,
        (None, headers),
        Duration::from_secs(20),
        Duration::from_secs(5),
        Duration::from_secs(5),
        false,
    )
    .await
}

/// Public directory metadata only; no credential headers or redirect dispatch.
/// An optional cache validator is the exact ETag previously returned for this URL.
pub(crate) async fn response_directory(
    raw: &str,
    etag: Option<&str>,
) -> Result<reqwest::Response, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/vnd.github+json"),
    );
    if let Some(etag) = etag {
        if etag.len() > 1024 || !etag.is_ascii() || etag.chars().any(char::is_control) {
            return Err("directory-validator-invalid".into());
        }
        headers.insert(
            reqwest::header::IF_NONE_MATCH,
            reqwest::header::HeaderValue::from_str(etag)
                .map_err(|_| "directory-validator-invalid")?,
        );
    }
    response_options_headers(
        raw,
        false,
        (None, Some(headers)),
        Duration::from_secs(20),
        Duration::from_secs(5),
        Duration::from_secs(5),
        false,
    )
    .await
}

async fn response_options_headers(
    raw: &str,
    allow_http: bool,
    request_headers: (Option<String>, Option<reqwest::header::HeaderMap>),
    total: Duration,
    connect: Duration,
    read: Duration,
    structured: bool,
) -> Result<reqwest::Response, String> {
    let (range, headers) = request_headers;
    let conditional = headers.is_some();
    if raw.len() > 16_384 {
        return Err(failure("invalid-url", "unknown", structured));
    }
    let url = Url::parse(raw).map_err(|_| failure("invalid-url", "unknown", structured))?;
    if !validate(&url, allow_http) {
        return Err(failure("url-policy-refused", "unknown", structured));
    }
    let client = build_client(allow_http, conditional, connect, read, total)
        .map_err(|error| request_failure(error, "unknown", structured))?;
    let mut request = client.get(url);
    if let Some(range) = range {
        request = request.header(reqwest::header::RANGE, range);
    }
    if let Some(headers) = headers {
        request = request.headers(headers);
    }
    let response = request
        .send()
        .await
        .map_err(|error| request_failure(error, "unknown", structured))?;
    Ok(response)
}

#[derive(serde::Serialize)]
pub struct SourceInspection {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub mime: String,
}

fn catalog_prefix(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_start_matches('\u{feff}').trim_start();
    text.starts_with("#EXTM3U") || text.starts_with("#EXTINF:")
}

fn media_prefix(bytes: &[u8], mime: &str) -> bool {
    // Error documents must not become media merely because a server labels them video/audio.
    // Reject their opening characters as well as full tags so split network chunks remain inert.
    let text = String::from_utf8_lossy(bytes);
    let prefix = text.trim_start_matches('\u{feff}').trim_start();
    if prefix.is_empty()
        || (bytes.len() < 3 && b"\xef\xbb\xbf".starts_with(bytes))
        || prefix.starts_with(['<', '{', '['])
    {
        return false;
    }
    let mime = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let magic = (bytes.len() >= 8 && &bytes[4..8] == b"ftyp")
        || bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
        || bytes.starts_with(b"OggS")
        || (bytes.len() >= 12
            && bytes.starts_with(b"RIFF")
            && (&bytes[8..12] == b"WAVE" || &bytes[8..12] == b"AVI "))
        || (bytes.len() >= 377 && bytes[0] == 0x47 && bytes[188] == 0x47 && bytes[376] == 0x47)
        || bytes.starts_with(b"ID3")
        || bytes.starts_with(b"fLaC");
    magic || mime.starts_with("video/") || mime.starts_with("audio/") || mime == "application/ogg"
}

#[cfg(test)]
mod playback_dns_tests {
    use super::*;
    #[tokio::test]
    async fn playback_reuses_answers_and_does_not_remember_failures() {
        let remembered: std::net::SocketAddr = "203.0.113.7:0".parse().unwrap();
        dns_cache().lock().unwrap().put(
            "cached.genx-fixture.invalid",
            std::time::Instant::now(),
            Some(vec![remembered]),
        );
        // A name that cannot resolve still answers: the remembered address.
        assert_eq!(
            resolve_for_playback("Cached.GenX-Fixture.invalid").await,
            Some(vec![remembered])
        );
        // A failed playback lookup leaves nothing behind for the next start.
        assert_eq!(
            resolve_for_playback("never.genx-fixture.invalid").await,
            None
        );
        assert!(dns_cache()
            .lock()
            .unwrap()
            .get("never.genx-fixture.invalid", std::time::Instant::now())
            .is_none());
    }
}
#[cfg(test)]
pub async fn inspect(raw: &str, allow_http: bool) -> Result<SourceInspection, String> {
    inspect_mode(raw, allow_http, false).await
}
pub async fn inspect_playback(raw: &str, allow_http: bool) -> Result<SourceInspection, String> {
    inspect_mode(raw, allow_http, true).await
}
async fn inspect_mode(
    raw: &str,
    allow_http: bool,
    structured: bool,
) -> Result<SourceInspection, String> {
    let work = async {
        let response = response_options(
            raw,
            allow_http,
            None,
            Duration::from_secs(20),
            Duration::from_secs(5),
            Duration::from_secs(5),
            structured,
        )
        .await?;
        if !response.status().is_success() {
            return Err(http_failure(&response, structured));
        }
        inspect_response_mode(response, structured).await
    };
    tokio::time::timeout(Duration::from_secs(20), work)
        .await
        .map_err(|_| failure("timeout", "unknown", structured))?
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthInspection {
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
}

pub async fn health_inspect(
    raw: &str,
    allow_http: bool,
    budget_ms: u64,
) -> Result<HealthInspection, String> {
    if !matches!(budget_ms, 20_000 | 45_000 | 60_000) {
        return Err("invalid-health-budget".into());
    }
    let total = Duration::from_millis(budget_ms);
    health_from_response(
        response_with_budget(raw, allow_http, None, budget_ms),
        total,
    )
    .await
}
async fn health_from_response(
    response: impl std::future::Future<Output = Result<reqwest::Response, String>>,
    total: Duration,
) -> Result<HealthInspection, String> {
    let work = async {
        let response = response.await?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 128)
            .map(str::to_owned);
        if !response.status().is_success() {
            return Ok(HealthInspection {
                status,
                retry_after,
                kind: None,
                mime: None,
            });
        }
        let inspected = inspect_response(response).await?;
        let mime = if inspected.mime.len() <= 128 {
            Some(inspected.mime)
        } else {
            None
        };
        Ok(HealthInspection {
            status,
            retry_after,
            kind: Some(inspected.kind),
            mime,
        })
    };
    tokio::time::timeout(total, work)
        .await
        .map_err(|_| "timeout".to_string())?
}
async fn inspect_response(response: reqwest::Response) -> Result<SourceInspection, String> {
    inspect_response_mode(response, false).await
}
async fn inspect_response_mode(
    mut response: reqwest::Response,
    structured: bool,
) -> Result<SourceInspection, String> {
    // Body size hints can shrink as chunks are consumed; retain the initial declaration for catalog admission.
    let declared_length = response.content_length();
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let mut bytes = Vec::new();
    // Observe at most 8KiB before choosing whether to download a text catalog.
    // Native chunks can be larger; keep only the inspected prefix for non-catalog data.
    loop {
        let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| request_failure(error, "body", structured))?
        else {
            break;
        };
        if !catalog_prefix(&bytes) {
            let needed = 8192usize.saturating_sub(bytes.len());
            let prefix = &chunk[..chunk.len().min(needed)];
            let mut candidate = bytes.clone();
            candidate.extend_from_slice(prefix);
            if catalog_prefix(&candidate) {
                bytes.extend_from_slice(&chunk);
            } else {
                bytes = candidate;
                if bytes.len() >= 8192 || media_prefix(&bytes, &mime) {
                    let kind = if media_prefix(&bytes, &mime) {
                        "media"
                    } else {
                        "unsupported"
                    };
                    return Ok(SourceInspection {
                        kind,
                        text: None,
                        mime,
                    });
                }
            }
        } else {
            if bytes.len() + chunk.len() > MAX_BYTES {
                return Err(failure("playlist-too-large", "body", structured));
            }
            bytes.extend_from_slice(&chunk);
        }
        if catalog_prefix(&bytes)
            && (bytes.len() > MAX_BYTES
                || declared_length.is_some_and(|size| size > MAX_BYTES as u64))
        {
            return Err(failure("playlist-too-large", "body", structured));
        }
    }
    if catalog_prefix(&bytes) {
        let text = String::from_utf8(bytes)
            .map_err(|_| failure("playlist-invalid-utf8", "body", structured))?;
        let kind = if text
            .lines()
            .any(|line| line.trim_start().starts_with("#EXT-X-"))
        {
            "hls"
        } else {
            "catalog"
        };
        Ok(SourceInspection {
            kind,
            text: Some(text),
            mime,
        })
    } else {
        Ok(SourceInspection {
            kind: if media_prefix(&bytes, &mime) {
                "media"
            } else {
                "unsupported"
            },
            text: None,
            mime,
        })
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaTiming {
    pub version: u8,
    pub first_byte_ms: f64,
    pub complete_ms: f64,
}

#[derive(serde::Serialize)]
pub struct MediaPayload {
    pub status: u16,
    pub url: String,
    pub headers: std::collections::HashMap<String, String>,
    pub data: Vec<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<MediaTiming>,
}

/// A media response as one binary message for the page: a 4-byte
/// little-endian length, that many bytes of JSON metadata (status, url,
/// headers, timing), then the body. Sending the body as a JSON number array
/// cost the TV's page thread about 10% of its time while playing (Sansui,
/// October 19, 2026), starving the picture.
pub fn frame_media(payload: &MediaPayload) -> Result<Vec<u8>, String> {
    #[derive(serde::Serialize)]
    struct Meta<'a> {
        status: u16,
        url: &'a str,
        headers: &'a std::collections::HashMap<String, String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timing: Option<&'a MediaTiming>,
    }
    let meta = serde_json::to_vec(&Meta {
        status: payload.status,
        url: &payload.url,
        headers: &payload.headers,
        timing: payload.timing.as_ref(),
    })
    .map_err(|_| "media-frame".to_string())?;
    let length = u32::try_from(meta.len()).map_err(|_| "media-frame".to_string())?;
    let mut framed = Vec::with_capacity(4 + meta.len() + payload.data.len());
    framed.extend_from_slice(&length.to_le_bytes());
    framed.extend_from_slice(&meta);
    framed.extend_from_slice(&payload.data);
    Ok(framed)
}

pub async fn media(
    raw: &str,
    allow_http: bool,
    range: Option<String>,
) -> Result<MediaPayload, String> {
    let started = std::time::Instant::now();
    if range
        .as_ref()
        .is_some_and(|value| !crate::relay::validate_range(value))
    {
        return Err(failure("range-refused", "unknown", true));
    }
    let work = async {
        let mut response = response_options(
            raw,
            allow_http,
            range,
            Duration::from_secs(20),
            Duration::from_secs(5),
            Duration::from_secs(5),
            true,
        )
        .await?;
        let headers_ms = started.elapsed().as_secs_f64() * 1000.0;
        let status = response.status().as_u16();
        let url = response.url().to_string();
        let mut headers = std::collections::HashMap::new();
        for name in ["content-type", "content-range", "retry-after"] {
            if let Some(value) = response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
            {
                if value.len() <= 256 {
                    headers.insert(name.to_string(), value.to_string());
                }
            }
        }
        let mut data = Vec::new();
        let mut first_byte_ms = None;
        if response.status().is_success() {
            const MEDIA_LIMIT: usize = 8 * 1024 * 1024;
            if response
                .content_length()
                .is_some_and(|size| size > MEDIA_LIMIT as u64)
            {
                return Err(failure("media-too-large", "headers", true));
            }
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| request_failure(error, "body", true))?
            {
                if data.len() + chunk.len() > MEDIA_LIMIT {
                    return Err(failure("media-too-large", "body", true));
                }
                if !chunk.is_empty() && first_byte_ms.is_none() {
                    first_byte_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
                }
                data.extend_from_slice(&chunk);
            }
        }
        let complete_ms = started.elapsed().as_secs_f64() * 1000.0;
        Ok(MediaPayload {
            status,
            url,
            headers,
            data,
            // Empty success bodies and deliberately unread error bodies have no
            // observed body byte. Use header arrival as an explicit fallback;
            // these timestamps exclude IPC serialization/dispatch overhead.
            timing: Some(MediaTiming {
                version: 1,
                first_byte_ms: first_byte_ms.unwrap_or(headers_ms),
                complete_ms,
            }),
        })
    };
    tokio::time::timeout(Duration::from_secs(20), work)
        .await
        .map_err(|_| failure("timeout", "unknown", true))?
}

#[cfg(test)]
#[path = "network_tests.rs"]
mod tests;
