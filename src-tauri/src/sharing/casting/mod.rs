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

mod chromecast;
mod discovery;
mod dlna;
mod network_scope;
mod protocol;
mod receiver_relay;
pub use network_scope::ReceiverNetworkScope;
pub(crate) use receiver_relay::ReceiverRelay;

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex as SyncMutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CastDevice {
    pub id: String,
    pub name: String,
    pub protocol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_receiver_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub identity_status: String,
    pub cryptographically_attested: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSelection {
    pub id: String,
    pub name: String,
    pub url: String,
    pub content_type: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CastStatus {
    pub session_id: String,
    pub selection_id: String,
    pub state: String,
    pub remote_session_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum Endpoint {
    Chromecast {
        name: String,
        address: SocketAddr,
        protocol_id: Option<String>,
        model: Option<String>,
        instance: Option<String>,
    },
    Dlna {
        name: String,
        control: reqwest::Url,
        service: String,
        description: reqwest::Url,
        protocol_id: Option<String>,
        model: Option<String>,
    },
}
#[derive(Clone)]
struct RosterEntry {
    endpoint: Endpoint,
    time: Instant,
    network: ReceiverNetworkScope,
}
#[derive(Clone)]
struct IssuedGrant {
    endpoint: Endpoint,
    time: Instant,
    network: ReceiverNetworkScope,
    allow_unverified_identity: bool,
}
fn grant_is_current(
    grant: &IssuedGrant,
    network: &ReceiverNetworkScope,
) -> Result<(), &'static str> {
    if grant.time.elapsed() >= Duration::from_secs(120) {
        return Err("cast-issued-handle-expired-revalidate");
    }
    if &grant.network != network {
        return Err("cast-network-changed");
    }
    Ok(())
}
fn identity_admitted(recheck: &str, acknowledged: bool) -> bool {
    recheck == "matched" || acknowledged
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverValidation {
    pub device: CastDevice,
    pub network: ReceiverNetworkScope,
    pub issued_handle: Option<String>,
    pub identity_recheck: String,
}
impl Endpoint {
    fn device(&self, id: String) -> CastDevice {
        let (name, protocol, protocol_id, model) = match self {
            Self::Chromecast {
                name,
                protocol_id,
                model,
                ..
            } => (name, "chromecast", protocol_id, model),
            Self::Dlna {
                name,
                protocol_id,
                model,
                ..
            } => (name, "dlna", protocol_id, model),
        };
        CastDevice {
            id,
            name: name.clone(),
            protocol: protocol.into(),
            protocol_receiver_id: protocol_id.clone(),
            model: model.clone(),
            identity_status: if protocol_id.is_some() {
                "protocol-reported"
            } else {
                "unverified"
            }
            .into(),
            cryptographically_attested: false,
        }
    }
}
async fn recheck_endpoint(endpoint: &Endpoint) -> Result<&'static str, &'static str> {
    match endpoint {
        Endpoint::Chromecast {
            address,
            instance,
            protocol_id,
            model,
            ..
        } => {
            discovery::recheck_receiver(
                *address,
                instance.as_deref(),
                protocol_id.as_deref(),
                model.as_deref(),
            )
            .await
        }
        Endpoint::Dlna {
            description,
            protocol_id,
            ..
        } => {
            let fresh = match tokio::time::timeout(
                Duration::from_secs(3),
                dlna::describe(description.clone()),
            )
            .await
            {
                Ok(Ok(value)) => value,
                _ => return Ok("unavailable"),
            };
            let Endpoint::Dlna {
                protocol_id: fresh_id,
                ..
            } = &fresh
            else {
                return Err("cast-receiver-identity-changed");
            };
            if protocol_id.is_none() || fresh_id.is_none() {
                return Ok("unavailable");
            }
            if &fresh != endpoint {
                return Err("cast-receiver-identity-changed");
            }
            Ok("matched")
        }
    }
}
enum Engine {
    Chromecast(Box<chromecast::Session>),
    Dlna(dlna::Session),
}
enum ReceiverState {
    Playing(String),
    Paused,
    Buffering,
    Ended,
}
struct OwnedSession {
    network: ReceiverNetworkScope,
    id: String,
    selection: String,
    cancel: AtomicBool,
    engine: Mutex<Option<Engine>>,
    relay: Mutex<Option<receiver_relay::ReceiverRelay>>,
}
#[derive(Default)]
pub struct CastingManager {
    discoveries: SyncMutex<DiscoveryOwners>,
    registry: Mutex<HashMap<String, RosterEntry>>,
    issued: Mutex<HashMap<String, IssuedGrant>>,
    network: Mutex<network_scope::NetworkTracker>,
    active: Mutex<Option<Arc<OwnedSession>>>,
    manual: Mutex<HashMap<String, RosterEntry>>,
    warnings: Mutex<Vec<&'static str>>,
    closing: AtomicBool,
    operations: AtomicUsize,
    changed: tokio::sync::Notify,
    cancel: tokio::sync::Notify,
}
struct Operation<'a>(&'a CastingManager);
#[derive(Default)]
struct DiscoveryOwners {
    generation: u64,
    active: HashMap<String, Arc<DiscoveryCancellation>>,
    canceled: VecDeque<String>,
}
#[derive(Default)]
struct DiscoveryCancellation {
    canceled: AtomicBool,
    changed: tokio::sync::Notify,
}
/// Held by the command through protocol socket disposal AND Android multicast lease release.
pub struct DiscoveryLease<'a> {
    manager: &'a CastingManager,
    id: String,
    generation: u64,
    cancellation: Arc<DiscoveryCancellation>,
    deadline: tokio::time::Instant,
    _operation: Operation<'a>,
}
impl DiscoveryLease<'_> {
    pub fn check_current(&self) -> Result<(), &'static str> {
        let owners = self
            .manager
            .discoveries
            .lock()
            .map_err(|_| "cast-discovery-owner-lock")?;
        if self.manager.closing.load(Ordering::SeqCst)
            || self.cancellation.canceled.load(Ordering::SeqCst)
            || owners.generation != self.generation
        {
            return Err("cast-discovery-canceled");
        }
        if tokio::time::Instant::now() >= self.deadline {
            return Err("cast-discovery-timeout");
        }
        Ok(())
    }
}
impl Drop for DiscoveryLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut owners) = self.manager.discoveries.lock() {
            owners.active.remove(&self.id);
        }
    }
}
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.operations.fetch_sub(1, Ordering::SeqCst);
        self.0.changed.notify_waiters();
    }
}
pub fn private_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private() && !ip.is_loopback() && !ip.is_link_local(),
        IpAddr::V6(ip) => ip.is_unique_local() && !ip.is_loopback(),
    }
}
fn valid_discovery_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}
fn token() -> Result<String, &'static str> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|_| "cast-id-entropy")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
impl CastingManager {
    pub fn begin_discovery(&self, request_id: &str) -> Result<DiscoveryLease<'_>, &'static str> {
        let operation = self.enter()?;
        if !valid_discovery_id(request_id) {
            return Err("cast-discovery-invalid-request");
        }
        let mut owners = self
            .discoveries
            .lock()
            .map_err(|_| "cast-discovery-owner-lock")?;
        if owners.canceled.iter().any(|id| id == request_id) {
            return Err("cast-discovery-canceled");
        }
        if owners.active.contains_key(request_id) {
            return Err("cast-discovery-duplicate-request");
        }
        owners.generation = owners
            .generation
            .checked_add(1)
            .ok_or("cast-discovery-owner-exhausted")?;
        for cancellation in owners.active.values() {
            cancellation.canceled.store(true, Ordering::SeqCst);
            cancellation.changed.notify_waiters();
        }
        let cancellation = Arc::new(DiscoveryCancellation::default());
        owners
            .active
            .insert(request_id.into(), cancellation.clone());
        Ok(DiscoveryLease {
            manager: self,
            id: request_id.into(),
            generation: owners.generation,
            cancellation,
            deadline: tokio::time::Instant::now() + Duration::from_secs(9),
            _operation: operation,
        })
    }
    pub fn cancel_discovery(&self, request_id: &str) -> Result<(), &'static str> {
        if !valid_discovery_id(request_id) {
            return Err("cast-discovery-invalid-request");
        }
        let mut owners = self
            .discoveries
            .lock()
            .map_err(|_| "cast-discovery-owner-lock")?;
        if let Some(cancellation) = owners.active.get(request_id) {
            cancellation.canceled.store(true, Ordering::SeqCst);
            cancellation.changed.notify_waiters();
        }
        // Commands can reach native admission out of order. A bounded tombstone refuses
        // a cancelled request even when cancellation arrived before its discovery command.
        if !owners.canceled.iter().any(|id| id == request_id) {
            owners.canceled.push_back(request_id.into());
            if owners.canceled.len() > 128 {
                owners.canceled.pop_front();
            }
        }
        Ok(())
    }
    async fn observe_network(&self) -> Result<ReceiverNetworkScope, &'static str> {
        let (fingerprint, routes) = match network_scope::snapshot() {
            Ok(value) => value,
            Err(error) => {
                self.network.lock().await.invalidate();
                return Err(error);
            }
        };
        self.network.lock().await.observe(fingerprint, routes)
    }
    pub async fn network_scope(&self) -> Result<ReceiverNetworkScope, &'static str> {
        let _operation = self.enter()?;
        self.observe_network().await
    }
    pub async fn validate_receiver(
        &self,
        device_id: &str,
        expected_network: ReceiverNetworkScope,
        allow_unverified_identity: bool,
    ) -> Result<ReceiverValidation, &'static str> {
        let _operation = self.enter()?;
        let network = self.observe_network().await?;
        if network != expected_network {
            return Err("cast-network-changed");
        }
        let entry = self.registry.lock().await.get(device_id).cloned();
        let entry = match entry {
            Some(value) => value,
            None => self
                .manual
                .lock()
                .await
                .get(device_id)
                .cloned()
                .ok_or("cast-receiver-expired-rediscover")?,
        };
        if entry.time.elapsed() >= Duration::from_secs(600) || entry.network != network {
            return Err("cast-receiver-expired-rediscover");
        }
        let identity_recheck = recheck_endpoint(&entry.endpoint).await?;
        if self.closing.load(Ordering::SeqCst) {
            return Err("cast-application-closing");
        }
        if self.observe_network().await? != network {
            return Err("cast-network-changed");
        }
        let issued_handle = if identity_admitted(identity_recheck, allow_unverified_identity) {
            let mut issued = self.issued.lock().await;
            issued.retain(|_, value| {
                value.time.elapsed() < Duration::from_secs(120) && value.network == network
            });
            if issued.len() >= 100 {
                return Err("cast-validation-limit");
            }
            let handle = token()?;
            issued.insert(
                handle.clone(),
                IssuedGrant {
                    endpoint: entry.endpoint.clone(),
                    time: Instant::now(),
                    network: network.clone(),
                    allow_unverified_identity,
                },
            );
            Some(handle)
        } else {
            None
        };
        Ok(ReceiverValidation {
            device: entry.endpoint.device(device_id.into()),
            network,
            issued_handle,
            identity_recheck: identity_recheck.into(),
        })
    }
    fn enter(&self) -> Result<Operation<'_>, &'static str> {
        if self.closing.load(Ordering::SeqCst) {
            return Err("cast-application-closing");
        }
        self.operations.fetch_add(1, Ordering::SeqCst);
        let operation = Operation(self);
        if self.closing.load(Ordering::SeqCst) {
            return Err("cast-application-closing");
        }
        if self.operations.load(Ordering::SeqCst) > 4 {
            return Err("cast-command-busy");
        }
        Ok(operation)
    }
    pub async fn discover(
        &self,
        request: &DiscoveryLease<'_>,
    ) -> Result<Vec<CastDevice>, &'static str> {
        let cancel = self.cancel.notified();
        tokio::pin!(cancel);
        cancel.as_mut().enable();
        let request_cancel = request.cancellation.changed.notified();
        tokio::pin!(request_cancel);
        request_cancel.as_mut().enable();
        if request.cancellation.canceled.load(Ordering::SeqCst) {
            return Err("cast-discovery-canceled");
        }
        request.check_current()?;
        if self.closing.load(Ordering::SeqCst) {
            return Err("cast-application-closing");
        }
        let scope = self.observe_network().await?;
        let discovered = tokio::select! { result = tokio::time::timeout_at(request.deadline, async {
            tokio::join!(discovery::chromecast_report(), discovery::dlna())
        }) => result.map_err(|_| "cast-discovery-timeout")?,
        _ = cancel => return Err("cast-discovery-canceled"),
        _ = request_cancel => return Err("cast-discovery-canceled"),
        };
        if self.closing.load(Ordering::SeqCst) {
            return Err("cast-discovery-canceled");
        }
        if self.observe_network().await? != scope {
            return Err("cast-network-changed");
        }
        let mut warnings = discovered.0.errors;
        let mut endpoints = discovered.0.endpoints;
        match discovered.1 {
            Ok(dlna) => endpoints.extend(dlna),
            Err(error) => warnings.push(error),
        }
        let manual = self.manual.lock().await;
        let mut published_warnings = self.warnings.lock().await;
        let mut registry = self.registry.lock().await;
        let owners = self
            .discoveries
            .lock()
            .map_err(|_| "cast-discovery-owner-lock")?;
        if owners.generation != request.generation
            || request.cancellation.canceled.load(Ordering::SeqCst)
            || self.closing.load(Ordering::SeqCst)
        {
            return Err("cast-discovery-canceled");
        }
        if tokio::time::Instant::now() >= request.deadline {
            return Err("cast-discovery-timeout");
        }
        let mut replacement = HashMap::new();
        let mut devices = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for endpoint in endpoints.into_iter().take(100) {
            let (_name, _protocol, key) = match &endpoint {
                Endpoint::Chromecast { name, address, .. } => {
                    (name.clone(), "chromecast", format!("cast:{address}"))
                }
                Endpoint::Dlna { name, control, .. } => {
                    (name.clone(), "dlna", format!("dlna:{control}"))
                }
            };
            if !seen.insert(key) {
                continue;
            }
            let id = token()?;
            devices.push(endpoint.device(id.clone()));
            replacement.insert(
                id,
                RosterEntry {
                    endpoint,
                    time: Instant::now(),
                    network: scope.clone(),
                },
            );
        }
        for (id, entry) in manual.iter() {
            if entry.time.elapsed() < Duration::from_secs(600) && entry.network == scope {
                devices.push(entry.endpoint.device(id.clone()));
            }
        }
        if devices.is_empty() && !warnings.is_empty() {
            return Err("cast-discovery-incomplete-check-network");
        }
        *registry = replacement;
        *published_warnings = warnings;
        Ok(devices)
    }
    pub async fn discovery_warnings(&self) -> Vec<String> {
        self.warnings
            .lock()
            .await
            .iter()
            .map(|value| value.to_string())
            .collect()
    }
    pub async fn register_receiver(
        &self,
        address: &str,
        name: &str,
    ) -> Result<CastDevice, &'static str> {
        let _operation = self.enter()?;
        let ip = address
            .parse::<IpAddr>()
            .map_err(|_| "cast-known-address-must-be-private-ip")?;
        if !private_address(ip)
            || name.trim().is_empty()
            || name.len() > 160
            || name.chars().any(char::is_control)
        {
            return Err("cast-known-receiver-invalid");
        }
        let scope = self.observe_network().await?;
        let address = SocketAddr::new(ip, 8009);
        tokio::time::timeout(Duration::from_secs(8), async {
            let mut session = chromecast::Session::connect(address, token()?).await?;
            session.verify_receiver().await
        })
        .await
        .map_err(|_| "cast-known-receiver-timeout")??;
        if self.closing.load(Ordering::SeqCst) {
            return Err("cast-application-closing");
        }
        let mut manual = self.manual.lock().await;
        manual.retain(|_, entry| {
            entry.time.elapsed() < Duration::from_secs(600) && entry.network == scope
        });
        if manual.len() >= 8 {
            return Err("cast-known-receiver-limit");
        }
        let id = token()?;
        if self.observe_network().await? != scope {
            return Err("cast-network-changed");
        }
        let endpoint = Endpoint::Chromecast {
            name: name.into(),
            address,
            protocol_id: None,
            model: None,
            instance: None,
        };
        let device = endpoint.device(id.clone());
        manual.insert(
            id,
            RosterEntry {
                endpoint,
                time: Instant::now(),
                network: scope,
            },
        );
        Ok(device)
    }

    pub async fn start(
        &self,
        device_id: &str,
        session_id: &str,
        selection: MediaSelection,
        allow_http: bool,
        allow_http_receiver: bool,
    ) -> Result<CastStatus, &'static str> {
        // Launching the TV's cast app and its first buffering of a live stream
        // (often through the relay) take well over ten seconds on Google TV.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(40);
        let _operation = self.enter()?;
        if session_id.is_empty()
            || session_id.len() > 128
            || selection.id.is_empty()
            || selection.id.len() > 16_384
            || selection.name.len() > 16_384
        {
            return Err("cast-selection-invalid");
        }
        let url = reqwest::Url::parse(&selection.url).map_err(|_| "cast-media-url-invalid")?;
        if selection.url.len() > 16_384
            || !url.username().is_empty()
            || url.password().is_some()
            || (url.scheme() != "https" && !(allow_http && url.scheme() == "http"))
        {
            return Err("cast-media-url-policy");
        }
        let host = url.host_str().ok_or("cast-media-host")?;
        let addresses = tokio::time::timeout(
            Duration::from_secs(3),
            tokio::net::lookup_host((host, url.port_or_known_default().ok_or("cast-media-port")?)),
        )
        .await
        .map_err(|_| "cast-media-dns-timeout")?
        .map_err(|_| "cast-media-dns")?;
        let mut addresses = addresses.peekable();
        if addresses.peek().is_none()
            || addresses.any(|address| !crate::sharing_policy::public_upstream(address.ip()))
        {
            return Err("cast-media-public-url-required");
        }
        if !matches!(
            selection.content_type.as_str(),
            "application/vnd.apple.mpegurl"
                | "application/x-mpegURL"
                | "video/mp4"
                | "video/mp2t"
                | "audio/mpeg"
        ) {
            return Err("cast-media-type-unsupported");
        }
        let grant = self
            .issued
            .lock()
            .await
            .get(device_id)
            .cloned()
            .filter(|grant| grant.time.elapsed() < Duration::from_secs(120))
            .ok_or("cast-issued-handle-expired-revalidate")?;
        grant_is_current(&grant, &self.observe_network().await?)?;
        let endpoint = grant.endpoint.clone();
        let owned = Arc::new(OwnedSession {
            network: grant.network.clone(),
            id: session_id.into(),
            selection: selection.id.clone(),
            cancel: AtomicBool::new(false),
            engine: Mutex::new(None),
            relay: Mutex::new(None),
        });
        {
            let mut active = self.active.lock().await;
            if self.closing.load(Ordering::SeqCst) {
                return Err("cast-application-closing");
            }
            if active.is_some() {
                return Err("cast-owned-session-stop-required");
            }
            *active = Some(owned.clone());
        }
        let mut selection = selection;
        // Press Cast, pick the TV, it plays (owner decision, October 19, 2026):
        // a Chromecast fetches the stream itself when it may; otherwise GenX
        // relays it automatically, with no separate consent step.
        let relay_needed = match &endpoint {
            Endpoint::Chromecast { .. } => {
                allow_http_receiver || !receiver_can_fetch(&selection.url).await
            }
            Endpoint::Dlna { .. } => false,
        };
        if relay_needed {
            let Endpoint::Chromecast { address, .. } = &endpoint else {
                self.clear_owned(&owned).await;
                return Err("cast-receiver-relay-chromecast-only");
            };
            match tokio::time::timeout_at(
                deadline,
                receiver_relay::ReceiverRelay::start(*address, &selection, allow_http, true),
            )
            .await
            .map_err(|_| "cast-playback-timeout")?
            {
                Ok(relay) => {
                    selection.url = relay.media_url().to_string();
                    *owned.relay.lock().await = Some(relay);
                }
                Err(error) => {
                    self.clear_owned(&owned).await;
                    return Err(error);
                }
            }
        }
        let engine = match endpoint.clone() {
            Endpoint::Chromecast { address, .. } => tokio::time::timeout_at(
                deadline,
                chromecast::Session::connect(address, session_id.into()),
            )
            .await
            .unwrap_or(Err("cast-playback-timeout"))
            .map(|session| Engine::Chromecast(Box::new(session))),
            Endpoint::Dlna {
                control, service, ..
            } => dlna::Session::new(control, service).map(Engine::Dlna),
        };
        let engine = match engine {
            Ok(engine) => engine,
            Err(error) => {
                Self::stop_relay(&owned).await?;
                self.clear_owned(&owned).await;
                return Err(error);
            }
        };
        let mut guard = owned.engine.lock().await;
        if owned.cancel.load(Ordering::SeqCst) {
            return Err("cast-start-canceled");
        }
        *guard = Some(engine);
        let cancel = async {
            while !owned.cancel.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        let load = async {
            if self.observe_network().await? != grant.network {
                return Err("cast-network-changed");
            }
            let recheck = recheck_endpoint(&endpoint).await?;
            if recheck == "unavailable" && !grant.allow_unverified_identity {
                return Err("cast-identity-recheck-unavailable");
            }
            if self.observe_network().await? != grant.network {
                return Err("cast-network-changed");
            }
            match guard.as_mut().ok_or("cast-session-missing")? {
                Engine::Chromecast(engine) => engine.load(&selection).await,
                Engine::Dlna(engine) => engine.load(&selection).await,
            }
        };
        let loaded: Result<(), &'static str> = tokio::select! {
            result = tokio::time::timeout_at(deadline, load) => {
                result.map_err(|_| "cast-playback-timeout").and_then(|r| r.map(|_| ()))
            }
            _ = cancel => return Err("cast-start-canceled"),
        };
        if let Err(error) = loaded {
            // The TV refused or never started the stream: close its receiver app
            // so it does not sit on the cast screen (its Back button cannot leave
            // it), revoke any relay, and release the session once it confirms.
            let closed = tokio::time::timeout(Duration::from_secs(5), async {
                match guard.as_mut() {
                    Some(Engine::Chromecast(engine)) => engine.stop().await,
                    Some(Engine::Dlna(engine)) => engine.stop().await,
                    None => Ok(true),
                }
            })
            .await;
            drop(guard);
            let _ = Self::stop_relay(&owned).await;
            if matches!(closed, Ok(Ok(true))) {
                self.clear_owned(&owned).await;
            }
            return Err(error);
        }
        drop(guard);
        tokio::time::timeout_at(deadline, self.status(session_id))
            .await
            .map_err(|_| "cast-playback-timeout")?
    }
    async fn clear_owned(&self, owned: &Arc<OwnedSession>) {
        let mut active = self.active.lock().await;
        if active
            .as_ref()
            .is_some_and(|value| Arc::ptr_eq(value, owned))
        {
            *active = None;
        }
    }
    async fn stop_relay(owned: &OwnedSession) -> Result<(), &'static str> {
        let mut relay = owned.relay.lock().await;
        if let Some(value) = relay.as_mut() {
            value.stop().await?;
        }
        *relay = None;
        Ok(())
    }
    async fn owned(&self, id: &str) -> Result<Arc<OwnedSession>, &'static str> {
        self.active
            .lock()
            .await
            .as_ref()
            .filter(|session| session.id == id)
            .cloned()
            .ok_or("cast-session-not-owned")
    }
    pub async fn status(&self, session_id: &str) -> Result<CastStatus, &'static str> {
        let owned = self.owned(session_id).await?;
        if self.observe_network().await? != owned.network {
            Self::stop_relay(&owned).await?;
            return Err("cast-network-changed-remote-stop-unconfirmed");
        }
        let state = tokio::time::timeout(Duration::from_secs(5), async {
            let mut guard = owned.engine.lock().await;
            match guard.as_mut().ok_or("cast-session-connecting")? {
                Engine::Chromecast(engine) => engine.status().await,
                Engine::Dlna(engine) => engine.status().await,
            }
        })
        .await
        .map_err(|_| "cast-status-timeout")??;
        let (state, remote) = match state {
            ReceiverState::Playing(id) => ("playing", Some(id)),
            ReceiverState::Paused => ("paused", None),
            ReceiverState::Buffering => ("buffering", None),
            ReceiverState::Ended => ("ended", None),
        };
        if state == "ended" {
            Self::stop_relay(&owned).await?;
        } else if let Some(relay) = owned.relay.lock().await.as_ref() {
            relay.renew()?;
        }
        Ok(CastStatus {
            session_id: owned.id.clone(),
            selection_id: owned.selection.clone(),
            state: state.into(),
            remote_session_id: remote,
        })
    }
    /// Asks the receiver to stop this session's media (five seconds at most),
    /// then releases the session whether or not the receiver answered, and
    /// returns whether it confirmed. Switching to another TV, or stopping, is
    /// never held up by a TV that does not answer (owner decision, October 24,
    /// 2026): one that is asleep, off the network or already taken over by
    /// another phone used to block every later cast. The relay is revoked
    /// first, so a TV that was fed through it loses the stream either way.
    pub async fn stop(&self, session_id: &str) -> Result<bool, &'static str> {
        let owned = self.owned(session_id).await?;
        owned.cancel.store(true, Ordering::SeqCst);
        let relay = Self::stop_relay(&owned).await;
        let same_network =
            matches!(self.observe_network().await, Ok(network) if network == owned.network);
        let stopped = same_network
            && matches!(
                tokio::time::timeout(Duration::from_secs(5), async {
                    let mut guard = owned.engine.lock().await;
                    match guard.as_mut() {
                        Some(Engine::Chromecast(engine)) => engine.stop().await,
                        Some(Engine::Dlna(engine)) => engine.stop().await,
                        None => Ok(true),
                    }
                })
                .await,
                Ok(Ok(true))
            );
        self.clear_owned(&owned).await;
        Ok(stopped && relay.is_ok())
    }
    pub async fn shutdown(&self) -> Result<(), &'static str> {
        self.closing.store(true, Ordering::SeqCst);
        self.cancel.notify_waiters();
        let owned = self.active.lock().await.clone();
        if let Some(session) = &owned {
            session.cancel.store(true, Ordering::SeqCst);
        }
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.operations.load(Ordering::SeqCst) == 0 {
                break;
            }
            changed.await;
        }
        if let Some(session) = owned {
            // Closing the app releases the cast even when the TV does not
            // answer; the relay is already revoked by then.
            self.stop(&session.id).await?;
        }
        Ok(())
    }
}
/// The origin of Google's cast receiver page, which fetches cast media.
const RECEIVER_ORIGIN: &str = "https://www.gstatic.com";

/// Whether a Chromecast may fetch this stream itself. Its receiver plays only
/// HTTPS media whose actual responses grant cross-origin access; many free
/// channels grant it only to the preflight (SportsGrid) or not at all, and the
/// TV then shows its blue cast icon. One small ranged request answers it.
async fn receiver_can_fetch(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };
    if url.scheme() != "https" || crate::relay::validate_url(&url).is_err() {
        return false;
    }
    let Ok(client) = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(4))
        .build()
    else {
        return false;
    };
    let Ok(response) = client
        .get(url)
        .header(reqwest::header::ORIGIN, RECEIVER_ORIGIN)
        .header(reqwest::header::RANGE, "bytes=0-1023")
        .send()
        .await
    else {
        return false;
    };
    response.status().is_success()
        && grants_receiver(
            response
                .headers()
                .get(reqwest::header::ACCESS_CONTROL_ALLOW_ORIGIN),
        )
}

/// A response's cross-origin grant covers the cast receiver page.
fn grants_receiver(value: Option<&reqwest::header::HeaderValue>) -> bool {
    matches!(
        value.and_then(|v| v.to_str().ok()).map(str::trim),
        Some("*") | Some(RECEIVER_ORIGIN)
    )
}

#[cfg(test)]
mod tests;
