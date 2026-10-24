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

//! Tests of the Paid TV playback proxy.

use super::*;

/// Tests that read the one start-timing record take turns.
#[cfg(test)]
pub(super) static TIMING_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
mod start_timing_tests {
    use super::*;
    #[test]
    fn each_session_times_its_first_live_request_only() {
        let _turn = TIMING_TESTS.blocking_lock();
        assert!(open_start_timing(41, 1000.0));
        time_start(Some(41), |t| t.upstream_headers_ms = Some(1200.0));
        // A reconnect of the same session neither reopens nor overwrites it.
        assert!(!open_start_timing(41, 5000.0));
        time_start(None, |t| t.upstream_headers_ms = Some(9999.0));
        time_start(Some(41), |t| {
            t.hops.push(HopTiming {
                dns_ms: 12.0,
                connect_ms: Some(80.0),
                server_wait_ms: 400.0,
                https: false,
                status: 302,
            })
        });
        let timing = start_timing().unwrap();
        assert_eq!(timing.hops.len(), 1);
        assert_eq!(
            (timing.request_ms, timing.upstream_headers_ms),
            (1000.0, Some(1200.0))
        );
        // The next channel's session starts a new record.
        assert!(open_start_timing(42, 7000.0));
        // A late update from the previous session leaves the new record alone.
        time_start(Some(41), |t| t.fresh_runs = 7);
        let next = start_timing().unwrap();
        assert_eq!(next.fresh_runs, 0);
        assert_eq!(
            (next.generation, next.request_ms, next.upstream_headers_ms),
            (42, 7000.0, None)
        );
        assert!(next.hops.is_empty());
        let json = serde_json::to_value(timing).unwrap();
        assert!(json.get("playerFirstByteMs").is_some() && json.get("busyRetries").is_some());
        assert_eq!(json["hops"][0]["serverWaitMs"], 400.0);
        assert_eq!(json["hops"][0]["connectMs"], 80.0);
    }
}

/// A controlled fixture provider on loopback: a portal that redirects twice,
/// then a stream server sending MPEG-TS (owner request, October 22, 2026:
/// provider asked at session start; a stream server that does not answer).
#[cfg(test)]
mod start_path_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Provider {
        portal: u16,
        portal_requests: Arc<AtomicUsize>,
        stream_requests: Arc<AtomicUsize>,
    }
    async fn read_head(socket: &mut TcpStream) -> String {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") && head.len() < 8192 {
            match socket.read(&mut byte).await {
                Ok(1) => head.push(byte[0]),
                _ => break,
            }
        }
        String::from_utf8_lossy(&head).into_owned()
    }
    /// `silent_first`: how many stream-server requests get no answer at all.
    async fn provider(silent_first: usize) -> Provider {
        let portal = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let portal_port = portal.local_addr().unwrap().port();
        let stream_port = stream.local_addr().unwrap().port();
        FIXTURE_PORTS
            .lock()
            .unwrap()
            .extend([portal_port, stream_port]);
        let portal_requests = Arc::new(AtomicUsize::new(0));
        let stream_requests = Arc::new(AtomicUsize::new(0));
        let counted = portal_requests.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = portal.accept().await {
                let counted = counted.clone();
                tokio::spawn(async move {
                    let head = read_head(&mut socket).await;
                    // Two redirects, like the measured provider.
                    let location = if head.starts_with("GET /live/") {
                        counted.fetch_add(1, Ordering::SeqCst);
                        format!("http://127.0.0.1:{portal_port}/balance/1.ts")
                    } else {
                        format!("http://127.0.0.1:{stream_port}/stream/1.ts")
                    };
                    let reply = format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
        let counted = stream_requests.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = stream.accept().await {
                let order = counted.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let _ = read_head(&mut socket).await;
                    if order < silent_first {
                        // Accepts, never answers.
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        return;
                    }
                    let mut body = Vec::new();
                    for _ in 0..12 {
                        let mut packet = [0xffu8; 188];
                        packet[0] = 0x47;
                        body.extend_from_slice(&packet);
                    }
                    let head =
                        "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nConnection: close\r\n\r\n";
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                });
            }
        });
        Provider {
            portal: portal_port,
            portal_requests,
            stream_requests,
        }
    }
    async fn relay(provider: &Provider, generation: u64) -> AccountPlaybackProxy {
        let origin = format!("http://127.0.0.1:{}", provider.portal);
        AccountPlaybackProxy::start(
            Zeroizing::new(format!("{origin}/live/u/p/1.ts")),
            origin,
            generation,
            Arc::new(|| Box::pin(async { Ok(()) })),
            false,
            None,
            None,
        )
        .await
        .unwrap()
    }
    /// The player's request; returns the status line and body length.
    async fn play(media_url: &str) -> (String, usize) {
        let url = Url::parse(media_url).unwrap();
        let host = format!("{}:{}", url.host_str().unwrap(), url.port().unwrap());
        let mut socket = TcpStream::connect(&host).await.unwrap();
        let request = format!(
            "GET {} HTTP/1.1\r\nHost: {host}\r\nOrigin: http://tauri.localhost\r\n\r\n",
            url.path()
        );
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut reply = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(10), socket.read_to_end(&mut reply)).await;
        let text = String::from_utf8_lossy(&reply).into_owned();
        let status = text.lines().next().unwrap_or("").to_owned();
        (status, reply.len())
    }

    #[tokio::test]
    async fn a_live_session_asks_the_provider_before_the_player_does() {
        let _turn = TIMING_TESTS.lock().await;
        let provider = provider(0).await;
        let mut proxy = relay(&provider, 9001).await;
        // The provider is asked while the player is still being prepared.
        let asked = Instant::now();
        while provider.stream_requests.load(Ordering::SeqCst) == 0
            && asked.elapsed() < Duration::from_secs(5)
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(provider.portal_requests.load(Ordering::SeqCst), 1);
        assert_eq!(provider.stream_requests.load(Ordering::SeqCst), 1);
        let (status, bytes) = play(proxy.media_url()).await;
        assert!(status.starts_with("HTTP/1.1 200"), "{status}");
        assert!(bytes > 12 * 188, "the stream reached the player");
        // The player took that answer: still one request through the chain.
        assert_eq!(provider.portal_requests.load(Ordering::SeqCst), 1);
        assert_eq!(provider.stream_requests.load(Ordering::SeqCst), 1);
        let timing = start_timing().unwrap();
        assert_eq!(timing.generation, 9001);
        assert!(timing.preopened);
        assert!(timing.player_request_ms.unwrap() >= timing.upstream_headers_ms.unwrap());
        assert_eq!(timing.hops.len(), 3);
        assert_eq!(timing.fresh_runs, 0);
        proxy.stop().await.unwrap();
    }

    #[tokio::test]
    async fn a_stream_server_that_does_not_answer_is_left_after_two_seconds() {
        let _turn = TIMING_TESTS.lock().await;
        let provider = provider(1).await;
        let started = Instant::now();
        let mut proxy = relay(&provider, 9002).await;
        let (status, _) = play(proxy.media_url()).await;
        let took = started.elapsed();
        assert!(status.starts_with("HTTP/1.1 200"), "{status}");
        // One fresh run of the chain found a server that answers.
        assert_eq!(provider.portal_requests.load(Ordering::SeqCst), 2);
        assert_eq!(provider.stream_requests.load(Ordering::SeqCst), 2);
        assert!(
            took >= STREAM_SERVER_ANSWER && took < Duration::from_secs(4),
            "{took:?}"
        );
        let timing = start_timing().unwrap();
        assert_eq!((timing.generation, timing.fresh_runs), (9002, 1));
        assert_eq!(timing.hops.iter().filter(|h| h.status == 0).count(), 1);
        proxy.stop().await.unwrap();
    }

    #[tokio::test]
    async fn a_second_silent_stream_server_fails_the_start_as_a_timeout() {
        let _turn = TIMING_TESTS.lock().await;
        let provider = provider(2).await;
        let mut proxy = relay(&provider, 9003).await;
        let (status, _) = play(proxy.media_url()).await;
        assert!(status.starts_with("HTTP/1.1 502"), "{status}");
        assert_eq!(provider.portal_requests.load(Ordering::SeqCst), 2);
        proxy.stop().await.unwrap();
    }

    #[tokio::test]
    async fn a_stopped_session_abandons_the_providers_answer() {
        let _turn = TIMING_TESTS.lock().await;
        let provider = provider(1).await;
        let mut proxy = relay(&provider, 9004).await;
        // Stopping while the opening request waits on a silent server joins it.
        tokio::time::sleep(Duration::from_millis(300)).await;
        tokio::time::timeout(Duration::from_secs(2), proxy.stop())
            .await
            .expect("stop does not wait for the provider")
            .unwrap();
    }
}

#[cfg(test)]
mod manifest_tests {
    use super::*;
    fn state() -> State {
        State {
            resources: HashMap::new(),
            groups: HashMap::new(),
            root: String::new(),
            capability: "c".repeat(64),
            local_origin: "http://127.0.0.1:9".into(),
            authorized_origin: "http://tv.fixture.example".into(),
            media_origins: Vec::new(),
            started: Instant::now(),
            renewed: Instant::now(),
            generation: 1,
            authority: Arc::new(|| Box::pin(async { Ok(()) })),
            authorities: Vec::new(),
            busy: None,
            on_media: None,
            verified: None,
            vod: false,
            vod_kind: None,
            preopen: None,
        }
    }
    #[test]
    fn unknown_tags_and_attributes_are_left_out_not_fatal() {
        // A typical Xtream-style live playlist: an old #EXT-X-ALLOW-CACHE tag,
        // PROGRAM-ID on the variant and an unlisted codec label.
        let master = "#EXTM3U
#EXT-X-ALLOW-CACHE:YES
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2000000,CODECS=\"mp4a.40.2,avc1.64001f,xyz9\",RESOLUTION=1280x720
http://tv.fixture.example/live/u/p/1.m3u8
";
        let mut s = state();
        let base = Url::parse("http://tv.fixture.example/live/u/p/1.m3u8").unwrap();
        let out = s.rewrite(master, &base).unwrap();
        assert!(!out.contains("ALLOW-CACHE"));
        assert!(!out.contains("PROGRAM-ID"));
        assert!(out.contains("BANDWIDTH=2000000"));
        assert!(out.contains("RESOLUTION=1280x720"));
        assert!(
            !out.contains("tv.fixture.example"),
            "every address goes through the relay"
        );
        let media = "#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-DATERANGE:ID=\"ad\",START-DATE=\"2026-10-18T00:00:00Z\"
#EXT-X-PROVIDER-OWN:URI=\"http://elsewhere.fixture.example/x\"
#EXTINF:10.0,
/hls/7.ts
";
        let out = state().rewrite(media, &base).unwrap();
        assert!(!out.contains("DATERANGE") && !out.contains("PROVIDER-OWN"));
        assert!(
            !out.contains("elsewhere"),
            "a dropped tag's address never reaches the player"
        );
        assert!(out.contains("#EXT-X-MEDIA-SEQUENCE:7") && out.contains("#EXTINF:10.0,"));
        // Segments on another public server the playlist names are admitted
        // (bounded); private addresses and downgrades never are.
        let mut s = state();
        assert!(s
            .rewrite(
                "#EXTM3U
#EXTINF:10,
http://cdn.fixture.example/7.ts
",
                &base
            )
            .is_ok());
        assert_eq!(s.media_origins, ["http://cdn.fixture.example"]);
        for refused in [
            "http://192.168.1.20/7.ts",
            "http://127.0.0.1:8080/7.ts",
            "http://u:p@cdn.fixture.example/7.ts",
        ] {
            let mut s = state();
            assert!(
                s.rewrite(
                    &format!(
                        "#EXTM3U
#EXTINF:10,
{refused}
"
                    ),
                    &base
                )
                .is_err(),
                "{refused}"
            );
            assert!(s.media_origins.is_empty());
        }
        let mut https = state();
        https.authorized_origin = "https://tv.fixture.example".into();
        let secure = Url::parse("https://tv.fixture.example/live/u/p/1.m3u8").unwrap();
        assert!(https
            .rewrite(
                "#EXTM3U
#EXTINF:10,
http://cdn.fixture.example/7.ts
",
                &secure
            )
            .is_err());
        // At most eight servers per session.
        let mut s = state();
        let many: String = (0..9)
            .map(|i| {
                format!(
                    "#EXTINF:10,
http://cdn{i}.fixture.example/7.ts
"
                )
            })
            .collect();
        assert!(s
            .rewrite(
                &format!(
                    "#EXTM3U
{many}"
                ),
                &base
            )
            .is_err());
        assert!(s.media_origins.is_empty());
    }
}

#[cfg(test)]
mod authority_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
    fn state(calls: Arc<AtomicUsize>, revoked: Arc<AtomicBool>) -> Arc<Mutex<State>> {
        Arc::new(Mutex::new(State {
            resources: HashMap::new(),
            groups: HashMap::new(),
            root: String::new(),
            capability: "c".repeat(64),
            local_origin: "http://127.0.0.1:9".into(),
            authorized_origin: "http://tv.fixture.example".into(),
            media_origins: Vec::new(),
            started: Instant::now(),
            renewed: Instant::now(),
            generation: 1,
            authority: Arc::new(move || {
                calls.fetch_add(1, SeqCst);
                let revoked = revoked.load(SeqCst);
                Box::pin(async move {
                    if revoked {
                        Err("revoked".to_string())
                    } else {
                        Ok(())
                    }
                })
            }),
            authorities: Vec::new(),
            busy: None,
            on_media: None,
            verified: None,
            vod: false,
            vod_kind: None,
            preopen: None,
        }))
    }
    #[tokio::test(start_paused = true)]
    async fn the_account_is_rechecked_every_two_seconds_not_every_chunk() {
        let calls = Arc::new(AtomicUsize::new(0));
        let revoked = Arc::new(AtomicBool::new(false));
        let state = state(calls.clone(), revoked.clone());
        // A live stream asks before every read and every 64 KB written.
        for _ in 0..100 {
            authority(&state).await.unwrap();
        }
        assert_eq!(
            calls.load(SeqCst),
            1,
            "one database check, not one per chunk"
        );
        tokio::time::advance(Duration::from_millis(2_100)).await;
        authority(&state).await.unwrap();
        assert_eq!(calls.load(SeqCst), 2);
        // Removing or editing the account still stops playback at the next check.
        revoked.store(true, SeqCst);
        tokio::time::advance(Duration::from_millis(2_100)).await;
        assert!(authority(&state).await.is_err());
    }
}

#[cfg(test)]
mod redirect_tests {
    use super::*;
    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }
    #[test]
    fn provider_redirects_may_change_server_but_never_downgrade() {
        // HTTPS account: another public HTTPS server is followed, plain HTTP is not.
        let https = "https://tv.fixture.example";
        assert!(redirect_target(&url("https://lb1.fixture.example:8443/live/1.ts"), https).is_ok());
        assert!(redirect_target(&url("http://lb1.fixture.example/live/1.ts"), https).is_err());
        // HTTP account (explicit grant): its load balancers may use HTTP or HTTPS.
        let http = "http://tv.fixture.example:8080";
        assert!(redirect_target(&url("http://lb2.fixture.example:8080/live/1.ts"), http).is_ok());
        assert!(redirect_target(&url("https://lb2.fixture.example/live/1.ts"), http).is_ok());
        // Never a private or loopback address, never embedded user info.
        assert!(redirect_target(&url("http://192.168.1.10/live/1.ts"), http).is_err());
        assert!(redirect_target(&url("http://127.0.0.1:8080/live/1.ts"), http).is_err());
        assert!(redirect_target(&url("http://user:pw@lb3.fixture.example/x.ts"), http).is_err());
        assert!(redirect_target(&url("ftp://lb3.fixture.example/x.ts"), http).is_err());
    }
}

#[cfg(test)]
mod sniff_tests {
    #[test]
    fn video_is_recognized_by_its_bytes_not_its_label() {
        assert_eq!(
            super::sniff_video(&[0x1a, 0x45, 0xdf, 0xa3, 0, 0]),
            Some("video/x-matroska")
        );
        assert_eq!(super::sniff_video(b"\0\0\0\x20ftypisom"), Some("video/mp4"));
        let mut ts = vec![0u8; 400];
        ts[0] = 0x47;
        ts[188] = 0x47;
        ts[376] = 0x47;
        assert_eq!(super::sniff_video(&ts), Some("video/mp2t"));
        assert_eq!(super::sniff_video(b"<html>Access denied</html>"), None);
        assert_eq!(super::sniff_video(b"{\"error\":1}"), None);
    }
}

#[cfg(test)]
mod busy_tests {
    use super::{busy_delay, LIVE_BUSY_WINDOW};
    use std::time::Duration;

    #[test]
    fn a_live_start_waits_out_a_busy_provider_within_its_window() {
        let mut remaining = LIVE_BUSY_WINDOW;
        let mut attempt = 0;
        let mut waited = Duration::ZERO;
        while let Some(delay) = busy_delay(attempt, true, remaining) {
            assert!(delay <= Duration::from_secs(3), "backoff is capped");
            waited += delay;
            remaining = remaining.saturating_sub(delay);
            attempt += 1;
        }
        // Covers the >15 s the trial provider kept a closed stream busy,
        // and never exceeds the window.
        assert!(waited >= Duration::from_secs(20), "{waited:?}");
        assert!(waited < LIVE_BUSY_WINDOW);
    }
    #[test]
    fn other_requests_keep_three_short_retries() {
        let delays: Vec<_> = (0..5)
            .map(|attempt| busy_delay(attempt, false, Duration::from_secs(20)))
            .collect();
        assert_eq!(
            delays,
            vec![
                Some(Duration::from_millis(1500)),
                Some(Duration::from_millis(2500)),
                Some(Duration::from_millis(3500)),
                None,
                None
            ]
        );
    }
    #[test]
    fn a_nearly_spent_window_gives_up_instead_of_overrunning() {
        assert_eq!(busy_delay(4, true, Duration::from_millis(3500)), None);
        assert_eq!(busy_delay(0, true, Duration::from_millis(2000)), None);
    }
}
