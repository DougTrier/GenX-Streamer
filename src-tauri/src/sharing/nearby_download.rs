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
//! - Every address carries a fresh random secret: without the code on the
//!   sharer's screen, the page and the file are not found.
//! - It serves the installed app itself (Android: this copy's APK from its
//!   own install folder; Windows: the running exe), with no second copy.
//! - The page names nothing about the sharer: it says "Get GenX Streamer".
//! - Bounded: eight connections at a time, small request heads, read and
//!   write deadlines.
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
}

#[derive(Default)]
struct Stats {
    visitors: Mutex<HashSet<IpAddr>>,
    downloads: AtomicU32,
    completed: AtomicU32,
}

struct Session {
    url: String,
    expires: Instant,
    stats: Arc<Stats>,
    stop: watch::Sender<bool>,
}

#[derive(Default)]
pub(crate) struct NearbyOwner(Mutex<Option<Session>>);

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NearbyStatus {
    pub active: bool,
    pub url: Option<String>,
    pub expires_in_ms: u64,
    pub visitors: u32,
    pub downloads: u32,
    pub completed: u32,
}

impl NearbyOwner {
    fn status(&self) -> NearbyStatus {
        let session = self.0.lock().ok();
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
                }
            }
            _ => NearbyStatus {
                active: false,
                url: None,
                expires_in_ms: 0,
                visitors: 0,
                downloads: 0,
                completed: 0,
            },
        }
    }
    /// Ends the session: no new connections; downloads under way may finish.
    pub(crate) fn stop(&self) {
        if let Ok(mut session) = self.0.lock() {
            if let Some(session) = session.take() {
                let _ = session.stop.send(true);
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

/// The secret part of every address of one session (16 random bytes, URL-safe).
fn secret() -> Result<String, String> {
    use base64::Engine;
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "nearby-unavailable".to_string())?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Route {
    Page,
    File,
    NotFound,
}

/// What a request head asks for: GET or HEAD of the page or the file, under the secret.
pub(crate) fn route(head: &str, token: &str, file: &str) -> (Route, bool) {
    let line = head.lines().next().unwrap_or("");
    let mut parts = line.split(' ');
    let (method, path, version) = (parts.next(), parts.next(), parts.next());
    let head_only = method == Some("HEAD");
    if !matches!(method, Some("GET" | "HEAD"))
        || !matches!(version, Some("HTTP/1.1" | "HTTP/1.0"))
        || parts.next().is_some()
    {
        return (Route::NotFound, head_only);
    }
    let path = path.unwrap_or("");
    let page = format!("/{token}/");
    if path == page {
        (Route::Page, head_only)
    } else if path == format!("{page}{file}") {
        (Route::File, head_only)
    } else {
        (Route::NotFound, head_only)
    }
}

/// The receiver's page: fixed text, the file's name, size and guidance only.
pub(crate) fn page(file: &AppFile) -> String {
    PAGE.replace("{{FILE}}", file.name)
        .replace(
            "{{SIZE}}",
            &format!("{:.1} MB", file.bytes as f64 / 1_048_576.0),
        )
        .replace("{{GUIDANCE}}", file.guidance)
}

fn response_head(status: &str, mime: &str, length: u64, extra: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {length}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n{extra}\r\n"
    )
}

/// One connection, on a blocking thread: the head, then the page or the file.
fn serve(
    mut stream: std::net::TcpStream,
    token: &str,
    file: &AppFile,
    stats: &Stats,
    peer: IpAddr,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(60)))?;
    let mut head = Vec::new();
    let mut buffer = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let read = stream.read(&mut buffer)?;
        if read == 0 || head.len() + read > MAX_HEAD {
            return Ok(());
        }
        head.extend_from_slice(&buffer[..read]);
    }
    let head = String::from_utf8_lossy(&head);
    match route(&head, token, file.name) {
        (Route::Page, head_only) => {
            if let Ok(mut visitors) = stats.visitors.lock() {
                if visitors.len() < 1024 {
                    visitors.insert(peer);
                }
            }
            let body = page(file);
            let csp = "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\r\n";
            stream.write_all(
                response_head("200 OK", "text/html; charset=utf-8", body.len() as u64, csp)
                    .as_bytes(),
            )?;
            if !head_only {
                stream.write_all(body.as_bytes())?;
            }
        }
        (Route::File, head_only) => {
            let mut source = std::fs::File::open(&file.path)?;
            let disposition = format!(
                "Content-Disposition: attachment; filename=\"{}\"\r\n",
                file.name
            );
            stream.write_all(
                response_head("200 OK", file.mime, file.bytes, &disposition).as_bytes(),
            )?;
            if !head_only {
                stats.downloads.fetch_add(1, Ordering::SeqCst);
                let sent = std::io::copy(&mut (&mut source).take(file.bytes), &mut stream)?;
                if sent == file.bytes {
                    stats.completed.fetch_add(1, Ordering::SeqCst);
                }
            }
        }
        (Route::NotFound, _) => {
            stream.write_all(response_head("404 Not Found", "text/plain", 0, "").as_bytes())?;
        }
    }
    stream.flush()
}

async fn the_app_file(app: &tauri::AppHandle) -> Result<AppFile, String> {
    #[cfg(target_os = "android")]
    {
        let (path, split) = crate::share_links::android_app_file(app).await?;
        if split {
            return Err("share-app-split".into());
        }
        let bytes = std::fs::metadata(&path)
            .map_err(|_| "share-app-unavailable".to_string())?
            .len();
        Ok(AppFile {
            path,
            name: "GenX-Streamer.apk",
            mime: "application/vnd.android.package-archive",
            bytes,
            guidance: "Open the downloaded file. When Android asks, allow your browser or Files to install apps.",
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let path = std::env::current_exe().map_err(|_| "share-app-unavailable".to_string())?;
        let bytes = std::fs::metadata(&path)
            .map_err(|_| "share-app-unavailable".to_string())?
            .len();
        Ok(AppFile {
            path,
            name: "GenX-Streamer.exe",
            mime: "application/vnd.microsoft.portable-executable",
            bytes,
            guidance: "Save it in a folder of its own and open it. If Windows says the publisher is unknown, choose More info, then Run anyway.",
        })
    }
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
    let listener = TcpListener::bind(SocketAddr::new(ip, 0))
        .await
        .map_err(|_| "nearby-unavailable".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "nearby-unavailable".to_string())?
        .port();
    let token = Arc::new(secret()?);
    let url = format!("http://{ip}:{port}/{token}/");
    let stats = Arc::new(Stats::default());
    let (stop, mut stopped) = watch::channel(false);
    let expires = Instant::now() + SESSION;
    *owner.0.lock().map_err(|_| "nearby-unavailable")? = Some(Session {
        url,
        expires,
        stats: stats.clone(),
        stop,
    });
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let closing = app.state::<NativeState>().closing.clone();
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let deadline = tokio::time::sleep_until(expires.into());
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                _ = stopped.changed() => break,
                accepted = listener.accept() => {
                    let Ok((stream, peer)) = accepted else {
                        // Out of sockets, for example: pause instead of spinning.
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        continue;
                    };
                    if !local_client(peer.ip()) || closing.load(Ordering::SeqCst) {
                        continue;
                    }
                    let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
                    let Ok(stream) = stream.into_std().and_then(|s| { s.set_nonblocking(false)?; Ok(s) }) else { continue };
                    let (token, file, stats, app) = (token.clone(), file.clone(), stats.clone(), task_app.clone());
                    tauri::async_runtime::spawn_blocking(move || {
                        let _permit = permit;
                        let _ = serve(stream, &token, &file, &stats, peer.ip());
                        changed(&app);
                    });
                }
            }
        }
        drop(listener);
        if let Some(owner) = task_app.try_state::<NearbyOwner>() {
            owner.stop();
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
