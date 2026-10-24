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

//! Cast V2 sessions against a TLS receiver fixture that behaves as Google TV.

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
            PrivateKeyDer::try_from(include_bytes!("../lan/fixtures/loopback-key.der").to_vec())
                .unwrap(),
        )
        .unwrap(),
    ))
}
// A relay address as GenX would hand the TV (a reserved name, not a real host).
const URL: &str = "http://cast-relay.invalid:4000/media/abc";
fn media(state: &str, reason: Option<&str>) -> Value {
    let mut status = json!({"mediaSessionId":7,"playerState":state,"media":{"contentId":URL}});
    if let Some(reason) = reason {
        status["idleReason"] = json!(reason);
    }
    json!({"type":"MEDIA_STATUS","status":[status]})
}
fn playing_at(time: f64) -> Value {
    let mut status = media("PLAYING", None);
    status["status"][0]["currentTime"] = json!(time);
    status
}
fn app(id: &str, transport: &str) -> Value {
    json!({"appId":"CC1AD845","transportId":transport,"sessionId":id})
}
/// How the fixture TV behaves.
#[derive(Clone, Default)]
struct Tv {
    /// Media statuses right after LOAD, after the early empty one.
    after_load: Vec<Value>,
    /// Replies to GenX's media status requests, in order; the last repeats.
    /// `{"fixture": ...}` plays the TV's side: `close-app` (Back or Home),
    /// `other-app` (another phone's app), `hang-up` (off or gone), `silent`.
    status: Vec<Value>,
    /// The TV's own status once GenX's app runs, when it says more than that.
    receiver: Option<Value>,
    /// A media receiver app from an earlier cast is still running.
    lingering: bool,
    /// GenX's cast app never answers its media Stop.
    stuck: bool,
}
/// A Default Media Receiver as Google TV behaves: an empty status right after
/// LOAD, then the scripted statuses; records every message GenX sends.
async fn receiver(tv: Tv) -> (SocketAddr, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut stream = fixture_tls().accept(tcp).await.unwrap();
        let mut seen = Vec::new();
        let mut apps = if tv.lingering {
            vec![app("app-0", "web-0")]
        } else {
            Vec::new()
        };
        let mut statuses = tv.status.clone();
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
            let request = message.payload["requestId"].clone();
            seen.push(json!({"ns":message.namespace,"payload":message.payload}));
            let mut replies = Vec::new();
            let launched = apps.iter().any(|app| app["sessionId"] == "app-1");
            let receiver_status = |apps: &Vec<Value>| match &tv.receiver {
                Some(status) if launched => status.clone(),
                _ => json!({ "applications": apps }),
            };
            match (message.namespace.as_str(), kind.as_str()) {
                (protocol::RECEIVER, "GET_STATUS") => replies.push(("receiver-0", protocol::RECEIVER, json!({"type":"RECEIVER_STATUS","requestId":request,"status":receiver_status(&apps)}))),
                (protocol::RECEIVER, "LAUNCH") => {
                    apps = vec![app("app-1", "web-1")];
                    replies.push(("receiver-0", protocol::RECEIVER, json!({"type":"RECEIVER_STATUS","requestId":request,"status":{"applications":apps}})));
                }
                (protocol::RECEIVER, "STOP") => {
                    let closing = message.payload["sessionId"].clone();
                    apps.retain(|app| app["sessionId"] != closing);
                    replies.push(("receiver-0", protocol::RECEIVER, json!({"type":"RECEIVER_STATUS","requestId":request,"status":{"applications":apps}})));
                }
                (protocol::MEDIA, "LOAD") => {
                    replies.push(("web-1", protocol::MEDIA, json!({"type":"MEDIA_STATUS","status":[]})));
                    for reply in &tv.after_load {
                        replies.push(("web-1", protocol::MEDIA, reply.clone()));
                    }
                }
                (protocol::MEDIA, "GET_STATUS") => {
                    let reply = if statuses.len() > 1 {
                        statuses.remove(0)
                    } else {
                        statuses.first().cloned().unwrap_or_else(|| json!({}))
                    };
                    match reply["fixture"].as_str() {
                        Some("close-app") => {
                            replies.push(("web-1", protocol::CONNECTION, json!({"type":"CLOSE"})))
                        }
                        Some("other-app") => {
                            apps = vec![json!({"appId":"233637DE","transportId":"web-9","sessionId":"app-9"})];
                            replies.push(("receiver-0", protocol::RECEIVER, json!({"type":"RECEIVER_STATUS","requestId":0,"status":{"applications":apps}})));
                        }
                        Some("hang-up") => return seen,
                        Some("silent") => {}
                        _ => replies.push(("web-1", protocol::MEDIA, reply)),
                    }
                }
                // Google TV reports the ending playback once before going idle.
                (protocol::MEDIA, "STOP") if !tv.stuck => {
                    replies.push(("web-1", protocol::MEDIA, media("PLAYING", None)));
                    replies.push(("web-1", protocol::MEDIA, media("IDLE", Some("CANCELLED"))));
                }
                _ => {}
            }
            for (source, namespace, payload) in replies {
                let frame = protocol::encode(source, &message.source, namespace, &payload).unwrap();
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
async fn loaded(tv: Tv) -> (Session, tokio::task::JoinHandle<Vec<Value>>) {
    let tv = Tv {
        after_load: if tv.after_load.is_empty() {
            vec![media("PLAYING", None)]
        } else {
            tv.after_load
        },
        ..tv
    };
    let (address, server) = receiver(tv).await;
    let mut session = Session::connect_transport(address, "load-fixture".into())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), session.load(&selection()))
        .await
        .unwrap()
        .unwrap();
    (session, server)
}
fn status(status: Value) -> Tv {
    Tv {
        status: vec![status],
        ..Tv::default()
    }
}
fn asked(seen: &[Value], kind: &str, ns: &str) -> usize {
    seen.iter()
        .filter(|m| m["ns"] == ns && m["payload"]["type"] == kind)
        .count()
}

#[tokio::test]
async fn load_waits_past_the_early_empty_status_and_stop_closes_the_cast_app() {
    let (mut session, server) = loaded(Tv {
        after_load: vec![
            media("IDLE", None),
            media("BUFFERING", None),
            media("PLAYING", None),
        ],
        status: vec![media("PLAYING", None)],
        ..Tv::default()
    })
    .await;
    assert_eq!(session.media_session, Some(7));
    assert!(tokio::time::timeout(Duration::from_secs(5), session.stop())
        .await
        .unwrap()
        .unwrap());
    drop(session);
    let seen = server.await.unwrap();
    let last = seen.last().unwrap();
    assert_eq!(last["ns"], protocol::RECEIVER);
    assert_eq!(last["payload"]["type"], "STOP");
    assert_eq!(last["payload"]["sessionId"], "app-1");
    // Nothing was running before, so nothing was closed before LAUNCH.
    assert_eq!(asked(&seen, "STOP", protocol::RECEIVER), 1);
}

#[tokio::test]
async fn a_receiver_that_goes_idle_with_an_error_fails_the_load() {
    let (address, server) = receiver(Tv {
        after_load: vec![media("IDLE", Some("ERROR"))],
        ..Tv::default()
    })
    .await;
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
    let (mut session, server) = loaded(status(other)).await;
    // Another phone took over: GenX's media is gone, so Stop is done.
    session.media_session = None;
    assert!(tokio::time::timeout(Duration::from_secs(5), session.stop())
        .await
        .unwrap()
        .unwrap());
    drop(session);
    let seen = server.await.unwrap();
    assert_eq!(asked(&seen, "STOP", protocol::RECEIVER), 0);
    assert_eq!(asked(&seen, "STOP", protocol::MEDIA), 0);
}

// Owner requirement, October 24, 2026: someone backing out of the stream
// on the TV, or another phone taking it over, ends GenX's cast at once.
#[tokio::test]
async fn the_tv_closing_genx_app_reads_as_ended_and_stop_sends_nothing_more() {
    for case in ["close-app", "other-app"] {
        let (mut session, server) = loaded(status(json!({ "fixture": case }))).await;
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
        assert_eq!(asked(&seen, "GET_STATUS", protocol::MEDIA), 1, "{case}");
        assert_eq!(asked(&seen, "STOP", protocol::MEDIA), 0, "{case}");
        assert_eq!(asked(&seen, "STOP", protocol::RECEIVER), 0, "{case}");
    }
}

// Owner report, October 24, 2026: the Sansui dropped its cast when it
// switched input, sending nothing, and GenX still showed it casting.
#[tokio::test]
async fn an_app_the_tv_closed_quietly_reads_as_ended_from_the_tv_own_status() {
    let (mut session, server) = loaded(Tv {
        status: vec![media("PLAYING", None)],
        receiver: Some(json!({ "applications": [], "isActiveInput": true })),
        ..Tv::default()
    })
    .await;
    let state = tokio::time::timeout(Duration::from_secs(5), session.status())
        .await
        .unwrap();
    assert!(matches!(state, Ok(ReceiverState::Ended)));
    assert!(tokio::time::timeout(Duration::from_secs(5), session.stop())
        .await
        .unwrap()
        .unwrap());
    drop(session);
    let seen = server.await.unwrap();
    // Its media was never asked: the TV itself said the app was gone.
    assert_eq!(asked(&seen, "GET_STATUS", protocol::MEDIA), 0);
}

#[tokio::test]
async fn the_tv_says_whether_it_shows_the_cast() {
    for (receiver, expected) in [
        (json!({ "isActiveInput": true }), Some(true)),
        (json!({ "isActiveInput": false }), Some(false)),
        (
            json!({ "isActiveInput": true, "isStandBy": true }),
            Some(false),
        ),
        (json!({}), None),
    ] {
        let mut receiver = receiver;
        receiver["applications"] = json!([app("app-1", "web-1")]);
        let (mut session, server) = loaded(Tv {
            status: vec![media("PLAYING", None)],
            receiver: Some(receiver),
            ..Tv::default()
        })
        .await;
        let state = tokio::time::timeout(Duration::from_secs(5), session.status())
            .await
            .unwrap();
        // Out of sight is not ended: a TV on another input may keep playing.
        assert!(matches!(state, Ok(ReceiverState::Playing(_))));
        assert_eq!(session.on_screen(), expected);
        drop(session);
        server.await.unwrap();
    }
}

#[tokio::test]
async fn a_picture_that_stands_still_reads_as_buffering_then_ended() {
    let mut times: Vec<Value> = [1.0, 3.0, 5.0].into_iter().map(playing_at).collect();
    times.push(playing_at(5.0));
    let (mut session, server) = loaded(Tv {
        status: times,
        ..Tv::default()
    })
    .await;
    let mut states = Vec::new();
    for _ in 0..19 {
        states.push(
            match tokio::time::timeout(Duration::from_secs(5), session.status())
                .await
                .unwrap()
                .unwrap()
            {
                ReceiverState::Playing(_) => "playing",
                ReceiverState::Buffering => "buffering",
                ReceiverState::Ended => "ended",
                ReceiverState::Paused => "paused",
            },
        );
    }
    // Moving three times, still for two checks, buffering from the third,
    // ended at the fifteenth.
    assert_eq!(states[..5], ["playing"; 5]);
    assert_eq!(states[5..17], ["buffering"; 12]);
    assert_eq!(states[17], "ended");
    drop(session);
    server.await.unwrap();
    // A TV that never reports a media time is taken at its word.
    let (mut session, server) = loaded(status(media("PLAYING", None))).await;
    for _ in 0..18 {
        assert!(matches!(
            session.status().await,
            Ok(ReceiverState::Playing(_))
        ));
    }
    drop(session);
    server.await.unwrap();
}

#[tokio::test]
async fn stop_closes_a_stuck_cast_app_even_when_its_media_never_answers() {
    let (mut session, server) = loaded(Tv {
        status: vec![media("PLAYING", None)],
        stuck: true,
        ..Tv::default()
    })
    .await;
    let started = std::time::Instant::now();
    let stopped = tokio::time::timeout(Duration::from_secs(5), session.stop())
        .await
        .unwrap()
        .unwrap();
    assert!(stopped, "the TV confirmed GenX's app closed");
    assert!(started.elapsed() < Duration::from_millis(4600));
    drop(session);
    let seen = server.await.unwrap();
    assert_eq!(asked(&seen, "STOP", protocol::MEDIA), 1);
    let last = seen.last().unwrap();
    assert_eq!(last["payload"]["type"], "STOP");
    assert_eq!(last["payload"]["sessionId"], "app-1");
}

#[tokio::test]
async fn a_new_cast_closes_a_lingering_media_app_and_launches_fresh() {
    let (session, server) = loaded(Tv {
        lingering: true,
        status: vec![media("PLAYING", None)],
        ..Tv::default()
    })
    .await;
    assert_eq!(session.receiver_session.as_deref(), Some("app-1"));
    drop(session);
    let seen = server.await.unwrap();
    let order: Vec<_> = seen
        .iter()
        .filter(|m| m["ns"] == protocol::RECEIVER)
        .map(|m| {
            format!(
                "{} {}",
                m["payload"]["type"].as_str().unwrap(),
                m["payload"]["sessionId"].as_str().unwrap_or_default()
            )
        })
        .collect();
    assert_eq!(order, ["GET_STATUS ", "STOP app-0", "LAUNCH "]);
}

#[tokio::test]
async fn idle_empty_and_foreign_media_statuses_read_as_ended() {
    let mut foreign = media("PLAYING", None);
    foreign["status"][0]["mediaSessionId"] = json!(99);
    for reply in [
        media("IDLE", Some("CANCELLED")),
        json!({"type":"MEDIA_STATUS","status":[]}),
        foreign,
    ] {
        let (mut session, server) = loaded(status(reply)).await;
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
    let (mut session, server) = loaded(status(json!({ "fixture": "hang-up" }))).await;
    let state = tokio::time::timeout(Duration::from_secs(5), session.status())
        .await
        .unwrap();
    assert!(state.is_err());
    drop(session);
    server.await.unwrap();
    let (mut session, server) = loaded(status(json!({ "fixture": "silent" }))).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(500), session.status())
            .await
            .is_err()
    );
    drop(session);
    server.await.unwrap();
}
