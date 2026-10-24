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

//! Actual local capability sockets and retained blocking readers; no provider.
use super::*;
async fn request(url: &str, method: &str, range_header: &str) -> Vec<u8> {
    let url = Url::parse(url).unwrap();
    let address = url.socket_addrs(|| None).unwrap()[0];
    let mut stream = TcpStream::connect(address).await.unwrap();
    stream
        .write_all(
            format!(
                "{method} {} HTTP/1.1\r\nHost: {address}\r\n{range_header}\r\n",
                url.path()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    bytes
}
fn payload(bytes: &[u8]) -> &[u8] {
    let at = bytes.windows(4).position(|s| s == b"\r\n\r\n").unwrap();
    &bytes[at + 4..]
}
#[tokio::test]
async fn archive_download_local_capability_serves_get_head_and_exact_ranges_without_remote_target()
{
    let (_root, body, data) = crate::archive_download_store::local_proxy_fixture();
    let mut proxy = ArchivePlaybackProxy::start_local(
        body,
        1,
        Arc::new(|| Box::pin(async { Ok(()) })),
        Arc::new(|| true),
        Instant::now() + DEADLINE,
    )
    .await
    .unwrap();
    assert!(proxy.state.lock().unwrap().target.is_none());
    assert!(open(&proxy.state, None, false).await.is_err()); // No remote backing can enter DNS/client creation.
    let head = request(proxy.media_url(), "HEAD", "").await;
    assert!(head.starts_with(b"HTTP/1.1 200"));
    assert!(payload(&head).is_empty());
    assert!(String::from_utf8_lossy(&head).contains("Content-Length: 131072"));
    let partial = request(proxy.media_url(), "GET", "Range: bytes=3-107\r\n").await;
    assert!(partial.starts_with(b"HTTP/1.1 206"));
    assert_eq!(payload(&partial), &data[3..108]);
    let all = request(proxy.media_url(), "GET", "").await;
    assert_eq!(payload(&all), data);
    let address = Url::parse(proxy.media_url())
        .unwrap()
        .socket_addrs(|| None)
        .unwrap()[0];
    proxy.stop().await.unwrap();
    drop(proxy);
    assert!(std::net::TcpListener::bind(address).is_ok());
}
#[tokio::test]
async fn archive_download_disconnect_and_stop_join_the_original_held_file_reader() {
    let (root, mut body, _) = crate::archive_download_store::local_proxy_fixture();
    let file_path = root
        .path()
        .join("archive-downloads-v1")
        .join(format!("{}.mp4", body.entry.download_ref));
    let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let held = gate.clone();
    let entered = Arc::new(tokio::sync::Notify::new());
    let observed = entered.clone();
    let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let actual = finished.clone();
    body.before_read = Some(Arc::new(move || {
        observed.notify_one();
        let (lock, wake) = &*held;
        let mut release = lock.lock().unwrap();
        while !*release {
            release = wake.wait(release).unwrap();
        }
        actual.store(true, std::sync::atomic::Ordering::SeqCst);
    }));
    let mut proxy = ArchivePlaybackProxy::start_local(
        body,
        2,
        Arc::new(|| Box::pin(async { Ok(()) })),
        Arc::new(|| true),
        Instant::now() + DEADLINE,
    )
    .await
    .unwrap();
    let url = Url::parse(proxy.media_url()).unwrap();
    let address = url.socket_addrs(|| None).unwrap()[0];
    let mut decoder = TcpStream::connect(address).await.unwrap();
    decoder
        .write_all(
            format!(
                "GET {} HTTP/1.1\r\nHost: {address}\r\nRange: bytes=0-31\r\n\r\n",
                url.path()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    drop(decoder);
    let mut stopped = tokio::spawn(async move {
        let result = proxy.stop().await;
        drop(proxy);
        result
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(40), &mut stopped)
            .await
            .is_err()
    );
    assert!(!finished.load(std::sync::atomic::Ordering::SeqCst));
    {
        let (lock, wake) = &*gate;
        *lock.lock().unwrap() = true;
        wake.notify_all();
    }
    stopped.await.unwrap().unwrap();
    assert!(finished.load(std::sync::atomic::Ordering::SeqCst));
    assert!(std::net::TcpListener::bind(address).is_ok());
    assert!(std::fs::OpenOptions::new()
        .write(true)
        .open(file_path)
        .is_ok());
}
#[tokio::test]
async fn archive_download_local_expiry_cannot_renew_or_resurrect_media() {
    let (_root, body, _) = crate::archive_download_store::local_proxy_fixture();
    let mut proxy = ArchivePlaybackProxy::start_local(
        body,
        3,
        Arc::new(|| Box::pin(async { Ok(()) })),
        Arc::new(|| true),
        Instant::now() + DEADLINE,
    )
    .await
    .unwrap();
    let validity = proxy.validity_handle();
    assert!(validity());
    proxy.state.lock().unwrap().renewed = Instant::now() - LEASE;
    assert!(!validity());
    assert!(proxy.renew().await.is_err());
    assert!(!validity());
    proxy.stop().await.unwrap();
}
