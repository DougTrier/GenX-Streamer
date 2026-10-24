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

//! Several TVs at once, each its own channel, and TVs that end the cast on
//! their side (owner requirements, October 24, 2026). The TVs are loopback
//! DLNA renderers answering real SOAP over HTTP.

use super::*;
use std::sync::atomic::AtomicUsize;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[test]
fn receiver_fetch_needs_a_grant_on_the_actual_response() {
    use reqwest::header::HeaderValue;
    assert!(grants_receiver(Some(&HeaderValue::from_static("*"))));
    assert!(grants_receiver(Some(&HeaderValue::from_static(
        "https://www.gstatic.com"
    ))));
    assert!(!grants_receiver(None));
    assert!(!grants_receiver(Some(&HeaderValue::from_static(
        "https://example.com"
    ))));
}

#[tokio::test]
async fn plain_http_and_invalid_streams_always_relay() {
    assert!(!receiver_can_fetch("http://example.invalid/live.m3u8").await);
    assert!(!receiver_can_fetch("not a url").await);
    assert!(!receiver_can_fetch("https://user:pass@example.invalid/live.m3u8").await);
}

const SERVICE: &str = "urn:schemas-upnp-org:service:AVTransport:1";

#[derive(Clone, Copy, PartialEq)]
enum Tv {
    Playing,
    /// Back or Home on the TV's remote: its transport stopped.
    BackedOut,
    /// Another phone cast something else to it.
    TakenOver,
    /// Off or gone from the network: connections open, nothing answers.
    Silent,
    /// Its control connection closes at once.
    HungUp,
}
struct FixtureTv {
    control: reqwest::Url,
    uri: String,
    mode: Arc<std::sync::Mutex<Tv>>,
    stops: Arc<AtomicUsize>,
}
impl FixtureTv {
    fn set(&self, mode: Tv) {
        *self.mode.lock().unwrap() = mode;
    }
    fn stops(&self) -> usize {
        self.stops.load(Ordering::SeqCst)
    }
}
async fn soap_action(socket: &mut tokio::net::TcpStream) -> Option<String> {
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        socket.read_exact(&mut byte).await.ok()?;
        header.push(byte[0]);
    }
    let header = String::from_utf8_lossy(&header).into_owned();
    let field = |wanted: &str| {
        header.lines().find_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.eq_ignore_ascii_case(wanted))
                .map(|(_, value)| value.trim().to_owned())
        })
    };
    let mut body = vec![0; field("content-length")?.parse().ok()?];
    socket.read_exact(&mut body).await.ok()?;
    field("soapaction")
}
async fn fixture_tv(channel: &str) -> FixtureTv {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let tv = FixtureTv {
        control: reqwest::Url::parse(&format!("http://{address}/control")).unwrap(),
        uri: format!("https://example.org/{channel}.m3u8"),
        mode: Arc::new(std::sync::Mutex::new(Tv::Playing)),
        stops: Arc::new(AtomicUsize::new(0)),
    };
    let (mode, stops, uri) = (tv.mode.clone(), tv.stops.clone(), tv.uri.clone());
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((mut socket, _)) = listener.accept().await {
            let current = *mode.lock().unwrap();
            match current {
                Tv::Silent => {
                    held.push(socket);
                    continue;
                }
                Tv::HungUp => continue,
                _ => {}
            }
            let Some(action) = soap_action(&mut socket).await else {
                continue;
            };
            let reply = if action.contains("#GetMediaInfo") {
                let playing = if current == Tv::TakenOver {
                    "https://other.example/live.m3u8"
                } else {
                    &uri
                };
                format!("<CurrentURI>{playing}</CurrentURI>")
            } else if action.contains("#GetTransportInfo") {
                let state = if current == Tv::BackedOut {
                    "STOPPED"
                } else {
                    "PLAYING"
                };
                format!("<CurrentTransportState>{state}</CurrentTransportState>")
            } else {
                if action.contains("#Stop") {
                    stops.fetch_add(1, Ordering::SeqCst);
                    *mode.lock().unwrap() = Tv::BackedOut;
                }
                "<ok/>".into()
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: text/xml\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    tv
}
/// Casts `channel` to the fixture TV through the real DLNA engine.
async fn cast(manager: &CastingManager, tv: &FixtureTv, session: &str, channel: &str) {
    let network = manager.observe_network().await.unwrap();
    let owned = Arc::new(OwnedSession::new(
        session,
        format!("dlna:{}", tv.control),
        channel,
        network,
    ));
    assert!(manager.admit(&owned).await.unwrap().is_none());
    let mut engine = dlna::Session::new(tv.control.clone(), SERVICE.into()).unwrap();
    engine
        .load(&MediaSelection {
            id: channel.into(),
            name: channel.into(),
            url: tv.uri.clone(),
            content_type: "application/x-mpegURL".into(),
        })
        .await
        .unwrap();
    *owned.engine.lock().await = Some(Engine::Dlna(engine));
}
async fn state(manager: &CastingManager, session: &str) -> Result<(String, String), &'static str> {
    manager
        .status(session)
        .await
        .map(|status| (status.state, status.selection_id))
}
fn playing(channel: &str) -> Result<(String, String), &'static str> {
    Ok(("playing".into(), channel.into()))
}

#[tokio::test]
async fn several_tvs_play_their_own_channels_and_stopping_one_leaves_the_others() {
    let manager = CastingManager::default();
    let channels = ["news", "sports", "movies"];
    let mut tvs = Vec::new();
    for (index, channel) in channels.iter().enumerate() {
        tvs.push(fixture_tv(channel).await);
        cast(&manager, &tvs[index], &format!("tv-{index}"), channel).await;
    }
    for (index, channel) in channels.iter().enumerate() {
        assert_eq!(
            state(&manager, &format!("tv-{index}")).await,
            playing(channel)
        );
    }
    assert!(manager.stop("tv-1").await.unwrap());
    assert_eq!(tvs[1].stops(), 1);
    assert_eq!(state(&manager, "tv-1").await, Err("cast-session-not-owned"));
    for index in [0, 2] {
        assert_eq!(
            state(&manager, &format!("tv-{index}")).await,
            playing(channels[index])
        );
        assert_eq!(tvs[index].stops(), 0);
    }
    manager.shutdown().await.unwrap();
    assert!(manager.active.lock().await.is_empty());
    assert!(tvs.iter().all(|tv| tv.stops() == 1));
}

#[tokio::test]
async fn a_tv_that_ends_the_cast_on_its_side_reports_ended_while_the_others_play() {
    let manager = CastingManager::default();
    let backed_out = fixture_tv("news").await;
    let taken_over = fixture_tv("sports").await;
    let watching = fixture_tv("movies").await;
    cast(&manager, &backed_out, "backed-out", "news").await;
    cast(&manager, &taken_over, "taken-over", "sports").await;
    cast(&manager, &watching, "watching", "movies").await;
    backed_out.set(Tv::BackedOut);
    taken_over.set(Tv::TakenOver);
    assert_eq!(
        state(&manager, "backed-out").await,
        Ok(("ended".into(), "news".into()))
    );
    assert_eq!(
        state(&manager, "taken-over").await,
        Ok(("ended".into(), "sports".into()))
    );
    assert_eq!(state(&manager, "watching").await, playing("movies"));
    // Releasing them confirms at once and never stops another phone's media.
    assert!(manager.stop("backed-out").await.unwrap());
    assert!(manager.stop("taken-over").await.unwrap());
    assert_eq!(taken_over.stops(), 0);
    assert_eq!(manager.active.lock().await.len(), 1);
    assert_eq!(state(&manager, "watching").await, playing("movies"));
    assert!(manager.stop("watching").await.unwrap());
}

#[tokio::test]
async fn a_tv_that_is_off_or_gone_fails_its_check_and_is_released_without_blocking() {
    let manager = CastingManager::default();
    let silent = fixture_tv("news").await;
    let hung_up = fixture_tv("sports").await;
    let watching = fixture_tv("movies").await;
    cast(&manager, &silent, "silent", "news").await;
    cast(&manager, &hung_up, "hung-up", "sports").await;
    cast(&manager, &watching, "watching", "movies").await;
    silent.set(Tv::Silent);
    hung_up.set(Tv::HungUp);
    let checked = Instant::now();
    assert!(state(&manager, "silent").await.is_err());
    assert!(checked.elapsed() <= Duration::from_secs(6));
    assert!(state(&manager, "hung-up").await.is_err());
    assert_eq!(state(&manager, "watching").await, playing("movies"));
    let released = Instant::now();
    assert!(!manager.stop("silent").await.unwrap());
    assert!(!manager.stop("hung-up").await.unwrap());
    assert!(released.elapsed() <= Duration::from_secs(11));
    for gone in ["silent", "hung-up"] {
        assert_eq!(state(&manager, gone).await, Err("cast-session-not-owned"));
    }
    assert_eq!(state(&manager, "watching").await, playing("movies"));
    manager.shutdown().await.unwrap();
    assert_eq!(watching.stops(), 1);
}

#[tokio::test]
async fn admission_replaces_only_the_same_tv_and_bounds_how_many() {
    let manager = CastingManager::default();
    let network = ReceiverNetworkScope {
        generation: 1,
        scope_id: "fixture".into(),
        observation: "interfaces-only".into(),
    };
    let session =
        |id: &str, tv: &str| Arc::new(OwnedSession::new(id, tv.into(), "channel", network.clone()));
    for index in 0..MAX_SESSIONS {
        let tv = format!("cast:192.168.1.{index}:8009");
        assert!(manager
            .admit(&session(&format!("s{index}"), &tv))
            .await
            .unwrap()
            .is_none());
    }
    assert!(matches!(
        manager
            .admit(&session("extra", "cast:192.168.1.99:8009"))
            .await,
        Err("cast-session-limit")
    ));
    assert!(matches!(
        manager
            .admit(&session("s0", "cast:192.168.1.98:8009"))
            .await,
        Err("cast-session-duplicate")
    ));
    let replaced = manager
        .admit(&session("again", "cast:192.168.1.2:8009"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replaced.id, "s2");
    let mut ids: Vec<_> = manager.active.lock().await.keys().cloned().collect();
    ids.sort();
    assert_eq!(ids, ["again", "s0", "s1", "s3"]);
}

#[tokio::test]
async fn closing_asks_every_tv_together_and_refuses_new_casts() {
    let manager = CastingManager::default();
    let mut tvs = Vec::new();
    for index in 0..MAX_SESSIONS {
        tvs.push(fixture_tv(&format!("channel-{index}")).await);
        cast(&manager, &tvs[index], &format!("tv-{index}"), "channel").await;
    }
    for tv in &tvs {
        tv.set(Tv::Silent);
    }
    let closing = Instant::now();
    manager.shutdown().await.unwrap();
    // Asked one after another, four silent TVs would take about 16 seconds.
    assert!(closing.elapsed() <= Duration::from_secs(9));
    assert!(manager.active.lock().await.is_empty());
    let late = Arc::new(OwnedSession::new(
        "late",
        "cast:192.168.1.5:8009".into(),
        "channel",
        manager.observe_network().await.unwrap(),
    ));
    assert!(matches!(
        manager.admit(&late).await,
        Err("cast-application-closing")
    ));
}
