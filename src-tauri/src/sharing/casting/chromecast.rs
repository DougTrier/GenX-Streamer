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
    request: u32,
}
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

    pub async fn load(&mut self, selection: &MediaSelection) -> Result<(), &'static str> {
        self.send(
            "receiver-0",
            protocol::RECEIVER,
            json!({"type":"LAUNCH","appId":"CC1AD845"}),
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
                if let Some(app) = apps.iter().find(|app| app["appId"] == "CC1AD845") {
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
                self.app_closed = true;
                self.receiver_session = None;
                self.media_session = None;
                self.owned_url = None;
                self.foreign_media = false;
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
        let Some(ours) = self.receiver_session.as_deref() else {
            return false;
        };
        let status = &message.payload["status"];
        message.namespace == protocol::RECEIVER
            && message.payload["type"] == "RECEIVER_STATUS"
            && status.is_object()
            && !status["applications"]
                .as_array()
                .is_some_and(|apps| apps.iter().any(|app| app["sessionId"] == ours))
    }
    pub async fn status(&mut self) -> Result<ReceiverState, &'static str> {
        if self.app_closed {
            return Ok(ReceiverState::Ended);
        }
        let destination = self.destination.clone().ok_or("cast-not-loaded")?;
        self.send(&destination, protocol::MEDIA, json!({"type":"GET_STATUS"}))
            .await?;
        self.next_state().await
    }
    pub async fn stop(&mut self) -> Result<bool, &'static str> {
        let stopped = self.stop_media().await?;
        // Never close the app while another sender's media plays in it.
        if stopped && !self.foreign_media {
            self.close_app().await;
        }
        Ok(stopped)
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
        // for idle (the caller bounds the wait: five seconds).
        while !matches!(self.next_state().await?, ReceiverState::Ended) {}
        self.media_session = None;
        self.owned_url = None;
        Ok(true)
    }
    /// Close the cast app this session launched, so the TV leaves its cast
    /// screen (its Back button cannot). Names only our own receiver session:
    /// the TV ignores it when another sender's app has replaced ours.
    async fn close_app(&mut self) {
        let Some(session) = self.receiver_session.take() else {
            return;
        };
        let _ = self
            .send(
                "receiver-0",
                protocol::RECEIVER,
                json!({"type":"STOP","sessionId":session}),
            )
            .await;
    }
}

#[cfg(test)]
mod receiver_tests {
    use super::*;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    use tokio::net::TcpListener;
    use tokio_rustls::TlsAcceptor;

    #[tokio::test]
    async fn known_receiver_probe_uses_real_tls_and_status_without_launch_or_load() {
        let tls = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(
                include_bytes!("../lan/fixtures/loopback-cert.der").to_vec(),
            )],
            PrivateKeyDer::try_from(include_bytes!("../lan/fixtures/loopback-key.der").to_vec())
                .unwrap(),
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut stream = TlsAcceptor::from(Arc::new(tls)).accept(tcp).await.unwrap();
            for expected in ["CONNECT", "GET_STATUS"] {
                let size = stream.read_u32().await.unwrap() as usize;
                assert!(size <= protocol::MAX_FRAME);
                let mut body = vec![0; size];
                stream.read_exact(&mut body).await.unwrap();
                let message = protocol::decode(&body).unwrap();
                assert_eq!(message.payload["type"], expected);
                if expected == "GET_STATUS" {
                    let reply = protocol::encode(
                        "receiver-0",
                        &message.source,
                        protocol::RECEIVER,
                        &json!({"type":"RECEIVER_STATUS","requestId":message.payload["requestId"],"status":{"volume":{"level":0.5}}}),
                    )
                    .unwrap();
                    stream.write_all(&reply).await.unwrap();
                }
            }
        });
        assert!(
            Session::connect(address, "refused-production-loopback".into())
                .await
                .is_err()
        );
        let mut session = Session::connect_transport(address, "probe-fixture".into())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), session.verify_receiver())
            .await
            .unwrap()
            .unwrap();
        assert!(session.media_session.is_none());
        assert!(session.owned_url.is_none());
        server.await.unwrap();
    }

    fn fixture_tls() -> TlsAcceptor {
        TlsAcceptor::from(Arc::new(
            rustls::ServerConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(
                    include_bytes!("../lan/fixtures/loopback-cert.der").to_vec(),
                )],
                PrivateKeyDer::try_from(
                    include_bytes!("../lan/fixtures/loopback-key.der").to_vec(),
                )
                .unwrap(),
            )
            .unwrap(),
        ))
    }
    const URL: &str = "http://10.0.0.2:4000/media/abc";
    fn media(state: &str, reason: Option<&str>) -> Value {
        let mut status = json!({"mediaSessionId":7,"playerState":state,"media":{"contentId":URL}});
        if let Some(reason) = reason {
            status["idleReason"] = json!(reason);
        }
        json!({"type":"MEDIA_STATUS","status":[status]})
    }
    /// A Default Media Receiver as Google TV behaves: an empty status right
    /// after LOAD, then `after_load`; records every message GenX sends.
    async fn receiver(
        after_load: Vec<Value>,
        on_status: Value,
    ) -> (SocketAddr, tokio::task::JoinHandle<Vec<Value>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut stream = fixture_tls().accept(tcp).await.unwrap();
            let mut seen = Vec::new();
            loop {
                let Ok(size) = stream.read_u32().await else {
                    return seen;
                };
                let mut body = vec![0; size as usize];
                stream.read_exact(&mut body).await.unwrap();
                let message = protocol::decode(&body).unwrap();
                let kind = message.payload["type"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                seen.push(json!({"ns":message.namespace,"payload":message.payload}));
                let mut replies = Vec::new();
                match (message.namespace.as_str(), kind.as_str()) {
                    (protocol::RECEIVER, "LAUNCH") => replies.push(("receiver-0", protocol::RECEIVER, json!({"type":"RECEIVER_STATUS","status":{"applications":[{"appId":"CC1AD845","transportId":"web-1","sessionId":"app-1"}]}}))),
                    (protocol::MEDIA, "LOAD") => {
                        replies.push(("web-1", protocol::MEDIA, json!({"type":"MEDIA_STATUS","status":[]})));
                        for reply in &after_load {
                            replies.push(("web-1", protocol::MEDIA, reply.clone()));
                        }
                    }
                    (protocol::MEDIA, "GET_STATUS") => match on_status["fixture"].as_str() {
                        // Back or Home on the TV's remote closes GenX's cast app.
                        Some("close-app") => {
                            replies.push(("web-1", protocol::CONNECTION, json!({"type":"CLOSE"})))
                        }
                        // Another phone's app replaced GenX's on the TV.
                        Some("other-app") => replies.push(("receiver-0", protocol::RECEIVER, json!({"type":"RECEIVER_STATUS","requestId":0,"status":{"applications":[{"appId":"233637DE","transportId":"web-9","sessionId":"app-9"}]}}))),
                        // The TV turned off or left the network.
                        Some("hang-up") => return seen,
                        Some("silent") => {}
                        _ => replies.push(("web-1", protocol::MEDIA, on_status.clone())),
                    },
                    // Google TV reports the ending playback once before going idle.
                    (protocol::MEDIA, "STOP") => {
                        replies.push(("web-1", protocol::MEDIA, media("PLAYING", None)));
                        replies.push(("web-1", protocol::MEDIA, media("IDLE", Some("CANCELLED"))));
                    }
                    (protocol::RECEIVER, "STOP") => return seen,
                    _ => {}
                }
                for (source, namespace, payload) in replies {
                    let frame =
                        protocol::encode(source, &message.source, namespace, &payload).unwrap();
                    stream.write_all(&frame).await.unwrap();
                }
            }
        });
        (address, server)
    }
    fn selection() -> MediaSelection {
        MediaSelection {
            id: "channel".into(),
            name: "Channel".into(),
            url: URL.into(),
            content_type: "application/x-mpegURL".into(),
        }
    }

    #[tokio::test]
    async fn load_waits_past_the_early_empty_status_and_stop_closes_the_cast_app() {
        let (address, server) = receiver(
            vec![
                media("IDLE", None),
                media("BUFFERING", None),
                media("PLAYING", None),
            ],
            media("PLAYING", None),
        )
        .await;
        let mut session = Session::connect_transport(address, "load-fixture".into())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), session.load(&selection()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(session.media_session, Some(7));
        assert!(tokio::time::timeout(Duration::from_secs(5), session.stop())
            .await
            .unwrap()
            .unwrap());
        let seen = server.await.unwrap();
        let last = seen.last().unwrap();
        assert_eq!(last["ns"], protocol::RECEIVER);
        assert_eq!(last["payload"]["type"], "STOP");
        assert_eq!(last["payload"]["sessionId"], "app-1");
    }

    #[tokio::test]
    async fn a_receiver_that_goes_idle_with_an_error_fails_the_load() {
        let (address, server) = receiver(vec![media("IDLE", Some("ERROR"))], json!({})).await;
        let mut session = Session::connect_transport(address, "load-fixture".into())
            .await
            .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), session.load(&selection()))
                .await
                .unwrap(),
            Err("cast-load-failed")
        );
        drop(session);
        server.abort();
    }

    #[tokio::test]
    async fn stop_leaves_another_senders_media_and_app_alone() {
        let mut other = media("PLAYING", None);
        other["status"][0]["mediaSessionId"] = json!(99);
        other["status"][0]["media"]["contentId"] = json!("https://other.example/live.m3u8");
        let (address, server) = receiver(vec![media("PLAYING", None)], other).await;
        let mut session = Session::connect_transport(address, "load-fixture".into())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), session.load(&selection()))
            .await
            .unwrap()
            .unwrap();
        // Another phone took over: GenX's media is gone, so Stop is done.
        session.media_session = None;
        assert!(tokio::time::timeout(Duration::from_secs(5), session.stop())
            .await
            .unwrap()
            .unwrap());
        drop(session);
        let seen = server.await.unwrap();
        assert!(seen
            .iter()
            .all(|m| !(m["ns"] == protocol::RECEIVER && m["payload"]["type"] == "STOP")));
        assert!(seen
            .iter()
            .all(|m| !(m["ns"] == protocol::MEDIA && m["payload"]["type"] == "STOP")));
    }

    async fn loaded(on_status: Value) -> (Session, tokio::task::JoinHandle<Vec<Value>>) {
        let (address, server) = receiver(vec![media("PLAYING", None)], on_status).await;
        let mut session = Session::connect_transport(address, "back-out-fixture".into())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), session.load(&selection()))
            .await
            .unwrap()
            .unwrap();
        (session, server)
    }

    // Owner requirement, October 24, 2026: someone backing out of the stream
    // on the TV, or another phone taking it over, ends GenX's cast at once.
    #[tokio::test]
    async fn the_tv_closing_genx_app_reads_as_ended_and_stop_sends_nothing_more() {
        for case in ["close-app", "other-app"] {
            let (mut session, server) = loaded(json!({ "fixture": case })).await;
            let state = tokio::time::timeout(Duration::from_secs(5), session.status())
                .await
                .unwrap();
            assert!(matches!(state, Ok(ReceiverState::Ended)), "{case}");
            assert!(matches!(session.status().await, Ok(ReceiverState::Ended)));
            assert!(tokio::time::timeout(Duration::from_secs(5), session.stop())
                .await
                .unwrap()
                .unwrap());
            drop(session);
            let seen = server.await.unwrap();
            let asked = |kind: &str, ns: &str| {
                seen.iter()
                    .filter(|m| m["ns"] == ns && m["payload"]["type"] == kind)
                    .count()
            };
            assert_eq!(asked("GET_STATUS", protocol::MEDIA), 1, "{case}");
            assert_eq!(asked("STOP", protocol::MEDIA), 0, "{case}");
            assert_eq!(asked("STOP", protocol::RECEIVER), 0, "{case}");
        }
    }

    #[tokio::test]
    async fn idle_empty_and_foreign_media_statuses_read_as_ended() {
        let mut foreign = media("PLAYING", None);
        foreign["status"][0]["mediaSessionId"] = json!(99);
        for status in [
            media("IDLE", Some("CANCELLED")),
            json!({"type":"MEDIA_STATUS","status":[]}),
            foreign,
        ] {
            let (mut session, server) = loaded(status).await;
            let state = tokio::time::timeout(Duration::from_secs(5), session.status())
                .await
                .unwrap();
            assert!(matches!(state, Ok(ReceiverState::Ended)));
            drop(session);
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn a_tv_that_hangs_up_or_stops_answering_fails_the_status_check() {
        let (mut session, server) = loaded(json!({ "fixture": "hang-up" })).await;
        let state = tokio::time::timeout(Duration::from_secs(5), session.status())
            .await
            .unwrap();
        assert!(state.is_err());
        drop(session);
        server.await.unwrap();
        let (mut session, server) = loaded(json!({ "fixture": "silent" })).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(500), session.status())
                .await
                .is_err()
        );
        drop(session);
        server.await.unwrap();
    }
}
