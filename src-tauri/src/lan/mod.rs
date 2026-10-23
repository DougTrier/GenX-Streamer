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

struct Request {
    method: String,
    path: String,
    origin: Option<String>,
    cookie: Option<String>,
    range: Option<String>,
    body: Vec<u8>,
}
struct Response {
    status: u16,
    body: Vec<u8>,
    content_type: String,
    extra: Vec<(String, String)>,
    upstream: Option<relay::OpenedUpstream>,
    owner: Option<RequestOwner>,
    manifest_budget: Option<tokio::sync::OwnedSemaphorePermit>,
    #[cfg(test)]
    writer_probe: Option<Arc<writer_tests::WriterProbe>>,
}
enum RequestOwner {
    Media(MediaPermit),
    Control(ControlPermit),
}
impl RequestOwner {
    fn valid(&self) -> bool {
        match self {
            Self::Media(permit) => permit.valid(),
            Self::Control(permit) => permit.valid(),
        }
    }
    async fn cancelled(&mut self) {
        match self {
            Self::Media(permit) => permit.cancelled().await,
            Self::Control(permit) => permit.cancelled().await,
        }
    }
}
fn response(status: u16, body: Vec<u8>) -> Response {
    Response {
        status,
        body,
        content_type: "application/json".into(),
        extra: Vec::new(),
        upstream: None,
        owner: None,
        manifest_budget: None,
        #[cfg(test)]
        writer_probe: None,
    }
}
fn error(status: u16, category: &str) -> Response {
    response(status, json(&serde_json::json!({"error": category})))
}
async fn read_request(
    stream: &mut TlsStream<tokio::net::TcpStream>,
) -> Result<Request, &'static str> {
    let mut bytes = Vec::new();
    let header_end;
    loop {
        let mut buffer = [0u8; 1024];
        let size = stream
            .read(&mut buffer)
            .await
            .map_err(|_| "request-read-failed")?;
        if size == 0 {
            return Err("request-incomplete");
        }
        bytes.extend_from_slice(&buffer[..size]);
        if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
            header_end = end + 4;
            break;
        }
        if bytes.len() > MAX_HEADER {
            return Err("request-header-large");
        }
    }
    if header_end > MAX_HEADER {
        return Err("request-header-large");
    }
    let text = std::str::from_utf8(&bytes[..header_end]).map_err(|_| "request-invalid")?;
    let mut lines = text.split("\r\n");
    let mut start = lines.next().ok_or("request-invalid")?.split(' ');
    let method = start.next().ok_or("request-invalid")?.to_string();
    let path = start.next().ok_or("request-invalid")?.to_string();
    if start.next() != Some("HTTP/1.1")
        || start.next().is_some()
        || !matches!(method.as_str(), "GET" | "POST")
        || path.len() > 256
        || !path.starts_with('/')
        || path.contains(['%', '\\', '?', '#'])
    {
        return Err("request-target-invalid");
    }
    let mut headers = HashMap::new();
    for line in lines.filter(|l| !l.is_empty()) {
        let (name, value) = line.split_once(':').ok_or("request-header-invalid")?;
        if name.is_empty()
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || headers
                .insert(name.to_ascii_lowercase(), value.trim().to_string())
                .is_some()
        {
            return Err("request-header-duplicate");
        }
    }
    if headers.contains_key("transfer-encoding") {
        return Err("request-transfer-refused");
    }
    let length = headers
        .get("content-length")
        .map(|v| v.parse::<usize>())
        .transpose()
        .map_err(|_| "request-length-invalid")?
        .unwrap_or(0);
    if length > MAX_BODY {
        return Err("request-body-large");
    }
    while bytes.len() < header_end + length {
        let mut buffer = [0u8; 1024];
        let size = stream
            .read(&mut buffer)
            .await
            .map_err(|_| "request-read-failed")?;
        if size == 0 {
            return Err("request-incomplete");
        }
        bytes.extend_from_slice(&buffer[..size]);
    }
    if bytes.len() != header_end + length {
        return Err("request-pipelining-refused");
    }
    Ok(Request {
        method,
        path,
        origin: headers.remove("origin"),
        cookie: headers.remove("cookie"),
        range: headers.remove("range"),
        body: bytes[header_end..].to_vec(),
    })
}
fn token(request: &Request) -> Option<&str> {
    request
        .cookie
        .as_deref()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(name, value)| *name == "tmg_viewer" && id(value))
        .map(|(_, value)| value)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairBody {
    secret: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HeartbeatBody {
    paused: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ControlBody {
    sequence: u64,
    revision: u64,
    action: ControlAction,
    channel_id: Option<String>,
    muted: Option<bool>,
    volume: Option<f64>,
}
impl ControlBody {
    fn valid(&self) -> bool {
        match self.action {
            ControlAction::Select => {
                self.channel_id
                    .as_ref()
                    .is_some_and(|id| !id.is_empty() && id.len() <= 256)
                    && self.muted.is_none()
                    && self.volume.is_none()
            }
            ControlAction::Mute => {
                self.muted.is_some() && self.channel_id.is_none() && self.volume.is_none()
            }
            ControlAction::Volume => {
                self.volume
                    .is_some_and(|volume| volume.is_finite() && (0.0..=1.0).contains(&volume))
                    && self.channel_id.is_none()
                    && self.muted.is_none()
            }
            _ => self.channel_id.is_none() && self.muted.is_none() && self.volume.is_none(),
        }
    }
}
async fn route(request: Request, shared: Arc<Mutex<State>>) -> Response {
    let permit = if matches!(request.path.as_str(), "/state" | "/channels" | "/control") {
        let Some(viewer) = token(&request) else {
            return error(401, "viewer-unauthorized");
        };
        let Ok(mut state) = shared.lock() else {
            return error(503, "state-unavailable");
        };
        let now = state.now();
        state.expire(now);
        match state.consumers.admit_control(viewer) {
            Ok(permit) => Some(permit),
            Err("consumer-control-limit" | "consumer-total-control-limit") => {
                let mut refused = error(429, "viewer-request-limit");
                refused.extra.push(("Retry-After".into(), "1".into()));
                return refused;
            }
            Err(_) => return error(401, "viewer-unauthorized"),
        }
    } else {
        None
    };
    if let Some(mut permit) = permit {
        let control_command = request.path == "/control";
        let mut result = tokio::select! {
            _ = permit.cancelled() => return if control_command { error(409, "control-application-unconfirmed") } else { error(401, "viewer-unauthorized") },
            result = route_inner(request, shared) => result,
        };
        if !permit.valid() {
            return if control_command {
                error(409, "control-application-unconfirmed")
            } else {
                error(401, "viewer-unauthorized")
            };
        }
        result.owner = Some(RequestOwner::Control(permit));
        result
    } else {
        route_inner(request, shared).await
    }
}
async fn route_inner(request: Request, shared: Arc<Mutex<State>>) -> Response {
    if request.method == "GET" {
        let asset = match request.path.as_str() {
            "/" => Some((
                include_str!("viewer.html").as_bytes(),
                "text/html; charset=utf-8",
            )),
            "/viewer.css" => Some((
                include_str!("viewer.css").as_bytes(),
                "text/css; charset=utf-8",
            )),
            "/viewer.js" => Some((
                include_str!("viewer.js").as_bytes(),
                "text/javascript; charset=utf-8",
            )),
            "/hls.js" => Some((
                include_str!("../../../node_modules/hls.js/dist/hls.min.js").as_bytes(),
                "text/javascript; charset=utf-8",
            )),
            _ => None,
        };
        if let Some((body, content_type)) = asset {
            return Response { status: 200, body: body.to_vec(), content_type: content_type.into(), extra: vec![("Content-Security-Policy".into(), "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; connect-src 'self'; worker-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'".into())], upstream: None, owner: None, manifest_budget: None, #[cfg(test)] writer_probe: None };
        }
    }

    if request.method == "POST" {
        let Ok(state) = shared.lock() else {
            return error(503, "state-unavailable");
        };
        if request.origin.as_deref() != Some(&state.origin) {
            return error(403, "origin-refused");
        }
    }
    if request.path == "/pair" && request.method == "POST" {
        let Ok(body) = serde_json::from_slice::<PairBody>(&request.body) else {
            return error(400, "pair-body-invalid");
        };
        let Ok(viewer) = opaque() else {
            return error(503, "entropy-unavailable");
        };
        let Ok(viewer_id) = opaque() else {
            return error(503, "entropy-unavailable");
        };
        let Ok(mut state) = shared.lock() else {
            return error(503, "state-unavailable");
        };
        let now = state.now();
        state.expire(now);
        if state
            .policy
            .pair(&body.secret, viewer.clone(), now)
            .is_err()
        {
            return error(403, "pairing-refused");
        }
        if state
            .consumers
            .register(&viewer, Instant::now() + Duration::from_secs(30))
            .is_err()
        {
            state.policy.revoke(&viewer);
            return error(503, "consumer-admission-unavailable");
        }
        state.viewers.insert(
            viewer_id.clone(),
            (viewer.clone(), now.saturating_add(30000)),
        );
        let controller = state.pending_controller.take();
        let role = if let Some((channels, labels)) = controller {
            state.controllers.insert(
                viewer.clone(),
                Controller {
                    channels,
                    labels,
                    sequence: 0,
                },
            );
            let _ = state.policy.heartbeat(&viewer, true, now);
            let _ =
                state
                    .consumers
                    .heartbeat(&viewer, true, Instant::now() + Duration::from_secs(30));
            "controller"
        } else {
            "viewer"
        };
        let mut result = response(
            200,
            json(
                &serde_json::json!({"paired":true,"viewerId":viewer_id,"role":role,"leaseMilliseconds":30000}),
            ),
        );
        result.extra.push((
            "Set-Cookie".into(),
            format!("tmg_viewer={viewer}; Secure; HttpOnly; SameSite=Strict; Path=/"),
        ));
        return result;
    }
    let Some(viewer) = token(&request) else {
        return error(401, "viewer-unauthorized");
    };
    if request.path == "/channels" && request.method == "GET" {
        let Ok(mut state) = shared.lock() else {
            return error(503, "state-unavailable");
        };
        let now = state.now();
        state.expire(now);
        if !state
            .viewers
            .values()
            .any(|(token, expiry)| token == viewer && *expiry > now)
        {
            return error(401, "viewer-unauthorized");
        }
        let Some(controller) = state.controllers.get(viewer) else {
            return error(403, "view-only-access");
        };
        return response(200, json(&controller.labels));
    }
    if request.path == "/state" && request.method == "POST" {
        let paused = if request.method == "POST" {
            let Ok(body) = serde_json::from_slice::<HeartbeatBody>(&request.body) else {
                return error(400, "state-body-invalid");
            };
            body.paused
        } else {
            false
        };
        let Ok(mut state) = shared.lock() else {
            return error(503, "state-unavailable");
        };
        let now = state.now();
        let Ok(channel) = state.policy.heartbeat(viewer, paused, now) else {
            return error(401, "viewer-unauthorized");
        };
        if state
            .consumers
            .heartbeat(viewer, paused, Instant::now() + Duration::from_secs(30))
            .is_err()
        {
            return error(401, "viewer-unauthorized");
        }
        if let Some((_, expiry)) = state
            .viewers
            .values_mut()
            .find(|(token, _)| token == viewer)
        {
            *expiry = now.saturating_add(30000);
        }
        return response(
            200,
            json(&ViewerState {
                revision: channel.as_ref().map(|c| c.revision),
                media_path: channel.map(|c| format!("/media/{}/{}", c.revision, c.media_id)),
            }),
        );
    }
    if request.path == "/control" && request.method == "POST" {
        {
            let Ok(state) = shared.lock() else {
                return error(503, "state-unavailable");
            };
            if !state.controllers.contains_key(viewer) {
                return error(403, "view-only-access");
            }
        }
        let Ok(body) = serde_json::from_slice::<ControlBody>(&request.body) else {
            return error(400, "control-body-invalid");
        };
        if !body.valid() {
            return error(400, "control-payload-invalid");
        }
        let (command_id, received) = {
            let Ok(mut state) = shared.lock() else {
                return error(503, "state-unavailable");
            };
            let now = state.now();
            state.expire(now);
            if state.policy.heartbeat(viewer, true, now).is_err() {
                return error(401, "viewer-unauthorized");
            }
            let Some(controller) = state.controllers.get(viewer) else {
                return error(403, "view-only-access");
            };
            if body.sequence == 0 || body.sequence <= controller.sequence {
                return error(409, "control-sequence-replayed");
            }
            if body.revision != state.revision {
                return error(409, "control-revision-obsolete");
            }
            if body
                .channel_id
                .as_ref()
                .is_some_and(|channel| !controller.channels.contains(channel))
            {
                return error(403, "control-channel-out-of-scope");
            }
            if state
                .pending_controls
                .values()
                .any(|pending| pending.token == viewer)
            {
                return error(409, "control-already-pending");
            }
            let Ok(command_id) = opaque() else {
                return error(503, "entropy-unavailable");
            };
            let (reply, received) = oneshot::channel();
            let command = ControlCommand {
                command_id: command_id.clone(),
                channel_id: body.channel_id,
                sequence: body.sequence,
                revision: body.revision,
                action: body.action,
                muted: body.muted,
                volume: body.volume,
                allowed_channel_ids: if matches!(
                    body.action,
                    ControlAction::Next | ControlAction::Previous
                ) {
                    let mut ids: Vec<_> = controller.channels.iter().cloned().collect();
                    ids.sort();
                    ids
                } else {
                    Vec::new()
                },
            };
            if state
                .consumers
                .heartbeat(viewer, true, Instant::now() + Duration::from_secs(30))
                .is_err()
            {
                return error(401, "viewer-unauthorized");
            }
            if state.command_sender.try_send(command).is_err() {
                return error(429, "control-queue-full");
            }
            state
                .controllers
                .get_mut(viewer)
                .expect("controller checked under lock")
                .sequence = body.sequence;
            if let Some((_, expiry)) = state
                .viewers
                .values_mut()
                .find(|(token, _)| token == viewer)
            {
                *expiry = now.saturating_add(30000);
            }
            state.pending_controls.insert(
                command_id.clone(),
                PendingControl {
                    token: viewer.into(),
                    expires: now.saturating_add(3000),
                    revision: body.revision,
                    reply,
                },
            );
            (command_id, received)
        };
        let confirmed = matches!(
            tokio::time::timeout(Duration::from_secs(3), received).await,
            Ok(Ok(true))
        );
        if let Ok(mut state) = shared.lock() {
            state.pending_controls.remove(&command_id);
        }
        return if confirmed {
            response(
                200,
                json(&serde_json::json!({"commandId":command_id,"applied":true})),
            )
        } else {
            error(409, "control-application-unconfirmed")
        };
    }
    if request.method != "GET" {
        return error(403, "view-only-access");
    }
    let parts: Vec<_> = request.path.split('/').collect();
    if parts.len() != 4 || parts[1] != "media" || !id(parts[3]) {
        return error(404, "resource-not-admitted");
    }
    let Ok(revision) = parts[2].parse::<u64>() else {
        return error(404, "resource-not-admitted");
    };
    let (target, allow_http, mut permit, budget) = {
        let Ok(mut state) = shared.lock() else {
            return error(503, "state-unavailable");
        };
        let now = state.now();
        state.expire(now);
        let Ok(target) = state.policy.resource(viewer, revision, parts[3], now) else {
            return error(401, "resource-unauthorized");
        };
        let permit = match state.consumers.admit_media(viewer, revision) {
            Ok(permit) => permit,
            Err("consumer-media-limit" | "consumer-total-media-limit") => {
                let mut refused = error(429, "viewer-request-limit");
                refused.extra.push(("Retry-After".into(), "1".into()));
                return refused;
            }
            Err(_) => return error(401, "resource-unauthorized"),
        };
        (
            target,
            state.allow_http,
            permit,
            state.manifest_budget.clone(),
        )
    };
    let Ok(url) = reqwest::Url::parse(&target) else {
        return error(502, "resource-invalid");
    };
    let upstream_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    #[cfg(test)]
    let fixture = shared
        .lock()
        .ok()
        .and_then(|state| state.fixture_upstream.clone());
    #[cfg(test)]
    let opening = async {
        if let Some(base) = fixture.clone() {
            open_fixture_upstream(url, request.range.clone(), base, upstream_deadline).await
        } else {
            relay::open_with_remaining_policy(
                url,
                request.range.clone(),
                allow_http,
                upstream_deadline,
                5,
            )
            .await
        }
    };
    #[cfg(not(test))]
    let opening = relay::open_with_remaining_policy(
        url,
        request.range.clone(),
        allow_http,
        upstream_deadline,
        5,
    );
    let mut reply = tokio::select! {
        _ = permit.cancelled() => return error(401, "resource-unauthorized"),
        result = opening => match result { Ok(reply) => reply, Err(_) => return error(502, "upstream-unavailable") },
    };
    if reply.body_kind == relay::BodyKind::Manifest
        && (reply.status == 206 || reply.content_range.is_some())
    {
        // Rewriting changes byte offsets: obtain the complete validated playlist once.
        // The initial request and this refetch share one deadline and redirect allowance.
        let canonical_url = reply.final_url.clone();
        let remaining_redirects = 5usize.saturating_sub(reply.redirects_used);
        drop(reply);
        #[cfg(test)]
        let opening = async {
            if let Some(base) = fixture {
                open_fixture_upstream(canonical_url, None, base, upstream_deadline).await
            } else {
                relay::open_with_remaining_policy(
                    canonical_url,
                    None,
                    allow_http,
                    upstream_deadline,
                    remaining_redirects,
                )
                .await
            }
        };
        #[cfg(not(test))]
        let opening = relay::open_with_remaining_policy(
            canonical_url,
            None,
            allow_http,
            upstream_deadline,
            remaining_redirects,
        );
        reply = tokio::select! {
            _ = permit.cancelled() => return error(401, "resource-unauthorized"),
            result = opening => match result { Ok(reply) => reply, Err(_) => return error(502, "upstream-unavailable") },
        };
        if reply.status == 206 || reply.content_range.is_some() {
            return error(502, "partial-manifest-unsupported");
        }
        if reply.status < 400 && reply.body_kind != relay::BodyKind::Manifest {
            return error(502, "canonical-manifest-invalid");
        }
    }
    if reply.status >= 400 {
        let mut failed = error(reply.status, "upstream-request-failed");
        if let Some(retry_after) = reply
            .retry_after
            .and_then(|value| safe_header(&value).map(str::to_string))
        {
            failed.extra.push(("Retry-After".into(), retry_after));
        }
        return failed;
    }
    let status = reply.status;
    let range = reply
        .content_range
        .clone()
        .and_then(|value| safe_header(&value).map(str::to_string));
    let content_type = safe_header(&reply.content_type)
        .unwrap_or("application/octet-stream")
        .to_string();
    let final_url = reply.final_url.clone();
    let (body, content_type, upstream, manifest_budget) = if reply.body_kind
        == relay::BodyKind::Manifest
    {
        if status == 206 || range.is_some() {
            return error(502, "partial-manifest-unsupported");
        }
        // Reserve input2MiB + rewritten output4MiB before collecting any manifest.
        let Ok(reservation) = budget.try_acquire_many_owned(6 * 1024 * 1024) else {
            let mut refused = error(503, "manifest-budget-unavailable");
            refused.extra.push(("Retry-After".into(), "1".into()));
            return refused;
        };
        let bytes = tokio::select! {
            _ = permit.cancelled() => return error(401, "resource-unauthorized"),
            result = reply.read_manifest() => match result { Ok(bytes) => bytes, Err(_) => return error(502, "manifest-invalid-or-large") },
        };
        let Ok(manifest) = std::str::from_utf8(&bytes) else {
            return error(502, "manifest-invalid");
        };
        if !supported_manifest(manifest) {
            return error(502, "manifest-feature-unsupported");
        }
        let Ok(mut state) = shared.lock() else {
            return error(503, "state-unavailable");
        };
        let now = state.now();
        if !permit.valid()
            || state
                .policy
                .resource(viewer, revision, parts[3], now)
                .is_err()
        {
            return error(401, "resource-unauthorized");
        }
        let mut staged: HashMap<String, String> = HashMap::new();
        let rewritten = relay::rewrite_hls(manifest, &final_url, |url| {
            if url.scheme() == "http" && !state.allow_http {
                return Err("upstream-http-denied");
            }
            let target = url.to_string();
            if target.len() > 8192 {
                return Err("manifest-target-large");
            }
            let resource = if let Some(resource) =
                state.resources.get(&target).or_else(|| staged.get(&target))
            {
                resource.clone()
            } else {
                if state.resources.len() + staged.len() >= 4096 {
                    return Err("resource-limit");
                }
                let resource = opaque()?;
                staged.insert(target, resource.clone());
                resource
            };
            Ok(format!("/media/{revision}/{resource}"))
        });
        let Ok(rewritten) = rewritten else {
            return error(502, "manifest-rewrite-refused");
        };
        let batch = staged
            .iter()
            .map(|(target, resource)| (resource.clone(), target.clone()))
            .collect();
        if state.policy.admit_resources(revision, batch).is_err() {
            return error(502, "manifest-rewrite-refused");
        }
        state.resources.extend(staged);
        (
            rewritten.into_bytes(),
            "application/vnd.apple.mpegurl".to_string(),
            None,
            Some(reservation),
        )
    } else {
        if !permit.valid() {
            return error(401, "resource-unauthorized");
        }
        (Vec::new(), content_type, Some(reply), None)
    };
    let mut result = Response {
        status,
        body,
        content_type,
        extra: Vec::new(),
        upstream,
        owner: Some(RequestOwner::Media(permit)),
        manifest_budget,
        #[cfg(test)]
        writer_probe: shared
            .lock()
            .ok()
            .and_then(|state| state.writer_probe.clone()),
    };
    if let Some(range) = range {
        result.extra.push(("Content-Range".into(), range));
    }
    result
}

#[cfg(test)]
async fn open_fixture_upstream(
    original: reqwest::Url,
    range: Option<String>,
    base: reqwest::Url,
    deadline: tokio::time::Instant,
) -> Result<relay::OpenedUpstream, &'static str> {
    if range
        .as_ref()
        .is_some_and(|value| !relay::validate_range(value))
    {
        return Err("range-refused");
    }
    let mut endpoint = base
        .join(original.path())
        .map_err(|_| "fixture-url-invalid")?;
    endpoint.set_query(original.query());
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "fixture-client-failed")?;
    let mut request = client.get(endpoint);
    if let Some(range) = range {
        request = request.header(reqwest::header::RANGE, range);
    }
    let response = tokio::time::timeout_at(deadline, request.send())
        .await
        .map_err(|_| "fixture-upstream-timeout")?
        .map_err(|_| "fixture-upstream-failed")?;
    let mut opened =
        relay::OpenedUpstream::from_test_response_with_deadline(response, deadline).await?;
    opened.final_url = original;
    Ok(opened)
}

fn supported_manifest(manifest: &str) -> bool {
    if manifest.contains("{$") {
        return false;
    }
    for line in manifest.lines().filter(|line| line.starts_with('#')) {
        if [
            "#EXT-X-DEFINE:",
            "#EXT-X-CONTENT-STEERING:",
            "#EXT-X-PART:",
            "#EXT-X-PRELOAD-HINT:",
            "#EXT-X-SERVER-CONTROL:",
            "#EXT-X-SKIP:",
        ]
        .iter()
        .any(|tag| line.starts_with(tag))
        {
            return false;
        }
        let mut remaining = line;
        while let Some(position) = remaining.find("URI=") {
            let tail = &remaining[position + 4..];
            let Some(quoted) = tail.strip_prefix('"') else {
                return false;
            };
            let Some(end) = quoted.find('"') else {
                return false;
            };
            remaining = &quoted[end + 1..];
        }
    }
    true
}
fn safe_header(value: &str) -> Option<&str> {
    if value.len() <= 256 && value.bytes().all(|b| (32..127).contains(&b)) {
        Some(value)
    } else {
        None
    }
}
async fn bounded_write<W: AsyncWrite + Unpin>(
    writer: &mut W,
    bytes: &[u8],
) -> Result<(), &'static str> {
    tokio::time::timeout(Duration::from_secs(5), writer.write_all(bytes))
        .await
        .map_err(|_| "response-timeout")?
        .map_err(|_| "response-write-failed")
}
async fn write_response<W: AsyncWrite + Unpin>(
    writer: &mut W,
    response: Response,
) -> Result<(), &'static str> {
    let Response {
        status,
        body,
        content_type,
        extra,
        mut upstream,
        mut owner,
        manifest_budget,
        #[cfg(test)]
        writer_probe,
    } = response;
    #[cfg(test)]
    let mut probed_writer = writer_tests::ProbeWriter::new(writer, writer_probe);
    #[cfg(test)]
    let writer = &mut probed_writer;
    // Keep this reservation and the request permit until the actual socket write settles.
    let _reservation = manifest_budget;
    let reason = match status {
        200 => "OK",
        206 => "Partial Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        409 => "Conflict",
        429 => "Too Many Requests",
        404 => "Not Found",
        502 => "Bad Gateway",
        _ => "Service Unavailable",
    };
    let framing = if upstream.is_some() {
        "Transfer-Encoding: chunked\r\n".to_string()
    } else {
        format!("Content-Length: {}\r\n", body.len())
    };
    let mut header = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\n{framing}Connection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n");
    for (name, value) in extra {
        header.push_str(&format!("{name}: {value}\r\n"));
    }
    header.push_str("\r\n");
    let writing = async {
        bounded_write(writer, header.as_bytes()).await?;
        if let Some(upstream) = upstream.as_mut() {
            while let Some(chunk) = upstream.next_chunk().await? {
                if chunk.is_empty() {
                    continue;
                }
                bounded_write(writer, format!("{:x}\r\n", chunk.len()).as_bytes()).await?;
                bounded_write(writer, chunk.as_ref()).await?;
                bounded_write(writer, b"\r\n").await?;
            }
            bounded_write(writer, b"0\r\n\r\n").await?;
        } else {
            bounded_write(writer, &body).await?;
        }
        tokio::time::timeout(Duration::from_secs(5), writer.shutdown())
            .await
            .map_err(|_| "response-timeout")?
            .map_err(|_| "response-write-failed")?;
        Ok(())
    };
    if let Some(owner) = owner.as_mut() {
        if !owner.valid() {
            return Err("consumer-cancelled");
        }
        tokio::select! {
            _ = owner.cancelled() => Err("consumer-cancelled"),
            result = writing => result,
        }
    } else {
        writing.await
    }
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
