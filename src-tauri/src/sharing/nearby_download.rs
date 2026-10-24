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

//! Share with everyone nearby (docs/share-links.md): a temporary download of
//! GenX Streamer on the local network, for friends on the same Wi-Fi. Only
//! when the viewer starts it; it ends after ten minutes, on Stop, or when GenX
//! closes.
//!
//! - Plain HTTP, so any phone's browser opens it, on this device's own
//!   network address and a random port; only local (private or link-local)
//!   clients are answered.
//! - Every session has a fresh six-digit code, short enough to type with a
//!   TV remote (Downloader on Google TV): without it the page and the file
//!   are not found, a client that guesses wrong five times is no longer
//!   answered, and twenty wrong guesses end the session (nearby_download/guard.rs).
//! - It serves the installed app itself (Android: this copy's APK from its
//!   own install folder; Windows: the running exe), with no second copy.
//! - The page names nothing about the sharer: it says "Get GenX Streamer".
//! - Bounded: eight connections at a time (three per client), small request
//!   heads, read and write deadlines.
//! - The right build or none (SH-009, SH-019, SH-020): the page is written
//!   for the device that asks; a file that cannot run there is not handed over.
//! - Checkable (SH-025): the page shows the file's SHA-256 and, on Android,
//!   the official signing fingerprint. Interrupted downloads resume (Range).
//! - Closed when this device leaves the network it was shared on (SH-021).
use crate::sharing::compatibility::Package;
use crate::NativeState;
use serde::Serialize;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::{watch, Semaphore};

pub(crate) const SESSION: Duration = Duration::from_secs(10 * 60);
const MAX_CONNECTIONS: usize = 8;
/// Tried first so the address is easy to type; any free port otherwise.
const PREFERRED_PORT: u16 = 8080;
/// How often the session checks that this device still has its address.
const NETWORK_CHECK: Duration = Duration::from_secs(3);
const MAX_HEAD: usize = 8 * 1024;
pub(crate) const CHANGED_EVENT: &str = "nearby-share-changed";
const PAGE: &str = include_str!("nearby_download/page.html");

/// The file shared: the installed app itself.
#[derive(Clone, Debug)]
pub(crate) struct AppFile {
    pub path: PathBuf,
    pub name: &'static str,
    pub mime: &'static str,
    pub bytes: u64,
    pub guidance: &'static str,
    /// What it is, read from the file itself (Android) or known (Windows).
    pub package: Package,
    /// Lowercase hex, computed when the session starts.
    pub sha256: String,
    /// Android: the official certificate's SHA-256 (only official copies serve).
    pub signer: Option<&'static str>,
}

#[derive(Default)]
struct Stats {
    visitors: Mutex<HashSet<IpAddr>>,
    downloads: AtomicU32,
    completed: AtomicU32,
    guesses: Guesses,
}

struct Session {
    url: String,
    expires: Instant,
    stats: Arc<Stats>,
    stop: watch::Sender<bool>,
}

/// Why the last session ended early (shown to the sharer), when it did.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Ended {
    /// Too many wrong codes were tried (SH-024).
    Guesses,
    /// This device left the network it shared on (SH-021).
    Network,
}

#[derive(Default)]
pub(crate) struct NearbyOwner {
    session: Mutex<Option<Session>>,
    ended: Mutex<Option<Ended>>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NearbyStatus {
    pub active: bool,
    pub url: Option<String>,
    pub expires_in_ms: u64,
    pub visitors: u32,
    pub downloads: u32,
    pub completed: u32,
    pub ended: Option<Ended>,
}

impl NearbyOwner {
    fn status(&self) -> NearbyStatus {
        let ended = self.ended.lock().ok().and_then(|ended| *ended);
        let session = self.session.lock().ok();
        match session.as_ref().and_then(|session| session.as_ref()) {
            Some(session) if session.expires > Instant::now() && !*session.stop.borrow() => {
                NearbyStatus {
                    active: true,
                    url: Some(session.url.clone()),
                    expires_in_ms: session
                        .expires
                        .saturating_duration_since(Instant::now())
                        .as_millis() as u64,
                    visitors: session.stats.visitors.lock().map_or(0, |v| v.len() as u32),
                    downloads: session.stats.downloads.load(Ordering::SeqCst),
                    completed: session.stats.completed.load(Ordering::SeqCst),
                    ended: None,
                }
            }
            _ => NearbyStatus {
                active: false,
                url: None,
                expires_in_ms: 0,
                visitors: 0,
                downloads: 0,
                completed: 0,
                ended,
            },
        }
    }
    /// Ends the session: no new connections; downloads under way may finish.
    pub(crate) fn stop(&self) {
        if let Ok(mut session) = self.session.lock() {
            if let Some(session) = session.take() {
                let _ = session.stop.send(true);
            }
        }
    }
    /// Ends the session at `url` only (never a newer one started since),
    /// saying why when it ended early.
    fn end(&self, url: &str, why: Option<Ended>) {
        if let Ok(mut session) = self.session.lock() {
            if session.as_ref().is_some_and(|session| session.url == url) {
                if let Some(session) = session.take() {
                    let _ = session.stop.send(true);
                }
                if let Ok(mut ended) = self.ended.lock() {
                    *ended = why;
                }
            }
        }
    }
}

/// A client on this network: private, shared (CGNAT hotspots) or link-local addresses only.
pub(crate) fn local_client(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, ..] = ip.octets();
            ip.is_private() || ip.is_link_local() || (a == 100 && (64..128).contains(&b))
        }
        IpAddr::V6(ip) => {
            let first = ip.segments()[0];
            (first & 0xffc0) == 0xfe80 || (first & 0xfe00) == 0xfc00
        }
    }
}

/// This device's address on the local network: the one its traffic would
/// leave from (a UDP "connect" sends nothing), else the first private one.
pub(crate) fn local_address() -> Result<IpAddr, String> {
    let routed = std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("192.0.2.1:9")?;
            socket.local_addr()
        })
        .ok()
        .map(|address| address.ip())
        .filter(|ip| matches!(ip, IpAddr::V4(v4) if v4.is_private()));
    if let Some(ip) = routed {
        return Ok(ip);
    }
    if_addrs::get_if_addrs()
        .map_err(|_| "nearby-no-network".to_string())?
        .into_iter()
        .map(|interface| interface.ip())
        .find(|ip| matches!(ip, IpAddr::V4(v4) if v4.is_private()))
        .ok_or_else(|| "nearby-no-network".to_string())
}

mod guard;
mod http;
use guard::{addresses, still_has, Clients, Guesses};
use http::serve;

async fn the_app_file(app: &tauri::AppHandle) -> Result<AppFile, String> {
    // Only an official release copy serves its own APK (docs/verify-a-download.md).
    crate::app_identity::may_send_app_file(app).await?;
    #[cfg(target_os = "android")]
    {
        let (path, split) = crate::share_links::android_app_file(app).await?;
        if split {
            return Err("share-app-split".into());
        }
        let (bytes, sha256, package) = measured(path.clone(), |path| {
            let found = crate::sharing::apk_contents::architectures(path)?;
            crate::sharing::apk_contents::android_package(&found)
                .ok_or_else(|| "share-app-unavailable".to_string())
        })
        .await?;
        Ok(AppFile {
            path,
            name: "GenX-Streamer.apk",
            mime: "application/vnd.android.package-archive",
            bytes,
            guidance: "Open the downloaded file. When Android asks, allow your browser or Files to install apps.",
            package,
            sha256,
            signer: Some(crate::app_identity::RELEASE_CERTIFICATE_SHA256),
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let path = std::env::current_exe().map_err(|_| "share-app-unavailable".to_string())?;
        let (bytes, sha256, package) = measured(path.clone(), |_| Ok(Package::WindowsExe)).await?;
        Ok(AppFile {
            path,
            name: "GenX-Streamer.exe",
            mime: "application/vnd.microsoft.portable-executable",
            bytes,
            guidance: "Save it in a folder of its own and open it. If Windows says the publisher is unknown, choose More info, then Run anyway.",
            package,
            sha256,
            signer: None,
        })
    }
}

/// The file's size, SHA-256 and package kind, read off the async runtime.
async fn measured(
    path: PathBuf,
    kind: impl FnOnce(&std::path::Path) -> Result<Package, String> + Send + 'static,
) -> Result<(u64, String, Package), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::metadata(&path)
            .map_err(|_| "share-app-unavailable".to_string())?
            .len();
        let package = kind(&path)?;
        let sha256 =
            crate::app_update::hash_file(&path).map_err(|_| "share-app-unavailable".to_string())?;
        Ok((bytes, sha256, package))
    })
    .await
    .map_err(|_| "share-app-unavailable".to_string())?
}

fn changed(app: &tauri::AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
}

/// Starts sharing nearby (or returns the session already running).
#[tauri::command]
pub(crate) async fn nearby_start(app: tauri::AppHandle) -> Result<NearbyStatus, String> {
    let _work = app.state::<NativeState>().admit_work()?;
    let owner = app.state::<NearbyOwner>();
    if owner.status().active {
        return Ok(owner.status());
    }
    let file = Arc::new(the_app_file(&app).await?);
    let ip = local_address()?;
    let listener = match TcpListener::bind(SocketAddr::new(ip, PREFERRED_PORT)).await {
        Ok(listener) => listener,
        Err(_) => TcpListener::bind(SocketAddr::new(ip, 0))
            .await
            .map_err(|_| "nearby-unavailable".to_string())?,
    };
    let port = listener
        .local_addr()
        .map_err(|_| "nearby-unavailable".to_string())?
        .port();
    let token = Arc::new(guard::code()?);
    let url = format!("http://{ip}:{port}/{token}");
    let stats = Arc::new(Stats::default());
    let (stop, mut stopped) = watch::channel(false);
    let expires = Instant::now() + SESSION;
    if let Ok(mut ended) = owner.ended.lock() {
        *ended = None;
    }
    *owner.session.lock().map_err(|_| "nearby-unavailable")? = Some(Session {
        url: url.clone(),
        expires,
        stats: stats.clone(),
        stop,
    });
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let clients = Arc::new(Clients::default());
    let closing = app.state::<NativeState>().closing.clone();
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let deadline = tokio::time::sleep_until(expires.into());
        tokio::pin!(deadline);
        let mut network = tokio::time::interval(NETWORK_CHECK);
        let why = loop {
            tokio::select! {
                _ = &mut deadline => break None,
                _ = stopped.changed() => break None,
                // SH-021: another network (or none) ends the session.
                _ = network.tick() => {
                    let now = tauri::async_runtime::spawn_blocking(addresses).await.unwrap_or_default();
                    if !still_has(ip, &now) {
                        break Some(Ended::Network);
                    }
                }
                accepted = listener.accept() => {
                    let Ok((stream, peer)) = accepted else {
                        // Out of sockets, for example: pause instead of spinning.
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        continue;
                    };
                    if stats.guesses.exhausted() {
                        break Some(Ended::Guesses);
                    }
                    if !local_client(peer.ip())
                        || closing.load(Ordering::SeqCst)
                        || stats.guesses.locked_out(peer.ip())
                    {
                        continue;
                    }
                    let Some(client) = clients.admit(peer.ip()) else { continue };
                    let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
                    let Ok(stream) = stream.into_std().and_then(|s| { s.set_nonblocking(false)?; Ok(s) }) else { continue };
                    let (token, file, stats, app, url) = (token.clone(), file.clone(), stats.clone(), task_app.clone(), url.clone());
                    tauri::async_runtime::spawn_blocking(move || {
                        let (_permit, _client) = (permit, client);
                        let _ = serve(stream, &token, &file, &stats, peer.ip());
                        // The guess that reaches the limit ends it at once.
                        if stats.guesses.exhausted() {
                            if let Some(owner) = app.try_state::<NearbyOwner>() {
                                owner.end(&url, Some(Ended::Guesses));
                            }
                        }
                        changed(&app);
                    });
                }
            }
        };
        drop(listener);
        if let Some(owner) = task_app.try_state::<NearbyOwner>() {
            owner.end(&url, why);
        }
        changed(&task_app);
    });
    changed(&app);
    Ok(owner.status())
}

#[tauri::command]
pub(crate) fn nearby_status(app: tauri::AppHandle) -> NearbyStatus {
    app.state::<NearbyOwner>().status()
}

#[tauri::command]
pub(crate) fn nearby_stop(app: tauri::AppHandle) {
    app.state::<NearbyOwner>().stop();
    changed(&app);
}

#[cfg(test)]
#[path = "nearby_download_tests.rs"]
mod tests;
