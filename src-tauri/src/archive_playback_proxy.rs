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
) -> Result<(), String> {
    authority(&state).await?;
    if request.options {
        let origin = request.origin.ok_or(ERR)?;
        let headers=format!("HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        *sent = true;
        tokio::time::timeout(DEADLINE, socket.write_all(headers.as_bytes()))
            .await
            .map_err(|_| ERR)?
            .map_err(|_| ERR)?;
        return Ok(());
    }
    let local = state.lock().map_err(|_| ERR)?.local.clone();
    let size = state.lock().map_err(|_| ERR)?.size;
    let mime = state.lock().map_err(|_| ERR)?.mime;
    let mut response = if local.is_none() {
        Some(
            tokio::time::timeout(DEADLINE, open(&state, request.range, request.head))
                .await
                .map_err(|_| "archive-proxy-timeout")??,
        )
    } else {
        None
    };
    let length = match &response {
        Some(response) => response_length_for(response, request.range, size, mime)?,
        None => request.range.map_or(size, |(start, end)| end - start + 1),
    };
    authority(&state).await?;
    let mut headers=format!("HTTP/1.1 {} OK\r\nContent-Type: {mime}\r\nContent-Length: {length}\r\nAccept-Ranges: bytes\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n",if request.range.is_some(){206}else{200});
    if let Some((start, end)) = request.range {
        headers.push_str(&format!("Content-Range: bytes {start}-{end}/{size}\r\n"));
    }
    if let Some(origin) = request.origin {
        headers.push_str(&format!("Access-Control-Allow-Origin: {origin}\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\nVary: Origin\r\n"));
    }
    headers.push_str("\r\n");
    *sent = true;
    tokio::time::timeout(DEADLINE, socket.write_all(headers.as_bytes()))
        .await
        .map_err(|_| ERR)?
        .map_err(|_| ERR)?;
    if request.head {
        return Ok(());
    }
    if let Some(body) = local {
        let mut offset = request.range.map_or(0, |(start, _)| start);
        let end = offset.checked_add(length).ok_or(ERR)?;
        while offset < end {
            authority(&state).await?;
            let bytes = local_chunk(
                &state,
                body.clone(),
                offset,
                (end - offset).min(CHUNK as u64) as usize,
            )
            .await?;
            authority(&state).await?;
            tokio::time::timeout(DEADLINE, socket.write_all(&bytes))
                .await
                .map_err(|_| "archive-proxy-timeout")?
                .map_err(|_| ERR)?;
            offset += bytes.len() as u64;
        }
        return Ok(());
    }
    let response = response.as_mut().ok_or(ERR)?;
    let mut delivered = 0u64;
    while let Some(bytes) = tokio::time::timeout(DEADLINE, response.chunk())
        .await
        .map_err(|_| "archive-proxy-timeout")?
        .map_err(|_| "archive-proxy-network")?
    {
        if bytes.len() > CHUNK {
            return Err("archive-proxy-chunk-limit".into());
        }
        delivered = delivered.checked_add(bytes.len() as u64).ok_or(ERR)?;
        if delivered > length {
            return Err("archive-media-size-changed".into());
        }
        for chunk in bytes.chunks(CHUNK) {
            tokio::time::timeout(DEADLINE, async {
                authority(&state).await?;
                socket.write_all(chunk).await.map_err(|_| ERR.to_owned())
            })
            .await
            .map_err(|_| "archive-proxy-timeout")??;
        }
    }
    if delivered != length {
        return Err("archive-media-truncated".into());
    }
    Ok(())
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
    let mut sent = false;
    let mut unexpected = [0u8; 1];
    let result = tokio::select! {biased;_=cancel.changed()=>None,_=invalidated(&state)=>None,
    // Decoder requests have no body/pipelining. EOF or unexpected request
    // bytes release this client promptly, even during an upstream stall.
    _=reader.read(&mut unexpected)=>None,
    result=client_inner(&mut writer,state.clone(),&mut sent,request)=>Some(result)};
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
mod tests {
    use super::*;
    #[test]
    fn archive_bookmark_validity_follows_expiry_and_stop_after_capture_without_renewal() {
        let s = state(Arc::new(|| Box::pin(async { Ok(()) })));
        let (stop, receiver) = watch::channel(false);
        let check = validity(s.clone(), receiver);
        assert!(check());
        s.lock().unwrap().renewed = Instant::now() - LEASE;
        assert!(!check());
        let before = s.lock().unwrap().renewed;
        assert!(!check());
        assert_eq!(before, s.lock().unwrap().renewed);
        s.lock().unwrap().renewed = Instant::now();
        assert!(check());
        stop.send(true).unwrap();
        assert!(!check());
    }
    pub(super) fn state(authority: Authority) -> Arc<Mutex<State>> {
        Arc::new(Mutex::new(State {
            target: Some(Url::parse("https://archive.org/download/item/file.mp4").unwrap()),
            public: None,
            mime: "video/mp4",
            local: None,
            allowed_hosts: vec!["archive.org".into()],
            tail: "item/file.mp4".into(),
            size: 100,
            path: "/archive/cap/file.mp4".into(),
            host: "127.0.0.1:1234".into(),
            generation: 1,
            started: Instant::now(),
            renewed: Instant::now(),
            authority,
            alive: Arc::new(|| true),
            tasks: vec![],
            join_failed: false,
        }))
    }
    #[test]
    fn decoder_http_requires_exact_capability_host_origin_and_single_range() {
        let state = state(Arc::new(|| Box::pin(async { Ok(()) })));
        let state = state.lock().unwrap();
        let valid =
            b"HEAD /archive/cap/file.mp4 HTTP/1.1\r\nHost: 127.0.0.1:1234\r\nRange: bytes=2-7\r\nOrigin: http://tauri.localhost\r\n\r\n";
        let parsed = parse(valid, &state).unwrap();
        assert!(parsed.head);
        assert_eq!(parsed.range, Some((2, 7)));
        for request in [
            "GET /archive/other/file.mp4 HTTP/1.1\r\nHost: 127.0.0.1:1234\r\n\r\n",
            "GET /archive/cap/file.mp4 HTTP/1.1\r\nHost: example.invalid\r\n\r\n",
            "GET /archive/cap/file.mp4 HTTP/1.1\r\nHost: 127.0.0.1:1234\r\nOrigin: https://example.invalid\r\n\r\n",
            "GET /archive/cap/file.mp4 HTTP/1.1\r\nHost: 127.0.0.1:1234\r\nRange: bytes=0-1,5-6\r\n\r\n",
        ] {
            assert!(parse(request.as_bytes(), &state).is_err());
        }
    }
    #[tokio::test]
    async fn decoder_disconnect_releases_client_and_retains_actual_authority_join() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let released = Arc::new(tokio::sync::Notify::new());
        let signal = entered.clone();
        let wait = released.clone();
        let state = state(Arc::new(move || {
            let signal = signal.clone();
            let wait = wait.clone();
            Box::pin(async move {
                signal.notify_one();
                wait.notified().await;
                Ok(())
            })
        }));
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        state.lock().unwrap().host = address.to_string();
        let mut decoder = TcpStream::connect(address).await.unwrap();
        let (socket, _) = listener.accept().await.unwrap();
        let (_cancel, receiver) = watch::channel(false);
        let live = state.clone();
        let serving = tokio::spawn(async move { client(socket, live, receiver).await });
        decoder
            .write_all(
                format!("GET /archive/cap/file.mp4 HTTP/1.1\r\nHost: {address}\r\n\r\n").as_bytes(),
            )
            .await
            .unwrap();
        entered.notified().await;
        drop(decoder);
        tokio::time::timeout(Duration::from_secs(1), serving)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(state.lock().unwrap().tasks.len(), 1);
        released.notify_one();
        join_tasks(&state).await.unwrap();
        assert!(state.lock().unwrap().tasks.is_empty());
    }
    #[test]
    fn range_requests_are_exact_bounded_and_single() {
        assert_eq!(range("bytes=0-", 100).unwrap(), (0, 99));
        assert_eq!(range("bytes=-20", 100).unwrap(), (80, 99));
        assert_eq!(range("bytes=90-999", 100).unwrap(), (90, 99));
        for raw in [
            "bytes=0-1,4-5",
            "bytes=100-",
            "bytes=-0",
            "bytes=+1-2",
            "bytes=9-2",
        ] {
            assert!(range(raw, 100).is_err());
        }
    }
    #[test]
    fn redirects_require_actual_metadata_host_and_exact_item_file() {
        let hosts = vec!["archive.org".into(), "ia800001.us.archive.org".into()];
        let tail = "item/exact%20file.mp4";
        assert!(validate(
            &Url::parse("https://ia800001.us.archive.org/12/items/item/exact%20file.mp4").unwrap(),
            &hosts,
            tail
        )
        .is_ok());
        for raw in [
            "https://ia800002.us.archive.org/12/items/item/exact%20file.mp4",
            "https://archive.org.evil.invalid/download/item/exact%20file.mp4",
            "https://archive.org/download/item/other.mp4",
            "https://archive.org/download/item/exact%20file.mp4?token=x",
            "http://archive.org/download/item/exact%20file.mp4",
        ] {
            assert!(validate(&Url::parse(raw).unwrap(), &hosts, tail).is_err());
        }
    }
    #[test]
    fn destination_refusals_distinguish_url_host_and_exact_path_without_echoing_data() {
        let hosts = vec!["archive.org".into(), "ia800001.us.archive.org".into()];
        let tail = "item/exact%20file.mp4";
        for (raw, expected) in [
            (
                "http://archive.org/download/item/exact%20file.mp4",
                "archive-proxy-url-refused",
            ),
            (
                "https://archive.org:444/download/item/exact%20file.mp4",
                "archive-proxy-url-refused",
            ),
            (
                "https://private:secret@archive.org/download/item/exact%20file.mp4",
                "archive-proxy-url-refused",
            ),
            (
                "https://archive.org/download/item/exact%20file.mp4?private=secret",
                "archive-proxy-url-refused",
            ),
            (
                "https://archive.org/download/item/exact%20file.mp4#private",
                "archive-proxy-url-refused",
            ),
            (
                "https://ia800002.us.archive.org/12/items/item/exact%20file.mp4",
                "archive-proxy-host-unverified",
            ),
            (
                "https://dn800001.us.archive.org/12/items/item/exact%20file.mp4",
                "archive-proxy-host-unverified",
            ),
            (
                "https://archive.org.evil.invalid/download/item/exact%20file.mp4",
                "archive-proxy-host-unverified",
            ),
            (
                "https://archive.org/download/item/other.mp4",
                "archive-proxy-path-unverified",
            ),
            (
                "https://archive.org/12345/items/item/exact%20file.mp4",
                "archive-proxy-path-unverified",
            ),
            (
                "https://archive.org/12/items/other/exact%20file.mp4",
                "archive-proxy-path-unverified",
            ),
        ] {
            let error = validate(&Url::parse(raw).unwrap(), &hosts, tail).unwrap_err();
            assert_eq!(error, expected);
            assert!(
                !error.contains("secret") && !error.contains("private") && !error.contains("http")
            );
        }
        // Only the exact fresh metadata-listed DN host is admitted.
        assert!(validate(
            &Url::parse("https://dn800001.us.archive.org/items/item/exact%20file.mp4").unwrap(),
            &["dn800001.us.archive.org".into()],
            tail
        )
        .is_ok());
    }
    #[test]
    fn dns_refusals_preserve_whole_answer_public_validation_and_exact_address_cap() {
        let public: SocketAddr = "8.8.8.8:443".parse().unwrap();
        assert_eq!(checked_addresses([public]).unwrap(), vec![public]);
        assert_eq!(
            checked_addresses(std::iter::repeat_n(public, 128))
                .unwrap()
                .len(),
            128
        );
        assert_eq!(
            checked_addresses(std::iter::repeat_n(public, 129)).unwrap_err(),
            "archive-proxy-dns-address-limit"
        );
        assert_eq!(checked_addresses([]).unwrap_err(), "archive-proxy-dns");
        for private in [
            "127.0.0.1:443",
            "10.0.0.1:443",
            "169.254.1.1:443",
            "[::1]:443",
            "[::ffff:192.168.1.1]:443",
        ] {
            assert_eq!(
                checked_addresses([public, private.parse().unwrap()]).unwrap_err(),
                "archive-proxy-dns-private"
            );
        }
    }
    #[test]
    fn response_encoding_refusal_is_distinct_and_does_not_relax_size_range_or_mime() {
        let response = |encoding: Option<&str>| {
            let mut builder = tauri::http::Response::builder()
                .status(206)
                .header("content-type", "video/mp4")
                .header("content-length", "4")
                .header("content-range", "bytes 0-3/100");
            if let Some(value) = encoding {
                builder = builder.header("content-encoding", value);
            }
            reqwest::Response::from(builder.body(reqwest::Body::from(vec![0u8; 4])).unwrap())
        };
        for encoding in [None, Some("identity")] {
            assert_eq!(
                response_length(&response(encoding), Some((0, 3)), 100).unwrap(),
                4
            );
        }
        for encoding in ["gzip", "br", "Identity", "identity, gzip"] {
            assert_eq!(
                response_length(&response(Some(encoding)), Some((0, 3)), 100).unwrap_err(),
                "archive-proxy-response-encoding-unverified"
            );
        }
        assert_eq!(
            response_length(&response(None), Some((0, 4)), 100).unwrap_err(),
            "archive-media-range-unverified"
        );
    }
    #[tokio::test]
    async fn canceled_authority_observer_still_joins_actual_producer() {
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let a = started.clone();
        let b = release.clone();
        let d = done.clone();
        let check: Authority = Arc::new(move || {
            let a = a.clone();
            let b = b.clone();
            let d = d.clone();
            Box::pin(async move {
                a.notify_one();
                b.notified().await;
                d.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
        });
        let state = Arc::new(Mutex::new(State {
            target: Some(Url::parse("https://archive.org/download/item/file.mp4").unwrap()),
            public: None,
            mime: "video/mp4",
            local: None,
            allowed_hosts: vec!["archive.org".into()],
            tail: "item/file.mp4".into(),
            size: 100,
            path: "/archive/cap/file.mp4".into(),
            host: "127.0.0.1:1234".into(),
            generation: 1,
            started: Instant::now(),
            renewed: Instant::now(),
            authority: check,
            alive: Arc::new(|| true),
            tasks: vec![],
            join_failed: false,
        }));
        let observed = state.clone();
        let observer = tokio::spawn(async move { authority(&observed).await });
        started.notified().await;
        observer.abort();
        assert!(observer.await.unwrap_err().is_cancelled());
        assert!(!done.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(state.lock().unwrap().tasks.len(), 1);
        release.notify_one();
        join_tasks(&state).await.unwrap();
        assert!(done.load(std::sync::atomic::Ordering::SeqCst));
        assert!(state.lock().unwrap().tasks.is_empty());
    }
}

#[cfg(test)]
#[path = "archive_download_proxy_tests.rs"]
mod download_tests;
