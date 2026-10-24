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

use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn remaining_fixture(
    always_redirect: bool,
) -> (
    Url,
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let ranges = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let range_count = ranges.clone();
    let (stop, mut stopped) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let mut clients = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                Some(result) = clients.join_next(), if !clients.is_empty() => { result.unwrap(); },
                accepted = listener.accept() => {
                    let (mut socket, _) = accepted.unwrap();
                    let count = count.clone(); let ranges = range_count.clone();
                    clients.spawn(async move {
                        let headers = tokio::time::timeout(Duration::from_secs(2), async {
                            let mut request = Vec::new();
                            while !request.ends_with(b"\r\n\r\n") {
                                let mut byte = [0]; socket.read_exact(&mut byte).await.unwrap();
                                request.push(byte[0]); assert!(request.len() <= 8192);
                            }
                            request
                        }).await.unwrap();
                        count.fetch_add(1, Ordering::SeqCst);
                        let ranged = headers.windows(6).any(|value| value.eq_ignore_ascii_case(b"range:"));
                        if ranged { ranges.fetch_add(1, Ordering::SeqCst); }
                        if always_redirect || headers.starts_with(b"GET /first ") {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: /canonical\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                            socket.shutdown().await.unwrap();
                        } else {
                            let status = if ranged { "206 Partial Content" } else { "200 OK" };
                            let header = format!("HTTP/1.1 {status}\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: 64\r\nConnection: close\r\n\r\n#EXTM3U\n#x\n");
                            socket.write_all(header.as_bytes()).await.unwrap();
                            // Keep an actual incomplete response until its owner drops/cancels it.
                            let mut byte = [0]; let _ = socket.read(&mut byte).await;
                        }
                    });
                }
            }
        }
        clients.abort_all();
        while let Some(result) = clients.join_next().await {
            if let Err(error) = result {
                assert!(error.is_cancelled());
            }
        }
    });
    (base, requests, ranges, stop, task)
}
async fn fixture_transport(
    url: Url,
    range: Option<String>,
    deadline: tokio::time::Instant,
) -> Result<reqwest::Response, &'static str> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .timeout(deadline.saturating_duration_since(tokio::time::Instant::now()))
        .build()
        .map_err(|_| "fixture-client-failed")?;
    let mut request = client.get(url);
    if let Some(range) = range {
        request = request.header(RANGE, range);
    }
    request.send().await.map_err(|_| "fixture-network-failed")
}
#[tokio::test]
async fn actual_canonical_refetch_keeps_original_body_deadline_and_counts_used_redirects() {
    use std::sync::atomic::Ordering;
    let (base, requests, ranges, stop, task) = remaining_fixture(false).await;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
    let first = open_with_remaining_transport(
        base.join("first").unwrap(),
        Some("bytes=0-10".into()),
        true,
        deadline,
        5,
        fixture_transport,
    )
    .await
    .unwrap();
    assert_eq!(first.redirects_used, 1);
    assert_eq!(first.status, 206);
    assert_eq!(first.body_kind, BodyKind::Manifest);
    let final_url = first.final_url.clone();
    let remaining = 5 - first.redirects_used;
    drop(first);
    let mut full = open_with_remaining_transport(
        final_url,
        None,
        true,
        deadline,
        remaining,
        fixture_transport,
    )
    .await
    .unwrap();
    assert_eq!(full.redirects_used, 0);
    assert_eq!(full.status, 200);
    assert_eq!(full.deadline, deadline);
    assert_eq!(requests.load(Ordering::SeqCst), 3);
    assert_eq!(
        ranges.load(Ordering::SeqCst),
        2,
        "canonical refetch must remove Range"
    );
    tokio::time::sleep_until(deadline + Duration::from_millis(5)).await;
    assert_eq!(full.next_chunk().await.unwrap_err(), "upstream-timeout");
    stop.send(()).unwrap();
    task.await.unwrap();
}
#[tokio::test]
async fn actual_remaining_redirect_allowance_refuses_extra_hop_and_clamps_to_five() {
    use std::sync::atomic::Ordering;
    for (allowance, requests_expected) in [(0usize, 1usize), (1, 2), (usize::MAX, 6)] {
        let (base, requests, _, stop, task) = remaining_fixture(true).await;
        let error = open_with_remaining_transport(
            base,
            None,
            true,
            tokio::time::Instant::now() + Duration::from_secs(2),
            allowance,
            fixture_transport,
        )
        .await
        .err();
        assert_eq!(error, Some("upstream-redirect-limit"));
        assert_eq!(requests.load(Ordering::SeqCst), requests_expected);
        stop.send(()).unwrap();
        task.await.unwrap();
    }
}
#[tokio::test]
async fn spent_deadline_and_http_refusal_never_start_fixture_transport() {
    use std::sync::atomic::Ordering;
    let (base, requests, _, stop, task) = remaining_fixture(true).await;
    assert_eq!(
        open_with_remaining_transport(
            base.clone(),
            None,
            true,
            tokio::time::Instant::now(),
            5,
            fixture_transport
        )
        .await
        .err(),
        Some("upstream-timeout")
    );
    assert_eq!(
        open_with_remaining_transport(
            base,
            None,
            false,
            tokio::time::Instant::now() + Duration::from_secs(2),
            5,
            fixture_transport
        )
        .await
        .err(),
        Some("upstream-http-approval-required")
    );
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    stop.send(()).unwrap();
    task.await.unwrap();
}
#[test]
fn oversized_remaining_deadline_is_clamped_without_extending_a_shorter_deadline() {
    let before = tokio::time::Instant::now();
    let (deadline, redirects) =
        remaining_policy_budget(before + Duration::from_secs(3600), usize::MAX).unwrap();
    assert!(deadline <= tokio::time::Instant::now() + Duration::from_secs(20));
    assert!(deadline >= before + Duration::from_secs(20));
    assert_eq!(redirects, 5);
    let short = before + Duration::from_secs(1);
    assert_eq!(remaining_policy_budget(short, 2).unwrap(), (short, 2));
}

async fn read_fixture_headers(socket: &mut tokio::net::TcpStream) {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            socket.read_exact(&mut byte).await.unwrap();
            request.push(byte[0]);
            assert!(request.len() <= 4096);
        }
    })
    .await
    .unwrap();
}

async fn response_fixture(
    headers: &str,
    parts: Vec<Vec<u8>>,
) -> (reqwest::Response, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let headers = headers.to_string();
    let owner = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_fixture_headers(&mut socket).await;
        socket.write_all(headers.as_bytes()).await.unwrap();
        for part in parts {
            if socket
                .write_all(format!("{:x}\r\n", part.len()).as_bytes())
                .await
                .is_err()
            {
                return;
            }
            if socket.write_all(&part).await.is_err() {
                return;
            }
            if socket.write_all(b"\r\n").await.is_err() {
                return;
            }
        }
        let _ = socket.write_all(b"0\r\n\r\n").await;
    });
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("http://{address}/controlled"))
        .send()
        .await
        .unwrap();
    (response, owner)
}

#[tokio::test]
async fn actual_partial_body_is_delivered_before_completion_and_drop_closes_upstream() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let owner = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_fixture_headers(&mut socket).await;
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n0123456789abcdef\r\n",
            )
            .await
            .unwrap();
        // No terminating chunk is sent. Consumer must get data without whole-body buffering.
        let mut byte = [0; 1];
        tokio::time::timeout(Duration::from_secs(3), socket.read(&mut byte))
            .await
            .unwrap()
            .unwrap()
    });
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("http://{address}/partial"))
        .send()
        .await
        .unwrap();
    let mut opened = tokio::time::timeout(
        Duration::from_secs(1),
        OpenedUpstream::from_test_response(response),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(opened.body_kind, BodyKind::Media);
    let first = opened.next_chunk().await.unwrap().unwrap();
    let second = opened.next_chunk().await.unwrap().unwrap();
    assert_eq!(
        [first.as_ref(), second.as_ref()].concat(),
        b"0123456789abcdef"
    );
    drop(opened);
    assert_eq!(owner.await.unwrap(), 0);
}

#[tokio::test]
async fn fragmented_bom_sniff_range_metadata_and_non_success_status_remain_observed() {
    let manifest = b"\xef\xbb\xbf#EXTM3U\n#EXTINF:1,\nsegment?opaque=yes\n";
    let (response,owner)=response_fixture("HTTP/1.1 206 Partial Content\r\nTransfer-Encoding: chunked\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 0-39/40\r\n\r\n",
            vec![manifest[..2].to_vec(),manifest[2..5].to_vec(),manifest[5..].to_vec()]).await;
    let opened = OpenedUpstream::from_test_response(response).await.unwrap();
    assert_eq!(opened.body_kind, BodyKind::Manifest);
    assert_eq!(opened.status, 206);
    assert_eq!(opened.content_range.as_deref(), Some("bytes 0-39/40"));
    assert_eq!(opened.read_manifest().await.unwrap(), manifest);
    owner.await.unwrap();
    let (response,owner)=response_fixture("HTTP/1.1 429 Too Many Requests\r\nTransfer-Encoding: chunked\r\nRetry-After: 7\r\nContent-Type: application/vnd.apple.mpegurl\r\n\r\n",vec![]).await;
    let mut opened = OpenedUpstream::from_test_response(response).await.unwrap();
    assert_eq!(opened.status, 429);
    assert_eq!(opened.retry_after.as_deref(), Some("7"));
    assert!(opened.next_chunk().await.unwrap().is_none());
    owner.await.unwrap();
}

#[tokio::test]
async fn actual_chunked_manifest_media_and_absolute_deadline_are_bounded() {
    let (response, owner) = response_fixture(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/vnd.apple.mpegurl\r\n\r\n",
            vec![vec![b'x'; 65536]; 33],
        )
        .await;
    let opened = OpenedUpstream::from_test_response(response).await.unwrap();
    assert_eq!(
        opened.read_manifest().await.unwrap_err(),
        "manifest-invalid-or-large"
    );
    owner.await.unwrap();
    let (response, owner) = response_fixture(
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
        vec![vec![b'x'; 65536]; 513],
    )
    .await;
    let mut opened = OpenedUpstream::from_test_response(response).await.unwrap();
    loop {
        match opened.next_chunk().await {
            Ok(Some(chunk)) => assert!(chunk.len() <= TRANSFER_CHUNK),
            Err(error) => {
                assert_eq!(error, "upstream-body-too-large");
                break;
            }
            Ok(None) => panic!("oversized body was admitted"),
        }
    }
    owner.await.unwrap();
    let (response, owner) = response_fixture(
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
        vec![b"0123456789abcdef".to_vec()],
    )
    .await;
    let url = response.url().clone();
    let mut opened = OpenedUpstream::from_response(
        response,
        url,
        tokio::time::Instant::now() + Duration::from_millis(100),
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(opened.next_chunk().await.unwrap_err(), "upstream-timeout");
    assert!(opened.next_chunk().await.unwrap().is_none());
    owner.await.unwrap();
}

#[test]
fn rewritten_manifest_has_an_explicit_output_ceiling() {
    let base = Url::parse("https://example.org/").unwrap();
    assert_eq!(
        rewrite_hls(
            "#EXTM3U\nsegment\n",
            &base,
            |_| Ok("x".repeat(OUTPUT_LIMIT))
        )
        .unwrap_err(),
        "manifest-output-too-large"
    );
}
#[test]
fn repeated_same_target_line_stops_before_output_growth_and_remaining_uri_work() {
    let occurrences = 100_000;
    let manifest = format!("#EXTM3U\n#EXT-X-KEY:{}\n", "URI=\"a\",".repeat(occurrences));
    assert!(manifest.len() < MANIFEST_LIMIT);
    let mut issued = 0usize;
    let mut peak_len = 0usize;
    let mut peak_capacity = 0usize;
    let mut capacity_changes = 0usize;
    let mut previous_capacity = 0usize;
    let session_path = format!("/media/1/{}", "a".repeat(64));
    let error = rewrite_hls_observed(
        &manifest,
        &Url::parse("https://example.org/feed").unwrap(),
        |url| {
            assert_eq!(url.as_str(), "https://example.org/a");
            issued += 1;
            Ok(session_path.clone())
        },
        |len, capacity| {
            peak_len = peak_len.max(len);
            peak_capacity = peak_capacity.max(capacity);
            if previous_capacity != capacity {
                capacity_changes += 1;
                previous_capacity = capacity;
            }
            assert!(len <= OUTPUT_LIMIT);
            assert!(capacity <= OUTPUT_LIMIT);
        },
    )
    .unwrap_err();
    assert_eq!(error, "manifest-output-too-large");
    assert!(peak_len > OUTPUT_LIMIT - 256);
    assert_eq!(peak_capacity, OUTPUT_LIMIT);
    assert!((50_000..60_000).contains(&issued));
    assert!(
        capacity_changes <= 20,
        "growth must not reallocate for every URI fragment"
    );
}
#[test]
fn oversized_issue_output_is_refused_before_result_allocation() {
    let mut peak_capacity = 0;
    let error = rewrite_hls_observed(
        "#EXTM3U\nsegment\n",
        &Url::parse("https://example.org/feed").unwrap(),
        |_| Ok("x".repeat(OUTPUT_LIMIT + 1)),
        |len, capacity| {
            assert!(len <= OUTPUT_LIMIT);
            peak_capacity = peak_capacity.max(capacity);
        },
    )
    .unwrap_err();
    assert_eq!(error, "manifest-output-too-large");
    assert!(peak_capacity < 1024);
    // The callback's own replacement allocation is outside the output buffer contract.
}
#[test]
fn checked_append_admits_exact_utf8_byte_limit_without_truncating_on_later_failure() {
    let mut output = String::new();
    let mut observe = |len, capacity| {
        assert!(len <= OUTPUT_LIMIT);
        assert!(capacity <= OUTPUT_LIMIT);
    };
    append_manifest_fragment(&mut output, &"x".repeat(OUTPUT_LIMIT - 4), &mut observe).unwrap();
    append_manifest_fragment(&mut output, "📺", &mut observe).unwrap();
    assert_eq!(output.len(), OUTPUT_LIMIT);
    assert_eq!(output.capacity(), OUTPUT_LIMIT);
    assert_eq!(
        append_manifest_fragment(&mut output, "x", &mut observe),
        Err("manifest-output-too-large")
    );
    assert_eq!(output.len(), OUTPUT_LIMIT);
    assert!(output.ends_with("📺"));
}
#[test]
fn input_limit_remains_independent_and_refuses_before_issuing_resources() {
    let exact = format!("#EXTM3U\n#{}", "x".repeat(MANIFEST_LIMIT - 9));
    assert_eq!(exact.len(), MANIFEST_LIMIT);
    let base = Url::parse("https://example.org/feed").unwrap();
    assert!(rewrite_hls(&exact, &base, |_| panic!("comment is not a resource")).is_ok());
    let oversized = format!("{exact}x");
    assert_eq!(
        rewrite_hls(&oversized, &base, |_| panic!(
            "oversized input cannot issue resources"
        )),
        Err("manifest-invalid-or-large")
    );
}
#[test]
fn bom_is_metadata_and_never_an_admitted_resource() {
    let base = Url::parse("https://example.org/master").unwrap();
    let mut resources = Vec::new();
    let output = rewrite_hls(
        "\u{feff}#EXTM3U\r\n#EXTINF:2,\r\nsegment\r\n",
        &base,
        |url| {
            resources.push(url);
            Ok("/opaque/segment".into())
        },
    )
    .unwrap();
    assert!(output.starts_with("#EXTM3U\n"));
    assert_eq!(resources.len(), 1);
    assert_eq!(resources[0].as_str(), "https://example.org/segment");
}
use super::*;
#[test]
fn hls_rewrites_variants_segments_keys_maps_and_queries() {
    let mut targets = Vec::new();
    let output = rewrite_hls("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key?a=secret\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-MEDIA:URI=\"audio.m3u8\",TYPE=AUDIO\n#EXT-X-STREAM-INF:BANDWIDTH=50000\nvariant.m3u8\nsegment.ts?signature=secret\n", &Url::parse("https://example.org/live/master.m3u8").unwrap(), |url| { targets.push(url); Ok(format!("/media/1/id{}", targets.len())) }).unwrap();
    assert_eq!(targets.len(), 5);
    assert_eq!(targets[0].as_str(), "https://example.org/live/key?a=secret");
    assert!(!output.contains("secret"));
    assert!(output.contains("URI=\"/media/1/id1\""));
    assert!(output.contains("/media/1/id5"));
    assert!(rewrite_hls(
        "#EXTM3U\nfile:///secret\n",
        &Url::parse("https://example.org/").unwrap(),
        |_| Ok("unused".into())
    )
    .is_err());
}
#[test]
fn range_is_single_bounded_and_valid() {
    for range in ["bytes=0-100", "bytes=50-", "bytes=-500"] {
        assert!(validate_range(range));
    }
    for range in [
        "bytes=100-50",
        "bytes=0-1,2-3",
        "bytes=-",
        "bytes=-0",
        "items=0-1",
        "bytes=18446744073709551616-",
    ] {
        assert!(!validate_range(range));
    }
}
