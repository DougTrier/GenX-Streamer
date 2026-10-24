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
fn media_frame_carries_metadata_then_the_raw_body() {
    let mut headers = std::collections::HashMap::new();
    headers.insert("content-type".to_string(), "video/mp2t".to_string());
    let body: Vec<u8> = (0..=255u8).cycle().take(3 * 188 * 1000).collect();
    let framed = frame_media(&MediaPayload {
        status: 206,
        url: "https://example.test/seg.ts".into(),
        headers,
        data: body.clone(),
        timing: Some(MediaTiming {
            version: 1,
            first_byte_ms: 1.5,
            complete_ms: 9.0,
        }),
    })
    .unwrap();
    let length = u32::from_le_bytes(framed[..4].try_into().unwrap()) as usize;
    let meta: serde_json::Value = serde_json::from_slice(&framed[4..4 + length]).unwrap();
    assert_eq!(meta["status"], 206);
    assert_eq!(meta["url"], "https://example.test/seg.ts");
    assert_eq!(meta["headers"]["content-type"], "video/mp2t");
    assert_eq!(meta["timing"]["firstByteMs"], 1.5);
    assert!(meta.get("data").is_none());
    assert_eq!(&framed[4 + length..], &body[..]);
    // The body costs its own size, not a number per byte.
    assert!(framed.len() < body.len() + 512);
}
async fn health_fixture(reply: Vec<u8>, delay: Duration) -> (String, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/signed?token=private",
        listener.local_addr().unwrap()
    );
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let _ = stream.read(&mut request).await;
        tokio::time::sleep(delay).await;
        let _ = stream.write_all(&reply).await;
    });
    (url, task)
}
#[tokio::test]
async fn native_health_body_evidence_rejects_mislabelled_documents_but_keeps_binary_and_hls() {
    for body in [
        "<!doctype html><html>Access denied</html>",
        "\u{feff}  <HTML>Error</HTML>",
        "<?xml version=\"1.0\"?><error>Denied</error>",
        "{\"error\":\"private\"}",
        "[\"not media\"]",
    ] {
        let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        let (url, server) = health_fixture(reply.into_bytes(), Duration::ZERO).await;
        assert_eq!(
            health_inspect(&url, true, 20_000).await.unwrap().kind,
            Some("unsupported")
        );
        server.await.unwrap();
    }
    let body = b"\x00\x00\x00\x18ftypisom";
    let mut reply = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
    reply.extend_from_slice(body);
    let (url, server) = health_fixture(reply, Duration::ZERO).await;
    assert_eq!(
        health_inspect(&url, true, 20_000).await.unwrap().kind,
        Some("media")
    );
    server.await.unwrap();
    let body = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nchunk\n";
    let reply = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    let (url, server) = health_fixture(reply.into_bytes(), Duration::ZERO).await;
    assert_eq!(
        health_inspect(&url, true, 20_000).await.unwrap().kind,
        Some("hls")
    );
    server.await.unwrap();
}
#[tokio::test]
async fn partial_error_document_prefix_cannot_be_accepted_before_remaining_body_arrives() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/health", listener.local_addr().unwrap());
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 13\r\nConnection: close\r\n\r\n<")
                .await
                .unwrap();
        ready_tx.send(()).unwrap();
        release_rx.await.unwrap();
        stream.write_all(b"html></html>").await.unwrap();
    });
    let request = tokio::spawn(async move { health_inspect(&url, true, 20_000).await });
    ready_rx.await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!request.is_finished());
    release_tx.send(()).unwrap();
    assert_eq!(request.await.unwrap().unwrap().kind, Some("unsupported"));
    server.await.unwrap();
}
#[tokio::test]
async fn health_status_retry_hint_does_not_wait_for_error_body_or_fetch_twice() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/health", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        stream
                .write_all(b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 7\r\nContent-Length: 1000000\r\nConnection: keep-alive\r\n\r\n")
                .await
                .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), stream.read(&mut request))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    });
    let inspected =
        tokio::time::timeout(Duration::from_secs(1), health_inspect(&url, true, 20_000))
            .await
            .unwrap()
            .unwrap();
    assert_eq!(inspected.status, 429);
    assert_eq!(inspected.retry_after.as_deref(), Some("7"));
    assert!(inspected.kind.is_none());
    assert!(inspected.mime.is_none());
    task.await.unwrap();
    for length in [128, 129] {
        let reply = format!(
                "HTTP/1.1 503 Unavailable\r\nRetry-After: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "9".repeat(length)
            );
        let (url, server) = health_fixture(reply.into_bytes(), Duration::ZERO).await;
        let status = health_inspect(&url, true, 45_000).await.unwrap();
        assert_eq!(status.status, 503);
        assert_eq!(status.retry_after.is_some(), length == 128);
        server.await.unwrap();
    }
}
#[tokio::test]
async fn health_single_response_sniff_is_bounded_and_budget_is_explicit() {
    let(url,server)=health_fixture(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 12\r\nConnection: close\r\n\r\n\x00\x00\x00\x18ftypisom".to_vec(),Duration::ZERO).await;
    let result = health_inspect(&url, true, 60_000).await.unwrap();
    assert_eq!(result.kind, Some("media"));
    assert_eq!(result.status, 200);
    server.await.unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/catalog", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 20971521\r\nConnection: keep-alive\r\n\r\n",
            )
            .await
            .unwrap();
        let mut prefix = vec![b' '; 65_536];
        prefix[..8].copy_from_slice(b"#EXTM3U\n");
        let disconnected = |error: &std::io::Error| {
            matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::BrokenPipe
            )
        };
        if let Err(error) = stream.write_all(&prefix).await {
            assert!(
                disconnected(&error),
                "unexpected fixture write error: {error}"
            );
            return;
        }
        match tokio::time::timeout(Duration::from_secs(1), stream.read(&mut request))
            .await
            .unwrap()
        {
            Ok(count) => assert_eq!(count, 0),
            Err(error) => assert!(
                disconnected(&error),
                "unexpected fixture read error: {error}"
            ),
        }
    });
    assert_eq!(
        health_inspect(&url, true, 20_000).await.unwrap_err(),
        "playlist-too-large"
    );
    server.await.unwrap();
    for budget in [0, 1, 19_999, 20_001, 44_999, 60_001, u64::MAX] {
        assert_eq!(
            health_inspect("http://invalid", true, budget)
                .await
                .unwrap_err(),
            "invalid-health-budget"
        );
    }
    for budget in [20_000, 45_000, 60_000] {
        assert_eq!(
            health_inspect("file:///private", true, budget)
                .await
                .unwrap_err(),
            "url-policy-refused"
        );
    }
}
#[tokio::test]
async fn health_header_budget_can_be_extended_and_drop_cancels_live_request() {
    // Scale the selectable 20/45 second budgets to 200/450ms for deterministic loopback fixtures.
    for (budget, passes) in [(200, false), (450, true)] {
        let total = Duration::from_millis(budget);
        let (url, server) = health_fixture(
            b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
            Duration::from_millis(300),
        )
        .await;
        let result = health_from_response(
            response_options(&url, true, None, total, total, total, false),
            total,
        )
        .await;
        if passes {
            assert_eq!(result.unwrap().status, 503);
        } else {
            assert_eq!(result.unwrap_err(), "timeout");
        }
        server.await.unwrap();
    }
    use tokio::io::AsyncReadExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/health", listener.local_addr().unwrap());
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 4096];
        assert!(stream.read(&mut bytes).await.unwrap() > 0);
        ready_tx.send(()).unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), stream.read(&mut bytes))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    });
    let request = tokio::spawn(async move { health_inspect(&url, true, 60_000).await });
    ready_rx.await.unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    server.await.unwrap();
}
#[tokio::test]
async fn health_refuses_credentials_file_redirect_and_ungranted_http() {
    assert_eq!(
        health_inspect("http://fixture.invalid", false, 20_000)
            .await
            .unwrap_err(),
        "url-policy-refused"
    );
    assert_eq!(
        health_inspect("https://user:secret@fixture.invalid", true, 20_000)
            .await
            .unwrap_err(),
        "url-policy-refused"
    );
    let (url, server) = health_fixture(
            b"HTTP/1.1 302 Found\r\nLocation: file:///private/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
            Duration::ZERO,
        )
        .await;
    // Unsupported-scheme redirects are returned without following by reqwest.
    let refused = health_inspect(&url, true, 20_000).await.unwrap();
    assert_eq!(refused.status, 302);
    assert!(refused.kind.is_none());
    server.await.unwrap();
    let (url, server) = health_fixture(
            b"HTTP/1.1 302 Found\r\nLocation: http://user:secret@127.0.0.1:9/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_vec(),
            Duration::ZERO,
        )
        .await;
    assert_eq!(
        health_inspect(&url, true, 20_000).await.unwrap_err(),
        "redirect-refused"
    );
    server.await.unwrap();
    assert!(!validate(
        &Url::parse("http://fixture.invalid/redirect").unwrap(),
        false
    ));
}
#[test]
fn policy_requires_explicit_http_and_no_credentials() {
    assert!(validate(
        &Url::parse("https://example.org/list.m3u").unwrap(),
        false
    ));
    assert!(!validate(
        &Url::parse("http://example.org/list.m3u").unwrap(),
        false
    ));
    assert!(validate(
        &Url::parse("http://example.org/list.m3u").unwrap(),
        true
    ));
    assert!(!validate(
        &Url::parse("https://user:secret@example.org/").unwrap(),
        true
    ));
    assert!(!validate(&Url::parse("file:///etc/passwd").unwrap(), true));
}

/// The DNS cache keeps answers five minutes, failures ten seconds, and
/// starts over rather than grow past its limit.
#[test]
fn dns_cache_remembers_answers_longer_than_failures_and_stays_bounded() {
    let mut cache = DnsCache {
        entries: Default::default(),
    };
    let t = std::time::Instant::now();
    let address: std::net::SocketAddr = "192.0.2.1:0".parse().unwrap();
    cache.put("Example.Test", t, Some(vec![address]));
    cache.put("gone.test", t, None);
    assert_eq!(cache.get("example.test", t), Some(Some(vec![address])));
    assert_eq!(cache.get("gone.test", t), Some(None));
    let later = t + Duration::from_secs(11);
    assert_eq!(cache.get("gone.test", later), None);
    assert_eq!(cache.get("example.test", later), Some(Some(vec![address])));
    assert_eq!(cache.get("example.test", t + DNS_TTL), None);
    for i in 0..DNS_CACHE_LIMIT {
        cache.put(&format!("h{i}.test"), t, None);
    }
    cache.put("one-more.test", t, None);
    assert_eq!(cache.entries.len(), 1);
}

fn fixture(reply: &'static [u8]) -> (String, std::thread::JoinHandle<()>) {
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/playlist", listener.local_addr().unwrap());
    let thread = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut buffer = [0u8; 4096];
        let _ = stream.read(&mut buffer).unwrap();
        stream.write_all(reply).unwrap();
    });
    (url, thread)
}

#[tokio::test(flavor = "current_thread")]
async fn real_http_body_status_and_size_policy() {
    let (url, thread) =
        fixture(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n#EXTM3U\n");
    assert_eq!(fetch(&url, true).await.unwrap(), "#EXTM3U\n");
    thread.join().unwrap();
    let (url, thread) =
        fixture(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    assert_eq!(fetch(&url, true).await.unwrap_err(), "http-403");
    thread.join().unwrap();
    let (url, thread) =
        fixture(b"HTTP/1.1 200 OK\r\nContent-Length: 20971521\r\nConnection: close\r\n\r\n");
    assert_eq!(fetch(&url, true).await.unwrap_err(), "playlist-too-large");
    thread.join().unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn denied_redirect_never_follows_file_scheme() {
    let (url, thread) =
            fixture(b"HTTP/1.1 302 Found\r\nLocation: file:///private/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    assert!(fetch(&url, true).await.is_err());
    thread.join().unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn source_probe_classifies_content_without_extension_and_stops_media_body() {
    let (url, thread) = fixture(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 12\r\nConnection: close\r\n\r\n\x00\x00\x00\x18ftypisom");
    let inspection = inspect(&url, true).await.unwrap();
    assert_eq!(inspection.kind, "media");
    assert!(inspection.text.is_none());
    thread.join().unwrap();
    let body = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nchunk.ts\n";
    let reply: &'static [u8] = Box::leak(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
        .into_boxed_slice(),
    );
    let (url, thread) = fixture(reply);
    let inspection = inspect(&url, true).await.unwrap();
    assert_eq!(inspection.kind, "hls");
    assert_eq!(inspection.text.unwrap(), body);
    thread.join().unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn media_keeps_http_status_retry_hint_ranges_and_binary_bytes() {
    let (url, thread) = fixture(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\nContent-Type: video/mp2t\r\nContent-Range: bytes 0-3/100\r\nConnection: close\r\n\r\n\x47\x00\xff\x01");
    let payload = media(&url, true, Some("bytes=0-3".into())).await.unwrap();
    assert_eq!(payload.status, 206);
    assert_eq!(payload.headers["content-range"], "bytes 0-3/100");
    assert_eq!(payload.data, vec![0x47, 0x00, 0xff, 0x01]);
    thread.join().unwrap();
    let (url, thread) = fixture(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nRetry-After: 5\r\nSet-Cookie: secret=private\r\nConnection: close\r\n\r\n");
    let payload = media(&url, true, None).await.unwrap();
    assert_eq!(payload.status, 503);
    assert_eq!(payload.headers["retry-after"], "5");
    assert!(!payload.headers.contains_key("set-cookie"));
    thread.join().unwrap();
    let (url, thread) =
        fixture(b"HTTP/1.1 200 OK\r\nContent-Length: 8388609\r\nConnection: close\r\n\r\n");
    let error = media(&url, true, None).await.err().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&error).unwrap(),
        serde_json::json!({"category":"media-too-large","phase":"headers"})
    );
    thread.join().unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn media_timing_observes_first_chunk_before_delayed_completion() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/media", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\na")
            .await
            .unwrap();
        stream.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        stream.write_all(b"bcd").await.unwrap();
    });
    let payload = media(&url, true, None).await.unwrap();
    task.await.unwrap();
    assert_eq!(payload.data, b"abcd");
    let timing = payload.timing.as_ref().unwrap();
    assert_eq!(timing.version, 1);
    assert!(timing.first_byte_ms.is_finite() && timing.first_byte_ms >= 0.0);
    assert!(timing.complete_ms - timing.first_byte_ms >= 150.0);
    let json = serde_json::to_value(&payload).unwrap();
    assert_eq!(json["timing"]["version"], 1);
    assert!(json["timing"]["firstByteMs"].is_number());
    assert!(json["timing"]["completeMs"].is_number());
}

#[tokio::test(flavor = "current_thread")]
async fn media_timing_empty_and_unread_error_body_use_headers_fallback() {
    for reply in [
            &b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"[..],
            &b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 8\r\nRetry-After: 1\r\nConnection: close\r\n\r\nunread!!"[..],
        ] {
            let (url, thread) = fixture(reply);
            let payload = media(&url, true, None).await.unwrap();
            thread.join().unwrap();
            assert!(payload.data.is_empty());
            let timing = payload.timing.unwrap();
            assert_eq!(timing.version, 1);
            assert!(timing.first_byte_ms >= 0.0 && timing.first_byte_ms <= timing.complete_ms);
            assert!(timing.complete_ms.is_finite());
        }
}

fn envelope(error: String) -> serde_json::Value {
    assert!(!error.contains("private") && !error.contains("signed") && error.len() <= 1024);
    serde_json::from_str(&error).unwrap()
}
#[tokio::test]
async fn playback_closed_tcp_is_connect_and_http_retry_headers_are_bounded() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let error = inspect_playback(&format!("http://{address}/signed?token=private"), true)
        .await
        .err()
        .unwrap();
    assert_eq!(
        envelope(error),
        serde_json::json!({"category":"connectivity-failure","phase":"connect"})
    );
    let (url, server) = health_fixture(
        b"HTTP/1.1 429 Busy\r\nRetry-After: 7\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_vec(),
        Duration::ZERO,
    )
    .await;
    let error = inspect_playback(&url, true).await.err().unwrap();
    assert_eq!(
        envelope(error),
        serde_json::json!({"category":"http","phase":"headers","status":429,"retryAfter":"7"})
    );
    server.await.unwrap();
    let reply = format!(
        "HTTP/1.1 503 Busy\r\nRetry-After: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "9".repeat(129)
    );
    let (url, server) = health_fixture(reply.into_bytes(), Duration::ZERO).await;
    assert_eq!(
        envelope(inspect_playback(&url, true).await.err().unwrap()),
        serde_json::json!({"category":"http","phase":"headers","status":503})
    );
    server.await.unwrap();
}
#[tokio::test]
async fn playback_delayed_headers_remain_unknown_but_observed_body_timeout_is_body() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let duration = Duration::from_millis(80);
    let (url, server) = health_fixture(
        b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        Duration::from_millis(250),
    )
    .await;
    let error = response_options(
        &url,
        true,
        None,
        Duration::from_secs(1),
        duration,
        duration,
        true,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(
        envelope(error),
        serde_json::json!({"category":"timeout","phase":"unknown"})
    );
    server.await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/signed?token=private",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let amount = stream.read(&mut request).await.unwrap();
        assert!(amount > 0);
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: 100\r\nConnection: close\r\n\r\n#EXTM3U\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
    });
    let response = response_options(
        &url,
        true,
        None,
        Duration::from_secs(1),
        duration,
        duration,
        true,
    )
    .await
    .unwrap();
    assert_eq!(
        envelope(inspect_response_mode(response, true).await.err().unwrap()),
        serde_json::json!({"category":"timeout","phase":"body"})
    );
    server.await.unwrap();
}
#[tokio::test]
async fn playback_invalid_tls_certificate_has_typed_tls_failure_without_trust_bypass() {
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    let config = rustls::ServerConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![
            CertificateDer::from(include_bytes!("lan/fixtures/loopback-cert.der").to_vec()),
            CertificateDer::from(include_bytes!("lan/fixtures/loopback-root.der").to_vec()),
        ],
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            include_bytes!("lan/fixtures/loopback-key.der").to_vec(),
        )),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "https://{}/signed?token=private",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(config));
        let result = tokio::time::timeout(Duration::from_secs(2), acceptor.accept(stream))
            .await
            .unwrap();
        assert!(result.is_err());
    });
    let error = inspect_playback(&url, false).await.err().unwrap();
    assert_eq!(
        envelope(error),
        serde_json::json!({"category":"tls-failure","phase":"connect"})
    );
    server.await.unwrap();
}
#[test]
fn opaque_error_words_never_become_dns_or_tls_and_legacy_policy_is_unchanged() {
    let opaque = std::io::Error::other("DNS TLS certificate private signed");
    assert_eq!(known_cause(&opaque), None);
    #[cfg(windows)]
    for code in 11001..=11004 {
        assert_eq!(
            known_cause(&std::io::Error::from_raw_os_error(code)),
            Some("dns-failure")
        );
    }
    assert_eq!(
        failure("url-policy-refused", "unknown", false),
        "url-policy-refused"
    );
    assert_eq!(
        envelope(failure("url-policy-refused", "unknown", true)),
        serde_json::json!({"category":"url-policy-refused","phase":"unknown"})
    );
}

#[test]
fn typed_dns_tls_causes_are_static_even_when_their_payload_contains_private_text() {
    let dns = std::io::Error::other(DnsFailure);
    let tls = std::io::Error::other(rustls::Error::General(
        "https://private.invalid/?token=secret".into(),
    ));
    assert_eq!(known_cause(&dns), Some("dns-failure"));
    assert_eq!(known_cause(&tls), Some("tls-failure"));
    let unknown = std::io::Error::other("dns-failure tls-failure token=secret");
    assert_eq!(known_cause(&unknown), None);
}
#[cfg(windows)]
#[tokio::test]
#[ignore = "Explicit installed-system DNS proof; deterministic CI uses typed cause fixtures."]
async fn actual_windows_dns_negative_response_has_typed_failure() {
    let client = reqwest::Client::builder()
        .no_proxy()
        .dns_resolver(std::sync::Arc::new(PlatformResolver))
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let error = client
        .get("https://does-not-exist.genx-fixture.invalid/signed?token=private")
        .send()
        .await
        .err()
        .unwrap();
    assert_eq!(
        envelope(request_failure(error, "unknown", true)),
        serde_json::json!({"category":"dns-failure","phase":"connect"})
    );
}

#[tokio::test]
async fn owned_resolver_failure_marker_survives_request_chain_without_os_text() {
    struct FixtureResolver(std::sync::atomic::AtomicUsize);
    impl reqwest::dns::Resolve for FixtureResolver {
        fn resolve(&self, _name: reqwest::dns::Name) -> reqwest::dns::Resolving {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async {
                Err(Box::new(DnsFailure) as Box<dyn std::error::Error + Send + Sync>)
            })
        }
    }
    let resolver = std::sync::Arc::new(FixtureResolver(std::sync::atomic::AtomicUsize::new(0)));
    let client = reqwest::Client::builder()
        .no_proxy()
        .dns_resolver(resolver.clone())
        .build()
        .unwrap();
    let error = client
        .get("https://genx-fixture.invalid/signed?token=private")
        .send()
        .await
        .err()
        .unwrap();
    assert_eq!(error_category(&error), "dns-failure");
    assert_eq!(
        envelope(request_failure(error, "unknown", true)),
        serde_json::json!({"category":"dns-failure","phase":"connect"})
    );
    assert_eq!(resolver.0.load(std::sync::atomic::Ordering::SeqCst), 1);
}
