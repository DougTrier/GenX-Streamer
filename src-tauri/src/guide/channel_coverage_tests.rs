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

fn fixture() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(
        "CREATE TABLE guide_source(id TEXT PRIMARY KEY,revision INTEGER,published_revision INTEGER);
         CREATE TABLE guide_channel(guide_source_id TEXT,id TEXT,PRIMARY KEY(guide_source_id,id));
         CREATE TABLE guide_program(guide_source_id TEXT,channel_id TEXT,ordinal INTEGER,start_ms INTEGER,stop_ms INTEGER);
         CREATE INDEX guide_program_channel_time ON guide_program(guide_source_id,channel_id,start_ms,ordinal);
         INSERT INTO guide_source VALUES('feed',2,2);
         INSERT INTO guide_channel VALUES('feed','A'),('feed','B');",
    ).unwrap();
    c
}
fn request(start: i64, end: i64) -> CoverageRequest {
    CoverageRequest {
        schema_version: 1,
        source_id: "feed".into(),
        xmltv_channel_id: "A".into(),
        start_ms: start,
        end_ms: end,
        expected_source_revision: 2,
        expected_published_revision: 2,
    }
}
fn insert(c: &Connection, channel: &str, ordinal: i64, start: i64, stop: Option<i64>) {
    c.execute(
        "INSERT INTO guide_program VALUES('feed',?1,?2,?3,?4)",
        params![channel, ordinal, start, stop],
    )
    .unwrap();
}
fn assess(c: &Connection, q: &CoverageRequest) -> ChannelCoverage {
    query(c, q, Arc::new(|| false)).unwrap()
}

#[test]
fn same_feed_seven_days_never_establishes_other_channel_coverage() {
    let c = fixture();
    insert(&c, "A", 0, 0, Some(WEEK_MS));
    insert(&c, "B", 1, 0, Some(3_600_000));
    let q = request(0, WEEK_MS);
    let a = assess(&c, &q);
    assert_eq!(a.covered_ms, Some(WEEK_MS));
    assert_eq!(a.gap_count, Some(0));
    let mut b = q;
    b.xmltv_channel_id = "B".into();
    let b = assess(&c, &b);
    assert_eq!(b.covered_ms, Some(3_600_000));
    assert_eq!(
        b.gaps,
        vec![Gap {
            start_ms: 3_600_000,
            end_ms: WEEK_MS
        }]
    );
}

#[test]
fn clipping_touching_overlap_edges_and_internal_gaps_are_exact() {
    let c = fixture();
    for (i, (start, stop)) in [
        (-10, 0),
        (0, 20),
        (20, 30),
        (25, 40),
        (50, 60),
        (60, 110),
        (100, 120),
    ]
    .into_iter()
    .enumerate()
    {
        insert(&c, "A", i as i64, start, Some(stop));
    }
    let r = assess(&c, &request(10, 100));
    assert_eq!(r.covered_ms, Some(80));
    assert_eq!(
        r.gaps,
        vec![Gap {
            start_ms: 40,
            end_ms: 50
        }]
    );
    assert_eq!(r.gap_count, Some(1));
    assert!(r.gaps_complete);
    // Conflicting overlap titles are not read or classified as programme accuracy.
}

#[test]
fn unknown_ends_never_fill_gaps_and_preview_is_bounded() {
    let c = fixture();
    insert(&c, "A", 100, -1, None);
    insert(&c, "A", 101, 0, None);
    insert(&c, "A", 102, 100, None);
    for i in 0..10 {
        insert(&c, "A", i, i * 10 + 2, Some(i * 10 + 3));
    }
    let r = assess(&c, &request(0, 100));
    assert_eq!(r.unknown_end_count, Some(1));
    assert_eq!(r.covered_ms, Some(10));
    assert_eq!(r.gap_count, Some(11));
    assert_eq!(r.gaps.len(), 8);
    assert!(!r.gaps_complete);
    let empty = assess(&c, &request(200, 300));
    assert_eq!(empty.covered_ms, Some(0));
    assert_eq!(
        empty.gaps,
        vec![Gap {
            start_ms: 200,
            end_ms: 300
        }]
    );
}

#[test]
fn exactly_4096_rows_assessed_but_overflow_exposes_no_partial_coverage() {
    let c = fixture();
    for i in 0..4096 {
        insert(&c, "A", i, 0, Some(100));
    }
    assert_eq!(assess(&c, &request(0, 100)).covered_ms, Some(100));
    insert(&c, "A", 4096, 0, Some(100));
    let r = assess(&c, &request(0, 100));
    assert_eq!(r.status, "not-assessed");
    assert_eq!(r.reason, Some("work-limit"));
    assert!(r.covered_ms.is_none() && r.gap_count.is_none() && r.unknown_end_count.is_none());
    assert!(r.gaps.is_empty() && !r.gaps_complete);
    handler_was_removed(&c);
}

#[test]
fn stale_unpublished_missing_and_canceled_never_claim_coverage() {
    let c = fixture();
    let mut q = request(0, 100);
    q.expected_source_revision = 1;
    assert_eq!(assess(&c, &q).reason, Some("source-stale"));
    q.expected_source_revision = 2;
    c.execute("UPDATE guide_source SET published_revision=NULL", [])
        .unwrap();
    assert_eq!(assess(&c, &q).reason, Some("source-stale"));
    c.execute("UPDATE guide_source SET published_revision=2", [])
        .unwrap();
    q.xmltv_channel_id = "missing".into();
    assert_eq!(assess(&c, &q).reason, Some("channel-missing"));
    q.source_id = "missing".into();
    assert_eq!(assess(&c, &q).reason, Some("source-missing"));
    assert_eq!(
        query(&c, &q, Arc::new(|| true)).unwrap_err(),
        "guide-cancelled"
    );
    assert!(c.is_autocommit());
}

#[test]
fn utc_chicago_dst_windows_have_23_or_25_hours_not_assumed_days() {
    let c = fixture();
    // Chicago midnight-to-midnight: 2026-03-08 CST -> 03-09 CDT;
    // 2026-11-01 CDT -> 11-02 CST. Exact UTC instants, no device timezone.
    for (i, start, hours) in [(0, 1_772_949_600_000, 23), (1, 1_793_509_200_000, 25)] {
        let end = start + hours * 3_600_000;
        insert(&c, "A", i, start, Some(end));
        let r = assess(&c, &request(start, end));
        assert_eq!(r.covered_ms, Some(hours * 3_600_000));
        assert_eq!(r.gap_count, Some(0));
    }
}

#[test]
fn request_limits_and_corrupt_stored_intervals_refuse_without_writes() {
    let c = fixture();
    for q in [request(0, 0), request(0, WEEK_MS + 1), request(i64::MIN, 0)] {
        assert!(query(&c, &q, Arc::new(|| false)).is_err());
    }
    let mut q = request(0, 100);
    q.schema_version = 2;
    assert!(query(&c, &q, Arc::new(|| false)).is_err());
    insert(&c, "A", 0, 20, Some(10));
    assert_eq!(
        query(&c, &request(0, 100), Arc::new(|| false)).unwrap_err(),
        "guide-invalid-program-end"
    );
    assert!(c.is_autocommit());
    assert_eq!(c.total_changes(), 4);
    handler_was_removed(&c);
}

#[test]
fn read_transaction_keeps_source_channel_and_intervals_in_one_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("coverage.sqlite3");
    let c = Connection::open(&path).unwrap();
    c.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE guide_source(id TEXT PRIMARY KEY,revision INTEGER,published_revision INTEGER);
        CREATE TABLE guide_channel(guide_source_id TEXT,id TEXT,PRIMARY KEY(guide_source_id,id));
        CREATE TABLE guide_program(guide_source_id TEXT,channel_id TEXT,ordinal INTEGER,start_ms INTEGER,stop_ms INTEGER);
        CREATE INDEX guide_program_channel_time ON guide_program(guide_source_id,channel_id,start_ms,ordinal);
        INSERT INTO guide_source VALUES('feed',2,2);
        INSERT INTO guide_channel VALUES('feed','A');").unwrap();
    insert(&c, "A", 0, 0, Some(100));
    let writer = Connection::open(&path).unwrap();
    let tx = c.unchecked_transaction().unwrap();
    let _: i64 = tx
        .query_row("SELECT revision FROM guide_source", [], |r| r.get(0))
        .unwrap();
    writer.execute_batch("BEGIN IMMEDIATE;UPDATE guide_source SET revision=3,published_revision=3;DELETE FROM guide_program;COMMIT;").unwrap();
    let old = read(&tx, &request(0, 100), &(Arc::new(|| false) as CancelCheck)).unwrap();
    assert_eq!(old.source_revision, Some(2));
    assert_eq!(old.covered_ms, Some(100));
    tx.commit().unwrap();
    assert_eq!(assess(&c, &request(0, 100)).reason, Some("source-stale"));
}

#[test]
fn cancellation_during_sql_iteration_refuses_and_drops_transaction() {
    use std::sync::atomic::AtomicUsize;
    let c = fixture();
    for i in 0..30_000 {
        // Filtered out, so cancellation must be observed inside SQLite stepping.
        insert(&c, "A", i, -20, Some(-10));
    }
    let polls = Arc::new(AtomicUsize::new(0));
    let during = polls.clone();
    let result = query(
        &c,
        &request(0, 100),
        Arc::new(move || during.fetch_add(1, Ordering::AcqRel) >= 2),
    );
    assert_eq!(result.unwrap_err(), "guide-cancelled");
    assert_eq!(polls.load(Ordering::Acquire), 3);
    assert!(c.is_autocommit());
    handler_was_removed(&c);
}

fn handler_was_removed(c: &Connection) {
    // Exceeds the production VM budget; would interrupt if the handler leaked.
    let sum:i64=c.query_row("WITH RECURSIVE n(x) AS(VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<30000) SELECT sum(x) FROM n",[],|r|r.get(0)).unwrap();
    assert_eq!(sum, 450_015_000);
}

#[test]
fn filtered_historical_rows_exhaust_vm_budget_without_partial_success() {
    let c = fixture();
    for i in 0..30_000 {
        insert(&c, "A", i, -20, Some(-10));
    }
    // One visible interval would look complete under a returned-row-only budget.
    insert(&c, "A", 30_000, 0, Some(100));
    let result = assess(&c, &request(0, 100));
    assert_eq!(result.status, "not-assessed");
    assert_eq!(result.reason, Some("work-limit"));
    assert!(
        result.covered_ms.is_none()
            && result.gap_count.is_none()
            && result.unknown_end_count.is_none()
    );
    assert!(result.gaps.is_empty() && !result.gaps_complete);
    assert!(c.is_autocommit());
    handler_was_removed(&c);
    c.execute("DELETE FROM guide_program WHERE start_ms<0", [])
        .unwrap();
    assert_eq!(assess(&c, &request(0, 100)).covered_ms, Some(100));
    handler_was_removed(&c);
}
