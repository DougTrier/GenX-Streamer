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
use rusqlite::types::Value;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn fixture(indexed: bool) -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE scan_manifest(id TEXT PRIMARY KEY); INSERT INTO scan_manifest VALUES('m'); CREATE TABLE scan_manifest_namespace(singleton INTEGER PRIMARY KEY,schema_version INTEGER); INSERT INTO scan_manifest_namespace VALUES(1,1); CREATE TABLE source_snapshot_namespace(singleton INTEGER PRIMARY KEY,schema_version INTEGER); INSERT INTO source_snapshot_namespace VALUES(1,2);").unwrap();
    c.execute_batch(TABLE).unwrap();
    c.execute_batch(SOURCE_TABLE).unwrap();
    if indexed {
        install_index(&c).unwrap();
    }
    c
}
fn source(c: &Connection, id: Value, revision: Value) {
    c.execute(
        "INSERT INTO source_snapshot_source VALUES(?1,?2,'{}','p','windows','p',0)",
        params![id, revision],
    )
    .unwrap();
}
fn row(c: &Connection, manifest: &str, ordinal: usize, id: Value, revision: Value) {
    c.execute(
        "INSERT INTO source_activation_row VALUES(?1,?2,?3,'entry',?4)",
        params![manifest, ordinal as i64, id, revision],
    )
    .unwrap();
}
fn text(s: &str) -> Value {
    Value::Text(s.into())
}
fn agrees(c: &Connection, expected: bool) {
    assert_eq!(original(c, "m").unwrap(), expected, "baseline");
    assert_eq!(stale(c, "m").unwrap(), expected, "indexed");
}
#[test]
fn healthy_empty_first_last_and_manifest_bounds_match_original() {
    let c = fixture(true);
    agrees(&c, false);
    for (i, id) in ["", "a", "z", "\u{10ffff}"].iter().enumerate() {
        source(&c, text(id), Value::Integer(1));
        row(&c, "m", i, text(id), text("1"));
    }
    c.execute("INSERT INTO scan_manifest VALUES('other')", [])
        .unwrap();
    row(&c, "other", 0, text("missing"), text("9"));
    agrees(&c, false);
    c.execute(
        "UPDATE source_activation_row SET source_revision='2' WHERE manifest_id='m' AND ordinal=3",
        [],
    )
    .unwrap();
    agrees(&c, true);
    c.execute(
        "UPDATE source_activation_row SET source_revision='1' WHERE manifest_id='m'",
        [],
    )
    .unwrap();
    c.execute(
        "UPDATE source_activation_row SET source_revision='0' WHERE manifest_id='m' AND ordinal=0",
        [],
    )
    .unwrap();
    agrees(&c, true);
}
#[test]
fn separate_revision_extrema_catch_late_wrong_and_missing_current_source() {
    let c = fixture(true);
    source(&c, text("s"), Value::Integer(1));
    c.execute_batch("BEGIN").unwrap();
    for i in 0..65000 {
        row(
            &c,
            "m",
            i,
            text("s"),
            text(if i == 64999 { "01" } else { "1" }),
        );
    }
    c.execute_batch("COMMIT").unwrap();
    agrees(&c, true);
    c.execute("UPDATE source_activation_row SET source_revision='1'", [])
        .unwrap();
    agrees(&c, false);
    c.execute("DELETE FROM source_snapshot_source", []).unwrap();
    agrees(&c, true);
}
#[test]
fn supported_affinity_and_blob_values_preserve_sql_comparisons() {
    for current in [
        Value::Integer(1),
        Value::Real(1.0),
        text("01"),
        Value::Blob(b"1".to_vec()),
    ] {
        for revision in [
            Value::Integer(1),
            Value::Real(1.0),
            text("1"),
            text("01"),
            Value::Blob(b"1".to_vec()),
        ] {
            let c = fixture(true);
            source(&c, text("s"), current.clone());
            row(&c, "m", 0, text("s"), revision);
            assert_eq!(stale(&c, "m").unwrap(), original(&c, "m").unwrap());
        }
    }
    let c = fixture(true);
    source(&c, Value::Blob(b"s".to_vec()), Value::Integer(1));
    row(&c, "m", 0, Value::Blob(b"s".to_vec()), text("1"));
    agrees(&c, false);
    row(&c, "m", 1, text("s"), text("1"));
    agrees(&c, true);
    let c = fixture(true);
    source(&c, text("s"), Value::Integer(1));
    row(&c, "m", 0, text("s"), text("1"));
    row(&c, "m", 1, text("s"), Value::Blob(b"1".to_vec()));
    agrees(&c, true);
}
#[test]
fn nullable_and_typeless_legacy_schema_falls_back_without_repair() {
    let c = fixture(false);
    c.execute_batch("DROP TABLE source_activation_row;CREATE TABLE source_activation_row(manifest_id,ordinal,source_id,entry_id,source_revision);CREATE INDEX source_activation_revision_guard_v1 ON source_activation_row(manifest_id,source_id,source_revision);").unwrap();
    source(&c, text("s"), Value::Integer(1));
    row(&c, "m", 0, text("s"), Value::Null);
    agrees(&c, false);
    row(&c, "m", 1, text("s"), Value::Integer(1));
    row(&c, "m", 2, text("s"), text("1"));
    row(&c, "m", 3, text("s"), text("01"));
    agrees(&c, true);
    c.execute("DELETE FROM source_activation_row", []).unwrap();
    row(&c, "m", 0, Value::Null, text("1"));
    agrees(&c, true);
    assert_eq!(install_index(&c).unwrap_err(), INVALID);
    c.execute_batch("DELETE FROM source_activation_row;DROP TABLE source_snapshot_source;CREATE TABLE source_snapshot_source(source_id TEXT PRIMARY KEY,revision,definition,permission,platform,profile,refreshed_ms);INSERT INTO source_snapshot_source VALUES('s',NULL,'{}','p','windows','p',0);").unwrap();
    row(&c, "m", 0, text("s"), text("1"));
    agrees(&c, true);
}
#[test]
fn absent_index_read_is_legacy_readonly_and_unknown_index_is_not_repaired() {
    let c = fixture(false);
    source(&c, text("s"), Value::Integer(1));
    row(&c, "m", 0, text("s"), text("1"));
    let before = c.total_changes();
    agrees(&c, false);
    assert_eq!(c.total_changes(), before);
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name=?1",
            [INDEX],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    c.execute_batch(
        "CREATE INDEX source_activation_revision_guard_v1 ON source_activation_row(source_id)",
    )
    .unwrap();
    agrees(&c, false);
    assert_eq!(install_index(&c).unwrap_err(), INVALID);
    let definition: String = c
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name=?1",
            [INDEX],
            |r| r.get(0),
        )
        .unwrap();
    assert!(definition.ends_with("(source_id)"));
}
#[test]
fn install_refuses_future_namespace_without_creating_index() {
    let c = fixture(false);
    c.execute("UPDATE source_snapshot_namespace SET schema_version=9", [])
        .unwrap();
    assert_eq!(install_index(&c).unwrap_err(), INVALID);
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name=?1",
            [INDEX],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}
fn steps(c: &Connection, run: impl FnOnce() -> bool) -> usize {
    let counter = Arc::new(AtomicUsize::new(0));
    let owned = counter.clone();
    c.progress_handler(
        1,
        Some(move || {
            owned.fetch_add(1, Ordering::Relaxed);
            false
        }),
    )
    .unwrap();
    assert!(!run());
    c.progress_handler(0, None::<fn() -> bool>).unwrap();
    counter.load(Ordering::Relaxed)
}
fn populate(c: &Connection, count: usize, sources: usize) {
    c.execute_batch("BEGIN").unwrap();
    for i in 0..sources {
        source(c, text(&format!("source-{i:03}")), Value::Integer(1));
    }
    for i in 0..count {
        row(
            c,
            "m",
            i,
            text(&format!("source-{:03}", i % sources)),
            text("1"),
        );
    }
    c.execute_batch("COMMIT").unwrap();
}
#[test]
fn healthy_vm_work_scales_with_sources_not_candidate_count_and_index_cost_is_measured() {
    let small = fixture(true);
    populate(&small, 1000, 1);
    let small_steps = steps(&small, || stale(&small, "m").unwrap());
    let large = fixture(false);
    populate(&large, 65000, 1);
    let pages_before: i64 = large
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap();
    install_index(&large).unwrap();
    let pages_after: i64 = large
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap();
    let page_size: i64 = large
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .unwrap();
    let baseline = steps(&large, || original(&large, "m").unwrap());
    let indexed = steps(&large, || stale(&large, "m").unwrap());
    let many = fixture(true);
    populate(&many, 65000, 17);
    let many_steps = steps(&many, || stale(&many, "m").unwrap());
    eprintln!("activation-guard aggregate: candidates=65000 sources=1 baseline_vm={baseline} indexed_vm={indexed} small_vm={small_steps} sources17_vm={many_steps} index_allocated_bytes={}",(pages_after-pages_before)*page_size);
    assert!(baseline > 650000);
    assert!(indexed < baseline / 100);
    assert!(indexed <= small_steps + 100);
    assert!(many_steps < baseline / 20);
    assert!(many_steps > indexed);
    assert!(pages_after > pages_before);
    assert!((pages_after - pages_before) * page_size < 8 * 1024 * 1024);
}
#[test]
fn interrupted_indexed_guard_propagates_error_and_releases_progress_handler() {
    let c = fixture(true);
    populate(&c, 1000, 17);
    c.progress_handler(1, Some(|| true)).unwrap();
    assert!(stale(&c, "m").is_err());
    c.progress_handler(0, None::<fn() -> bool>).unwrap();
    agrees(&c, false);
}
#[test]
fn replacement_guard_retains_cas_identity_and_autocommit_readonly() {
    let c = fixture(true);
    populate(&c, 100, 2);
    c.execute_batch("CREATE TABLE scan_manifest_replacement(manifest_id TEXT,prior_job_id TEXT,prior_review_digest TEXT,catalog_revision INTEGER,checkpoint_revision INTEGER,allow_unfinished INTEGER); INSERT INTO scan_manifest_replacement VALUES('m','job','digest',2,3,1);CREATE TABLE scan_checkpoint(singleton INTEGER,job_id TEXT,contents TEXT);INSERT INTO scan_checkpoint VALUES(1,'job','{\"reviewDigest\":\"digest\"}');").unwrap();
    let v = serde_json::json!({});
    let mut context = crate::scan_candidate_manifest::Context {
        preferences: &v,
        catalog: &v,
        catalog_revision: 2,
        checkpoint_revision: 3,
        now: 0,
    };
    let before = c.total_changes();
    assert_eq!(
        crate::scan_candidate_manifest::replacement_guard(&c, "m", &context).unwrap(),
        Some((Some("job".into()), Some("digest".into()), true))
    );
    assert!(c.is_autocommit());
    assert_eq!(c.total_changes(), before);
    c.execute_batch("BEGIN").unwrap();
    assert!(
        crate::scan_candidate_manifest::replacement_guard(&c, "m", &context)
            .unwrap()
            .is_some()
    );
    assert!(!c.is_autocommit());
    c.execute_batch("ROLLBACK").unwrap();
    context.catalog_revision = 4;
    assert_eq!(
        crate::scan_candidate_manifest::replacement_guard(&c, "m", &context).unwrap_err(),
        "catalog-revision-stale"
    );
    assert!(c.is_autocommit());
    context.catalog_revision = 2;
    c.execute("UPDATE scan_checkpoint SET job_id='new'", [])
        .unwrap();
    assert_eq!(
        crate::scan_candidate_manifest::replacement_guard(&c, "m", &context).unwrap_err(),
        "scan-checkpoint-job-stale"
    );
    assert!(c.is_autocommit());
}

#[test]
fn autocommit_guard_seeks_keep_one_snapshot_during_concurrent_revision_change() {
    use std::sync::atomic::AtomicBool;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("guard.sqlite3");
    let c = Connection::open(&path).unwrap();
    c.execute_batch("PRAGMA journal_mode=WAL;CREATE TABLE scan_manifest(id TEXT PRIMARY KEY);INSERT INTO scan_manifest VALUES('m');CREATE TABLE scan_manifest_namespace(singleton INTEGER PRIMARY KEY,schema_version INTEGER);INSERT INTO scan_manifest_namespace VALUES(1,1);CREATE TABLE source_snapshot_namespace(singleton INTEGER PRIMARY KEY,schema_version INTEGER);INSERT INTO source_snapshot_namespace VALUES(1,2);").unwrap();
    c.execute_batch(TABLE).unwrap();
    c.execute_batch(SOURCE_TABLE).unwrap();
    install_index(&c).unwrap();
    populate(&c, 100, 2);
    c.execute_batch("CREATE TABLE scan_manifest_replacement(manifest_id TEXT,prior_job_id TEXT,prior_review_digest TEXT,catalog_revision INTEGER,checkpoint_revision INTEGER,allow_unfinished INTEGER);INSERT INTO scan_manifest_replacement VALUES('m','job','digest',2,3,0);CREATE TABLE scan_checkpoint(singleton INTEGER,job_id TEXT,contents TEXT);INSERT INTO scan_checkpoint VALUES(1,'job','{\"reviewDigest\":\"digest\"}');").unwrap();
    let fired = Arc::new(AtomicBool::new(false));
    let owned = fired.clone();
    c.progress_handler(50,Some(move || {
        if !owned.swap(true,Ordering::SeqCst) {
            let writer=Connection::open(&path).unwrap();
            writer.execute_batch("BEGIN IMMEDIATE;UPDATE source_snapshot_source SET revision=2;UPDATE scan_checkpoint SET job_id='new';COMMIT;").unwrap();
        }
        false
    })).unwrap();
    let v = serde_json::json!({});
    let context = crate::scan_candidate_manifest::Context {
        preferences: &v,
        catalog: &v,
        catalog_revision: 2,
        checkpoint_revision: 3,
        now: 0,
    };
    let result = crate::scan_candidate_manifest::replacement_guard(&c, "m", &context);
    c.progress_handler(0, None::<fn() -> bool>).unwrap();
    assert!(fired.load(Ordering::SeqCst));
    assert!(result.unwrap().is_some());
    assert!(c.is_autocommit());
    assert_eq!(
        crate::scan_candidate_manifest::replacement_guard(&c, "m", &context).unwrap_err(),
        "scan-checkpoint-job-stale"
    );
    assert!(c.is_autocommit());
}

#[test]
fn raw_text_bytes_are_never_lossily_decoded_or_retyped() {
    let c = fixture(true);
    c.execute_batch("INSERT INTO source_snapshot_source VALUES(CAST(X'80' AS TEXT),1,'{}','p','windows','p',0);INSERT INTO source_activation_row VALUES('m',0,CAST(X'80' AS TEXT),'entry','1');").unwrap();
    agrees(&c, false);
    c.execute_batch("UPDATE source_activation_row SET source_revision=CAST(X'80' AS TEXT);")
        .unwrap();
    agrees(&c, true);
}

#[test]
fn more_than_admitted_source_bound_falls_back_without_ignoring_late_rows() {
    let c = fixture(true);
    populate(&c, 1000, 101);
    agrees(&c, false);
    c.execute(
        "UPDATE source_activation_row SET source_revision='2' WHERE source_id='source-100'",
        [],
    )
    .unwrap();
    agrees(&c, true);
    c.execute(
        "DELETE FROM source_snapshot_source WHERE source_id='source-100'",
        [],
    )
    .unwrap();
    agrees(&c, true);
}
