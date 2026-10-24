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

const TOKEN: &str = "q1w2e3r4t5y6u7i8o9p0aa";

#[test]
fn only_the_page_and_the_file_under_the_secret_are_found() {
    let ask = |line: &str| {
        route(
            &format!("{line}\r\nHost: x\r\n\r\n"),
            TOKEN,
            "GenX-Streamer.apk",
        )
    };
    assert_eq!(
        ask(&format!("GET /{TOKEN}/ HTTP/1.1")),
        (Route::Page, false)
    );
    assert_eq!(
        ask(&format!("GET /{TOKEN}/GenX-Streamer.apk HTTP/1.1")),
        (Route::File, false)
    );
    assert_eq!(
        ask(&format!("HEAD /{TOKEN}/GenX-Streamer.apk HTTP/1.0")),
        (Route::File, true)
    );
    for refused in [
        "GET / HTTP/1.1".to_string(),
        format!("GET /{TOKEN} HTTP/1.1"),
        "GET /wrongsecret/ HTTP/1.1".into(),
        "GET /wrongsecret/GenX-Streamer.apk HTTP/1.1".into(),
        format!("GET /{TOKEN}/../etc/passwd HTTP/1.1"),
        format!("GET /{TOKEN}/GenX-Streamer.apk?x=1 HTTP/1.1"),
        format!("POST /{TOKEN}/ HTTP/1.1"),
        format!("GET /{TOKEN}/ HTTP/2"),
        format!("GET /{TOKEN}/ HTTP/1.1 extra"),
        String::new(),
    ] {
        assert_eq!(ask(&refused).0, Route::NotFound, "{refused}");
    }
}

#[test]
fn only_clients_on_this_network_are_answered() {
    for local in [
        "192.168.1.20",
        "10.0.0.5",
        "172.16.4.4",
        "169.254.10.1",
        "100.64.1.2",
        "fe80::1",
        "fd12::3",
    ] {
        assert!(local_client(local.parse().unwrap()), "{local}");
    }
    for remote in [
        "8.8.8.8",
        "203.0.113.4",
        "100.128.0.1",
        "2001:4860::8888",
        "127.0.0.1",
        "::1",
    ] {
        assert!(!local_client(remote.parse().unwrap()), "{remote}");
    }
}

#[test]
fn each_session_has_its_own_unguessable_secret() {
    let a = secret().unwrap();
    let b = secret().unwrap();
    assert_ne!(a, b);
    assert_eq!(a.len(), 22);
    assert!(a
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
}

fn file(dir: &std::path::Path) -> AppFile {
    let path = dir.join("app.apk");
    std::fs::write(&path, vec![7u8; 300_000]).unwrap();
    AppFile {
        path,
        name: "GenX-Streamer.apk",
        mime: "application/vnd.android.package-archive",
        bytes: 300_000,
        guidance: "Open the downloaded file.",
    }
}

#[test]
fn the_page_names_only_the_app_and_has_no_placeholders_left() {
    let dir = tempfile::tempdir().unwrap();
    let body = page(&file(dir.path()));
    assert!(body.contains("Get GenX Streamer"));
    assert!(body.contains("href=\"GenX-Streamer.apk\""));
    assert!(body.contains("(0.3 MB)"));
    assert!(body.contains("Open the downloaded file."));
    assert!(!body.contains("{{"));
}

/// A real exchange over a socket: the request, the response head and body.
fn exchange(request: &str, file: &AppFile, stats: &Stats) -> Vec<u8> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let request = request.to_string();
    let client = std::thread::spawn(move || {
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut reply = Vec::new();
        stream.read_to_end(&mut reply).unwrap();
        reply
    });
    let (stream, peer) = listener.accept().unwrap();
    serve(stream, TOKEN, file, stats, peer.ip()).unwrap();
    client.join().unwrap()
}

#[test]
fn the_file_is_served_whole_with_its_name_and_counted() {
    let dir = tempfile::tempdir().unwrap();
    let file = file(dir.path());
    let stats = Stats::default();
    let reply = exchange(
        &format!("GET /{TOKEN}/GenX-Streamer.apk HTTP/1.1\r\nHost: x\r\n\r\n"),
        &file,
        &stats,
    );
    let split = reply.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
    let head = String::from_utf8_lossy(&reply[..split]);
    assert!(head.starts_with("HTTP/1.1 200 OK"));
    assert!(head.contains("Content-Type: application/vnd.android.package-archive"));
    assert!(head.contains("Content-Length: 300000"));
    assert!(head.contains("Content-Disposition: attachment; filename=\"GenX-Streamer.apk\""));
    assert_eq!(&reply[split..], &vec![7u8; 300_000][..]);
    assert_eq!(stats.downloads.load(Ordering::SeqCst), 1);
    assert_eq!(stats.completed.load(Ordering::SeqCst), 1);
}

#[test]
fn the_page_counts_visitors_and_strangers_find_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let file = file(dir.path());
    let stats = Stats::default();
    let page = exchange(&format!("GET /{TOKEN}/ HTTP/1.1\r\n\r\n"), &file, &stats);
    let page = String::from_utf8_lossy(&page);
    assert!(page.starts_with("HTTP/1.1 200 OK"));
    assert!(page.contains("Content-Security-Policy: default-src 'none'"));
    assert!(page.contains("Get GenX Streamer"));
    assert_eq!(stats.visitors.lock().unwrap().len(), 1);
    let stranger = exchange(
        "GET /guess/GenX-Streamer.apk HTTP/1.1\r\n\r\n",
        &file,
        &stats,
    );
    assert!(String::from_utf8_lossy(&stranger).starts_with("HTTP/1.1 404 Not Found"));
    assert_eq!(stats.downloads.load(Ordering::SeqCst), 0);
}

#[test]
fn an_oversized_request_head_gets_no_answer() {
    let dir = tempfile::tempdir().unwrap();
    let file = file(dir.path());
    let stats = Stats::default();
    let reply = exchange(
        &format!("GET /{TOKEN}/ HTTP/1.1\r\nX: {}", "a".repeat(MAX_HEAD)),
        &file,
        &stats,
    );
    assert!(reply.is_empty());
}

#[test]
fn a_stopped_or_expired_session_reports_inactive() {
    let owner = NearbyOwner::default();
    assert!(!owner.status().active);
    let (stop, _receiver) = watch::channel(false);
    *owner.0.lock().unwrap() = Some(Session {
        url: format!("http://192.168.1.20:4000/{TOKEN}/"),
        expires: Instant::now() + SESSION,
        stats: Arc::new(Stats::default()),
        stop,
    });
    let status = owner.status();
    assert!(status.active);
    assert!(status.expires_in_ms > 9 * 60 * 1000);
    owner.stop();
    assert_eq!(
        owner.status(),
        NearbyStatus {
            active: false,
            url: None,
            expires_in_ms: 0,
            visitors: 0,
            downloads: 0,
            completed: 0
        }
    );
}
