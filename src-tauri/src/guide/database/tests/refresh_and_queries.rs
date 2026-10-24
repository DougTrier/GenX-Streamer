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

//! Guide database tests: full refreshes, token search, migrations, and query
//! and channel cursors.

use super::*;

#[test]
fn real_sqlite_full_guide_refresh_retains_last_good_rows_and_revisions() {
    let mut f = fixture();
    install(&mut f.c, "g", "Last good");
    save_mapping(&mut f.c, &mapping("g", "app-a", "catalog-a")).unwrap();
    let before_sources = serde_json::to_value(list_sources(&f.c).unwrap()).unwrap();
    let before_programs =
        serde_json::to_value(query_programs(&f.c, &query("g", &[])).unwrap()).unwrap();
    let before_revision = database_revision(&f.c).unwrap();
    f.c.execute_batch("CREATE TABLE full_guide_probe(value BLOB)")
        .unwrap();
    let pages: i64 =
        f.c.query_row("PRAGMA page_count", [], |r| r.get(0))
            .unwrap();
    f.c.pragma_update(None, "max_page_count", pages).unwrap();
    loop {
        match f
            .c
            .execute("INSERT INTO full_guide_probe VALUES(zeroblob(1000))", [])
        {
            Ok(_) => {}
            Err(error) => {
                assert_eq!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DiskFull)
                );
                assert_eq!(sql::<usize>(Err(error)).unwrap_err(), "sqlite-storage-full");
                break;
            }
        }
    }
    let mut replacement = feed("Replacement");
    replacement.programs[0].description = Some("x".repeat(65_536));
    assert_eq!(
        replace_guide(
            &mut f.c,
            "g",
            2,
            &replacement,
            4000,
            &AtomicBool::new(false)
        )
        .unwrap_err(),
        "sqlite-storage-full"
    );
    assert_eq!(
        serde_json::to_value(list_sources(&f.c).unwrap()).unwrap(),
        before_sources
    );
    assert_eq!(
        serde_json::to_value(query_programs(&f.c, &query("g", &[])).unwrap()).unwrap(),
        before_programs
    );
    assert_eq!(database_revision(&f.c).unwrap(), before_revision);
    let reopened = Connection::open(f._dir.path().join("guide.sqlite3")).unwrap();
    assert_eq!(
        serde_json::to_value(list_sources(&reopened).unwrap()).unwrap(),
        before_sources
    );
    assert_eq!(
        serde_json::to_value(query_programs(&reopened, &query("g", &[])).unwrap()).unwrap(),
        before_programs
    );
}

#[test]
fn non_full_guide_sql_error_keeps_generic_code() {
    let c = Connection::open_in_memory().unwrap();
    let error = c
        .execute("INSERT INTO missing_table VALUES(1)", [])
        .unwrap_err();
    assert_ne!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DiskFull)
    );
    assert_eq!(
        sql::<usize>(Err(error)).unwrap_err(),
        "guide-database-operation-failed"
    );
}

#[test]
fn global_seven_day_token_search_pages_equal_instants_across_feeds_and_rejects_stale_cursor() {
    let mut f = fixture();
    install(&mut f.c, "g1", "Chicago Bears Live");
    install(&mut f.c, "g2", "Chicago Bears Preview");
    save_mapping(&mut f.c, &mapping("g1", "app-a", "catalog-a")).unwrap();
    save_mapping(&mut f.c, &mapping("g2", "app-b", "catalog-b")).unwrap();
    let mut q = query("", &[]);
    q.search = "bears, CHICAGO".into();
    q.page_size = 1;
    let first = query_programs(&f.c, &q).unwrap();
    assert_eq!(first.source_revision, 0);
    assert_eq!(first.programs[0].guide_source_id, "g1");
    q.cursor = first.next_cursor.clone();
    let second = query_programs(&f.c, &q).unwrap();
    assert_eq!(second.programs[0].guide_source_id, "g2");
    assert!(second.next_cursor.is_none());
    replace_guide(
        &mut f.c,
        "g2",
        2,
        &feed("Chicago Bears New"),
        5000,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(query_programs(&f.c, &q).is_err());
    q.cursor = None;
    q.search = "chicago absent".into();
    assert!(query_programs(&f.c, &q).unwrap().programs.is_empty());
}

#[test]
fn failed_migration_rolls_back_version_and_all_new_tables() {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA user_version=1;CREATE TABLE guide_source(existing TEXT);")
        .unwrap();
    assert!(migrate(&mut c).is_err());
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='guide_meta'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn first_and_edited_source_publish_metadata_schedule_and_revision_together() {
    let mut f = fixture();
    let flag = AtomicBool::new(false);
    assert!(publish_inner(
        &mut f.c,
        &source("g"),
        0,
        &feed("First"),
        3000,
        &flag,
        |_| Err("injected".into())
    )
    .is_err());
    assert!(list_sources(&f.c).unwrap().is_empty());
    assert_eq!(
        publish_source(&mut f.c, &source("g"), 0, &feed("First"), 3000, &flag).unwrap(),
        1
    );
    let mut edited = source("g");
    edited.revision = 1;
    edited.location = "https://guide.example/edited".into();
    assert!(
        publish_inner(&mut f.c, &edited, 1, &feed("Second"), 4000, &flag, |p| {
            if p == usize::MAX {
                flag.store(true, Ordering::Release);
            }
            Ok(())
        })
        .is_err()
    );
    assert_eq!(
        list_sources(&f.c).unwrap()[0].location,
        source("g").location
    );
    assert_eq!(
        source_coverage(&f.c, "g").unwrap().published_revision,
        Some(1)
    );
    flag.store(false, Ordering::Release);
    assert_eq!(
        publish_source(&mut f.c, &edited, 1, &feed("Second"), 4000, &flag).unwrap(),
        2
    );
    assert_eq!(list_sources(&f.c).unwrap()[0].location, edited.location);
}

#[test]
fn empty_channel_scope_searches_every_mapping_beyond_the_scoped_query_cap() {
    let mut f = fixture();
    install(&mut f.c, "g", "Event");
    f.c.execute_batch("WITH RECURSIVE ids(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM ids WHERE i<101) INSERT INTO channel SELECT 'all-'||i,'catalog-all' FROM ids;INSERT INTO guide_mapping SELECT source_id,id,'g','xml-a' FROM channel WHERE source_id='catalog-all';").unwrap();
    let mut q = query("g", &[]);
    q.page_size = 100;
    q.search = "EVENT".into();
    let first = query_programs(&f.c, &q).unwrap();
    assert_eq!(first.programs.len(), 100);
    q.cursor = first.next_cursor;
    let second = query_programs(&f.c, &q).unwrap();
    assert_eq!(second.programs.len(), 1);
    assert!(second.next_cursor.is_none());
    let first_ids: HashSet<_> = first.programs.iter().map(|p| &p.app_channel_id).collect();
    assert!(!first_ids.contains(&second.programs[0].app_channel_id));
}

#[test]
fn query_cursor_is_bound_to_filters_catalog_revision_and_nfkc_all_tokens() {
    let mut f = fixture();
    let mut data = feed("ＦＯＯ Cafe\u{301}");
    data.programs.push(GuideProgram {
        start_ms: 3000,
        stop_ms: Some(4000),
        ..data.programs[0].clone()
    });
    publish_source(
        &mut f.c,
        &source("g"),
        0,
        &data,
        5000,
        &AtomicBool::new(false),
    )
    .unwrap();
    save_mapping(&mut f.c, &mapping("g", "app-a", "catalog-a")).unwrap();
    let mut q = query("g", &[]);
    q.page_size = 1;
    q.search = "CAFÉ foo".into();
    let first = query_programs(&f.c, &q).unwrap();
    assert_eq!(first.programs.len(), 1);
    q.cursor = first.next_cursor;
    q.search = "foo".into();
    assert!(query_programs(&f.c, &q).is_err());
    q.search = "CAFÉ foo".into();
    f.c.execute("UPDATE metadata SET revision=revision+1", [])
        .unwrap();
    assert!(query_programs(&f.c, &q).is_err());
    q.cursor = None;
    q.search = "foo missing".into();
    assert!(query_programs(&f.c, &q).unwrap().programs.is_empty());
}

#[test]
fn channel_pages_have_revision_filter_guards_and_coverage_does_not_invent_unknown_end() {
    let mut f = fixture();
    let mut data = feed("X");
    data.channels.push(GuideChannel {
        id: "xml-b".into(),
        names: vec!["ＦＯＯ News".into()],
    });
    data.programs[0].stop_ms = None;
    publish_source(
        &mut f.c,
        &source("g"),
        0,
        &data,
        3000,
        &AtomicBool::new(false),
    )
    .unwrap();
    let first = list_channels(&f.c, "g", "", None, 1).unwrap();
    assert!(first.next_cursor.is_some());
    let second = list_channels(&f.c, "g", "", first.next_cursor.as_ref(), 1).unwrap();
    assert_eq!(second.channels[0].id, "xml-b");
    assert!(second.next_cursor.is_none());
    assert!(list_channels(&f.c, "g", "news", first.next_cursor.as_ref(), 1).is_err());
    assert_eq!(
        list_channels(&f.c, "g", "news FOO", None, 100)
            .unwrap()
            .channels[0]
            .id,
        "xml-b"
    );
    let coverage = source_coverage(&f.c, "g").unwrap();
    assert_eq!(coverage.channel_count, 2);
    assert_eq!(coverage.program_count, 1);
    assert_eq!(coverage.first_start_ms, Some(1000));
    assert_eq!(coverage.last_stop_ms, None);
    assert_eq!(coverage.unknown_end_count, 1);
    replace_guide(&mut f.c, "g", 1, &data, 4000, &AtomicBool::new(false)).unwrap();
    assert!(list_channels(&f.c, "g", "", first.next_cursor.as_ref(), 1).is_err());
}
