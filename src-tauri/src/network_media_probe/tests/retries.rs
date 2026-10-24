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

//! Network media probe tests: header retries and transport failure categories.

use super::*;

pub(super) fn fresh_probe() -> Probe {
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
                    socket
                        .write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes())
                        .await
                        .unwrap();
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
    tokio::select! {
        biased; _=&mut pending => panic!("retry delay completed before cancellation"),
        _=tokio::task::yield_now() => {
        }
    }
    send.send(()).unwrap();
    // Same select/drop ownership as inspect_media_resources; no detached retry task.
    tokio::select! {
        biased; _=receiver => {
        }
        _=&mut pending => panic!("canceled retry delay completed"),
    }
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
