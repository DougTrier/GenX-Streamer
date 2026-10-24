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

// This module's parts, by area, are in account_playback_proxy/.
mod timing;
pub(crate) use timing::*;
mod requests;
use requests::*;
mod upstream;
use upstream::*;
mod responses;
use responses::*;
mod manifest;
use manifest::*;
#[cfg(test)]
mod proxy_tests;
