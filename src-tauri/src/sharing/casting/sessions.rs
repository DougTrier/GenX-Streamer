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

//! Cast sessions: one per TV, several TVs at once, each with its own channel,
//! receiver connection and relay (owner request, October 24, 2026).

use super::{
    chromecast, dlna, grant_is_current, receiver_relay, recheck_endpoint, CastStatus,
    CastingManager, Endpoint, MediaSelection, ReceiverNetworkScope,
};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    task::Poll,
    time::Duration,
};
use tokio::sync::Mutex;

/// TVs that can be cast to at the same time. Each holds a receiver
/// connection and possibly a relay; a household rarely has more.
pub(super) const MAX_SESSIONS: usize = 4;

pub(super) enum Engine {
    Chromecast(Box<chromecast::Session>),
    Dlna(dlna::Session),
}
pub(super) enum ReceiverState {
    Playing(String),
    Paused,
    Buffering,
    Ended,
}
pub(super) struct OwnedSession {
    network: ReceiverNetworkScope,
    id: String,
    /// The TV this session casts to; no two sessions share one.
    target: String,
    selection: String,
    cancel: AtomicBool,
    engine: Mutex<Option<Engine>>,
    relay: Mutex<Option<receiver_relay::ReceiverRelay>>,
}
impl Endpoint {
    /// Which TV this is, whatever roster id discovery gave it this time.
    fn target(&self) -> String {
        match self {
            Self::Chromecast { address, .. } => format!("cast:{address}"),
            Self::Dlna { control, .. } => format!("dlna:{control}"),
        }
    }
}
impl OwnedSession {
    pub(super) fn new(
        id: &str,
        target: String,
        selection: &str,
        network: ReceiverNetworkScope,
    ) -> Self {
        Self {
            network,
            id: id.into(),
            target,
            selection: selection.into(),
            cancel: AtomicBool::new(false),
            engine: Mutex::new(None),
            relay: Mutex::new(None),
        }
    }
}
impl CastingManager {
    /// Takes a new session into the map. Choosing a TV that is already
    /// casting replaces only that TV's cast (returned, for the caller to
    /// release); the other TVs keep playing.
    async fn admit(
        &self,
        owned: &Arc<OwnedSession>,
    ) -> Result<Option<Arc<OwnedSession>>, &'static str> {
        let mut active = self.active.lock().await;
        if self.closing.load(Ordering::SeqCst) {
            return Err("cast-application-closing");
        }
        if active.contains_key(&owned.id) {
            return Err("cast-session-duplicate");
        }
        let replaced = active
            .values()
            .find(|session| session.target == owned.target)
            .cloned();
        if replaced.is_none() && active.len() >= MAX_SESSIONS {
            return Err("cast-session-limit");
        }
        if let Some(previous) = &replaced {
            active.remove(&previous.id);
        }
        active.insert(owned.id.clone(), owned.clone());
        Ok(replaced)
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
        let owned = Arc::new(OwnedSession::new(
            session_id,
            endpoint.target(),
            &selection.id,
            grant.network.clone(),
        ));
        if let Some(previous) = self.admit(&owned).await? {
            Self::release(&previous, Some(&grant.network)).await;
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
            .get(&owned.id)
            .is_some_and(|value| Arc::ptr_eq(value, owned))
        {
            active.remove(&owned.id);
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
            .get(id)
            .cloned()
            .ok_or("cast-session-not-owned")
    }
    /// The TV's own report for this session. A TV whose viewer pressed Back
    /// or Home, that another phone took over, or whose media went idle reports
    /// `ended`; a TV that is off, gone from the network or hung up fails the
    /// check. Either way the page then releases this session alone.
    pub async fn status(&self, session_id: &str) -> Result<CastStatus, &'static str> {
        let owned = self.owned(session_id).await?;
        if self.observe_network().await? != owned.network {
            Self::stop_relay(&owned).await?;
            return Err("cast-network-changed-remote-stop-unconfirmed");
        }
        let state = tokio::time::timeout(Duration::from_secs(5), async {
            let mut guard = owned.engine.lock().await;
            match guard.as_mut().ok_or("cast-session-connecting")? {
                Engine::Chromecast(engine) => {
                    let state = engine.status().await?;
                    Ok((state, engine.on_screen()))
                }
                Engine::Dlna(engine) => Ok((engine.status().await?, None)),
            }
        })
        .await
        .unwrap_or(Err("cast-status-timeout"));
        let (state, on_screen) = match state {
            Ok(state) => state,
            Err("cast-session-connecting") => return Err("cast-session-connecting"),
            Err(error) => {
                // A TV that is off, gone or hung up feeds no one: revoke its
                // relay now; the page releases the session.
                Self::stop_relay(&owned).await?;
                return Err(error);
            }
        };
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
            on_screen,
        })
    }
    /// Asks the receiver to stop this session's media (five seconds at most),
    /// then releases the session whether or not the receiver answered, and
    /// returns whether it confirmed. Switching to another TV, or stopping, is
    /// never held up by a TV that does not answer (owner decision, October 24,
    /// 2026): one that is asleep, off the network or already taken over by
    /// another phone used to block every later cast. The relay is revoked
    /// first, so a TV that was fed through it loses the stream either way.
    /// Other TVs' sessions are not touched.
    pub async fn stop(&self, session_id: &str) -> Result<bool, &'static str> {
        let owned = self.owned(session_id).await?;
        let network = self.observe_network().await.ok();
        let stopped = Self::release(&owned, network.as_ref()).await;
        self.clear_owned(&owned).await;
        Ok(stopped)
    }
    /// Cancels a session's start, revokes its relay and asks its TV to stop
    /// (five seconds at most, and only on the network it was started on).
    async fn release(owned: &OwnedSession, network: Option<&ReceiverNetworkScope>) -> bool {
        owned.cancel.store(true, Ordering::SeqCst);
        let relay = Self::stop_relay(owned).await;
        let stopped = network == Some(&owned.network)
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
        stopped && relay.is_ok()
    }
    pub async fn shutdown(&self) -> Result<(), &'static str> {
        self.closing.store(true, Ordering::SeqCst);
        self.cancel.notify_waiters();
        for session in self.active.lock().await.values() {
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
        // Closing the app releases every cast even when a TV does not answer;
        // the TVs are asked together, so closing waits five seconds at most.
        let sessions: Vec<_> = self.active.lock().await.drain().map(|(_, s)| s).collect();
        if sessions.is_empty() {
            return Ok(());
        }
        let network = self.observe_network().await.ok();
        join_all(
            sessions
                .iter()
                .map(|session| Self::release(session, network.as_ref())),
        )
        .await;
        Ok(())
    }
}
/// Runs the futures together and waits for all of them (the app's tokio has
/// no task spawning of its own).
async fn join_all<F: Future>(futures: impl Iterator<Item = F>) -> Vec<F::Output> {
    let mut pending: Vec<Pin<Box<F>>> = futures.map(Box::pin).collect();
    let mut done: Vec<Option<F::Output>> = pending.iter().map(|_| None).collect();
    std::future::poll_fn(|context| {
        let mut waiting = false;
        for (future, output) in pending.iter_mut().zip(done.iter_mut()) {
            if output.is_none() {
                match future.as_mut().poll(context) {
                    Poll::Ready(value) => *output = Some(value),
                    Poll::Pending => waiting = true,
                }
            }
        }
        if waiting {
            Poll::Pending
        } else {
            Poll::Ready(())
        }
    })
    .await;
    done.into_iter().flatten().collect()
}
/// The origin of Google's cast receiver page, which fetches cast media.
const RECEIVER_ORIGIN: &str = "https://www.gstatic.com";

/// Whether a Chromecast may fetch this stream itself. Its receiver plays only
/// HTTPS media whose actual responses grant cross-origin access; many free
/// channels grant it only to the preflight (SportsGrid) or not at all, and the
/// TV then shows its blue cast icon. One small ranged request answers it.
pub(super) async fn receiver_can_fetch(url: &str) -> bool {
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
pub(super) fn grants_receiver(value: Option<&reqwest::header::HeaderValue>) -> bool {
    matches!(
        value.and_then(|v| v.to_str().ok()).map(str::trim),
        Some("*") | Some(RECEIVER_ORIGIN)
    )
}

#[cfg(test)]
#[path = "sessions_tests.rs"]
mod tests;
