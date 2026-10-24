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
use crate::guide::parser::{GuideChannel, GuideProgram, ParsedGuide};
fn fixture() -> (Connection, GuideSource, ParsedGuide) {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;PRAGMA user_version=1;")
        .unwrap();
    db::migrate(&mut c).unwrap();
    c.execute_batch("PRAGMA user_version=3;").unwrap();
    db::migrate_suggestions(&mut c).unwrap();
    let source = GuideSource {
        id: "g".into(),
        name: "Fixture".into(),
        kind: "url".into(),
        location: "https://example.invalid/guide".into(),
        allow_http: false,
        revision: 0,
        updated_ms: None,
    };
    db::save_source(&mut c, &source, 0).unwrap();
    let source = db::list_sources(&c).unwrap().remove(0);
    let feed = ParsedGuide {
        channels: vec![GuideChannel {
            id: "a".into(),
            names: vec!["A".into()],
        }],
        programs: vec![GuideProgram {
            channel_id: "a".into(),
            start_ms: 1000,
            stop_ms: Some(10000),
            title: "Actual".into(),
            description: None,
            categories: vec![],
        }],
    };
    (c, source, feed)
}
fn validators() -> Validators {
    Validators {
        etag: Some("\"fixture-v1\"".into()),
        last_modified: Some("Mon, 12 Oct 2026 00:00:00 GMT".into()),
    }
}
fn publish(c: &mut Connection, s: &GuideSource, f: &ParsedGuide) -> GuideSource {
    db::replace_guide_conditional(c, s, f, 2000, &validators(), &AtomicBool::new(false)).unwrap();
    db::list_sources(c).unwrap().remove(0)
}
#[test]
fn not_modified_preserves_rows_success_time_revisions_and_attempt_metadata() {
    let (mut c, s, f) = fixture();
    let s = publish(&mut c, &s, &f);
    let cached = read(&c, &s).unwrap().unwrap();
    let coverage = db::source_coverage(&c, &s.id).unwrap();
    revalidate(
        &mut c,
        &s,
        &cached,
        &Validators::default(),
        3000,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(db::list_sources(&c).unwrap()[0], s);
    assert_eq!(
        db::source_coverage(&c, &s.id).unwrap().published_revision,
        coverage.published_revision
    );
    assert_eq!(
        c.query_row("SELECT checked_ms FROM guide_http_cache", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        3000
    );
    assert_eq!(
        c.query_row("SELECT title FROM guide_program", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "Actual"
    );
}
#[test]
fn expired_cancel_changed_config_and_manual_publication_never_promote() {
    let (mut c, s, f) = fixture();
    let s = publish(&mut c, &s, &f);
    let cached = read(&c, &s).unwrap().unwrap();
    assert_eq!(
        revalidate(
            &mut c,
            &s,
            &cached,
            &validators(),
            10000,
            &AtomicBool::new(false)
        )
        .unwrap_err(),
        "guide-not-modified-cache-expired"
    );
    assert_eq!(
        revalidate(
            &mut c,
            &s,
            &cached,
            &validators(),
            3000,
            &AtomicBool::new(true)
        )
        .unwrap_err(),
        "canceled"
    );
    assert_eq!(db::list_sources(&c).unwrap()[0], s);
    let mut forged = s.clone();
    forged.location = "https://other.invalid/guide".into();
    assert!(read(&c, &forged).unwrap().is_none());
    assert_eq!(
        revalidate(
            &mut c,
            &forged,
            &cached,
            &validators(),
            3000,
            &AtomicBool::new(false)
        )
        .unwrap_err(),
        "guide-stale-revision"
    );
    db::replace_guide(&mut c, &s.id, s.revision, &f, 4000, &AtomicBool::new(false)).unwrap();
    let next = db::list_sources(&c).unwrap().remove(0);
    assert!(read(&c, &next).unwrap().is_none());
    assert_eq!(
        revalidate(
            &mut c,
            &s,
            &cached,
            &validators(),
            5000,
            &AtomicBool::new(false)
        )
        .unwrap_err(),
        "guide-stale-revision"
    );
}
#[test]
fn validator_failure_rolls_back_new_schedule_and_metadata_together() {
    let (mut c, s, f) = fixture();
    let s = publish(&mut c, &s, &f);
    let before = read(&c, &s).unwrap().unwrap();
    c.execute_batch("CREATE TRIGGER fail_validator BEFORE UPDATE ON guide_http_cache BEGIN SELECT RAISE(ABORT,'fixture'); END;")
        .unwrap();
    let mut next = f.clone();
    next.programs[0].title = "Replacement".into();
    assert!(db::replace_guide_conditional(
        &mut c,
        &s,
        &next,
        5000,
        &validators(),
        &AtomicBool::new(false)
    )
    .is_err());
    assert_eq!(db::list_sources(&c).unwrap()[0], s);
    assert_eq!(read(&c, &s).unwrap().unwrap().validators, before.validators);
    assert_eq!(
        c.query_row("SELECT title FROM guide_program", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "Actual"
    );
}
#[test]
fn cancellation_after_metadata_write_rolls_back_transport_check() {
    let (mut c, s, f) = fixture();
    let s = publish(&mut c, &s, &f);
    let cached = read(&c, &s).unwrap().unwrap();
    let mut checks = 0;
    let error = revalidate_checked(&mut c, &s, &cached, &Validators::default(), 3000, || {
        checks += 1;
        checks == 2
    })
    .unwrap_err();
    assert_eq!(error, "canceled");
    assert_eq!(checks, 2);
    assert_eq!(
        c.query_row("SELECT checked_ms FROM guide_http_cache", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2000
    );
    assert_eq!(db::list_sources(&c).unwrap()[0], s);
}
#[test]
fn automatic_200_empty_past_unknown_and_invalid_times_preserve_last_good_and_validators() {
    let (mut c, s, f) = fixture();
    let s = publish(&mut c, &s, &f);
    let cached = read(&c, &s).unwrap().unwrap();
    let mut empty = f.clone();
    empty.programs.clear();
    let mut past = f.clone();
    past.programs[0].stop_ms = Some(2500);
    let mut unknown = f.clone();
    unknown.programs[0].start_ms = 99999;
    unknown.programs[0].stop_ms = None;
    let mut out_of_range = f.clone();
    out_of_range.programs[0].start_ms = i64::MAX - 1;
    out_of_range.programs[0].stop_ms = Some(i64::MAX);
    let mut mixed_invalid = f.clone();
    mixed_invalid
        .programs
        .push(out_of_range.programs[0].clone());
    for (next, code) in [
        (empty, "guide-empty-confirmation-required"),
        (past, "guide-refresh-no-future-schedule"),
        (unknown, "guide-refresh-no-future-schedule"),
        (out_of_range, "guide-invalid-instant"),
        (mixed_invalid, "guide-invalid-instant"),
    ] {
        let error = db::replace_guide_conditional(
            &mut c,
            &s,
            &next,
            3000,
            &Validators {
                etag: Some("\"rejected\"".into()),
                last_modified: None,
            },
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(error, code);
        assert_eq!(db::list_sources(&c).unwrap()[0], s);
        assert_eq!(
            db::source_coverage(&c, &s.id).unwrap().published_revision,
            Some(s.revision)
        );
        assert_eq!(read(&c, &s).unwrap().unwrap().validators, cached.validators);
        assert_eq!(
            c.query_row("SELECT checked_ms FROM guide_http_cache", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2000
        );
        assert_eq!(
            c.query_row("SELECT title FROM guide_program", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "Actual"
        );
    }
    assert_eq!(
        db::replace_guide_conditional(&mut c, &s, &f, 3000, &validators(), &AtomicBool::new(true))
            .unwrap_err(),
        "canceled"
    );
    assert_eq!(db::list_sources(&c).unwrap()[0], s);
}
#[test]
fn automatic_200_mixed_and_future_known_intervals_admitted_manual_past_unchanged() {
    let (mut c, s, f) = fixture();
    let s = publish(&mut c, &s, &f);
    let mut mixed = f.clone();
    mixed.programs[0].stop_ms = Some(2500);
    let mut future = f.programs[0].clone();
    future.start_ms = 12000;
    future.stop_ms = Some(14000);
    future.title = "Future".into();
    mixed.programs.push(future);
    let revision = db::replace_guide_conditional(
        &mut c,
        &s,
        &mixed,
        3000,
        &validators(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(db::source_coverage(&c, &s.id).unwrap().program_count, 2);
    // Explicit manual import retains its existing ability to publish past data.
    db::replace_guide(&mut c, &s.id, revision, &f, 20000, &AtomicBool::new(false)).unwrap();
    assert_eq!(db::source_coverage(&c, &s.id).unwrap().program_count, 1);
}
#[test]
fn header_and_stored_metadata_bounds_refuse_without_url_errors() {
    for value in ["x\r\nSecret: marker".into(), "x".repeat(1025), "".into()] {
        let invalid = Validators {
            etag: Some(value),
            last_modified: None,
        };
        assert_eq!(invalid.valid().unwrap_err(), "guide-validator-invalid");
    }
    let (mut c, s, f) = fixture();
    let s = publish(&mut c, &s, &f);
    c.execute("UPDATE guide_http_cache SET etag=?1", ["x".repeat(1025)])
        .unwrap();
    assert_eq!(read(&c, &s).unwrap_err(), "guide-database-operation-failed");
}

async fn served(
    status: u16,
    headers: &str,
    body: &[u8],
    cached: Option<&CachedValidators>,
) -> (
    Result<crate::guide::input::ConditionalFetch, String>,
    String,
) {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let response = format!(
        "HTTP/1.1 {status} Fixture\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let body = body.to_vec();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        let mut b = [0; 1];
        while !request.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut b).unwrap();
            request.extend(b);
            assert!(request.len() < 8192);
        }
        stream.write_all(response.as_bytes()).unwrap();
        if !body.is_empty() {
            let _ = stream.write_all(&body);
        }
        String::from_utf8(request).unwrap()
    });
    let result = crate::guide::input::fetch_conditional(
        &format!("http://{address}/guide"),
        true,
        cached,
        &AtomicBool::new(false),
    )
    .await;
    (result, server.join().unwrap())
}
#[tokio::test]
async fn controlled_http_validators_304_no_cache_and_http_error() {
    let (_, s, _) = fixture();
    let cached = CachedValidators {
        fingerprint: fingerprint(&s).unwrap(),
        revision: 1,
        validators: validators(),
    };
    let (result, request) = served(304, "ETag: \"fixture-v1\"\r\n", b"", Some(&cached)).await;
    assert!(matches!(
        result.unwrap(),
        crate::guide::input::ConditionalFetch::NotModified(_)
    ));
    let request = request.to_lowercase();
    assert!(request.contains("if-none-match: \"fixture-v1\""));
    assert!(request.contains("if-modified-since: mon, 12 oct 2026"));
    assert_eq!(
        served(304, "", b"", None).await.0.err().unwrap(),
        "guide-not-modified-without-cache"
    );
    assert_eq!(
        served(503, "", b"", Some(&cached)).await.0.err().unwrap(),
        "http-503"
    );
    // Refuse every conditional redirect before following to another resource;
    // A real listening destination must receive no connection or validator.
    let destination = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    destination.set_nonblocking(true).unwrap();
    let redirect = format!(
        "Location: http://{}/other\r\n",
        destination.local_addr().unwrap()
    );
    assert!(served(302, &redirect, b"", Some(&cached)).await.0.is_err());
    assert_eq!(
        destination.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    let (result, _) = served(200, "ETag: \"new\"\r\n", b"<tv/>", None).await;
    match result.unwrap() {
        crate::guide::input::ConditionalFetch::Body(bytes, v) => {
            assert_eq!(bytes, b"<tv/>");
            assert_eq!(v.etag.as_deref(), Some("\"new\""));
        }
        _ => panic!("Expected body"),
    }
}
#[tokio::test]
async fn pre_cancel_and_cancellation_after_response_headers_do_not_return_body() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    assert_eq!(
        crate::guide::input::fetch_conditional(
            "http://127.0.0.1:1/unused",
            true,
            None,
            &AtomicBool::new(true)
        )
        .await
        .err()
        .unwrap(),
        "canceled"
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let flag = Arc::new(AtomicBool::new(false));
    let server_flag = flag.clone();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut b = [0; 1];
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut b).unwrap();
            request.extend(b);
            assert!(request.len() < 8192)
        }
        server_flag.store(true, Ordering::SeqCst);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n<tv/>")
            .unwrap();
    });
    assert_eq!(
        crate::guide::input::fetch_conditional(
            &format!("http://{address}/guide"),
            true,
            None,
            &flag
        )
        .await
        .err()
        .unwrap(),
        "canceled"
    );
    server.join().unwrap();
}
#[tokio::test]
async fn controlled_200_xml_empty_expired_unknown_and_future_publication() {
    let (mut c, s, f) = fixture();
    let mut s = publish(&mut c, &s, &f);
    let channel = "<channel id=\"a\"><display-name>A</display-name></channel>";
    for (program, expected) in [
        ("", Some("guide-empty-confirmation-required")),
        (
            "<programme channel=\"a\" start=\"19700101000001 +0000\" stop=\"19700101000002 +0000\"><title>Expired</title></programme>",
            Some("guide-refresh-no-future-schedule"),
        ),
        (
            "<programme channel=\"a\" start=\"19700101000012 +0000\"><title>Unknown end</title></programme>",
            Some("guide-refresh-no-future-schedule"),
        ),
        (
            "<programme channel=\"a\" start=\"19700101000012 +0000\" stop=\"19700101000014 +0000\"><title>Known future</title></programme>",
            None,
        ),
    ] {
        let xml = format!("<tv>{channel}{program}</tv>");
        let (result, _) = served(200, "ETag: \"http-candidate\"\r\n", xml.as_bytes(), None).await;
        let crate::guide::input::ConditionalFetch::Body(bytes, validators) = result.unwrap() else {
            panic!("Expected HTTP200 body")
        };
        let parsed = crate::guide::parser::parse_guide(&bytes).unwrap();
        let old = read(&c, &s).unwrap().unwrap();
        let result = db::replace_guide_conditional(&mut c, &s, &parsed, 3000, &validators, &AtomicBool::new(false));
        if let Some(error) = expected {
            assert_eq!(result.unwrap_err(), error);
            assert_eq!(db::list_sources(&c).unwrap()[0], s);
            assert_eq!(read(&c, &s).unwrap().unwrap().validators, old.validators);
            assert_eq!(db::source_coverage(&c, &s.id).unwrap().published_revision, Some(s.revision));
            assert_eq!(
                c.query_row("SELECT title FROM guide_program", [], |r| r.get::<_, String>(0))
                    .unwrap(),
                "Actual"
            );
        } else {
            assert_eq!(result.unwrap(), s.revision + 1);
            s = db::list_sources(&c).unwrap().remove(0);
            assert_eq!(
                c.query_row("SELECT title FROM guide_program", [], |r| r.get::<_, String>(0))
                    .unwrap(),
                "Known future"
            );
        }
    }
}
