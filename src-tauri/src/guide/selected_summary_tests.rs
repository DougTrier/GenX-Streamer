use super::*;
use crate::guide::parser::{GuideChannel, GuideProgram, ParsedGuide};
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
fn fixture() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,revision INTEGER,catalog_revision INTEGER);INSERT INTO metadata VALUES(1,42,7);CREATE TABLE source(id TEXT PRIMARY KEY);INSERT INTO source VALUES('catalog');CREATE TABLE channel(id TEXT PRIMARY KEY,source_id TEXT);INSERT INTO channel VALUES('app','catalog');CREATE TABLE removed(id TEXT PRIMARY KEY);PRAGMA user_version=1;").unwrap();
    migrate(&mut c).unwrap();
    c.execute_batch("PRAGMA user_version=3").unwrap();
    migrate_suggestions(&mut c).unwrap();
    c
}
fn query() -> SummaryQuery {
    SummaryQuery {
        catalog_source_id: "catalog".into(),
        app_channel_id: "app".into(),
        at_ms: 5000,
        request_id: "summary-test".into(),
    }
}
fn program(start: i64, stop: Option<i64>, title: &str) -> GuideProgram {
    GuideProgram {
        channel_id: "xml".into(),
        start_ms: start,
        stop_ms: stop,
        title: title.into(),
        description: None,
        categories: Vec::new(),
    }
}
fn install(c: &mut Connection, programs: Vec<GuideProgram>) {
    let source = GuideSource {
        id: "guide".into(),
        name: "Fixture".into(),
        location: "https://fixture.invalid/guide".into(),
        kind: "url".into(),
        allow_http: false,
        revision: 0,
        updated_ms: None,
    };
    save_source(c, &source, 0).unwrap();
    replace_guide(
        c,
        "guide",
        1,
        &ParsedGuide {
            channels: vec![GuideChannel {
                id: "xml".into(),
                names: vec!["Fixture".into()],
            }],
            programs,
        },
        6000,
        &std::sync::atomic::AtomicBool::new(false),
    )
    .unwrap();
    save_mapping(
        c,
        &GuideMapping {
            catalog_source_id: "catalog".into(),
            app_channel_id: "app".into(),
            guide_source_id: "guide".into(),
            xmltv_channel_id: "xml".into(),
        },
    )
    .unwrap();
}
fn read(c: &Connection) -> SelectedSummary {
    selected_summary(c, &query(), Arc::new(|| false)).unwrap()
}
#[test]
fn complete_current_and_next_groups_do_not_infer_from_page_fifty() {
    let mut c = fixture();
    let mut programs = (0..75)
        .map(|i| program(1000 + i, Some(9000), &format!("Overlap {i}")))
        .collect::<Vec<_>>();
    programs.extend([
        program(6000, None, "First next"),
        program(6000, Some(7000), "Concurrent next"),
    ]);
    install(&mut c, programs);
    let result = read(&c);
    assert_eq!(result.current_status, Some("overlap"));
    assert!(result.current.is_none());
    assert_eq!(result.next_status, Some("overlap"));
    assert!(result.next.is_none());
    assert_eq!(result.catalog_revision, "7");
    assert_eq!(result.request_id, "summary-test");
}
#[test]
fn semantic_duplicates_unknown_history_and_future_context_are_exact() {
    let mut c = fixture();
    let p = program(1000, None, "Unknown");
    install(
        &mut c,
        vec![p.clone(), p, program(6000, Some(7000), "Future")],
    );
    assert_eq!(read(&c).current_status, Some("unknown-end"));
    assert!(read(&c).current.is_none());
    assert_eq!(read(&c).next.as_ref().unwrap().title, "Future");
    c.execute("INSERT INTO guide_program(guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,description,search_text) VALUES('guide',99,'xml',2000,3000,'Historical known',NULL,'known')",[]).unwrap();
    assert_eq!(read(&c).current_status, Some("gap"));
    c.execute(
        "INSERT INTO guide_program(guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,description,search_text) VALUES('guide',100,'xml',4000,5500,'Current',NULL,'current')",
        [],
    )
    .unwrap();
    let result = read(&c);
    assert_eq!(result.current_status, Some("current"));
    assert_eq!(result.current.unwrap().title, "Current");
}
#[test]
fn mapping_removed_scope_missing_feed_and_stale_cache_are_explicit() {
    let mut c = fixture();
    assert_eq!(read(&c).mapping_status, "unmapped");
    install(&mut c, vec![program(4000, Some(5500), "Current")]);
    c.execute(
        "UPDATE guide_source SET revision=revision+1 WHERE id='guide'",
        [],
    )
    .unwrap();
    let result = read(&c);
    assert_eq!(result.cache_status, "stale");
    assert_eq!(result.published_revision, Some(2));
    let mut wrong = query();
    wrong.catalog_source_id = "other".into();
    assert_eq!(
        selected_summary(&c, &wrong, Arc::new(|| false))
            .unwrap()
            .mapping_status,
        "channel-unavailable"
    );
    c.execute("INSERT INTO removed VALUES('app')", []).unwrap();
    assert_eq!(read(&c).mapping_status, "channel-unavailable");
    c.execute("DELETE FROM removed", []).unwrap();
    c.execute("DELETE FROM guide_source WHERE id='guide'", [])
        .unwrap();
    let result = read(&c);
    assert_eq!(result.mapping_status, "source-unavailable");
    assert!(result.mapping.is_some());
    assert!(result.current_status.is_none());
}
#[test]
fn bounded_vm_cancellation_removes_handler_before_connection_reuse() {
    let mut c = fixture();
    install(&mut c, vec![program(4000, Some(5500), "Current")]);
    c.execute_batch("WITH RECURSIVE n(x) AS(SELECT 100 UNION ALL SELECT x+1 FROM n WHERE x<30000) INSERT INTO guide_program(guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,description,search_text) SELECT 'guide',x,'xml',100000+x,100001+x,'Future',NULL,'future' FROM n").unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let result = selected_summary(
        &c,
        &query(),
        Arc::new(move || observed.fetch_add(1, AtomicOrdering::SeqCst) >= 20),
    );
    assert_eq!(result.unwrap_err(), "canceled");
    assert!(calls.load(AtomicOrdering::SeqCst) >= 20);
    // If the still-true cancellation handler leaked, this VM scan would be interrupted.
    let count: i64 = c
        .query_row("SELECT sum(ordinal) FROM guide_program", [], |r| r.get(0))
        .unwrap();
    assert!(count > 1_000_000);
    assert_eq!(read(&c).current.unwrap().title, "Current");
}
#[test]
fn scope_validation_precancel_and_complete_reply_byte_cap_refuse_whole_result() {
    let mut c = fixture();
    install(&mut c, vec![program(4000, Some(5500), "Current")]);
    assert_eq!(
        selected_summary(&c, &query(), Arc::new(|| true)).unwrap_err(),
        "canceled"
    );
    let mut q = query();
    q.request_id = "bad control\n".into();
    assert!(selected_summary(&c, &q, Arc::new(|| false)).is_err());
    // Valid bounded identifiers/title can still escape to a large JSON response: refuse it whole.
    let big = "\\".repeat(16_384);
    c.execute_batch("BEGIN;PRAGMA defer_foreign_keys=ON;")
        .unwrap();
    c.execute("UPDATE channel SET id=?1", [&big]).unwrap();
    c.execute("UPDATE guide_channel SET id=?1", [&big]).unwrap();
    c.execute("UPDATE guide_channel_name SET channel_id=?1", [&big])
        .unwrap();
    c.execute(
        "UPDATE guide_mapping SET app_channel_id=?1,xmltv_channel_id=?1",
        [&big],
    )
    .unwrap();
    c.execute("UPDATE guide_program SET channel_id=?1,title=?1", [&big])
        .unwrap();
    c.execute(
        "INSERT INTO guide_program(guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,description,search_text) VALUES('guide',1,?1,6000,7000,?1,NULL,'next')",
        [&big],
    )
    .unwrap();
    c.execute_batch("COMMIT").unwrap();
    q = query();
    q.app_channel_id = big;
    assert_eq!(
        selected_summary(&c, &q, Arc::new(|| false)).unwrap_err(),
        "guide-summary-byte-limit"
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM guide_program", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}
#[test]
fn canonical_mapping_source_program_and_revisions_share_one_actual_snapshot() {
    let mut initial = fixture();
    install(&mut initial, vec![program(4000, Some(5500), "Original")]);
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("summary.sqlite3");
    initial
        .execute("VACUUM INTO ?1", [path.to_str().unwrap()])
        .unwrap();
    let reader = Connection::open(&path).unwrap();
    reader.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    let writer = std::sync::Mutex::new(Connection::open(&path).unwrap());
    let count = AtomicUsize::new(0);
    let result=selected_summary(&reader,&query(),Arc::new(move || {
        // First check precedes BEGIN; second occurs after catalog/global revision reads.
        if count.fetch_add(1,AtomicOrdering::SeqCst)==1 {
            writer.lock().unwrap().execute_batch("BEGIN IMMEDIATE;UPDATE metadata SET revision=99,catalog_revision=8;UPDATE guide_source SET revision=revision+1;UPDATE guide_program SET title='Changed';COMMIT;").unwrap();
        }
        false
    })).unwrap();
    assert_eq!(result.catalog_revision, "7");
    assert_eq!(result.source_revision, Some(2));
    assert_eq!(result.cache_status, "current");
    assert_eq!(result.current.unwrap().title, "Original");
    assert_eq!(
        reader
            .query_row("SELECT revision FROM metadata", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        99
    );
    assert_eq!(read(&reader).current.unwrap().title, "Changed");
}

#[test]
fn actual_canonical_store_preferences_and_health_do_not_change_summary_catalog_revision() {
    let root = tempfile::tempdir().unwrap();
    let store = crate::storage_transaction::PairStore::new(root.path().into()).unwrap();
    let catalog = serde_json::json!({"schemaVersion":1,"sources":[{"id":"catalog","name":"Fixture","kind":"file","location":"fixture.m3u"}],"channels":[{"id":"app","sourceId":"catalog","name":"Channel","category":"Sports","urls":["https://example.invalid/live"]}]});
    let mut prefs = serde_json::json!({"schemaVersion":1,"sources":catalog["sources"],"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":300});
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    store
        .with_guide_write(|c| {
            install(c, vec![program(4000, Some(5500), "Current")]);
            Ok(())
        })
        .unwrap();
    let original = store.read_snapshot().unwrap();
    let global_before: i64 = store
        .with_guide_read(|c| {
            Ok(
                c.query_row("SELECT revision FROM metadata", [], |r| r.get(0))
                    .unwrap(),
            )
        })
        .unwrap();
    prefs["muted"] = serde_json::json!(false);
    store.write("preferences", &prefs.to_string()).unwrap();
    let global_after_preferences: i64 = store
        .with_guide_read(|c| {
            Ok(
                c.query_row("SELECT revision FROM metadata", [], |r| r.get(0))
                    .unwrap(),
            )
        })
        .unwrap();
    assert_eq!(global_after_preferences, global_before + 1);
    let fingerprint =
        crate::health_storage::fingerprint(&catalog["sources"][0], &catalog["channels"][0], 0)
            .unwrap();
    let health=serde_json::json!({"schemaVersion":1,"records":[{"schemaVersion":1,"channelId":"app","sourceId":"catalog","checkedUrlOrdinal":0,"targetFingerprint":fingerprint,"platform":"windows","observerProfile":"native-mse-v1","observedAt":100,"verdict":"Reachable","evidence":{"kind":"http","status":200,"contentRecognized":true},"origin":"local"}]}).to_string();
    let before_health = store.read_snapshot().unwrap();
    store
        .write_health_guarded(
            &health,
            &before_health.catalog_revision,
            &before_health.health_revision,
            || Ok(()),
        )
        .unwrap();
    let latest = store.read_snapshot().unwrap();
    assert_eq!(latest.catalog_revision, original.catalog_revision);
    assert_ne!(latest.health_revision, original.health_revision);
    let summary = store
        .with_guide_read(|c| selected_summary(c, &query(), Arc::new(|| false)))
        .unwrap();
    assert_eq!(summary.catalog_revision, latest.catalog_revision);
    assert_eq!(summary.current.unwrap().title, "Current");
    let global_after: i64 = store
        .with_guide_read(|c| {
            Ok(
                c.query_row("SELECT revision FROM metadata", [], |r| r.get(0))
                    .unwrap(),
            )
        })
        .unwrap();
    assert_eq!(global_after, global_after_preferences); // Dedicated health writes advance only health_revision.
}

#[path = "visible_summary_tests.rs"]
mod visible;

#[test]
fn differing_actual_categories_are_overlap_while_normalized_equivalents_share_identity() {
    use crate::guide::category::GuideCategory;
    use std::sync::atomic::AtomicBool;
    let mut c = fixture();
    let mut one = program(4000, Some(6000), "Same title");
    one.categories = vec![GuideCategory {
        text: "Action".into(),
        language: None,
    }];
    let mut equivalent = one.clone();
    equivalent.categories[0].text = "ＡＣＴＩＯＮ".into();
    install(&mut c, vec![one.clone(), equivalent]);
    assert_eq!(
        selected_summary(&c, &query(), Arc::new(|| false))
            .unwrap()
            .current_status,
        Some("current")
    );
    let mut different = one.clone();
    different.categories[0].text = "Drama".into();
    let feed = ParsedGuide {
        channels: vec![GuideChannel {
            id: "xml".into(),
            names: vec!["Fixture".into()],
        }],
        programs: vec![one, different],
    };
    replace_guide(&mut c, "guide", 2, &feed, 7000, &AtomicBool::new(false)).unwrap();
    let value = selected_summary(&c, &query(), Arc::new(|| false)).unwrap();
    assert_eq!(value.current_status, Some("overlap"));
    assert!(value.current.is_none());
}
