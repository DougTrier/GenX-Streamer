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
fn ids(names: &[&str]) -> Vec<SummaryIdentity> {
    names
        .iter()
        .map(|name| SummaryIdentity {
            catalog_source_id: "catalog".into(),
            app_channel_id: (*name).into(),
        })
        .collect()
}
fn add(c: &Connection, name: &str, mapped: bool) {
    c.execute("INSERT INTO channel VALUES(?1,'catalog')", [name])
        .unwrap();
    if mapped {
        c.execute(
            "INSERT INTO guide_mapping VALUES('catalog',?1,'guide','xml')",
            [name],
        )
        .unwrap();
    }
}
#[test]
fn ordered_mixed_rows_share_exact_single_semantics_and_cached_source() {
    let mut c = fixture();
    install(
        &mut c,
        vec![
            program(4000, None, "Unknown"),
            program(6000, Some(7000), "Next"),
        ],
    );
    add(&c, "second", true);
    add(&c, "unmapped", false);
    let batch = visible_summaries(
        &c,
        "batch",
        5000,
        &ids(&["second", "unmapped", "absent", "app"]),
        Arc::new(|| false),
    )
    .unwrap();
    assert_eq!(batch.catalog_revision, "7");
    assert_eq!(batch.rows.len(), 4);
    assert_eq!(batch.rows[0].app_channel_id, "second");
    assert_eq!(batch.rows[1].mapping_status, "unmapped");
    assert_eq!(batch.rows[2].mapping_status, "channel-unavailable");
    for row in &batch.rows {
        assert_eq!(row.request_id, "batch");
        assert_eq!(row.at_ms, 5000);
        assert_eq!(row.catalog_revision, batch.catalog_revision);
        assert_eq!(row.database_revision, batch.database_revision);
    }
    let single = selected_summary(
        &c,
        &SummaryQuery {
            request_id: "batch".into(),
            ..query()
        },
        Arc::new(|| false),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&batch.rows[3]).unwrap(),
        serde_json::to_value(single).unwrap()
    );
    assert_eq!(batch.rows[0].current_status, Some("unknown-end"));
    assert_eq!(batch.rows[0].next.as_ref().unwrap().title, "Next");
}
#[test]
fn limits_duplicates_and_cancellation_refuse_without_partial_rows() {
    let c = fixture();
    assert_eq!(
        visible_summaries(&c, "batch", 5000, &[], Arc::new(|| false)).unwrap_err(),
        "guide-summary-channel-limit"
    );
    assert_eq!(
        visible_summaries(&c, "batch", 5000, &ids(&["app", "app"]), Arc::new(|| false))
            .unwrap_err(),
        "guide-summary-duplicate-channel"
    );
    let many: Vec<_> = (0..65)
        .map(|n| SummaryIdentity {
            catalog_source_id: "catalog".into(),
            app_channel_id: format!("app{n}"),
        })
        .collect();
    assert_eq!(
        visible_summaries(&c, "batch", 5000, &many, Arc::new(|| false)).unwrap_err(),
        "guide-summary-channel-limit"
    );
    assert_eq!(
        visible_summaries(&c, "batch", 5000, &ids(&["app"]), Arc::new(|| true)).unwrap_err(),
        "canceled"
    );
}
#[test]
fn full_batch_byte_cap_refuses_valid_individual_rows() {
    let mut c = fixture();
    let title = "x".repeat(16_384);
    install(
        &mut c,
        vec![
            program(4000, Some(5500), &title),
            program(6000, Some(7000), &title),
        ],
    );
    let mut channels = ids(&["app"]);
    for n in 0..20 {
        let name = format!("a{n}");
        add(&c, &name, true);
        channels.push(SummaryIdentity {
            catalog_source_id: "catalog".into(),
            app_channel_id: name,
        });
    }
    assert!(serde_json::to_vec(&read(&c)).unwrap().len() < 128 * 1024);
    assert_eq!(
        visible_summaries(&c, "batch", 5000, &channels, Arc::new(|| false)).unwrap_err(),
        "guide-summary-batch-byte-limit"
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM channel", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        21
    );
}
#[test]
fn entire_batch_observes_snapshot_before_concurrent_writer() {
    let mut initial = fixture();
    install(&mut initial, vec![program(4000, Some(5500), "Original")]);
    add(&initial, "second", true);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("batch.sqlite3");
    initial
        .execute("VACUUM INTO ?1", [path.to_str().unwrap()])
        .unwrap();
    let reader = Connection::open(&path).unwrap();
    reader.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    let writer = std::sync::Mutex::new(Connection::open(&path).unwrap());
    let count = AtomicUsize::new(0);
    let batch=visible_summaries(&reader,"batch",5000,&ids(&["app","second"]),Arc::new(move || {
        if count.fetch_add(1,AtomicOrdering::SeqCst)==1 {writer.lock().unwrap().execute_batch("BEGIN IMMEDIATE;UPDATE metadata SET revision=99,catalog_revision=8;UPDATE guide_source SET revision=revision+1;UPDATE guide_program SET title='Changed';COMMIT;").unwrap();}false
    })).unwrap();
    assert_eq!(batch.catalog_revision, "7");
    for row in batch.rows {
        assert_eq!(row.catalog_revision, "7");
        assert_eq!(row.source_revision, Some(2));
        assert_eq!(row.current.unwrap().title, "Original");
    }
    assert_eq!(read(&reader).current.unwrap().title, "Changed");
}
#[test]
fn later_expensive_row_is_interrupted_and_handler_removed() {
    let mut c = fixture();
    install(
        &mut c,
        (0..30_000)
            .map(|n| program(n, Some(40_000), "Overlap"))
            .collect(),
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let err = visible_summaries(
        &c,
        "batch",
        5000,
        &ids(&["absent", "app"]),
        Arc::new(move || observed.fetch_add(1, AtomicOrdering::SeqCst) > 20),
    )
    .unwrap_err();
    assert_eq!(err, "canceled");
    assert!(calls.load(AtomicOrdering::SeqCst) > 20);
    assert_eq!(
        c.query_row("SELECT sum(start_ms) FROM guide_program", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        449985000
    );
}
