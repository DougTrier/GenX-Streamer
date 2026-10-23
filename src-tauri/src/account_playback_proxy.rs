//! Local decoder route for vaulted media; never a LAN or casting transport.
//! Only loopback capability URLs leave this module. Secret URLs, provider headers,
//! error bodies and raw manifest metadata remain native. The parent serializes
//! one proxy/decoder generation and awaits stop before replacing or closing it.
use crate::relay;
use reqwest::{redirect::Policy, Url};
use std::{
    collections::HashMap,
    future::Future,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    task::{JoinHandle, JoinSet},
    time::Instant,
};
use zeroize::Zeroizing;

const CLIENT_LIMIT: usize = 4;
const RESOURCE_LIMIT: usize = 2048;
const RESOURCE_BYTES: usize = 4 * 1024 * 1024;
const HEADER_LIMIT: usize = 8192;
const MANIFEST_LIMIT: usize = 2 * 1024 * 1024;
const FINITE_BODY_LIMIT: usize = 32 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;
const RESOURCE_LIFETIME: Duration = Duration::from_secs(180);
const LEASE: Duration = Duration::from_secs(60);
const MAX_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

pub(crate) type AuthorityFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub(crate) type Authority = Arc<dyn Fn() -> AuthorityFuture + Send + Sync>;
/// Called once per start when the provider first answers "busy" (503).
pub(crate) type BusyNotice = Arc<dyn Fn() + Send + Sync>;
/// Called once per live session when real video bytes first reach the player.
pub(crate) type MediaNotice = Arc<dyn Fn() + Send + Sync>;
/// Measurement only (owner request, October 22, 2026): wall-clock times of the
/// latest live start's first request through this relay, so a slow start can
/// be split into provider time and player time. Times and a count only; no
/// addresses, headers or bodies.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartTiming {
    pub generation: u64,
    /// The relay began asking the provider: at session start when the request
    /// was opened ahead of the player, else when the player's request arrived.
    pub request_ms: f64,
    /// The player's first request reached the relay.
    pub player_request_ms: Option<f64>,
    /// The provider was asked at session start, before the player.
    pub preopened: bool,
    /// Redirect chains run again because a stream server did not answer.
    pub fresh_runs: u32,
    /// The provider's response headers arrived (after any "busy" retries).
    pub upstream_headers_ms: Option<f64>,
    /// The provider's first body bytes arrived.
    pub upstream_first_byte_ms: Option<f64>,
    /// The first bytes were written to the player.
    pub player_first_byte_ms: Option<f64>,
    /// How many times the provider answered "busy" (503) first.
    pub busy_retries: u32,
    /// Each request of the answering attempt: the first, then one per redirect.
    pub hops: Vec<HopTiming>,
}
/// One provider request (measurement only). Milliseconds.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HopTiming {
    /// Looking up the host's addresses.
    pub dns_ms: f64,
    /// Opening the connection (TCP, plus TLS for HTTPS); None if it failed.
    pub connect_ms: Option<f64>,
    /// From the open connection to the response headers (the server's wait).
    pub server_wait_ms: f64,
    pub https: bool,
    pub status: u16,
}
const TIMED_HOPS: usize = 12;
static START_TIMING: Mutex<Option<StartTiming>> = Mutex::new(None);
pub(crate) fn start_timing() -> Option<StartTiming> {
    START_TIMING.lock().ok().and_then(|timing| timing.clone())
}
fn elapsed_ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}
/// Times the client's connector (a pass-through layer; measurement only).
#[derive(Clone)]
struct ConnectTiming(Arc<Mutex<Option<f64>>>);
impl<S> tower_layer::Layer<S> for ConnectTiming {
    type Service = TimedConnect<S>;
    fn layer(&self, inner: S) -> Self::Service {
        TimedConnect {
            inner,
            out: self.0.clone(),
        }
    }
}
#[derive(Clone)]
struct TimedConnect<S> {
    inner: S,
    out: Arc<Mutex<Option<f64>>>,
}
impl<S, R> tower_service::Service<R> for TimedConnect<S>
where
    S: tower_service::Service<R>,
    S::Future: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<S::Response, S::Error>> + Send>>;
    fn poll_ready(
        &mut self,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), S::Error>> {
        self.inner.poll_ready(cx)
    }
    fn call(&mut self, request: R) -> Self::Future {
        let started = Instant::now();
        let out = self.out.clone();
        let connecting = self.inner.call(request);
        Box::pin(async move {
            let connected = connecting.await;
            if connected.is_ok() {
                if let Ok(mut out) = out.lock() {
                    out.get_or_insert(elapsed_ms(started));
                }
            }
            connected
        })
    }
}
fn unix_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}
/// Opens the record for a session's first live request; later requests of the
/// same session (reconnects) leave it alone. True when this request opened it.
fn open_start_timing(generation: u64, request_ms: f64) -> bool {
    START_TIMING.lock().is_ok_and(|mut timing| {
        if timing.as_ref().is_some_and(|t| t.generation == generation) {
            return false;
        }
        *timing = Some(StartTiming {
            generation,
            request_ms,
            ..StartTiming::default()
        });
        true
    })
}
/// Updates the record of the session that is timing (`timed` names it), never
/// a newer session's record.
fn time_start(timed: Option<u64>, update: impl FnOnce(&mut StartTiming)) {
    let Some(generation) = timed else {
        return;
    };
    if let Ok(mut timing) = START_TIMING.lock() {
        if let Some(timing) = timing.as_mut().filter(|t| t.generation == generation) {
            update(timing);
        }
    }
}
/// How long a live channel's first request waits out a busy provider. One-
/// connection providers keep counting a just-closed stream for well over 15 s.
const LIVE_BUSY_WINDOW: Duration = Duration::from_secs(30);
/// A live start's servers reached through a redirect (the provider's stream
/// servers) normally answer in 0.15-0.8 s; one that has not answered in 2 s is
/// treated as not answering, and the chain runs once more from the start
/// (owner request, October 22, 2026; measured: a dead server held a start for
/// 4.9 s before the whole session was retried).
const STREAM_SERVER_ANSWER: Duration = Duration::from_secs(2);
/// Internal outcome of a chain whose stream server did not answer in time.
const STALLED: &str = "account-proxy-stream-server-stalled";
/// A provider answer opened at session start is handed to the player's first
/// request only while fresh; the player normally asks about 0.6 s later.
const PREOPEN_FRESH: Duration = Duration::from_secs(5);
/// The provider's answer to a live session's first request, opened when the
/// session starts instead of when the player first asks.
type Preopened = Result<(reqwest::Response, Instant), &'static str>;
type PreopenWork = Pin<Box<dyn Future<Output = ()> + Send>>;
/// Delay before retrying a 503, or None to give up. A live channel's first
/// request retries with backoff capped at 3 s while the window leaves room for
/// another attempt; anything else keeps the original three short retries.
fn busy_delay(attempt: u64, live_start: bool, remaining: Duration) -> Option<Duration> {
    let step = Duration::from_millis(500 + 1000 * (attempt + 1));
    if !live_start {
        return (attempt < 3).then_some(step);
    }
    let step = step.min(Duration::from_secs(3));
    (remaining > step + Duration::from_secs(1)).then_some(step)
}
#[derive(Clone)]
struct Resource {
    url: Zeroizing<String>,
    seen: Instant,
    playlist: bool,
}
struct State {
    resources: HashMap<String, Resource>,
    groups: HashMap<String, String>,
    root: String,
    capability: String,
    local_origin: String,
    authorized_origin: String,
    /// Servers the provider itself redirected playback to (load balancers), bounded.
    media_origins: Vec<String>,
    started: Instant,
    renewed: Instant,
    generation: u64,
    authority: Authority,
    authorities: Vec<JoinHandle<()>>,
    busy: Option<BusyNotice>,
    /// Taken (so called once) when verified video is first sent.
    on_media: Option<MediaNotice>,
    /// When the account's authority was last confirmed (see `authority`).
    verified: Option<Instant>,
    /// A movie or episode session: video file bodies stream without the
    /// finite size cap or whole-response deadline (each read stays bounded).
    vod: bool,
    /// The container recognized from the start of this VOD file, reused for
    /// later byte ranges (a seek's first bytes are mid-file).
    vod_kind: Option<&'static str>,
    /// A live session's provider answer opened at start, taken once by the
    /// player's first request (see `PREOPEN_FRESH`).
    preopen: Option<tokio::sync::oneshot::Receiver<Preopened>>,
}
impl State {
    fn active(&self) -> bool {
        self.renewed.elapsed() < LEASE && self.started.elapsed() < MAX_LIFETIME
    }
    fn admits(&self, url: &Url) -> bool {
        validate(url, &self.authorized_origin).is_ok()
            || self.media_origins.iter().any(|o| validate(url, o).is_ok())
    }
    fn issue(&mut self, url: Url) -> Result<String, &'static str> {
        if !self.admits(&url) {
            // A server the provider's own playlist names (Xtream load balancers
            // put segments on another host) is trusted like its redirects:
            // public only, never a downgrade, nothing added, bounded per session.
            redirect_target(&url, &self.authorized_origin)
                .map_err(|_| "account-proxy-source-refused")?;
            if self.media_origins.len() >= 8 {
                return Err("account-proxy-resource-limit");
            }
            self.media_origins.push(url.origin().ascii_serialization());
        }
        let root = &self.root;
        self.resources
            .retain(|id, r| id == root || r.playlist || r.seen.elapsed() < RESOURCE_LIFETIME);
        if let Some((id, r)) = self
            .resources
            .iter_mut()
            .find(|(_, r)| r.url.as_str() == url.as_str())
        {
            r.seen = Instant::now();
            return Ok(format!(
                "{}/account/{}/media/{id}",
                self.local_origin, self.capability
            ));
        }
        let bytes: usize = self.resources.values().map(|r| r.url.len()).sum();
        if self.resources.len() >= RESOURCE_LIMIT
            || url.as_str().len() > RESOURCE_BYTES.saturating_sub(bytes)
        {
            return Err("account-proxy-resource-limit");
        }
        let id = opaque()?;
        self.resources.insert(
            id.clone(),
            Resource {
                url: Zeroizing::new(url.to_string()),
                seen: Instant::now(),
                playlist: false,
            },
        );
        Ok(format!(
            "{}/account/{}/media/{id}",
            self.local_origin, self.capability
        ))
    }
    fn group(&mut self, value: &str) -> Result<String, &'static str> {
        if value.is_empty() || value.len() > 1024 {
            return Err("account-proxy-manifest-invalid");
        }
        if let Some(id) = self.groups.get(value) {
            return Ok(id.clone());
        }
        if self.groups.len() >= 256 {
            return Err("account-proxy-resource-limit");
        }
        let id = opaque()?;
        self.groups.insert(value.to_owned(), id.clone());
        Ok(id)
    }
    fn rewrite(&mut self, manifest: &str, base: &Url) -> Result<String, &'static str> {
        let resources = self.resources.clone();
        let groups = self.groups.clone();
        let origins = self.media_origins.clone();
        let result = (|| {
            let cleaned = clean_manifest(manifest, self)?;
            relay::rewrite_hls(&cleaned, base, |url| self.issue(url))
        })();
        if result.is_err() {
            self.resources = resources;
            self.groups = groups;
            self.media_origins = origins;
        }
        result
    }
}
fn opaque() -> Result<String, &'static str> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "account-proxy-entropy")?;
    Ok(bytes.iter().map(|v| format!("{v:02x}")).collect())
}
fn valid_cap(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
/// A provider-issued redirect may move playback to another public server (Xtream
/// load balancers do this). The app adds no credentials to it, and an HTTPS
/// account is never downgraded to plain HTTP.
fn redirect_target(url: &Url, authorized: &str) -> Result<(), &'static str> {
    if !authorized.starts_with("http://") && url.scheme() != "https" {
        return Err("account-proxy-redirect-refused");
    }
    validate(url, &url.origin().ascii_serialization())
}
/// Upstream addresses the relay may reach: public ones only. This crate's own
/// tests may add a loopback port they registered (a controlled fixture
/// provider); release and debug builds never compile that exception.
fn upstream_admitted(ip: IpAddr, port: u16) -> bool {
    crate::sharing_policy::public_upstream(ip) || fixture_upstream(ip, port)
}
#[cfg(not(test))]
fn fixture_upstream(_: IpAddr, _: u16) -> bool {
    false
}
#[cfg(test)]
static FIXTURE_PORTS: Mutex<Vec<u16>> = Mutex::new(Vec::new());
#[cfg(test)]
fn fixture_upstream(ip: IpAddr, port: u16) -> bool {
    ip.is_loopback()
        && FIXTURE_PORTS
            .lock()
            .is_ok_and(|ports| ports.contains(&port))
}
fn validate(url: &Url, origin: &str) -> Result<(), &'static str> {
    relay::validate_url(url).map_err(|_| "account-proxy-source-refused")?;
    // Scheme is pinned by the account's stored origin (HTTP only by explicit grant).
    if url.as_str().len() > 16_384
        || !matches!(url.scheme(), "https" | "http")
        || url.fragment().is_some()
        || url.origin().ascii_serialization() != origin
    {
        return Err("account-proxy-source-refused");
    }
    if url
        .host_str()
        .and_then(|h| h.trim_matches(['[', ']']).parse::<IpAddr>().ok())
        .is_some_and(|ip| !upstream_admitted(ip, url.port_or_known_default().unwrap_or(0)))
    {
        return Err("account-proxy-source-refused");
    }
    Ok(())
}

pub(crate) struct AccountPlaybackProxy {
    media_url: String,
    state: Arc<Mutex<State>>,
    cancel: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
    join_failed: bool,
}
impl AccountPlaybackProxy {
    pub(crate) async fn start(
        secret_url: Zeroizing<String>,
        authorized_origin: String,
        generation: u64,
        authority: Authority,
        vod: bool,
        busy: Option<BusyNotice>,
        on_media: Option<MediaNotice>,
    ) -> Result<Self, String> {
        authority().await?;
        let target = Url::parse(&secret_url).map_err(|_| "account-proxy-source-refused")?;
        validate(&target, &authorized_origin).map_err(str::to_owned)?;
        let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .map_err(|_| "account-proxy-listen")?;
        let local_origin = format!(
            "http://{}",
            listener.local_addr().map_err(|_| "account-proxy-listen")?
        );
        let mut state = State {
            resources: HashMap::new(),
            groups: HashMap::new(),
            root: String::new(),
            capability: opaque().map_err(str::to_owned)?,
            local_origin,
            authorized_origin,
            media_origins: Vec::new(),
            started: Instant::now(),
            renewed: Instant::now(),
            generation,
            authority,
            authorities: Vec::new(),
            busy,
            on_media,
            verified: None,
            vod,
            vod_kind: None,
            preopen: None,
        };
        let root_target = target.clone();
        let media_url = state.issue(target).map_err(str::to_owned)?;
        state.root = media_url
            .rsplit('/')
            .next()
            .ok_or("account-proxy-resource-limit")?
            .to_owned();
        (state.authority)().await?;
        let answer = if vod {
            None
        } else {
            let (answer, taken) = tokio::sync::oneshot::channel();
            state.preopen = Some(taken);
            Some(answer)
        };
        let state = Arc::new(Mutex::new(state));
        let (cancel, received) = watch::channel(false);
        let preopen =
            answer.map(|answer| preopen(state.clone(), root_target, answer, received.clone()));
        let task = tokio::spawn(serve(
            listener,
            state.clone(),
            cancel.clone(),
            received,
            preopen,
        ));
        Ok(Self {
            media_url,
            state,
            cancel,
            task: Some(task),
            join_failed: false,
        })
    }
    pub(crate) fn media_url(&self) -> &str {
        &self.media_url
    }
    pub(crate) fn generation(&self) -> Result<u64, String> {
        self.state
            .lock()
            .map(|s| s.generation)
            .map_err(|_| "account-proxy-state".into())
    }
    pub(crate) fn renew(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "account-proxy-state")?;
        if !state.active() || self.task.as_ref().is_none_or(JoinHandle::is_finished) {
            return Err("account-proxy-expired".into());
        }
        state.renewed = Instant::now();
        Ok(())
    }
    pub(crate) async fn stop(&mut self) -> Result<(), String> {
        let _ = self.cancel.send(true);
        if self.join_failed {
            return Err("account-proxy-shutdown".into());
        }
        if let Some(task) = self.task.as_mut() {
            // Retain the JoinHandle if this observer is canceled during await.
            if task.await.is_err() {
                self.join_failed = true;
                return Err("account-proxy-shutdown".into());
            }
            self.task = None;
        }
        let mut state = self.state.lock().map_err(|_| "account-proxy-state")?;
        state.resources.clear();
        state.groups.clear();
        Ok(())
    }
}
impl Drop for AccountPlaybackProxy {
    fn drop(&mut self) {
        // Supervisor remains retained by Tokio to cancel and JOIN its clients;
        // dropping the observer is not reported as a completed stop operation.
        let _ = self.cancel.send(true);
    }
}
/// A live channel asks the provider when its session starts, while the player
/// is still being prepared (owner request, October 22, 2026: the player's
/// request arrives about 0.6 s after the session, and the provider takes about
/// 1.4 s to answer). Runs under the relay's supervisor, which joins it on stop;
/// the player's first request takes the answer (one provider connection).
fn preopen(
    state: Arc<Mutex<State>>,
    target: Url,
    answer: tokio::sync::oneshot::Sender<Preopened>,
    mut cancel: watch::Receiver<bool>,
) -> PreopenWork {
    Box::pin(async move {
        let work = async {
            let (generation, allowed, busy) = {
                let s = state.lock().map_err(|_| "account-proxy-state")?;
                (
                    s.generation,
                    vec![s.authorized_origin.clone()],
                    s.busy.clone(),
                )
            };
            let timed = open_start_timing(generation, unix_ms()).then_some(generation);
            time_start(timed, |t| t.preopened = true);
            let deadline = Instant::now() + LIVE_BUSY_WINDOW;
            let response = open_waiting(
                &state,
                &target,
                None,
                &allowed,
                deadline,
                true,
                busy.as_ref(),
                timed,
            )
            .await?;
            Ok((response, Instant::now()))
        };
        tokio::select! { biased;
            _ = cancel.changed() => {},
            opened = work => { let _ = answer.send(opened); },
        }
    })
}
async fn serve(
    listener: TcpListener,
    state: Arc<Mutex<State>>,
    stop: watch::Sender<bool>,
    mut cancel: watch::Receiver<bool>,
    preopen: Option<PreopenWork>,
) {
    let mut clients = JoinSet::new();
    if let Some(work) = preopen {
        clients.spawn(work);
    }
    let mut expiry = tokio::time::interval(Duration::from_millis(250));
    loop {
        tokio::select! { biased;
            _=cancel.changed()=>break,
            _=expiry.tick()=> { if !state.lock().is_ok_and(|s|s.active()) {break;} },
            Some(_)=clients.join_next(),if !clients.is_empty()=>{},
            incoming=listener.accept()=> {
                let Ok((socket,peer))=incoming else {break;};
                if peer.ip()==IpAddr::V4(Ipv4Addr::LOCALHOST) && clients.len()<CLIENT_LIMIT
                    && state.lock().is_ok_and(|s|s.active()) {
                    clients.spawn(client(socket,state.clone(),cancel.clone()));
                }
            }
        }
    }
    let _ = stop.send(true);
    // Every client has a watch receiver, so ordinary cancellation completes its
    // current async operation by dropping request/socket ownership, then joins.
    while clients.join_next().await.is_some() {}
    let authorities = state
        .lock()
        .map(|mut s| std::mem::take(&mut s.authorities))
        .unwrap_or_default();
    // Dropping a client's callback observer cannot abandon native SQLite work.
    for task in authorities {
        let _ = task.await;
    }
    if let Ok(mut s) = state.lock() {
        s.resources.clear();
        s.groups.clear();
    }
}
fn cors(value: &str) -> bool {
    matches!(
        value,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) || (cfg!(debug_assertions) && value == "http://localhost:1420")
}
struct Request {
    id: String,
    range: Option<String>,
    head: bool,
    options: bool,
    origin: Option<String>,
}
fn parse_request(bytes: &[u8], state: &State) -> Result<Request, &'static str> {
    let text = std::str::from_utf8(bytes).map_err(|_| "account-proxy-request-refused")?;
    let mut lines = text.split("\r\n");
    let mut first = lines
        .next()
        .ok_or("account-proxy-request-refused")?
        .split(' ');
    let method = first.next().ok_or("account-proxy-request-refused")?;
    let path = first.next().ok_or("account-proxy-request-refused")?;
    let version = first.next().ok_or("account-proxy-request-refused")?;
    if !matches!(method, "GET" | "HEAD" | "OPTIONS")
        || !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || first.next().is_some()
    {
        return Err("account-proxy-request-refused");
    }
    let prefix = format!("/account/{}/media/", state.capability);
    let id = path
        .strip_prefix(&prefix)
        .filter(|v| valid_cap(v))
        .ok_or("account-proxy-resource-refused")?;
    let mut host = None;
    let mut origin = None;
    let mut range = None;
    let mut cross_site = false;
    for line in lines.filter(|line| !line.is_empty()) {
        let (key, value) = line
            .split_once(':')
            .ok_or("account-proxy-request-refused")?;
        let value = value.trim();
        if key.eq_ignore_ascii_case("host") {
            if host.replace(value).is_some() {
                return Err("account-proxy-request-refused");
            }
        }
        if key.eq_ignore_ascii_case("origin") {
            if origin.is_some() || !cors(value) {
                return Err("account-proxy-origin-refused");
            }
            origin = Some(value.to_owned());
        }
        if key.eq_ignore_ascii_case("range") {
            if range.is_some() || !relay::validate_range(value) {
                return Err("account-proxy-range-refused");
            }
            range = Some(value.to_owned());
        }
        if key.eq_ignore_ascii_case("transfer-encoding")
            || (key.eq_ignore_ascii_case("content-length") && value != "0")
        {
            return Err("account-proxy-request-refused");
        }
        if key.eq_ignore_ascii_case("sec-fetch-site") && value == "cross-site" {
            cross_site = true;
        }
    }
    if cross_site && origin.is_none() {
        return Err("account-proxy-origin-refused");
    }
    if host != state.local_origin.strip_prefix("http://") {
        return Err("account-proxy-host-refused");
    }
    Ok(Request {
        id: id.to_owned(),
        range,
        head: method == "HEAD",
        options: method == "OPTIONS",
        origin,
    })
}
async fn read_request(
    socket: &mut TcpStream,
    state: &Arc<Mutex<State>>,
) -> Result<Request, &'static str> {
    let work = async {
        let mut bytes = Vec::new();
        let mut part = [0u8; 1024];
        loop {
            let n = socket
                .read(&mut part)
                .await
                .map_err(|_| "account-proxy-request-refused")?;
            if n == 0 || bytes.len() + n > HEADER_LIMIT {
                return Err("account-proxy-request-refused");
            }
            bytes.extend_from_slice(&part[..n]);
            if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                if end + 4 != bytes.len() {
                    return Err("account-proxy-request-refused");
                }
                let captured = state.lock().map_err(|_| "account-proxy-state")?;
                return parse_request(&bytes, &captured);
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(3), work)
        .await
        .map_err(|_| "account-proxy-request-refused")?
}
/// How long a confirmed authority stands. The relay asks before every read
/// and every 64 KB written; confirming each time was a database transaction
/// per chunk, which on a TV throttled every paid channel below real time.
/// Removal or an edit of the account still stops playback within this.
const AUTHORITY_INTERVAL: Duration = Duration::from_secs(2);
async fn authority(state: &Arc<Mutex<State>>) -> Result<(), &'static str> {
    let received = {
        let mut s = state.lock().map_err(|_| "account-proxy-state")?;
        if !s.active() {
            return Err("account-proxy-expired");
        }
        if s.verified.is_some_and(|at| at.elapsed() < AUTHORITY_INTERVAL) {
            s.renewed = Instant::now();
            return Ok(());
        }
        s.authorities.retain(|task| !task.is_finished());
        if s.authorities.len() >= 16 {
            return Err("account-proxy-authority-limit");
        }
        let callback = s.authority.clone();
        let (sent, received) = tokio::sync::oneshot::channel();
        s.authorities.push(tokio::spawn(async move {
            let result = callback().await.map_err(|_| "account-proxy-revoked");
            let _ = sent.send(result);
        }));
        received
    };
    received.await.map_err(|_| "account-proxy-revoked")??;
    let mut s = state.lock().map_err(|_| "account-proxy-state")?;
    if !s.active() {
        return Err("account-proxy-expired");
    }
    // Actual authorized decoder traffic renews the local lease, including a
    // continuous TS response. Paused/background owners may stop explicitly.
    s.renewed = Instant::now();
    s.verified = Some(Instant::now());
    Ok(())
}
/// One request to the provider, waiting out "busy". Providers with a
/// connection limit keep counting the previous stream after a channel change
/// and answer 503 meanwhile. A live channel's first request waits that out
/// (see `busy_delay`); a stop or newer channel ends this task, and every other
/// status fails at once.
#[allow(clippy::too_many_arguments)]
async fn open_waiting(
    state: &Arc<Mutex<State>>,
    target: &Url,
    range: Option<String>,
    allowed: &[String],
    deadline: Instant,
    live_start: bool,
    busy: Option<&BusyNotice>,
    timed: Option<u64>,
) -> Result<reqwest::Response, &'static str> {
    let mut attempt = 0u64;
    let response = tokio::time::timeout_at(deadline, async {
        loop {
            match open(
                target.clone(),
                range.clone(),
                allowed,
                deadline,
                timed,
                live_start,
            )
            .await
            {
                Err("account-proxy-upstream-503") => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    let Some(delay) = busy_delay(attempt, live_start, remaining) else {
                        break Err("account-proxy-upstream-503");
                    };
                    if attempt == 0 && live_start {
                        if let Some(notice) = busy {
                            notice();
                        }
                    }
                    attempt += 1;
                    tokio::time::sleep(delay).await;
                    authority(state).await?;
                }
                other => break other,
            }
        }
    })
    .await
    .map_err(|_| "account-proxy-timeout")??;
    time_start(timed, |t| {
        t.upstream_headers_ms = Some(unix_ms());
        t.busy_retries = u32::try_from(attempt).unwrap_or(u32::MAX);
    });
    Ok(response)
}
/// The provider's answer through its redirects. A live start whose stream
/// server does not answer in time runs the chain once more from the start.
async fn open(
    url: Url,
    range: Option<String>,
    allowed: &[String],
    deadline: Instant,
    timed: Option<u64>,
    live_start: bool,
) -> Result<reqwest::Response, &'static str> {
    // A busy retry starts over: the hops kept are the answering attempt's.
    time_start(timed, |t| t.hops.clear());
    let first = open_chain(
        url.clone(),
        range.clone(),
        allowed,
        deadline,
        timed,
        live_start,
    )
    .await;
    let outcome = match first {
        Err(code) if code == STALLED => {
            time_start(timed, |t| t.fresh_runs += 1);
            open_chain(url, range, allowed, deadline, timed, live_start).await
        }
        other => other,
    };
    match outcome {
        Err(code) if code == STALLED => Err("account-proxy-timeout"),
        other => other,
    }
}
async fn open_chain(
    mut url: Url,
    range: Option<String>,
    allowed: &[String],
    deadline: Instant,
    timed: Option<u64>,
    live_start: bool,
) -> Result<reqwest::Response, &'static str> {
    let authorized = allowed.first().ok_or("account-proxy-source-refused")?;
    if !allowed.iter().any(|o| validate(&url, o).is_ok()) {
        return Err("account-proxy-source-refused");
    }
    for redirect in 0..=5 {
        if redirect > 0 {
            redirect_target(&url, authorized)?;
        }
        let host = url.host_str().ok_or("account-proxy-source-refused")?;
        let port = url
            .port_or_known_default()
            .ok_or("account-proxy-source-refused")?;
        let looked_up = Instant::now();
        let mut addresses = Vec::new();
        for mut address in crate::network::resolve_for_playback(host)
            .await
            .ok_or("account-proxy-network-failed")?
        {
            if addresses.len() >= 128 || !upstream_admitted(address.ip(), port) {
                return Err("account-proxy-source-refused");
            }
            address.set_port(port);
            addresses.push(address);
        }
        if addresses.is_empty() {
            return Err("account-proxy-network-failed");
        }
        let dns_ms = elapsed_ms(looked_up);
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("account-proxy-timeout");
        }
        let connect_ms = Arc::new(Mutex::new(None));
        let builder = if timed.is_some() {
            reqwest::Client::builder().connector_layer(ConnectTiming(connect_ms.clone()))
        } else {
            reqwest::Client::builder()
        };
        let client = builder
            .no_proxy()
            .redirect(Policy::none())
            .resolve_to_addrs(host, &addresses)
            .connect_timeout(remaining.min(Duration::from_secs(5)))
            .read_timeout(Duration::from_secs(5))
            .user_agent("TMG-TV/0.1")
            .build()
            .map_err(|_| "account-proxy-network-failed")?;
        // No whole-body timeout for an explicitly recognized continuous TS
        // stream. Startup, finite resources, each read, and writes stay bounded.
        let mut request = client.get(url.clone());
        if let Some(value) = &range {
            request = request.header(reqwest::header::RANGE, value);
        }
        let sent = Instant::now();
        // A live start's stream server (reached through a redirect) must
        // answer within `STREAM_SERVER_ANSWER`; None means it did not.
        let answered = if live_start && redirect > 0 {
            tokio::time::timeout(STREAM_SERVER_ANSWER, request.send())
                .await
                .ok()
        } else {
            Some(request.send().await)
        };
        if timed.is_some() {
            let connect_ms = connect_ms.lock().ok().and_then(|c| *c);
            let hop = HopTiming {
                dns_ms,
                connect_ms,
                server_wait_ms: (elapsed_ms(sent) - connect_ms.unwrap_or(0.0)).max(0.0),
                https: url.scheme() == "https",
                status: answered
                    .as_ref()
                    .and_then(|r| r.as_ref().ok())
                    .map_or(0, |r| r.status().as_u16()),
            };
            time_start(timed, |t| {
                if t.hops.len() < TIMED_HOPS {
                    t.hops.push(hop);
                }
            });
        }
        let response = answered
            .ok_or(STALLED)?
            .map_err(|_| "account-proxy-network-failed")?;
        if response.status().is_redirection() {
            if redirect == 5 {
                return Err("account-proxy-redirect-refused");
            }
            let raw = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .filter(|v| v.len() <= 16_384)
                .ok_or("account-proxy-redirect-refused")?;
            let next = url
                .join(raw)
                .map_err(|_| "account-proxy-redirect-refused")?;
            redirect_target(&next, authorized)?;
            url = next;
            continue;
        }
        if !matches!(response.status().as_u16(), 200 | 206) {
            // Fixed codes per common status keep provider refusals diagnosable.
            return Err(match response.status().as_u16() {
                401 => "account-proxy-upstream-401",
                403 => "account-proxy-upstream-403",
                404 => "account-proxy-upstream-404",
                405 => "account-proxy-upstream-405",
                406 => "account-proxy-upstream-406",
                429 => "account-proxy-upstream-429",
                458 => "account-proxy-upstream-458",
                500 => "account-proxy-upstream-500",
                502 => "account-proxy-upstream-502",
                503 => "account-proxy-upstream-503",
                509 => "account-proxy-upstream-509",
                _ => "account-proxy-upstream-refused",
            });
        }
        return Ok(response);
    }
    Err("account-proxy-redirect-refused")
}
fn mime(response: &reqwest::Response) -> &'static str {
    let raw = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    match raw
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "application/vnd.apple.mpegurl"
        | "application/x-mpegurl"
        | "audio/mpegurl"
        | "audio/x-mpegurl" => "application/vnd.apple.mpegurl",
        "video/mp2t" => "video/mp2t",
        "video/mp4" => "video/mp4",
        "video/x-matroska" => "video/x-matroska",
        "video/webm" => "video/webm",
        "audio/mp4" => "audio/mp4",
        "audio/aac" => "audio/aac",
        "audio/mpeg" => "audio/mpeg",
        "text/html" | "application/json" | "text/xml" | "application/xml" => "refused",
        _ => "application/octet-stream",
    }
}
/// Video container from its first bytes (Matroska/WebM, MP4, MPEG-TS), never
/// from a server label. None means "not a video file" (for example an error page).
/// Relay trace for diagnosing provider replies: debug builds only, and only when
/// GENX_RELAY_DIAG names a file. Records status, type and leading-byte facts,
/// never addresses, credentials or bodies.
fn diag(line: std::fmt::Arguments) {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("GENX_RELAY_DIAG") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(f, "{} {}", now_ms(), line);
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = line;
}
fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
fn sniff_video(prefix: &[u8]) -> Option<&'static str> {
    if prefix.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        Some("video/x-matroska")
    } else if prefix.len() >= 8 && &prefix[4..8] == b"ftyp" {
        Some("video/mp4")
    } else if prefix.len() >= 377 && prefix[0] == 0x47 && prefix[188] == 0x47 && prefix[376] == 0x47
    {
        Some("video/mp2t")
    } else {
        None
    }
}

fn content_range(response: &reqwest::Response) -> Result<Option<String>, &'static str> {
    let Some(raw) = response.headers().get(reqwest::header::CONTENT_RANGE) else {
        return Ok(None);
    };
    let value = raw.to_str().map_err(|_| "account-proxy-range-refused")?;
    if value.len() > 80 {
        return Err("account-proxy-range-refused");
    }
    let raw = value
        .strip_prefix("bytes ")
        .ok_or("account-proxy-range-refused")?;
    let (extent, total) = raw.split_once('/').ok_or("account-proxy-range-refused")?;
    let (start, end) = extent
        .split_once('-')
        .ok_or("account-proxy-range-refused")?;
    let start = start
        .parse::<u64>()
        .map_err(|_| "account-proxy-range-refused")?;
    let end = end
        .parse::<u64>()
        .map_err(|_| "account-proxy-range-refused")?;
    if start > end || (total != "*" && !total.parse::<u64>().is_ok_and(|n| n > end)) {
        return Err("account-proxy-range-refused");
    }
    Ok(Some(value.to_owned()))
}
async fn headers(
    socket: &mut TcpStream,
    status: u16,
    mime: &str,
    length: Option<usize>,
    range: Option<&str>,
    origin: Option<&str>,
) -> Result<(), &'static str> {
    let mut text=format!("HTTP/1.1 {status} Response\r\nContent-Type: {mime}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nAccept-Ranges: bytes\r\n");
    if let Some(length) = length {
        text.push_str(&format!("Content-Length: {length}\r\n"));
    } else {
        text.push_str("Transfer-Encoding: chunked\r\n");
    }
    if let Some(value) = range {
        text.push_str(&format!("Content-Range: {value}\r\n"));
    }
    if let Some(value) = origin {
        text.push_str(&format!("Access-Control-Allow-Origin: {value}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET,HEAD,OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Expose-Headers: Content-Range,Accept-Ranges\r\n"));
    }
    text.push_str("\r\n");
    socket
        .write_all(text.as_bytes())
        .await
        .map_err(|_| "account-proxy-write-failed")
}
async fn chunk(socket: &mut TcpStream, bytes: &[u8]) -> Result<(), &'static str> {
    for part in bytes.chunks(CHUNK) {
        let work = async {
            socket
                .write_all(format!("{:x}\r\n", part.len()).as_bytes())
                .await?;
            socket.write_all(part).await?;
            socket.write_all(b"\r\n").await
        };
        tokio::time::timeout(Duration::from_secs(5), work)
            .await
            .map_err(|_| "account-proxy-write-failed")?
            .map_err(|_| "account-proxy-write-failed")?;
    }
    Ok(())
}
async fn process(
    socket: &mut TcpStream,
    state: &Arc<Mutex<State>>,
    sent: &mut bool,
) -> Result<(), &'static str> {
    let request = read_request(socket, state).await?;
    let arrived = unix_ms();
    authority(state).await?;
    let (target, allowed, vod, live_start, busy, timed, preopened) = {
        let mut s = state.lock().map_err(|_| "account-proxy-state")?;
        let vod = s.vod;
        let busy = s.busy.clone();
        let live_start = !vod && request.id == s.root;
        // The player's first plain request takes the answer opened at start.
        let preopened = if live_start && !request.options && !request.head && request.range.is_none()
        {
            s.preopen.take()
        } else {
            None
        };
        // The first live request of each session opens the timing record
        // (unless the session's opening request already did).
        let timed = (live_start
            && !request.options
            && (preopened.is_some() || open_start_timing(s.generation, arrived)))
        .then_some(s.generation);
        let mut allowed = vec![s.authorized_origin.clone()];
        allowed.extend(s.media_origins.iter().cloned());
        let root = s.root.clone();
        let r = s
            .resources
            .get_mut(&request.id)
            .ok_or("account-proxy-resource-refused")?;
        if request.id != root && !r.playlist && r.seen.elapsed() >= RESOURCE_LIFETIME {
            return Err("account-proxy-resource-refused");
        }
        r.seen = Instant::now();
        (
            Url::parse(&r.url).map_err(|_| "account-proxy-source-refused")?,
            allowed,
            vod,
            live_start,
            busy,
            timed,
            preopened,
        )
    };
    time_start(timed, |t| {
        t.player_request_ms.get_or_insert(arrived);
    });
    if request.options {
        *sent = true;
        headers(
            socket,
            204,
            "text/plain",
            Some(0),
            None,
            request.origin.as_deref(),
        )
        .await?;
        return Ok(());
    }
    let deadline = Instant::now()
        + if live_start {
            LIVE_BUSY_WINDOW
        } else {
            Duration::from_secs(20)
        };
    // The answer opened at session start, while fresh. Its failure is this
    // request's failure (asking again at once would only repeat it); a stale or
    // abandoned one is dropped and the provider is asked now.
    let opened = match preopened {
        Some(taken) => match tokio::time::timeout_at(deadline, taken)
            .await
            .map_err(|_| "account-proxy-timeout")?
        {
            Ok(Ok((response, ready))) if ready.elapsed() <= PREOPEN_FRESH => Some(response),
            Ok(Err(code)) => return Err(code),
            Ok(Ok(_)) | Err(_) => None,
        },
        None => None,
    };
    let mut response = match opened {
        Some(response) => response,
        None => {
            open_waiting(
                state,
                &target,
                request.range.clone(),
                &allowed,
                deadline,
                live_start,
                busy.as_ref(),
                timed,
            )
            .await?
        }
    };
    authority(state).await?;
    let status = response.status().as_u16();
    let mut kind = mime(&response);
    diag(format_args!(
        "vod={} status={} label={:?} length={:?} range_reply={} same_origin={}",
        vod,
        status,
        response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
        response.content_length(),
        response
            .headers()
            .contains_key(reqwest::header::CONTENT_RANGE),
        response.url().origin() == target.origin()
    ));
    let range = content_range(&response)?;
    // Many panels label video files as text/html or JSON. In a VOD session the
    // first bytes decide (below); anything else still refuses such labels.
    if kind == "refused" {
        if !vod {
            return Err("account-proxy-content-refused");
        }
        kind = "pending";
    }
    // In a VOD session a video file is streamed with bounded reads, not capped:
    // movies are gigabytes and players fetch them in byte ranges.
    let media_file = vod
        && matches!(
            kind,
            "video/mp4"
                | "video/x-matroska"
                | "video/webm"
                | "application/octet-stream"
                | "pending"
        );
    if !media_file
        && response
            .content_length()
            .is_some_and(|n| n > FINITE_BODY_LIMIT as u64)
    {
        return Err("account-proxy-body-limit");
    }
    let base = response.url().clone();
    {
        // Remember where the provider sent this playback so its manifest's
        // segment addresses on that server are admitted (bounded per session).
        let mut s = state.lock().map_err(|_| "account-proxy-state")?;
        let reached = base.origin().ascii_serialization();
        if !s.admits(&base) {
            if s.media_origins.len() >= 8 {
                return Err("account-proxy-resource-limit");
            }
            s.media_origins.push(reached);
        }
    }
    let mut prefix = Zeroizing::new(Vec::new());
    while prefix.len() < 512 {
        let part = tokio::time::timeout_at(deadline, response.chunk())
            .await
            .map_err(|_| "account-proxy-timeout")?
            .map_err(|_| "account-proxy-network-failed")?;
        let Some(part) = part else { break };
        if part.len() > FINITE_BODY_LIMIT.saturating_sub(prefix.len()) {
            return Err("account-proxy-body-limit");
        }
        if prefix.is_empty() && !part.is_empty() {
            time_start(timed, |t| t.upstream_first_byte_ms = Some(unix_ms()));
        }
        prefix.extend_from_slice(&part);
    }
    diag(format_args!(
        "head={:02x?} text_start={:?}",
        &prefix[..prefix.len().min(16)],
        String::from_utf8_lossy(&prefix[..prefix.len().min(9)])
    ));
    if prefix.is_empty() {
        return Err("account-proxy-content-empty");
    }
    let text = String::from_utf8_lossy(&prefix);
    let sniff = text.trim_start_matches('\u{feff}').trim_start();
    // A provider's block or login page (any case, any label) is never media.
    let opening = sniff.get(..9).unwrap_or(sniff).to_ascii_lowercase();
    if opening.starts_with("<html")
        || opening.starts_with("<!doctype")
        || opening.starts_with("<?xml")
    {
        return Err("account-proxy-content-page");
    }
    if kind == "pending" {
        let mut s = state.lock().map_err(|_| "account-proxy-state")?;
        kind = match sniff_video(&prefix) {
            Some(found) => {
                s.vod_kind = Some(found);
                found
            }
            None if status == 206 => s.vod_kind.ok_or("account-proxy-content-not-video")?,
            None => return Err("account-proxy-content-not-video"),
        };
    }
    let manifest = kind == "application/vnd.apple.mpegurl" || sniff.starts_with("#EXTM3U");
    drop(text);
    if manifest {
        if prefix.len() > MANIFEST_LIMIT {
            return Err("account-proxy-manifest-limit");
        }
        while let Some(part) = tokio::time::timeout_at(deadline, response.chunk())
            .await
            .map_err(|_| "account-proxy-timeout")?
            .map_err(|_| "account-proxy-network-failed")?
        {
            if part.len() > MANIFEST_LIMIT.saturating_sub(prefix.len()) {
                return Err("account-proxy-manifest-limit");
            }
            prefix.extend_from_slice(&part);
        }
        authority(state).await?;
        let body = {
            let mut s = state.lock().map_err(|_| "account-proxy-state")?;
            let source =
                std::str::from_utf8(&prefix).map_err(|_| "account-proxy-manifest-invalid")?;
            let body = s.rewrite(source, &base)?;
            if let Some(r) = s.resources.get_mut(&request.id) {
                r.playlist = true;
            }
            body
        };
        authority(state).await?;
        *sent = true;
        headers(
            socket,
            status,
            "application/vnd.apple.mpegurl",
            Some(body.len()),
            None,
            request.origin.as_deref(),
        )
        .await?;
        if !request.head {
            socket
                .write_all(body.as_bytes())
                .await
                .map_err(|_| "account-proxy-write-failed")?;
        }
        return Ok(());
    }
    let continuous = response.content_length().is_none()
        && request.range.is_none()
        && (kind == "video/mp2t"
            || (prefix.len() >= 377
                && prefix[0] == 0x47
                && prefix[188] == 0x47
                && prefix[376] == 0x47));
    authority(state).await?;
    *sent = true;
    // Real video is reaching the player: this format works for this account.
    let on_media = state.lock().ok().and_then(|mut s| s.on_media.take());
    if let Some(notice) = on_media {
        notice();
    }
    headers(
        socket,
        status,
        kind,
        if request.head {
            response.content_length().map(|n| n as usize)
        } else {
            None
        },
        range.as_deref(),
        request.origin.as_deref(),
    )
    .await?;
    if request.head {
        return Ok(());
    }
    let mut received = prefix.len();
    chunk(socket, &prefix).await?;
    time_start(timed, |t| t.player_first_byte_ms = Some(unix_ms()));
    loop {
        authority(state).await?;
        let until = if continuous || media_file {
            Instant::now() + Duration::from_secs(5)
        } else {
            deadline
        };
        let part = tokio::time::timeout_at(until, response.chunk())
            .await
            .map_err(|_| "account-proxy-timeout")?
            .map_err(|_| "account-proxy-network-failed")?;
        let Some(part) = part else { break };
        if !continuous && !media_file && part.len() > FINITE_BODY_LIMIT.saturating_sub(received) {
            return Err("account-proxy-body-limit");
        }
        received = received.saturating_add(part.len());
        for piece in part.chunks(CHUNK) {
            authority(state).await?;
            chunk(socket, piece).await?;
        }
    }
    authority(state).await?;
    socket
        .write_all(b"0\r\n\r\n")
        .await
        .map_err(|_| "account-proxy-write-failed")?;
    Ok(())
}
async fn client(
    mut socket: TcpStream,
    state: Arc<Mutex<State>>,
    mut cancel: watch::Receiver<bool>,
) {
    let mut sent = false;
    let mut failure = None;
    tokio::select! { biased;
        _=cancel.changed()=>{},
        _=async { if let Err(code)=process(&mut socket,&state,&mut sent).await { failure=Some(code); } }=>{},
    }
    // Failing before any response: answer 502 with the fixed internal code only
    // (never a provider address, credential or upstream payload), so a failed
    // start is diagnosable instead of an unexplained dropped connection.
    diag(format_args!("outcome={:?} sent={}", failure, sent));
    if let (Some(code), false) = (failure, sent) {
        let reply = format!(
            "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\nX-GenX-Proxy-Error: {code}\r\n\r\n"
        );
        let _ =
            tokio::time::timeout(Duration::from_secs(1), socket.write_all(reply.as_bytes())).await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.shutdown()).await;
}

fn scalar(raw: &str) -> bool {
    !raw.is_empty() && raw.len() <= 32 && raw.bytes().all(|b| b.is_ascii_digit())
}
fn decimal(raw: &str) -> bool {
    raw.len() <= 32 && raw.split('.').count() <= 2 && raw.split('.').all(scalar)
}
fn attrs(raw: &str) -> Result<Vec<(String, String, bool)>, &'static str> {
    let mut values = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    for (i, c) in raw.char_indices().chain(std::iter::once((raw.len(), ','))) {
        if c == '"' {
            quoted = !quoted;
        }
        if c == ',' && !quoted {
            let pair = raw[start..i].trim();
            let (key, value) = pair
                .split_once('=')
                .ok_or("account-proxy-manifest-invalid")?;
            if key.is_empty() || !key.bytes().all(|b| b.is_ascii_uppercase() || b == b'-') {
                return Err("account-proxy-manifest-invalid");
            }
            let is_quoted = value.starts_with('"') && value.ends_with('"') && value.len() >= 2;
            let value = if is_quoted {
                &value[1..value.len() - 1]
            } else {
                value
            };
            if value.len() > 16_384
                || value.contains('"')
                || values.iter().any(|(k, _, _)| k == key)
            {
                return Err("account-proxy-manifest-invalid");
            }
            values.push((key.to_owned(), value.to_owned(), is_quoted));
            start = i + 1;
        }
    }
    if quoted || values.len() > 32 {
        return Err("account-proxy-manifest-invalid");
    }
    Ok(values)
}
/// A manifest tag or attribute name for the developer trace: printable ASCII
/// only, bounded (never a value, which may carry an address or credential).
fn printable(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '#' | '-' | '_'))
        .take(48)
        .collect()
}
fn clean_manifest(raw: &str, state: &mut State) -> Result<String, &'static str> {
    if raw.len() > MANIFEST_LIMIT {
        return Err("account-proxy-manifest-limit");
    }
    let mut result = String::new();
    let mut header = false;
    for line in raw.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.len() > 16_384 || line.chars().any(char::is_control) {
            return Err("account-proxy-manifest-invalid");
        }
        if line.is_empty() {
            continue;
        }
        if !header {
            if line != "#EXTM3U" {
                return Err("account-proxy-manifest-invalid");
            }
            header = true;
            result.push_str("#EXTM3U\n");
            continue;
        }
        if !line.starts_with('#') {
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXTINF:") {
            let duration = value
                .split(',')
                .next()
                .ok_or("account-proxy-manifest-invalid")?;
            if !decimal(duration) {
                return Err("account-proxy-manifest-invalid");
            }
            result.push_str(&format!("#EXTINF:{duration},\n"));
            continue;
        }
        let (tag, value) = line.split_once(':').unwrap_or((line, ""));
        if matches!(
            tag,
            "#EXT-X-ENDLIST"
                | "#EXT-X-DISCONTINUITY"
                | "#EXT-X-INDEPENDENT-SEGMENTS"
                | "#EXT-X-I-FRAMES-ONLY"
                | "#EXT-X-GAP"
        ) {
            if !value.is_empty() {
                return Err("account-proxy-manifest-invalid");
            }
            result.push_str(tag);
            result.push('\n');
            continue;
        }
        if matches!(
            tag,
            "#EXT-X-VERSION"
                | "#EXT-X-TARGETDURATION"
                | "#EXT-X-MEDIA-SEQUENCE"
                | "#EXT-X-DISCONTINUITY-SEQUENCE"
        ) {
            if !scalar(value) {
                return Err("account-proxy-manifest-invalid");
            }
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if tag == "#EXT-X-PLAYLIST-TYPE" {
            if !matches!(value, "EVENT" | "VOD") {
                return Err("account-proxy-manifest-invalid");
            }
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if tag == "#EXT-X-PROGRAM-DATE-TIME" {
            if chrono::DateTime::parse_from_rfc3339(value).is_err() {
                return Err("account-proxy-manifest-invalid");
            }
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if tag == "#EXT-X-BYTERANGE" {
            if value.split('@').count() > 2 || !value.split('@').all(scalar) {
                return Err("account-proxy-manifest-invalid");
            }
            result.push_str(line);
            result.push('\n');
            continue;
        }
        let keys: &[&str] = match tag {
            "#EXT-X-STREAM-INF" => &[
                "BANDWIDTH",
                "AVERAGE-BANDWIDTH",
                "CODECS",
                "RESOLUTION",
                "FRAME-RATE",
                "AUDIO",
                "VIDEO",
                "SUBTITLES",
                "CLOSED-CAPTIONS",
            ],
            "#EXT-X-I-FRAME-STREAM-INF" => &[
                "BANDWIDTH",
                "AVERAGE-BANDWIDTH",
                "CODECS",
                "RESOLUTION",
                "VIDEO",
                "URI",
            ],
            "#EXT-X-MEDIA" => &[
                "TYPE",
                "GROUP-ID",
                "NAME",
                "LANGUAGE",
                "DEFAULT",
                "AUTOSELECT",
                "FORCED",
                "INSTREAM-ID",
                "URI",
            ],
            "#EXT-X-KEY" | "#EXT-X-SESSION-KEY" => {
                &["METHOD", "URI", "IV", "KEYFORMAT", "KEYFORMATVERSIONS"]
            }
            "#EXT-X-MAP" => &["URI", "BYTERANGE"],
            "#EXT-X-PART" => &["URI", "DURATION", "INDEPENDENT", "GAP", "BYTERANGE"],
            "#EXT-X-PART-INF" => &["PART-TARGET"],
            "#EXT-X-SERVER-CONTROL" => &[
                "CAN-BLOCK-RELOAD",
                "HOLD-BACK",
                "PART-HOLD-BACK",
                "CAN-SKIP-UNTIL",
                "CAN-SKIP-DATERANGES",
            ],
            "#EXT-X-PRELOAD-HINT" => &["TYPE", "URI", "BYTERANGE-START", "BYTERANGE-LENGTH"],
            "#EXT-X-RENDITION-REPORT" => &["URI", "LAST-MSN", "LAST-PART"],
            "#EXT-X-SKIP" => &["SKIPPED-SEGMENTS"],
            _ if !tag.starts_with("#EXT") => continue,
            // Tags GenX does not know (#EXT-X-ALLOW-CACHE, #EXT-X-DATERANGE,
            // a provider's own) are left out, never passed through: the player
            // only ever sees vetted lines, and no address escapes the relay.
            _ => {
                diag(format_args!("manifest dropped tag {}", printable(tag)));
                continue;
            }
        };
        let mut output = Vec::new();
        for (key, mut value, mut quoted) in attrs(value)? {
            if !keys.contains(&key.as_str()) {
                // Likewise an attribute GenX does not know (PROGRAM-ID).
                diag(format_args!("manifest dropped {} {}", printable(tag), printable(&key)));
                continue;
            }
            match key.as_str() {
                "URI" => {
                    if !quoted || value.is_empty() {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "AUDIO" | "VIDEO" | "SUBTITLES" | "GROUP-ID" => {
                    value = state.group(&value)?;
                    quoted = true;
                }
                "CLOSED-CAPTIONS" => {
                    if value != "NONE" {
                        value = state.group(&value)?;
                        quoted = true;
                    }
                }
                "NAME" => {
                    value = "Track".into();
                    quoted = true;
                }
                "CODECS" => {
                    if !quoted
                        || value.len() > 512
                        || !value
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b',' | b'-'))
                        || value.split(',').any(|v| {
                            !v.starts_with("avc1")
                                && !v.starts_with("avc3")
                                && !v.starts_with("hvc1")
                                && !v.starts_with("hev1")
                                && !v.starts_with("av01")
                                && !v.starts_with("vp09")
                                && !v.starts_with("mp4a")
                                && !matches!(v, "opus" | "ac-3" | "ec-3" | "stpp" | "wvtt")
                        })
                    {
                        // An unknown codec label is left out; the player
                        // decides from the media itself.
                        diag(format_args!("manifest dropped CODECS"));
                        continue;
                    }
                }
                "RESOLUTION" => {
                    let mut v = value.split('x');
                    if !v.next().is_some_and(scalar)
                        || !v.next().is_some_and(scalar)
                        || v.next().is_some()
                    {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "LANGUAGE" => {
                    if value.len() > 35
                        || !value.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-')
                    {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "TYPE" => {
                    if !matches!(
                        value.as_str(),
                        "AUDIO" | "VIDEO" | "SUBTITLES" | "CLOSED-CAPTIONS" | "PART" | "MAP"
                    ) {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "METHOD" => {
                    if !matches!(value.as_str(), "NONE" | "AES-128") {
                        return Err("account-proxy-encryption-unsupported");
                    }
                }
                "KEYFORMAT" => {
                    if value != "identity" {
                        return Err("account-proxy-encryption-unsupported");
                    }
                }
                "KEYFORMATVERSIONS" => {
                    if value != "1" {
                        return Err("account-proxy-encryption-unsupported");
                    }
                }
                "IV" => {
                    if !value
                        .strip_prefix("0x")
                        .is_some_and(|v| v.len() == 32 && v.bytes().all(|b| b.is_ascii_hexdigit()))
                    {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "DEFAULT"
                | "AUTOSELECT"
                | "FORCED"
                | "INDEPENDENT"
                | "GAP"
                | "CAN-BLOCK-RELOAD"
                | "CAN-SKIP-DATERANGES" => {
                    if !matches!(value.as_str(), "YES" | "NO") {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "BYTERANGE" => {
                    if value.split('@').count() > 2 || !value.split('@').all(scalar) {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "INSTREAM-ID" => {
                    if !(value
                        .strip_prefix("CC")
                        .is_some_and(|v| v.parse::<u8>().is_ok_and(|v| (1..=4).contains(&v)))
                        || value
                            .strip_prefix("SERVICE")
                            .is_some_and(|v| v.parse::<u8>().is_ok_and(|v| (1..=63).contains(&v))))
                    {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "FRAME-RATE" | "DURATION" | "PART-TARGET" | "HOLD-BACK" | "PART-HOLD-BACK"
                | "CAN-SKIP-UNTIL" => {
                    if !decimal(&value) {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                _ => {
                    if !scalar(&value) {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
            }
            output.push(if quoted {
                format!("{key}=\"{value}\"")
            } else {
                format!("{key}={value}")
            });
        }
        result.push_str(tag);
        result.push(':');
        result.push_str(&output.join(","));
        result.push('\n');
        if result.len() > MANIFEST_LIMIT {
            return Err("account-proxy-manifest-limit");
        }
    }
    if !header {
        return Err("account-proxy-manifest-invalid");
    }
    Ok(result)
}

/// Tests that read the one start-timing record take turns.
#[cfg(test)]
static TIMING_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
mod start_timing_tests {
    use super::*;
    #[test]
    fn each_session_times_its_first_live_request_only() {
        let _turn = TIMING_TESTS.blocking_lock();
        assert!(open_start_timing(41, 1000.0));
        time_start(Some(41), |t| t.upstream_headers_ms = Some(1200.0));
        // A reconnect of the same session neither reopens nor overwrites it.
        assert!(!open_start_timing(41, 5000.0));
        time_start(None, |t| t.upstream_headers_ms = Some(9999.0));
        time_start(Some(41), |t| {
            t.hops.push(HopTiming {
                dns_ms: 12.0,
                connect_ms: Some(80.0),
                server_wait_ms: 400.0,
                https: false,
                status: 302,
            })
        });
        let timing = start_timing().unwrap();
        assert_eq!(timing.hops.len(), 1);
        assert_eq!(
            (timing.request_ms, timing.upstream_headers_ms),
            (1000.0, Some(1200.0))
        );
        // The next channel's session starts a new record.
        assert!(open_start_timing(42, 7000.0));
        // A late update from the previous session leaves the new record alone.
        time_start(Some(41), |t| t.fresh_runs = 7);
        let next = start_timing().unwrap();
        assert_eq!(next.fresh_runs, 0);
        assert_eq!(
            (next.generation, next.request_ms, next.upstream_headers_ms),
            (42, 7000.0, None)
        );
        assert!(next.hops.is_empty());
        let json = serde_json::to_value(timing).unwrap();
        assert!(json.get("playerFirstByteMs").is_some() && json.get("busyRetries").is_some());
        assert_eq!(json["hops"][0]["serverWaitMs"], 400.0);
        assert_eq!(json["hops"][0]["connectMs"], 80.0);
    }
}

/// A controlled fixture provider on loopback: a portal that redirects twice,
/// then a stream server sending MPEG-TS (owner request, October 22, 2026:
/// provider asked at session start; a stream server that does not answer).
#[cfg(test)]
mod start_path_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Provider {
        portal: u16,
        portal_requests: Arc<AtomicUsize>,
        stream_requests: Arc<AtomicUsize>,
    }
    async fn read_head(socket: &mut TcpStream) -> String {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") && head.len() < 8192 {
            match socket.read(&mut byte).await {
                Ok(1) => head.push(byte[0]),
                _ => break,
            }
        }
        String::from_utf8_lossy(&head).into_owned()
    }
    /// `silent_first`: how many stream-server requests get no answer at all.
    async fn provider(silent_first: usize) -> Provider {
        let portal = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let portal_port = portal.local_addr().unwrap().port();
        let stream_port = stream.local_addr().unwrap().port();
        FIXTURE_PORTS
            .lock()
            .unwrap()
            .extend([portal_port, stream_port]);
        let portal_requests = Arc::new(AtomicUsize::new(0));
        let stream_requests = Arc::new(AtomicUsize::new(0));
        let counted = portal_requests.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = portal.accept().await {
                let counted = counted.clone();
                tokio::spawn(async move {
                    let head = read_head(&mut socket).await;
                    // Two redirects, like the measured provider.
                    let location = if head.starts_with("GET /live/") {
                        counted.fetch_add(1, Ordering::SeqCst);
                        format!("http://127.0.0.1:{portal_port}/balance/1.ts")
                    } else {
                        format!("http://127.0.0.1:{stream_port}/stream/1.ts")
                    };
                    let reply = format!(
                        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
        let counted = stream_requests.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = stream.accept().await {
                let order = counted.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let _ = read_head(&mut socket).await;
                    if order < silent_first {
                        // Accepts, never answers.
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        return;
                    }
                    let mut body = Vec::new();
                    for _ in 0..12 {
                        let mut packet = [0xffu8; 188];
                        packet[0] = 0x47;
                        body.extend_from_slice(&packet);
                    }
                    let head =
                        "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nConnection: close\r\n\r\n";
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                });
            }
        });
        Provider {
            portal: portal_port,
            portal_requests,
            stream_requests,
        }
    }
    async fn relay(provider: &Provider, generation: u64) -> AccountPlaybackProxy {
        let origin = format!("http://127.0.0.1:{}", provider.portal);
        AccountPlaybackProxy::start(
            Zeroizing::new(format!("{origin}/live/u/p/1.ts")),
            origin,
            generation,
            Arc::new(|| Box::pin(async { Ok(()) })),
            false,
            None,
            None,
        )
        .await
        .unwrap()
    }
    /// The player's request; returns the status line and body length.
    async fn play(media_url: &str) -> (String, usize) {
        let url = Url::parse(media_url).unwrap();
        let host = format!("{}:{}", url.host_str().unwrap(), url.port().unwrap());
        let mut socket = TcpStream::connect(&host).await.unwrap();
        let request = format!(
            "GET {} HTTP/1.1\r\nHost: {host}\r\nOrigin: http://tauri.localhost\r\n\r\n",
            url.path()
        );
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut reply = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(10), socket.read_to_end(&mut reply)).await;
        let text = String::from_utf8_lossy(&reply).into_owned();
        let status = text.lines().next().unwrap_or("").to_owned();
        (status, reply.len())
    }

    #[tokio::test]
    async fn a_live_session_asks_the_provider_before_the_player_does() {
        let _turn = TIMING_TESTS.lock().await;
        let provider = provider(0).await;
        let mut proxy = relay(&provider, 9001).await;
        // The provider is asked while the player is still being prepared.
        let asked = Instant::now();
        while provider.stream_requests.load(Ordering::SeqCst) == 0
            && asked.elapsed() < Duration::from_secs(5)
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(provider.portal_requests.load(Ordering::SeqCst), 1);
        assert_eq!(provider.stream_requests.load(Ordering::SeqCst), 1);
        let (status, bytes) = play(proxy.media_url()).await;
        assert!(status.starts_with("HTTP/1.1 200"), "{status}");
        assert!(bytes > 12 * 188, "the stream reached the player");
        // The player took that answer: still one request through the chain.
        assert_eq!(provider.portal_requests.load(Ordering::SeqCst), 1);
        assert_eq!(provider.stream_requests.load(Ordering::SeqCst), 1);
        let timing = start_timing().unwrap();
        assert_eq!(timing.generation, 9001);
        assert!(timing.preopened);
        assert!(timing.player_request_ms.unwrap() >= timing.upstream_headers_ms.unwrap());
        assert_eq!(timing.hops.len(), 3);
        assert_eq!(timing.fresh_runs, 0);
        proxy.stop().await.unwrap();
    }

    #[tokio::test]
    async fn a_stream_server_that_does_not_answer_is_left_after_two_seconds() {
        let _turn = TIMING_TESTS.lock().await;
        let provider = provider(1).await;
        let started = Instant::now();
        let mut proxy = relay(&provider, 9002).await;
        let (status, _) = play(proxy.media_url()).await;
        let took = started.elapsed();
        assert!(status.starts_with("HTTP/1.1 200"), "{status}");
        // One fresh run of the chain found a server that answers.
        assert_eq!(provider.portal_requests.load(Ordering::SeqCst), 2);
        assert_eq!(provider.stream_requests.load(Ordering::SeqCst), 2);
        assert!(
            took >= STREAM_SERVER_ANSWER && took < Duration::from_secs(4),
            "{took:?}"
        );
        let timing = start_timing().unwrap();
        assert_eq!((timing.generation, timing.fresh_runs), (9002, 1));
        assert_eq!(timing.hops.iter().filter(|h| h.status == 0).count(), 1);
        proxy.stop().await.unwrap();
    }

    #[tokio::test]
    async fn a_second_silent_stream_server_fails_the_start_as_a_timeout() {
        let _turn = TIMING_TESTS.lock().await;
        let provider = provider(2).await;
        let mut proxy = relay(&provider, 9003).await;
        let (status, _) = play(proxy.media_url()).await;
        assert!(status.starts_with("HTTP/1.1 502"), "{status}");
        assert_eq!(provider.portal_requests.load(Ordering::SeqCst), 2);
        proxy.stop().await.unwrap();
    }

    #[tokio::test]
    async fn a_stopped_session_abandons_the_providers_answer() {
        let _turn = TIMING_TESTS.lock().await;
        let provider = provider(1).await;
        let mut proxy = relay(&provider, 9004).await;
        // Stopping while the opening request waits on a silent server joins it.
        tokio::time::sleep(Duration::from_millis(300)).await;
        tokio::time::timeout(Duration::from_secs(2), proxy.stop())
            .await
            .expect("stop does not wait for the provider")
            .unwrap();
    }
}

#[cfg(test)]
mod manifest_tests {
    use super::*;
    fn state() -> State {
        State {
            resources: HashMap::new(),
            groups: HashMap::new(),
            root: String::new(),
            capability: "c".repeat(64),
            local_origin: "http://127.0.0.1:9".into(),
            authorized_origin: "http://tv.fixture.example".into(),
            media_origins: Vec::new(),
            started: Instant::now(),
            renewed: Instant::now(),
            generation: 1,
            authority: Arc::new(|| Box::pin(async { Ok(()) })),
            authorities: Vec::new(),
            busy: None,
            on_media: None,
            verified: None,
            vod: false,
            vod_kind: None,
            preopen: None,
        }
    }
    #[test]
    fn unknown_tags_and_attributes_are_left_out_not_fatal() {
        // A typical Xtream-style live playlist: an old #EXT-X-ALLOW-CACHE tag,
        // PROGRAM-ID on the variant and an unlisted codec label.
        let master = "#EXTM3U
#EXT-X-ALLOW-CACHE:YES
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2000000,CODECS=\"mp4a.40.2,avc1.64001f,xyz9\",RESOLUTION=1280x720
http://tv.fixture.example/live/u/p/1.m3u8
";
        let mut s = state();
        let base = Url::parse("http://tv.fixture.example/live/u/p/1.m3u8").unwrap();
        let out = s.rewrite(master, &base).unwrap();
        assert!(!out.contains("ALLOW-CACHE"));
        assert!(!out.contains("PROGRAM-ID"));
        assert!(out.contains("BANDWIDTH=2000000"));
        assert!(out.contains("RESOLUTION=1280x720"));
        assert!(!out.contains("tv.fixture.example"), "every address goes through the relay");
        let media = "#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-DATERANGE:ID=\"ad\",START-DATE=\"2026-10-18T00:00:00Z\"
#EXT-X-PROVIDER-OWN:URI=\"http://elsewhere.fixture.example/x\"
#EXTINF:10.0,
/hls/7.ts
";
        let out = state().rewrite(media, &base).unwrap();
        assert!(!out.contains("DATERANGE") && !out.contains("PROVIDER-OWN"));
        assert!(!out.contains("elsewhere"), "a dropped tag's address never reaches the player");
        assert!(out.contains("#EXT-X-MEDIA-SEQUENCE:7") && out.contains("#EXTINF:10.0,"));
        // Segments on another public server the playlist names are admitted
        // (bounded); private addresses and downgrades never are.
        let mut s = state();
        assert!(s
            .rewrite("#EXTM3U
#EXTINF:10,
http://cdn.fixture.example/7.ts
", &base)
            .is_ok());
        assert_eq!(s.media_origins, ["http://cdn.fixture.example"]);
        for refused in ["http://192.168.1.20/7.ts", "http://127.0.0.1:8080/7.ts", "http://u:p@cdn.fixture.example/7.ts"] {
            let mut s = state();
            assert!(s.rewrite(&format!("#EXTM3U
#EXTINF:10,
{refused}
"), &base).is_err(), "{refused}");
            assert!(s.media_origins.is_empty());
        }
        let mut https = state();
        https.authorized_origin = "https://tv.fixture.example".into();
        let secure = Url::parse("https://tv.fixture.example/live/u/p/1.m3u8").unwrap();
        assert!(https.rewrite("#EXTM3U
#EXTINF:10,
http://cdn.fixture.example/7.ts
", &secure).is_err());
        // At most eight servers per session.
        let mut s = state();
        let many: String = (0..9).map(|i| format!("#EXTINF:10,
http://cdn{i}.fixture.example/7.ts
")).collect();
        assert!(s.rewrite(&format!("#EXTM3U
{many}"), &base).is_err());
        assert!(s.media_origins.is_empty());
    }
}

#[cfg(test)]
mod authority_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
    fn state(calls: Arc<AtomicUsize>, revoked: Arc<AtomicBool>) -> Arc<Mutex<State>> {
        Arc::new(Mutex::new(State {
            resources: HashMap::new(),
            groups: HashMap::new(),
            root: String::new(),
            capability: "c".repeat(64),
            local_origin: "http://127.0.0.1:9".into(),
            authorized_origin: "http://tv.fixture.example".into(),
            media_origins: Vec::new(),
            started: Instant::now(),
            renewed: Instant::now(),
            generation: 1,
            authority: Arc::new(move || {
                calls.fetch_add(1, SeqCst);
                let revoked = revoked.load(SeqCst);
                Box::pin(async move {
                    if revoked {
                        Err("revoked".to_string())
                    } else {
                        Ok(())
                    }
                })
            }),
            authorities: Vec::new(),
            busy: None,
            on_media: None,
            verified: None,
            vod: false,
            vod_kind: None,
            preopen: None,
        }))
    }
    #[tokio::test(start_paused = true)]
    async fn the_account_is_rechecked_every_two_seconds_not_every_chunk() {
        let calls = Arc::new(AtomicUsize::new(0));
        let revoked = Arc::new(AtomicBool::new(false));
        let state = state(calls.clone(), revoked.clone());
        // A live stream asks before every read and every 64 KB written.
        for _ in 0..100 {
            authority(&state).await.unwrap();
        }
        assert_eq!(calls.load(SeqCst), 1, "one database check, not one per chunk");
        tokio::time::advance(Duration::from_millis(2_100)).await;
        authority(&state).await.unwrap();
        assert_eq!(calls.load(SeqCst), 2);
        // Removing or editing the account still stops playback at the next check.
        revoked.store(true, SeqCst);
        tokio::time::advance(Duration::from_millis(2_100)).await;
        assert!(authority(&state).await.is_err());
    }
}

#[cfg(test)]
mod redirect_tests {
    use super::*;
    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }
    #[test]
    fn provider_redirects_may_change_server_but_never_downgrade() {
        // HTTPS account: another public HTTPS server is followed, plain HTTP is not.
        let https = "https://tv.fixture.example";
        assert!(redirect_target(&url("https://lb1.fixture.example:8443/live/1.ts"), https).is_ok());
        assert!(redirect_target(&url("http://lb1.fixture.example/live/1.ts"), https).is_err());
        // HTTP account (explicit grant): its load balancers may use HTTP or HTTPS.
        let http = "http://tv.fixture.example:8080";
        assert!(redirect_target(&url("http://lb2.fixture.example:8080/live/1.ts"), http).is_ok());
        assert!(redirect_target(&url("https://lb2.fixture.example/live/1.ts"), http).is_ok());
        // Never a private or loopback address, never embedded user info.
        assert!(redirect_target(&url("http://192.168.1.10/live/1.ts"), http).is_err());
        assert!(redirect_target(&url("http://127.0.0.1:8080/live/1.ts"), http).is_err());
        assert!(redirect_target(&url("http://user:pw@lb3.fixture.example/x.ts"), http).is_err());
        assert!(redirect_target(&url("ftp://lb3.fixture.example/x.ts"), http).is_err());
    }
}

#[cfg(test)]
mod sniff_tests {
    #[test]
    fn video_is_recognized_by_its_bytes_not_its_label() {
        assert_eq!(
            super::sniff_video(&[0x1a, 0x45, 0xdf, 0xa3, 0, 0]),
            Some("video/x-matroska")
        );
        assert_eq!(super::sniff_video(b"\0\0\0\x20ftypisom"), Some("video/mp4"));
        let mut ts = vec![0u8; 400];
        ts[0] = 0x47;
        ts[188] = 0x47;
        ts[376] = 0x47;
        assert_eq!(super::sniff_video(&ts), Some("video/mp2t"));
        assert_eq!(super::sniff_video(b"<html>Access denied</html>"), None);
        assert_eq!(super::sniff_video(b"{\"error\":1}"), None);
    }
}

#[cfg(test)]
mod busy_tests {
    use super::{busy_delay, LIVE_BUSY_WINDOW};
    use std::time::Duration;

    #[test]
    fn a_live_start_waits_out_a_busy_provider_within_its_window() {
        let mut remaining = LIVE_BUSY_WINDOW;
        let mut attempt = 0;
        let mut waited = Duration::ZERO;
        while let Some(delay) = busy_delay(attempt, true, remaining) {
            assert!(delay <= Duration::from_secs(3), "backoff is capped");
            waited += delay;
            remaining = remaining.saturating_sub(delay);
            attempt += 1;
        }
        // Covers the >15 s the trial provider kept a closed stream busy,
        // and never exceeds the window.
        assert!(waited >= Duration::from_secs(20), "{waited:?}");
        assert!(waited < LIVE_BUSY_WINDOW);
    }
    #[test]
    fn other_requests_keep_three_short_retries() {
        let delays: Vec<_> = (0..5)
            .map(|attempt| busy_delay(attempt, false, Duration::from_secs(20)))
            .collect();
        assert_eq!(
            delays,
            vec![
                Some(Duration::from_millis(1500)),
                Some(Duration::from_millis(2500)),
                Some(Duration::from_millis(3500)),
                None,
                None
            ]
        );
    }
    #[test]
    fn a_nearly_spent_window_gives_up_instead_of_overrunning() {
        assert_eq!(busy_delay(4, true, Duration::from_millis(3500)), None);
        assert_eq!(busy_delay(0, true, Duration::from_millis(2000)), None);
    }
}
