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

//! Explicit TLS listener. Production certificates are supplied by the host; no trust bypass.
mod consumer_owner;
use crate::{
    relay,
    sharing_policy::{ChannelRevision, SharingPolicy},
};
use consumer_owner::{ConsumerOwners, ControlPermit, MediaPermit};
use rustls::{
    pki_types::{CertificateDer, PrivateKeyDer},
    ServerConfig,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpListener,
    sync::{mpsc, oneshot, Semaphore},
    task::{JoinHandle, JoinSet},
};
use tokio_rustls::{server::TlsStream, TlsAcceptor};

const MAX_CONNECTIONS: usize = 44;
const MAX_HEADER: usize = 16 * 1024;
const MAX_BODY: usize = 2048;

pub struct StartConfig {
    pub bind: SocketAddr,
    pub certificate_chain: Vec<Vec<u8>>,
    pub private_key: Vec<u8>,
    pub allow_http_upstream: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInfo {
    pub address: String,
    pub pairing_secret: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Publication {
    pub revision: u64,
    pub media_id: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTransitionReceipt {
    pub generation: u64,
    pub publication_revision: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerState {
    pub revision: Option<u64>,
    pub media_path: Option<String>,
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ControlAction {
    Select,
    Next,
    Previous,
    Pause,
    Resume,
    Mute,
    Volume,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlCommand {
    pub command_id: String,
    pub sequence: u64,
    pub revision: u64,
    pub action: ControlAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub allowed_channel_ids: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControllerChannel {
    pub id: String,
    pub name: String,
}
struct Controller {
    channels: HashSet<String>,
    labels: Vec<ControllerChannel>,
    sequence: u64,
}
struct PendingControl {
    token: String,
    expires: u64,
    revision: u64,
    reply: oneshot::Sender<bool>,
}
struct State {
    policy: SharingPolicy,
    consumers: ConsumerOwners,
    manifest_budget: Arc<Semaphore>,
    #[cfg(test)]
    fixture_upstream: Option<reqwest::Url>,
    #[cfg(test)]
    writer_probe: Option<Arc<writer_tests::WriterProbe>>,
    origin: String,
    started: Instant,
    allow_http: bool,
    resources: HashMap<String, String>,
    viewers: HashMap<String, (String, u64)>,
    pending_controller: Option<(HashSet<String>, Vec<ControllerChannel>)>,
    controllers: HashMap<String, Controller>,
    pending_controls: HashMap<String, PendingControl>,
    command_sender: mpsc::Sender<ControlCommand>,
    revision: u64,
    host_generation: u64,
}
impl State {
    fn expire(&mut self, now: u64) {
        self.policy.expire(now);
        let _ = self.consumers.expire(Instant::now());
        self.viewers.retain(|_, (_, expiry)| *expiry > now);
        let active: HashSet<String> = self
            .viewers
            .values()
            .map(|(token, _)| token.clone())
            .collect();
        self.controllers.retain(|token, _| active.contains(token));
        self.pending_controls
            .retain(|_, pending| pending.expires > now && active.contains(&pending.token));
    }
    fn now(&self) -> u64 {
        self.started.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
}
struct Running {
    state: Arc<Mutex<State>>,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
    join_failed: bool,
    commands: Arc<tokio::sync::Mutex<mpsc::Receiver<ControlCommand>>>,
}
#[derive(Default)]
pub struct LanManager {
    running: tokio::sync::Mutex<Option<Running>>,
    closing: AtomicBool,
}

fn opaque() -> Result<String, &'static str> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "lan-entropy-unavailable")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn json(value: &impl Serialize) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec())
}

impl LanManager {
    #[cfg(test)]
    async fn set_test_upstream(&self, base: &str) -> Result<(), &'static str> {
        let url = reqwest::Url::parse(base).map_err(|_| "fixture-url-invalid")?;
        let address = url
            .host_str()
            .and_then(|host| host.parse::<std::net::IpAddr>().ok());
        if url.scheme() != "http"
            || !address.is_some_and(|address| address.is_loopback())
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("fixture-url-refused");
        }
        let running = self.running.lock().await;
        let mut state = running
            .as_ref()
            .ok_or("lan-not-running")?
            .state
            .lock()
            .map_err(|_| "state-unavailable")?;
        state.fixture_upstream = Some(url);
        Ok(())
    }
    #[cfg(test)]
    async fn test_consumer_stats(&self) -> Result<consumer_owner::ConsumerStats, &'static str> {
        let running = self.running.lock().await;
        let state = running
            .as_ref()
            .ok_or("lan-not-running")?
            .state
            .lock()
            .map_err(|_| "state-unavailable")?;
        state.consumers.stats()
    }
    #[cfg(test)]
    async fn test_writer_probe(&self, probe: Arc<writer_tests::WriterProbe>) {
        let running = self.running.lock().await;
        running.as_ref().unwrap().state.lock().unwrap().writer_probe = Some(probe);
    }
    pub async fn start(&self, config: StartConfig) -> Result<StartInfo, &'static str> {
        let mut running = self.running.lock().await;
        if self.closing.load(Ordering::SeqCst) {
            return Err("lan-owner-closing");
        }
        if running.is_some() {
            return Err("lan-already-running");
        }
        if config.bind.ip().is_unspecified()
            || config.bind.ip().is_multicast()
            || !(config.bind.ip().is_loopback()
                || matches!(config.bind.ip(), std::net::IpAddr::V4(ip) if ip.is_private()))
        {
            return Err("lan-interface-must-be-explicit-private-address");
        }
        if config.certificate_chain.is_empty()
            || config.certificate_chain.len() > 8
            || config.certificate_chain.iter().any(|c| c.len() > 65536)
            || config.private_key.len() > 65536
        {
            return Err("lan-certificate-invalid");
        }
        let chain = config
            .certificate_chain
            .into_iter()
            .map(CertificateDer::from)
            .collect();
        let key = PrivateKeyDer::try_from(config.private_key).map_err(|_| "lan-key-invalid")?;
        let tls =
            ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .map_err(|_| "lan-tls-invalid")?
                .with_no_client_auth()
                .with_single_cert(chain, key)
                .map_err(|_| "lan-certificate-invalid")?;
        let listener = TcpListener::bind(config.bind)
            .await
            .map_err(|_| "lan-bind-failed")?;
        if self.closing.load(Ordering::SeqCst) {
            return Err("lan-owner-closing");
        }
        let address = listener
            .local_addr()
            .map_err(|_| "lan-address-unavailable")?;
        let origin = format!("https://{address}");
        let pairing_secret = opaque()?;
        let (command_sender, commands) = mpsc::channel(32);
        let state = Arc::new(Mutex::new(State {
            policy: SharingPolicy::start(pairing_secret.clone(), 0)?,
            consumers: ConsumerOwners::new(),
            manifest_budget: Arc::new(Semaphore::new(96 * 1024 * 1024)),
            #[cfg(test)]
            fixture_upstream: None,
            #[cfg(test)]
            writer_probe: None,
            origin: origin.clone(),
            started: Instant::now(),
            allow_http: config.allow_http_upstream,
            resources: HashMap::new(),
            viewers: HashMap::new(),
            pending_controller: None,
            controllers: HashMap::new(),
            pending_controls: HashMap::new(),
            command_sender,
            revision: 0,
            host_generation: 0,
        }));
        let (stop, cancelled) = oneshot::channel();
        let task = tokio::spawn(serve(
            listener,
            TlsAcceptor::from(Arc::new(tls)),
            state.clone(),
            cancelled,
        ));
        *running = Some(Running {
            state,
            stop: Some(stop),
            task,
            join_failed: false,
            commands: Arc::new(tokio::sync::Mutex::new(commands)),
        });
        Ok(StartInfo {
            address: origin,
            pairing_secret,
        })
    }
    pub async fn invite(&self) -> Result<String, &'static str> {
        let running = self.running.lock().await;
        let mut state = running
            .as_ref()
            .ok_or("lan-not-running")?
            .state
            .lock()
            .map_err(|_| "lan-state-unavailable")?;
        let secret = opaque()?;
        let now = state.now();
        state.policy.invite(secret.clone(), now)?;
        state.pending_controller = None;
        Ok(secret)
    }
    pub async fn invite_controller(
        &self,
        channel_ids: Vec<String>,
    ) -> Result<String, &'static str> {
        self.invite_controller_labeled(channel_ids, Vec::new())
            .await
    }
    pub async fn invite_controller_labeled(
        &self,
        channel_ids: Vec<String>,
        labels: Vec<ControllerChannel>,
    ) -> Result<String, &'static str> {
        if channel_ids.iter().map(String::len).sum::<usize>() > 1024 * 1024
            || channel_ids.is_empty()
            || channel_ids.len() > 100000
            || channel_ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control))
        {
            return Err("controller-channel-scope-invalid");
        }
        let scope: HashSet<String> = channel_ids.iter().cloned().collect();
        if scope.len() != channel_ids.len()
            || labels.len() > channel_ids.len()
            || labels
                .iter()
                .map(|label| label.id.len() + label.name.len())
                .sum::<usize>()
                > 4 * 1024 * 1024
        {
            return Err("controller-labels-invalid");
        }
        let mut names = HashMap::new();
        for label in labels {
            if !scope.contains(&label.id)
                || label.name.trim().is_empty()
                || label.name.len() > 160
                || label.name.chars().any(char::is_control)
                || names.insert(label.id, label.name).is_some()
            {
                return Err("controller-labels-invalid");
            }
        }
        let labels = channel_ids
            .into_iter()
            .enumerate()
            .map(|(index, id)| ControllerChannel {
                name: names
                    .remove(&id)
                    .unwrap_or_else(|| format!("Channel {}", index + 1)),
                id,
            })
            .collect();
        let running = self.running.lock().await;
        let mut state = running
            .as_ref()
            .ok_or("lan-not-running")?
            .state
            .lock()
            .map_err(|_| "lan-state-unavailable")?;
        let secret = opaque()?;
        let now = state.now();
        state.policy.invite(secret.clone(), now)?;
        state.pending_controller = Some((scope, labels));
        Ok(secret)
    }
    pub async fn next_control(&self) -> Result<Option<ControlCommand>, &'static str> {
        let commands = {
            let running = self.running.lock().await;
            running.as_ref().ok_or("lan-not-running")?.commands.clone()
        };
        let command = tokio::time::timeout(Duration::from_millis(250), async {
            commands.lock().await.recv().await
        })
        .await
        .ok()
        .flatten();
        match command {
            Some(command) if self.control_active(&command.command_id).await => Ok(Some(command)),
            _ => Ok(None),
        }
    }
    pub async fn control_active(&self, command_id: &str) -> bool {
        let running = self.running.lock().await;
        let Some(running) = running.as_ref() else {
            return false;
        };
        let Ok(state) = running.state.lock() else {
            return false;
        };
        let now = state.now();
        state
            .pending_controls
            .get(command_id)
            .is_some_and(|pending| {
                pending.expires > now
                    && pending.revision == state.revision
                    && state.controllers.contains_key(&pending.token)
                    && state
                        .viewers
                        .values()
                        .any(|(token, expiry)| token == &pending.token && *expiry > now)
            })
    }
    pub async fn control_allows(&self, command_id: &str, channel_id: &str) -> bool {
        let running = self.running.lock().await;
        let Some(running) = running.as_ref() else {
            return false;
        };
        let Ok(state) = running.state.lock() else {
            return false;
        };
        let now = state.now();
        state
            .pending_controls
            .get(command_id)
            .is_some_and(|pending| {
                pending.expires > now
                    && pending.revision == state.revision
                    && state
                        .controllers
                        .get(&pending.token)
                        .is_some_and(|controller| controller.channels.contains(channel_id))
            })
    }
    /// The host calls this only after observing the requested channel applied.
    pub async fn acknowledge_control(
        &self,
        command_id: &str,
        applied: bool,
    ) -> Result<bool, &'static str> {
        let running = self.running.lock().await;
        let mut state = running
            .as_ref()
            .ok_or("lan-not-running")?
            .state
            .lock()
            .map_err(|_| "lan-state-unavailable")?;
        let Some(pending) = state.pending_controls.remove(command_id) else {
            return Ok(false);
        };
        let now = state.now();
        let confirmed = applied
            && pending.expires > now
            && pending.revision == state.revision
            && state.controllers.contains_key(&pending.token)
            && state
                .viewers
                .values()
                .any(|(token, expiry)| token == &pending.token && *expiry > now);
        let _ = pending.reply.send(confirmed);
        Ok(confirmed)
    }
    pub async fn publish(&self, source_url: &str) -> Result<Publication, &'static str> {
        self.publish_inner(source_url, None).await
    }
    pub async fn publish_guarded(
        &self,
        source_url: &str,
        generation: u64,
    ) -> Result<Publication, &'static str> {
        self.publish_inner(source_url, Some(generation)).await
    }
    pub async fn selection_changed(
        &self,
        generation: u64,
        command_id: Option<&str>,
    ) -> Result<(), &'static str> {
        self.selection_changed_with_publication(generation, command_id, false)
            .await
            .map(|_| ())
    }
    pub async fn selection_changed_with_publication(
        &self,
        generation: u64,
        command_id: Option<&str>,
        preserve_publication: bool,
    ) -> Result<HostTransitionReceipt, &'static str> {
        if generation > 9_007_199_254_740_991 {
            return Err("lan-host-generation-invalid");
        }
        let running = self.running.lock().await;
        let mut state = running
            .as_ref()
            .ok_or("lan-not-running")?
            .state
            .lock()
            .map_err(|_| "lan-state-unavailable")?;
        if generation < state.host_generation {
            return Err("lan-obsolete-host-generation");
        }
        if generation == state.host_generation {
            return Ok(HostTransitionReceipt {
                generation: state.host_generation,
                publication_revision: state.revision,
            });
        }
        let preserved = command_id.filter(|id| {
            state.pending_controls.get(*id).is_some_and(|pending| {
                pending.revision == state.revision
                    && pending.expires > state.now()
                    && state.controllers.contains_key(&pending.token)
                    && state
                        .viewers
                        .values()
                        .any(|(token, expiry)| token == &pending.token && *expiry > state.now())
            })
        });
        if command_id.is_some() && preserved.is_none() {
            return Err("control-command-inactive");
        }
        state.host_generation = generation;
        if !preserve_publication {
            state.consumers.invalidate_publication()?;
            state.policy.invalidate_publication();
            state.resources.clear();
            state.revision = 0;
        }
        let revision = state.revision;
        state.pending_controls.retain(|id, pending| {
            if Some(id.as_str()) == preserved {
                pending.revision = revision;
                true
            } else {
                false
            }
        });
        Ok(HostTransitionReceipt {
            generation: state.host_generation,
            publication_revision: state.revision,
        })
    }
    async fn publish_inner(
        &self,
        source_url: &str,
        generation: Option<u64>,
    ) -> Result<Publication, &'static str> {
        if source_url.len() > 8192 {
            return Err("lan-publication-invalid");
        }
        let url = reqwest::Url::parse(source_url).map_err(|_| "lan-publication-invalid")?;
        relay::validate_url(&url)?;
        let running = self.running.lock().await;
        let mut state = running
            .as_ref()
            .ok_or("lan-not-running")?
            .state
            .lock()
            .map_err(|_| "lan-state-unavailable")?;
        if url.scheme() == "http" && !state.allow_http {
            return Err("lan-upstream-http-denied");
        }
        if generation.is_some_and(|generation| {
            generation != state.host_generation || generation > 9_007_199_254_740_991
        }) {
            return Err("lan-obsolete-host-generation");
        }
        // DNS and redirect admission is enforced by relay::fetch before every network request.
        let media_id = opaque()?;
        let ChannelRevision { revision, .. } = state.policy.publish(media_id.clone())?;
        state.consumers.publish(revision)?;
        state.resources.clear();
        state.revision = revision;
        state
            .policy
            .admit_resource(revision, media_id.clone(), url.to_string())?;
        state.resources.insert(url.to_string(), media_id.clone());
        Ok(Publication { revision, media_id })
    }
    pub async fn revoke(&self, viewer_id: &str) -> Result<(), &'static str> {
        let running = self.running.lock().await;
        let mut state = running
            .as_ref()
            .ok_or("lan-not-running")?
            .state
            .lock()
            .map_err(|_| "lan-state-unavailable")?;
        if let Some((token, _)) = state.viewers.remove(viewer_id) {
            state.consumers.revoke(&token)?;
            state.policy.revoke(&token);
            state.controllers.remove(&token);
            state
                .pending_controls
                .retain(|_, pending| pending.token != token);
        }
        Ok(())
    }
    pub async fn viewers(&self) -> Result<Vec<String>, &'static str> {
        let running = self.running.lock().await;
        let mut state = running
            .as_ref()
            .ok_or("lan-not-running")?
            .state
            .lock()
            .map_err(|_| "lan-state-unavailable")?;
        let now = state.now();
        state.expire(now);
        Ok(state.viewers.keys().cloned().collect())
    }
    pub async fn stop(&self) -> Result<(), &'static str> {
        let mut owner = self.running.lock().await;
        let Some(running) = owner.as_mut() else {
            return Ok(());
        };
        if running.join_failed {
            return Err("lan-stop-task-failed");
        }
        if let Ok(mut state) = running.state.lock() {
            let _ = state.consumers.stop();
            state.policy.stop();
            state.resources.clear();
            state.viewers.clear();
            state.controllers.clear();
            state.pending_controls.clear();
            state.pending_controller = None;
        }
        if let Some(stop) = running.stop.take() {
            let _ = stop.send(());
        }
        // Keep the task in its owner across timeout or cancellation of this waiter.
        // Aborting serve would drop its JoinSet before the child joins settle.
        match tokio::time::timeout(Duration::from_secs(2), &mut running.task).await {
            Err(_) => Err("lan-stop-deadline"),
            Ok(Err(_)) => {
                running.join_failed = true;
                Err("lan-stop-task-failed")
            }
            Ok(Ok(())) => {
                *owner = None;
                Ok(())
            }
        }
    }
    pub async fn shutdown(&self) -> Result<(), &'static str> {
        self.closing.store(true, Ordering::SeqCst);
        self.stop().await
    }
}

async fn serve(
    listener: TcpListener,
    acceptor: TlsAcceptor,
    state: Arc<Mutex<State>>,
    mut stop: oneshot::Receiver<()>,
) {
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let preauth = Arc::new(Semaphore::new(4));
    let mut connections = JoinSet::new();
    let mut expiry = tokio::time::interval(Duration::from_millis(100));
    loop {
        tokio::select! {
            _ = &mut stop => break,
            _ = expiry.tick() => {
                if let Ok(mut state) = state.lock() {
                    let now = state.now();
                    state.expire(now);
                }
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {},
            incoming = listener.accept() => {
                let Ok((socket, _address)) = incoming else { break; };
                let Ok(slot) = slots.clone().try_acquire_owned() else { continue; };
                let preauth = preauth.clone();
                let acceptor = acceptor.clone(); let state = state.clone();
                connections.spawn(async move {
                    let _slot = slot;
                    let _ = tokio::time::timeout(Duration::from_secs(30), async {
                        // Bounded pending connections admit normal parallel browser bootstrap.
                        let authentication = tokio::time::timeout(Duration::from_secs(5), preauth.acquire_owned()).await.map_err(|_| "authentication-queue-timeout")?.map_err(|_| "authentication-queue-closed")?;
                        let mut stream = tokio::time::timeout(Duration::from_secs(5), acceptor.accept(socket)).await.map_err(|_| "tls-timeout")?.map_err(|_| "tls-failed")?;
                        let request = match tokio::time::timeout(Duration::from_secs(5), read_request(&mut stream)).await {
                            Ok(Ok(request)) => request,
                            _ => { let _ = write_response(&mut stream,error(400,"request-refused")).await; return Ok(()); }
                        };
                        drop(authentication);
                        let (mut reader, mut writer) = tokio::io::split(stream);
                        let mut unexpected = [0u8; 1];
                        // Close-after-one-request: disappearance or pipelining drops owned upstream work.
                        tokio::select! {
                            _ = reader.read(&mut unexpected) => Err("client-disconnected"),
                            result = async {
                                let response = route(request, state).await;
                                write_response(&mut writer, response).await
                            } => result,
                        }
                    }).await;
                });
            }
        }
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
}

#[cfg(test)]
mod consumer_tests;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod manifest_tests;
#[cfg(test)]
mod stop_tests;
#[cfg(test)]
mod writer_tests;

// This module's parts, by area, are in this folder.
mod http;
use http::*;
mod routes;
use routes::*;
