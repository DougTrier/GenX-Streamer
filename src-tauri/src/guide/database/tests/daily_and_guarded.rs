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

//! Guide database tests: daily guide claims, guarded guides and genre tags.

use super::*;

#[test]
fn daily_guide_attempt_claim_is_durable_scoped_and_does_not_publish_on_failure() {
    use crate::guide::refresh;
    let mut f = fixture();
    // Refresh evaluates real catalog-source ownership, unlike guide-only query fixtures.
    f.c.execute_batch("CREATE TABLE source(id TEXT PRIMARY KEY);INSERT INTO source VALUES('catalog-a'),('catalog-b');")
        .unwrap();
    f.c.execute_batch(
        "CREATE TABLE preference(singleton INTEGER PRIMARY KEY,auto_source_refresh INTEGER);INSERT INTO preference VALUES(1,1);",
    )
    .unwrap();
    install(&mut f.c, "g", "Old");
    let due = 3000 + 86_400_000;
    assert_eq!(refresh::plan(&f.c, 0).unwrap().sources[0].next_due_ms, due);
    assert!(!refresh::claim(&mut f.c, "g", 2, due - 1).unwrap().2);
    assert!(refresh::claim(&mut f.c, "g", 2, due).unwrap().2);
    assert!(!refresh::claim(&mut f.c, "g", 2, due).unwrap().2);
    // Reopen proves failure attempt survives process lifetime, while last good rows do not change.
    let path = f._dir.path().join("guide.sqlite3");
    let reopened = Connection::open(path).unwrap();
    assert_eq!(
        refresh::plan(&reopened, due).unwrap().sources[0].next_due_ms,
        due + 86_400_000
    );
    assert_eq!(list_sources(&reopened).unwrap()[0].updated_ms, Some(3000));
    assert_eq!(
        reopened
            .query_row("SELECT title FROM guide_program", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "Old"
    );
    drop(reopened);
    assert_eq!(
        refresh::claim(&mut f.c, "g", 1, due).unwrap_err(),
        "guide-stale-revision"
    );
    replace_guide(
        &mut f.c,
        "g",
        2,
        &feed("Fresh"),
        due + 100,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        refresh::plan(&f.c, due).unwrap().sources[0].next_due_ms,
        due + 100 + 86_400_000
    );
    assert!(!refresh::claim(&mut f.c, "g", 3, due + 100).unwrap().2);
    save_source(&mut f.c, &source("unreviewed"), 0).unwrap();
    assert_eq!(refresh::plan(&f.c, due).unwrap().sources.len(), 1);
    assert_eq!(
        refresh::claim(&mut f.c, "unreviewed", 1, due).unwrap_err(),
        "guide-refresh-source-unapproved"
    );
    let mut changed = source("g");
    changed.revision = 3;
    changed.location = "https://other.example/guide".into();
    save_source(&mut f.c, &changed, 3).unwrap();
    assert!(refresh::plan(&f.c, due).unwrap().sources.is_empty());
}

#[test]
fn guarded_guide_zero_exact_matches_does_not_publish_and_checks_both_revisions() {
    let mut f = fixture();
    f.c.execute_batch("ALTER TABLE metadata ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 7;ALTER TABLE channel ADD COLUMN provider_id TEXT;UPDATE channel SET provider_id='XML-A';").unwrap();
    install(&mut f.c, "g", "Old schedule");
    let before = source_coverage(&f.c, "g").unwrap();
    let global = database_revision(&f.c).unwrap();
    let next = feed("Must not publish");
    let reply =
        replace_guide_if_matched(&mut f.c, "g", 2, "7", &next, 6000, &AtomicBool::new(false))
            .unwrap();
    assert!(!reply.committed);
    assert_eq!(reply.matched, 0);
    assert_eq!(reply.source_revision, 2);
    assert_eq!(
        serde_json::to_value(source_coverage(&f.c, "g").unwrap()).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    assert_eq!(database_revision(&f.c).unwrap(), global);
    assert_eq!(
        f.c.query_row(
            "SELECT title FROM guide_program WHERE guide_source_id='g'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "Old schedule"
    );
    assert!(list_mappings(&f.c).unwrap().is_empty());
    assert_eq!(
        replace_guide_if_matched(&mut f.c, "g", 2, "8", &next, 6000, &AtomicBool::new(false))
            .unwrap_err(),
        "catalog-revision-stale"
    );
    assert_eq!(
        replace_guide_if_matched(&mut f.c, "g", 1, "7", &next, 6000, &AtomicBool::new(false))
            .unwrap_err(),
        "guide-stale-revision"
    );
    for revision in ["", "-1", "01", "9223372036854775808"] {
        assert_eq!(
            replace_guide_if_matched(
                &mut f.c,
                "g",
                2,
                revision,
                &next,
                6000,
                &AtomicBool::new(false)
            )
            .unwrap_err(),
            "catalog-revision-invalid"
        );
    }
}

#[test]
fn guarded_guide_retains_exact_existing_and_maps_all_distinct_variants_atomically() {
    let mut f = fixture();
    f.c.execute_batch("ALTER TABLE metadata ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 7;ALTER TABLE channel ADD COLUMN provider_id TEXT;UPDATE channel SET provider_id='xml-a';INSERT INTO channel VALUES('removed-match','catalog-a','xml-a');INSERT INTO removed VALUES('removed-match');").unwrap();
    install(&mut f.c, "g", "Old");
    save_mapping(&mut f.c, &mapping("g", "app-a", "catalog-a")).unwrap();
    let reply = replace_guide_if_matched(
        &mut f.c,
        "g",
        2,
        "7",
        &feed("Matched schedule"),
        6000,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(reply.committed);
    assert_eq!(
        (
            reply.matched,
            reply.unmatched,
            reply.preserved_mappings,
            reply.source_revision
        ),
        (2, 0, 1, 3)
    );
    assert_eq!(list_mappings(&f.c).unwrap().len(), 2);
    assert_eq!(
        f.c.query_row(
            "SELECT title FROM guide_program WHERE guide_source_id='g'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "Matched schedule"
    );
    // Retained exact mappings still authorize subsequent schedule refresh, without reinserting them.
    let refreshed = replace_guide_if_matched(
        &mut f.c,
        "g",
        3,
        "7",
        &feed("Refresh"),
        7000,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(refreshed.committed);
    assert_eq!((refreshed.matched, refreshed.preserved_mappings), (2, 2));
}

#[test]
fn guarded_guide_precommit_cancellation_rolls_back_schedule_and_mapping() {
    let mut f = fixture();
    f.c.execute_batch("ALTER TABLE metadata ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 7;ALTER TABLE channel ADD COLUMN provider_id TEXT;UPDATE channel SET provider_id='xml-a';").unwrap();
    install(&mut f.c, "g", "Old");
    let before = database_revision(&f.c).unwrap();
    let flag = AtomicBool::new(false);
    let error = match_inner(
        &mut f.c,
        "g",
        2,
        Some(7),
        None,
        &feed("Canceled"),
        6000,
        &flag,
        || {
            flag.store(true, Ordering::Release);
            Ok(())
        },
    )
    .unwrap_err();
    assert_eq!(error, "guide-cancelled");
    assert_eq!(source_revision(&f.c, "g").unwrap(), 2);
    assert_eq!(database_revision(&f.c).unwrap(), before);
    assert!(list_mappings(&f.c).unwrap().is_empty());
    assert_eq!(
        f.c.query_row(
            "SELECT title FROM guide_program WHERE guide_source_id='g'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "Old"
    );
}

#[test]
fn actual_genre_tags_search_and_semantic_duplicates_keep_source_scope_and_cursor_guards() {
    use crate::guide::category::GuideCategory;
    let mut f = fixture();
    let mut data = feed("Midnight story");
    data.programs[0].categories = vec![GuideCategory {
        text: "Mystery".into(),
        language: Some("en".into()),
    }];
    let mut variant = data.programs[0].clone();
    variant.categories[0].text = "ｍｙｓｔｅｒｙ".into();
    data.programs.push(variant);
    let mut distinct = data.programs[0].clone();
    distinct.categories[0].text = "Drama".into();
    data.programs.push(distinct);
    publish_source(
        &mut f.c,
        &source("g"),
        0,
        &data,
        3000,
        &AtomicBool::new(false),
    )
    .unwrap();
    save_mapping(&mut f.c, &mapping("g", "app-a", "catalog-a")).unwrap();
    assert_eq!(
        f.c.query_row("SELECT count(*) FROM guide_program", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    let mut q = query("g", &["app-a"]);
    q.search = "midnight mystery".into();
    let page = query_programs(&f.c, &q).unwrap();
    assert_eq!(page.programs.len(), 1);
    assert_eq!(
        page.programs[0].categories[0].language.as_deref(),
        Some("en")
    );
    q.search = "Action".into();
    assert!(query_programs(&f.c, &q).unwrap().programs.is_empty());
    q.search.clear();
    q.page_size = 1;
    let first = query_programs(&f.c, &q).unwrap();
    assert!(first.next_cursor.is_some());
    q.cursor = first.next_cursor;
    let flag = AtomicBool::new(true);
    assert!(replace_guide(&mut f.c, "g", 1, &feed("replacement"), 4000, &flag).is_err());
    assert!(query_programs(&f.c, &q).is_ok());
    replace_guide(
        &mut f.c,
        "g",
        1,
        &feed("replacement"),
        4000,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(query_programs(&f.c, &q).unwrap_err(), "guide-stale-cursor");
    q.cursor = None;
    q.search = "Mystery".into();
    assert!(query_programs(&f.c, &q).unwrap().programs.is_empty());
}

#[test]
fn guide_daily_permission_is_independent_of_channel_cadence_and_reuses_attempt() {
    use crate::guide::refresh;
    let mut f = fixture();
    // Refresh evaluates real catalog-source ownership, unlike guide-only query fixtures.
    f.c.execute_batch("CREATE TABLE source(id TEXT PRIMARY KEY);INSERT INTO source VALUES('catalog-a'),('catalog-b');")
        .unwrap();
    f.c.execute_batch("CREATE TABLE preference(singleton INTEGER PRIMARY KEY,source_refresh_cadence TEXT);INSERT INTO preference VALUES(1,'hourly');ALTER TABLE metadata ADD COLUMN automatic_guide_updates INTEGER;UPDATE metadata SET automatic_guide_updates=1;PRAGMA user_version=8;").unwrap();
    install(&mut f.c, "g", "Old");
    let due = 3000 + 86_400_000;
    assert_eq!(refresh::plan(&f.c, 0).unwrap().sources[0].next_due_ms, due);
    assert!(refresh::claim(&mut f.c, "g", 2, due).unwrap().2);
    f.c.execute(
        "UPDATE preference SET source_refresh_cadence='every6hours'",
        [],
    )
    .unwrap();
    assert_eq!(
        refresh::plan(&f.c, due).unwrap().sources[0].next_due_ms,
        due + 86_400_000
    );
    assert!(!refresh::claim(&mut f.c, "g", 2, due + 3_600_000).unwrap().2);
    f.c.execute("UPDATE preference SET source_refresh_cadence='off'", [])
        .unwrap();
    assert_eq!(
        refresh::plan(&f.c, due).unwrap().sources[0].next_due_ms,
        due + 86_400_000
    );
    f.c.execute("UPDATE metadata SET automatic_guide_updates=0", [])
        .unwrap();
    assert!(refresh::plan(&f.c, due).unwrap().sources.is_empty());
    assert_eq!(
        refresh::claim(&mut f.c, "g", 2, due + 100_000_000).unwrap_err(),
        "guide-refresh-disabled"
    );
    let attempted: i64 =
        f.c.query_row("SELECT attempted_ms FROM guide_refresh_state", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(attempted, due);
    f.c.execute("UPDATE metadata SET automatic_guide_updates=1", [])
        .unwrap();
    f.c.execute("UPDATE preference SET source_refresh_cadence='weekly'", [])
        .unwrap();
    assert_eq!(
        refresh::plan(&f.c, due).unwrap().sources[0].next_due_ms,
        due + 86_400_000
    );
}

#[test]
fn daily_guide_claim_ignores_monthly_channel_cadence_and_retains_last_good() {
    use crate::guide::refresh;
    use chrono::{TimeZone, Utc};
    let mut f = fixture();
    // Refresh evaluates real catalog-source ownership, unlike guide-only query fixtures.
    f.c.execute_batch("CREATE TABLE source(id TEXT PRIMARY KEY);INSERT INTO source VALUES('catalog-a'),('catalog-b');")
        .unwrap();
    f.c.execute_batch("CREATE TABLE preference(singleton INTEGER PRIMARY KEY,source_refresh_cadence TEXT);INSERT INTO preference VALUES(1,'monthly');PRAGMA user_version=8;").unwrap();
    let jan31 = Utc
        .with_ymd_and_hms(2023, 1, 31, 12, 34, 56)
        .unwrap()
        .timestamp_millis()
        + 123;
    let jan15 = Utc
        .with_ymd_and_hms(2023, 1, 15, 12, 34, 56)
        .unwrap()
        .timestamp_millis()
        + 123;
    for (id, last) in [("a", jan31), ("b", jan15)] {
        save_source(&mut f.c, &source(id), 0).unwrap();
        replace_guide(
            &mut f.c,
            id,
            1,
            &feed("Last good"),
            last,
            &AtomicBool::new(false),
        )
        .unwrap();
    }
    let next_a = jan31 + 86_400_000;
    let next_b = jan15 + 86_400_000;
    let plan = refresh::plan(&f.c, jan31).unwrap();
    assert_eq!(
        plan.sources
            .iter()
            .find(|v| v.source_id == "a")
            .unwrap()
            .next_due_ms,
        next_a
    );
    assert_eq!(
        plan.sources
            .iter()
            .find(|v| v.source_id == "b")
            .unwrap()
            .next_due_ms,
        next_b
    );
    assert!(refresh::claim(&mut f.c, "a", 2, next_a).unwrap().2);
    let after_claim = next_a + 86_400_000;
    assert_eq!(
        refresh::plan(&f.c, next_a)
            .unwrap()
            .sources
            .iter()
            .find(|v| v.source_id == "a")
            .unwrap()
            .next_due_ms,
        after_claim
    );
    let reopened = Connection::open(f._dir.path().join("guide.sqlite3")).unwrap();
    assert_eq!(
        refresh::plan(&reopened, next_a)
            .unwrap()
            .sources
            .iter()
            .find(|v| v.source_id == "a")
            .unwrap()
            .next_due_ms,
        after_claim
    );
    assert_eq!(source_coverage(&reopened, "a").unwrap().program_count, 1);
    assert_eq!(
        list_sources(&reopened)
            .unwrap()
            .iter()
            .find(|v| v.id == "a")
            .unwrap()
            .updated_ms,
        Some(jan31)
    );
}
