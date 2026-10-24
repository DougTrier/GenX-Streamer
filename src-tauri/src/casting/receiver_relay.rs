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

//! Receiver-scoped HTTP compatibility transport, separate from encrypted LAN viewing.
use super::{private_address, MediaSelection};
use crate::relay as upstream;
use reqwest::Url;
use std::{
    collections::HashMap,
    future::Future,
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    task::{JoinHandle, JoinSet},
};

const LEASE: Duration = Duration::from_secs(60);
const MAX_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);
const RESOURCE_LIFETIME: Duration = Duration::from_secs(180);
const MAX_RESOURCES: usize = 2048;
const MAX_CLIENTS: usize = 4;
const MAX_HEADER: usize = 8192;
type FetchFuture = Pin<Box<dyn Future<Output = Result<upstream::Reply, &'static str>> + Send>>;
type Fetcher = Arc<dyn Fn(Url, Option<String>, bool) -> FetchFuture + Send + Sync>;

#[derive(Clone)]
struct Resource {
    url: Url,
    seen: Instant,
    playlist: bool,
}
struct State {
    resources: HashMap<String, Resource>,
    renewed: Instant,
    started: Instant,
    origin: String,
    receiver: IpAddr,
    allow_http: bool,
    fetch: Fetcher,
    root: String,
    /// GenX's own Android player only: realign audio stamped far from its video.
    align: Option<crate::ts_align::TsAligner>,
}
impl State {
    fn active(&self) -> bool {
        self.renewed.elapsed() < LEASE && self.started.elapsed() < MAX_LIFETIME
    }
    fn issue(&mut self, url: Url) -> Result<String, &'static str> {
        validate_target(&url, self.allow_http)?;
        self.resources.retain(|id, resource| {
            id == &self.root || resource.playlist || resource.seen.elapsed() < RESOURCE_LIFETIME
        });
        if let Some((id, resource)) = self
            .resources
            .iter_mut()
            .find(|(_, resource)| resource.url == url)
        {
            resource.seen = Instant::now();
            return Ok(format!("{}/media/{id}", self.origin));
        }
        if self.resources.len() >= MAX_RESOURCES {
            return Err("cast-relay-resource-limit");
        }
        let id = opaque()?;
        self.resources.insert(
            id.clone(),
            Resource {
                url,
                seen: Instant::now(),
                playlist: false,
            },
        );
        Ok(format!("{}/media/{id}", self.origin))
    }
    fn rewrite(&mut self, manifest: &str, base: &Url) -> Result<String, &'static str> {
        let before = self.resources.clone();
        let result = upstream::rewrite_hls(manifest.trim_start_matches('\u{feff}'), base, |url| {
            self.issue(url)
        });
        if result.is_err() {
            self.resources = before;
        }
        result
    }
}
fn opaque() -> Result<String, &'static str> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| "cast-relay-entropy")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn validate_target(url: &Url, allow_http: bool) -> Result<(), &'static str> {
    upstream::validate_url(url)?;
    if url.as_str().len() > 8192 || (!allow_http && url.scheme() == "http") {
        return Err("cast-relay-source-policy");
    }
    if url
        .host_str()
        .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok())
        .is_some_and(|ip| !crate::sharing_policy::public_upstream(ip))
    {
        return Err("cast-relay-source-policy");
    }
    Ok(())
}

pub struct ReceiverRelay {
    media_url: String,
    state: Arc<Mutex<State>>,
    cancel: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
    join_failed: bool,
}
impl ReceiverRelay {
    pub async fn start(
        receiver: SocketAddr,
        selection: &MediaSelection,
        allow_http_upstream: bool,
        allow_http_receiver: bool,
    ) -> Result<Self, &'static str> {
        if !allow_http_receiver {
            return Err("cast-relay-http-consent-required");
        }
        if !private_address(receiver.ip()) {
            return Err("cast-relay-receiver-refused");
        }
        let url = Url::parse(&selection.url).map_err(|_| "cast-relay-source-invalid")?;
        validate_target(&url, allow_http_upstream)?;
        // UDP connect chooses the route without sending a datagram or probing an
        // unrelated public host. Bind only that selected private LAN interface.
        let route = std::net::UdpSocket::bind(if receiver.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        })
        .map_err(|_| "cast-relay-route-bind")?;
        route.connect(receiver).map_err(|_| "cast-relay-route")?;
        let bind = SocketAddr::new(route.local_addr().map_err(|_| "cast-relay-route")?.ip(), 0);
        if !private_address(bind.ip()) {
            return Err("cast-relay-route-refused");
        }
        let listener = TcpListener::bind(bind)
            .await
            .map_err(|_| "cast-relay-listen")?;
        let origin = format!(
            "http://{}",
            listener.local_addr().map_err(|_| "cast-relay-listen")?
        );
        Self::owned(listener, origin, receiver.ip(), url, allow_http_upstream)
    }
    /// GenX's own Android player on this device: the same scoped relay, bound
    /// to loopback and admitting only this device (live channels whose MPEG-2
    /// picture the web player cannot show; docs/native-vod-player.md).
    pub async fn start_loopback(
        url: &str,
        allow_http_upstream: bool,
    ) -> Result<Self, &'static str> {
        let url = Url::parse(url).map_err(|_| "cast-relay-source-invalid")?;
        validate_target(&url, allow_http_upstream)?;
        let loopback = IpAddr::from([127, 0, 0, 1]);
        let listener = TcpListener::bind(SocketAddr::new(loopback, 0))
            .await
            .map_err(|_| "cast-relay-listen")?;
        let origin = format!(
            "http://{}",
            listener.local_addr().map_err(|_| "cast-relay-listen")?
        );
        let relay = Self::owned(listener, origin, loopback, url, allow_http_upstream)?;
        if let Ok(mut state) = relay.state.lock() {
            state.align = Some(crate::ts_align::TsAligner::default());
        }
        Ok(relay)
    }
    fn owned(
        listener: TcpListener,
        origin: String,
        receiver: IpAddr,
        url: Url,
        allow_http: bool,
    ) -> Result<Self, &'static str> {
        let mut state = State {
            resources: HashMap::new(),
            renewed: Instant::now(),
            started: Instant::now(),
            origin,
            receiver,
            allow_http,
            fetch: Arc::new(|url, range, allow_http| {
                Box::pin(upstream::fetch_with_policy(url, range, allow_http))
            }),
            root: String::new(),
            align: None,
        };
        let media_url = state.issue(url)?;
        state.root = media_url
            .rsplit('/')
            .next()
            .ok_or("cast-relay-resource")?
            .to_owned();
        let state = Arc::new(Mutex::new(state));
        let (cancel, received) = watch::channel(false);
        let task = tokio::spawn(serve(listener, state.clone(), received));
        Ok(Self {
            media_url,
            state,
            cancel,
            task: Some(task),
            join_failed: false,
        })
    }
    pub fn media_url(&self) -> &str {
        &self.media_url
    }
    pub fn renew(&self) -> Result<(), &'static str> {
        let mut state = self.state.lock().map_err(|_| "cast-relay-state")?;
        if !state.active() || self.task.as_ref().is_none_or(JoinHandle::is_finished) {
            return Err("cast-relay-expired");
        }
        state.renewed = Instant::now();
        Ok(())
    }
    pub async fn stop(&mut self) -> Result<(), &'static str> {
        let _ = self.cancel.send(true);
        if self.join_failed {
            return Err("cast-relay-shutdown");
        }
        if let Some(task) = self.task.as_mut() {
            // Cancellation of this waiter must not detach serve's child joins.
            if task.await.is_err() {
                self.join_failed = true;
                return Err("cast-relay-shutdown");
            }
            self.task = None;
        }
        self.state
            .lock()
            .map_err(|_| "cast-relay-shutdown")?
            .resources
            .clear();
        Ok(())
    }
}
impl Drop for ReceiverRelay {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn serve(listener: TcpListener, state: Arc<Mutex<State>>, mut cancel: watch::Receiver<bool>) {
    let mut clients = JoinSet::new();
    let mut expiry = tokio::time::interval(Duration::from_millis(250));
    loop {
        tokio::select! {
            biased;
            _=cancel.changed()=>break,
            _=expiry.tick()=>{
                if !state.lock().is_ok_and(|state|state.active()){break;}
            },
            Some(_)=clients.join_next(), if !clients.is_empty()=>{},
            incoming=listener.accept()=>{
                let Ok((socket,peer))=incoming else {break;};
                let admitted=state.lock().is_ok_and(|state|state.active() && peer.ip()==state.receiver);
                if admitted && clients.len()<MAX_CLIENTS {
                    clients.spawn(client(socket,state.clone(),cancel.clone()));
                }
            }
        }
    }
    clients.abort_all();
    while clients.join_next().await.is_some() {}
    if let Ok(mut state) = state.lock() {
        state.resources.clear();
    }
}
struct Request {
    path: String,
    range: Option<String>,
    head: bool,
    options: bool,
}
fn parse_request(header: &[u8]) -> Result<Request, &'static str> {
    let text = std::str::from_utf8(header).map_err(|_| "request-invalid")?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next().ok_or("request-invalid")?.split(' ');
    let method = first.next().ok_or("request-invalid")?;
    let path = first.next().ok_or("request-invalid")?;
    let version = first.next().ok_or("request-invalid")?;
    if !matches!(method, "GET" | "HEAD" | "OPTIONS")
        || !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || first.next().is_some()
    {
        return Err("request-invalid");
    }
    let Some(id) = path.strip_prefix("/media/") else {
        return Err("resource-not-admitted");
    };
    if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("resource-not-admitted");
    }
    let mut range = None;
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or("request-invalid")?;
        let value = value.trim();
        if name.eq_ignore_ascii_case("range") {
            if range.is_some() || !upstream::validate_range(value) {
                return Err("range-refused");
            }
            range = Some(value.to_owned());
        }
        if name.eq_ignore_ascii_case("transfer-encoding")
            || (name.eq_ignore_ascii_case("content-length") && value != "0")
        {
            return Err("request-body-refused");
        }
    }
    Ok(Request {
        path: path.to_owned(),
        range,
        head: method == "HEAD",
        options: method == "OPTIONS",
    })
}
async fn read_request(socket: &mut TcpStream) -> Result<Request, &'static str> {
    let work = async {
        let mut bytes = Vec::new();
        let mut part = [0; 1024];
        loop {
            let count = socket.read(&mut part).await.map_err(|_| "request-read")?;
            if count == 0 || bytes.len() + count > MAX_HEADER {
                return Err("request-limit");
            }
            bytes.extend_from_slice(&part[..count]);
            if let Some(end) = bytes.windows(4).position(|chunk| chunk == b"\r\n\r\n") {
                if end + 4 != bytes.len() {
                    return Err("request-body-refused");
                }
                return parse_request(&bytes);
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(3), work)
        .await
        .map_err(|_| "request-timeout")?
}
async fn write_reply(
    socket: &mut TcpStream,
    status: u16,
    body: &[u8],
    mime: &str,
    range: Option<&str>,
    retry_after: Option<&str>,
    head: bool,
) -> std::io::Result<()> {
    let mut header=format!("HTTP/1.1 {status} Response\r\nContent-Length: {}\r\nContent-Type: {mime}\r\nConnection: close\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET,HEAD,OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Expose-Headers: Content-Range,Accept-Ranges,Retry-After\r\nAccept-Ranges: bytes\r\n",body.len());
    if let Some(range) = range {
        header.push_str(&format!("Content-Range: {range}\r\n"));
    }
    if let Some(value) = retry_after.filter(|value| !value.contains(['\r', '\n'])) {
        header.push_str(&format!("Retry-After: {value}\r\n"));
    }
    header.push_str("\r\n");
    socket.write_all(header.as_bytes()).await?;
    if !head {
        socket.write_all(body).await?;
    }
    socket.shutdown().await
}
async fn client(
    mut socket: TcpStream,
    state: Arc<Mutex<State>>,
    mut cancel: watch::Receiver<bool>,
) {
    let work = async {
        let request = match read_request(&mut socket).await {
            Ok(request) => request,
            Err(_) => {
                let _ = write_reply(
                    &mut socket,
                    400,
                    b"request-refused",
                    "text/plain",
                    None,
                    None,
                    false,
                )
                .await;
                return;
            }
        };
        let target = state.lock().ok().and_then(|mut state| {
            if !state.active() {
                return None;
            }
            let allow_http = state.allow_http;
            let root = state.root == request.path[7..];
            let resource = state.resources.get_mut(&request.path[7..])?;
            if !root && !resource.playlist && resource.seen.elapsed() >= RESOURCE_LIFETIME {
                return None;
            }
            resource.seen = Instant::now();
            Some((resource.url.clone(), allow_http, state.fetch.clone()))
        });
        let Some((url, allow_http, fetch)) = target else {
            let _ = write_reply(
                &mut socket,
                404,
                b"resource-not-admitted",
                "text/plain",
                None,
                None,
                request.head,
            )
            .await;
            return;
        };
        if request.options {
            let _ = write_reply(&mut socket, 204, b"", "text/plain", None, None, true).await;
            return;
        }
        let ranged = request.range.is_some();
        let reply = fetch(url, request.range, allow_http).await;
        let Ok(mut reply) = reply else {
            let _ = write_reply(
                &mut socket,
                502,
                b"source-unavailable",
                "text/plain",
                None,
                None,
                request.head,
            )
            .await;
            return;
        };
        if (200..300).contains(&reply.status)
            && (reply.body.starts_with(b"#EXTM3U")
                || reply.body.starts_with(b"\xef\xbb\xbf#EXTM3U"))
        {
            if ranged {
                let _ = write_reply(
                    &mut socket,
                    416,
                    b"manifest-range-refused",
                    "text/plain",
                    None,
                    None,
                    request.head,
                )
                .await;
                return;
            }
            let rewritten = std::str::from_utf8(&reply.body)
                .map_err(|_| "manifest-invalid")
                .and_then(|manifest| {
                    let mut state = state.lock().map_err(|_| "cast-relay-state")?;
                    state.rewrite(manifest, &reply.final_url)
                });
            let Ok(rewritten) = rewritten else {
                let _ = write_reply(
                    &mut socket,
                    502,
                    b"manifest-refused",
                    "text/plain",
                    None,
                    None,
                    request.head,
                )
                .await;
                return;
            };
            reply.body = rewritten.into_bytes();
            if let Ok(mut state) = state.lock() {
                if let Some(resource) = state.resources.get_mut(&request.path[7..]) {
                    resource.playlist = true;
                }
            }
            reply.content_type = "application/vnd.apple.mpegurl".into();
            reply.content_range = None;
        }
        if (200..300).contains(&reply.status) && !ranged && reply.content_range.is_none() {
            if let Ok(mut state) = state.lock() {
                if let Some(aligner) = state.align.as_mut() {
                    aligner.apply(&mut reply.body);
                }
            }
        }
        if !(200..300).contains(&reply.status) {
            reply.body = b"source-refused".to_vec();
            reply.content_type = "text/plain".into();
        }
        let _ = write_reply(
            &mut socket,
            reply.status,
            &reply.body,
            &reply.content_type,
            reply.content_range.as_deref(),
            reply.retry_after.as_deref(),
            request.head,
        )
        .await;
    };
    tokio::select! {_=cancel.changed()=>{},_=tokio::time::timeout(Duration::from_secs(25),work)=>{}}
}

#[cfg(test)]
#[path = "receiver_relay_stop_tests.rs"]
mod stop_tests;
#[cfg(test)]
#[path = "receiver_relay_tests.rs"]
mod tests;
