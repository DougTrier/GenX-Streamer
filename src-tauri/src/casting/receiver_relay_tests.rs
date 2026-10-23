use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
async fn fixture() -> ReceiverRelay {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    ReceiverRelay::owned(
        listener,
        origin,
        IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
        Url::parse("https://fixture.test/master?private=secret").unwrap(),
        false,
    )
    .unwrap()
}
async fn request(url: &str, header: &str) -> Vec<u8> {
    let url = Url::parse(url).unwrap();
    let mut socket = TcpStream::connect((url.host_str().unwrap(), url.port().unwrap()))
        .await
        .unwrap();
    socket
        .write_all(format!("{header}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut result = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(2), socket.read_to_end(&mut result))
        .await
        .unwrap();
    if let Err(error) = read {
        assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
    }
    result
}
#[tokio::test]
async fn production_start_requires_separate_consent_and_private_receiver() {
    let selection = MediaSelection {
        id: "one".into(),
        name: "TV".into(),
        url: "https://fixture.test/opaque".into(),
        content_type: "application/vnd.apple.mpegurl".into(),
    };
    assert!(matches!(
        ReceiverRelay::start(
            "192.168.1.5:8009".parse().unwrap(),
            &selection,
            false,
            false
        )
        .await,
        Err("cast-relay-http-consent-required")
    ));
    assert!(matches!(
        ReceiverRelay::start("127.0.0.1:8009".parse().unwrap(), &selection, false, true).await,
        Err("cast-relay-receiver-refused")
    ));
}
#[tokio::test]
async fn actual_http_rejects_arbitrary_targets_unknown_tokens_and_other_peers_before_fetch() {
    let mut relay = fixture().await;
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    relay.state.lock().unwrap().fetch = Arc::new(move |_, _, _| {
        seen.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err("unexpected-fetch") })
    });
    let parsed = Url::parse(relay.media_url()).unwrap();
    for path in [
        "/proxy?url=https://private.test",
        "/media/../../secret",
        "/media/not-a-token",
    ] {
        let reply = request(
            relay.media_url(),
            &format!("GET {path} HTTP/1.1\r\nHost: fixture"),
        )
        .await;
        assert!(reply.starts_with(b"HTTP/1.1 400"));
    }
    let unknown = format!("/media/{}", "a".repeat(64));
    assert!(request(
        relay.media_url(),
        &format!("GET {unknown} HTTP/1.1\r\nHost: fixture")
    )
    .await
    .starts_with(b"HTTP/1.1 404"));
    let options = request(
        relay.media_url(),
        &format!(
            "OPTIONS {} HTTP/1.1\r\nAccess-Control-Request-Headers: Range",
            parsed.path()
        ),
    )
    .await;
    assert!(options.starts_with(b"HTTP/1.1 204"));
    assert!(String::from_utf8_lossy(&options).contains("Access-Control-Allow-Headers: Range"));
    relay.state.lock().unwrap().receiver = "192.168.1.5".parse().unwrap();
    let denied = request(
        relay.media_url(),
        &format!("GET {} HTTP/1.1\r\nHost: fixture", parsed.path()),
    )
    .await;
    assert!(denied.is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    relay.stop().await.unwrap();
}
#[tokio::test]
async fn real_http_preserves_ranges_busy_status_retry_and_head_without_raw_source_errors() {
    let mut relay = fixture().await;
    relay.state.lock().unwrap().fetch = Arc::new(|url, range, _| {
        Box::pin(async move {
            assert_eq!(range.as_deref(), Some("bytes=2-3"));
            Ok(upstream::Reply {
                body: b"AB".to_vec(),
                content_type: "video/mp4".into(),
                content_range: Some("bytes 2-3/10".into()),
                status: 206,
                retry_after: None,
                final_url: url,
            })
        })
    });
    let path = Url::parse(relay.media_url()).unwrap().path().to_owned();
    let reply = request(
        relay.media_url(),
        &format!("GET {path} HTTP/1.1\r\nRange: bytes=2-3"),
    )
    .await;
    assert!(reply.starts_with(b"HTTP/1.1 206"));
    assert!(String::from_utf8_lossy(&reply).contains("Content-Range: bytes 2-3/10"));
    assert!(reply.ends_with(b"\r\n\r\nAB"));
    let head = request(
        relay.media_url(),
        &format!("HEAD {path} HTTP/1.1\r\nRange: bytes=2-3"),
    )
    .await;
    assert!(head.ends_with(b"\r\n\r\n"));
    assert!(String::from_utf8_lossy(&head).contains("Content-Length: 2"));
    relay.state.lock().unwrap().fetch = Arc::new(|url, _, _| {
        Box::pin(async move {
            Ok(upstream::Reply {
                body: b"private-provider-token".to_vec(),
                content_type: "text/plain".into(),
                content_range: None,
                status: 429,
                retry_after: Some("30".into()),
                final_url: url,
            })
        })
    });
    let busy = request(relay.media_url(), &format!("GET {path} HTTP/1.1")).await;
    let busy = String::from_utf8(busy).unwrap();
    assert!(busy.starts_with("HTTP/1.1 429"));
    assert!(busy.contains("Retry-After: 30"));
    assert!(!busy.contains("private-provider-token"));
    relay.stop().await.unwrap();
}
#[tokio::test]
async fn real_http_extensionless_manifest_rewrites_variants_keys_maps_and_signed_references() {
    let mut relay = fixture().await;
    relay.state.lock().unwrap().fetch = Arc::new(|url, _, _| {
        Box::pin(async move {
            Ok(upstream::Reply{body:b"\xef\xbb\xbf#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key?token=secret\"\n#EXT-X-MAP:URI=\"init\"\n#EXT-X-STREAM-INF:BANDWIDTH=100\nvariant\nmedia?token=secret\n".to_vec(),content_type:"text/plain".into(),content_range:None,status:200,retry_after:None,final_url:url})
        })
    });
    let path = Url::parse(relay.media_url()).unwrap().path().to_owned();
    let reply = request(relay.media_url(), &format!("GET {path} HTTP/1.1")).await;
    let reply = String::from_utf8(reply).unwrap();
    assert!(reply.contains("Content-Type: application/vnd.apple.mpegurl"));
    assert!(!reply.contains("secret"));
    assert!(!reply.contains("fixture.test"));
    {
        let state = relay.state.lock().unwrap();
        assert_eq!(state.resources.len(), 5);
        assert!(state
            .resources
            .values()
            .any(|resource| resource.url.as_str() == "https://fixture.test/key?token=secret"));
    }
    relay.stop().await.unwrap();
}
#[tokio::test]
async fn stop_cancels_pending_fetch_and_stalled_headers_then_closes_listener_idempotently() {
    let mut relay = fixture().await;
    let (entered, mut received) = watch::channel(false);
    relay.state.lock().unwrap().fetch = Arc::new(move |_, _, _| {
        let _ = entered.send(true);
        Box::pin(std::future::pending())
    });
    let url = Url::parse(relay.media_url()).unwrap();
    let mut fetching = TcpStream::connect((url.host_str().unwrap(), url.port().unwrap()))
        .await
        .unwrap();
    fetching
        .write_all(format!("GET {} HTTP/1.1\r\n\r\n", url.path()).as_bytes())
        .await
        .unwrap();
    received.changed().await.unwrap();
    let mut stalled = TcpStream::connect((url.host_str().unwrap(), url.port().unwrap()))
        .await
        .unwrap();
    stalled.write_all(b"GET /media/").await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), relay.stop())
        .await
        .unwrap()
        .unwrap();
    relay.stop().await.unwrap();
    assert!(
        TcpStream::connect((url.host_str().unwrap(), url.port().unwrap()))
            .await
            .is_err()
    );
    let mut byte = [0];
    assert_eq!(fetching.read(&mut byte).await.unwrap(), 0);
    match stalled.read(&mut byte).await {
        Ok(count) => assert_eq!(count, 0),
        Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset),
    }
    assert!(relay.state.lock().unwrap().resources.is_empty());
}
#[tokio::test]
async fn expiry_releases_listener_and_cannot_be_renewed_after_expiration() {
    let mut relay = fixture().await;
    relay.state.lock().unwrap().renewed = Instant::now() - LEASE;
    assert_eq!(relay.renew(), Err("cast-relay-expired"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(relay.task.as_ref().unwrap().is_finished());
    relay.stop().await.unwrap();
}
#[tokio::test]
async fn master_resource_survives_owned_pause_but_absolute_lifetime_is_not_extendable() {
    let mut relay = fixture().await;
    {
        let mut state = relay.state.lock().unwrap();
        let root = state.root.clone();
        state.resources.get_mut(&root).unwrap().seen = Instant::now() - RESOURCE_LIFETIME;
        state
            .issue(Url::parse("https://fixture.test/other").unwrap())
            .unwrap();
        assert!(state.resources.contains_key(&root));
        state.fetch = Arc::new(|url, _, _| {
            Box::pin(async move {
                Ok(upstream::Reply {
                    body: vec![1],
                    content_type: "video/mp4".into(),
                    content_range: None,
                    status: 200,
                    retry_after: None,
                    final_url: url,
                })
            })
        });
    }
    let path = Url::parse(relay.media_url()).unwrap().path().to_owned();
    assert!(request(relay.media_url(), &format!("GET {path} HTTP/1.1"))
        .await
        .starts_with(b"HTTP/1.1 200"));
    relay.state.lock().unwrap().started = Instant::now() - MAX_LIFETIME;
    assert_eq!(relay.renew(), Err("cast-relay-expired"));
    relay.stop().await.unwrap();
}
#[tokio::test]
async fn active_fetch_concurrency_is_bounded_and_excess_clients_cannot_enqueue_work() {
    let mut relay = fixture().await;
    let calls = Arc::new(AtomicUsize::new(0));
    let entered = calls.clone();
    relay.state.lock().unwrap().fetch = Arc::new(move |_, _, _| {
        entered.fetch_add(1, Ordering::SeqCst);
        Box::pin(std::future::pending())
    });
    let url = Url::parse(relay.media_url()).unwrap();
    let mut sockets = Vec::new();
    for _ in 0..MAX_CLIENTS {
        let mut socket = TcpStream::connect((url.host_str().unwrap(), url.port().unwrap()))
            .await
            .unwrap();
        socket
            .write_all(format!("GET {} HTTP/1.1\r\n\r\n", url.path()).as_bytes())
            .await
            .unwrap();
        sockets.push(socket);
    }
    tokio::time::timeout(Duration::from_secs(1), async {
        while calls.load(Ordering::SeqCst) != MAX_CLIENTS {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let refused = request(relay.media_url(), &format!("GET {} HTTP/1.1", url.path())).await;
    assert!(refused.is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), MAX_CLIENTS);
    relay.stop().await.unwrap();
    drop(sockets);
}
#[tokio::test]
async fn parsed_variant_playlist_capability_survives_a_long_owned_receiver_pause() {
    let mut relay = fixture().await;
    relay.state.lock().unwrap().fetch = Arc::new(|url, _, _| {
        Box::pin(async move {
            Ok(upstream::Reply {
                body: b"#EXTM3U\n#EXTINF:2,\nsegment\n".to_vec(),
                content_type: "text/plain".into(),
                content_range: None,
                status: 200,
                retry_after: None,
                final_url: url,
            })
        })
    });
    let variant = relay
        .state
        .lock()
        .unwrap()
        .issue(Url::parse("https://fixture.test/variant").unwrap())
        .unwrap();
    let path = Url::parse(&variant).unwrap().path().to_owned();
    assert!(request(&variant, &format!("GET {path} HTTP/1.1"))
        .await
        .starts_with(b"HTTP/1.1 200"));
    {
        let mut state = relay.state.lock().unwrap();
        let id = path.trim_start_matches("/media/");
        state.resources.get_mut(id).unwrap().seen = Instant::now() - RESOURCE_LIFETIME;
        state
            .issue(Url::parse("https://fixture.test/new-resource").unwrap())
            .unwrap();
        assert!(state.resources.contains_key(id));
    }
    assert!(request(&variant, &format!("GET {path} HTTP/1.1"))
        .await
        .starts_with(b"HTTP/1.1 200"));
    relay.stop().await.unwrap();
}
#[tokio::test]
async fn failed_manifest_rewrite_is_atomic_and_resource_limits_are_explicit() {
    let mut relay = fixture().await;
    {
        let mut state = relay.state.lock().unwrap();
        let original = state.resources.len();
        assert!(state
            .rewrite(
                "#EXTM3U\nsegment\nhttp://private.test/refused\n",
                &Url::parse("https://fixture.test/path/master").unwrap()
            )
            .is_err());
        assert_eq!(state.resources.len(), original);
        for index in 1..MAX_RESOURCES {
            state
                .issue(Url::parse(&format!("https://fixture.test/resource/{index}")).unwrap())
                .unwrap();
        }
        assert_eq!(
            state.issue(Url::parse("https://fixture.test/overflow").unwrap()),
            Err("cast-relay-resource-limit")
        );
        assert!(state
            .issue(Url::parse("https://user:secret@fixture.test/a").unwrap())
            .is_err());
        assert!(state
            .issue(Url::parse("https://127.0.0.1/a").unwrap())
            .is_err());
        assert!(state.issue(Url::parse("https://[::1]/a").unwrap()).is_err());
        assert!(state
            .issue(Url::parse("https://[::ffff:127.0.0.1]/a").unwrap())
            .is_err());
    }
    relay.stop().await.unwrap();
}
#[test]
fn request_parser_refuses_duplicate_ranges_bodies_and_non_viewing_methods() {
    let path = format!("/media/{}", "b".repeat(64));
    for header in [
        format!("POST {path} HTTP/1.1\r\n\r\n"),
        format!("GET {path} HTTP/1.1\r\nRange: bytes=0-1\r\nRange: bytes=2-3\r\n\r\n"),
        format!("GET {path} HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"),
        format!("GET {path} HTTP/1.1\r\nContent-Length: 1\r\n\r\n"),
    ] {
        assert!(parse_request(header.as_bytes()).is_err());
    }
}
#[tokio::test]
async fn loopback_relay_serves_only_this_device_and_only_public_streams() {
    let mut relay = ReceiverRelay::start_loopback("https://fixture.test/live.m3u8", false)
        .await
        .unwrap();
    let url = Url::parse(relay.media_url()).unwrap();
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    let segments: Vec<&str> = url.path_segments().unwrap().collect();
    assert_eq!(segments.len(), 2);
    assert_eq!(segments[0], "media");
    assert!(segments[1].len() == 64 && segments[1].bytes().all(|b| b.is_ascii_hexdigit()));
    relay.stop().await.unwrap();
    for refused in [
        "http://fixture.test/live.m3u8",
        "https://127.0.0.1/live.m3u8",
        "https://192.168.1.4/live.m3u8",
        "https://user:pass@fixture.test/live.m3u8",
    ] {
        assert!(
            ReceiverRelay::start_loopback(refused, false).await.is_err(),
            "{refused}"
        );
    }
    // Plain HTTP only when this channel's source allows it.
    let mut plain = ReceiverRelay::start_loopback("http://fixture.test/live.m3u8", true)
        .await
        .unwrap();
    plain.stop().await.unwrap();
}
