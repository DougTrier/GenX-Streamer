//! Resource availability preflight only: no decoder or playback-success claim.
use reqwest::Url;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};
const MANIFEST: usize = 1024 * 1024;
const SAMPLE: usize = 128 * 1024;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Inspection {
    pub status: &'static str,
    pub reason_code: &'static str,
    pub checked_resources: usize,
    pub request_id: String,
    /// Additional resource-fetch API calls, not underlying redirect/wire calls.
    #[serde(skip_serializing_if = "is_zero")]
    pub header_retry_count: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header_retry_reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<String>,
}
fn is_zero(value: &u8) -> bool {
    *value == 0
}
#[derive(Debug)]
struct Refusal(&'static str, Option<u16>);
type Result<T> = std::result::Result<T, Refusal>;
fn transport_reason(code: &str) -> &'static str {
    match code {
        "timeout" => "timeout",
        "dns-failure" => "dns-failure",
        "tls-failure" => "tls-failure",
        "connectivity-failure" => "connectivity-failure",
        "redirect-refused" => "redirect-refused",
        "url-policy-refused" => "url-policy-refused",
        "invalid-url" => "invalid-url",
        _ => "network-failure",
    }
}
fn body_refusal(error: reqwest::Error, status: u16) -> Refusal {
    Refusal(crate::network::error_category(&error), Some(status))
}
#[derive(Clone)]
struct Resource {
    url: Url,
    range: Option<(u64, u64)>,
}
#[derive(Clone)]
struct InitMap {
    resource: Resource,
    key: Option<Url>,
}
#[derive(Clone)]
struct Segment {
    resource: Resource,
    map: Option<InitMap>,
    key: Option<Url>,
}
struct Manifest {
    segment: Option<Segment>,
    variant: Option<Url>,
    audio: Option<Url>,
}
struct Probe {
    count: usize,
    budget: u64,
    allow_http: bool,
    visited: HashSet<String>,
    retry_after: Option<String>,
    header_retry_claimed: bool,
    header_retry_count: u8,
    /// Triage: the first answer must arrive by then (None once answered or untriaged).
    first_response: Option<tokio::time::Instant>,
    /// The check's own client: its requests reuse connections (None in fixtures
    /// that build a probe by hand; a client is then made per request).
    client: Option<reqwest::Client>,
}
fn attrs(s: &str) -> Result<HashMap<String, String>> {
    let mut out = HashMap::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut parts = Vec::new();
    for c in s.chars() {
        if c == '"' {
            quoted = !quoted;
        }
        if c == ',' && !quoted {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
    }
    if quoted {
        return Err(Refusal("manifest-invalid", None));
    }
    parts.push(current);
    for part in parts {
        let (k, v) = part
            .split_once('=')
            .ok_or(Refusal("manifest-invalid", None))?;
        let v = v.trim();
        if out
            .insert(k.trim().to_owned(), v.trim_matches('"').to_owned())
            .is_some()
        {
            return Err(Refusal("manifest-invalid", None));
        }
    }
    Ok(out)
}
fn resolve(base: &Url, s: &str) -> Result<Url> {
    if s.is_empty() || s.len() > 16_384 {
        return Err(Refusal("resource-url-invalid", None));
    }
    base.join(s)
        .map_err(|_| Refusal("resource-url-invalid", None))
}
fn byte_range(raw: &str, previous: Option<u64>) -> Result<(u64, u64)> {
    let mut p = raw.split('@');
    let length = p
        .next()
        .and_then(|n| n.parse::<u64>().ok())
        .filter(|n| *n > 0)
        .ok_or(Refusal("range-invalid", None))?;
    let offset = match p.next() {
        Some(n) => n.parse().map_err(|_| Refusal("range-invalid", None))?,
        None => previous.ok_or(Refusal("range-invalid", None))?,
    };
    if p.next().is_some() {
        return Err(Refusal("range-invalid", None));
    }
    Ok((
        offset,
        offset
            .checked_add(length - 1)
            .ok_or(Refusal("range-invalid", None))?,
    ))
}
fn parse(base: &Url, text: &str) -> Result<Manifest> {
    if !text
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("#EXTM3U")
    {
        return Err(Refusal("manifest-invalid", None));
    }
    let lines: Vec<&str> = text
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .collect();
    let mut variants = Vec::new();
    let mut audio_groups = HashMap::new();
    let mut pending_variant = None;
    let mut extinf = false;
    let mut range = None;
    let mut previous: Option<(String, u64)> = None;
    let mut map = None;
    let mut key = None;
    let mut segment = None;
    for line in lines {
        if let Some(s) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending_variant = Some(attrs(s)?);
            continue;
        }
        if let Some(s) = line.strip_prefix("#EXT-X-MEDIA:") {
            let a = attrs(s)?;
            if a.get("TYPE").map(String::as_str) == Some("AUDIO") {
                if let Some(group) = a.get("GROUP-ID") {
                    let uri = a.get("URI").map(|uri| resolve(base, uri)).transpose()?;
                    if a.get("DEFAULT").map(String::as_str) == Some("YES") {
                        audio_groups.insert(group.clone(), uri);
                    } else {
                        audio_groups.entry(group.clone()).or_insert(uri);
                    }
                }
            }
            continue;
        }
        if let Some(s) = line.strip_prefix("#EXT-X-KEY:") {
            let a = attrs(s)?;
            match a.get("METHOD").map(String::as_str) {
                Some("NONE") => key = None,
                Some("AES-128") => {
                    if a.get("KEYFORMAT").is_some_and(|v| v != "identity") {
                        return Err(Refusal("drm-unverified", None));
                    }
                    key = Some(resolve(
                        base,
                        a.get("URI").ok_or(Refusal("manifest-invalid", None))?,
                    )?);
                }
                _ => return Err(Refusal("drm-unverified", None)),
            }
            continue;
        }
        if let Some(s) = line.strip_prefix("#EXT-X-MAP:") {
            let a = attrs(s)?;
            map = Some(InitMap {
                key: key.clone(),
                resource: Resource {
                    url: resolve(base, a.get("URI").ok_or(Refusal("manifest-invalid", None))?)?,
                    range: a
                        .get("BYTERANGE")
                        .map(|r| byte_range(r, None))
                        .transpose()?,
                },
            });
            continue;
        }
        if let Some(s) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            range = Some(s.to_owned());
            continue;
        }
        if let Some(s) = line.strip_prefix("#EXTINF:") {
            let duration = s
                .split(',')
                .next()
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite() && *v > 0.0)
                .ok_or(Refusal("manifest-invalid", None))?;
            let _ = duration;
            extinf = true;
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let url = resolve(base, line)?;
        if let Some(a) = pending_variant.take() {
            // A quality labelled with H.264/AAC is checked first. One with no
            // CODECS label (allowed by HLS, and common: 174 of 1,095 Sansui
            // scan candidates, October 21, 2026) is checked too; its media
            // bytes must still be recognized below. Other labels are refused.
            let codec = a.get("CODECS").map(String::as_str).unwrap_or("").trim();
            let labelled = !codec.is_empty();
            let supported = !labelled
                || codec.split(',').all(|c| {
                    let c = c.trim();
                    c.starts_with("avc1.") || c.starts_with("avc3.") || c.starts_with("mp4a.")
                });
            if supported {
                let bandwidth = a
                    .get("BANDWIDTH")
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(u64::MAX);
                variants.push((!labelled, bandwidth, url, a.get("AUDIO").cloned()));
            }
            continue;
        }
        if !extinf {
            return Err(Refusal("manifest-invalid", None));
        }
        extinf = false;
        let r = range
            .take()
            .map(|r| {
                byte_range(
                    &r,
                    previous
                        .as_ref()
                        .filter(|(u, _)| u == url.as_str())
                        .map(|(_, end)| *end),
                )
            })
            .transpose()?;
        previous = r
            .and_then(|(_, end)| end.checked_add(1))
            .map(|end| (url.to_string(), end));
        segment = Some(Segment {
            resource: Resource { url, range: r },
            map: map.clone(),
            key: key.clone(),
        });
    }
    if pending_variant.is_some() {
        return Err(Refusal("manifest-invalid", None));
    }
    variants.sort_by_key(|v| (v.0, v.1));
    let (variant, audio) = match variants.into_iter().next() {
        Some((_, _, v, g)) => {
            let audio = match g {
                Some(g) => audio_groups
                    .get(&g)
                    .cloned()
                    .ok_or(Refusal("external-audio-unverified", None))?,
                None => None,
            };
            (Some(v), audio)
        }
        None => (None, None),
    };
    if variant.is_none() && segment.is_none() {
        return Err(Refusal("format-unverified", None));
    }
    Ok(Manifest {
        segment,
        variant,
        audio,
    })
}
fn clear_media(bytes: &[u8]) -> bool {
    if bytes.len() >= 376 && bytes[0] == 0x47 && bytes[188] == 0x47 {
        return true;
    }
    if bytes.len() >= 8
        && [b"ftyp", b"styp", b"moof", b"mdat"]
            .iter()
            .any(|k| &bytes[4..8] == *k)
    {
        return true;
    }
    bytes.len() >= 4 && bytes[0] == 0xff && (bytes[1] & 0xf6) == 0xf0 // ADTS AAC resource only
}
fn document(bytes: &[u8]) -> bool {
    if std::str::from_utf8(bytes).is_err() {
        return false;
    }
    let b = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let b = b
        .iter()
        .copied()
        .skip_while(u8::is_ascii_whitespace)
        .collect::<Vec<_>>();
    matches!(b.first(), Some(b'<' | b'{' | b'['))
}
impl Probe {
    async fn read(
        &mut self,
        resource: &Resource,
        limit: usize,
        complete: bool,
    ) -> Result<(Url, Vec<u8>)> {
        if self.count >= 8 {
            return Err(Refusal("request-limit-unverified", None));
        }
        let range = resource
            .range
            .map(|(s, e)| format!("bytes={s}-{}", e.min(s.saturating_add(limit as u64 - 1))));
        let mut retry_dispatch = false;
        // A failure seen before the triage deadline is the answer, not slowness.
        let mut failed: Option<&'static str> = None;
        let mut response = loop {
            self.count += 1;
            if retry_dispatch {
                self.header_retry_count = 1;
            }
            let request = async {
                match &self.client {
                    Some(client) => {
                        crate::network::response_with_client(
                            client,
                            resource.url.as_str(),
                            self.allow_http,
                            range.clone(),
                        )
                        .await
                    }
                    None => {
                        crate::network::response_with_budget(
                            resource.url.as_str(),
                            self.allow_http,
                            range.clone(),
                            self.budget,
                        )
                        .await
                    }
                }
            };
            // Triage: the first answer must come by the deadline; once one has,
            // the rest of the check keeps the ordinary limits.
            let answered = match self.first_response {
                Some(deadline) => match tokio::time::timeout_at(deadline, request).await {
                    Ok(result) => result,
                    Err(_) => return Err(Refusal(failed.unwrap_or("slow-first-response"), None)),
                },
                None => request.await,
            };
            match answered {
                Ok(response) => {
                    self.first_response = None;
                    break response;
                }
                Err(code) if self.claim_header_retry(&code) => {
                    failed = Some(transport_reason(&code));
                    // Owned by inspect's original whole deadline and cancellation future.
                    // No Response/body/HTTP failure reaches this exact-error branch.
                    self.wait_header_retry().await;
                    retry_dispatch = true;
                }
                Err(code) => return Err(Refusal(transport_reason(&code), None)),
            }
        };
        let status = response.status().as_u16();
        if !response.status().is_success() {
            self.retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .filter(|v| v.len() <= 128 && !v.chars().any(char::is_control))
                .map(str::to_owned);
            return Err(Refusal("resource-http-unavailable", Some(status)));
        }
        if let Some(range) = range {
            if status != 206 {
                return Err(Refusal("range-unavailable", Some(status)));
            }
            let expected = range.trim_start_matches("bytes=");
            let actual = response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("bytes "))
                .and_then(|v| v.split_once('/'))
                .map(|v| v.0);
            if actual != Some(expected) {
                return Err(Refusal("range-unavailable", Some(status)));
            }
        }
        if complete
            && limit != MANIFEST
            && response.content_length().is_some_and(|n| n > limit as u64)
        {
            return Err(Refusal("resource-too-large", Some(status)));
        }
        let final_url = response.url().clone();
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| body_refusal(error, status))?
        {
            if complete && chunk.len() > limit.saturating_sub(bytes.len()) {
                if limit == MANIFEST && clear_media(&chunk[..chunk.len().min(SAMPLE)]) {
                    bytes.extend_from_slice(&chunk[..chunk.len().min(SAMPLE)]);
                    break;
                }
                return Err(Refusal("resource-too-large", Some(status)));
            }
            let amount = chunk.len().min(limit.saturating_sub(bytes.len()));
            bytes.extend_from_slice(&chunk[..amount]);
            if limit == MANIFEST && clear_media(&bytes) {
                bytes.truncate(SAMPLE);
                break;
            }
            if !complete && bytes.len() >= limit {
                break;
            }
        }
        if bytes.is_empty() {
            return Err(Refusal("resource-empty", Some(status)));
        }
        if !(limit == 16 && complete) && document(&bytes) {
            return Err(Refusal("resource-error-document", Some(status)));
        }
        Ok((final_url, bytes))
    }
    fn claim_header_retry(&mut self, original_code: &str) -> bool {
        if original_code != "network-failure" || self.header_retry_claimed || self.count >= 8 {
            return false;
        }
        self.header_retry_claimed = true;
        true
    }
    async fn wait_header_retry(&mut self) {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    async fn segment(&mut self, segment: Segment) -> Result<bool> {
        let encrypted = segment.key.is_some();
        let map_encrypted = segment.map.as_ref().is_some_and(|m| m.key.is_some());
        let mut keys = Vec::new();
        if let Some(key) = segment.key {
            keys.push(key);
        }
        if let Some(key) = segment.map.as_ref().and_then(|m| m.key.clone()) {
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
        for key in keys {
            let (_, bytes) = self
                .read(
                    &Resource {
                        url: key,
                        range: None,
                    },
                    16,
                    true,
                )
                .await?;
            if bytes.len() != 16 {
                return Err(Refusal("key-invalid", None));
            }
        }
        if let Some(map) = segment.map {
            let (_, bytes) = self.read(&map.resource, SAMPLE, false).await?;
            if !map_encrypted && !clear_media(&bytes) {
                return Err(Refusal("init-map-unverified", None));
            }
        }
        let (_, bytes) = self.read(&segment.resource, SAMPLE, false).await?;
        if !encrypted && !clear_media(&bytes) {
            return Err(Refusal("media-format-unverified", None));
        }
        Ok(encrypted || map_encrypted)
    }
    async fn hls(&mut self, initial: Url) -> Result<bool> {
        let mut url = initial;
        let mut audio = None;
        for _ in 0..=3 {
            if !self.visited.insert(url.to_string()) {
                return Err(Refusal("manifest-cycle-unverified", None));
            }
            let (final_url, bytes) = self
                .read(&Resource { url, range: None }, MANIFEST, true)
                .await?;
            if !bytes.starts_with(b"#EXTM3U") && !bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
                if clear_media(&bytes) && audio.is_none() {
                    return Ok(false);
                }
                return Err(Refusal("media-format-unverified", None));
            }
            let text =
                std::str::from_utf8(&bytes).map_err(|_| Refusal("manifest-invalid", None))?;
            let manifest = parse(&final_url, text)?;
            if let Some(a) = manifest.audio {
                audio = Some(a);
            }
            if let Some(v) = manifest.variant {
                url = v;
                continue;
            }
            let mut encrypted = self
                .segment(manifest.segment.ok_or(Refusal("format-unverified", None))?)
                .await?;
            if let Some(a) = audio {
                let (final_url, bytes) = self
                    .read(
                        &Resource {
                            url: a,
                            range: None,
                        },
                        MANIFEST,
                        true,
                    )
                    .await?;
                let text = std::str::from_utf8(&bytes)
                    .map_err(|_| Refusal("external-audio-unverified", None))?;
                let audio = parse(&final_url, text)?;
                if audio.variant.is_some() {
                    return Err(Refusal("external-audio-unverified", None));
                }
                encrypted |= self
                    .segment(
                        audio
                            .segment
                            .ok_or(Refusal("external-audio-unverified", None))?,
                    )
                    .await?;
            }
            return Ok(encrypted);
        }
        Err(Refusal("manifest-depth-unverified", None))
    }
}
pub(crate) async fn inspect(
    url: &str,
    allow_http: bool,
    request_id: String,
    budget_ms: u64,
) -> std::result::Result<Inspection, String> {
    inspect_triaged(url, allow_http, request_id, budget_ms, None).await
}
/// Scan triage (owner design, October 21, 2026): with `first_response_ms`, the
/// check's first request must answer within that long of the check starting,
/// or the check ends as "slow-first-response" (the stream goes to the Slow
/// list, checked later in the background with the whole budget). Later
/// requests keep the ordinary limits.
/// How long a triaged scan's server has to accept a plain connection.
pub(crate) const CONNECT_GATE_MS: u64 = 1_000;
pub(crate) async fn inspect_triaged(
    url: &str,
    allow_http: bool,
    request_id: String,
    budget_ms: u64,
    first_response_ms: Option<u64>,
) -> std::result::Result<Inspection, String> {
    if !matches!(budget_ms, 20_000 | 45_000 | 60_000)
        || first_response_ms.is_some_and(|ms| !(1_000..=budget_ms).contains(&ms))
    {
        return Err("invalid-health-budget".into());
    }
    let url = Url::parse(url).map_err(|_| "invalid-url")?;
    let mut probe = Probe {
        first_response: first_response_ms
            .map(|ms| tokio::time::Instant::now() + Duration::from_millis(ms)),
        count: 0,
        budget: budget_ms,
        allow_http,
        visited: HashSet::new(),
        retry_after: None,
        header_retry_claimed: false,
        header_retry_count: 0,
        client: Some(crate::network::check_client(allow_http, budget_ms)?),
    };
    // Triaged scans first ask whether the server answers at all: a plain
    // connection within a second, before any TLS (owner design). One that does
    // not goes to the Slow list like a late first answer.
    let gate = match probe.first_response {
        Some(deadline) => match tokio::time::timeout_at(
            deadline,
            crate::network::connect_gate(&url, Duration::from_millis(CONNECT_GATE_MS)),
        )
        .await
        {
            Ok(Ok(())) => Ok(()),
            Ok(Err("slow-connect")) | Err(_) => Err(Refusal("slow-first-response", None)),
            Ok(Err(code)) => Err(Refusal(code, None)),
        },
        None => Ok(()),
    };
    let result = match gate {
        Ok(()) => tokio::time::timeout(Duration::from_millis(budget_ms), probe.hls(url))
            .await
            .unwrap_or(Err(Refusal("timeout", None))),
        Err(refusal) => Err(refusal),
    };
    let (status, reason_code, http_status) = match result {
        Ok(encrypted) => (
            "resources-responded",
            if encrypted {
                "encrypted-resources-responded"
            } else {
                "media-resources-responded"
            },
            None,
        ),
        Err(Refusal(reason, status)) => {
            let unverified = reason.ends_with("unverified") || reason == "manifest-invalid";
            (
                if unverified {
                    "unverified"
                } else {
                    "unavailable"
                },
                reason,
                status,
            )
        }
    };
    Ok(Inspection {
        status,
        reason_code,
        http_status,
        checked_resources: probe.count,
        request_id,
        retry_after: probe.retry_after,
        header_retry_count: probe.header_retry_count,
        header_retry_reason: (probe.header_retry_count == 1).then_some("network-failure"),
    })
}
#[cfg(test)]
#[path = "network_media_probe_tests.rs"]
mod tests;
