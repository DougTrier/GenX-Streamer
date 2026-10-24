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

use super::{protocol, MediaSelection, ReceiverState};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    DigitallySignedStruct, SignatureScheme,
};
use serde_json::{json, Value};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tokio_rustls::{client::TlsStream, TlsConnector};

/// Cast receivers use locally generated TLS certificates rather than public Web PKI.
/// This verifier is used only after a private-LAN discovery record was explicitly selected;
/// it verifies handshake signatures but is not Google Cast device-authentication attestation.
#[derive(Debug)]
struct LanReceiverVerifier {
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ServerCertVerifier for LanReceiverVerifier {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            certificate,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            certificate,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}
pub struct Session {
    stream: TlsStream<TcpStream>,
    incoming: Vec<u8>,
    outgoing: Vec<u8>,
    written: usize,
    sender: String,
    destination: Option<String>,
    receiver_session: Option<String>,
    media_session: Option<i64>,
    owned_url: Option<String>,
    /// Why the owned media last went idle ("ERROR", "FINISHED"...), if said.
    idle_reason: Option<String>,
    /// The last status showed another sender's media on the receiver.
    foreign_media: bool,
    /// The TV closed the cast app GenX launched: Back or Home on its remote,
    /// another phone's app, or sleep. Nothing of GenX's plays there any more.
    app_closed: bool,
    /// Whether the TV shows this cast: false on another input or in standby.
    on_screen: Option<bool>,
    /// The media time the TV last reported for GenX's stream, the time at the
    /// previous status check, whether it has ever moved, and for how many
    /// checks it has stood still while the TV said it was playing.
    media_time: Option<f64>,
    checked_time: Option<f64>,
    time_moved: bool,
    frozen_checks: u32,
    request: u32,
}
/// The default media receiver, GenX's cast app on the TV.
const MEDIA_RECEIVER: &str = "CC1AD845";
/// Checks (two seconds apart) a picture may stand still while the TV says it
/// plays: shown as buffering after three, ended after fifteen (thirty seconds).
const FROZEN_BUFFERING: u32 = 3;
const FROZEN_ENDED: u32 = 15;
impl Session {
    pub async fn connect(address: SocketAddr, sender: String) -> Result<Self, &'static str> {
        if !super::private_address(address.ip()) {
            return Err("cast-device-address-refused");
        }
        Self::connect_transport(address, sender).await
    }
    async fn connect_transport(address: SocketAddr, sender: String) -> Result<Self, &'static str> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .map_err(|_| "cast-tls-config")?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(LanReceiverVerifier { provider }))
            .with_no_client_auth();
        let tcp = tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(address))
            .await
            .map_err(|_| "cast-connect-timeout")?
            .map_err(|_| "cast-connect")?;
        let server_name = ServerName::IpAddress(address.ip().into());
        let stream = tokio::time::timeout(
            Duration::from_secs(3),
            TlsConnector::from(Arc::new(config)).connect(server_name, tcp),
        )
        .await
        .map_err(|_| "cast-tls-timeout")?
        .map_err(|_| "cast-tls")?;
        let mut session = Self {
            stream,
            incoming: Vec::new(),
            outgoing: Vec::new(),
            written: 0,
            sender,
            destination: None,
            receiver_session: None,
            media_session: None,
            owned_url: None,
            idle_reason: None,
            foreign_media: false,
            app_closed: false,
            on_screen: None,
            media_time: None,
            checked_time: None,
            time_moved: false,
            frozen_checks: 0,
            request: 0,
        };
        session
            .send(
                "receiver-0",
                protocol::CONNECTION,
                json!({"type":"CONNECT"}),
            )
            .await?;
        Ok(session)
    }
    async fn send(
        &mut self,
        destination: &str,
        namespace: &str,
        mut payload: Value,
    ) -> Result<(), &'static str> {
        if !self.outgoing.is_empty() {
            tokio::time::timeout(Duration::from_secs(3), self.flush_frame())
                .await
                .map_err(|_| "cast-write-timeout")??;
        }
        self.request = self.request.checked_add(1).ok_or("cast-request-limit")?;
        if namespace == protocol::RECEIVER || namespace == protocol::MEDIA {
            payload["requestId"] = json!(self.request);
        }
        self.outgoing = protocol::encode(&self.sender, destination, namespace, &payload)?;
        self.written = 0;
        tokio::time::timeout(Duration::from_secs(3), self.flush_frame())
            .await
            .map_err(|_| "cast-write-timeout")?
    }
    async fn flush_frame(&mut self) -> Result<(), &'static str> {
        while self.written < self.outgoing.len() {
            let count = self
                .stream
                .write(&self.outgoing[self.written..])
                .await
                .map_err(|_| "cast-write")?;
            if count == 0 {
                return Err("cast-connection-closed");
            }
            self.written += count;
        }
        self.outgoing.clear();
        self.written = 0;
        Ok(())
    }
    async fn receive(&mut self) -> Result<protocol::Message, &'static str> {
        loop {
            while self.incoming.len() < 4 {
                self.read_chunk().await?;
            }
            let size = u32::from_be_bytes(self.incoming[..4].try_into().map_err(|_| "cast-read")?)
                as usize;
            if size == 0 || size > protocol::MAX_FRAME {
                return Err("cast-frame-limit");
            }
            while self.incoming.len() < size + 4 {
                self.read_chunk().await?;
            }
            let body = self.incoming[4..size + 4].to_vec();
            self.incoming.drain(..size + 4);
            let message = protocol::decode(&body)?;
            if message.destination != self.sender && message.destination != "*" {
                continue;
            }
            if message.namespace == protocol::HEARTBEAT && message.payload["type"] == "PING" {
                self.send(&message.source, protocol::HEARTBEAT, json!({"type":"PONG"}))
                    .await?;
                continue;
            }
            return Ok(message);
        }
    }
    // read() is cancellation-safe and consumed bytes are immediately retained on the session.
    // Timing out a partial status frame must not corrupt the next Stop/status transaction.
    async fn read_chunk(&mut self) -> Result<(), &'static str> {
        let mut bytes = [0; 4096];
        let count = self
            .stream
            .read(&mut bytes)
            .await
            .map_err(|_| "cast-read")?;
        if count == 0 {
            return Err("cast-connection-closed");
        }
        if self.incoming.len() + count > protocol::MAX_FRAME + 4100 {
            return Err("cast-frame-limit");
        }
        self.incoming.extend_from_slice(&bytes[..count]);
        Ok(())
    }
    pub async fn verify_receiver(&mut self) -> Result<(), &'static str> {
        self.send(
            "receiver-0",
            protocol::RECEIVER,
            json!({"type":"GET_STATUS"}),
        )
        .await?;
        let request = self.request;
        for _ in 0..32 {
            let message = self.receive().await?;
            if message.source == "receiver-0"
                && message.namespace == protocol::RECEIVER
                && message.payload["type"] == "RECEIVER_STATUS"
                && message.payload["requestId"].as_u64() == Some(u64::from(request))
                && message.payload["status"].is_object()
            {
                return Ok(());
            }
        }
        Err("cast-known-receiver-status-unverified")
    }

    /// Asks the TV itself (not the cast app) for its status: the apps it runs,
    /// and whether it is on screen.
    async fn receiver_status(&mut self) -> Result<Value, &'static str> {
        self.send(
            "receiver-0",
            protocol::RECEIVER,
            json!({"type":"GET_STATUS"}),
        )
        .await?;
        let request = u64::from(self.request);
        loop {
            let message = self.receive().await?;
            if message.namespace == protocol::CONNECTION && self.closes_our_app(&message) {
                self.mark_app_closed();
            }
            if message.source == "receiver-0"
                && message.namespace == protocol::RECEIVER
                && message.payload["type"] == "RECEIVER_STATUS"
                && message.payload["requestId"].as_u64() == Some(request)
                && message.payload["status"].is_object()
            {
                return Ok(message.payload["status"].clone());
            }
        }
    }
    /// A media receiver app already on the TV, such as GenX's own from an
    /// earlier cast left behind when the TV switched input, keeps reporting
    /// that it plays while out of sight, and a new cast would join it there
    /// (Sansui, October 24, 2026). Close it so the new cast opens in front.
    async fn close_lingering_app(&mut self) -> Result<(), &'static str> {
        let status = self.receiver_status().await?;
        let Some(lingering) = status["applications"].as_array().and_then(|apps| {
            apps.iter()
                .find(|app| app["appId"] == MEDIA_RECEIVER)
                .and_then(|app| app["sessionId"].as_str().map(str::to_owned))
        }) else {
            return Ok(());
        };
        self.send(
            "receiver-0",
            protocol::RECEIVER,
            json!({"type":"STOP","sessionId":lingering}),
        )
        .await?;
        // Bounded: a TV that keeps it gets the new cast in that app anyway.
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let message = self.receive().await?;
                if Self::app_gone(&message, &lingering) {
                    return Ok::<(), &'static str>(());
                }
            }
        })
        .await;
        Ok(())
    }
    /// A receiver status that does not list the app with this session id.
    fn app_gone(message: &protocol::Message, session: &str) -> bool {
        message.namespace == protocol::RECEIVER
            && message.payload["type"] == "RECEIVER_STATUS"
            && message.payload["status"].is_object()
            && !Self::listed(&message.payload["status"], session)
    }
    fn listed(receiver: &Value, session: &str) -> bool {
        receiver["applications"]
            .as_array()
            .is_some_and(|apps| apps.iter().any(|app| app["sessionId"] == session))
    }
    pub async fn load(&mut self, selection: &MediaSelection) -> Result<(), &'static str> {
        self.close_lingering_app().await?;
        self.send(
            "receiver-0",
            protocol::RECEIVER,
            json!({"type":"LAUNCH","appId":MEDIA_RECEIVER}),
        )
        .await?;
        loop {
            let message = self.receive().await?;
            if message.namespace != protocol::RECEIVER {
                continue;
            }
            if message.payload["type"] == "LAUNCH_ERROR" {
                return Err("cast-receiver-launch-refused");
            }
            if let Some(apps) = message.payload["status"]["applications"].as_array() {
                if let Some(app) = apps.iter().find(|app| app["appId"] == MEDIA_RECEIVER) {
                    self.destination = app["transportId"].as_str().map(str::to_owned);
                    self.receiver_session = app["sessionId"].as_str().map(str::to_owned);
                    break;
                }
            }
        }
        let destination = self
            .destination
            .clone()
            .ok_or("cast-transport-id-missing")?;
        self.send(
            &destination,
            protocol::CONNECTION,
            json!({"type":"CONNECT"}),
        )
        .await?;
        self.owned_url = Some(selection.url.clone());
        self.send(&destination,protocol::MEDIA,json!({"type":"LOAD","autoplay":true,"media":{"contentId":selection.url,"contentType":selection.content_type,"streamType":"LIVE","metadata":{"metadataType":0,"title":selection.name}}})).await?;
        self.idle_reason = None;
        loop {
            match self.next_state().await? {
                ReceiverState::Playing(_) => return Ok(()),
                // The receiver reports an empty or idle status right after LOAD,
                // before its player starts (Google TV, October 19, 2026). A
                // refused stream arrives as LOAD_FAILED or idle with a reason;
                // the start deadline bounds the wait otherwise.
                ReceiverState::Ended if self.idle_reason.is_some() => {
                    return Err("cast-load-failed")
                }
                _ => {}
            }
        }
    }
    async fn next_state(&mut self) -> Result<ReceiverState, &'static str> {
        loop {
            let message = self.receive().await?;
            if self.closes_our_app(&message) {
                self.mark_app_closed();
                return Ok(ReceiverState::Ended);
            }
            if message.namespace != protocol::MEDIA
                || self.destination.as_deref() != Some(message.source.as_str())
            {
                continue;
            }
            if matches!(
                message.payload["type"].as_str(),
                Some("LOAD_FAILED" | "LOAD_CANCELLED" | "INVALID_REQUEST")
            ) {
                return Err("cast-media-refused");
            }
            if let Some(statuses) = message.payload["status"].as_array() {
                if statuses.is_empty() {
                    self.foreign_media = false;
                    return Ok(ReceiverState::Ended);
                }
                for status in statuses {
                    let id = status["mediaSessionId"]
                        .as_i64()
                        .ok_or("cast-media-session-missing")?;
                    if let Some(owned) = self.media_session {
                        if owned != id {
                            continue;
                        }
                    } else {
                        if status["media"]["contentId"].as_str() != self.owned_url.as_deref() {
                            continue;
                        }
                        self.media_session = Some(id);
                    }
                    self.foreign_media = false;
                    self.media_time = status["currentTime"].as_f64();
                    if status["playerState"] == "IDLE" {
                        self.idle_reason = status["idleReason"].as_str().map(str::to_owned);
                    }
                    return match status["playerState"].as_str() {
                        Some("PLAYING") => Ok(ReceiverState::Playing(id.to_string())),
                        Some("PAUSED") => Ok(ReceiverState::Paused),
                        Some("BUFFERING") => Ok(ReceiverState::Buffering),
                        Some("IDLE") => Ok(ReceiverState::Ended),
                        _ => Err("cast-state-unknown"),
                    };
                }
                self.foreign_media = true;
                return Ok(ReceiverState::Ended); // Another media session owns the receiver; never stop it.
            }
        }
    }
    /// The TV says GenX's cast app is gone: it closed GenX's connection to
    /// the app, or its receiver status no longer lists the app GenX launched.
    fn closes_our_app(&self, message: &protocol::Message) -> bool {
        if message.namespace == protocol::CONNECTION {
            return message.payload["type"] == "CLOSE"
                && self.destination.as_deref() == Some(message.source.as_str());
        }
        self.receiver_session
            .as_deref()
            .is_some_and(|ours| Self::app_gone(message, ours))
    }
    fn mark_app_closed(&mut self) {
        self.app_closed = true;
        self.receiver_session = None;
        self.media_session = None;
        self.owned_url = None;
        self.foreign_media = false;
    }
    /// Whether the TV shows this cast, when it says: false while it is on
    /// another input or in standby.
    pub fn on_screen(&self) -> Option<bool> {
        self.on_screen
    }
    /// One status check: first the TV itself (is GenX's app still running, is
    /// the TV on screen), then GenX's media in that app.
    pub async fn status(&mut self) -> Result<ReceiverState, &'static str> {
        if self.app_closed {
            return Ok(ReceiverState::Ended);
        }
        let receiver = self.receiver_status().await?;
        if self.app_closed
            || self
                .receiver_session
                .as_deref()
                .is_some_and(|ours| !Self::listed(&receiver, ours))
        {
            // Back or Home on the TV, another app, or the TV closed the app
            // on its own: the cast ended there.
            self.mark_app_closed();
            return Ok(ReceiverState::Ended);
        }
        self.on_screen = match (
            receiver["isStandBy"].as_bool(),
            receiver["isActiveInput"].as_bool(),
        ) {
            (Some(true), _) => Some(false),
            (_, active) => active,
        };
        let destination = self.destination.clone().ok_or("cast-not-loaded")?;
        self.send(&destination, protocol::MEDIA, json!({"type":"GET_STATUS"}))
            .await?;
        let state = self.next_state().await?;
        Ok(self.check_progress(state))
    }
    /// A TV whose cast app was sent to the background can keep saying it
    /// plays while its picture stands still. Once the media time has moved,
    /// a time that stops moving reads as buffering, and after thirty seconds
    /// as ended. A TV that reports no media time is taken at its word.
    fn check_progress(&mut self, state: ReceiverState) -> ReceiverState {
        let ReceiverState::Playing(_) = state else {
            self.frozen_checks = 0;
            self.checked_time = None;
            return state;
        };
        match (self.checked_time, self.media_time) {
            (Some(before), Some(now)) if now > before => {
                self.time_moved = true;
                self.frozen_checks = 0;
            }
            (Some(_), Some(_)) if self.time_moved => self.frozen_checks += 1,
            _ => {}
        }
        self.checked_time = self.media_time;
        if self.frozen_checks >= FROZEN_ENDED {
            ReceiverState::Ended
        } else if self.frozen_checks >= FROZEN_BUFFERING {
            ReceiverState::Buffering
        } else {
            state
        }
    }
    /// Stops GenX's media (three seconds at most), then closes the cast app
    /// GenX launched even when the media did not answer: an app stuck in the
    /// background would otherwise take the next cast out of sight. Never
    /// closes the app while another sender's media plays in it. Confirmed
    /// when the media stopped or the TV confirms the app closed.
    pub async fn stop(&mut self) -> Result<bool, &'static str> {
        let stopped = matches!(
            tokio::time::timeout(Duration::from_secs(3), self.stop_media()).await,
            Ok(Ok(true))
        );
        let closed = !self.foreign_media && self.close_app().await;
        Ok(stopped || closed)
    }
    async fn stop_media(&mut self) -> Result<bool, &'static str> {
        if self.app_closed {
            return Ok(true);
        }
        if self.media_session.is_none() {
            if self.owned_url.is_none() {
                return Ok(true);
            }
            // An ambiguous LOAD may have reached the receiver. Resolve ownership before STOP.
            if matches!(self.status().await?, ReceiverState::Ended) {
                return Ok(true);
            }
        }
        if matches!(self.status().await?, ReceiverState::Ended) {
            return Ok(true);
        }
        let destination = self.destination.clone().ok_or("cast-not-loaded")?;
        let id = self.media_session.ok_or("cast-unconfirmed-media")?;
        self.send(
            &destination,
            protocol::MEDIA,
            json!({"type":"STOP","mediaSessionId":id}),
        )
        .await?;
        // The receiver may first report the playback it is still ending; wait
        // for idle (stop() bounds the wait: three seconds).
        while !matches!(self.next_state().await?, ReceiverState::Ended) {}
        self.media_session = None;
        self.owned_url = None;
        Ok(true)
    }
    /// Close the cast app this session launched, so the TV leaves its cast
    /// screen (its Back button cannot). Names only our own receiver session:
    /// the TV ignores it when another sender's app has replaced ours.
    /// Returns whether the TV confirmed it closed (one and a half seconds at
    /// most); the TV's own receiver answers even when the app is stuck.
    async fn close_app(&mut self) -> bool {
        let Some(session) = self.receiver_session.take() else {
            return self.app_closed;
        };
        if self
            .send(
                "receiver-0",
                protocol::RECEIVER,
                json!({"type":"STOP","sessionId":session}),
            )
            .await
            .is_err()
        {
            return false;
        }
        let closed = tokio::time::timeout(Duration::from_millis(1500), async {
            loop {
                let message = self.receive().await?;
                if Self::app_gone(&message, &session) {
                    return Ok::<(), &'static str>(());
                }
            }
        })
        .await;
        self.app_closed = matches!(closed, Ok(Ok(())));
        self.app_closed
    }
}

#[cfg(test)]
#[path = "chromecast_tests.rs"]
mod receiver_tests;
