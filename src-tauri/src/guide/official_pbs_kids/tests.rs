// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::guide::{database as db, input, parser};
use serde_json::{json, Value};
fn day(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}
fn listing(time: &str, title: &str, episode: &str, minutes: u16) -> Value {
    json!({"title":title,"episode_title":episode,"minutes":minutes,"nola_episode":"000115","nola_root":"XRID","start_time":time})
}
fn body(rows: Vec<Value>) -> Vec<u8> {
    serde_json::to_vec(&json!({"data":{"day0":[{"short_name":"Kids 24/7","listings":rows}]}}))
        .unwrap()
}
fn parsed(date: &str, rows: Vec<Value>) -> parser::ParsedGuide {
    let xml = normalize_days(&body(rows), &[day(date)], &AtomicBool::new(false)).unwrap();
    parser::parse_guide(&xml).unwrap()
}
#[test]
fn official_pbs_national_identity_episode_metadata_minutes_and_midnight() {
    let bytes = include_bytes!("../../../../tests/fixtures/guide/pbs-kids-official-schedule.json");
    let xml = normalize_days(bytes, &[day("2026-11-01")], &AtomicBool::new(false)).unwrap();
    assert!(String::from_utf8(xml.clone())
        .unwrap()
        .contains("<sub-title>I am Mary Leakey &amp; Alexander Hamilton</sub-title>"));
    let feed = parser::parse_guide(&xml).unwrap();
    assert_eq!(feed.channels.len(), 1);
    assert_eq!(feed.channels[0].id, "PBSKids.us@SD");
    assert_eq!(
        feed.programs[0].title,
        "Xavier Riddle and the Secret Museum"
    );
    assert_eq!(
        feed.programs[0].description.as_deref(),
        Some("I am Mary Leakey & Alexander Hamilton")
    );
    assert_eq!(
        feed.programs[0].start_ms,
        parser::parse_timestamp("20261102033000 +0000").unwrap()
    );
    assert_eq!(
        feed.programs[0].stop_ms,
        Some(parser::parse_timestamp("20261102040000 +0000").unwrap())
    );
    assert_eq!(
        feed.programs[1].stop_ms,
        Some(parser::parse_timestamp("20261102053000 +0000").unwrap())
    );
}
#[test]
fn official_pbs_mirrors_published_last_row_precedence_takeover_and_declared_gaps() {
    for (a, b) in [
        ("Superseded", "Publisher winner"),
        ("Publisher winner", "Superseded"),
    ] {
        let feed = parsed(
            "2026-11-02",
            vec![
                listing("0300", a, "first", 60),
                listing("0300", b, "last", 60),
                listing("0330", "Later start", "short", 10),
                listing("0400", "After gap", "next", 30),
            ],
        );
        assert_eq!(feed.programs.len(), 3);
        assert_eq!(feed.programs[0].title, b);
        assert_eq!(feed.programs[0].stop_ms, Some(feed.programs[1].start_ms));
        assert_eq!(
            feed.programs[1].stop_ms,
            Some(feed.programs[1].start_ms + 10 * 60_000)
        );
        assert!(feed.programs[1].stop_ms.unwrap() < feed.programs[2].start_ms);
    }
    assert!(normalize_days(
        &body(vec![
            listing("0400", "A", "", 30),
            listing("0300", "B", "", 30)
        ]),
        &[day("2026-11-02")],
        &AtomicBool::new(false)
    )
    .is_err());
}
#[test]
fn official_pbs_iana_offsets_and_dst_are_not_guessed() {
    let summer = parsed(
        "2026-06-01",
        vec![listing("2230", "Xavier Riddle", "Summer", 30)],
    );
    assert_eq!(
        summer.programs[0].start_ms,
        parser::parse_timestamp("20260602023000 +0000").unwrap()
    );
    for (date, clock) in [("2026-11-01", "0130"), ("2026-03-08", "0230")] {
        assert!(normalize_days(
            &body(vec![listing(
                clock,
                "Xavier Riddle",
                "Unresolved local start",
                30
            )]),
            &[day(date)],
            &AtomicBool::new(false)
        )
        .is_err());
    }
    let spring = parsed(
        "2026-03-08",
        vec![listing("0130", "Known elapsed duration", "", 60)],
    );
    assert_eq!(
        spring.programs[0].stop_ms,
        Some(parser::parse_timestamp("20260308073000 +0000").unwrap())
    );
}
#[test]
fn official_pbs_refuses_invalid_schema_days_feeds_fields_and_limits() {
    let good = body(vec![listing("1430", "Xavier Riddle", "Published", 30)]);
    let baseline: Value = serde_json::from_slice(&good).unwrap();
    for bad in [
        json!({"data":{}}),
        json!({"data":{"day1":baseline["data"]["day0"]}}),
        json!({"data":baseline["data"],"errors":[{"message":"Unavailable"}]}),
        json!({"data":{"day0":[]}}),
        json!({"data":{"day0":[{"short_name":"Regional PBS","listings":[]} ]}}),
    ] {
        assert!(normalize_days(
            &serde_json::to_vec(&bad).unwrap(),
            &[day("2026-11-02")],
            &AtomicBool::new(false)
        )
        .is_err());
    }
    for (field, value) in [
        ("minutes", json!(0)),
        ("minutes", json!(1441)),
        ("minutes", json!("30")),
        ("start_time", json!("2400")),
        ("start_time", json!("2:30")),
        ("title", json!("")),
        ("episode_title", json!("\u{0}")),
        ("other", json!(true)),
    ] {
        let mut changed = baseline.clone();
        changed["data"]["day0"][0]["listings"][0][field] = value;
        assert!(
            normalize_days(
                &serde_json::to_vec(&changed).unwrap(),
                &[day("2026-11-02")],
                &AtomicBool::new(false)
            )
            .is_err(),
            "{field}"
        );
    }
    assert!(normalize_days(
        &vec![b' '; BODY_LIMIT + 1],
        &[day("2026-11-02")],
        &AtomicBool::new(false)
    )
    .is_err());
    assert!(normalize_days(
        &body(vec![listing("1430", "X", "", 30); 129]),
        &[day("2026-11-02")],
        &AtomicBool::new(false)
    )
    .is_err());
    assert!(normalize_days(&good, &[day("2026-11-02")], &AtomicBool::new(true)).is_err());
}
#[test]
fn official_pbs_request_is_fixed_batched_bounded_and_exact_identity_only() {
    let now = parser::parse_timestamp("20261102003000 -0500").unwrap();
    let days = dates(now).unwrap();
    assert_eq!(days.len(), 8);
    assert_eq!(days[0], day("2026-11-02"));
    let request = request_body(&days).unwrap();
    assert!(request.len() <= 4096);
    let request: Value = serde_json::from_slice(&request).unwrap();
    assert_eq!(request["variables"]["station"], "PBSKIDS247");
    assert_eq!(request["variables"]["d7"], "20261109");
    assert_eq!(
        request["query"]
            .as_str()
            .unwrap()
            .matches("tvSchedulesFeeds(")
            .count(),
        8
    );
    assert!(handles(LOCATION));
    for bad in [
        API,
        "http://pbskids.org/videos/watch/live",
        "https://pbskids.org/videos/watch/live/",
        "https://pbskids.org/videos/watch/live?station=regional",
        "https://pbskids.org.evil.invalid/videos/watch/live",
    ] {
        assert!(!handles(bad));
    }
    for good in ["PBSKids.us", "PBSKids.us@SD"] {
        assert!(main_provider(good));
    }
    for bad in [
        "PBSKids.us@HD",
        "PBSKids.us@KERA",
        "USBC3600013PC",
        "pbskids.us",
        "PBS Kids",
    ] {
        assert!(!main_provider(bad));
    }
}
#[tokio::test]
async fn official_pbs_cancel_and_request_bounds_refuse_before_network() {
    assert_eq!(
        fetch(0, &AtomicBool::new(true)).await.unwrap_err(),
        "canceled"
    );
    assert_eq!(
        crate::network::response_pbs_kids_metadata(&[])
            .await
            .unwrap_err(),
        "pbs-request-limit"
    );
    assert_eq!(
        crate::network::response_pbs_kids_metadata(&vec![0; 4097])
            .await
            .unwrap_err(),
        "pbs-request-limit"
    );
}
#[test]
fn official_pbs_native_suggestion_uses_only_saved_nonremoved_national_ids() {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE channel(id TEXT,provider_id TEXT);CREATE TABLE removed(id TEXT);INSERT INTO channel VALUES('a','PBSKids.us@SD'),('b','PBSKids.us'),('region','PBSKids.us@KERA'),('samsung','USBC3600013PC');").unwrap();
    let suggestions = crate::guide::crosswalk_pack::suggestions_from_catalog(&c).unwrap();
    assert_eq!(
        suggestions
            .iter()
            .find(|s| s.location == LOCATION)
            .unwrap()
            .channels,
        2
    );
    c.execute_batch("INSERT INTO removed VALUES('a'),('b')")
        .unwrap();
    assert!(!crate::guide::crosswalk_pack::suggestions_from_catalog(&c)
        .unwrap()
        .iter()
        .any(|s| s.location == LOCATION));
}
fn full_body(now: i64) -> Vec<u8> {
    let data=dates(now).unwrap().iter().enumerate().map(|(i,_)|(format!("day{i}"),json!([{"short_name":"Kids 24/7","listings":[listing("2230","Xavier Riddle and the Secret Museum","I am Mary Leakey/I am Alexander Hamilton",30)]}]))).collect::<serde_json::Map<_,_>>();
    serde_json::to_vec(&json!({"data":data})).unwrap()
}
#[test]
fn official_pbs_existing_worker_cached_connector_and_sqlite_search_need_no_channel_rescan() {
    let now = parser::parse_timestamp("20261102223000 -0500").unwrap();
    let flag = AtomicBool::new(false);
    let body = full_body(now);
    let xml = input::expand_for_source(body.clone(), LOCATION, now, &flag).unwrap();
    let feed = parser::parse_guide(&xml)
        .expect("official publisher JSON must dispatch through its registered adapter");
    let mut c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,revision INTEGER,catalog_revision INTEGER);INSERT INTO metadata VALUES(1,7,7);CREATE TABLE channel(id TEXT PRIMARY KEY,source_id TEXT,provider_id TEXT,name TEXT,category TEXT);INSERT INTO channel VALUES('pbs-row','catalog','PBSKids.us@SD','PBS KIDS','Kids'),('bare','catalog','PBSKids.us','PBS KIDS','Kids'),('regional','catalog','PBSKids.us@KERA','Regional PBS','Kids'),('samsung','catalog','USBC3600013PC','PBS Kids','Kids');CREATE TABLE removed(id TEXT PRIMARY KEY);CREATE TABLE favorite(id TEXT PRIMARY KEY);PRAGMA user_version=1;").unwrap();
    db::migrate(&mut c).unwrap();
    c.execute_batch("PRAGMA user_version=3").unwrap();
    db::migrate_suggestions(&mut c).unwrap();
    db::save_source(
        &mut c,
        &db::GuideSource {
            id: "official-pbs".into(),
            name: "Official PBS KIDS".into(),
            location: LOCATION.into(),
            kind: "url".into(),
            allow_http: false,
            revision: 0,
            updated_ms: None,
        },
        0,
    )
    .unwrap();
    let revision = db::replace_guide(&mut c, "official-pbs", 1, &feed, now, &flag).unwrap();
    let connected = crate::guide::cached_matching::connect(
        &mut c,
        "7",
        &[crate::guide::cached_matching::CachedSource {
            id: "official-pbs".into(),
            location: LOCATION.into(),
            expected_source_revision: revision,
            expected_published_revision: revision,
        }],
        &[],
        &|| false,
    )
    .unwrap();
    assert_eq!(
        (connected.matched, connected.unmatched, connected.ambiguous),
        (2, 2, 0)
    );
    assert!(db::list_mappings(&c)
        .unwrap()
        .iter()
        .all(|m| m.xmltv_channel_id == CHANNEL
            && ["pbs-row", "bare"].contains(&m.app_channel_id.as_str())));
    for search in ["Xavier Riddle", "Mary Leakey"] {
        let q:db::ProgramQuery=serde_json::from_value(json!({"guideSourceId":"official-pbs","appChannelIds":["pbs-row"],"windowStartMs":now-3600000,"windowEndMs":now+3600000,"search":search,"pageSize":50,"cursor":null})).unwrap();
        let result = db::query_programs(&c, &q).unwrap();
        assert_eq!(result.programs.len(), 1, "{search}");
        assert!(result.programs[0].title.contains("Xavier Riddle"));
        let before = c
            .query_row(
                "SELECT revision FROM guide_meta WHERE singleton=1",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap();
        assert!(
            input::expand_for_source(b"{\"errors\":[{}]}".to_vec(), LOCATION, now, &flag).is_err()
        );
        assert_eq!(
            c.query_row(
                "SELECT revision FROM guide_meta WHERE singleton=1",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            before
        );
        assert_eq!(db::query_programs(&c, &q).unwrap().programs.len(), 1);
    }
    assert_eq!(
        c.query_row(
            "SELECT catalog_revision FROM metadata WHERE singleton=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        7
    );
}

#[tokio::test]
#[ignore = "Explicit public PBS KIDS API diagnostic; run with --ignored --nocapture"]
async fn official_pbs_kids_live_api_smoke() {
    use sha2::{Digest, Sha256};
    let now = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap();
    let flag = AtomicBool::new(false);
    let bytes = fetch(now, &flag).await.unwrap();
    let xml = input::expand_for_source(bytes.clone(), LOCATION, now, &flag).unwrap();
    let feed = parser::parse_guide(&xml).unwrap();
    crate::guide::refresh::admit_schedule(&feed, now, &flag).unwrap();
    assert_eq!(feed.channels.len(), 1);
    assert_eq!(feed.channels[0].id, CHANNEL);
    assert!(feed
        .programs
        .iter()
        .any(|p| p.title.contains("Xavier Riddle") && p.stop_ms.is_some_and(|end| end > now)));
    println!(
        "{}",
        json!({"status":"PASS_PUBLIC_PBS_METADATA_ONLY","anchorMs":now,"endpoint":API,"dates":dates(now).unwrap().iter().map(ToString::to_string).collect::<Vec<_>>(),"bodyBytes":bytes.len(),"bodySha256":format!("{:x}",Sha256::digest(&bytes)),"programmes":feed.programs.len(),"channel":CHANNEL,"ianaTzdb":chrono_tz::IANA_TZDB_VERSION})
    );
}
