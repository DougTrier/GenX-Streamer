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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct ControlledBody {
    ready: AtomicBool,
    wake: tokio::sync::Notify,
    bytes: Mutex<Vec<u8>>,
    partial: usize,
    would_block_once: AtomicBool,
    fail: AtomicBool,
    write_error: AtomicBool,
}
impl ControlledBody {
    fn blocked() -> Arc<Self> {
        Arc::new(Self {
            ready: AtomicBool::new(false),
            wake: tokio::sync::Notify::new(),
            bytes: Mutex::new(Vec::new()),
            partial: 3,
            would_block_once: AtomicBool::new(false),
            fail: AtomicBool::new(false),
            write_error: AtomicBool::new(false),
        })
    }
    fn release(&self) {
        self.ready.store(true, Ordering::SeqCst);
        self.wake.notify_waiters();
    }
}
impl BodyOutput for ControlledBody {
    async fn writable(&self) -> std::io::Result<()> {
        loop {
            let wake = self.wake.notified();
            if self.fail.load(Ordering::SeqCst) {
                return Err(std::io::ErrorKind::BrokenPipe.into());
            }
            if self.ready.load(Ordering::SeqCst) {
                return Ok(());
            }
            wake.await;
        }
    }
    fn try_body_write(&self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.write_error.load(Ordering::SeqCst) {
            return Err(std::io::ErrorKind::BrokenPipe.into());
        }
        if self.would_block_once.swap(false, Ordering::SeqCst) {
            return Err(std::io::ErrorKind::WouldBlock.into());
        }
        let count = bytes.len().min(self.partial);
        self.bytes
            .lock()
            .unwrap()
            .extend_from_slice(&bytes[..count]);
        Ok(count)
    }
}

fn diagnostic_request() -> Request {
    Request {
        range: Some((12, 99)),
        head: false,
        options: false,
        origin: Some("http://tauri.localhost".into()),
    }
}

#[tokio::test(start_paused = true)]
async fn vod_body_backpressure_longer_than_twenty_seconds_keeps_one_socket_and_exact_bytes() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let decoder_socket = tokio::net::TcpSocket::new_v4().unwrap();
    decoder_socket.set_recv_buffer_size(16384).unwrap();
    let mut decoder = decoder_socket
        .connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (socket, _) = listener.accept().await.unwrap();
    socket2::SockRef::from(&socket)
        .set_send_buffer_size(1024)
        .unwrap();
    socket.set_nodelay(true).unwrap();
    let (_, writer) = socket.into_split();
    let entered = Arc::new(tokio::sync::Notify::new());
    let observed = entered.clone();
    let state = state(Arc::new(move || {
        let observed = observed.clone();
        Box::pin(async move {
            observed.notify_one();
            Ok(())
        })
    }));
    let data: Vec<u8> = (0..(32 * CHUNK)).map(|n| (n % 251) as u8).collect();
    let expected = data.clone();
    let task = tokio::spawn(async move {
        let mut diagnostic = RequestDiagnostic::new(&state, &diagnostic_request());
        let mut result = Ok(());
        for chunk in data.chunks(CHUNK) {
            if let Err(error) = observed_remote_chunk(&state, &writer, chunk, &mut diagnostic).await
            {
                result = Err(error);
                break;
            }
        }
        (result, diagnostic.body_bytes)
    });
    entered.notified().await;
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_secs(21)).await;
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    if task.is_finished() {
        let (result, written) = task.await.unwrap();
        panic!("Response finished while decoder remained blocked: result={result:?} accepted={written}; expected pending single response after 21 seconds");
    }
    tokio::time::resume();
    let mut received = vec![0; expected.len()];
    tokio::time::timeout(Duration::from_secs(5), decoder.read_exact(&mut received))
        .await
        .unwrap()
        .unwrap();
    let (result, written) = task.await.unwrap();
    result.unwrap();
    assert_eq!(written as usize, expected.len());
    assert_eq!(
        received, expected,
        "No skipped or repeated byte after backpressure resumes"
    );
}

#[tokio::test(start_paused = true)]
async fn header_write_keeps_twenty_second_deadline_and_actual_partial_byte_count() {
    let state = state(Arc::new(|| Box::pin(async { Ok(()) })));
    let mut diagnostic = RequestDiagnostic::new(&state, &diagnostic_request());
    let (mut writer, _reader) = tokio::io::duplex(1);
    let at = Instant::now();
    let error = observed_output(&mut writer, b"ab", false, &mut diagnostic)
        .await
        .unwrap_err();
    assert_eq!(error, "archive-proxy-write-timeout");
    assert_eq!(Instant::now() - at, DEADLINE);
    let line = diagnostic.line(RequestEnd::Failed, Some(&error), true);
    assert!(line.contains("written_bytes=1 body_bytes=0"));
    assert!(line.contains("authority_ms=0 write_ms=20000 phase=headers timeout_boundary=socket"));
    assert!(line.contains("owner_current=true failure=write-timeout"));
}

#[tokio::test(start_paused = true)]
async fn authority_deadline_reports_held_authority_and_preserves_existing_refusal() {
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let observed = entered.clone();
    let wait = release.clone();
    let state = state(Arc::new(move || {
        let observed = observed.clone();
        let wait = wait.clone();
        Box::pin(async move {
            observed.notify_one();
            wait.notified().await;
            Ok(())
        })
    }));
    let mut diagnostic = RequestDiagnostic::new(&state, &diagnostic_request());
    let writer = ControlledBody::blocked();
    writer.release();
    let at = Instant::now();
    let error = observed_remote_chunk(&state, writer.as_ref(), b"ab", &mut diagnostic)
        .await
        .unwrap_err();
    assert_eq!(error, "archive-proxy-timeout");
    assert_eq!(Instant::now() - at, DEADLINE);
    let line = diagnostic.line(RequestEnd::Failed, Some(&error), true);
    assert!(line.contains("written_bytes=0 body_bytes=0"));
    assert!(
        line.contains("authority_ms=20000 write_ms=0 phase=authority timeout_boundary=authority")
    );
    assert_eq!(state.lock().unwrap().tasks.len(), 1);
    // Timeout only drops the observer. The retained authority operation is
    // still joined, preserving the existing Stop ownership contract.
    release.notify_one();
    join_tasks(&state).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn body_backpressure_rechecks_authority_over_twenty_seconds_and_writes_exact_partial_bytes() {
    let checks = Arc::new(AtomicUsize::new(0));
    let observed = checks.clone();
    let state = state(Arc::new(move || {
        let observed = observed.clone();
        Box::pin(async move {
            observed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }));
    let writer = ControlledBody::blocked();
    writer.would_block_once.store(true, Ordering::SeqCst);
    let output = writer.clone();
    let task = tokio::spawn(async move {
        let mut diagnostic = RequestDiagnostic::new(&state, &diagnostic_request());
        let result =
            observed_remote_chunk(&state, output.as_ref(), b"abcdefgh", &mut diagnostic).await;
        join_tasks(&state).await.unwrap();
        (result, diagnostic)
    });
    tokio::task::yield_now().await;
    for _ in 0..12 {
        tokio::time::advance(BODY_AUTHORITY_CHECK).await;
        for _ in 0..4 {
            tokio::task::yield_now().await;
        }
    }
    assert!(!task.is_finished());
    assert!(checks.load(Ordering::SeqCst) >= 12);
    assert!(writer.bytes.lock().unwrap().is_empty());
    writer.release();
    let (result, mut diagnostic) = task.await.unwrap();
    result.unwrap();
    assert_eq!(&*writer.bytes.lock().unwrap(), b"abcdefgh");
    assert_eq!(diagnostic.body_bytes, 8);
    assert!(diagnostic
        .line(RequestEnd::Complete, None, true)
        .contains("timeout_boundary=none"));
}

#[tokio::test(start_paused = true)]
async fn readiness_after_revocation_cannot_write_using_preblocked_authority() {
    let allowed = Arc::new(AtomicBool::new(true));
    let checks = Arc::new(AtomicUsize::new(0));
    let admit = allowed.clone();
    let observed = checks.clone();
    let state = state(Arc::new(move || {
        let admit = admit.clone();
        let observed = observed.clone();
        Box::pin(async move {
            observed.fetch_add(1, Ordering::SeqCst);
            if admit.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("archive-playback-replaced".into())
            }
        })
    }));
    let writer = ControlledBody::blocked();
    let output = writer.clone();
    let task = tokio::spawn(async move {
        let mut diagnostic = RequestDiagnostic::new(&state, &diagnostic_request());
        let result =
            observed_remote_chunk(&state, output.as_ref(), b"never", &mut diagnostic).await;
        join_tasks(&state).await.unwrap();
        result
    });
    tokio::task::yield_now().await;
    tokio::time::advance(BODY_AUTHORITY_CHECK).await;
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
    assert!(checks.load(Ordering::SeqCst) > 0);
    allowed.store(false, Ordering::SeqCst);
    // Readiness arrives before the next periodic check. A fresh authority
    // decision still occurs before the nonblocking write is attempted.
    writer.release();
    assert_eq!(
        task.await.unwrap().unwrap_err(),
        "archive-playback-replaced"
    );
    assert!(writer.bytes.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn periodic_revocation_ends_blocked_body_without_any_further_byte() {
    let allowed = Arc::new(AtomicBool::new(true));
    let admit = allowed.clone();
    let state = state(Arc::new(move || {
        let admit = admit.clone();
        Box::pin(async move {
            if admit.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("archive-file-stale".into())
            }
        })
    }));
    let writer = ControlledBody::blocked();
    let output = writer.clone();
    let task = tokio::spawn(async move {
        let mut diagnostic = RequestDiagnostic::new(&state, &diagnostic_request());
        let result =
            observed_remote_chunk(&state, output.as_ref(), b"never", &mut diagnostic).await;
        join_tasks(&state).await.unwrap();
        result
    });
    tokio::task::yield_now().await;
    allowed.store(false, Ordering::SeqCst);
    tokio::time::advance(BODY_AUTHORITY_CHECK).await;
    assert_eq!(task.await.unwrap().unwrap_err(), "archive-file-stale");
    assert!(writer.bytes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn socket_readiness_and_try_write_errors_are_not_swallowed() {
    let state = state(Arc::new(|| Box::pin(async { Ok(()) })));
    let writer = ControlledBody::blocked();
    writer.fail.store(true, Ordering::SeqCst);
    let mut diagnostic = RequestDiagnostic::new(&state, &diagnostic_request());
    assert_eq!(
        observed_remote_chunk(&state, writer.as_ref(), b"never", &mut diagnostic)
            .await
            .unwrap_err(),
        "archive-proxy-write-failed"
    );
    assert_eq!(diagnostic.body_bytes, 0);
    let writer = ControlledBody::blocked();
    writer.write_error.store(true, Ordering::SeqCst);
    writer.release();
    assert_eq!(
        observed_remote_chunk(&state, writer.as_ref(), b"never", &mut diagnostic)
            .await
            .unwrap_err(),
        "archive-proxy-write-failed"
    );
    assert_eq!(diagnostic.body_bytes, 0);
}

#[tokio::test]
async fn cancel_joins_an_actual_backpressured_client_without_waiting_for_body_timeout() {
    let (_root, body, _) = crate::archive_download_store::local_proxy_fixture_sized(32 * CHUNK);
    let size = body.size();
    let checks = Arc::new(AtomicUsize::new(0));
    let observed = checks.clone();
    let state = state(Arc::new(move || {
        let observed = observed.clone();
        Box::pin(async move {
            observed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }));
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let decoder_socket = tokio::net::TcpSocket::new_v4().unwrap();
    decoder_socket.set_recv_buffer_size(16384).unwrap();
    let mut decoder = decoder_socket
        .connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (socket, _) = listener.accept().await.unwrap();
    socket2::SockRef::from(&socket)
        .set_send_buffer_size(1024)
        .unwrap();
    {
        let mut s = state.lock().unwrap();
        s.local = Some(Arc::new(body));
        s.size = size;
        s.host = listener.local_addr().unwrap().to_string();
    }
    let (cancel, receiver) = watch::channel(false);
    let serving_state = state.clone();
    let serving = tokio::spawn(async move { client(socket, serving_state, receiver).await });
    decoder
        .write_all(
            format!(
                "GET /archive/cap/file.mp4 HTTP/1.1\r\nHost: {}\r\n\r\n",
                listener.local_addr().unwrap()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    // Read actual body bytes, then leave most of the response unconsumed.
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        decoder.read_exact(&mut byte).await.unwrap();
        headers.push(byte[0]);
    }
    let mut prefix = vec![0; CHUNK];
    decoder.read_exact(&mut prefix).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let before = checks.load(Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(100)).await;
            if checks.load(Ordering::SeqCst) == before {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(!serving.is_finished());
    // With no decoder reads or new requests, a later authority check proves
    // the current body reached its periodic socket-backpressure checkpoint.
    let before = checks.load(Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(3), async {
        while checks.load(Ordering::SeqCst) == before {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    tokio::task::yield_now().await;
    let at = std::time::Instant::now();
    cancel.send(true).unwrap();
    serving.await.unwrap();
    join_tasks(&state).await.unwrap();
    assert!(at.elapsed() < Duration::from_secs(2));
    assert!(state.lock().unwrap().tasks.is_empty());
}

#[tokio::test]
async fn reqwest_read_deadline_does_not_expire_while_completed_chunk_waits_on_decoder() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let send_more = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let ready = send_more.clone();
    let wait = release.clone();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            socket.read_exact(&mut byte).await.unwrap();
            request.push(byte[0]);
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\na")
            .await
            .unwrap();
        ready.notified().await;
        socket.write_all(b"b").await.unwrap();
        wait.notified().await;
    });
    let mut response = reqwest::Client::builder()
        .no_proxy()
        .read_timeout(DEADLINE)
        .build()
        .unwrap()
        .get(format!("http://{address}/verified.mp4"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        read_upstream(&mut response)
            .await
            .unwrap()
            .unwrap()
            .as_ref(),
        b"a"
    );
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(25)).await;
    tokio::time::resume();
    send_more.notify_one();
    assert_eq!(
        read_upstream(&mut response)
            .await
            .unwrap()
            .unwrap()
            .as_ref(),
        b"b"
    );
    tokio::time::pause();
    let at = Instant::now();
    assert_eq!(
        read_upstream(&mut response).await.unwrap_err(),
        "archive-proxy-read-timeout"
    );
    let elapsed = Instant::now() - at;
    assert!(elapsed >= DEADLINE && elapsed <= DEADLINE + Duration::from_millis(5));
    release.notify_one();
    server.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn request_diagnostic_privacy_and_header_body_counts_are_closed() {
    let state = state(Arc::new(|| Box::pin(async { Ok(()) })));
    {
        let mut state = state.lock().unwrap();
        state.target = Some(
            Url::parse("https://archive.org/download/private-title/private-file.mp4").unwrap(),
        );
        state.path = "/archive/private-capability/private-route.mp4".into();
        state.tail = "private-title/private-file.mp4".into();
    }
    let mut request = diagnostic_request();
    request.origin = Some("private-origin-secret".into());
    let mut diagnostic = RequestDiagnostic::new(&state, &request);
    let next = RequestDiagnostic::new(&state, &request);
    assert_eq!((diagnostic.sequence, next.sequence), (1, 2));
    let (mut writer, mut reader) = tokio::io::duplex(8);
    observed_output(&mut writer, b"head", false, &mut diagnostic)
        .await
        .unwrap();
    observed_output(&mut writer, b"body", true, &mut diagnostic)
        .await
        .unwrap();
    let mut bytes = [0; 8];
    reader.read_exact(&mut bytes).await.unwrap();
    assert_eq!(&bytes, b"headbody");
    let line = diagnostic.line(
        RequestEnd::Failed,
        Some("private-error https://secret.invalid/?password=hidden"),
        false,
    );
    assert!(line.contains("written_bytes=8 body_bytes=4"));
    assert!(line
        .contains("generation=1 request=1 method=get has_range=true range_start=12 range_end=99"));
    assert!(line.ends_with("owner_current=false failure=other"));
    for secret in [
        "private",
        "secret",
        "password",
        "hidden",
        "archive.org",
        "http",
        "/archive/",
    ] {
        assert!(!line.contains(secret), "{secret}");
    }
    assert_eq!(line.lines().count(), 1);
    assert!(line.len() < 512);
    let mut head = RequestDiagnostic::new(
        &state,
        &Request {
            head: true,
            range: None,
            options: false,
            origin: None,
        },
    );
    assert!(head
        .line(RequestEnd::Start, None, true)
        .contains("method=head has_range=false range_start=0 range_end=0"));
}

#[tokio::test(start_paused = true)]
async fn decoder_backpressure_and_disconnect_are_not_upstream_read_timeouts() {
    let (mut writer, reader) = tokio::io::duplex(1);
    let at = Instant::now();
    assert_eq!(
        write_output(&mut writer, b"ab").await.unwrap_err(),
        "archive-proxy-write-timeout"
    );
    assert_eq!(Instant::now() - at, DEADLINE);
    drop(reader);
    assert_eq!(
        write_output(&mut writer, b"c").await.unwrap_err(),
        "archive-proxy-write-failed"
    );
}

#[tokio::test]
async fn stalled_http_body_has_upstream_read_phase_after_successful_headers() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let release = Arc::new(tokio::sync::Notify::new());
    let wait = release.clone();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            socket.read_exact(&mut byte).await.unwrap();
            request.push(byte[0]);
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n")
            .await
            .unwrap();
        wait.notified().await;
    });
    let mut response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("http://{address}/verified.mp4"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    tokio::time::pause();
    let at = Instant::now();
    assert_eq!(
        read_upstream(&mut response).await.unwrap_err(),
        "archive-proxy-read-timeout"
    );
    let elapsed = Instant::now() - at;
    assert!(elapsed >= DEADLINE && elapsed <= DEADLINE + Duration::from_millis(5));
    release.notify_one();
    server.await.unwrap();
}

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
        request_sequence: 0,
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
        request_sequence: 0,
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
