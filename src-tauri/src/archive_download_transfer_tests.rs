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
use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, TcpListener},
    sync::atomic::{AtomicBool, Ordering},
};
fn check() -> Check {
    Arc::new(|| Ok(()))
}
fn writer(directory: &Path, size: u64) -> Arc<Mutex<Writer>> {
    Arc::new(Mutex::new(Writer {
        temp: Some(NamedTempFile::new_in(directory).unwrap()),
        size,
        received: 0,
        sha1: Sha1::new(),
        sha256: Sha256::new(),
    }))
}
#[test]
fn archive_download_response_and_space_bounds_refuse_unverified_content() {
    assert!(response(200, "video/mp4", Some(3), None, false, 3).is_ok());
    for (status, mime, length, encoding, range) in [
        (401, "video/mp4", Some(3), None, false),
        (403, "video/mp4", Some(3), None, false),
        (404, "video/mp4", Some(3), None, false),
        (429, "video/mp4", Some(3), None, false),
        (206, "video/mp4", Some(3), None, true),
        (200, "text/html", Some(3), None, false),
        (200, "video/mp4", None, None, false),
        (200, "video/mp4", Some(4), None, false),
        (200, "video/mp4", Some(3), Some(b"gzip".as_slice()), false),
    ] {
        assert!(response(status, mime, length, encoding, range, 3).is_err());
    }
    assert!(reserve(5_000_000_000, 6_000_000_000).is_ok());
    assert!(reserve(3, 3).is_err());
    assert!(reserve(0, u64::MAX).is_err());
    assert!(reserve(MAX_FILE + 1, u64::MAX).is_err());
    assert!(addresses([SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 443)]).is_err());
    assert!(addresses([
        "8.8.8.8:443".parse().unwrap(),
        "192.168.1.1:443".parse().unwrap()
    ])
    .is_err());
    assert!(addresses(std::iter::repeat_n("8.8.8.8:443".parse().unwrap(), 129)).is_err());
}
#[test]
fn archive_download_abandoned_partial_files_are_removed_and_nothing_else() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("archive-downloads-v1");
    fs::create_dir(&path).unwrap();
    let hour_ago = SystemTime::now() - Duration::from_secs(3600);
    let make = |name: &str, bytes: u64, old: bool| {
        let file = fs::File::create(path.join(name)).unwrap();
        file.set_len(bytes).unwrap();
        if old {
            file.set_modified(hour_ago).unwrap();
        }
    };
    let published = format!("{}.mp4", "a".repeat(64));
    make(".download-abandoned", 4096, true);
    make(".download-live", 512, false);
    make(&published, 2048, true);
    make("downloads.sqlite3", 1024, true);
    fs::create_dir(path.join(".download-folder")).unwrap();
    let before = SystemTime::now() - Duration::from_secs(60);
    assert_eq!(sweep_abandoned(&path, before), (1, 4096));
    let mut left: Vec<String> = fs::read_dir(&path)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    left.sort();
    assert_eq!(
        left,
        [
            ".download-folder".to_string(),
            ".download-live".into(),
            published,
            "downloads.sqlite3".into()
        ]
    );
    // A second pass finds nothing; a missing folder is not an error.
    assert_eq!(sweep_abandoned(&path, before), (0, 0));
    assert_eq!(sweep_abandoned(&root.path().join("absent"), before), (0, 0));
}
#[tokio::test]
async fn archive_download_actual_bytes_verify_digests_and_publish_without_replacement() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("archive-downloads-v1");
    fs::create_dir(&path).unwrap();
    let state = writer(&path, 3);
    {
        let mut w = state.lock().unwrap();
        w.append(b"a", &check()).unwrap();
        w.append(b"bc", &check()).unwrap();
    }
    let staged = state
        .lock()
        .unwrap()
        .finish(Some("a9993e364706816aba3e25717850c26c9cd0d89d"), &check())
        .unwrap();
    assert_eq!(
        staged.local_sha256,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert!(staged.provider_sha1_verified);
    let reference = "a".repeat(64);
    let published = staged.publish(reference.clone(), check()).await.unwrap();
    assert_eq!(
        fs::read(path.join(&published.managed_name)).unwrap(),
        b"abc"
    );
    let duplicate = writer(&path, 3);
    duplicate.lock().unwrap().append(b"new", &check()).unwrap();
    let staged = duplicate.lock().unwrap().finish(None, &check()).unwrap();
    assert!(staged.publish(reference.clone(), check()).await.is_err());
    assert_eq!(
        fs::read(path.join(&published.managed_name)).unwrap(),
        b"abc"
    );
    assert!(
        remove_published(path.clone(), reference.clone(), "../wrong.mp4".into())
            .await
            .is_err()
    );
    remove_published(
        path.clone(),
        reference.clone(),
        published.managed_name.clone(),
    )
    .await
    .unwrap();
    remove_published(path.clone(), reference, published.managed_name)
        .await
        .unwrap();
    assert_eq!(fs::read_dir(&path).unwrap().count(), 0);
}
#[tokio::test]
async fn archive_download_digest_overflow_truncation_cancel_and_path_failures_never_publish() {
    let root = tempfile::tempdir().unwrap();
    for mode in ["hash", "overflow", "truncated", "frame", "cancel"] {
        let state = writer(root.path(), 3);
        let canceled: Check = Arc::new(|| Err("canceled".into()));
        let failed = match mode {
            "overflow" => state.lock().unwrap().append(b"four", &check()).is_err(),
            "frame" => state
                .lock()
                .unwrap()
                .append(&vec![0; FRAME + 1], &check())
                .is_err(),
            "cancel" => state.lock().unwrap().append(b"abc", &canceled).is_err(),
            "truncated" => state.lock().unwrap().finish(None, &check()).is_err(),
            _ => {
                state.lock().unwrap().append(b"abc", &check()).unwrap();
                state
                    .lock()
                    .unwrap()
                    .finish(Some(&"0".repeat(40)), &check())
                    .is_err()
            }
        };
        assert!(failed, "{mode}");
        cleanup(state).await.unwrap();
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }
    let fake = root.path().join("archive-downloads-v1");
    fs::write(&fake, b"not a directory").unwrap();
    assert!(directory(&fake).is_err());
    assert!(directory(&root.path().join("arbitrary")).is_err());
}
async fn response_fixture(
    header: &str,
    bytes: &[u8],
) -> (reqwest::Response, std::thread::JoinHandle<()>) {
    let server = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let address = server.local_addr().unwrap();
    let header = header.to_owned();
    let bytes = bytes.to_vec();
    let worker = std::thread::spawn(move || {
        let (mut socket, _) = server.accept().unwrap();
        // Read until the end of the request head: one read may return
        // only part of it.
        let mut request = Vec::new();
        let mut chunk = [0; 2048];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = socket.read(&mut chunk).unwrap();
            assert!(read > 0, "client closed before the request head ended");
            request.extend_from_slice(&chunk[..read]);
        }
        socket.write_all(header.as_bytes()).unwrap();
        socket.write_all(&bytes).unwrap();
    });
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("http://{address}/fixture"))
        .send()
        .await
        .unwrap();
    (response, worker)
}
#[tokio::test]
async fn archive_download_controlled_http_body_and_error_cleanup_use_actual_stream() {
    // This internal body seam uses a local fixture; production open still
    // refuses every private destination before sending a request.
    for (header, body, ok) in [
            (
                "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 3\r\nConnection: close\r\n\r\n",
                b"abc".as_slice(),
                true,
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 3\r\nConnection: close\r\n\r\n",
                b"a".as_slice(),
                false,
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 3\r\nConnection: close\r\n\r\n",
                b"abc".as_slice(),
                false,
            ),
        ] {
            let root = tempfile::tempdir().unwrap();
            let state = writer(root.path(), 3);
            let (response, worker) = response_fixture(header, body).await;
            let result = receive(response, state.clone(), None, check(), Arc::new(|_| {})).await;
            assert_eq!(result.is_ok(), ok);
            if let Ok(staged) = result {
                assert!(!staged.provider_sha1_verified);
                staged.discard().await.unwrap();
            }
            cleanup(state).await.unwrap();
            tokio::task::spawn_blocking(move || worker.join().unwrap()).await.unwrap();
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        }
}
#[tokio::test]
async fn archive_download_cancelled_wait_still_joins_original_blocking_producer() {
    let canceled = Arc::new(AtomicBool::new(false));
    let observed = canceled.clone();
    let guard: Check = Arc::new(move || {
        if observed.load(Ordering::SeqCst) {
            Err("canceled".into())
        } else {
            Ok(())
        }
    });
    let (release, held) = std::sync::mpsc::channel();
    let actual = tokio::task::spawn_blocking(move || {
        held.recv().unwrap();
        42
    });
    let mut actual = actual;
    let (observed, ready) = tokio::sync::oneshot::channel();
    let original = tokio::spawn(async move {
        let mut consumed = false;
        let result = checked(&guard, async {
            let value = (&mut actual).await;
            consumed = true;
            value.map_err(|_| "worker".to_owned())
        })
        .await;
        let _ = observed.send(());
        if !consumed {
            actual.await.unwrap();
        }
        result
    });
    canceled.store(true, Ordering::SeqCst);
    ready.await.unwrap();
    assert!(!original.is_finished());
    release.send(()).unwrap();
    assert_eq!(original.await.unwrap().unwrap_err(), "canceled");
}
