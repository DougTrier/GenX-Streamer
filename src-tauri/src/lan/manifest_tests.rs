//! Test-only actual TLS/HTTP ownership fixtures; no shipped private-upstream exception.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

const POOL_BYTES: usize = 96 * 1024 * 1024;
const RESERVATION_BYTES: usize = 6 * 1024 * 1024;

struct Fixture {
    address: SocketAddr,
    payload: Arc<Mutex<Vec<u8>>>,
    held_opened: Arc<AtomicUsize>,
    held_closed: Arc<AtomicUsize>,
    stop: tokio::sync::watch::Sender<bool>,
    task: JoinHandle<()>,
}
impl Fixture {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let payload = Arc::new(Mutex::new(b"#EXTM3U\nprior?keep=1\n".to_vec()));
        let held_opened = Arc::new(AtomicUsize::new(0));
        let held_closed = Arc::new(AtomicUsize::new(0));
        let (stop, mut stopped) = tokio::sync::watch::channel(false);
        let data = payload.clone();
        let opened = held_opened.clone();
        let closed = held_closed.clone();
        let task = tokio::spawn(async move {
            let mut jobs = JoinSet::new();
            loop {
                tokio::select! {
                    _ = stopped.changed() => break,
                    Some(result) = jobs.join_next(), if !jobs.is_empty() => { result.unwrap(); },
                    accepted = listener.accept() => {
                        let (mut socket, _) = accepted.unwrap();
                        let data = data.clone();
                        let opened = opened.clone();
                        let closed = closed.clone();
                        let mut stopped = stopped.clone();
                        jobs.spawn(async move {
                            let request = tokio::time::timeout(Duration::from_secs(3), async {
                                let mut request = Vec::new();
                                while !request.ends_with(b"\r\n\r\n") {
                                    let mut byte = [0];
                                    if socket.read_exact(&mut byte).await.is_err() { return None; }
                                    request.push(byte[0]);
                                    assert!(request.len() <= 16384);
                                }
                                Some(request)
                            }).await.unwrap();
                            let Some(request) = request else { return; };
                            if request.starts_with(b"GET /hold ") {
                                opened.fetch_add(1, Ordering::SeqCst);
                                if socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nb\r\n#EXTM3U\n#x\n\r\n").await.is_err() {
                                    closed.fetch_add(1, Ordering::SeqCst); return;
                                }
                                // A real unfinished manifest read owns the six-MiB reservation.
                                // Keep idle reads alive while the test fills the pool.
                                let mut tick = tokio::time::interval(Duration::from_millis(100));
                                let mut byte = [0];
                                loop { tokio::select! {
                                    read = socket.read(&mut byte) => {
                                        assert!(matches!(read, Ok(0) | Err(_)));
                                        closed.fetch_add(1, Ordering::SeqCst); break;
                                    }
                                    _ = tick.tick() => {
                                        if socket.write_all(b"2\r\n#\n\r\n").await.is_err() {
                                            closed.fetch_add(1, Ordering::SeqCst); break;
                                        }
                                    }
                                    _ = stopped.changed() => break,
                                } }
                            } else {
                                let binary = request.starts_with(b"GET /binary ");
                                let body = if binary { b"0123456789abcdef".to_vec() } else { data.lock().unwrap().clone() };
                                let kind = if binary { "video/mp2t" } else { "application/vnd.apple.mpegurl" };
                                let header = format!("HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                                tokio::select! {
                                    _ = stopped.changed() => {},
                                    result = tokio::time::timeout(Duration::from_secs(3), async {
                                        socket.write_all(header.as_bytes()).await?;
                                        socket.write_all(&body).await?;
                                        socket.shutdown().await
                                    }) => { let _ = result; },
                                }
                            }
                        });
                    }
                }
            }
            jobs.abort_all();
            while let Some(result) = jobs.join_next().await {
                if let Err(error) = result {
                    assert!(error.is_cancelled());
                }
            }
        });
        Self {
            address,
            payload,
            held_opened,
            held_closed,
            stop,
            task,
        }
    }
    fn body(&self, body: String) {
        *self.payload.lock().unwrap() = body.into_bytes();
    }
    async fn stop(self) {
        self.stop.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(3), self.task)
            .await
            .unwrap()
            .unwrap();
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
async fn start(fixture: &Fixture) -> (LanManager, StartInfo) {
    let manager = LanManager::default();
    let info = manager
        .start(StartConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            certificate_chain: vec![
                include_bytes!("fixtures/loopback-cert.der").to_vec(),
                include_bytes!("fixtures/loopback-root.der").to_vec(),
            ],
            private_key: include_bytes!("fixtures/loopback-key.der").to_vec(),
            allow_http_upstream: false,
        })
        .await
        .unwrap();
    manager
        .set_test_upstream(&format!("http://{}", fixture.address))
        .await
        .unwrap();
    (manager, info)
}
async fn pair(client: &reqwest::Client, info: &StartInfo, secret: &str) -> (String, String) {
    let response = client
        .post(format!("{}/pair", info.address))
        .header("Origin", &info.address)
        .body(json(&serde_json::json!({"secret":secret})))
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
async fn heartbeat(client: &reqwest::Client, info: &StartInfo, cookie: &str) {
    let response = client
        .post(format!("{}/state", info.address))
        .header("Origin", &info.address)
        .header("Cookie", cookie)
        .body(json(&serde_json::json!({"paused":false})))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.bytes().await.unwrap();
}
async fn state(manager: &LanManager) -> Arc<Mutex<State>> {
    manager.running.lock().await.as_ref().unwrap().state.clone()
}
async fn path(manager: &LanManager, revision: u64, endpoint: &str) -> String {
    let resource = opaque().unwrap();
    let target = format!("https://example.org{endpoint}");
    let state = state(manager).await;
    let mut state = state.lock().unwrap();
    state
        .policy
        .admit_resource(revision, resource.clone(), target.clone())
        .unwrap();
    state.resources.insert(target, resource.clone());
    format!("/media/{revision}/{resource}")
}
fn request(
    client: &reqwest::Client,
    info: &StartInfo,
    cookie: &str,
    path: &str,
) -> JoinHandle<Result<reqwest::Response, reqwest::Error>> {
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
async fn response(job: JoinHandle<Result<reqwest::Response, reqwest::Error>>) -> reqwest::Response {
    tokio::time::timeout(Duration::from_secs(5), job)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}
async fn wait_pool(state: &Arc<Mutex<State>>, available: usize, media: usize) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            {
                let state = state.lock().unwrap();
                let stats = state.consumers.stats().unwrap();
                if state.manifest_budget.available_permits() == available
                    && stats.media_requests == media
                    && stats.control_requests == 0
                {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
fn snapshot(
    state: &Arc<Mutex<State>>,
    cookie: &str,
    revision: u64,
) -> Vec<(String, String, String)> {
    let token = cookie.split_once('=').unwrap().1;
    let mut state = state.lock().unwrap();
    let map = state.resources.clone();
    let now = state.now();
    let mut result = Vec::new();
    for (target, resource) in map {
        let admitted = state
            .policy
            .resource(token, revision, &resource, now)
            .unwrap();
        assert_eq!(admitted, target);
        result.push((target, resource, admitted));
    }
    result.sort();
    result
}

#[tokio::test]
async fn real_tls_sixteen_held_manifests_fill_pool_without_starving_binary_or_control() {
    let fixture = Fixture::start().await;
    let (manager, info) = start(&fixture).await;
    let client = client();
    let mut viewers = Vec::new();
    for index in 0..8 {
        let secret = if index == 0 {
            info.pairing_secret.clone()
        } else {
            manager.invite().await.unwrap()
        };
        viewers.push(pair(&client, &info, &secret).await);
    }
    let published = manager.publish("https://example.org/hold").await.unwrap();
    for (cookie, _) in &viewers {
        heartbeat(&client, &info, cookie).await;
    }
    let binary = path(&manager, published.revision, "/binary").await;
    let held = format!("/media/{}/{}", published.revision, published.media_id);
    let state = state(&manager).await;
    let before = snapshot(&state, &viewers[0].0, published.revision);
    let mut jobs = Vec::new();
    for (index, (cookie, _)) in viewers.iter().enumerate() {
        for offset in 0..2 {
            jobs.push(request(&client, &info, cookie, &held));
            let count = index * 2 + offset + 1;
            wait_pool(&state, POOL_BYTES - count * RESERVATION_BYTES, count).await;
        }
    }
    assert_eq!(fixture.held_opened.load(Ordering::SeqCst), 16);
    let refused = response(request(&client, &info, &viewers[0].0, &held)).await;
    assert_eq!(refused.status(), 503);
    assert_eq!(refused.headers()["retry-after"], "1");
    assert!(String::from_utf8(refused.bytes().await.unwrap().to_vec())
        .unwrap()
        .contains("manifest-budget-unavailable"));
    wait_pool(&state, 0, 16).await;
    assert_eq!(snapshot(&state, &viewers[0].0, published.revision), before);
    let fast = tokio::time::timeout(
        Duration::from_secs(2),
        response(request(&client, &info, &viewers[0].0, &binary)),
    )
    .await
    .unwrap();
    assert_eq!(fast.status(), 200);
    assert_eq!(fast.bytes().await.unwrap().as_ref(), b"0123456789abcdef");
    tokio::time::timeout(
        Duration::from_secs(2),
        heartbeat(&client, &info, &viewers[0].0),
    )
    .await
    .unwrap();
    for (_, viewer) in &viewers {
        manager.revoke(viewer).await.unwrap();
    }
    for job in jobs {
        let result = tokio::time::timeout(Duration::from_secs(3), job)
            .await
            .unwrap()
            .unwrap();
        if let Ok(response) = result {
            assert_eq!(response.status(), 401);
        }
    }
    wait_pool(&state, POOL_BYTES, 0).await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while fixture.held_closed.load(Ordering::SeqCst) < 17 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(fixture.held_opened.load(Ordering::SeqCst), 17);
    manager.stop().await.unwrap();
    fixture.stop().await;
}

#[tokio::test]
async fn real_tls_manifest_failures_leave_both_registries_and_capacity_usable() {
    let fixture = Fixture::start().await;
    let (manager, info) = start(&fixture).await;
    let client = client();
    let (cookie, _) = pair(&client, &info, &info.pairing_secret).await;
    let published = manager
        .publish("https://example.org/manifest")
        .await
        .unwrap();
    heartbeat(&client, &info, &cookie).await;
    let endpoint = format!("/media/{}/{}", published.revision, published.media_id);
    let state = state(&manager).await;
    let failures = [
        "#EXTM3U\nnew-segment?query=kept\nhttp://[broken\n".to_owned(),
        format!(
            "#EXTM3U\n{}",
            (0..5000).map(|i| format!("new-{i}\n")).collect::<String>()
        ),
        format!("#EXTM3U\n#EXT-X-KEY:{}\n", "URI=\"a\",".repeat(100000)),
        format!("#EXTM3U\n#{}", "x".repeat(2 * 1024 * 1024)),
    ];
    for bad in failures {
        let before = snapshot(&state, &cookie, published.revision);
        fixture.body(bad);
        let refused = response(request(&client, &info, &cookie, &endpoint)).await;
        assert_eq!(refused.status(), 502);
        refused.bytes().await.unwrap();
        wait_pool(&state, POOL_BYTES, 0).await;
        assert_eq!(snapshot(&state, &cookie, published.revision), before);
        fixture.body("#EXTM3U\nprior?keep=1\n".to_owned());
        let valid = response(request(&client, &info, &cookie, &endpoint)).await;
        assert_eq!(valid.status(), 200);
        let body = String::from_utf8(valid.bytes().await.unwrap().to_vec()).unwrap();
        assert!(body.starts_with("#EXTM3U\n/media/"));
        wait_pool(&state, POOL_BYTES, 0).await;
    }
    // Hidden policy-only ID leaks would prevent reaching the exact remaining capacity.
    let count = state.lock().unwrap().resources.len();
    fixture.body(format!(
        "#EXTM3U\n{}",
        (0..4096 - count)
            .map(|i| format!("fill-{i}\n"))
            .collect::<String>()
    ));
    let filled = response(request(&client, &info, &cookie, &endpoint)).await;
    assert_eq!(filled.status(), 200);
    filled.bytes().await.unwrap();
    wait_pool(&state, POOL_BYTES, 0).await;
    assert_eq!(snapshot(&state, &cookie, published.revision).len(), 4096);
    manager.stop().await.unwrap();
    fixture.stop().await;
}

#[tokio::test]
async fn real_tls_obsolete_held_manifest_cannot_mutate_replacement_publication() {
    let fixture = Fixture::start().await;
    let (manager, info) = start(&fixture).await;
    let client = client();
    let (cookie, _) = pair(&client, &info, &info.pairing_secret).await;
    let old = manager.publish("https://example.org/hold").await.unwrap();
    heartbeat(&client, &info, &cookie).await;
    let state = state(&manager).await;
    let job = request(
        &client,
        &info,
        &cookie,
        &format!("/media/{}/{}", old.revision, old.media_id),
    );
    wait_pool(&state, POOL_BYTES - RESERVATION_BYTES, 1).await;
    let current = manager
        .publish("https://example.org/manifest")
        .await
        .unwrap();
    let before = snapshot(&state, &cookie, current.revision);
    let result = tokio::time::timeout(Duration::from_secs(3), job)
        .await
        .unwrap()
        .unwrap();
    if let Ok(response) = result {
        assert_eq!(response.status(), 401);
    }
    wait_pool(&state, POOL_BYTES, 0).await;
    assert_eq!(snapshot(&state, &cookie, current.revision), before);
    tokio::time::timeout(Duration::from_secs(3), async {
        while fixture.held_closed.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let valid = response(request(
        &client,
        &info,
        &cookie,
        &format!("/media/{}/{}", current.revision, current.media_id),
    ))
    .await;
    assert_eq!(valid.status(), 200);
    valid.bytes().await.unwrap();
    wait_pool(&state, POOL_BYTES, 0).await;
    let after = snapshot(&state, &cookie, current.revision);
    assert!(after
        .iter()
        .any(|(target, _, _)| target == "https://example.org/prior?keep=1"));
    assert!(!after
        .iter()
        .any(|(target, _, _)| target == "https://example.org/hold"));
    manager.stop().await.unwrap();
    fixture.stop().await;
}
