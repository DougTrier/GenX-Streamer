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

//! Public-only, DNS-pinned bounded upstream fetch. This is NOT the local import API.
use crate::sharing_policy::public_upstream;
use reqwest::{
    header::{CONTENT_RANGE, CONTENT_TYPE, LOCATION, RANGE, RETRY_AFTER},
    redirect::Policy,
    Url,
};
use std::{net::SocketAddr, time::Duration};

pub struct Reply {
    pub body: Vec<u8>,
    pub content_type: String,
    pub content_range: Option<String>,
    pub status: u16,
    pub retry_after: Option<String>,
    pub final_url: Url,
}

pub fn validate_url(url: &Url) -> Result<(), &'static str> {
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("upstream-url-refused");
    }
    Ok(())
}

pub fn validate_range(value: &str) -> bool {
    let Some(spec) = value.strip_prefix("bytes=") else {
        return false;
    };
    if spec.len() > 48 || spec.contains(',') {
        return false;
    }
    let Some((start, end)) = spec.split_once('-') else {
        return false;
    };
    if start.is_empty() {
        return end.parse::<u64>().is_ok_and(|n| n > 0);
    }
    let Ok(start) = start.parse::<u64>() else {
        return false;
    };
    end.is_empty() || end.parse::<u64>().is_ok_and(|end| end >= start)
}

const BODY_LIMIT: usize = 32 * 1024 * 1024;
const MANIFEST_LIMIT: usize = 2 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const TRANSFER_CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyKind {
    Media,
    Manifest,
}

/// One response owner, pulled by the downstream writer. Dropping it cancels the body.
/// The transport may own a larger underlying chunk; this is not an RSS guarantee.
pub struct OpenedUpstream {
    pub content_type: String,
    pub content_range: Option<String>,
    pub status: u16,
    pub retry_after: Option<String>,
    pub final_url: Url,
    pub body_kind: BodyKind,
    pub(crate) redirects_used: usize,
    response: Option<reqwest::Response>,
    prefix: bytes::Bytes,
    pending: bytes::Bytes,
    received: usize,
    deadline: tokio::time::Instant,
}

fn header(response: &reqwest::Response, name: reqwest::header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() <= 256)
        .map(str::to_string)
}

fn manifest_mime(value: &str) -> bool {
    matches!(
        value
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "application/vnd.apple.mpegurl"
            | "application/x-mpegurl"
            | "audio/mpegurl"
            | "audio/x-mpegurl"
    )
}

impl OpenedUpstream {
    #[cfg(test)]
    pub(crate) async fn from_test_response(
        response: reqwest::Response,
    ) -> Result<Self, &'static str> {
        Self::from_test_response_with_deadline(
            response,
            tokio::time::Instant::now() + Duration::from_secs(20),
        )
        .await
    }
    #[cfg(test)]
    pub(crate) async fn from_test_response_with_deadline(
        response: reqwest::Response,
        absolute_deadline: tokio::time::Instant,
    ) -> Result<Self, &'static str> {
        let (deadline, _) = remaining_policy_budget(absolute_deadline, 0)?;
        let url = response.url().clone();
        tokio::time::timeout_at(deadline, Self::from_response(response, url, deadline))
            .await
            .map_err(|_| "upstream-timeout")?
    }
    async fn from_response(
        response: reqwest::Response,
        final_url: Url,
        deadline: tokio::time::Instant,
    ) -> Result<Self, &'static str> {
        let status = response.status().as_u16();
        if response.status().is_success()
            && response
                .content_length()
                .is_some_and(|n| n > BODY_LIMIT as u64)
        {
            return Err("upstream-body-too-large");
        }
        let content_type =
            header(&response, CONTENT_TYPE).unwrap_or_else(|| "application/octet-stream".into());
        let content_range = header(&response, CONTENT_RANGE);
        let retry_after = header(&response, RETRY_AFTER);
        let success = response.status().is_success();
        let mut opened = Self {
            body_kind: if manifest_mime(&content_type) {
                BodyKind::Manifest
            } else {
                BodyKind::Media
            },
            redirects_used: 0,
            content_type,
            content_range,
            status,
            retry_after,
            final_url,
            response: success.then_some(response),
            prefix: bytes::Bytes::new(),
            pending: bytes::Bytes::new(),
            received: 0,
            deadline,
        };
        if success {
            // Ten bytes cover the optional UTF-8 BOM plus exact #EXTM3U marker.
            let mut prefix = Vec::with_capacity(10);
            while prefix.len() < 10 {
                if opened.pending.is_empty() {
                    let Some(chunk) = opened.pull().await? else {
                        break;
                    };
                    opened.pending = chunk;
                }
                let count = (10 - prefix.len()).min(opened.pending.len());
                prefix.extend_from_slice(&opened.pending.split_to(count));
            }
            let text = prefix.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&prefix);
            if text.starts_with(b"#EXTM3U") {
                opened.body_kind = BodyKind::Manifest;
            }
            opened.prefix = prefix.into();
        }
        Ok(opened)
    }

    fn cancel_body(&mut self) {
        self.response = None;
        self.prefix = bytes::Bytes::new();
        self.pending = bytes::Bytes::new();
    }

    async fn pull(&mut self) -> Result<Option<bytes::Bytes>, &'static str> {
        let Some(response) = self.response.as_mut() else {
            return Ok(None);
        };
        let chunk = match tokio::time::timeout_at(self.deadline, response.chunk()).await {
            Err(_) => {
                self.cancel_body();
                return Err("upstream-timeout");
            }
            Ok(Err(_)) => {
                self.cancel_body();
                return Err("upstream-body-failed");
            }
            Ok(Ok(chunk)) => chunk,
        };
        if let Some(chunk) = &chunk {
            if chunk.len() > BODY_LIMIT.saturating_sub(self.received) {
                self.cancel_body();
                return Err("upstream-body-too-large");
            }
            self.received += chunk.len();
        } else {
            self.response = None;
        }
        Ok(chunk)
    }

    /// No upstream read occurs until the consumer asks for another bounded slice.
    pub async fn next_chunk(&mut self) -> Result<Option<bytes::Bytes>, &'static str> {
        if tokio::time::Instant::now() >= self.deadline
            && (self.response.is_some() || !self.prefix.is_empty() || !self.pending.is_empty())
        {
            self.cancel_body();
            return Err("upstream-timeout");
        }
        if !self.prefix.is_empty() {
            return Ok(Some(self.prefix.split_to(self.prefix.len())));
        }
        while self.pending.is_empty() {
            let Some(chunk) = self.pull().await? else {
                return Ok(None);
            };
            self.pending = chunk;
        }
        Ok(Some(
            self.pending
                .split_to(TRANSFER_CHUNK.min(self.pending.len())),
        ))
    }

    pub async fn read_manifest(mut self) -> Result<Vec<u8>, &'static str> {
        if self.body_kind != BodyKind::Manifest {
            return Err("manifest-required");
        }
        let mut body = Vec::new();
        while let Some(chunk) = self.next_chunk().await? {
            if chunk.len() > MANIFEST_LIMIT.saturating_sub(body.len()) {
                return Err("manifest-invalid-or-large");
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
}

pub async fn fetch(url: Url, range: Option<String>) -> Result<Reply, &'static str> {
    fetch_with_policy(url, range, false).await
}

/// Compatibility: this deliberately buffers the original full 32 MiB limit.
pub async fn fetch_with_policy(
    url: Url,
    range: Option<String>,
    allow_http: bool,
) -> Result<Reply, &'static str> {
    let mut opened = open_with_policy(url, range, allow_http).await?;
    let mut body = Vec::new();
    while let Some(chunk) = opened.next_chunk().await? {
        body.extend_from_slice(&chunk);
    }
    Ok(Reply {
        body,
        content_type: opened.content_type,
        content_range: opened.content_range,
        status: opened.status,
        retry_after: opened.retry_after,
        final_url: opened.final_url,
    })
}

pub async fn open_with_policy(
    url: Url,
    range: Option<String>,
    allow_http: bool,
) -> Result<OpenedUpstream, &'static str> {
    open_with_remaining_policy(
        url,
        range,
        allow_http,
        tokio::time::Instant::now() + Duration::from_secs(20),
        5,
    )
    .await
}

fn remaining_policy_budget(
    absolute_deadline: tokio::time::Instant,
    remaining_redirects: usize,
) -> Result<(tokio::time::Instant, usize), &'static str> {
    let now = tokio::time::Instant::now();
    if absolute_deadline <= now {
        return Err("upstream-timeout");
    }
    Ok((
        absolute_deadline.min(now + Duration::from_secs(20)),
        remaining_redirects.min(5),
    ))
}

/// A canonical refetch spends the original request's remaining time and redirects.
/// No added credentials, destination exceptions, timeout reset or downgrade fallback.
pub(crate) async fn open_with_remaining_policy(
    url: Url,
    range: Option<String>,
    allow_http: bool,
    absolute_deadline: tokio::time::Instant,
    remaining_redirects: usize,
) -> Result<OpenedUpstream, &'static str> {
    open_with_remaining_transport(
        url,
        range,
        allow_http,
        absolute_deadline,
        remaining_redirects,
        request_public,
    )
    .await
}

async fn request_public(
    url: Url,
    range: Option<String>,
    deadline: tokio::time::Instant,
) -> Result<reqwest::Response, &'static str> {
    let host = url.host_str().ok_or("upstream-host-refused")?;
    let port = url.port_or_known_default().ok_or("upstream-port-refused")?;
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "upstream-dns-failed")?
        .collect();
    if addresses.is_empty()
        || addresses.len() > 128
        || addresses.iter().any(|a| !public_upstream(a.ip()))
    {
        return Err("upstream-address-refused");
    }
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err("upstream-timeout");
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(5).min(remaining))
        .read_timeout(Duration::from_secs(5).min(remaining))
        .timeout(remaining)
        .build()
        .map_err(|_| "upstream-client-failed")?;
    let mut request = client.get(url);
    if let Some(range) = range {
        request = request.header(RANGE, range);
    }
    request.send().await.map_err(|_| "upstream-network-failed")
}

// Production uses only request_public. Private injection permits controlled socket fixtures;
// it is not an exported private-network relay or alternate production fallback.
async fn open_with_remaining_transport<F, Fut>(
    mut url: Url,
    range: Option<String>,
    allow_http: bool,
    absolute_deadline: tokio::time::Instant,
    remaining_redirects: usize,
    mut transport: F,
) -> Result<OpenedUpstream, &'static str>
where
    F: FnMut(Url, Option<String>, tokio::time::Instant) -> Fut,
    Fut: std::future::Future<Output = Result<reqwest::Response, &'static str>>,
{
    if range.as_ref().is_some_and(|range| !validate_range(range)) {
        return Err("range-refused");
    }
    let (deadline, allowed_redirects) =
        remaining_policy_budget(absolute_deadline, remaining_redirects)?;
    let work = async {
        for redirects in 0..=allowed_redirects {
            validate_url(&url)?;
            if url.scheme() == "http" && !allow_http {
                return Err("upstream-http-approval-required");
            }
            let response = transport(url.clone(), range.clone(), deadline).await?;
            if response.status().is_redirection() {
                if redirects >= allowed_redirects {
                    return Err("upstream-redirect-limit");
                }
                let location = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or("upstream-redirect-invalid")?;
                let next = url
                    .join(location)
                    .map_err(|_| "upstream-redirect-invalid")?;
                if url.scheme() == "https" && next.scheme() == "http" {
                    return Err("upstream-downgrade-refused");
                }
                url = next;
                continue;
            }
            let mut opened = OpenedUpstream::from_response(response, url, deadline).await?;
            opened.redirects_used = redirects;
            return Ok(opened);
        }
        Err("upstream-redirect-limit")
    };
    tokio::time::timeout_at(deadline, work)
        .await
        .map_err(|_| "upstream-timeout")?
}

/// Result allocation is admitted fragment by fragment. The issue callback owns its
/// replacement allocations; this is not an allocator-overhead or process-RSS bound.
pub fn rewrite_hls<F>(manifest: &str, base: &Url, issue: F) -> Result<String, &'static str>
where
    F: FnMut(Url) -> Result<String, &'static str>,
{
    rewrite_hls_observed(manifest, base, issue, |_, _| {})
}

fn append_manifest_fragment<O>(
    result: &mut String,
    fragment: &str,
    observe: &mut O,
) -> Result<(), &'static str>
where
    O: FnMut(usize, usize),
{
    if fragment.len() > OUTPUT_LIMIT.saturating_sub(result.len()) {
        observe(result.len(), result.capacity());
        return Err("manifest-output-too-large");
    }
    let required = result.len() + fragment.len();
    if required > result.capacity() {
        // Geometric growth avoids a reallocation/copy per URI fragment. Exact reserve
        // controls the requested capacity; cap growth before allocation, not after it.
        let target = required
            .max(result.capacity().max(64).saturating_mul(2))
            .min(OUTPUT_LIMIT);
        result
            .try_reserve_exact(target - result.len())
            .map_err(|_| "manifest-output-allocation-failed")?;
    }
    result.push_str(fragment);
    observe(result.len(), result.capacity());
    Ok(())
}

fn rewrite_hls_observed<F, O>(
    manifest: &str,
    base: &Url,
    mut issue: F,
    mut observe: O,
) -> Result<String, &'static str>
where
    F: FnMut(Url) -> Result<String, &'static str>,
    O: FnMut(usize, usize),
{
    if manifest.len() > 2 * 1024 * 1024
        || !manifest
            .trim_start_matches('\u{feff}')
            .starts_with("#EXTM3U")
    {
        return Err("manifest-invalid-or-large");
    }
    let attributes =
        regex::Regex::new("URI=\"([^\"]*)\"").map_err(|_| "manifest-rewriter-failed")?;
    let mut result = String::new();
    for line in manifest.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.starts_with('#') {
            let mut position = 0;
            for captures in attributes.captures_iter(line) {
                let capture = captures.get(0).ok_or("manifest-uri-invalid")?;
                let url = base
                    .join(&captures[1])
                    .map_err(|_| "manifest-uri-invalid")?;
                validate_url(&url)?;
                append_manifest_fragment(
                    &mut result,
                    &line[position..capture.start()],
                    &mut observe,
                )?;
                append_manifest_fragment(&mut result, "URI=\"", &mut observe)?;
                let replacement = issue(url)?;
                append_manifest_fragment(&mut result, &replacement, &mut observe)?;
                append_manifest_fragment(&mut result, "\"", &mut observe)?;
                position = capture.end();
            }
            append_manifest_fragment(&mut result, &line[position..], &mut observe)?;
        } else if !line.is_empty() {
            let url = base.join(line).map_err(|_| "manifest-uri-invalid")?;
            validate_url(&url)?;
            let replacement = issue(url)?;
            append_manifest_fragment(&mut result, &replacement, &mut observe)?;
        }
        append_manifest_fragment(&mut result, "\n", &mut observe)?;
    }
    Ok(result)
}

#[cfg(test)]
#[path = "relay_tests.rs"]
mod tests;
