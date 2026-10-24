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

use super::*;
#[test]
fn archive_bookmark_validity_follows_expiry_and_stop_after_capture_without_renewal() {
    let s = state(Arc::new(|| Box::pin(async { Ok(()) })));
    let (stop, receiver) = watch::channel(false);
    let check = validity(s.clone(), receiver);
    assert!(check());
    s.lock().unwrap().renewed = Instant::now() - LEASE;
    assert!(!check());
    let before = s.lock().unwrap().renewed;
    assert!(!check());
    assert_eq!(before, s.lock().unwrap().renewed);
    s.lock().unwrap().renewed = Instant::now();
    assert!(check());
    stop.send(true).unwrap();
    assert!(!check());
}
pub(super) fn state(authority: Authority) -> Arc<Mutex<State>> {
    Arc::new(Mutex::new(State {
        target: Some(Url::parse("https://archive.org/download/item/file.mp4").unwrap()),
        public: None,
        mime: "video/mp4",
        local: None,
        allowed_hosts: vec!["archive.org".into()],
        tail: "item/file.mp4".into(),
        size: 100,
        path: "/archive/cap/file.mp4".into(),
        host: "127.0.0.1:1234".into(),
        generation: 1,
        started: Instant::now(),
        renewed: Instant::now(),
        authority,
        alive: Arc::new(|| true),
        tasks: vec![],
        join_failed: false,
    }))
}
#[test]
fn decoder_http_requires_exact_capability_host_origin_and_single_range() {
    let state = state(Arc::new(|| Box::pin(async { Ok(()) })));
    let state = state.lock().unwrap();
    let valid =
            b"HEAD /archive/cap/file.mp4 HTTP/1.1\r\nHost: 127.0.0.1:1234\r\nRange: bytes=2-7\r\nOrigin: http://tauri.localhost\r\n\r\n";
    let parsed = parse(valid, &state).unwrap();
    assert!(parsed.head);
    assert_eq!(parsed.range, Some((2, 7)));
    for request in [
            "GET /archive/other/file.mp4 HTTP/1.1\r\nHost: 127.0.0.1:1234\r\n\r\n",
            "GET /archive/cap/file.mp4 HTTP/1.1\r\nHost: example.invalid\r\n\r\n",
            "GET /archive/cap/file.mp4 HTTP/1.1\r\nHost: 127.0.0.1:1234\r\nOrigin: https://example.invalid\r\n\r\n",
            "GET /archive/cap/file.mp4 HTTP/1.1\r\nHost: 127.0.0.1:1234\r\nRange: bytes=0-1,5-6\r\n\r\n",
        ] {
            assert!(parse(request.as_bytes(), &state).is_err());
        }
}
#[tokio::test]
async fn decoder_disconnect_releases_client_and_retains_actual_authority_join() {
    let entered = Arc::new(tokio::sync::Notify::new());
    let released = Arc::new(tokio::sync::Notify::new());
    let signal = entered.clone();
    let wait = released.clone();
    let state = state(Arc::new(move || {
        let signal = signal.clone();
        let wait = wait.clone();
        Box::pin(async move {
            signal.notify_one();
            wait.notified().await;
            Ok(())
        })
    }));
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    state.lock().unwrap().host = address.to_string();
    let mut decoder = TcpStream::connect(address).await.unwrap();
    let (socket, _) = listener.accept().await.unwrap();
    let (_cancel, receiver) = watch::channel(false);
    let live = state.clone();
    let serving = tokio::spawn(async move { client(socket, live, receiver).await });
    decoder
        .write_all(
            format!("GET /archive/cap/file.mp4 HTTP/1.1\r\nHost: {address}\r\n\r\n").as_bytes(),
        )
        .await
        .unwrap();
    entered.notified().await;
    drop(decoder);
    tokio::time::timeout(Duration::from_secs(1), serving)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state.lock().unwrap().tasks.len(), 1);
    released.notify_one();
    join_tasks(&state).await.unwrap();
    assert!(state.lock().unwrap().tasks.is_empty());
}
#[test]
fn range_requests_are_exact_bounded_and_single() {
    assert_eq!(range("bytes=0-", 100).unwrap(), (0, 99));
    assert_eq!(range("bytes=-20", 100).unwrap(), (80, 99));
    assert_eq!(range("bytes=90-999", 100).unwrap(), (90, 99));
    for raw in [
        "bytes=0-1,4-5",
        "bytes=100-",
        "bytes=-0",
        "bytes=+1-2",
        "bytes=9-2",
    ] {
        assert!(range(raw, 100).is_err());
    }
}
#[test]
fn redirects_require_actual_metadata_host_and_exact_item_file() {
    let hosts = vec!["archive.org".into(), "ia800001.us.archive.org".into()];
    let tail = "item/exact%20file.mp4";
    assert!(validate(
        &Url::parse("https://ia800001.us.archive.org/12/items/item/exact%20file.mp4").unwrap(),
        &hosts,
        tail
    )
    .is_ok());
    for raw in [
        "https://ia800002.us.archive.org/12/items/item/exact%20file.mp4",
        "https://archive.org.evil.invalid/download/item/exact%20file.mp4",
        "https://archive.org/download/item/other.mp4",
        "https://archive.org/download/item/exact%20file.mp4?token=x",
        "http://archive.org/download/item/exact%20file.mp4",
    ] {
        assert!(validate(&Url::parse(raw).unwrap(), &hosts, tail).is_err());
    }
}
#[test]
fn destination_refusals_distinguish_url_host_and_exact_path_without_echoing_data() {
    let hosts = vec!["archive.org".into(), "ia800001.us.archive.org".into()];
    let tail = "item/exact%20file.mp4";
    for (raw, expected) in [
        (
            "http://archive.org/download/item/exact%20file.mp4",
            "archive-proxy-url-refused",
        ),
        (
            "https://archive.org:444/download/item/exact%20file.mp4",
            "archive-proxy-url-refused",
        ),
        (
            "https://private:secret@archive.org/download/item/exact%20file.mp4",
            "archive-proxy-url-refused",
        ),
        (
            "https://archive.org/download/item/exact%20file.mp4?private=secret",
            "archive-proxy-url-refused",
        ),
        (
            "https://archive.org/download/item/exact%20file.mp4#private",
            "archive-proxy-url-refused",
        ),
        (
            "https://ia800002.us.archive.org/12/items/item/exact%20file.mp4",
            "archive-proxy-host-unverified",
        ),
        (
            "https://dn800001.us.archive.org/12/items/item/exact%20file.mp4",
            "archive-proxy-host-unverified",
        ),
        (
            "https://archive.org.evil.invalid/download/item/exact%20file.mp4",
            "archive-proxy-host-unverified",
        ),
        (
            "https://archive.org/download/item/other.mp4",
            "archive-proxy-path-unverified",
        ),
        (
            "https://archive.org/12345/items/item/exact%20file.mp4",
            "archive-proxy-path-unverified",
        ),
        (
            "https://archive.org/12/items/other/exact%20file.mp4",
            "archive-proxy-path-unverified",
        ),
    ] {
        let error = validate(&Url::parse(raw).unwrap(), &hosts, tail).unwrap_err();
        assert_eq!(error, expected);
        assert!(!error.contains("secret") && !error.contains("private") && !error.contains("http"));
    }
    // Only the exact fresh metadata-listed DN host is admitted.
    assert!(validate(
        &Url::parse("https://dn800001.us.archive.org/items/item/exact%20file.mp4").unwrap(),
        &["dn800001.us.archive.org".into()],
        tail
    )
    .is_ok());
}
#[test]
fn dns_refusals_preserve_whole_answer_public_validation_and_exact_address_cap() {
    let public: SocketAddr = "8.8.8.8:443".parse().unwrap();
    assert_eq!(checked_addresses([public]).unwrap(), vec![public]);
    assert_eq!(
        checked_addresses(std::iter::repeat_n(public, 128))
            .unwrap()
            .len(),
        128
    );
    assert_eq!(
        checked_addresses(std::iter::repeat_n(public, 129)).unwrap_err(),
        "archive-proxy-dns-address-limit"
    );
    assert_eq!(checked_addresses([]).unwrap_err(), "archive-proxy-dns");
    for private in [
        "127.0.0.1:443",
        "10.0.0.1:443",
        "169.254.1.1:443",
        "[::1]:443",
        "[::ffff:192.168.1.1]:443",
    ] {
        assert_eq!(
            checked_addresses([public, private.parse().unwrap()]).unwrap_err(),
            "archive-proxy-dns-private"
        );
    }
}
#[test]
fn response_encoding_refusal_is_distinct_and_does_not_relax_size_range_or_mime() {
    let response = |encoding: Option<&str>| {
        let mut builder = tauri::http::Response::builder()
            .status(206)
            .header("content-type", "video/mp4")
            .header("content-length", "4")
            .header("content-range", "bytes 0-3/100");
        if let Some(value) = encoding {
            builder = builder.header("content-encoding", value);
        }
        reqwest::Response::from(builder.body(reqwest::Body::from(vec![0u8; 4])).unwrap())
    };
    for encoding in [None, Some("identity")] {
        assert_eq!(
            response_length(&response(encoding), Some((0, 3)), 100).unwrap(),
            4
        );
    }
    for encoding in ["gzip", "br", "Identity", "identity, gzip"] {
        assert_eq!(
            response_length(&response(Some(encoding)), Some((0, 3)), 100).unwrap_err(),
            "archive-proxy-response-encoding-unverified"
        );
    }
    assert_eq!(
        response_length(&response(None), Some((0, 4)), 100).unwrap_err(),
        "archive-media-range-unverified"
    );
}
#[tokio::test]
async fn canceled_authority_observer_still_joins_actual_producer() {
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let a = started.clone();
    let b = release.clone();
    let d = done.clone();
    let check: Authority = Arc::new(move || {
        let a = a.clone();
        let b = b.clone();
        let d = d.clone();
        Box::pin(async move {
            a.notify_one();
            b.notified().await;
            d.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
    });
    let state = Arc::new(Mutex::new(State {
        target: Some(Url::parse("https://archive.org/download/item/file.mp4").unwrap()),
        public: None,
        mime: "video/mp4",
        local: None,
        allowed_hosts: vec!["archive.org".into()],
        tail: "item/file.mp4".into(),
        size: 100,
        path: "/archive/cap/file.mp4".into(),
        host: "127.0.0.1:1234".into(),
        generation: 1,
        started: Instant::now(),
        renewed: Instant::now(),
        authority: check,
        alive: Arc::new(|| true),
        tasks: vec![],
        join_failed: false,
    }));
    let observed = state.clone();
    let observer = tokio::spawn(async move { authority(&observed).await });
    started.notified().await;
    observer.abort();
    assert!(observer.await.unwrap_err().is_cancelled());
    assert!(!done.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(state.lock().unwrap().tasks.len(), 1);
    release.notify_one();
    join_tasks(&state).await.unwrap();
    assert!(done.load(std::sync::atomic::Ordering::SeqCst));
    assert!(state.lock().unwrap().tasks.is_empty());
}
