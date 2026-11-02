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
    #[tokio::test]
    async fn native_live_admission_excludes_vod_expired_and_stopped_proxies() {
        let shared = Arc::new(Mutex::new(state()));
        let (cancel, _) = watch::channel(false);
        let mut proxy = AccountPlaybackProxy {
            media_url: "http://127.0.0.1:9/account/c/media/r".into(),
            state: shared.clone(),
            cancel,
            task: Some(tokio::spawn(async {})),
            join_failed: false,
        };
        assert!(proxy.native_live_url().is_some());
        shared.lock().unwrap().vod = true;
        assert!(proxy.native_live_url().is_none());
        {
            let mut s = shared.lock().unwrap();
            s.vod = false;
            s.renewed = Instant::now() - LEASE - Duration::from_secs(1);
        }
        assert!(proxy.native_live_url().is_none());
        shared.lock().unwrap().renewed = Instant::now();
        proxy.stop().await.unwrap();
        assert!(proxy.native_live_url().is_none());
    }
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
    fn hold_authority(
        state: &Arc<Mutex<State>>,
        calls: Arc<AtomicUsize>,
        result: Result<(), &'static str>,
    ) -> (Arc<tokio::sync::Notify>, Arc<tokio::sync::Semaphore>) {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let callback_entered = entered.clone();
        let callback_release = release.clone();
        state.lock().unwrap().authority = Arc::new(move || {
            calls.fetch_add(1, SeqCst);
            let entered = callback_entered.clone();
            let release = callback_release.clone();
            Box::pin(async move {
                entered.notify_one();
                release.acquire().await.unwrap().forget();
                result.map_err(str::to_owned)
            })
        });
        (entered, release)
    }
    #[tokio::test(start_paused = true)]
    async fn delayed_authority_cannot_refresh_or_satisfy_the_cache_before_fresh_success() {
        let calls = Arc::new(AtomicUsize::new(0));
        let state = state(calls.clone(), Arc::new(AtomicBool::new(false)));
        authority(&state).await.unwrap();
        let original = {
            let s = state.lock().unwrap();
            (s.verified, s.renewed)
        };
        tokio::time::advance(Duration::from_millis(2100)).await;
        let (entered, release) = hold_authority(&state, calls.clone(), Ok(()));
        let first_state = state.clone();
        let first = tokio::spawn(async move { authority(&first_state).await });
        entered.notified().await;
        tokio::time::advance(Duration::from_secs(6)).await;
        assert!(
            !first.is_finished(),
            "an unconfirmed callback cannot admit traffic"
        );
        {
            let s = state.lock().unwrap();
            assert_eq!((s.verified, s.renewed), original);
        }
        // A concurrent chunk must also await real authority, not a cache entry
        // created merely by the first callback starting or waiting on storage.
        let second_state = state.clone();
        let second = tokio::spawn(async move { authority(&second_state).await });
        entered.notified().await;
        assert_eq!(calls.load(SeqCst), 3);
        assert!(!first.is_finished() && !second.is_finished());
        {
            let s = state.lock().unwrap();
            assert_eq!((s.verified, s.renewed), original);
        }
        let confirmed_at = Instant::now();
        release.add_permits(2);
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        let confirmed = {
            let s = state.lock().unwrap();
            assert!(s.verified.unwrap() >= confirmed_at && s.renewed >= confirmed_at);
            (s.verified, s.renewed)
        };
        tokio::time::advance(Duration::from_secs(1)).await;
        authority(&state).await.unwrap();
        assert_eq!(
            calls.load(SeqCst),
            3,
            "only confirmed success creates the two-second cache"
        );
        let s = state.lock().unwrap();
        assert_eq!(s.verified, confirmed.0);
        assert!(s.renewed > confirmed.1);
    }
    #[tokio::test(start_paused = true)]
    async fn delayed_changed_or_replaced_authority_still_denies_without_renewal() {
        for refusal in [
            "account-media-reference-revoked",
            "account-playback-session-replaced",
        ] {
            let calls = Arc::new(AtomicUsize::new(0));
            let state = state(calls.clone(), Arc::new(AtomicBool::new(false)));
            authority(&state).await.unwrap();
            let original = {
                let s = state.lock().unwrap();
                (s.verified, s.renewed)
            };
            tokio::time::advance(Duration::from_millis(2100)).await;
            let (entered, release) = hold_authority(&state, calls.clone(), Err(refusal));
            let checking_state = state.clone();
            let checking = tokio::spawn(async move { authority(&checking_state).await });
            entered.notified().await;
            tokio::time::advance(Duration::from_secs(6)).await;
            assert!(!checking.is_finished());
            {
                let s = state.lock().unwrap();
                assert_eq!((s.verified, s.renewed), original);
            }
            release.add_permits(1);
            assert_eq!(
                checking.await.unwrap().unwrap_err(),
                "account-proxy-revoked"
            );
            let s = state.lock().unwrap();
            assert_eq!((s.verified, s.renewed), original);
            assert_eq!(calls.load(SeqCst), 2);
        }
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
        assert_eq!(
            authority(&state).await.unwrap_err(),
            "account-proxy-revoked"
        );
    }
    #[tokio::test(start_paused = true)]
    async fn a_diagnosed_storage_refusal_still_denies_without_renewing_authority() {
        let state = state(
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicBool::new(false)),
        );
        authority(&state).await.unwrap();
        let (verified, renewed) = {
            let s = state.lock().unwrap();
            (s.verified, s.renewed)
        };
        tokio::time::advance(Duration::from_millis(2100)).await;
        state.lock().unwrap().authority =
            Arc::new(|| Box::pin(async { Err("sqlite-busy".into()) }));
        assert_eq!(
            authority(&state).await.unwrap_err(),
            "account-proxy-revoked"
        );
        let s = state.lock().unwrap();
        assert_eq!(s.verified, verified);
        assert_eq!(s.renewed, renewed);
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

#[cfg(test)]
mod bursty_live_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    async fn bursty(
        gap: Duration,
    ) -> (
        AccountPlaybackProxy,
        Arc<AtomicUsize>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        FIXTURE_PORTS.lock().unwrap().push(port);
        let requests = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![];
            let mut b = [0u8; 1];
            while !bytes.ends_with(b"\r\n\r\n") {
                if socket.read(&mut b).await.unwrap_or(0) == 0 {
                    return;
                }
                bytes.push(b[0]);
            }
            count.fetch_add(1, Ordering::SeqCst);
            let mut ts = vec![0xff; 188 * 20];
            for i in (0..ts.len()).step_by(188) {
                ts[i] = 0x47;
            }
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            socket.write_all(&ts).await.unwrap();
            tokio::time::sleep(gap).await;
            let _ = socket.write_all(&ts).await;
        });
        let origin = format!("http://127.0.0.1:{port}");
        let proxy = AccountPlaybackProxy::start(
            Zeroizing::new(format!("{origin}/live.ts")),
            origin,
            9801,
            Arc::new(|| Box::pin(async { Ok(()) })),
            false,
            None,
            None,
        )
        .await
        .unwrap();
        (proxy, requests, task)
    }
    #[tokio::test]
    async fn six_second_live_delivery_gap_does_not_close_or_reopen_the_stream() {
        let _turn = TIMING_TESTS.lock().await;
        let (mut proxy, requests, server) = bursty(Duration::from_secs(6)).await;
        let response = reqwest::Client::new()
            .get(proxy.media_url())
            .send()
            .await
            .unwrap();
        let bytes = tokio::time::timeout(Duration::from_secs(10), response.bytes())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(bytes.len(), 188 * 40);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        proxy.stop().await.unwrap();
        server.await.unwrap();
    }
    #[tokio::test]
    async fn stop_cancels_a_waiting_live_body_without_waiting_out_the_idle_budget() {
        let _turn = TIMING_TESTS.lock().await;
        let (mut proxy, _, server) = bursty(Duration::from_secs(60)).await;
        let mut response = reqwest::Client::new()
            .get(proxy.media_url())
            .send()
            .await
            .unwrap();
        assert!(!response.chunk().await.unwrap().unwrap().is_empty());
        tokio::time::timeout(Duration::from_secs(1), proxy.stop())
            .await
            .unwrap()
            .unwrap();
        server.abort();
        let _ = server.await;
    }
}

#[cfg(test)]
mod finite_vod_body_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn vod_state(calls: Arc<AtomicUsize>, revoked: Arc<AtomicBool>) -> Arc<Mutex<State>> {
        Arc::new(Mutex::new(State {
            resources: HashMap::new(),
            groups: HashMap::new(),
            root: "fixture".into(),
            capability: "fixture".into(),
            local_origin: "http://127.0.0.1:1234".into(),
            authorized_origin: "https://vod.fixture.invalid".into(),
            media_origins: Vec::new(),
            started: Instant::now(),
            renewed: Instant::now(),
            generation: 19802,
            authority: Arc::new(move || {
                let calls = calls.clone();
                let revoked = revoked.clone();
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    if revoked.load(Ordering::SeqCst) {
                        Err("account-removed".into())
                    } else {
                        Ok(())
                    }
                })
            }),
            authorities: Vec::new(),
            busy: None,
            on_media: None,
            verified: None,
            vod: true,
            vod_kind: None,
            preopen: None,
        }))
    }
    async fn join_authorities(state: &Arc<Mutex<State>>) {
        let tasks = std::mem::take(&mut state.lock().unwrap().authorities);
        for task in tasks {
            task.await.unwrap();
        }
    }
    async fn settle() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }
    struct ControlledVodBody {
        blocked: AtomicBool,
        ready: tokio::sync::Notify,
        bytes: Mutex<Vec<u8>>,
        would_block_once: AtomicBool,
        revoke_when_ready: AtomicBool,
        revoked: Arc<AtomicBool>,
    }
    impl ControlledVodBody {
        fn blocked(revoked: Arc<AtomicBool>) -> Arc<Self> {
            Arc::new(Self {
                blocked: AtomicBool::new(true),
                ready: tokio::sync::Notify::new(),
                bytes: Mutex::new(Vec::new()),
                would_block_once: AtomicBool::new(false),
                revoke_when_ready: AtomicBool::new(false),
                revoked,
            })
        }
        fn release(&self) {
            self.blocked.store(false, Ordering::SeqCst);
            self.ready.notify_waiters();
        }
    }
    impl VodBodyOutput for ControlledVodBody {
        async fn writable(&self) -> std::io::Result<()> {
            loop {
                let ready = self.ready.notified();
                if !self.blocked.load(Ordering::SeqCst) {
                    break;
                }
                ready.await;
            }
            if self.revoke_when_ready.swap(false, Ordering::SeqCst) {
                self.revoked.store(true, Ordering::SeqCst);
            }
            Ok(())
        }
        fn try_body_write(&self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.would_block_once.swap(false, Ordering::SeqCst) {
                return Err(std::io::ErrorKind::WouldBlock.into());
            }
            let count = bytes.len().min(2);
            self.bytes
                .lock()
                .unwrap()
                .extend_from_slice(&bytes[..count]);
            Ok(count)
        }
    }

    #[tokio::test(start_paused = true)]
    async fn owned_vod_backpressure_requires_fresh_success_beyond_idle_lease_and_preserves_framing()
    {
        let calls = Arc::new(AtomicUsize::new(0));
        let revoked = Arc::new(AtomicBool::new(false));
        let state = vod_state(calls.clone(), revoked.clone());
        let observed = state.clone();
        let writer = ControlledVodBody::blocked(revoked);
        writer.would_block_once.store(true, Ordering::SeqCst);
        let output = writer.clone();
        let task = tokio::spawn(async move {
            vod_chunk(output.as_ref(), &observed, b"abcdefgh").await?;
            write_vod_body(output.as_ref(), &observed, b"0\r\n\r\n").await
        });
        settle().await;
        for _ in 0..35 {
            tokio::time::advance(AUTHORITY_INTERVAL).await;
            settle().await;
        }
        assert!(!task.is_finished());
        assert!(calls.load(Ordering::SeqCst) >= 35);
        assert!(state.lock().unwrap().active());
        assert!(state.lock().unwrap().started.elapsed() > LEASE);
        assert!(writer.bytes.lock().unwrap().is_empty());
        writer.release();
        task.await.unwrap().unwrap();
        join_authorities(&state).await;
        assert_eq!(
            decode_chunked(&writer.bytes.lock().unwrap()).unwrap(),
            b"abcdefgh"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn vod_resume_rechecks_after_readiness_even_when_periodic_success_is_cached() {
        let calls = Arc::new(AtomicUsize::new(0));
        let revoked = Arc::new(AtomicBool::new(false));
        let state = vod_state(calls.clone(), revoked.clone());
        let writer = ControlledVodBody::blocked(revoked);
        let output = writer.clone();
        let observed = state.clone();
        let task = tokio::spawn(async move {
            write_vod_body(output.as_ref(), &observed, b"must-not-cross").await
        });
        settle().await;
        tokio::time::advance(AUTHORITY_INTERVAL).await;
        settle().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let renewed = state.lock().unwrap().renewed;
        assert!(state.lock().unwrap().verified.is_some());
        // Metadata changes at readiness, immediately after the last successful
        // periodic check. The still-fresh cache must not admit resumed bytes.
        writer.revoke_when_ready.store(true, Ordering::SeqCst);
        writer.release();
        assert_eq!(task.await.unwrap(), Err("account-proxy-revoked"));
        join_authorities(&state).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(writer.bytes.lock().unwrap().is_empty());
        assert_eq!(state.lock().unwrap().renewed, renewed);
    }

    #[tokio::test(start_paused = true)]
    async fn forced_vod_check_never_uses_a_cached_success_or_renews_on_refusal() {
        let calls = Arc::new(AtomicUsize::new(0));
        let state = vod_state(calls.clone(), Arc::new(AtomicBool::new(true)));
        let renewed = Instant::now() - Duration::from_secs(30);
        {
            let mut state = state.lock().unwrap();
            state.renewed = renewed;
            state.verified = Some(Instant::now());
        }
        assert_eq!(
            fresh_vod_authority(&state).await,
            Err("account-proxy-revoked")
        );
        join_authorities(&state).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(state.lock().unwrap().renewed, renewed);
    }

    #[tokio::test(start_paused = true)]
    async fn vod_checks_cannot_revive_idle_expiry_maxlife_or_a_non_vod_owner() {
        for scenario in ["idle", "maxlife", "live"] {
            let calls = Arc::new(AtomicUsize::new(0));
            let state = vod_state(calls.clone(), Arc::new(AtomicBool::new(false)));
            {
                let mut s = state.lock().unwrap();
                match scenario {
                    "idle" => s.renewed = Instant::now() - LEASE,
                    "maxlife" => s.started = Instant::now() - MAX_LIFETIME,
                    _ => s.vod = false,
                }
            }
            let renewed = state.lock().unwrap().renewed;
            let error = if scenario == "live" {
                "account-proxy-state"
            } else {
                "account-proxy-expired"
            };
            assert_eq!(fresh_vod_authority(&state).await, Err(error));
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert_eq!(state.lock().unwrap().renewed, renewed);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_timed_out_fresh_vod_observer_retains_and_joins_its_real_callback_without_renewal() {
        let state = vod_state(
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicBool::new(false)),
        );
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let observed = entered.clone();
        let wait = release.clone();
        state.lock().unwrap().authority = Arc::new(move || {
            let observed = observed.clone();
            let wait = wait.clone();
            Box::pin(async move {
                observed.notify_one();
                wait.notified().await;
                Ok(())
            })
        });
        let renewed = state.lock().unwrap().renewed;
        let checking = state.clone();
        let task = tokio::spawn(async move { fresh_vod_authority(&checking).await });
        entered.notified().await;
        tokio::time::advance(Duration::from_secs(20)).await;
        assert_eq!(task.await.unwrap(), Err("account-proxy-timeout"));
        assert_eq!(state.lock().unwrap().authorities.len(), 1);
        assert_eq!(state.lock().unwrap().renewed, renewed);
        assert!(state.lock().unwrap().verified.is_none());
        release.notify_one();
        join_authorities(&state).await;
        assert_eq!(state.lock().unwrap().renewed, renewed);
        assert!(state.lock().unwrap().verified.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn an_unused_vod_proxy_still_expires_without_periodic_authority_or_lease_renewal() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        // VOD never preopens a provider connection. No request is made to this
        // fixture origin: only the otherwise-unused supervisor is exercised.
        let mut proxy = AccountPlaybackProxy::start(
            Zeroizing::new("https://vod.fixture.invalid/movie/fixture.mp4".into()),
            "https://vod.fixture.invalid".into(),
            19803,
            Arc::new(move || {
                let observed = observed.clone();
                Box::pin(async move {
                    observed.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            }),
            true,
            None,
            None,
        )
        .await
        .unwrap();
        let initial_calls = calls.load(Ordering::SeqCst);
        let renewed = proxy.state.lock().unwrap().renewed;
        settle().await;
        tokio::time::advance(LEASE + Duration::from_secs(1)).await;
        settle().await;
        assert!(proxy.task.as_ref().unwrap().is_finished());
        assert_eq!(calls.load(Ordering::SeqCst), initial_calls);
        assert_eq!(proxy.state.lock().unwrap().renewed, renewed);
        proxy.stop().await.unwrap();
        assert!(proxy.state.lock().unwrap().resources.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_fresh_success_after_idle_or_maxlife_expiry_cannot_revive_the_owner() {
        for maxlife in [false, true] {
            let state = vod_state(
                Arc::new(AtomicUsize::new(0)),
                Arc::new(AtomicBool::new(false)),
            );
            let entered = Arc::new(tokio::sync::Notify::new());
            let release = Arc::new(tokio::sync::Notify::new());
            let observed = entered.clone();
            let wait = release.clone();
            state.lock().unwrap().authority = Arc::new(move || {
                let observed = observed.clone();
                let wait = wait.clone();
                Box::pin(async move {
                    observed.notify_one();
                    wait.notified().await;
                    Ok(())
                })
            });
            let checking = state.clone();
            let task = tokio::spawn(async move { fresh_vod_authority(&checking).await });
            entered.notified().await;
            {
                let mut s = state.lock().unwrap();
                if maxlife {
                    s.started = Instant::now() - MAX_LIFETIME;
                } else {
                    s.renewed = Instant::now() - LEASE;
                }
            }
            let renewed = state.lock().unwrap().renewed;
            release.notify_one();
            assert_eq!(task.await.unwrap(), Err("account-proxy-expired"));
            join_authorities(&state).await;
            assert_eq!(state.lock().unwrap().renewed, renewed);
            assert!(state.lock().unwrap().verified.is_none());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn legacy_live_and_hls_body_chunks_keep_the_five_second_write_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let decoder = tokio::net::TcpSocket::new_v4().unwrap();
        decoder.set_recv_buffer_size(16384).unwrap();
        let decoder = decoder
            .connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        socket2::SockRef::from(&socket)
            .set_send_buffer_size(1024)
            .unwrap();
        let task = tokio::spawn(async move { chunk(&mut socket, &vec![1; 2 * 1024 * 1024]).await });
        settle().await;
        tokio::time::advance(Duration::from_secs(6)).await;
        assert_eq!(task.await.unwrap(), Err("account-proxy-write-timeout"));
        drop(decoder);
    }

    fn decode_chunked(mut wire: &[u8]) -> Result<Vec<u8>, &'static str> {
        let mut body = Vec::new();
        loop {
            let end = wire
                .windows(2)
                .position(|part| part == b"\r\n")
                .ok_or("missing chunk size")?;
            let size = std::str::from_utf8(&wire[..end])
                .ok()
                .and_then(|value| usize::from_str_radix(value, 16).ok())
                .ok_or("invalid chunk size")?;
            wire = &wire[end + 2..];
            if size == 0 {
                return (wire == b"\r\n")
                    .then_some(body)
                    .ok_or("invalid final chunk framing");
            }
            if wire.len() < size + 2 || &wire[size..size + 2] != b"\r\n" {
                return Err("truncated chunk or invalid body framing");
            }
            body.extend_from_slice(&wire[..size]);
            wire = &wire[size + 2..];
        }
    }

    struct RangedFixture {
        proxy: AccountPlaybackProxy,
        decoder: TcpStream,
        expected: Vec<u8>,
        headers: Vec<u8>,
        server: JoinHandle<bool>,
        port: u16,
        requests: Arc<AtomicUsize>,
    }
    async fn ranged_fixture(authority: Authority) -> RangedFixture {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        FIXTURE_PORTS.lock().unwrap().push(port);
        let mut body: Vec<u8> = (0..8 * 1024 * 1024).map(|n| (n % 251) as u8).collect();
        body[..12].copy_from_slice(b"\0\0\0\x18ftypisom");
        let expected = body.clone();
        let length = body.len();
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = requests.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0; 1];
            while !head.ends_with(b"\r\n\r\n") && head.len() < HEADER_LIMIT {
                if socket.read(&mut byte).await.unwrap_or(0) == 0 {
                    return false;
                }
                head.push(byte[0]);
            }
            observed.fetch_add(1, Ordering::SeqCst);
            let ranged = String::from_utf8_lossy(&head)
                .to_ascii_lowercase()
                .contains(&format!("range: bytes=0-{}\r\n", length - 1));
            let headers = format!("HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Length: {length}\r\nContent-Range: bytes 0-{}/{length}\r\nConnection: close\r\n\r\n", length - 1);
            if socket.write_all(headers.as_bytes()).await.is_ok() {
                let _ = socket.write_all(&body).await;
            }
            ranged
        });
        let origin = format!("http://127.0.0.1:{port}");
        let proxy = AccountPlaybackProxy::start(
            Zeroizing::new(format!("{origin}/movie/fixture.mp4")),
            origin,
            19801,
            authority,
            true,
            None,
            None,
        )
        .await
        .unwrap();
        let url = Url::parse(proxy.media_url()).unwrap();
        let decoder_socket = tokio::net::TcpSocket::new_v4().unwrap();
        decoder_socket.set_recv_buffer_size(16384).unwrap();
        let mut decoder = decoder_socket
            .connect(
                format!("127.0.0.1:{}", url.port().unwrap())
                    .parse()
                    .unwrap(),
            )
            .await
            .unwrap();
        let request = format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: http://tauri.localhost\r\nRange: bytes=0-{}\r\n\r\n", url.path(), url.port().unwrap(), length - 1);
        decoder.write_all(request.as_bytes()).await.unwrap();
        let mut headers = Vec::new();
        let mut byte = [0; 1];
        while !headers.ends_with(b"\r\n\r\n") && headers.len() < HEADER_LIMIT {
            if decoder.read(&mut byte).await.unwrap_or(0) == 0 {
                break;
            }
            headers.push(byte[0]);
        }
        RangedFixture {
            proxy,
            decoder,
            expected,
            headers,
            server,
            port,
            requests,
        }
    }

    #[tokio::test]
    async fn ranged_vod_survives_a_six_second_decoder_pause_with_exact_chunked_body() {
        let RangedFixture {
            mut proxy,
            mut decoder,
            expected,
            headers,
            server,
            port,
            requests,
        } = ranged_fixture(Arc::new(|| Box::pin(async { Ok(()) }))).await;
        // Keep the actual decoder socket connected but stop consuming bytes.
        // This exceeds the old five-second local write deadline; the provider
        // is healthy and already delivering the exact recognized MP4 range.
        tokio::time::sleep(Duration::from_secs(6)).await;
        socket2::SockRef::from(&decoder)
            .set_recv_buffer_size(1024 * 1024)
            .unwrap();
        let mut wire = Vec::new();
        let read =
            tokio::time::timeout(Duration::from_secs(12), decoder.read_to_end(&mut wire)).await;
        drop(decoder);
        let stopped = tokio::time::timeout(Duration::from_secs(3), proxy.stop()).await;
        let ranged = server.await.unwrap();
        FIXTURE_PORTS.lock().unwrap().retain(|value| *value != port);
        stopped.unwrap().unwrap();
        assert!(
            ranged,
            "The valid provider request must retain the exact range"
        );
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert!(String::from_utf8_lossy(&headers).starts_with("HTTP/1.1 206 "));
        read.unwrap().unwrap();
        assert_eq!(
            decode_chunked(&wire).expect("VOD body must finish with exact HTTP chunk framing"),
            expected,
            "A paused decoder must resume without skipped, repeated or overwritten bytes"
        );
    }

    #[tokio::test]
    async fn stop_joins_a_real_vod_client_while_its_decoder_remains_backpressured() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let RangedFixture {
            mut proxy,
            decoder,
            server,
            port,
            requests,
            ..
        } = ranged_fixture(Arc::new(move || {
            let observed = observed.clone();
            Box::pin(async move {
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }))
        .await;
        tokio::time::sleep(Duration::from_secs(6)).await;
        let fresh_calls = calls.load(Ordering::SeqCst);
        let stopped = tokio::time::timeout(Duration::from_secs(1), proxy.stop()).await;
        drop(decoder);
        let ranged = server.await.unwrap();
        FIXTURE_PORTS.lock().unwrap().retain(|value| *value != port);
        stopped.unwrap().unwrap();
        assert!(ranged);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert!(
            fresh_calls >= 4,
            "The blocked owned body must still obtain fresh authority"
        );
        assert!(proxy.task.is_none());
        assert!(proxy.state.lock().unwrap().resources.is_empty());
        assert!(proxy.state.lock().unwrap().authorities.is_empty());
    }
}
