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

use super::{
    casting::LanReceiverVerifier,
    nearby_download::{local_address, local_client},
};
use crate::{NativeState, Ordering};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use rustls::{
    pki_types::{PrivatePkcs8KeyDer, ServerName},
    ClientConfig, ServerConfig,
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    future::Future,
    net::{IpAddr, SocketAddr, SocketAddrV4},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Manager;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    time,
};
use tokio_rustls::{TlsAcceptor, TlsConnector};

const SERVICE: &str = "_genx-favs._tcp.local.";
const HOST: &str = "genx-favorites.local";
const ALPN: &[u8] = b"genx-favorites/1";
const SESSION: Duration = Duration::from_secs(120);
const HANDSHAKE: Duration = Duration::from_secs(5);
const MAX_BYTES: usize = 1024 * 1024;
const UNAVAILABLE: &str = "favorites-network-unavailable";
const DISCONNECTED: &str = "favorites-disconnected";
const EXPORTER: &[u8] = b"EXPORTER-GenX-Favorites-Pairing-v1";

#[derive(Clone, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub(crate) enum Status {
    Idle,
    Waiting,
    Pairing { code: String },
    Transferring,
    Received,
    Sent,
    Failed { reason: &'static str },
}

struct Session {
    id: String,
    status: Mutex<Status>,
    payload: Mutex<Option<String>>,
    cancel: watch::Sender<bool>,
    approved: watch::Sender<bool>,
}

impl Session {
    fn set(&self, status: Status) {
        if let Ok(mut current) = self.status.lock() {
            *current = status;
        }
    }

    async fn approve(&self, code: String) -> Result<(), &'static str> {
        let mut approval = self.approved.subscribe();
        self.set(Status::Pairing { code });
        approval
            .wait_for(|value| *value)
            .await
            .map_err(|_| DISCONNECTED)?;
        self.set(Status::Transferring);
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct Owner(Mutex<Option<Arc<Session>>>);

impl Owner {
    fn start(&self, id: String) -> Result<Arc<Session>, &'static str> {
        if id.len() != 36
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        {
            return Err(UNAVAILABLE);
        }
        let mut current = self.0.lock().map_err(|_| UNAVAILABLE)?;
        if current.is_some() {
            return Err("favorites-session-active");
        }
        let session = Arc::new(Session {
            id,
            status: Mutex::new(Status::Waiting),
            payload: Mutex::new(None),
            cancel: watch::channel(false).0,
            approved: watch::channel(false).0,
        });
        *current = Some(session.clone());
        Ok(session)
    }

    fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.0
            .lock()
            .ok()?
            .as_ref()
            .filter(|session| session.id == id)
            .cloned()
    }

    pub(crate) fn stop(&self, id: Option<&str>) {
        self.stop_matching(|session| id.is_none_or(|id| session.id == id));
    }

    fn stop_matching(&self, matches: impl FnOnce(&Arc<Session>) -> bool) {
        if let Ok(mut current) = self.0.lock() {
            if current.as_ref().is_some_and(matches) {
                if let Some(session) = current.take() {
                    session.cancel.send_replace(true);
                }
            }
        }
    }
}

async fn prepare<T>(
    session: &Session,
    work: impl Future<Output = Result<T, &'static str>>,
) -> Result<T, &'static str> {
    let mut cancel = session.cancel.subscribe();
    tokio::select! {
        biased;
        _ = cancel.wait_for(|value| *value) => Err(DISCONNECTED),
        result = work => result,
    }
}

fn launch<F>(session: Arc<Session>, work: F)
where
    F: Future<Output = Result<Status, &'static str>> + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut cancel = session.cancel.subscribe();
        let result = tokio::select! {
            biased;
            _ = cancel.wait_for(|value| *value) => return,
            result = time::timeout(SESSION, work) => result.unwrap_or(Err("favorites-session-expired")),
        };
        session.set(result.unwrap_or_else(|reason| Status::Failed { reason }));
    });
}

// Each code is bound to one TLS handshake. A certificate is provisional
// until the user compares the codes on both devices and confirms both screens.
fn code(bytes: [u8; 8]) -> String {
    format!("{:08}", u64::from_be_bytes(bytes) % 100_000_000)
}

fn server_tls() -> Result<TlsAcceptor, &'static str> {
    let rcgen::CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(vec![HOST.to_string()]).map_err(|_| UNAVAILABLE)?;
    let mut config =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|_| UNAVAILABLE)?
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                PrivatePkcs8KeyDer::from(signing_key.serialize_der()).into(),
            )
            .map_err(|_| UNAVAILABLE)?;
    config.alpn_protocols = vec![ALPN.to_vec()];
    Ok(TlsAcceptor::from(Arc::new(config)))
}

fn client_tls() -> Result<TlsConnector, &'static str> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|_| UNAVAILABLE)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(LanReceiverVerifier { provider }))
        .with_no_client_auth();
    config.alpn_protocols = vec![ALPN.to_vec()];
    Ok(TlsConnector::from(Arc::new(config)))
}

struct Discovery {
    daemon: ServiceDaemon,
    #[cfg(target_os = "android")]
    _lease: MulticastLease,
}

impl Discovery {
    async fn new(_app: &tauri::AppHandle) -> Result<Self, &'static str> {
        Ok(Self {
            #[cfg(target_os = "android")]
            _lease: MulticastLease::acquire(_app).await?,
            daemon: ServiceDaemon::new().map_err(|_| UNAVAILABLE)?,
        })
    }

    fn advertise(
        &self,
        name: &str,
        hostname: &str,
        address: SocketAddr,
    ) -> Result<(), &'static str> {
        let service = ServiceInfo::new(SERVICE, name, hostname, address.ip(), address.port(), None)
            .map_err(|_| UNAVAILABLE)?;
        self.daemon.register(service).map_err(|_| UNAVAILABLE)
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        let _ = self.daemon.shutdown();
    }
}

#[cfg(target_os = "android")]
struct MulticastLease {
    app: tauri::AppHandle,
    id: String,
}

#[cfg(target_os = "android")]
impl MulticastLease {
    async fn acquire(app: &tauri::AppHandle) -> Result<Self, &'static str> {
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).map_err(|_| UNAVAILABLE)?;
        let lease = Self {
            app: app.clone(),
            id: format!("favorites-{:016x}", u64::from_le_bytes(nonce)),
        };
        app.state::<crate::AndroidViewing>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "setDiscovery",
                serde_json::json!({ "enabled": true, "leaseId": lease.id }),
            )
            .await
            .map_err(|_| UNAVAILABLE)?;
        Ok(lease)
    }
}

#[cfg(target_os = "android")]
impl Drop for MulticastLease {
    fn drop(&mut self) {
        let app = self.app.clone();
        let id = self.id.clone();
        tauri::async_runtime::spawn(async move {
            let _ = app
                .state::<crate::AndroidViewing>()
                .0
                .run_mobile_plugin_async::<serde_json::Value>(
                    "setDiscovery",
                    serde_json::json!({ "enabled": false, "leaseId": id }),
                )
                .await;
        });
    }
}

#[derive(Serialize)]
pub(crate) struct Receiver {
    name: String,
    address: String,
}

fn receiver_address(raw: &str) -> Result<SocketAddrV4, &'static str> {
    let address: SocketAddrV4 = raw.parse().map_err(|_| "favorites-invalid-address")?;
    if address.port() == 0 || !local_client(IpAddr::V4(*address.ip())) {
        return Err("favorites-invalid-address");
    }
    Ok(address)
}

async fn browse(discovery: Discovery) -> Result<Vec<Receiver>, &'static str> {
    let events = discovery.daemon.browse(SERVICE).map_err(|_| UNAVAILABLE)?;
    let own: Vec<_> = if_addrs::get_if_addrs()
        .map_err(|_| UNAVAILABLE)?
        .into_iter()
        .map(|interface| interface.ip())
        .collect();
    let mut found = BTreeMap::new();
    let _ = time::timeout(Duration::from_secs(3), async {
        while let Ok(event) = events.recv_async().await {
            match event {
                ServiceEvent::ServiceResolved(service) if found.len() < 32 => {
                    let full = service.get_fullname();
                    let Some(name) = full.strip_suffix("._genx-favs._tcp.local.") else {
                        continue;
                    };
                    if name.is_empty() || name.len() > 63 || name.chars().any(char::is_control) {
                        continue;
                    }
                    if let Some(ip) = service.get_addresses_v4().into_iter().find(|ip| {
                        let ip = IpAddr::V4(*ip);
                        local_client(ip) && !own.contains(&ip)
                    }) {
                        let address = SocketAddrV4::new(ip, service.get_port()).to_string();
                        if receiver_address(&address).is_ok() {
                            found.insert(
                                full.to_string(),
                                Receiver {
                                    name: name.to_string(),
                                    address,
                                },
                            );
                        }
                    }
                }
                ServiceEvent::ServiceRemoved(_, full) => {
                    found.remove(&full);
                }
                _ => {}
            }
        }
    })
    .await;
    Ok(found.into_values().collect())
}

async fn receive(
    listener: TcpListener,
    acceptor: TlsAcceptor,
    session: Arc<Session>,
    advertisement: Option<Discovery>,
) -> Result<Status, &'static str> {
    let stream = loop {
        let (tcp, peer) = listener.accept().await.map_err(|_| UNAVAILABLE)?;
        if !local_client(peer.ip()) {
            continue;
        }
        if let Ok(Ok(stream)) = time::timeout(HANDSHAKE, acceptor.accept(tcp)).await {
            if stream.get_ref().1.alpn_protocol() == Some(ALPN) {
                break stream;
            }
        }
    };
    drop(advertisement);
    drop(listener);
    receive_paired(stream, session).await
}

async fn receive_paired(
    mut stream: tokio_rustls::server::TlsStream<TcpStream>,
    session: Arc<Session>,
) -> Result<Status, &'static str> {
    let value = stream
        .get_ref()
        .1
        .export_keying_material([0; 8], EXPORTER, None)
        .map_err(|_| DISCONNECTED)?;
    tokio::select! {
        biased;
        _ = stream.read_u8() => return Err(DISCONNECTED),
        result = session.approve(code(value)) => result?,
    }
    stream.write_u8(1).await.map_err(|_| DISCONNECTED)?;
    stream.flush().await.map_err(|_| DISCONNECTED)?;
    let size = stream.read_u32().await.map_err(|_| DISCONNECTED)? as usize;
    if !(1..=MAX_BYTES).contains(&size) {
        return Err("favorites-list-too-large");
    }
    let mut bytes = vec![0; size];
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|_| DISCONNECTED)?;
    let text = String::from_utf8(bytes).map_err(|_| "favorites-invalid-list")?;
    *session.payload.lock().map_err(|_| UNAVAILABLE)? = Some(text);
    // The file is already safely staged in memory even if the sender goes away.
    let _ = stream.write_u8(1).await;
    let _ = stream.flush().await;
    Ok(Status::Received)
}

async fn send(
    address: SocketAddrV4,
    payload: String,
    session: Arc<Session>,
) -> Result<Status, &'static str> {
    let mut stream = time::timeout(HANDSHAKE, async {
        let tcp = TcpStream::connect(address)
            .await
            .map_err(|_| DISCONNECTED)?;
        client_tls()?
            .connect(ServerName::try_from(HOST).map_err(|_| UNAVAILABLE)?, tcp)
            .await
            .map_err(|_| DISCONNECTED)
    })
    .await
    .map_err(|_| DISCONNECTED)??;
    if stream.get_ref().1.alpn_protocol() != Some(ALPN) {
        return Err(DISCONNECTED);
    }
    let value = stream
        .get_ref()
        .1
        .export_keying_material([0; 8], EXPORTER, None)
        .map_err(|_| DISCONNECTED)?;
    tokio::try_join!(session.approve(code(value)), async {
        if stream.read_u8().await.map_err(|_| DISCONNECTED)? == 1 {
            Ok(())
        } else {
            Err(DISCONNECTED)
        }
    })?;
    stream
        .write_u32(payload.len() as u32)
        .await
        .map_err(|_| DISCONNECTED)?;
    stream
        .write_all(payload.as_bytes())
        .await
        .map_err(|_| DISCONNECTED)?;
    stream.flush().await.map_err(|_| DISCONNECTED)?;
    if stream.read_u8().await.map_err(|_| DISCONNECTED)? != 1 {
        return Err(DISCONNECTED);
    }
    Ok(Status::Sent)
}

fn main_webview(webview: &tauri::Webview) -> Result<(), &'static str> {
    if webview.label() != "main" {
        return Err(UNAVAILABLE);
    }
    Ok(())
}

fn open(webview: &tauri::Webview, app: &tauri::AppHandle) -> Result<(), &'static str> {
    main_webview(webview)?;
    if app.state::<NativeState>().closing.load(Ordering::SeqCst) {
        return Err("application-closing");
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn favorites_discover(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<Receiver>, &'static str> {
    open(&webview, &app)?;
    browse(Discovery::new(&app).await?).await
}

#[tauri::command]
pub(crate) async fn favorites_receive(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    id: String,
) -> Result<Receiver, &'static str> {
    open(&webview, &app)?;
    let owner = app.state::<Owner>();
    // Register before the first await so a close during setup can find us.
    let session = owner.start(id)?;
    let setup = prepare(&session, async {
        open(&webview, &app)?;
        let ip = local_address().map_err(|_| UNAVAILABLE)?;
        let listener = TcpListener::bind(SocketAddr::new(ip, 0))
            .await
            .map_err(|_| UNAVAILABLE)?;
        let address = listener.local_addr().map_err(|_| UNAVAILABLE)?;
        let acceptor = server_tls()?;
        let discovery = Discovery::new(&app).await.ok();
        open(&webview, &app)?;
        Ok((ip, listener, address, acceptor, discovery))
    })
    .await;
    let (ip, listener, address, acceptor, discovery) = match setup {
        Ok(setup) => setup,
        Err(error) => {
            owner.stop_matching(|current| Arc::ptr_eq(current, &session));
            return Err(error);
        }
    };
    let suffix = &session.id[..8];
    let platform = if cfg!(target_os = "android") {
        "Android"
    } else {
        "Windows"
    };
    let name = format!("GenX {platform} {suffix}");
    let hostname = format!("genx-{suffix}.local.");
    let advertised_name = name.clone();
    let owned = session.clone();
    launch(session, async move {
        let advertisement = discovery.filter(|discovery| {
            discovery
                .advertise(&advertised_name, &hostname, address)
                .is_ok()
        });
        let network_lost = async {
            loop {
                time::sleep(Duration::from_secs(3)).await;
                if !if_addrs::get_if_addrs()
                    .is_ok_and(|interfaces| interfaces.iter().any(|interface| interface.ip() == ip))
                {
                    break;
                }
            }
        };
        tokio::select! {
            _ = network_lost => Err(UNAVAILABLE),
            result = receive(listener, acceptor, owned, advertisement) => result,
        }
    });
    Ok(Receiver {
        name,
        address: address.to_string(),
    })
}

#[tauri::command]
pub(crate) fn favorites_send(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    id: String,
    address: String,
    payload: String,
) -> Result<(), &'static str> {
    open(&webview, &app)?;
    if !(1..=MAX_BYTES).contains(&payload.len()) {
        return Err("favorites-list-too-large");
    }
    let address = receiver_address(&address)?;
    let owner = app.state::<Owner>();
    let session = owner.start(id)?;
    if let Err(error) = open(&webview, &app) {
        owner.stop_matching(|current| Arc::ptr_eq(current, &session));
        return Err(error);
    }
    launch(session.clone(), send(address, payload, session));
    Ok(())
}

#[tauri::command]
pub(crate) fn favorites_status(
    webview: tauri::Webview,
    owner: tauri::State<'_, Owner>,
    id: String,
) -> Status {
    if main_webview(&webview).is_err() {
        return Status::Idle;
    }
    owner
        .get(&id)
        .and_then(|session| session.status.lock().ok().map(|status| status.clone()))
        .unwrap_or(Status::Idle)
}

#[tauri::command]
pub(crate) fn favorites_approve(
    webview: tauri::Webview,
    owner: tauri::State<'_, Owner>,
    id: String,
    code: String,
) -> Result<(), &'static str> {
    main_webview(&webview)?;
    let session = owner.get(&id).ok_or(DISCONNECTED)?;
    let status = session.status.lock().map_err(|_| UNAVAILABLE)?;
    if !matches!(&*status, Status::Pairing { code: current } if *current == code) {
        return Err(DISCONNECTED);
    }
    session.approved.send_replace(true);
    Ok(())
}

#[tauri::command]
pub(crate) fn favorites_take(
    webview: tauri::Webview,
    owner: tauri::State<'_, Owner>,
    id: String,
) -> Option<String> {
    main_webview(&webview).ok()?;
    let session = owner.get(&id)?;
    if !matches!(*session.status.lock().ok()?, Status::Received) {
        return None;
    }
    let payload = session.payload.lock().ok()?.take();
    payload
}

#[tauri::command]
pub(crate) fn favorites_stop(webview: tauri::Webview, owner: tauri::State<'_, Owner>, id: String) {
    if main_webview(&webview).is_ok() {
        owner.stop(Some(&id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    async fn pairing_code(session: &Session) -> String {
        time::timeout(HANDSHAKE, async {
            loop {
                if let Status::Pairing { code } = session.status.lock().unwrap().clone() {
                    break code;
                }
                time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn tls_favorites_wait_for_both_approvals() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let SocketAddr::V4(address) = listener.local_addr().unwrap() else {
            unreachable!()
        };
        let sending = Owner::default()
            .start("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into())
            .unwrap();
        let receiving = Owner::default()
            .start("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb".into())
            .unwrap();
        let acceptor = server_tls().unwrap();
        let receiver = {
            let receiving = receiving.clone();
            tokio::spawn(async move {
                let (tcp, _) = listener.accept().await.unwrap();
                let tls = acceptor.accept(tcp).await.unwrap();
                receive_paired(tls, receiving).await
            })
        };
        let sender = tokio::spawn(send(address, "favorite payload".into(), sending.clone()));
        let (sender_code, receiver_code) =
            tokio::join!(pairing_code(&sending), pairing_code(&receiving));
        assert_eq!(sender_code, receiver_code);
        sending.approved.send_replace(true);
        time::sleep(Duration::from_millis(25)).await;
        assert!(receiving.payload.lock().unwrap().is_none());
        assert!(!sender.is_finished());
        receiving.approved.send_replace(true);
        let (sender, receiver) = time::timeout(HANDSHAKE, async { tokio::join!(sender, receiver) })
            .await
            .unwrap();
        assert!(matches!(sender.unwrap(), Ok(Status::Sent)));
        assert!(matches!(receiver.unwrap(), Ok(Status::Received)));
        assert_eq!(
            receiving.payload.lock().unwrap().as_deref(),
            Some("favorite payload")
        );
    }

    #[tokio::test]
    async fn receiver_rejects_early_data_and_oversized_frames() {
        for approved in [false, true] {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let receiving = Owner::default()
                .start("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb".into())
                .unwrap();
            let acceptor = server_tls().unwrap();
            let receiver = {
                let receiving = receiving.clone();
                tokio::spawn(async move {
                    let (tcp, _) = listener.accept().await.unwrap();
                    receive_paired(acceptor.accept(tcp).await.unwrap(), receiving).await
                })
            };
            let tcp = TcpStream::connect(address).await.unwrap();
            let mut peer = client_tls()
                .unwrap()
                .connect(ServerName::try_from(HOST).unwrap(), tcp)
                .await
                .unwrap();
            pairing_code(&receiving).await;
            if approved {
                receiving.approved.send_replace(true);
                assert_eq!(peer.read_u8().await.unwrap(), 1);
            }
            peer.write_u32(MAX_BYTES as u32 + 1).await.unwrap();
            peer.flush().await.unwrap();
            let outcome = time::timeout(HANDSHAKE, receiver).await.unwrap().unwrap();
            let expected = if approved {
                "favorites-list-too-large"
            } else {
                DISCONNECTED
            };
            assert!(matches!(outcome, Err(reason) if reason == expected));
            assert!(receiving.payload.lock().unwrap().is_none());
        }
    }

    #[test]
    fn manual_receivers_are_local_ipv4_and_have_a_port() {
        let local = Ipv4Addr::new(192, 168, 1, 10);
        let address = SocketAddrV4::new(local, 1234).to_string();
        let zero_port = SocketAddrV4::new(local, 0).to_string();
        let with_scheme = format!("https://{address}");
        assert!(receiver_address(&address).is_ok());
        for address in [
            &zero_port,
            "8.8.8.8:1234",
            "127.0.0.1:1234",
            "[::1]:1234",
            &with_scheme,
        ] {
            assert!(receiver_address(address).is_err(), "{address}");
        }
    }

    #[test]
    fn stale_cancel_does_not_stop_a_new_session() {
        let owner = Owner::default();
        let first = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let second = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        let session = owner.start(first.into()).unwrap();
        assert!(owner.start(second.into()).is_err());
        owner.stop(Some(first));
        assert!(*session.cancel.borrow());
        let session = owner.start(second.into()).unwrap();
        owner.stop(Some(first));
        assert!(!*session.cancel.borrow());
    }

    #[tokio::test]
    async fn canceled_receive_setup_cannot_stop_its_replacement() {
        let owner = Owner::default();
        let id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let original = owner.start(id.into()).unwrap();
        let (started, entered) = tokio::sync::oneshot::channel();
        let task = {
            let original = original.clone();
            tokio::spawn(async move {
                prepare(&original, async move {
                    started.send(()).unwrap();
                    std::future::pending::<Result<(), &'static str>>().await
                })
                .await
            })
        };
        entered.await.unwrap();
        owner.stop(Some(id));
        let replacement = owner.start(id.into()).unwrap();
        assert_eq!(task.await.unwrap(), Err(DISCONNECTED));
        owner.stop_matching(|current| Arc::ptr_eq(current, &original));
        assert!(Arc::ptr_eq(&owner.get(id).unwrap(), &replacement));
    }
}
