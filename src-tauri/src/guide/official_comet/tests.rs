// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::guide::parser;
use std::sync::atomic::AtomicBool;

fn day(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
}

fn one(date: &str, clocks: &[&str]) -> Vec<u8> {
    let mut html = format!(
        "<h1 class='print-heading'>{}</h1>",
        day(date).format("%B %-d, %Y")
    );
    for (index, clock) in clocks.iter().enumerate() {
        html.push_str(&format!("<div class='row single-show'><div class='time'><div>{clock} Eastern Pacific</div><div>8 PM CT</div><div>10 PM MT</div></div><h2 class='title'><a href='https://comettv.com/show/the-x-files/'>The X-Files</a><small class='episode-title'><a href='https://comettv.com/program/fixture/'>Episode {index}</a></small></h2><div class='description'>Synthetic &amp; safe description.</div></div>"));
    }
    serde_json::to_vec(&serde_json::json!({"html":{date:html}})).unwrap()
}

fn parsed(date: &str, bytes: &[u8]) -> Result<parser::ParsedGuide, String> {
    let xml = normalize_days(bytes, &[day(date)], &AtomicBool::new(false))?;
    parser::parse_guide(&xml)
}

#[test]
fn official_comet_api_fragment_normalizes_exact_main_identity_and_midnight() {
    let feed = parsed(
        "2026-11-01",
        &one("2026-11-01", &["9 PM", "10 PM", "11 PM", "12 AM"]),
    )
    .unwrap();
    assert_eq!(
        feed.channels
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        ["Comet.us@SD"]
    );
    let rows: Vec<_> = feed
        .programs
        .iter()
        .filter(|p| p.channel_id == "Comet.us@SD")
        .collect();
    assert_eq!(rows.len(), 4);
    assert_eq!(
        rows[1].start_ms,
        parser::parse_timestamp("20261101220000 -0500").unwrap()
    );
    assert_eq!(
        rows[1].stop_ms,
        Some(parser::parse_timestamp("20261101230000 -0500").unwrap())
    );
    assert_eq!(
        rows[3].start_ms,
        parser::parse_timestamp("20261102000000 -0500").unwrap()
    );
    assert_eq!(rows[3].stop_ms, None);
    assert_eq!(rows[0].title, "The X-Files — Episode 0");
    assert_eq!(
        rows[0].description.as_deref(),
        Some("Synthetic & safe description.")
    );
}

#[test]
fn official_comet_iana_summer_offset_and_fall_spring_refusal() {
    let summer = parsed("2026-06-01", &one("2026-06-01", &["10 PM", "11 PM"])).unwrap();
    assert_eq!(
        summer.programs[0].start_ms,
        parser::parse_timestamp("20260601220000 -0400").unwrap()
    );
    assert!(parsed(
        "2026-10-31",
        &one("2026-10-31", &["11 PM", "1:30 AM", "3 AM"])
    )
    .is_err());
    assert!(parsed(
        "2026-03-07",
        &one("2026-03-07", &["11 PM", "2:30 AM", "3 AM"])
    )
    .is_err());
}

#[test]
fn official_comet_raw_publisher_fragment_contract_is_supported() {
    let body = include_bytes!("../../../../tests/fixtures/guide/comet-official-fragment.json");
    let feed = parsed("2026-11-01", body).unwrap();
    assert_eq!(feed.programs.len(), 3);
    assert!(feed
        .programs
        .iter()
        .any(|p| p.title == "The X-Files — Dreamland"));
}

#[test]
fn official_comet_strict_source_identity_request_bounds_and_cancel() {
    assert!(handles(LOCATION));
    for bad in [
        "http://comettv.com/schedule/",
        "https://comettv.com.evil.invalid/schedule/",
        "https://comettv.com/schedule/?x=1",
        API,
    ] {
        assert!(!handles(bad));
    }
    assert!(main_provider("Comet.us"));
    assert!(main_provider("Comet.us@SD"));
    for bad in ["Comet.us@HD", "Comet.us@KATU", "comet.us", "Comet"] {
        assert!(!main_provider(bad));
    }
    let now = parser::parse_timestamp("20261102003000 -0500").unwrap();
    let request = reqwest::Url::parse(&request_url(now).unwrap()).unwrap();
    let params: std::collections::HashMap<_, _> = request.query_pairs().collect();
    assert_eq!(params["timezone"], "America/New_York");
    assert_eq!(params["days"].split(',').count(), 8);
    assert!(params["days"].starts_with("2026-11-01,2026-11-02,"));
    assert!(normalize_days(
        &one("2026-11-01", &["10 PM"]),
        &[day("2026-11-01")],
        &AtomicBool::new(true)
    )
    .is_err());
}

#[test]
fn official_comet_refuses_bad_shape_rows_clock_order_and_limits() {
    let original = one("2026-11-01", &["10 PM", "11 PM"]);
    for bad in [
        b"{\"html\":{}}".to_vec(),
        b"{\"html\":{},\"other\":true}".to_vec(),
        vec![b' '; BODY_LIMIT + 1],
        one("2026-11-02", &["10 PM", "11 PM"]),
        one("2026-11-01", &["10 PM", "10 PM"]),
        one("2026-11-01", &["9 AM", "8 AM"]),
        one("2026-11-01", &["11 PM", "1 AM", "1 PM"]),
        one("2026-11-01", &["9 PM<script>"]),
    ] {
        assert!(parsed("2026-11-01", &bad).is_err());
    }
    let source = String::from_utf8(original).unwrap();
    for (from, to) in [
        ("Eastern Pacific", "Eastern"),
        ("November 1, 2026", "November 2, 2026"),
        ("class='title'", "class='other'"),
        (
            "Synthetic &amp; safe description.",
            "<script>unsafe</script>",
        ),
    ] {
        let changed = source.replace(from, to);
        assert!(parsed("2026-11-01", changed.as_bytes()).is_err(), "{from}");
    }
    let many: Vec<_> = std::iter::repeat_n("10 PM", 129).collect();
    assert!(parsed("2026-11-01", &one("2026-11-01", &many)).is_err());
}

#[test]
fn official_comet_previous_broadcast_day_is_only_needed_during_overnight_am() {
    let am = parser::parse_timestamp("20261102003000 -0500").unwrap();
    assert_eq!(dates(am).unwrap()[0], day("2026-11-01"));
    let pm = parser::parse_timestamp("20261101223000 -0500").unwrap();
    assert_eq!(dates(pm).unwrap()[0], day("2026-11-01"));
    assert_eq!(dates(pm).unwrap().len(), 8);
}

#[test]
fn official_comet_native_suggestion_uses_only_saved_nonremoved_published_main_ids() {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE channel(id TEXT,provider_id TEXT);CREATE TABLE removed(id TEXT);INSERT INTO channel VALUES('a','Comet.us@SD'),('b','Comet.us'),('regional','Comet.us@KATU'),('foreign','Comet.us@HD');").unwrap();
    let suggestions = crate::guide::crosswalk_pack::suggestions_from_catalog(&c).unwrap();
    let comet = suggestions.iter().find(|s| s.location == LOCATION).unwrap();
    assert_eq!(comet.channels, 2);
    c.execute_batch("INSERT INTO removed VALUES('a'),('b')")
        .unwrap();
    assert!(!crate::guide::crosswalk_pack::suggestions_from_catalog(&c)
        .unwrap()
        .iter()
        .any(|s| s.location == LOCATION));
}

#[test]
fn official_comet_existing_source_worker_and_sqlite_cache_supply_title_search_without_channel_rescan(
) {
    use crate::guide::{database as db, input};
    let date = "2026-11-01";
    let now = parser::parse_timestamp("20261101223000 -0500").unwrap();
    let first =
        serde_json::from_slice::<serde_json::Value>(&one(date, &["9 PM", "10 PM", "11 PM"]))
            .unwrap();
    let mut html = serde_json::Map::new();
    for value in dates(now).unwrap() {
        html.insert(value.to_string(), serde_json::Value::String(String::new()));
    }
    html.insert(date.into(), first["html"][date].clone());
    let body = serde_json::to_vec(&serde_json::json!({"html":html})).unwrap();
    let flag = AtomicBool::new(false);
    assert!(parser::parse_guide(&body).is_err());
    let xml = input::expand_for_source(body.clone(), LOCATION, now, &flag).unwrap();
    let feed = parser::parse_guide(&xml).unwrap();
    assert_eq!(
        input::expand_for_source(
            body.clone(),
            "https://fixture.invalid/ordinary.xml",
            now,
            &flag
        )
        .unwrap(),
        body
    );
    let mut c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,revision INTEGER,catalog_revision INTEGER);INSERT INTO metadata VALUES(1,7,7);CREATE TABLE channel(id TEXT PRIMARY KEY,source_id TEXT,provider_id TEXT,name TEXT,category TEXT);INSERT INTO channel VALUES('comet-row','catalog','Comet.us@SD','COMET','Entertainment'),('bare','catalog','Comet.us','COMET','Entertainment'),('regional','catalog','Comet.us@KATU','COMET Portland','Entertainment');CREATE TABLE removed(id TEXT PRIMARY KEY);CREATE TABLE favorite(id TEXT PRIMARY KEY);PRAGMA user_version=1;").unwrap();
    db::migrate(&mut c).unwrap();
    c.execute_batch("PRAGMA user_version=3").unwrap();
    db::migrate_suggestions(&mut c).unwrap();
    db::save_source(
        &mut c,
        &db::GuideSource {
            id: "official-comet".into(),
            name: "Official COMET".into(),
            location: LOCATION.into(),
            kind: "url".into(),
            allow_http: false,
            revision: 0,
            updated_ms: None,
        },
        0,
    )
    .unwrap();
    let revision = db::replace_guide(&mut c, "official-comet", 1, &feed, now, &flag).unwrap();
    let connection = crate::guide::cached_matching::connect(
        &mut c,
        "7",
        &[crate::guide::cached_matching::CachedSource {
            id: "official-comet".into(),
            location: LOCATION.into(),
            expected_source_revision: revision,
            expected_published_revision: revision,
        }],
        &[],
        &|| false,
    )
    .unwrap();
    assert_eq!(
        (
            connection.matched,
            connection.unmatched,
            connection.ambiguous
        ),
        (2, 1, 0)
    );
    let mappings = db::list_mappings(&c).unwrap();
    assert_eq!(mappings.len(), 2);
    assert!(mappings
        .iter()
        .all(|m| m.xmltv_channel_id == "Comet.us@SD" && m.app_channel_id != "regional"));
    let q:db::ProgramQuery=serde_json::from_value(serde_json::json!({"guideSourceId":"official-comet","appChannelIds":["comet-row"],"windowStartMs":now-2*3600000_i64,"windowEndMs":now+3600000_i64,"search":"X-Files","pageSize":100,"cursor":null})).unwrap();
    let result = db::query_programs(&c, &q).unwrap();
    assert_eq!(result.programs.len(), 3);
    assert!(result
        .programs
        .iter()
        .all(|p| p.app_channel_id == "comet-row" && p.title.contains("The X-Files")));
    assert_eq!(
        c.query_row(
            "SELECT catalog_revision FROM metadata WHERE singleton=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        7
    );
    let read_revision = |c: &rusqlite::Connection| {
        c.query_row(
            "SELECT revision FROM guide_meta WHERE singleton=1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
    };
    let previous = read_revision(&c);
    assert!(input::expand_for_source(b"bad JSON".to_vec(), LOCATION, now, &flag).is_err());
    assert_eq!(read_revision(&c), previous);
    assert_eq!(db::query_programs(&c, &q).unwrap().programs.len(), 3);
}

/// Explicit diagnostic, not an implicit Internet dependency of ordinary unit CI.
#[tokio::test]
#[ignore = "Explicit public COMET API smoke; run with --ignored --nocapture"]
async fn official_comet_live_api_smoke() {
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
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let xml = crate::guide::input::expand_for_source(bytes.clone(), LOCATION, now, &flag).unwrap();
    let feed = parser::parse_guide(&xml).unwrap();
    crate::guide::refresh::admit_schedule(&feed, now, &flag).unwrap();
    assert_eq!(feed.channels.len(), 1);
    assert_eq!(feed.channels[0].id, "Comet.us@SD");
    assert!(feed
        .programs
        .iter()
        .any(|p| p.stop_ms.is_some_and(|end| end > now)));
    println!(
        "{}",
        serde_json::json!({"status":"PASS_LIVE_PUBLIC_METADATA_ONLY","anchorMs":now,"requestUrl":request_url(now).unwrap(),"bodyBytes":bytes.len(),"bodySha256":digest,"normalizedXmlBytes":xml.len(),"programmes":feed.programs.len(),"channel":"Comet.us@SD","knownFutureIntervals":feed.programs.iter().filter(|p|p.stop_ms.is_some_and(|end|end>now)).count(),"firstStartMs":feed.programs.iter().map(|p|p.start_ms).min(),"lastStartMs":feed.programs.iter().map(|p|p.start_ms).max(),"ianaTzdb":chrono_tz::IANA_TZDB_VERSION})
    );
}
