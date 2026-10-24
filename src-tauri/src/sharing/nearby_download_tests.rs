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

use super::http::{bytes, etag, page, request, Bytes, Route};
use super::*;

const TOKEN: &str = "482913";

#[test]
fn only_the_page_and_the_file_under_the_code_are_found() {
    let ask = |line: &str| {
        let asked = request(
            &format!("{line}\r\nHost: x\r\n\r\n"),
            TOKEN,
            "GenX-Streamer.apk",
        );
        (asked.route, asked.head_only)
    };
    assert_eq!(
        ask(&format!("GET /{TOKEN}/ HTTP/1.1")),
        (Route::Page, false)
    );
    // As typed on a TV remote, without the final slash.
    assert_eq!(ask(&format!("GET /{TOKEN} HTTP/1.1")), (Route::Page, false));
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
        "GET /favicon.ico HTTP/1.1".into(),
        "GET /wrongsecret/ HTTP/1.1".into(),
        format!("GET /{TOKEN}/../etc/passwd HTTP/1.1"),
        format!("GET /{TOKEN}/GenX-Streamer.apk?x=1 HTTP/1.1"),
        format!("POST /{TOKEN}/ HTTP/1.1"),
        format!("GET /{TOKEN}/ HTTP/2"),
        format!("GET /{TOKEN}/ HTTP/1.1 extra"),
        String::new(),
    ] {
        assert_eq!(ask(&refused).0, Route::NotFound, "{refused}");
    }
    for guess in [
        "GET /123456 HTTP/1.1",
        "GET /000000/ HTTP/1.1",
        "GET /999999/GenX-Streamer.apk HTTP/1.1",
        "GET /4829130 HTTP/1.1",
    ] {
        assert_eq!(ask(guess).0, Route::WrongCode, "{guess}");
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

fn file(dir: &std::path::Path) -> AppFile {
    let path = dir.join("app.apk");
    std::fs::write(&path, vec![7u8; 300_000]).unwrap();
    AppFile {
        path,
        name: "GenX-Streamer.apk",
        mime: "application/vnd.android.package-archive",
        bytes: 300_000,
        guidance: "Open the downloaded file.",
        package: Package::AndroidUniversal,
        sha256: "ab".repeat(32),
        signer: Some("464c42785a80bb27022527d7e5b703c4ecf2d62f433a0f9f6b162ee95b7872ff"),
    }
}

const ANDROID: &str =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/140 Mobile";
const IPHONE: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const WINDOWS: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

#[test]
fn the_page_names_only_the_app_and_has_no_placeholders_left() {
    let dir = tempfile::tempdir().unwrap();
    let body = page(&file(dir.path()), ANDROID, TOKEN);
    assert!(body.contains("Get GenX Streamer"));
    assert!(body.contains("href=\"/482913/GenX-Streamer.apk\""));
    assert!(body.contains("(0.3 MB)"));
    assert!(body.contains("Open the downloaded file."));
    assert!(body.contains("32- and 64-bit"));
    assert!(!body.contains("class=\"warn\""));
    assert!(!body.contains("{{"));
}

#[test]
fn the_page_shows_the_checksum_and_the_official_signer() {
    let dir = tempfile::tempdir().unwrap();
    let body = page(&file(dir.path()), ANDROID, TOKEN);
    assert!(body.contains(&"ab".repeat(32)));
    assert!(body.contains("46:4C:42:78:5A:80:BB:27"));
    assert!(body.contains(":5B:78:72:FF</code>"));
    let mut windows = file(dir.path());
    windows.package = Package::WindowsExe;
    windows.signer = None;
    let body = page(&windows, WINDOWS, TOKEN);
    assert!(body.contains("SHA-256"));
    assert!(!body.contains("Signed by"));
}

#[test]
fn a_device_that_cannot_run_it_is_told_why_and_offered_no_file() {
    let dir = tempfile::tempdir().unwrap();
    let iphone = page(&file(dir.path()), IPHONE, TOKEN);
    assert!(iphone.contains("This is GenX Streamer for Android"));
    assert!(iphone.contains("for iPhone, iPad or Mac yet"));
    assert!(!iphone.contains("href=\"/482913/GenX-Streamer.apk\""));
    let pc = page(&file(dir.path()), WINDOWS, TOKEN);
    assert!(pc.contains("dougtrier.github.io/GenX-Streamer/get"));
    assert!(!pc.contains("href=\"/482913/GenX-Streamer.apk\""));
    let unknown = page(&file(dir.path()), "curl/8", TOKEN);
    assert!(unknown.contains("class=\"warn\""));
    assert!(unknown.contains("href=\"/482913/GenX-Streamer.apk\""));
}

#[test]
fn markup_in_the_page_text_stays_plain_text() {
    let dir = tempfile::tempdir().unwrap();
    let mut odd = file(dir.path());
    odd.sha256 = "<script>x</script>".into();
    let body = page(&odd, ANDROID, TOKEN);
    assert!(!body.contains("<script>"));
    assert!(body.contains("&lt;script&gt;"));
}

#[test]
fn ranges_resume_only_the_same_file() {
    let tag = "\"abc\"";
    assert_eq!(bytes(None, None, tag, 100), Bytes::Whole);
    assert_eq!(
        bytes(Some("bytes=10-"), None, tag, 100),
        Bytes::Part(10, 99)
    );
    assert_eq!(
        bytes(Some("bytes=10-19"), Some(tag), tag, 100),
        Bytes::Part(10, 19)
    );
    assert_eq!(
        bytes(Some("bytes=90-500"), None, tag, 100),
        Bytes::Part(90, 99)
    );
    assert_eq!(
        bytes(Some("bytes=-30"), None, tag, 100),
        Bytes::Part(70, 99)
    );
    assert_eq!(
        bytes(Some("bytes=-300"), None, tag, 100),
        Bytes::Part(0, 99)
    );
    // Another file than the one the browser started: the whole file again.
    assert_eq!(
        bytes(Some("bytes=10-"), Some("\"old\""), tag, 100),
        Bytes::Whole
    );
    assert_eq!(bytes(Some("bytes=0-1,5-6"), None, tag, 100), Bytes::Whole);
    assert_eq!(bytes(Some("items=0-5"), None, tag, 100), Bytes::Whole);
    assert_eq!(bytes(Some("bytes=x-5"), None, tag, 100), Bytes::Whole);
    assert_eq!(
        bytes(Some("bytes=100-"), None, tag, 100),
        Bytes::Unsatisfiable
    );
    assert_eq!(
        bytes(Some("bytes=20-10"), None, tag, 100),
        Bytes::Unsatisfiable
    );
    assert_eq!(
        bytes(Some("bytes=-0"), None, tag, 100),
        Bytes::Unsatisfiable
    );
    assert_eq!(
        bytes(Some("bytes=99999999999999999999-"), None, tag, 100),
        Bytes::Whole
    );
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
        &format!(
            "GET /{TOKEN}/GenX-Streamer.apk HTTP/1.1\r\nHost: x\r\nUser-Agent: {ANDROID}\r\n\r\n"
        ),
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
    assert!(head.contains("Accept-Ranges: bytes"));
    assert!(head.contains(&format!("ETag: {}", etag(&file))));
    assert_eq!(stats.downloads.load(Ordering::SeqCst), 1);
    assert_eq!(stats.completed.load(Ordering::SeqCst), 1);
}

#[test]
fn an_interrupted_download_resumes_where_it_stopped() {
    let dir = tempfile::tempdir().unwrap();
    let file = file(dir.path());
    std::fs::write(
        &file.path,
        (0..300_000u32).map(|i| i as u8).collect::<Vec<_>>(),
    )
    .unwrap();
    let stats = Stats::default();
    let reply = exchange(
        &format!(
            "GET /{TOKEN}/GenX-Streamer.apk HTTP/1.1\r\nRange: bytes=299990-\r\nIf-Range: {}\r\nUser-Agent: {ANDROID}\r\n\r\n",
            etag(&file)
        ),
        &file,
        &stats,
    );
    let split = reply.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
    let head = String::from_utf8_lossy(&reply[..split]);
    assert!(head.starts_with("HTTP/1.1 206 Partial Content"), "{head}");
    assert!(head.contains("Content-Range: bytes 299990-299999/300000"));
    assert!(head.contains("Content-Length: 10"));
    let expected: Vec<u8> = (299_990..300_000u32).map(|i| i as u8).collect();
    assert_eq!(&reply[split..], &expected[..]);
    // The end of a resumed download completes it, without counting a new one.
    assert_eq!(stats.downloads.load(Ordering::SeqCst), 0);
    assert_eq!(stats.completed.load(Ordering::SeqCst), 1);
    let beyond = exchange(
        &format!("GET /{TOKEN}/GenX-Streamer.apk HTTP/1.1\r\nRange: bytes=300000-\r\n\r\n"),
        &file,
        &stats,
    );
    let beyond = String::from_utf8_lossy(&beyond);
    assert!(beyond.starts_with("HTTP/1.1 416 Range Not Satisfiable"));
    assert!(beyond.contains("Content-Range: bytes */300000"));
}

#[test]
fn the_file_is_refused_to_a_device_it_cannot_run_on() {
    let dir = tempfile::tempdir().unwrap();
    let file = file(dir.path());
    let stats = Stats::default();
    let reply = exchange(
        &format!("GET /{TOKEN}/GenX-Streamer.apk HTTP/1.1\r\nUser-Agent: {IPHONE}\r\n\r\n"),
        &file,
        &stats,
    );
    let reply = String::from_utf8_lossy(&reply);
    assert!(reply.starts_with("HTTP/1.1 403 Forbidden"));
    assert!(!reply.contains("Content-Disposition"));
    assert_eq!(stats.downloads.load(Ordering::SeqCst), 0);
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
    assert!(!stats.guesses.exhausted());
}

#[test]
fn wrong_codes_are_counted_and_lock_the_guesser_out() {
    let dir = tempfile::tempdir().unwrap();
    let file = file(dir.path());
    let stats = Stats::default();
    for wrong in 0..super::guard::CLIENT_GUESSES {
        let reply = exchange(&format!("GET /{wrong:06} HTTP/1.1\r\n\r\n"), &file, &stats);
        assert!(String::from_utf8_lossy(&reply).starts_with("HTTP/1.1 404 Not Found"));
    }
    // exchange() connects from 127.0.0.1; the accept loop drops a locked-out client.
    assert!(stats.guesses.locked_out("127.0.0.1".parse().unwrap()));
    assert!(!stats.guesses.locked_out("192.168.1.30".parse().unwrap()));
}

#[test]
fn the_page_typed_without_its_slash_links_the_file_by_its_full_path() {
    let dir = tempfile::tempdir().unwrap();
    let file = file(dir.path());
    let stats = Stats::default();
    let reply = exchange(
        &format!("GET /{TOKEN} HTTP/1.1\r\nUser-Agent: {ANDROID}\r\n\r\n"),
        &file,
        &stats,
    );
    let reply = String::from_utf8_lossy(&reply);
    assert!(reply.starts_with("HTTP/1.1 200 OK"));
    assert!(reply.contains(&format!("href=\"/{TOKEN}/GenX-Streamer.apk\"")));
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
    *owner.session.lock().unwrap() = Some(Session {
        url: format!("http://192.168.1.20:4000/{TOKEN}"),
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
            completed: 0,
            ended: None,
            check_in: None
        }
    );
}

#[test]
fn an_early_end_says_why_and_never_ends_a_newer_session() {
    let owner = NearbyOwner::default();
    let session = |url: &str| {
        let (stop, receiver) = watch::channel(false);
        std::mem::forget(receiver);
        Session {
            url: url.into(),
            expires: Instant::now() + SESSION,
            stats: Arc::new(Stats::default()),
            stop,
        }
    };
    *owner.session.lock().unwrap() = Some(session("http://192.168.1.20:8080/111111"));
    owner.end("http://192.168.1.20:8080/111111", Some(Ended::Guesses));
    assert!(!owner.status().active);
    assert_eq!(owner.status().ended, Some(Ended::Guesses));
    // The old session's task finishing late leaves the new one running.
    *owner.session.lock().unwrap() = Some(session("http://192.168.1.20:8080/222222"));
    owner.end("http://192.168.1.20:8080/111111", Some(Ended::Network));
    assert!(owner.status().active);
}

#[test]
fn genx_on_a_tv_reports_whether_it_runs_the_file_shared_here() {
    let dir = tempfile::tempdir().unwrap();
    let file = file(dir.path());
    let stats = Stats::default();
    let other = "cd".repeat(32);
    let ask = |path: String| format!("GET {path} HTTP/1.1\r\n\r\n");
    let reply = exchange(
        &ask(format!("/{TOKEN}/installed?sha256={other}")),
        &file,
        &stats,
    );
    assert!(String::from_utf8_lossy(&reply).starts_with("HTTP/1.1 204 No Content"));
    assert_eq!(*stats.check_in.lock().unwrap(), Some(CheckIn::Different));
    let sha = file.sha256.clone();
    exchange(
        &ask(format!("/{TOKEN}/installed?sha256={sha}")),
        &file,
        &stats,
    );
    assert_eq!(*stats.check_in.lock().unwrap(), Some(CheckIn::Same));
    // Malformed reports and reports without the code are not check-ins (nor guesses).
    for refused in [
        format!("/{TOKEN}/installed?sha256=XYZ"),
        format!("/{TOKEN}/installed"),
        format!("/installed?sha256={other}"),
    ] {
        let reply = exchange(&ask(refused.clone()), &file, &stats);
        assert!(
            String::from_utf8_lossy(&reply).starts_with("HTTP/1.1 404"),
            "{refused}"
        );
    }
    assert_eq!(*stats.check_in.lock().unwrap(), Some(CheckIn::Same));
    assert!(!stats.guesses.exhausted());
}
