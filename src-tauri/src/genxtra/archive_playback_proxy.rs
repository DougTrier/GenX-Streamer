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

//! One exact metadata-verified Archive MP4, available only through a loopback
//! capability. Not a LAN/casting server. No arbitrary upstream URL IPC.
use reqwest::{redirect::Policy, Url};
use std::{
    future::Future,
    net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs},
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{
        tcp::{OwnedReadHalf, OwnedWriteHalf},
        TcpListener, TcpStream,
    },
    sync::{oneshot, watch},
    task::{JoinHandle, JoinSet},
    time::Instant,
};

const ERR: &str = "archive-proxy-refused";
const LEASE: Duration = Duration::from_secs(60);
const MAX_LIFE: Duration = Duration::from_secs(24 * 60 * 60);
const DEADLINE: Duration = Duration::from_secs(20);
const BODY_AUTHORITY_CHECK: Duration = Duration::from_secs(2);
const CHUNK: usize = 64 * 1024;
const MAX_FILE: u64 = 64 * 1024 * 1024 * 1024;
pub(crate) type Authority =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;
pub(crate) type Alive = Arc<dyn Fn() -> bool + Send + Sync>;
struct State {
    target: Option<Url>,
    public: Option<crate::archive_provider_discovery::ExactMedia>,
    mime: &'static str,
    local: Option<Arc<crate::archive_download_store::LocalBody>>,
    allowed_hosts: Vec<String>,
    tail: String,
    size: u64,
    path: String,
    host: String,
    generation: u64,
    request_sequence: u64,
    started: Instant,
    renewed: Instant,
    authority: Authority,
    alive: Alive,
    tasks: Vec<JoinHandle<()>>,
    join_failed: bool,
}
impl State {
    fn active(&self) -> bool {
        !self.join_failed
            && (self.alive)()
            && self.renewed.elapsed() < LEASE
            && self.started.elapsed() < MAX_LIFE
    }
}
pub(crate) struct ArchivePlaybackProxy {
    state: Arc<Mutex<State>>,
    media_url: String,
    cancel: watch::Sender<bool>,
    task: Option<JoinHandle<Result<(), String>>>,
    failed: bool,
}
fn validity(state: Arc<Mutex<State>>, canceled: watch::Receiver<bool>) -> Alive {
    Arc::new(move || !*canceled.borrow() && state.lock().is_ok_and(|s| s.active()))
}
fn opaque() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| ERR)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn archive_host(host: &str) -> bool {
    crate::archive_discovery::media_host(host)
}
pub(crate) fn validate(url: &Url, hosts: &[String], tail: &str) -> Result<(), String> {
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str().len() > 16384
    {
        return Err("archive-proxy-url-refused".into());
    }
    let host = url.host_str().ok_or("archive-proxy-host-unverified")?;
    if !archive_host(host) || !hosts.iter().any(|h| h == host) {
        return Err("archive-proxy-host-unverified".into());
    }
    let path = url.path();
    let exact = path.strip_prefix("/download/") == Some(tail)
        || path.strip_prefix("/items/") == Some(tail)
        || path
            .strip_prefix('/')
            .and_then(|p| p.split_once("/items/"))
            .is_some_and(|(disk, p)| {
                !disk.is_empty()
                    && disk.len() <= 4
                    && disk.bytes().all(|b| b.is_ascii_digit())
                    && p == tail
            });
    if !exact {
        return Err("archive-proxy-path-unverified".into());
    }
    Ok(())
}
async fn join_tasks(state: &Arc<Mutex<State>>) -> Result<(), String> {
    let tasks = std::mem::take(&mut state.lock().map_err(|_| ERR)?.tasks);
    let mut failed = false;
    for task in tasks {
        failed |= task.await.is_err();
    }
    if failed || state.lock().map_err(|_| ERR)?.join_failed {
        Err("archive-proxy-work-join-failed".into())
    } else {
        Ok(())
    }
}
async fn reap_finished(state: &Arc<Mutex<State>>) -> Result<(), String> {
    let finished = {
        let mut s = state.lock().map_err(|_| ERR)?;
        let mut finished = Vec::new();
        let mut pending = Vec::new();
        for task in std::mem::take(&mut s.tasks) {
            if task.is_finished() {
                finished.push(task);
            } else {
                pending.push(task);
            }
        }
        s.tasks = pending;
        finished
    };
    let mut failed = false;
    for task in finished {
        failed |= task.await.is_err();
    }
    if failed {
        state.lock().map_err(|_| ERR)?.join_failed = true;
        return Err("archive-proxy-work-join-failed".into());
    }
    Ok(())
}
// Cancellation/timeouts drop observers, NEVER the native SQL/OS resolver task.
// The supervisor retains and joins those actual operations before Stop succeeds.
async fn authority(state: &Arc<Mutex<State>>) -> Result<(), String> {
    reap_finished(state).await?;
    let (send, receive) = oneshot::channel();
    {
        let mut s = state.lock().map_err(|_| ERR)?;
        if !s.active() {
            return Err("archive-proxy-expired".into());
        }
        if s.tasks.len() >= 16 {
            return Err("archive-proxy-work-limit".into());
        }
        let check = s.authority.clone();
        s.tasks.push(tokio::spawn(async move {
            let _ = send.send(check().await);
        }));
    }
    let result = tokio::time::timeout(DEADLINE, receive)
        .await
        .map_err(|_| "archive-proxy-timeout")?
        .map_err(|_| "archive-proxy-authority-lost")?;
    result?;
    if !state.lock().map_err(|_| ERR)?.active() {
        return Err("archive-proxy-expired".into());
    }
    Ok(())
}
fn checked_addresses(
    addresses: impl IntoIterator<Item = SocketAddr>,
) -> Result<Vec<SocketAddr>, String> {
    let mut result = Vec::new();
    for addr in addresses {
        if result.len() >= 128 {
            return Err("archive-proxy-dns-address-limit".into());
        }
        if !crate::sharing_policy::public_upstream(addr.ip()) {
            return Err("archive-proxy-dns-private".into());
        }
        result.push(addr);
    }
    if result.is_empty() {
        Err("archive-proxy-dns".into())
    } else {
        Ok(result)
    }
}
async fn addresses(state: &Arc<Mutex<State>>, host: String) -> Result<Vec<SocketAddr>, String> {
    reap_finished(state).await?;
    let (send, receive) = oneshot::channel();
    {
        let mut s = state.lock().map_err(|_| ERR)?;
        if !s.active() || s.tasks.len() >= 16 {
            return Err(ERR.into());
        }
        s.tasks.push(tokio::spawn(async move {
            let result = tokio::task::spawn_blocking(move || {
                checked_addresses(
                    (host.as_str(), 443)
                        .to_socket_addrs()
                        .map_err(|_| "archive-proxy-dns")?,
                )
            })
            .await
            .unwrap_or_else(|_| Err("archive-proxy-dns-join".into()));
            let _ = send.send(result);
        }));
    }
    tokio::time::timeout(DEADLINE, receive)
        .await
        .map_err(|_| "archive-proxy-timeout")?
        .map_err(|_| "archive-proxy-dns-join")?
}
async fn open(
    state: &Arc<Mutex<State>>,
    range: Option<(u64, u64)>,
    head: bool,
) -> Result<reqwest::Response, String> {
    let (mut url, hosts, tail, public) = {
        let s = state.lock().map_err(|_| ERR)?;
        (
            s.target
                .clone()
                .ok_or("archive-proxy-network-unavailable")?,
            s.allowed_hosts.clone(),
            s.tail.clone(),
            s.public.clone(),
        )
    };
    for redirect in 0..=5 {
        authority(state).await?;
        if public
            .as_ref()
            .is_some_and(|p| crate::archive_provider_net::retry_until(p.provider).is_some())
        {
            return Err("archive-media-rate-limited".into());
        }
        if let Some(proof) = &public {
            proof.validate(&url)?;
        } else {
            validate(&url, &hosts, &tail)?;
        }
        let host = url.host_str().ok_or(ERR)?.to_owned();
        let addrs = addresses(state, host.clone()).await?;
        authority(state).await?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .http1_only()
            .redirect(Policy::none())
            .resolve_to_addrs(&host, &addrs)
            .connect_timeout(DEADLINE)
            .read_timeout(DEADLINE)
            .user_agent(
                if public.as_ref().is_some_and(|p| {
                    p.provider == crate::archive_provider_contract::Provider::Commons
                }) {
                    crate::archive_provider_net::commons_agent()?
                } else {
                    "GenX-Streamer/0.1 ArchivePlayback".into()
                },
            )
            .build()
            .map_err(|_| "archive-proxy-network")?;
        let mut request = if head {
            client.head(url.clone())
        } else {
            client.get(url.clone())
        };
        request = request.header(reqwest::header::ACCEPT_ENCODING, "identity");
        if let Some((start, end)) = range {
            request = request.header(reqwest::header::RANGE, format!("bytes={start}-{end}"));
        }
        let response = request.send().await.map_err(|_| "archive-proxy-network")?;
        authority(state).await?;
        if response.status().is_redirection() {
            if redirect == 5 {
                return Err("archive-proxy-redirect-limit".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("archive-proxy-url-refused")?;
            url = url
                .join(location)
                .map_err(|_| "archive-proxy-url-refused")?;
            if let Some(proof) = &public {
                proof.validate(&url)?;
            } else {
                validate(&url, &hosts, &tail)?;
            }
        } else {
            if let Some(proof) = &public {
                if matches!(response.status().as_u16(), 429 | 503) {
                    crate::archive_provider_net::retain_retry(
                        proof.provider,
                        response
                            .headers()
                            .get(reqwest::header::RETRY_AFTER)
                            .and_then(|h| h.to_str().ok()),
                    );
                }
            }
            return Ok(response);
        }
    }
    Err(ERR.into())
}
#[cfg(test)]
fn response_length(
    response: &reqwest::Response,
    range: Option<(u64, u64)>,
    size: u64,
) -> Result<u64, String> {
    response_length_for(response, range, size, "video/mp4")
}
fn response_length_for(
    response: &reqwest::Response,
    range: Option<(u64, u64)>,
    size: u64,
    expected_mime: &str,
) -> Result<u64, String> {
    let status = response.status().as_u16();
    if matches!(status, 401 | 403) {
        return Err("archive-media-access-refused".into());
    }
    if matches!(status, 404 | 410) {
        return Err("archive-media-unavailable".into());
    }
    if status == 429 {
        return Err("archive-media-rate-limited".into());
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_ENCODING)
        .is_some_and(|v| v.as_bytes() != b"identity")
    {
        return Err("archive-proxy-response-encoding-unverified".into());
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if !mime.eq_ignore_ascii_case(expected_mime) {
        return Err("archive-media-format-unverified".into());
    }
    let length = match range {
        None => {
            if status != 200
                || response
                    .headers()
                    .contains_key(reqwest::header::CONTENT_RANGE)
            {
                return Err(ERR.into());
            }
            size
        }
        Some((start, end)) => {
            if status != 206 {
                return Err("archive-media-range-unverified".into());
            }
            let expected = format!("bytes {start}-{end}/{size}");
            if response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                != Some(expected.as_str())
            {
                return Err("archive-media-range-unverified".into());
            }
            end - start + 1
        }
    };
    if response.content_length() != Some(length) {
        return Err("archive-media-size-changed".into());
    }
    Ok(length)
}
fn range(raw: &str, size: u64) -> Result<(u64, u64), String> {
    let spec = raw
        .strip_prefix("bytes=")
        .filter(|s| s.len() <= 64)
        .ok_or(ERR)?;
    let (first, last) = spec.split_once('-').ok_or(ERR)?;
    let number = |s: &str| -> Result<u64, String> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(ERR.into());
        }
        s.parse().map_err(|_| ERR.into())
    };
    if first.is_empty() {
        let n = number(last)?;
        if n == 0 {
            return Err(ERR.into());
        }
        return Ok((size.saturating_sub(n), size - 1));
    }
    let start = number(first)?;
    let end = if last.is_empty() {
        size - 1
    } else {
        number(last)?.min(size - 1)
    };
    if start > end || start >= size {
        return Err("archive-proxy-range-unsatisfiable".into());
    }
    Ok((start, end))
}
fn cors(value: &str) -> bool {
    matches!(
        value,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) || (cfg!(debug_assertions) && value == "http://localhost:1420")
}
struct Request {
    range: Option<(u64, u64)>,
    head: bool,
    options: bool,
    origin: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RequestPhase {
    Admitted,
    Authority,
    Open,
    Headers,
    UpstreamRead,
    LocalRead,
    SocketWrite,
}
impl RequestPhase {
    fn code(self) -> &'static str {
        match self {
            Self::Admitted => "admitted",
            Self::Authority => "authority",
            Self::Open => "open",
            Self::Headers => "headers",
            Self::UpstreamRead => "upstream-read",
            Self::LocalRead => "local-read",
            Self::SocketWrite => "socket-write",
        }
    }
}
#[derive(Clone, Copy)]
enum RequestEnd {
    Start,
    Complete,
    Canceled,
    OwnerInvalid,
    ConsumerClosed,
    ConsumerInput,
    ConsumerReadFailed,
    Failed,
}
#[derive(Clone, Copy)]
enum TimeoutBoundary {
    None,
    Socket,
    Authority,
    Open,
    UpstreamRead,
}
impl TimeoutBoundary {
    fn code(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Socket => "socket",
            Self::Authority => "authority",
            Self::Open => "open",
            Self::UpstreamRead => "upstream-read",
        }
    }
}
impl RequestEnd {
    fn code(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Complete => "complete",
            Self::Canceled => "canceled",
            Self::OwnerInvalid => "owner-invalid",
            Self::ConsumerClosed => "consumer-closed",
            Self::ConsumerInput => "consumer-input",
            Self::ConsumerReadFailed => "consumer-read-failed",
            Self::Failed => "failed",
        }
    }
}
// Numeric/closed-token request facts only. Never retain or format the media
// capability, upstream URL, origin, file/title reference or arbitrary errors.
struct RequestDiagnostic {
    generation: u64,
    sequence: u64,
    method: &'static str,
    range: Option<(u64, u64)>,
    started: Instant,
    response_started: Option<Instant>,
    headers_complete: bool,
    expected_bytes: Option<u64>,
    written_bytes: u64,
    body_bytes: u64,
    phase: RequestPhase,
    phase_started: Option<Instant>,
    timeout_boundary: TimeoutBoundary,
    authority_ms: u64,
    write_ms: u64,
}
fn bounded_ms(duration: Duration) -> u64 {
    duration.as_millis().min(MAX_LIFE.as_millis()) as u64
}
impl RequestDiagnostic {
    fn new(state: &Arc<Mutex<State>>, request: &Request) -> Self {
        let (generation, sequence) = state.lock().map_or((0, 0), |mut s| {
            s.request_sequence = s.request_sequence.saturating_add(1);
            (s.generation, s.request_sequence)
        });
        Self {
            generation,
            sequence,
            method: if request.options {
                "options"
            } else if request.head {
                "head"
            } else {
                "get"
            },
            range: request.range,
            started: Instant::now(),
            response_started: None,
            headers_complete: false,
            expected_bytes: None,
            written_bytes: 0,
            body_bytes: 0,
            phase: RequestPhase::Admitted,
            phase_started: None,
            timeout_boundary: TimeoutBoundary::None,
            authority_ms: 0,
            write_ms: 0,
        }
    }
    fn begin(&mut self, phase: RequestPhase) {
        self.finish();
        self.phase = phase;
        self.phase_started = Some(Instant::now());
    }
    fn finish(&mut self) {
        if let Some(started) = self.phase_started.take() {
            let elapsed = bounded_ms(started.elapsed());
            let total = match self.phase {
                RequestPhase::Authority => Some(&mut self.authority_ms),
                RequestPhase::SocketWrite | RequestPhase::Headers => Some(&mut self.write_ms),
                _ => None,
            };
            if let Some(total) = total {
                *total = total.saturating_add(elapsed).min(bounded_ms(MAX_LIFE));
            }
        }
    }
    fn line(&mut self, end: RequestEnd, code: Option<&str>, owner_current: bool) -> String {
        self.finish();
        let failure = match code {
            None => "none",
            Some("archive-proxy-write-timeout") => "write-timeout",
            Some("archive-proxy-write-failed") => "write-failed",
            Some("archive-proxy-read-timeout") => "read-timeout",
            Some("archive-proxy-timeout") => "timeout",
            Some("archive-proxy-network") => "network",
            Some("archive-proxy-expired" | "archive-playback-replaced") => "owner-invalid",
            Some(_) => "other",
        };
        let (range_start, range_end) = self.range.unwrap_or((0, 0));
        format!(
            "[GenX archive-request] event={} generation={} request={} method={} has_range={} range_start={} range_end={} written_bytes={} body_bytes={} expected_bytes={} expected_known={} request_age_ms={} response_age_ms={} response_started={} headers_complete={} authority_ms={} write_ms={} phase={} timeout_boundary={} owner_current={} failure={}",
            end.code(), self.generation, self.sequence, self.method, self.range.is_some(),
            range_start, range_end, self.written_bytes, self.body_bytes,
            self.expected_bytes.unwrap_or(0), self.expected_bytes.is_some(),
            bounded_ms(self.started.elapsed()), self.response_started.map_or(0, |at| bounded_ms(at.elapsed())),
            self.response_started.is_some(), self.headers_complete,
            self.authority_ms, self.write_ms, self.phase.code(), self.timeout_boundary.code(), owner_current, failure,
        )
    }
}

struct CountedOutput<'a, W> {
    socket: &'a mut W,
    written: &'a mut u64,
    body_written: &'a mut u64,
    body: bool,
}
impl<W: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for CountedOutput<'_, W> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bytes: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let result = Pin::new(&mut *self.socket).poll_write(cx, bytes);
        if let std::task::Poll::Ready(Ok(count)) = result {
            *self.written = self.written.saturating_add(count as u64);
            if self.body {
                *self.body_written = self.body_written.saturating_add(count as u64);
            }
        }
        result
    }
    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        Pin::new(&mut *self.socket).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        Pin::new(&mut *self.socket).poll_shutdown(cx)
    }
}

async fn observed_authority(
    state: &Arc<Mutex<State>>,
    diagnostic: &mut RequestDiagnostic,
) -> Result<(), String> {
    diagnostic.begin(RequestPhase::Authority);
    let result = authority(state).await;
    if result.as_ref().err().map(String::as_str) == Some("archive-proxy-timeout") {
        diagnostic.timeout_boundary = TimeoutBoundary::Authority;
    }
    diagnostic.finish();
    result
}
async fn observed_output<W: tokio::io::AsyncWrite + Unpin>(
    socket: &mut W,
    bytes: &[u8],
    body: bool,
    diagnostic: &mut RequestDiagnostic,
) -> Result<(), String> {
    diagnostic.begin(if body {
        RequestPhase::SocketWrite
    } else {
        RequestPhase::Headers
    });
    let result = write_output(
        &mut CountedOutput {
            socket,
            written: &mut diagnostic.written_bytes,
            body_written: &mut diagnostic.body_bytes,
            body,
        },
        bytes,
    )
    .await;
    if result.as_ref().err().map(String::as_str) == Some("archive-proxy-write-timeout") {
        diagnostic.timeout_boundary = TimeoutBoundary::Socket;
    }
    diagnostic.finish();
    result
}
// Readiness does not consume or write bytes. Revalidate after it resolves and
// use a nonblocking write, so an authorization made before a long wait cannot
// admit the bytes that resume afterward. A racing WouldBlock preserves offset.
trait BodyOutput {
    fn writable(&self) -> impl Future<Output = std::io::Result<()>> + Send;
    fn try_body_write(&self, bytes: &[u8]) -> std::io::Result<usize>;
}
impl BodyOutput for OwnedWriteHalf {
    fn writable(&self) -> impl Future<Output = std::io::Result<()>> + Send {
        OwnedWriteHalf::writable(self)
    }
    fn try_body_write(&self, bytes: &[u8]) -> std::io::Result<usize> {
        self.try_write(bytes)
    }
}
fn body_owner_current(state: &Arc<Mutex<State>>) -> Result<(), String> {
    if state.lock().map_err(|_| ERR)?.active() {
        Ok(())
    } else {
        Err("archive-proxy-expired".into())
    }
}
async fn observed_remote_chunk<W: BodyOutput + Sync>(
    state: &Arc<Mutex<State>>,
    socket: &W,
    bytes: &[u8],
    diagnostic: &mut RequestDiagnostic,
) -> Result<(), String> {
    let mut offset = 0;
    while offset < bytes.len() {
        body_owner_current(state)?;
        diagnostic.begin(RequestPhase::SocketWrite);
        tokio::select! {biased;
            _=tokio::time::sleep(BODY_AUTHORITY_CHECK)=>{
                diagnostic.finish();
                observed_authority(state, diagnostic).await?;
                body_owner_current(state)?;
                continue;
            }
            ready=socket.writable()=>{
                diagnostic.finish();
                ready.map_err(|_| "archive-proxy-write-failed")?;
            }
        }
        observed_authority(state, diagnostic).await?;
        body_owner_current(state)?;
        diagnostic.begin(RequestPhase::SocketWrite);
        let result = socket.try_body_write(&bytes[offset..]);
        diagnostic.finish();
        match result {
            Ok(0) => return Err("archive-proxy-write-failed".into()),
            Ok(count) => {
                offset += count;
                diagnostic.written_bytes = diagnostic.written_bytes.saturating_add(count as u64);
                diagnostic.body_bytes = diagnostic.body_bytes.saturating_add(count as u64);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => (),
            Err(_) => return Err("archive-proxy-write-failed".into()),
        }
    }
    Ok(())
}
fn parse(bytes: &[u8], s: &State) -> Result<Request, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| ERR)?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next().ok_or(ERR)?.split(' ');
    let method = first.next().ok_or(ERR)?;
    let path = first.next().ok_or(ERR)?;
    let version = first.next().ok_or(ERR)?;
    if !matches!(method, "GET" | "HEAD" | "OPTIONS")
        || path != s.path
        || !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || first.next().is_some()
    {
        return Err(ERR.into());
    }
    let (mut host, mut origin, mut selected, mut cross) = (None, None, None, false);
    let mut seen = std::collections::HashSet::new();
    for line in lines.filter(|s| !s.is_empty()) {
        let (k, v) = line.split_once(':').ok_or(ERR)?;
        let k = k.to_ascii_lowercase();
        let v = v.trim();
        if !seen.insert(k.clone()) {
            return Err(ERR.into());
        }
        match k.as_str() {
            "host" => host = Some(v),
            "origin" => {
                if !cors(v) {
                    return Err(ERR.into());
                }
                origin = Some(v.to_owned());
            }
            "range" => selected = Some(range(v, s.size)?),
            "transfer-encoding" => return Err(ERR.into()),
            "content-length" if v != "0" => return Err(ERR.into()),
            "sec-fetch-site" if v == "cross-site" => cross = true,
            _ => (),
        }
    }
    if host != Some(s.host.as_str()) || (cross && origin.is_none()) {
        return Err(ERR.into());
    }
    Ok(Request {
        range: selected,
        head: method == "HEAD",
        options: method == "OPTIONS",
        origin,
    })
}
async fn read_request(
    socket: &mut OwnedReadHalf,
    state: &Arc<Mutex<State>>,
) -> Result<Request, String> {
    let mut bytes = Vec::new();
    let mut part = [0u8; 1024];
    loop {
        let n = socket.read(&mut part).await.map_err(|_| ERR)?;
        if n == 0 || bytes.len() + n > 8192 {
            return Err(ERR.into());
        }
        bytes.extend_from_slice(&part[..n]);
        if bytes.windows(4).any(|b| b == b"\r\n\r\n") {
            break;
        }
    }
    let end = bytes.windows(4).position(|b| b == b"\r\n\r\n").ok_or(ERR)? + 4;
    if end != bytes.len() {
        return Err(ERR.into());
    }
    let state = state.lock().map_err(|_| ERR)?;
    parse(&bytes, &state)
}
async fn invalidated(state: &Arc<Mutex<State>>) {
    loop {
        if !state.lock().is_ok_and(|s| s.active()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
// The original blocking file read remains in the supervisor's retained task
// list after decoder disconnect, timeout or Cancel; Stop joins its actual end.
async fn local_chunk(
    state: &Arc<Mutex<State>>,
    body: Arc<crate::archive_download_store::LocalBody>,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>, String> {
    reap_finished(state).await?;
    let (send, receive) = oneshot::channel();
    {
        let mut s = state.lock().map_err(|_| ERR)?;
        if !s.active() || s.tasks.len() >= 16 {
            return Err("archive-proxy-work-limit".into());
        }
        s.tasks.push(tokio::spawn(async move {
            let result = tokio::task::spawn_blocking(move || body.read_chunk(offset, length))
                .await
                .unwrap_or_else(|_| Err("archive-download-file-worker-failed".into()));
            let _ = send.send(result);
        }));
    }
    tokio::time::timeout(DEADLINE, receive)
        .await
        .map_err(|_| "archive-proxy-timeout")?
        .map_err(|_| "archive-download-file-worker-failed")?
}
async fn client_inner(
    socket: &mut OwnedWriteHalf,
    state: Arc<Mutex<State>>,
    sent: &mut bool,
    request: Request,
    diagnostic: &mut RequestDiagnostic,
) -> Result<(), String> {
    observed_authority(&state, diagnostic).await?;
    if request.options {
        let origin = request.origin.ok_or(ERR)?;
        let headers=format!("HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        *sent = true;
        diagnostic.response_started = Some(Instant::now());
        observed_output(socket, headers.as_bytes(), false, diagnostic).await?;
        diagnostic.headers_complete = true;
        return Ok(());
    }
    let local = state.lock().map_err(|_| ERR)?.local.clone();
    let size = state.lock().map_err(|_| ERR)?.size;
    let mime = state.lock().map_err(|_| ERR)?.mime;
    let mut response = if local.is_none() {
        diagnostic.begin(RequestPhase::Open);
        Some(
            tokio::time::timeout(DEADLINE, open(&state, request.range, request.head))
                .await
                .map_err(|_| {
                    diagnostic.timeout_boundary = TimeoutBoundary::Open;
                    "archive-proxy-timeout"
                })??,
        )
    } else {
        None
    };
    let length = match &response {
        Some(response) => response_length_for(response, request.range, size, mime)?,
        None => request.range.map_or(size, |(start, end)| end - start + 1),
    };
    diagnostic.expected_bytes = Some(length);
    observed_authority(&state, diagnostic).await?;
    let mut headers=format!("HTTP/1.1 {} OK\r\nContent-Type: {mime}\r\nContent-Length: {length}\r\nAccept-Ranges: bytes\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n",if request.range.is_some(){206}else{200});
    if let Some((start, end)) = request.range {
        headers.push_str(&format!("Content-Range: bytes {start}-{end}/{size}\r\n"));
    }
    if let Some(origin) = request.origin {
        headers.push_str(&format!("Access-Control-Allow-Origin: {origin}\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\nVary: Origin\r\n"));
    }
    headers.push_str("\r\n");
    *sent = true;
    diagnostic.response_started = Some(Instant::now());
    observed_output(socket, headers.as_bytes(), false, diagnostic).await?;
    diagnostic.headers_complete = true;
    if request.head {
        return Ok(());
    }
    if let Some(body) = local {
        let mut offset = request.range.map_or(0, |(start, _)| start);
        let end = offset.checked_add(length).ok_or(ERR)?;
        while offset < end {
            observed_authority(&state, diagnostic).await?;
            diagnostic.begin(RequestPhase::LocalRead);
            let bytes = local_chunk(
                &state,
                body.clone(),
                offset,
                (end - offset).min(CHUNK as u64) as usize,
            )
            .await?;
            observed_remote_chunk(&state, socket, &bytes, diagnostic).await?;
            offset += bytes.len() as u64;
        }
        return Ok(());
    }
    let response = response.as_mut().ok_or(ERR)?;
    let mut delivered = 0u64;
    loop {
        diagnostic.begin(RequestPhase::UpstreamRead);
        let result = read_upstream(response).await;
        if result.as_ref().err().map(String::as_str) == Some("archive-proxy-read-timeout") {
            diagnostic.timeout_boundary = TimeoutBoundary::UpstreamRead;
        }
        let Some(bytes) = result? else {
            break;
        };
        if bytes.len() > CHUNK {
            return Err("archive-proxy-chunk-limit".into());
        }
        delivered = delivered.checked_add(bytes.len() as u64).ok_or(ERR)?;
        if delivered > length {
            return Err("archive-media-size-changed".into());
        }
        for chunk in bytes.chunks(CHUNK) {
            observed_remote_chunk(&state, socket, chunk, diagnostic).await?;
        }
    }
    if delivered != length {
        return Err("archive-media-truncated".into());
    }
    Ok(())
}

// Response headers still require bounded delivery. A buffered VOD decoder's
// body backpressure is handled separately by observed_remote_chunk.
async fn write_output<W: tokio::io::AsyncWrite + Unpin>(
    socket: &mut W,
    bytes: &[u8],
) -> Result<(), String> {
    tokio::time::timeout(DEADLINE, socket.write_all(bytes))
        .await
        .map_err(|_| "archive-proxy-write-timeout")?
        .map_err(|_| "archive-proxy-write-failed".into())
}

async fn read_upstream(response: &mut reqwest::Response) -> Result<Option<bytes::Bytes>, String> {
    tokio::time::timeout(DEADLINE, response.chunk())
        .await
        .map_err(|_| "archive-proxy-read-timeout")?
        .map_err(|error| {
            if error.is_timeout() {
                "archive-proxy-read-timeout"
            } else {
                "archive-proxy-network"
            }
            .into()
        })
}
async fn client(socket: TcpStream, state: Arc<Mutex<State>>, mut cancel: watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    let (mut reader, mut writer) = socket.into_split();
    let request = tokio::select! {biased;_=cancel.changed()=>return,_=invalidated(&state)=>return,
        result=tokio::time::timeout(DEADLINE,read_request(&mut reader,&state))=>{
            match result {Ok(Ok(request))=>request,_=>return}
        }
    };
    let mut diagnostic = RequestDiagnostic::new(&state, &request);
    let owner_current = !*cancel.borrow() && state.lock().is_ok_and(|s| s.active());
    eprintln!(
        "{}",
        diagnostic.line(RequestEnd::Start, None, owner_current)
    );
    let mut sent = false;
    let mut unexpected = [0u8; 1];
    let (end, result) = tokio::select! {biased;_=cancel.changed()=>(RequestEnd::Canceled,None),_=invalidated(&state)=>(RequestEnd::OwnerInvalid,None),
    // Decoder requests have no body/pipelining. EOF or unexpected request
    // bytes release this client promptly, even during an upstream stall.
    read=reader.read(&mut unexpected)=>(match read {
        Ok(0)=>RequestEnd::ConsumerClosed,
        Ok(_)=>RequestEnd::ConsumerInput,
        Err(_)=>RequestEnd::ConsumerReadFailed,
    },None),
    result=client_inner(&mut writer,state.clone(),&mut sent,request,&mut diagnostic)=>{
        (if result.is_ok(){RequestEnd::Complete}else{RequestEnd::Failed},Some(result))
    }};
    let owner_current = !*cancel.borrow() && state.lock().is_ok_and(|s| s.active());
    eprintln!(
        "{}",
        diagnostic.line(
            end,
            result
                .as_ref()
                .and_then(|r| r.as_ref().err())
                .map(String::as_str),
            owner_current
        )
    );
    if let Some(Err(code)) = &result {
        crate::platform::playback_trace::native_failure(
            "genxtra",
            code,
            code.contains("timeout"),
            false,
            sent,
        );
    }

    if result.is_some_and(|r| r.is_err()) && !sent {
        // Never reflect URLs, remote headers or login/error bodies. Once media
        // headers crossed, only close: a second HTTP response would corrupt it.
        let _ = tokio::time::timeout(
            DEADLINE,
            writer.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"),
        )
        .await;
    }
}
async fn serve(
    listener: TcpListener,
    state: Arc<Mutex<State>>,
    stop: watch::Sender<bool>,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    let mut clients = JoinSet::new();
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    let mut failed = false;
    loop {
        tokio::select! {biased;_=cancel.changed()=>break,_=tick.tick()=>{if !state.lock().is_ok_and(|s|s.active()){break;}},
        Some(done)=clients.join_next(),if !clients.is_empty()=>{failed|=done.is_err();},
        incoming=listener.accept()=>{let Ok((socket,peer))=incoming else{break;};
            if peer.ip()==IpAddr::V4(Ipv4Addr::LOCALHOST)&&clients.len()<4&&state.lock().is_ok_and(|s|s.active()){
                clients.spawn(client(socket,state.clone(),cancel.clone()));}}}
    }
    drop(listener);
    let _ = stop.send(true);
    while let Some(done) = clients.join_next().await {
        failed |= done.is_err();
    }
    join_tasks(&state).await?;
    if failed {
        Err("archive-proxy-client-join-failed".into())
    } else {
        Ok(())
    }
}
impl ArchivePlaybackProxy {
    pub(crate) async fn start(
        file: crate::archive_discovery::VerifiedFile,
        generation: u64,
        authorization: Authority,
        alive: Alive,
        startup_ends: Instant,
    ) -> Result<Self, String> {
        if Instant::now() >= startup_ends {
            return Err("archive-proxy-timeout".into());
        }
        let tail = file.expected_tail;
        if file.size_bytes < 16 || file.size_bytes > MAX_FILE {
            return Err(ERR.into());
        }
        if file.public.is_none()
            && (file.allowed_hosts.is_empty()
                || file.allowed_hosts.len() > 4
                || file.allowed_hosts.iter().any(|h| !archive_host(h)))
        {
            return Err("archive-proxy-host-unverified".into());
        }
        if let Some(proof) = &file.public {
            proof.validate(&file.url)?;
        } else {
            validate(&file.url, &file.allowed_hosts, &tail)?;
        }
        let mime = file.mime;
        if !matches!(mime, "video/mp4" | "video/webm") {
            return Err("archive-media-format-unverified".into());
        }
        let extension = if mime == "video/webm" { "webm" } else { "mp4" };
        let path = format!("/archive/{}/{}.{extension}", opaque()?, opaque()?);
        let state = Arc::new(Mutex::new(State {
            target: Some(file.url),
            public: file.public,
            mime,
            local: None,
            allowed_hosts: file.allowed_hosts,
            tail,
            size: file.size_bytes,
            path,
            host: String::new(),
            generation,
            request_sequence: 0,
            started: Instant::now(),
            renewed: Instant::now(),
            authority: authorization,
            alive,
            tasks: vec![],
            join_failed: false,
        }));
        let preflight = async {
            let size = state.lock().map_err(|_| ERR)?.size;
            let extent = (0, size.min(4096) - 1);
            let mut response = open(&state, Some(extent), false).await?;
            let length = response_length_for(&response, Some(extent), size, mime)?;
            let mut prefix = Vec::with_capacity(length as usize);
            while let Some(bytes) = response
                .chunk()
                .await
                .map_err(|_| "archive-proxy-network")?
            {
                if bytes.len() > length as usize - prefix.len() {
                    return Err("archive-media-size-changed".into());
                }
                prefix.extend_from_slice(&bytes);
            }
            let container = if mime == "video/webm" {
                prefix.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
            } else {
                prefix.get(4..8) == Some(b"ftyp")
            };
            if prefix.len() != length as usize || !container {
                return Err("archive-media-container-unverified".into());
            }
            authority(&state).await?;
            Ok::<(), String>(())
        };
        let result = tokio::select! {biased;_=invalidated(&state)=>Err("archive-proxy-expired".into()),
        value=tokio::time::timeout_at(startup_ends,preflight)=>value.unwrap_or_else(|_|Err("archive-proxy-timeout".into()))};
        if let Err(error) = result {
            join_tasks(&state).await?;
            return Err(error);
        }
        if Instant::now() >= startup_ends {
            join_tasks(&state).await?;
            return Err("archive-proxy-timeout".into());
        }
        Self::bind(state, startup_ends).await
    }
    pub(crate) async fn start_local(
        body: crate::archive_download_store::LocalBody,
        generation: u64,
        authorization: Authority,
        alive: Alive,
        startup_ends: Instant,
    ) -> Result<Self, String> {
        if body.size() < 16 || body.size() > MAX_FILE || Instant::now() >= startup_ends {
            return Err("archive-download-file-invalid".into());
        }
        let size = body.size();
        let state = Arc::new(Mutex::new(State {
            target: None,
            public: None,
            mime: "video/mp4",
            local: Some(Arc::new(body)),
            allowed_hosts: vec![],
            tail: String::new(),
            size,
            path: format!("/archive/{}/{}.mp4", opaque()?, opaque()?),
            host: String::new(),
            generation,
            request_sequence: 0,
            started: Instant::now(),
            renewed: Instant::now(),
            authority: authorization,
            alive,
            tasks: vec![],
            join_failed: false,
        }));
        if let Err(error) = authority(&state).await {
            join_tasks(&state).await?;
            return Err(error);
        }
        Self::bind(state, startup_ends).await
    }
    async fn bind(state: Arc<Mutex<State>>, startup_ends: Instant) -> Result<Self, String> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| ERR)?;
        let host = listener.local_addr().map_err(|_| ERR)?.to_string();
        if Instant::now() >= startup_ends {
            drop(listener);
            join_tasks(&state).await?;
            return Err("archive-proxy-timeout".into());
        }
        let media_url = {
            let mut s = state.lock().map_err(|_| ERR)?;
            s.host = host.clone();
            format!("http://{host}{}", s.path)
        };
        let (cancel, received) = watch::channel(false);
        let task = tokio::spawn(serve(listener, state.clone(), cancel.clone(), received));
        Ok(Self {
            state,
            media_url,
            cancel,
            task: Some(task),
            failed: false,
        })
    }
    pub(crate) fn media_url(&self) -> &str {
        &self.media_url
    }
    pub(crate) fn generation(&self) -> Result<u64, String> {
        Ok(self.state.lock().map_err(|_| ERR)?.generation)
    }
    pub(crate) fn needs_cleanup(&self) -> Result<bool, String> {
        Ok(self.failed || !self.state.lock().map_err(|_| ERR)?.active())
    }
    /// Read-only authority for original bookmark workers. Never renews a lease
    /// or takes the playback owner's ACTIVE mutex while Stop joins those workers.
    pub(crate) fn validity_handle(&self) -> Alive {
        validity(self.state.clone(), self.cancel.subscribe())
    }
    pub(crate) async fn renew(&self) -> Result<(), String> {
        authority(&self.state).await?;
        let mut s = self.state.lock().map_err(|_| ERR)?;
        if !s.active() || self.task.as_ref().is_none_or(JoinHandle::is_finished) {
            return Err("archive-proxy-expired".into());
        }
        s.renewed = Instant::now();
        Ok(())
    }
    pub(crate) async fn stop(&mut self) -> Result<(), String> {
        let _ = self.cancel.send(true);
        if self.failed {
            return Err("archive-proxy-stop-unconfirmed".into());
        }
        if let Some(task) = self.task.as_mut() {
            match task.await {
                Ok(Ok(())) => (),
                _ => {
                    self.failed = true;
                    return Err("archive-proxy-stop-unconfirmed".into());
                }
            }
            self.task = None;
        }
        Ok(())
    }
}
impl Drop for ArchivePlaybackProxy {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
    }
}

#[cfg(test)]
pub(crate) fn bookmark_lease_fixture() -> (Alive, impl Fn()) {
    let state = tests::state(Arc::new(|| Box::pin(async { Ok(()) })));
    let (stop, receiver) = watch::channel(false);
    let active = validity(state.clone(), receiver);
    (active, move || {
        state.lock().unwrap().renewed = Instant::now() - LEASE;
        // serve publishes the same cancellation when its active lease expires.
        stop.send(true).unwrap();
    })
}

#[cfg(test)]
#[path = "archive_playback_proxy_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "archive_download_proxy_tests.rs"]
mod download_tests;
