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

//! Actual socket fixtures for consumer ownership. This module is test-only.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

struct UpstreamFixture {
    address: std::net::SocketAddr,
    opened: Arc<AtomicUsize>,
    closed: Arc<AtomicUsize>,
    canonical: Arc<AtomicUsize>,
    ranged: Arc<AtomicUsize>,
    stop: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl UpstreamFixture {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let opened = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicUsize::new(0));
        let canonical = Arc::new(AtomicUsize::new(0));
        let ranged = Arc::new(AtomicUsize::new(0));
        let (stop, mut canceled) = tokio::sync::watch::channel(false);
        let task_opened = opened.clone();
        let task_closed = closed.clone();
        let task_canonical = canonical.clone();
        let task_ranged = ranged.clone();
        let task = tokio::spawn(async move {
            let mut clients = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _ = canceled.changed() => break,
                    accepted = listener.accept() => {
                        let (mut socket, _) = accepted.unwrap();
                        let opened = task_opened.clone();
                        let closed = task_closed.clone();
                        let canonical=task_canonical.clone();
                        let ranged_count=task_ranged.clone();
                        let mut canceled = canceled.clone();
                        clients.spawn(async move {
                            let mut request = Vec::new();
                            loop {
                                let mut byte = [0];
                                if socket.read(&mut byte).await.unwrap_or(0) == 0 { return; }
                                request.push(byte[0]);
                                if request.ends_with(b"\r\n\r\n") { break; }
                                assert!(request.len() <= 8192);
                            }
                            opened.fetch_add(1, Ordering::SeqCst);
                            let ranged=request.windows(7).any(|bytes|bytes.eq_ignore_ascii_case(b"range: "));
                            let refetch=request.starts_with(b"GET /cancel-refetch ");
                            if request.starts_with(b"GET /partial-manifest ") || refetch || request.starts_with(b"GET /always-partial ") {
                                if ranged {ranged_count.fetch_add(1,Ordering::SeqCst);} else {canonical.fetch_add(1,Ordering::SeqCst);}
                            }
                            let lease_stream = request.starts_with(b"GET /lease ");
                            let stalled = request.starts_with(b"GET /stall ") || lease_stream || (refetch&&!ranged);
                            if stalled {
                                // Headers arrive, but the body never does: cancellation must close
                                // the real upstream socket rather than merely ignore its result.
                                if refetch {
                                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n#EXTM3U\n#E").await.unwrap();
                                } else { socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n").await.unwrap(); }
                                if lease_stream {
                                    socket.write_all(b"0123456789").await.unwrap();
                                }
                                let mut byte = [0];
                                let mut progress = tokio::time::interval(Duration::from_secs(1));
                                loop { tokio::select! {
                                    read = socket.read(&mut byte) => {
                                        assert!(matches!(read, Ok(0) | Err(_)), "upstream must close without new request bytes");
                                        closed.fetch_add(1, Ordering::SeqCst);
                                        break;
                                    }
                                    _ = canceled.changed() => break,
                                    _ = progress.tick(), if lease_stream => {
                                        if socket.write_all(b"0").await.is_err() {
                                            closed.fetch_add(1, Ordering::SeqCst);
                                            break;
                                        }
                                    }
                                } }
                            } else {
                                let response = if request.starts_with(b"GET /always-partial ") || ((request.starts_with(b"GET /partial-manifest ")||refetch)&&ranged) {
                                    b"HTTP/1.1 206 Partial Content\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Range: bytes 0-31/80\r\nContent-Length: 32\r\nConnection: close\r\n\r\n#EXTM3U\n#EXTINF:1,\ntruncated.ts\n".as_slice()
                                } else if request.starts_with(b"GET /partial-manifest ") {
                                    b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: 37\r\nConnection: close\r\n\r\n#EXTM3U\n#EXTINF:1,\ncanonical.ts?ok=1\n".as_slice()
                                } else if ranged {
                                    b"HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp2t\r\nContent-Range: bytes 0-3/4\r\nContent-Length: 4\r\nConnection: close\r\n\r\nfast".as_slice()
                                } else {
                                    b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: 4\r\nConnection: close\r\n\r\nfast".as_slice()
                                };
                                socket.write_all(response).await.unwrap();
                                socket.shutdown().await.unwrap();
                            }
                        });
                    }
                    Some(result) = clients.join_next(), if !clients.is_empty() => { result.unwrap(); }
                }
            }
            while let Some(result) = clients.join_next().await {
                result.unwrap();
            }
        });
        Self {
            address,
            opened,
            closed,
            canonical,
            ranged,
            stop,
            task,
        }
    }

    async fn wait_count(counter: &AtomicUsize, count: usize) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while counter.load(Ordering::SeqCst) < count {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    async fn stop(self) {
        self.stop.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(3), self.task)
            .await
            .unwrap()
            .unwrap();
    }
}

fn config() -> StartConfig {
    StartConfig {
        bind: "127.0.0.1:0".parse().unwrap(),
        certificate_chain: vec![
            include_bytes!("fixtures/loopback-cert.der").to_vec(),
            include_bytes!("fixtures/loopback-root.der").to_vec(),
        ],
        private_key: include_bytes!("fixtures/loopback-key.der").to_vec(),
        allow_http_upstream: false,
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .add_root_certificate(
            reqwest::Certificate::from_der(include_bytes!("fixtures/loopback-root.der")).unwrap(),
        )
        .build()
        .unwrap()
}

async fn pair(client: &reqwest::Client, info: &StartInfo, secret: &str) -> (String, String) {
    let response = client
        .post(format!("{}/pair", info.address))
        .header("Origin", &info.address)
        .body(serde_json::to_vec(&serde_json::json!({"secret":secret})).unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let body: serde_json::Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    (cookie, body["viewerId"].as_str().unwrap().to_owned())
}

async fn heartbeat(
    client: &reqwest::Client,
    info: &StartInfo,
    cookie: &str,
    paused: bool,
) -> serde_json::Value {
    let response = client
        .post(format!("{}/state", info.address))
        .header("Origin", &info.address)
        .header("Cookie", cookie)
        .body(serde_json::to_vec(&serde_json::json!({"paused":paused})).unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    serde_json::from_slice(&response.bytes().await.unwrap()).unwrap()
}

async fn media_path(manager: &LanManager, revision: u64, path: &str) -> String {
    let id = opaque().unwrap();
    let target = format!("https://example.org{path}");
    let running = manager.running.lock().await;
    let mut state = running.as_ref().unwrap().state.lock().unwrap();
    state
        .policy
        .admit_resource(revision, id.clone(), target.clone())
        .unwrap();
    state.resources.insert(target, id.clone());
    format!("/media/{revision}/{id}")
}

fn request(
    client: &reqwest::Client,
    info: &StartInfo,
    cookie: &str,
    path: &str,
) -> tokio::task::JoinHandle<Result<reqwest::Response, reqwest::Error>> {
    let client = client.clone();
    let address = info.address.clone();
    let cookie = cookie.to_owned();
    let path = path.to_owned();
    tokio::spawn(async move {
        client
            .get(format!("{address}{path}"))
            .header("Cookie", cookie)
            .send()
            .await
    })
}

async fn settled(manager: &LanManager) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let stats = manager.test_consumer_stats().await.unwrap();
            if stats.media_requests == 0 && stats.control_requests == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn actual_tls_four_stalled_requests_do_not_starve_second_viewer_or_control() {
    let fixture = UpstreamFixture::start().await;
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    manager
        .set_test_upstream(&format!("http://{}", fixture.address))
        .await
        .unwrap();
    let client = client();
    let (first, first_id) = pair(&client, &info, &info.pairing_secret).await;
    let (second, _) = pair(&client, &info, &manager.invite().await.unwrap()).await;
    let publication = manager.publish("https://example.org/stall").await.unwrap();
    heartbeat(&client, &info, &first, false).await;
    heartbeat(&client, &info, &second, false).await;
    let stalled = format!("/media/{}/{}", publication.revision, publication.media_id);
    let fast = media_path(&manager, publication.revision, "/fast").await;
    let mut jobs = Vec::new();
    for count in 1..=4 {
        jobs.push(request(&client, &info, &first, &stalled));
        // Establish authenticated requests in order; all four remain active together.
        UpstreamFixture::wait_count(&fixture.opened, count).await;
    }
    UpstreamFixture::wait_count(&fixture.opened, 4).await;
    let refused = tokio::time::timeout(
        Duration::from_secs(2),
        request(&client, &info, &first, &stalled),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    assert_eq!(refused.status(), 429);
    let fast_reply = tokio::time::timeout(
        Duration::from_secs(2),
        request(&client, &info, &second, &fast),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    assert_eq!(fast_reply.status(), 200);
    assert_eq!(fast_reply.bytes().await.unwrap().as_ref(), b"fast");
    // A control-class state request must have admission despite its viewer's media quota.
    tokio::time::timeout(
        Duration::from_secs(2),
        heartbeat(&client, &info, &first, false),
    )
    .await
    .unwrap();
    let controller_invite = manager
        .invite_controller(vec!["owned-channel".into()])
        .await
        .unwrap();
    let (controller, _) = pair(&client, &info, &controller_invite).await;
    let control_client = client.clone();
    let control_address = info.address.clone();
    let control = tokio::spawn(async move {
        control_client.post(format!("{control_address}/control"))
            .header("Origin", &control_address).header("Cookie", controller)
            .body(serde_json::to_vec(&serde_json::json!({"sequence":1,"revision":publication.revision,"action":"pause"})).unwrap())
            .send().await.unwrap()
    });
    let command = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(command) = manager.next_control().await.unwrap() {
                break command;
            }
        }
    })
    .await
    .unwrap();
    assert!(manager
        .acknowledge_control(&command.command_id, true)
        .await
        .unwrap());
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), control)
            .await
            .unwrap()
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        fixture.opened.load(Ordering::SeqCst),
        5,
        "denied media must not reach upstream"
    );
    manager.revoke(&first_id).await.unwrap();
    UpstreamFixture::wait_count(&fixture.closed, 4).await;
    for job in jobs {
        let _ = tokio::time::timeout(Duration::from_secs(3), job)
            .await
            .unwrap()
            .unwrap();
    }
    settled(&manager).await;
    manager.stop().await.unwrap();
    fixture.stop().await;
}

async fn cancellation_case(reason: &str) {
    let fixture = UpstreamFixture::start().await;
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    manager
        .set_test_upstream(&format!("http://{}", fixture.address))
        .await
        .unwrap();
    let client = client();
    let (cookie, viewer) = pair(&client, &info, &info.pairing_secret).await;
    let publication = manager.publish("https://example.org/stall").await.unwrap();
    heartbeat(&client, &info, &cookie, false).await;
    let path = format!("/media/{}/{}", publication.revision, publication.media_id);
    let job = request(&client, &info, &cookie, &path);
    UpstreamFixture::wait_count(&fixture.opened, 1).await;
    let state_after_stop = manager.running.lock().await.as_ref().unwrap().state.clone();
    match reason {
        "pause" => {
            heartbeat(&client, &info, &cookie, true).await;
        }
        "revoke" => manager.revoke(&viewer).await.unwrap(),
        "revision" => {
            manager
                .publish("https://example.org/replacement")
                .await
                .unwrap();
        }
        "stop" => manager.stop().await.unwrap(),
        _ => panic!("unknown fixture action"),
    }
    UpstreamFixture::wait_count(&fixture.closed, 1).await;
    let _ = tokio::time::timeout(Duration::from_secs(3), job)
        .await
        .unwrap()
        .unwrap();
    if reason != "stop" {
        settled(&manager).await;
        manager.stop().await.unwrap();
    }
    let stats = state_after_stop.lock().unwrap().consumers.stats().unwrap();
    assert_eq!(stats.media_requests, 0);
    assert_eq!(stats.control_requests, 0);
    fixture.stop().await;
}

#[tokio::test]
async fn actual_tls_viewer_pause_closes_owned_upstream() {
    cancellation_case("pause").await;
}
#[tokio::test]
async fn actual_tls_revoke_closes_owned_upstream() {
    cancellation_case("revoke").await;
}
#[tokio::test]
async fn actual_tls_publication_replacement_closes_owned_upstream() {
    cancellation_case("revision").await;
}
#[tokio::test]
async fn actual_tls_stop_closes_owned_upstream() {
    cancellation_case("stop").await;
}

#[tokio::test]
async fn actual_tls_preserved_host_pause_keeps_media_alive_until_viewer_pause() {
    let fixture = UpstreamFixture::start().await;
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    manager
        .set_test_upstream(&format!("http://{}", fixture.address))
        .await
        .unwrap();
    let client = client();
    let (cookie, _) = pair(&client, &info, &info.pairing_secret).await;
    manager.selection_changed(1, None).await.unwrap();
    let published = manager
        .publish_guarded("https://example.org/stall", 1)
        .await
        .unwrap();
    heartbeat(&client, &info, &cookie, false).await;
    let job = request(
        &client,
        &info,
        &cookie,
        &format!("/media/{}/{}", published.revision, published.media_id),
    );
    UpstreamFixture::wait_count(&fixture.opened, 1).await;
    manager
        .selection_changed_with_publication(2, None, true)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(fixture.closed.load(Ordering::SeqCst), 0);
    assert_eq!(
        manager.test_consumer_stats().await.unwrap().media_requests,
        1
    );
    heartbeat(&client, &info, &cookie, true).await;
    UpstreamFixture::wait_count(&fixture.closed, 1).await;
    let _ = job.await.unwrap();
    settled(&manager).await;
    manager.stop().await.unwrap();
    fixture.stop().await;
}

#[tokio::test]
async fn actual_tls_disconnected_request_closes_upstream_and_releases_permit() {
    let fixture = UpstreamFixture::start().await;
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    manager
        .set_test_upstream(&format!("http://{}", fixture.address))
        .await
        .unwrap();
    let client = client();
    let (cookie, _) = pair(&client, &info, &info.pairing_secret).await;
    let publication = manager.publish("https://example.org/stall").await.unwrap();
    heartbeat(&client, &info, &cookie, false).await;
    let job = request(
        &client,
        &info,
        &cookie,
        &format!("/media/{}/{}", publication.revision, publication.media_id),
    );
    UpstreamFixture::wait_count(&fixture.opened, 1).await;
    job.abort();
    assert!(job.await.unwrap_err().is_cancelled());
    UpstreamFixture::wait_count(&fixture.closed, 1).await;
    settled(&manager).await;
    manager.stop().await.unwrap();
    fixture.stop().await;
}

#[tokio::test]
async fn actual_thirty_second_viewer_lease_cancels_before_twenty_second_upstream_deadline() {
    let fixture = UpstreamFixture::start().await;
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    manager
        .set_test_upstream(&format!("http://{}", fixture.address))
        .await
        .unwrap();
    let client = client();
    let (cookie, _) = pair(&client, &info, &info.pairing_secret).await;
    let publication = manager.publish("https://example.org/lease").await.unwrap();
    heartbeat(&client, &info, &cookie, false).await;
    let heartbeat_time = Instant::now();
    // No synthetic clock or early renewal. Start upstream late enough that its
    // own twenty-second timeout cannot be mistaken for the real thirty-second lease.
    tokio::time::sleep(Duration::from_secs(21)).await;
    let job = request(
        &client,
        &info,
        &cookie,
        &format!("/media/{}/{}", publication.revision, publication.media_id),
    );
    UpstreamFixture::wait_count(&fixture.opened, 1).await;
    let upstream_time = Instant::now();
    tokio::time::timeout(Duration::from_secs(13), async {
        while fixture.closed.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(heartbeat_time.elapsed() >= Duration::from_secs(29));
    assert!(upstream_time.elapsed() < Duration::from_secs(14));
    let _ = job.await.unwrap();
    settled(&manager).await;
    manager.stop().await.unwrap();
    fixture.stop().await;
}

#[tokio::test]
async fn actual_tls_streamed_range_preserves_status_header_and_body() {
    let fixture = UpstreamFixture::start().await;
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    manager
        .set_test_upstream(&format!("http://{}", fixture.address))
        .await
        .unwrap();
    let client = client();
    let (cookie, _) = pair(&client, &info, &info.pairing_secret).await;
    let publication = manager.publish("https://example.org/fast").await.unwrap();
    heartbeat(&client, &info, &cookie, false).await;
    let response = client
        .get(format!(
            "{}/media/{}/{}",
            info.address, publication.revision, publication.media_id
        ))
        .header("Cookie", cookie)
        .header("Range", "bytes=0-3")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.headers()["content-range"], "bytes 0-3/4");
    assert_eq!(response.bytes().await.unwrap().as_ref(), b"fast");
    settled(&manager).await;
    manager.stop().await.unwrap();
    fixture.stop().await;
}

#[tokio::test]
async fn actual_tls_always_partial_manifest_cannot_commit_rewritten_resource_ids() {
    let fixture = UpstreamFixture::start().await;
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    manager
        .set_test_upstream(&format!("http://{}", fixture.address))
        .await
        .unwrap();
    let client = client();
    let (cookie, _) = pair(&client, &info, &info.pairing_secret).await;
    let publication = manager
        .publish("https://example.org/always-partial")
        .await
        .unwrap();
    heartbeat(&client, &info, &cookie, false).await;
    let before = {
        let running = manager.running.lock().await;
        let state = running.as_ref().unwrap().state.lock().unwrap();
        state.resources.clone()
    };
    let response = request(
        &client,
        &info,
        &cookie,
        &format!("/media/{}/{}", publication.revision, publication.media_id),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.status(), 502);
    assert!(String::from_utf8(response.bytes().await.unwrap().to_vec())
        .unwrap()
        .contains("partial-manifest-unsupported"));
    {
        let running = manager.running.lock().await;
        let state = running.as_ref().unwrap().state.lock().unwrap();
        assert_eq!(state.resources, before);
    }
    settled(&manager).await;
    manager.stop().await.unwrap();
    fixture.stop().await;
}

#[tokio::test]
async fn actual_tls_eight_parallel_bootstrap_clients_get_all_bundled_assets_without_retry() {
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    let barrier = Arc::new(tokio::sync::Barrier::new(25));
    let expected = [
        ("/viewer.css", include_bytes!("viewer.css").as_slice()),
        ("/viewer.js", include_bytes!("viewer.js").as_slice()),
        (
            "/hls.js",
            include_bytes!("../../../node_modules/hls.js/dist/hls.min.js").as_slice(),
        ),
    ];
    let mut clients = tokio::task::JoinSet::new();
    for _ in 0..8 {
        for (path, body) in expected {
            let barrier = barrier.clone();
            let address = info.address.clone();
            clients.spawn(async move {
                let client = client();
                barrier.wait().await;
                let response = tokio::time::timeout(
                    Duration::from_secs(5),
                    client.get(format!("{address}{path}")).send(),
                )
                .await
                .unwrap()
                .unwrap();
                assert_eq!(
                    response.status(),
                    200,
                    "bootstrap asset must load on its first connection"
                );
                assert_eq!(response.bytes().await.unwrap().as_ref(), body);
            });
        }
    }
    barrier.wait().await;
    while let Some(result) = clients.join_next().await {
        result.unwrap();
    }
    manager.stop().await.unwrap();
}

#[tokio::test]
async fn actual_tls_range_manifest_is_canonicalized_once_and_only_complete_ids_commit() {
    let fixture = UpstreamFixture::start().await;
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    manager
        .set_test_upstream(&format!("http://{}", fixture.address))
        .await
        .unwrap();
    let client = client();
    let (cookie, _) = pair(&client, &info, &info.pairing_secret).await;
    let publication = manager
        .publish("https://example.org/partial-manifest")
        .await
        .unwrap();
    heartbeat(&client, &info, &cookie, false).await;
    let response = client
        .get(format!(
            "{}/media/{}/{}",
            info.address, publication.revision, publication.media_id
        ))
        .header("Cookie", &cookie)
        .header("Range", "bytes=0-")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(!response.headers().contains_key("content-range"));
    let manifest = response.text().await.unwrap();
    assert!(manifest.starts_with("#EXTM3U\n"));
    assert!(manifest.contains(&format!("/media/{}/", publication.revision)));
    assert!(!manifest.contains("canonical.ts"));
    assert!(!manifest.contains("truncated.ts"));
    assert_eq!(fixture.ranged.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.canonical.load(Ordering::SeqCst), 1);
    {
        let running = manager.running.lock().await;
        let state = running.as_ref().unwrap().state.lock().unwrap();
        assert!(state
            .resources
            .contains_key("https://example.org/canonical.ts?ok=1"));
        assert!(!state
            .resources
            .contains_key("https://example.org/truncated.ts"));
        assert_eq!(state.resources.len(), 2);
    }
    settled(&manager).await;
    manager.stop().await.unwrap();
    fixture.stop().await;
}

#[tokio::test]
async fn actual_tls_canceled_canonical_refetch_closes_upstream_and_cannot_commit_ids() {
    let fixture = UpstreamFixture::start().await;
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    manager
        .set_test_upstream(&format!("http://{}", fixture.address))
        .await
        .unwrap();
    let client = client();
    let (cookie, _) = pair(&client, &info, &info.pairing_secret).await;
    let publication = manager
        .publish("https://example.org/cancel-refetch")
        .await
        .unwrap();
    heartbeat(&client, &info, &cookie, false).await;
    let before = {
        let running = manager.running.lock().await;
        let state = running.as_ref().unwrap().state.lock().unwrap();
        state.resources.clone()
    };
    let address = info.address.clone();
    let token = cookie.clone();
    let job = tokio::spawn(async move {
        client
            .get(format!(
                "{address}/media/{}/{}",
                publication.revision, publication.media_id
            ))
            .header("Cookie", token)
            .header("Range", "bytes=0-")
            .send()
            .await
    });
    UpstreamFixture::wait_count(&fixture.canonical, 1).await;
    heartbeat(&self::client(), &info, &cookie, true).await;
    UpstreamFixture::wait_count(&fixture.closed, 1).await;
    let _ = tokio::time::timeout(Duration::from_secs(3), job)
        .await
        .unwrap();
    settled(&manager).await;
    {
        let running = manager.running.lock().await;
        let state = running.as_ref().unwrap().state.lock().unwrap();
        assert_eq!(state.resources, before);
    }
    assert_eq!(fixture.ranged.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.canonical.load(Ordering::SeqCst), 1);
    manager.stop().await.unwrap();
    fixture.stop().await;
}
