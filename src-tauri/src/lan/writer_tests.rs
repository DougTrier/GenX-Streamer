//! Test-only observation of actual TLS backpressure, never an artificial writer delay.
use super::*;
use std::{
    pin::Pin,
    sync::atomic::AtomicUsize,
    task::{Context, Poll},
};
use tokio::{io::AsyncReadExt, net::TcpSocket};

#[derive(Default)]
pub(super) struct WriterProbe {
    pending: AtomicUsize,
    bytes: AtomicUsize,
}
pub(super) struct ProbeWriter<'a, W> {
    inner: &'a mut W,
    probe: Option<Arc<WriterProbe>>,
    pending: bool,
}
impl<'a, W> ProbeWriter<'a, W> {
    pub(super) fn new(inner: &'a mut W, probe: Option<Arc<WriterProbe>>) -> Self {
        Self {
            inner,
            probe,
            pending: false,
        }
    }
    fn track(&mut self, pending: bool) {
        if pending != self.pending {
            if let Some(probe) = &self.probe {
                if pending {
                    probe.pending.fetch_add(1, Ordering::SeqCst);
                } else {
                    probe.pending.fetch_sub(1, Ordering::SeqCst);
                }
            }
            self.pending = pending;
        }
    }
}
impl<W> Drop for ProbeWriter<'_, W> {
    fn drop(&mut self) {
        self.track(false);
    }
}
impl<W: AsyncWrite + Unpin> AsyncWrite for ProbeWriter<'_, W> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let result = Pin::new(&mut *self.inner).poll_write(cx, bytes);
        self.track(result.is_pending());
        if let Poll::Ready(Ok(size)) = result {
            if let Some(probe) = &self.probe {
                probe.bytes.fetch_add(size, Ordering::SeqCst);
            }
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.inner).poll_shutdown(cx)
    }
}

struct Fixture {
    address: SocketAddr,
    closed: Arc<AtomicUsize>,
    cancel: tokio::sync::watch::Sender<bool>,
    task: JoinHandle<()>,
}
impl Fixture {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let closed = Arc::new(AtomicUsize::new(0));
        let observed = closed.clone();
        let (cancel, mut stopped) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(async move {
            let mut children = JoinSet::new();
            loop {
                tokio::select! {
                    _ = stopped.changed() => break,
                    Some(result) = children.join_next(), if !children.is_empty() => { result.unwrap(); }
                    connection = listener.accept() => {
                        let (mut socket, _) = connection.unwrap();
                        let closed = observed.clone();
                        let mut canceled = stopped.clone();
                        children.spawn(async move {
                            let serving = async {
                                let mut header = Vec::new();
                                while !header.ends_with(b"\r\n\r\n") {
                                    let mut byte = [0];
                                    if socket.read(&mut byte).await.unwrap_or(0) == 0 { return; }
                                    header.push(byte[0]);
                                    assert!(header.len() < 8192);
                                }
                                if header.starts_with(b"GET /fast ") {
                                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: 4\r\nConnection: close\r\n\r\nfast").await.unwrap();
                                    socket.shutdown().await.unwrap();
                                    return;
                                }
                                if socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: 33554432\r\nConnection: close\r\n\r\n").await.is_err() { return; }
                                let chunk = vec![0x47; 65536];
                                for _ in 0..512 {
                                    if socket.write_all(&chunk).await.is_err() {
                                        closed.fetch_add(1, Ordering::SeqCst);
                                        return;
                                    }
                                }
                                let mut byte = [0];
                                let read = socket.read(&mut byte).await;
                                assert!(matches!(read, Ok(0) | Err(_)));
                                closed.fetch_add(1, Ordering::SeqCst);
                            };
                            tokio::select! { _ = canceled.changed() => {}, _ = serving => {} }
                        });
                    }
                }
            }
            while let Some(result) = children.join_next().await {
                result.unwrap();
            }
        });
        Self {
            address,
            closed,
            cancel,
            task,
        }
    }
    async fn stop(self) {
        self.cancel.send(true).unwrap();
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
    let reply = client
        .post(format!("{}/pair", info.address))
        .header("Origin", &info.address)
        .body(json(&serde_json::json!({"secret":secret})))
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 200);
    let cookie = reply.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let value: serde_json::Value = serde_json::from_slice(&reply.bytes().await.unwrap()).unwrap();
    (cookie, value["viewerId"].as_str().unwrap().to_owned())
}
async fn heartbeat(client: &reqwest::Client, info: &StartInfo, cookie: &str, paused: bool) {
    assert_eq!(
        client
            .post(format!("{}/state", info.address))
            .header("Origin", &info.address)
            .header("Cookie", cookie)
            .body(json(&serde_json::json!({"paused":paused})))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
}
async fn blocked_client(
    info: &StartInfo,
    cookie: &str,
    path: &str,
) -> tokio_rustls::client::TlsStream<tokio::net::TcpStream> {
    let address: SocketAddr = info
        .address
        .strip_prefix("https://")
        .unwrap()
        .parse()
        .unwrap();
    let socket = TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(4096).unwrap();
    let socket = socket.connect(address).await.unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(CertificateDer::from(
            include_bytes!("fixtures/loopback-root.der").to_vec(),
        ))
        .unwrap();
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let mut tls = connector
        .connect(
            rustls::pki_types::ServerName::IpAddress(address.ip().into()),
            socket,
        )
        .await
        .unwrap();
    tls.write_all(
        format!(
            "GET {path} HTTP/1.1\r\nHost: {}\r\nCookie: {cookie}\r\nConnection: close\r\n\r\n",
            address
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let mut header = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !header.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            assert_eq!(tls.read(&mut byte).await.unwrap(), 1);
            header.push(byte[0]);
            assert!(header.len() < 8192);
        }
    })
    .await
    .unwrap();
    assert!(header.starts_with(b"HTTP/1.1 200 "));
    // No further reads. Probe observes the real TLS write future reaching Pending.
    tls
}

async fn case(action: &str) {
    let fixture = Fixture::start().await;
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    manager
        .set_test_upstream(&format!("http://{}", fixture.address))
        .await
        .unwrap();
    let probe = Arc::new(WriterProbe::default());
    manager.test_writer_probe(probe.clone()).await;
    let client = client();
    let (cookie, viewer) = pair(&client, &info, &info.pairing_secret).await;
    let (healthy, _) = pair(&client, &info, &manager.invite().await.unwrap()).await;
    let publication = manager.publish("https://example.org/large").await.unwrap();
    heartbeat(&client, &info, &cookie, false).await;
    heartbeat(&client, &info, &healthy, false).await;
    let state = manager.running.lock().await.as_ref().unwrap().state.clone();
    let budget = state.lock().unwrap().manifest_budget.available_permits();
    let fast_id = opaque().unwrap();
    state
        .lock()
        .unwrap()
        .policy
        .admit_resource(
            publication.revision,
            fast_id.clone(),
            "https://example.org/fast".into(),
        )
        .unwrap();
    let mut blocked = Some(
        blocked_client(
            &info,
            &cookie,
            &format!("/media/{}/{}", publication.revision, publication.media_id),
        )
        .await,
    );
    tokio::time::timeout(Duration::from_secs(4), async {
        while probe.pending.load(Ordering::SeqCst) == 0
            || probe.bytes.load(Ordering::SeqCst) < 64 * 1024
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        state
            .lock()
            .unwrap()
            .consumers
            .stats()
            .unwrap()
            .media_requests,
        1
    );
    let response = tokio::time::timeout(
        Duration::from_secs(2),
        client
            .get(format!(
                "{}/media/{}/{fast_id}",
                info.address, publication.revision
            ))
            .header("Cookie", &healthy)
            .send(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.bytes().await.unwrap().as_ref(), b"fast");
    tokio::time::timeout(
        Duration::from_secs(2),
        heartbeat(&client, &info, &cookie, false),
    )
    .await
    .unwrap();
    let secret = manager
        .invite_controller(vec!["channel".into()])
        .await
        .unwrap();
    let (controller, _) = pair(&client, &info, &secret).await;
    let control_client = client.clone();
    let control_address = info.address.clone();
    let control = tokio::spawn(async move {
        control_client
            .post(format!("{control_address}/control"))
            .header("Origin", &control_address)
            .header("Cookie", controller)
            .body(json(
                &serde_json::json!({"sequence":1,"revision":publication.revision,"action":"pause"}),
            ))
            .send()
            .await
            .unwrap()
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
    assert!(
        probe.pending.load(Ordering::SeqCst) > 0,
        "writer must remain backpressured until explicit action"
    );
    assert_eq!(
        fixture.closed.load(Ordering::SeqCst),
        0,
        "upstream must not have closed by its own deadline"
    );
    match action {
        "pause" => heartbeat(&client, &info, &cookie, true).await,
        "revoke" => manager.revoke(&viewer).await.unwrap(),
        "revision" => {
            manager.publish("https://example.org/new").await.unwrap();
        }
        "stop" => manager.stop().await.unwrap(),
        "disconnect" => {
            drop(blocked.take());
        }
        _ => panic!("unknown action"),
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let stats = state.lock().unwrap().consumers.stats().unwrap();
            if fixture.closed.load(Ordering::SeqCst) == 1
                && stats.media_requests == 0
                && stats.control_requests == 0
                && probe.pending.load(Ordering::SeqCst) == 0
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        state.lock().unwrap().manifest_budget.available_permits(),
        budget
    );
    drop(blocked);
    manager.stop().await.unwrap();
    fixture.stop().await;
}

#[tokio::test]
async fn real_tls_backpressured_writer_cancels_on_pause() {
    case("pause").await;
}
#[tokio::test]
async fn real_tls_backpressured_writer_cancels_on_revoke() {
    case("revoke").await;
}
#[tokio::test]
async fn real_tls_backpressured_writer_cancels_on_revision() {
    case("revision").await;
}
#[tokio::test]
async fn real_tls_backpressured_writer_cancels_on_stop() {
    case("stop").await;
}
#[tokio::test]
async fn real_tls_backpressured_writer_cancels_on_disconnect() {
    case("disconnect").await;
}
