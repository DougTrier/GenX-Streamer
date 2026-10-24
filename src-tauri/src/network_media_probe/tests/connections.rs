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

//! Network media probe tests: triage, connection reuse and quality order.

use super::*;

/// Scan triage: a server whose first answer comes after the first-response
/// limit ends the check as "slow-first-response"; the same server passes an
/// untriaged check (the Slow pass), and a prompt first answer is unaffected.
#[tokio::test]
async fn triage_ends_a_late_first_answer_and_the_full_check_still_passes_it() {
    for (delay_ms, triage, expected) in [
        (1_600, Some(1_000), "slow-first-response"),
        (1_600, None, "media-resources-responded"),
        (0, Some(1_000), "media-resources-responded"),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        // Accepts every connection: a triaged check first opens a bare one
        // (the connect gate), which sends nothing.
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut request = [0; 4096];
                    if socket.read(&mut request).await.unwrap_or(0) == 0 {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    let body = ts();
                    // The triaged client may have gone; a failed write is expected then.
                    let _ = socket
                        .write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes())
                        .await;
                    let _ = socket.write_all(&body).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        let started = std::time::Instant::now();
        let receipt = inspect_triaged(
            &format!("http://{address}/live.ts"),
            true,
            "owned".into(),
            20_000,
            triage,
        )
        .await
        .unwrap();
        assert_eq!(
            receipt.reason_code, expected,
            "delay {delay_ms} triage {triage:?}"
        );
        if expected == "slow-first-response" {
            assert_eq!(receipt.status, "unavailable");
            assert!(started.elapsed() < Duration::from_millis(1_500));
        }
        server.abort();
    }
}

#[tokio::test]
async fn triage_limit_must_fit_the_budget() {
    for first in [Some(999), Some(20_001)] {
        assert_eq!(
            inspect_triaged(
                "http://127.0.0.1:9/x.ts",
                true,
                "owned".into(),
                20_000,
                first
            )
            .await
            .unwrap_err(),
            "invalid-health-budget"
        );
    }
}

/// Connection reuse (owner request, October 21, 2026): a check's requests to
/// one site share a connection, so a playlist and its segment cost one
/// connection (and on HTTPS one TLS handshake), not two. Untriaged, so the
/// connect gate's own bare connection is not part of the count.
#[tokio::test]
async fn a_check_reuses_one_connection_for_its_requests_to_a_site() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let connections = Arc::new(AtomicUsize::new(0));
    let requests = Arc::new(AtomicUsize::new(0));
    let (seen_connections, seen_requests) = (connections.clone(), requests.clone());
    let server = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            seen_connections.fetch_add(1, Ordering::SeqCst);
            let seen_requests = seen_requests.clone();
            tokio::spawn(async move {
                let mut buffer = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let n = match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => n,
                    };
                    buffer.extend_from_slice(&chunk[..n]);
                    while let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buffer[..end]).to_string();
                        buffer.drain(..end + 4);
                        seen_requests.fetch_add(1, Ordering::SeqCst);
                        let body = if head.starts_with("GET /live.m3u8") {
                            media("seg.ts")
                        } else {
                            ts()
                        };
                        let reply =
                            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
                        if socket.write_all(reply.as_bytes()).await.is_err()
                            || socket.write_all(&body).await.is_err()
                        {
                            return;
                        }
                    }
                }
            });
        }
    });
    let receipt = inspect_triaged(
        &format!("http://{address}/live.m3u8"),
        true,
        "owned".into(),
        20_000,
        None,
    )
    .await
    .unwrap();
    assert_eq!(receipt.status, "resources-responded");
    assert_eq!(requests.load(Ordering::SeqCst), 2, "playlist and segment");
    assert_eq!(
        connections.load(Ordering::SeqCst),
        1,
        "one connection for both"
    );
    server.abort();
}

/// The connect gate (owner design, October 21, 2026): the server only has to
/// accept a plain connection; nothing is sent on it (no TLS, no request).
#[tokio::test]
async fn connect_gate_opens_a_bare_connection_and_sends_nothing() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        socket.read_to_end(&mut bytes).await.unwrap();
        bytes.len()
    });
    let url = Url::parse(&format!("https://{address}/live.m3u8")).unwrap();
    crate::network::connect_gate(&url, Duration::from_secs(1))
        .await
        .unwrap();
    assert_eq!(server.await.unwrap(), 0, "no TLS hello or request was sent");
}

/// A server that does not accept a connection within the gate goes to the
/// Slow list after about a second, not after the 3-second answer limit.
#[tokio::test]
async fn a_host_that_does_not_connect_within_a_second_is_let_go() {
    // TEST-NET-1 (RFC 5737): never routed; it either hangs or is refused.
    let started = std::time::Instant::now();
    let receipt = inspect_triaged(
        "http://192.0.2.1/live.m3u8",
        true,
        "owned".into(),
        20_000,
        Some(3_000),
    )
    .await
    .unwrap();
    assert!(
        ["slow-first-response", "connectivity-failure"].contains(&receipt.reason_code),
        "{}",
        receipt.reason_code
    );
    assert!(started.elapsed() < Duration::from_millis(1_800));
    assert_eq!(receipt.checked_resources, 0);
}

/// Qualities with no CODECS label (owner decision, October 21, 2026): HLS
/// allows leaving it out, and 174 of 1,095 Sansui scan candidates did. They
/// are tried after any labelled H.264/AAC quality; other labels stay refused.
#[test]
fn unlabelled_qualities_are_tried_after_labelled_h264_and_other_labels_refused() {
    let base = Url::parse("https://example.test/").unwrap();
    let only_unlabelled = parse(
        &base,
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900\nlow\n#EXT-X-STREAM-INF:BANDWIDTH=5000\nhigh\n",
    )
    .unwrap();
    assert_eq!(only_unlabelled.variant.unwrap().path(), "/low");
    let mixed = parse(
        &base,
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nunlabelled\n#EXT-X-STREAM-INF:BANDWIDTH=9000,CODECS=\"avc1.64001f,mp4a.40.2\"\nlabelled\n",
    )
    .unwrap();
    assert_eq!(mixed.variant.unwrap().path(), "/labelled");
    let beside_hevc = parse(
        &base,
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS=\"hvc1.1.6.L93.B0\"\nhevc\n#EXT-X-STREAM-INF:BANDWIDTH=900\nunlabelled\n",
    )
    .unwrap();
    assert_eq!(beside_hevc.variant.unwrap().path(), "/unlabelled");
    for refused in [
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"hvc1.1.6.L93.B0\"\nv\n",
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"avc1.64001f,ac-3\"\nv\n",
    ] {
        assert!(parse(&base, refused).is_err());
    }
}

/// An unlabelled quality is saved only if its video bytes are real media.
#[tokio::test]
async fn an_unlabelled_quality_must_still_deliver_recognized_media() {
    for (segment, expected) in [
        (ts(), "media-resources-responded"),
        (
            b"<html><body>Not here</body></html>".to_vec(),
            "resource-error-document",
        ),
        (
            b"\x89PNG\r\n\x1a\n not video".to_vec(),
            "media-format-unverified",
        ),
    ] {
        let f = fixture(HashMap::from([
            (
                "/root".into(),
                (
                    200,
                    b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900\nvideo\n".to_vec(),
                    None,
                ),
            ),
            ("/video".into(), (200, media("segment"), None)),
            ("/segment".into(), (200, segment, None)),
        ]))
        .await;
        let r = inspect(
            f.base.join("root").unwrap().as_str(),
            true,
            "owned".into(),
            20_000,
        )
        .await
        .unwrap();
        assert_eq!(r.reason_code, expected);
    }
}
