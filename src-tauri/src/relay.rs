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
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn remaining_fixture(
        always_redirect: bool,
    ) -> (
        Url,
        std::sync::Arc<std::sync::atomic::AtomicUsize>,
        std::sync::Arc<std::sync::atomic::AtomicUsize>,
        tokio::sync::oneshot::Sender<()>,
        tokio::task::JoinHandle<()>,
    ) {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let ranges = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let range_count = ranges.clone();
        let (stop, mut stopped) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let mut clients = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    Some(result) = clients.join_next(), if !clients.is_empty() => { result.unwrap(); },
                    accepted = listener.accept() => {
                        let (mut socket, _) = accepted.unwrap();
                        let count = count.clone(); let ranges = range_count.clone();
                        clients.spawn(async move {
                            let headers = tokio::time::timeout(Duration::from_secs(2), async {
                                let mut request = Vec::new();
                                while !request.ends_with(b"\r\n\r\n") {
                                    let mut byte = [0]; socket.read_exact(&mut byte).await.unwrap();
                                    request.push(byte[0]); assert!(request.len() <= 8192);
                                }
                                request
                            }).await.unwrap();
                            count.fetch_add(1, Ordering::SeqCst);
                            let ranged = headers.windows(6).any(|value| value.eq_ignore_ascii_case(b"range:"));
                            if ranged { ranges.fetch_add(1, Ordering::SeqCst); }
                            if always_redirect || headers.starts_with(b"GET /first ") {
                                tokio::time::sleep(Duration::from_millis(5)).await;
                                socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: /canonical\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                                socket.shutdown().await.unwrap();
                            } else {
                                let status = if ranged { "206 Partial Content" } else { "200 OK" };
                                let header = format!("HTTP/1.1 {status}\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: 64\r\nConnection: close\r\n\r\n#EXTM3U\n#x\n");
                                socket.write_all(header.as_bytes()).await.unwrap();
                                // Keep an actual incomplete response until its owner drops/cancels it.
                                let mut byte = [0]; let _ = socket.read(&mut byte).await;
                            }
                        });
                    }
                }
            }
            clients.abort_all();
            while let Some(result) = clients.join_next().await {
                if let Err(error) = result {
                    assert!(error.is_cancelled());
                }
            }
        });
        (base, requests, ranges, stop, task)
    }
    async fn fixture_transport(
        url: Url,
        range: Option<String>,
        deadline: tokio::time::Instant,
    ) -> Result<reqwest::Response, &'static str> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .timeout(deadline.saturating_duration_since(tokio::time::Instant::now()))
            .build()
            .map_err(|_| "fixture-client-failed")?;
        let mut request = client.get(url);
        if let Some(range) = range {
            request = request.header(RANGE, range);
        }
        request.send().await.map_err(|_| "fixture-network-failed")
    }
    #[tokio::test]
    async fn actual_canonical_refetch_keeps_original_body_deadline_and_counts_used_redirects() {
        use std::sync::atomic::Ordering;
        let (base, requests, ranges, stop, task) = remaining_fixture(false).await;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
        let first = open_with_remaining_transport(
            base.join("first").unwrap(),
            Some("bytes=0-10".into()),
            true,
            deadline,
            5,
            fixture_transport,
        )
        .await
        .unwrap();
        assert_eq!(first.redirects_used, 1);
        assert_eq!(first.status, 206);
        assert_eq!(first.body_kind, BodyKind::Manifest);
        let final_url = first.final_url.clone();
        let remaining = 5 - first.redirects_used;
        drop(first);
        let mut full = open_with_remaining_transport(
            final_url,
            None,
            true,
            deadline,
            remaining,
            fixture_transport,
        )
        .await
        .unwrap();
        assert_eq!(full.redirects_used, 0);
        assert_eq!(full.status, 200);
        assert_eq!(full.deadline, deadline);
        assert_eq!(requests.load(Ordering::SeqCst), 3);
        assert_eq!(
            ranges.load(Ordering::SeqCst),
            2,
            "canonical refetch must remove Range"
        );
        tokio::time::sleep_until(deadline + Duration::from_millis(5)).await;
        assert_eq!(full.next_chunk().await.unwrap_err(), "upstream-timeout");
        stop.send(()).unwrap();
        task.await.unwrap();
    }
    #[tokio::test]
    async fn actual_remaining_redirect_allowance_refuses_extra_hop_and_clamps_to_five() {
        use std::sync::atomic::Ordering;
        for (allowance, requests_expected) in [(0usize, 1usize), (1, 2), (usize::MAX, 6)] {
            let (base, requests, _, stop, task) = remaining_fixture(true).await;
            let error = open_with_remaining_transport(
                base,
                None,
                true,
                tokio::time::Instant::now() + Duration::from_secs(2),
                allowance,
                fixture_transport,
            )
            .await
            .err();
            assert_eq!(error, Some("upstream-redirect-limit"));
            assert_eq!(requests.load(Ordering::SeqCst), requests_expected);
            stop.send(()).unwrap();
            task.await.unwrap();
        }
    }
    #[tokio::test]
    async fn spent_deadline_and_http_refusal_never_start_fixture_transport() {
        use std::sync::atomic::Ordering;
        let (base, requests, _, stop, task) = remaining_fixture(true).await;
        assert_eq!(
            open_with_remaining_transport(
                base.clone(),
                None,
                true,
                tokio::time::Instant::now(),
                5,
                fixture_transport
            )
            .await
            .err(),
            Some("upstream-timeout")
        );
        assert_eq!(
            open_with_remaining_transport(
                base,
                None,
                false,
                tokio::time::Instant::now() + Duration::from_secs(2),
                5,
                fixture_transport
            )
            .await
            .err(),
            Some("upstream-http-approval-required")
        );
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        stop.send(()).unwrap();
        task.await.unwrap();
    }
    #[test]
    fn oversized_remaining_deadline_is_clamped_without_extending_a_shorter_deadline() {
        let before = tokio::time::Instant::now();
        let (deadline, redirects) =
            remaining_policy_budget(before + Duration::from_secs(3600), usize::MAX).unwrap();
        assert!(deadline <= tokio::time::Instant::now() + Duration::from_secs(20));
        assert!(deadline >= before + Duration::from_secs(20));
        assert_eq!(redirects, 5);
        let short = before + Duration::from_secs(1);
        assert_eq!(remaining_policy_budget(short, 2).unwrap(), (short, 2));
    }

    async fn read_fixture_headers(socket: &mut tokio::net::TcpStream) {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
                assert!(request.len() <= 4096);
            }
        })
        .await
        .unwrap();
    }

    async fn response_fixture(
        headers: &str,
        parts: Vec<Vec<u8>>,
    ) -> (reqwest::Response, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let headers = headers.to_string();
        let owner = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_fixture_headers(&mut socket).await;
            socket.write_all(headers.as_bytes()).await.unwrap();
            for part in parts {
                if socket
                    .write_all(format!("{:x}\r\n", part.len()).as_bytes())
                    .await
                    .is_err()
                {
                    return;
                }
                if socket.write_all(&part).await.is_err() {
                    return;
                }
                if socket.write_all(b"\r\n").await.is_err() {
                    return;
                }
            }
            let _ = socket.write_all(b"0\r\n\r\n").await;
        });
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{address}/controlled"))
            .send()
            .await
            .unwrap();
        (response, owner)
    }

    #[tokio::test]
    async fn actual_partial_body_is_delivered_before_completion_and_drop_closes_upstream() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let owner = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_fixture_headers(&mut socket).await;
            socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n0123456789abcdef\r\n").await.unwrap();
            // No terminating chunk is sent. Consumer must get data without whole-body buffering.
            let mut byte = [0; 1];
            tokio::time::timeout(Duration::from_secs(3), socket.read(&mut byte))
                .await
                .unwrap()
                .unwrap()
        });
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{address}/partial"))
            .send()
            .await
            .unwrap();
        let mut opened = tokio::time::timeout(
            Duration::from_secs(1),
            OpenedUpstream::from_test_response(response),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(opened.body_kind, BodyKind::Media);
        let first = opened.next_chunk().await.unwrap().unwrap();
        let second = opened.next_chunk().await.unwrap().unwrap();
        assert_eq!(
            [first.as_ref(), second.as_ref()].concat(),
            b"0123456789abcdef"
        );
        drop(opened);
        assert_eq!(owner.await.unwrap(), 0);
    }

    #[tokio::test]
    async fn fragmented_bom_sniff_range_metadata_and_non_success_status_remain_observed() {
        let manifest = b"\xef\xbb\xbf#EXTM3U\n#EXTINF:1,\nsegment?opaque=yes\n";
        let (response,owner)=response_fixture("HTTP/1.1 206 Partial Content\r\nTransfer-Encoding: chunked\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 0-39/40\r\n\r\n",
            vec![manifest[..2].to_vec(),manifest[2..5].to_vec(),manifest[5..].to_vec()]).await;
        let opened = OpenedUpstream::from_test_response(response).await.unwrap();
        assert_eq!(opened.body_kind, BodyKind::Manifest);
        assert_eq!(opened.status, 206);
        assert_eq!(opened.content_range.as_deref(), Some("bytes 0-39/40"));
        assert_eq!(opened.read_manifest().await.unwrap(), manifest);
        owner.await.unwrap();
        let (response,owner)=response_fixture("HTTP/1.1 429 Too Many Requests\r\nTransfer-Encoding: chunked\r\nRetry-After: 7\r\nContent-Type: application/vnd.apple.mpegurl\r\n\r\n",vec![]).await;
        let mut opened = OpenedUpstream::from_test_response(response).await.unwrap();
        assert_eq!(opened.status, 429);
        assert_eq!(opened.retry_after.as_deref(), Some("7"));
        assert!(opened.next_chunk().await.unwrap().is_none());
        owner.await.unwrap();
    }

    #[tokio::test]
    async fn actual_chunked_manifest_media_and_absolute_deadline_are_bounded() {
        let (response,owner)=response_fixture("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/vnd.apple.mpegurl\r\n\r\n",vec![vec![b'x';65536];33]).await;
        let opened = OpenedUpstream::from_test_response(response).await.unwrap();
        assert_eq!(
            opened.read_manifest().await.unwrap_err(),
            "manifest-invalid-or-large"
        );
        owner.await.unwrap();
        let (response, owner) = response_fixture(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
            vec![vec![b'x'; 65536]; 513],
        )
        .await;
        let mut opened = OpenedUpstream::from_test_response(response).await.unwrap();
        loop {
            match opened.next_chunk().await {
                Ok(Some(chunk)) => assert!(chunk.len() <= TRANSFER_CHUNK),
                Err(error) => {
                    assert_eq!(error, "upstream-body-too-large");
                    break;
                }
                Ok(None) => panic!("oversized body was admitted"),
            }
        }
        owner.await.unwrap();
        let (response, owner) = response_fixture(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
            vec![b"0123456789abcdef".to_vec()],
        )
        .await;
        let url = response.url().clone();
        let mut opened = OpenedUpstream::from_response(
            response,
            url,
            tokio::time::Instant::now() + Duration::from_millis(100),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(opened.next_chunk().await.unwrap_err(), "upstream-timeout");
        assert!(opened.next_chunk().await.unwrap().is_none());
        owner.await.unwrap();
    }

    #[test]
    fn rewritten_manifest_has_an_explicit_output_ceiling() {
        let base = Url::parse("https://example.org/").unwrap();
        assert_eq!(
            rewrite_hls(
                "#EXTM3U\nsegment\n",
                &base,
                |_| Ok("x".repeat(OUTPUT_LIMIT))
            )
            .unwrap_err(),
            "manifest-output-too-large"
        );
    }
    #[test]
    fn repeated_same_target_line_stops_before_output_growth_and_remaining_uri_work() {
        let occurrences = 100_000;
        let manifest = format!("#EXTM3U\n#EXT-X-KEY:{}\n", "URI=\"a\",".repeat(occurrences));
        assert!(manifest.len() < MANIFEST_LIMIT);
        let mut issued = 0usize;
        let mut peak_len = 0usize;
        let mut peak_capacity = 0usize;
        let mut capacity_changes = 0usize;
        let mut previous_capacity = 0usize;
        let session_path = format!("/media/1/{}", "a".repeat(64));
        let error = rewrite_hls_observed(
            &manifest,
            &Url::parse("https://example.org/feed").unwrap(),
            |url| {
                assert_eq!(url.as_str(), "https://example.org/a");
                issued += 1;
                Ok(session_path.clone())
            },
            |len, capacity| {
                peak_len = peak_len.max(len);
                peak_capacity = peak_capacity.max(capacity);
                if previous_capacity != capacity {
                    capacity_changes += 1;
                    previous_capacity = capacity;
                }
                assert!(len <= OUTPUT_LIMIT);
                assert!(capacity <= OUTPUT_LIMIT);
            },
        )
        .unwrap_err();
        assert_eq!(error, "manifest-output-too-large");
        assert!(peak_len > OUTPUT_LIMIT - 256);
        assert_eq!(peak_capacity, OUTPUT_LIMIT);
        assert!((50_000..60_000).contains(&issued));
        assert!(
            capacity_changes <= 20,
            "growth must not reallocate for every URI fragment"
        );
    }
    #[test]
    fn oversized_issue_output_is_refused_before_result_allocation() {
        let mut peak_capacity = 0;
        let error = rewrite_hls_observed(
            "#EXTM3U\nsegment\n",
            &Url::parse("https://example.org/feed").unwrap(),
            |_| Ok("x".repeat(OUTPUT_LIMIT + 1)),
            |len, capacity| {
                assert!(len <= OUTPUT_LIMIT);
                peak_capacity = peak_capacity.max(capacity);
            },
        )
        .unwrap_err();
        assert_eq!(error, "manifest-output-too-large");
        assert!(peak_capacity < 1024);
        // The callback's own replacement allocation is outside the output buffer contract.
    }
    #[test]
    fn checked_append_admits_exact_utf8_byte_limit_without_truncating_on_later_failure() {
        let mut output = String::new();
        let mut observe = |len, capacity| {
            assert!(len <= OUTPUT_LIMIT);
            assert!(capacity <= OUTPUT_LIMIT);
        };
        append_manifest_fragment(&mut output, &"x".repeat(OUTPUT_LIMIT - 4), &mut observe).unwrap();
        append_manifest_fragment(&mut output, "📺", &mut observe).unwrap();
        assert_eq!(output.len(), OUTPUT_LIMIT);
        assert_eq!(output.capacity(), OUTPUT_LIMIT);
        assert_eq!(
            append_manifest_fragment(&mut output, "x", &mut observe),
            Err("manifest-output-too-large")
        );
        assert_eq!(output.len(), OUTPUT_LIMIT);
        assert!(output.ends_with("📺"));
    }
    #[test]
    fn input_limit_remains_independent_and_refuses_before_issuing_resources() {
        let exact = format!("#EXTM3U\n#{}", "x".repeat(MANIFEST_LIMIT - 9));
        assert_eq!(exact.len(), MANIFEST_LIMIT);
        let base = Url::parse("https://example.org/feed").unwrap();
        assert!(rewrite_hls(&exact, &base, |_| panic!("comment is not a resource")).is_ok());
        let oversized = format!("{exact}x");
        assert_eq!(
            rewrite_hls(&oversized, &base, |_| panic!(
                "oversized input cannot issue resources"
            )),
            Err("manifest-invalid-or-large")
        );
    }
    #[test]
    fn bom_is_metadata_and_never_an_admitted_resource() {
        let base = Url::parse("https://example.org/master").unwrap();
        let mut resources = Vec::new();
        let output = rewrite_hls(
            "\u{feff}#EXTM3U\r\n#EXTINF:2,\r\nsegment\r\n",
            &base,
            |url| {
                resources.push(url);
                Ok("/opaque/segment".into())
            },
        )
        .unwrap();
        assert!(output.starts_with("#EXTM3U\n"));
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0].as_str(), "https://example.org/segment");
    }
    use super::*;
    #[test]
    fn hls_rewrites_variants_segments_keys_maps_and_queries() {
        let mut targets = Vec::new();
        let output = rewrite_hls("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key?a=secret\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-MEDIA:URI=\"audio.m3u8\",TYPE=AUDIO\n#EXT-X-STREAM-INF:BANDWIDTH=50000\nvariant.m3u8\nsegment.ts?signature=secret\n", &Url::parse("https://example.org/live/master.m3u8").unwrap(), |url| { targets.push(url); Ok(format!("/media/1/id{}", targets.len())) }).unwrap();
        assert_eq!(targets.len(), 5);
        assert_eq!(targets[0].as_str(), "https://example.org/live/key?a=secret");
        assert!(!output.contains("secret"));
        assert!(output.contains("URI=\"/media/1/id1\""));
        assert!(output.contains("/media/1/id5"));
        assert!(rewrite_hls(
            "#EXTM3U\nfile:///secret\n",
            &Url::parse("https://example.org/").unwrap(),
            |_| Ok("unused".into())
        )
        .is_err());
    }
    #[test]
    fn range_is_single_bounded_and_valid() {
        for range in ["bytes=0-100", "bytes=50-", "bytes=-500"] {
            assert!(validate_range(range));
        }
        for range in [
            "bytes=100-50",
            "bytes=0-1,2-3",
            "bytes=-",
            "bytes=-0",
            "items=0-1",
            "bytes=18446744073709551616-",
        ] {
            assert!(!validate_range(range));
        }
    }
}
