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
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

fn fresh_probe() -> Probe {
    Probe {
        count: 0,
        budget: 20_000,
        allow_http: true,
        visited: HashSet::new(),
        retry_after: None,
        header_retry_claimed: false,
        header_retry_count: 0,
        first_response: None,
        client: None,
    }
}

#[tokio::test]
async fn one_pre_response_close_retry_responds_or_preserves_final_failure() {
    for healthy in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requests = 0;
            for index in 0..2 {
                let (mut socket, _) =
                    tokio::time::timeout(Duration::from_secs(2), listener.accept())
                        .await
                        .unwrap()
                        .unwrap();
                let mut request = [0; 4096];
                assert!(socket.read(&mut request).await.unwrap() > 0);
                requests += 1;
                if index == 1 && healthy {
                    let body = ts();
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
                    socket.write_all(&body).await.unwrap();
                }
                socket.shutdown().await.unwrap();
            }
            requests
        });
        let receipt = inspect(
            &format!("http://{address}/secret?token=private"),
            true,
            "owned".into(),
            20_000,
        )
        .await
        .unwrap();
        assert_eq!(server.await.unwrap(), 2);
        assert_eq!(receipt.checked_resources, 2);
        assert_eq!(receipt.header_retry_count, 1);
        assert_eq!(receipt.header_retry_reason, Some("network-failure"));
        assert_eq!(
            receipt.status,
            if healthy {
                "resources-responded"
            } else {
                "unavailable"
            }
        );
        assert_eq!(
            receipt.reason_code,
            if healthy {
                "media-resources-responded"
            } else {
                "network-failure"
            }
        );
        assert!(receipt.http_status.is_none());
        let json = serde_json::to_string(&receipt).unwrap();
        assert!(!json.contains("private") && !json.contains("secret"));
    }
}

#[test]
fn header_retry_requires_exact_original_error_once_and_preserves_cap_boundary() {
    for code in [
        "timeout",
        "dns-failure",
        "tls-failure",
        "connectivity-failure",
        "redirect-refused",
        "url-policy-refused",
        "invalid-url",
        "private arbitrary error",
    ] {
        let mut probe = fresh_probe();
        probe.count = 1;
        assert!(!probe.claim_header_retry(code));
        assert!(!probe.header_retry_claimed);
        assert_eq!(probe.header_retry_count, 0);
    }
    let mut probe = fresh_probe();
    probe.count = 7;
    assert!(probe.claim_header_retry("network-failure"));
    assert!(!probe.claim_header_retry("network-failure"));
    assert_eq!(probe.header_retry_count, 0); // claim is not a dispatch receipt
    let mut full = fresh_probe();
    full.count = 8;
    assert!(!full.claim_header_retry("network-failure"));
    assert_eq!(transport_reason("network-failure"), "network-failure");
}

#[tokio::test]
async fn successful_retry_is_not_repeated_for_a_later_resource_in_same_probe() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for index in 0..3 {
            let (mut socket, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            if index == 1 {
                let body = ts();
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                socket.write_all(&body).await.unwrap();
            }
            socket.shutdown().await.unwrap();
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(250), listener.accept())
                .await
                .is_err()
        );
    });
    let mut probe = fresh_probe();
    let resource = Resource {
        url: Url::parse(&format!("http://{address}/root")).unwrap(),
        range: None,
    };
    probe.read(&resource, MANIFEST, true).await.unwrap();
    let later = Resource {
        url: Url::parse(&format!("http://{address}/later")).unwrap(),
        range: None,
    };
    assert_eq!(
        probe.read(&later, MANIFEST, true).await.unwrap_err().0,
        "network-failure"
    );
    assert_eq!(probe.count, 3);
    assert_eq!(probe.header_retry_count, 1);
    server.await.unwrap();
}

#[tokio::test]
async fn header_retry_cap_refuses_second_fetch_without_changing_original_reason() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        socket.shutdown().await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(250), listener.accept())
                .await
                .is_err()
        );
    });
    let mut probe = fresh_probe();
    probe.count = 7;
    let resource = Resource {
        url: Url::parse(&format!("http://{address}/root")).unwrap(),
        range: None,
    };
    let failure = probe.read(&resource, MANIFEST, true).await.unwrap_err();
    assert_eq!(failure.0, "network-failure");
    assert_eq!(probe.count, 8);
    assert_eq!(probe.header_retry_count, 0);
    assert!(!probe.header_retry_claimed);
    server.await.unwrap();
}

#[tokio::test]
async fn deadline_and_cancel_drop_owned_retry_delay_without_dispatch_or_metadata() {
    let mut timed = fresh_probe();
    timed.count = 1;
    assert!(timed.claim_header_retry("network-failure"));
    assert!(
        tokio::time::timeout(Duration::from_millis(10), timed.wait_header_retry())
            .await
            .is_err()
    );
    assert_eq!(timed.count, 1);
    assert_eq!(timed.header_retry_count, 0);
    let mut canceled = fresh_probe();
    canceled.count = 1;
    assert!(canceled.claim_header_retry("network-failure"));
    let (send, receiver) = tokio::sync::oneshot::channel();
    let mut pending = Box::pin(canceled.wait_header_retry());
    // Poll the real owned sleep before cancellation; then destroy it at settlement.
    tokio::select! { biased; _=&mut pending=>panic!("retry delay completed before cancellation"), _=tokio::task::yield_now()=>{} }
    send.send(()).unwrap();
    // Same select/drop ownership as inspect_media_resources; no detached retry task.
    tokio::select! { biased; _=receiver=>{}, _=&mut pending=>panic!("canceled retry delay completed") }
    drop(pending);
    assert_eq!(canceled.count, 1);
    assert_eq!(canceled.header_retry_count, 0);
    let mut healthy = fixture(HashMap::from([("/peer".into(), (200, ts(), None))])).await;
    let receipt = inspect(
        healthy.base.join("peer").unwrap().as_str(),
        true,
        "peer".into(),
        20_000,
    )
    .await
    .unwrap();
    assert_eq!(receipt.status, "resources-responded");
    assert_eq!(receipt.checked_resources, 1);
    let json = serde_json::to_value(&receipt).unwrap();
    assert!(json.get("headerRetryCount").is_none() && json.get("headerRetryReason").is_none());
    healthy.task.abort();
    assert!((&mut healthy.task).await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn hard_http_refusal_does_not_claim_header_retry() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        socket
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        socket.shutdown().await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(250), listener.accept())
                .await
                .is_err()
        );
    });
    let receipt = inspect(
        &format!("http://{address}/root"),
        true,
        "http".into(),
        20_000,
    )
    .await
    .unwrap();
    assert_eq!(receipt.reason_code, "resource-http-unavailable");
    assert_eq!(receipt.http_status, Some(404));
    assert_eq!(receipt.checked_resources, 1);
    assert_eq!(receipt.header_retry_count, 0);
    assert!(receipt.header_retry_reason.is_none());
    server.await.unwrap();
}

#[test]
fn transport_reason_accepts_only_fixed_categories_and_discards_secret_error_text() {
    for code in [
        "timeout",
        "dns-failure",
        "tls-failure",
        "connectivity-failure",
        "redirect-refused",
        "url-policy-refused",
        "invalid-url",
    ] {
        assert_eq!(transport_reason(code), code);
    }
    for opaque in [
        "https://private.invalid/?token=secret",
        "DNS TLS private-password",
        "network-unavailable",
        "{\"category\":\"dns-failure\",\"url\":\"secret\"}",
    ] {
        assert_eq!(transport_reason(opaque), "network-failure");
    }
}

#[tokio::test]
async fn refused_connection_preserves_fixed_transport_category_without_http_status() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let receipt = inspect(
        &format!("http://{address}/signed?token=secret"),
        true,
        "owned".into(),
        20_000,
    )
    .await
    .unwrap();
    assert_eq!(receipt.status, "unavailable");
    assert_eq!(receipt.reason_code, "connectivity-failure");
    assert_eq!(receipt.http_status, None);
    assert_eq!(receipt.checked_resources, 1);
    assert_eq!(receipt.header_retry_count, 0);
    assert!(receipt.header_retry_reason.is_none());
    let json = serde_json::to_string(&receipt).unwrap();
    assert!(!json.contains("secret"));
    assert!(!json.contains("signed"));
}

#[tokio::test]
async fn truncated_response_body_preserves_failure_category_and_observed_status() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 4096];
        assert!(socket.read(&mut bytes).await.unwrap() > 0);
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 1024\r\nConnection: close\r\n\r\n#EXTM3U\n",
            )
            .await
            .unwrap();
        socket.shutdown().await.unwrap();
    });
    let receipt = inspect(
        &format!("http://{address}/secret"),
        true,
        "owned".into(),
        20_000,
    )
    .await
    .unwrap();
    assert_eq!(receipt.status, "unavailable");
    assert_eq!(receipt.reason_code, "network-failure");
    assert_eq!(receipt.http_status, Some(200));
    assert_eq!(receipt.checked_resources, 1);
    assert_eq!(receipt.header_retry_count, 0);
    assert!(receipt.header_retry_reason.is_none());
    server.await.unwrap();
}

#[tokio::test]
async fn short_controlled_body_timeout_uses_typed_timeout_category_without_long_probe_wait() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (ready, headers) = tokio::sync::oneshot::channel();
    let (release, hold) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 4096];
        assert!(socket.read(&mut bytes).await.unwrap() > 0);
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1024\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        ready.send(()).unwrap();
        hold.await.unwrap();
    });
    let client = reqwest::Client::builder()
        .no_proxy()
        .read_timeout(Duration::from_millis(500))
        .build()
        .unwrap();
    let mut response = client
        .get(format!("http://{address}/secret"))
        .send()
        .await
        .unwrap();
    headers.await.unwrap();
    let error = response.chunk().await.unwrap_err();
    assert!(error.is_timeout());
    let refusal = body_refusal(error, response.status().as_u16());
    assert_eq!(refusal.0, "timeout");
    assert_eq!(refusal.1, Some(200));
    release.send(()).unwrap();
    server.await.unwrap();
}
struct Fixture {
    base: Url,
    task: tokio::task::JoinHandle<()>,
    count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn fixture(routes: HashMap<String, (u16, Vec<u8>, Option<String>)>) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = count.clone();
    let task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut bytes = vec![0; 8192];
            let n = socket.read(&mut bytes).await.unwrap_or(0);
            let raw = String::from_utf8_lossy(&bytes[..n]);
            let path = raw
                .lines()
                .next()
                .and_then(|l| l.split_whitespace().nth(1))
                .unwrap_or("");
            observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let (status, body, range) =
                routes.get(path).cloned().unwrap_or((404, Vec::new(), None));
            let mut header = format!(
                "HTTP/1.1 {status} response\r\nContent-Length: {}\r\nConnection: close\r\n",
                body.len()
            );
            if let Some(range) = range {
                header.push_str(&format!("Content-Range: {range}\r\n"));
            }
            header.push_str("\r\n");
            let _ = socket.write_all(header.as_bytes()).await;
            let _ = socket.write_all(&body).await;
        }
    });
    Fixture { base, task, count }
}
fn ts() -> Vec<u8> {
    let mut b = vec![0; 564];
    for i in [0, 188, 376] {
        b[i] = 0x47;
    }
    b
}
fn media(uri: &str) -> Vec<u8> {
    format!("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n{uri}\n").into_bytes()
}
#[tokio::test]
async fn recognized_root_does_not_hide_segment_http_or_html_error_and_latest_complete_is_checked() {
    for (status, body, reason) in [
        (404, Vec::new(), "resource-http-unavailable"),
        (
            200,
            b"<html>error</html>".to_vec(),
            "resource-error-document",
        ),
        (200, ts(), "media-resources-responded"),
    ] {
        let f = fixture(HashMap::from([
            ("/root".into(), (200, media("latest"), None)),
            ("/latest".into(), (status, body, None)),
        ]))
        .await;
        let r = inspect(
            f.base.join("root").unwrap().as_str(),
            true,
            "r".into(),
            20_000,
        )
        .await
        .unwrap();
        assert_eq!(r.reason_code, reason);
        assert_eq!(r.checked_resources, 2);
        assert_eq!(f.count.load(std::sync::atomic::Ordering::SeqCst), 2);
    }
}
#[tokio::test]
async fn master_relative_variant_init_map_range_and_audio_are_real_requests() {
    let root=b"#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"audio\"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS=\"avc1.64001f,mp4a.40.2\",AUDIO=\"a\"\nvideo\n".to_vec();
    let video =
        b"#EXTM3U\n#EXT-X-MAP:URI=\"map\"\n#EXT-X-BYTERANGE:8@8\n#EXTINF:2,\nsegment\n".to_vec();
    let f = fixture(HashMap::from([
        ("/root".into(), (200, root, None)),
        ("/video".into(), (200, video, None)),
        ("/map".into(), (200, b"\0\0\0\x08ftyp".to_vec(), None)),
        (
            "/segment".into(),
            (
                206,
                b"\0\0\0\x08moof".to_vec(),
                Some("bytes 8-15/16".into()),
            ),
        ),
        ("/audio".into(), (200, media("aac"), None)),
        ("/aac".into(), (200, vec![0xff, 0xf1, 0, 0], None)),
    ]))
    .await;
    let r = inspect(
        f.base.join("root").unwrap().as_str(),
        true,
        "r".into(),
        20_000,
    )
    .await
    .unwrap();
    assert_eq!(r.status, "resources-responded");
    assert_eq!(r.checked_resources, 6);
}
#[tokio::test]
async fn encrypted_resources_require_exact_key_without_claiming_decoded_bytes() {
    for length in [15, 16, 17] {
        let text =
            b"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXTINF:2,\nsegment\n".to_vec();
        let f = fixture(HashMap::from([
            ("/root".into(), (200, text, None)),
            ("/key".into(), (200, vec![b'<'; length], None)),
            ("/segment".into(), (200, vec![1; 32], None)),
        ]))
        .await;
        let r = inspect(
            f.base.join("root").unwrap().as_str(),
            true,
            "r".into(),
            20_000,
        )
        .await
        .unwrap();
        if length == 16 {
            assert_eq!(r.reason_code, "encrypted-resources-responded");
        } else {
            assert_eq!(r.status, "unavailable");
        }
    }
}
#[tokio::test]
async fn unsupported_drm_and_master_cycle_never_request_media_and_no_http_override() {
    let f = fixture(HashMap::from([
        (
            "/drm".into(),
            (
                200,
                b"#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"key\"\n#EXTINF:2,\nsegment\n"
                    .to_vec(),
                None,
            ),
        ),
        (
            "/cycle".into(),
            (
                200,
                b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"avc1.64001f\"\ncycle\n".to_vec(),
                None,
            ),
        ),
    ]))
    .await;
    assert_eq!(
        inspect(
            f.base.join("drm").unwrap().as_str(),
            true,
            "r".into(),
            20_000
        )
        .await
        .unwrap()
        .reason_code,
        "drm-unverified"
    );
    assert_eq!(
        inspect(
            f.base.join("cycle").unwrap().as_str(),
            true,
            "r".into(),
            20_000
        )
        .await
        .unwrap()
        .reason_code,
        "manifest-cycle-unverified"
    );
    let before = f.count.load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        inspect(
            f.base.join("cycle").unwrap().as_str(),
            false,
            "r".into(),
            20_000
        )
        .await
        .unwrap()
        .status,
        "unavailable"
    );
    assert_eq!(f.count.load(std::sync::atomic::Ordering::SeqCst), before);
}
#[test]
fn parser_implicit_range_requires_same_resource_and_unsupported_codecs_do_not_guess() {
    let base = Url::parse("https://example.test/").unwrap();
    let p = parse(
        &base,
        "#EXTM3U\n#EXT-X-BYTERANGE:8@0\n#EXTINF:2,\nsame\n#EXT-X-BYTERANGE:8\n#EXTINF:2,\nsame\n",
    )
    .unwrap();
    assert_eq!(p.segment.unwrap().resource.range, Some((8, 15)));
    assert!(parse(&base, "#EXTM3U\n#EXT-X-BYTERANGE:8\n#EXTINF:2,\nother\n").is_err());
    assert!(parse(
        &base,
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"hev1.test\"\nv\n"
    )
    .is_err());
}

#[tokio::test]
async fn abandoned_held_segment_closes_actual_upstream_after_future_settlement() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let (ready_tx, ready) = tokio::sync::oneshot::channel();
    let (closed_tx, closed) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut root, _) = listener.accept().await.unwrap();
        let mut request = [0; 1024];
        assert!(root.read(&mut request).await.unwrap() > 0);
        let body = media("segment");
        root.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
        root.write_all(&body).await.unwrap();
        drop(root);
        let (mut segment, _) = listener.accept().await.unwrap();
        assert!(segment.read(&mut request).await.unwrap() > 0);
        segment
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 564\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        ready_tx.send(()).unwrap();
        let n = segment.read(&mut request).await.unwrap();
        assert_eq!(n, 0);
        closed_tx.send(()).unwrap();
    });
    let operation = tokio::spawn(async move { inspect(&url, true, "cancel".into(), 20_000).await });
    tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    operation.abort();
    assert!(operation.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(2), closed)
        .await
        .unwrap()
        .unwrap();
    server.await.unwrap();
}
#[tokio::test]
async fn rate_limit_is_one_request_with_safe_retry_after_and_invalid_ranges_refuse() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 1024];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        socket.write_all(b"HTTP/1.1 429 Busy\r\nRetry-After: 60\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
    });
    let r = inspect(&url, true, "r".into(), 20_000).await.unwrap();
    assert_eq!(r.http_status, Some(429));
    assert_eq!(r.retry_after.as_deref(), Some("60"));
    assert_eq!(r.checked_resources, 1);
    server.await.unwrap();
    let f = fixture(HashMap::from([
        (
            "/root".into(),
            (
                200,
                b"#EXTM3U\n#EXT-X-BYTERANGE:8@0\n#EXTINF:2,\nsegment\n".to_vec(),
                None,
            ),
        ),
        ("/segment".into(), (200, b"\0\0\0\x08moof".to_vec(), None)),
    ]))
    .await;
    assert_eq!(
        inspect(
            f.base.join("root").unwrap().as_str(),
            true,
            "r".into(),
            20_000
        )
        .await
        .unwrap()
        .reason_code,
        "range-unavailable"
    );
}
#[tokio::test]
async fn request_ceiling_manifest_limit_and_binary_sample_are_bounded_without_truncating_success() {
    let mut routes = HashMap::new();
    for (path, next) in [("/root", "m1"), ("/m1", "m2"), ("/m2", "video")] {
        routes.insert(path.into(),(200,format!("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"avc1.test\",AUDIO=\"a\"\n{next}\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"audio\"\n").into_bytes(),None));
    }
    routes.insert("/video".into(),(200,b"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXT-X-MAP:URI=\"map\"\n#EXTINF:2,\nsegment\n".to_vec(),None));
    routes.insert("/key".into(), (200, vec![1; 16], None));
    routes.insert("/map".into(), (200, vec![1; 32], None));
    routes.insert("/segment".into(), (200, vec![1; 32], None));
    routes.insert("/audio".into(), (200, media("aac"), None));
    routes.insert("/aac".into(), (200, vec![0xff, 0xf1, 0, 0], None));
    let f = fixture(routes).await;
    let r = inspect(
        f.base.join("root").unwrap().as_str(),
        true,
        "r".into(),
        20_000,
    )
    .await
    .unwrap();
    assert_eq!(r.reason_code, "request-limit-unverified");
    assert_eq!(r.checked_resources, 8);
    assert_eq!(f.count.load(std::sync::atomic::Ordering::SeqCst), 8);
    let f = fixture(HashMap::from([(
        "/root".into(),
        (
            200,
            [b"#EXTM3U\n".to_vec(), vec![b'#'; MANIFEST]].concat(),
            None,
        ),
    )]))
    .await;
    assert_eq!(
        inspect(
            f.base.join("root").unwrap().as_str(),
            true,
            "r".into(),
            20_000
        )
        .await
        .unwrap()
        .reason_code,
        "resource-too-large"
    );
    let mut large = ts();
    large.resize(2 * SAMPLE, 0);
    let f = fixture(HashMap::from([("/root".into(), (200, large, None))])).await;
    let r = inspect(
        f.base.join("root").unwrap().as_str(),
        true,
        "r".into(),
        20_000,
    )
    .await
    .unwrap();
    assert_eq!(r.status, "resources-responded");
    assert_eq!(r.checked_resources, 1);
}

#[test]
fn multiplexed_audio_and_default_external_audio_are_distinguished() {
    let base = Url::parse("https://example.test/").unwrap();
    let p=parse(&base,"#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",DEFAULT=YES\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"avc1.test,mp4a.40.2\",AUDIO=\"a\"\nv\n").unwrap();
    assert!(p.audio.is_none());
    assert!(p.variant.is_some());
    let p=parse(&base,"#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"first\"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"default\",DEFAULT=YES\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"avc1.test,mp4a.40.2\",AUDIO=\"a\"\nv\n").unwrap();
    assert_eq!(p.audio.unwrap().path(), "/default");
}

#[tokio::test]
async fn init_map_uses_its_own_effective_key_after_segment_key_changes() {
    let text=b"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"old-key\"\n#EXT-X-MAP:URI=\"map\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"new-key\"\n#EXTINF:2,\nsegment\n".to_vec();
    let f = fixture(HashMap::from([
        ("/root".into(), (200, text, None)),
        ("/new-key".into(), (200, vec![1; 16], None)),
        ("/old-key".into(), (404, vec![], None)),
        ("/map".into(), (200, vec![1; 32], None)),
        ("/segment".into(), (200, vec![1; 32], None)),
    ]))
    .await;
    let r = inspect(
        f.base.join("root").unwrap().as_str(),
        true,
        "r".into(),
        20_000,
    )
    .await
    .unwrap();
    assert_eq!(r.status, "unavailable");
    assert_eq!(r.http_status, Some(404));
    assert_eq!(r.checked_resources, 3);
}

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
                        .write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            )
                            .as_bytes(),
                        )
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
