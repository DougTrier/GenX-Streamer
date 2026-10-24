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
use crate::guide::parser::GuideChannel;
#[path = "database_storage_budget_tests.rs"]
mod storage_budget_tests;

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
struct Fixture {
    _dir: tempfile::TempDir,
    c: Connection,
}
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let mut c = Connection::open(dir.path().join("guide.sqlite3")).unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO metadata VALUES(1,0);CREATE TABLE channel(id TEXT PRIMARY KEY,source_id TEXT);INSERT INTO channel VALUES('app-a','catalog-a'),('app-b','catalog-b');CREATE TABLE removed(id TEXT PRIMARY KEY);CREATE TABLE favorite(id TEXT PRIMARY KEY);INSERT INTO favorite VALUES('app-a');PRAGMA user_version=1;").unwrap();
    migrate(&mut c).unwrap();
    // Catalog geography migration is owned elsewhere; this fixture tests guide-only tables.
    c.execute_batch("PRAGMA user_version=3").unwrap();
    migrate_suggestions(&mut c).unwrap();
    Fixture { _dir: dir, c }
}
fn source(id: &str) -> GuideSource {
    GuideSource {
        id: id.into(),
        name: id.into(),
        location: "https://guide.example/feed".into(),
        kind: "url".into(),
        allow_http: false,
        revision: 0,
        updated_ms: None,
    }
}
fn feed(title: &str) -> ParsedGuide {
    ParsedGuide {
        channels: vec![GuideChannel {
            id: "xml-a".into(),
            names: vec!["Channel A".into()],
        }],
        programs: vec![GuideProgram {
            channel_id: "xml-a".into(),
            start_ms: 1000,
            stop_ms: Some(2000),
            title: title.into(),
            description: Some("Tonight München".into()),
            categories: Vec::new(),
        }],
    }
}
fn mapping(source: &str, app: &str, catalog: &str) -> GuideMapping {
    GuideMapping {
        catalog_source_id: catalog.into(),
        app_channel_id: app.into(),
        guide_source_id: source.into(),
        xmltv_channel_id: "xml-a".into(),
    }
}
fn install(c: &mut Connection, id: &str, title: &str) {
    save_source(c, &source(id), 0).unwrap();
    replace_guide(c, id, 1, &feed(title), 3000, &AtomicBool::new(false)).unwrap();
}
fn query(id: &str, apps: &[&str]) -> ProgramQuery {
    ProgramQuery {
        guide_source_id: id.into(),
        app_channel_ids: apps.iter().map(|s| s.to_string()).collect(),
        window_start_ms: 0,
        window_end_ms: 10_000,
        context_at_ms: None,
        search: String::new(),
        page_size: 100,
        cursor: None,
    }
}
#[test]
fn versioned_migration_preserves_catalog_and_refuses_future_schema() {
    let mut f = fixture();
    migrate(&mut f.c).unwrap();
    assert_eq!(
        f.c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        4
    );
    assert_eq!(
        f.c.query_row("SELECT count(*) FROM favorite", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    f.c.execute_batch("PRAGMA user_version=99").unwrap();
    assert!(migrate(&mut f.c).is_err());
    assert_eq!(
        f.c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        99
    );
}
#[test]
fn atomic_refresh_rollback_cancel_and_stale_cas_preserve_last_valid_after_reopen() {
    let mut f = fixture();
    install(&mut f.c, "g", "Old");
    save_mapping(&mut f.c, &mapping("g", "app-a", "catalog-a")).unwrap();
    for phase in [0, 1, usize::MAX] {
        assert!(replace_inner(
            &mut f.c,
            "g",
            2,
            &feed("New"),
            4000,
            &AtomicBool::new(false),
            |p| if p == phase {
                Err("injected-failure".into())
            } else {
                Ok(())
            }
        )
        .is_err());
        assert_eq!(source_revision(&f.c, "g").unwrap(), 2);
        assert_eq!(
            query_programs(&f.c, &query("g", &["app-a"]))
                .unwrap()
                .programs[0]
                .title,
            "Old"
        );
    }
    let flag = AtomicBool::new(false);
    assert!(
        replace_inner(&mut f.c, "g", 2, &feed("New"), 4000, &flag, |phase| {
            if phase == usize::MAX {
                flag.store(true, Ordering::Release);
            }
            Ok(())
        })
        .is_err()
    );
    assert!(replace_guide(
        &mut f.c,
        "g",
        1,
        &feed("Stale"),
        4000,
        &AtomicBool::new(false)
    )
    .is_err());
    drop(f.c);
    let c = Connection::open(f._dir.path().join("guide.sqlite3")).unwrap();
    assert_eq!(
        query_programs(&c, &query("g", &["app-a"]))
            .unwrap()
            .programs[0]
            .title,
        "Old"
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM favorite", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn replacement_is_source_scoped_and_missing_mapping_targets_remain_recoverable() {
    let mut f = fixture();
    install(&mut f.c, "g1", "First");
    install(&mut f.c, "g2", "Second");
    save_mapping(&mut f.c, &mapping("g1", "app-a", "catalog-a")).unwrap();
    save_mapping(&mut f.c, &mapping("g2", "app-b", "catalog-b")).unwrap();
    replace_guide(
        &mut f.c,
        "g1",
        2,
        &ParsedGuide {
            channels: vec![],
            programs: vec![],
        },
        5000,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(query_programs(&f.c, &query("g1", &["app-a"]))
        .unwrap()
        .programs
        .is_empty());
    assert_eq!(
        query_programs(&f.c, &query("g2", &["app-b"]))
            .unwrap()
            .programs[0]
            .title,
        "Second"
    );
    assert_eq!(list_mappings(&f.c).unwrap().len(), 2);
    f.c.execute("DELETE FROM channel WHERE id='app-b'", [])
        .unwrap();
    assert_eq!(list_mappings(&f.c).unwrap().len(), 2);
    assert!(query_programs(&f.c, &query("g2", &["app-b"]))
        .unwrap()
        .programs
        .is_empty());
}
#[test]
fn literal_unicode_search_and_stable_paging_do_not_merge_or_repeat_mapped_channels() {
    let mut f = fixture();
    save_source(&mut f.c, &source("g"), 0).unwrap();
    let mut data = feed("Event % _ München");
    for i in 1..6 {
        let mut p = data.programs[0].clone();
        p.start_ms += i * 1000;
        p.stop_ms = Some(p.start_ms + 1000);
        p.title = format!("Event {i}");
        data.programs.push(p);
    }
    data.programs.push(data.programs[0].clone());
    data.programs.reverse();
    replace_guide(&mut f.c, "g", 1, &data, 10_000, &AtomicBool::new(false)).unwrap();
    save_mapping(&mut f.c, &mapping("g", "app-a", "catalog-a")).unwrap();
    save_mapping(&mut f.c, &mapping("g", "app-b", "catalog-b")).unwrap();
    let mut q = query("g", &["app-a", "app-b"]);
    q.page_size = 3;
    let mut rows = Vec::new();
    loop {
        let page = query_programs(&f.c, &q).unwrap();
        rows.extend(page.programs);
        q.cursor = page.next_cursor;
        if q.cursor.is_none() {
            break;
        }
    }
    assert_eq!(rows.len(), 12);
    let keys: HashSet<_> = rows
        .iter()
        .map(|p| (&p.app_channel_id, p.ordinal))
        .collect();
    assert_eq!(keys.len(), 12);
    q.cursor = None;
    q.search = "MÜNCHEN".into();
    assert_eq!(query_programs(&f.c, &q).unwrap().programs.len(), 3); // description matches all; page remains bounded
    q.search = "% _".into();
    assert_eq!(query_programs(&f.c, &q).unwrap().programs.len(), 0);
    q.search = "' OR 1=1 --".into();
    assert!(query_programs(&f.c, &q).unwrap().programs.is_empty());
}
#[test]
fn stale_cursor_bounds_removed_channels_and_unknown_ends_are_explicit() {
    let mut f = fixture();
    save_source(&mut f.c, &source("g"), 0).unwrap();
    let mut data = feed("Known");
    data.programs.push(GuideProgram {
        channel_id: "xml-a".into(),
        start_ms: 3000,
        stop_ms: None,
        title: "Unknown".into(),
        description: None,
        categories: Vec::new(),
    });
    replace_guide(&mut f.c, "g", 1, &data, 4000, &AtomicBool::new(false)).unwrap();
    save_mapping(&mut f.c, &mapping("g", "app-a", "catalog-a")).unwrap();
    let mut q = query("g", &["app-a"]);
    q.page_size = 1;
    let page = query_programs(&f.c, &q).unwrap();
    assert!(page.next_cursor.is_some());
    q.cursor = page.next_cursor;
    replace_guide(&mut f.c, "g", 2, &data, 5000, &AtomicBool::new(false)).unwrap();
    assert!(query_programs(&f.c, &q).unwrap_err().contains("stale"));
    q.cursor = None;
    q.window_start_ms = 4000;
    assert!(query_programs(&f.c, &q).unwrap().programs.is_empty()); // unknown end isn't extended forever
    q.window_start_ms = 0;
    q.window_end_ms = WEEK + 1;
    assert!(query_programs(&f.c, &q).is_err());
    q.window_end_ms = 10_000;
    f.c.execute("INSERT INTO removed VALUES('app-a')", [])
        .unwrap();
    assert!(query_programs(&f.c, &q).unwrap().programs.is_empty());
}
#[test]
fn metadata_http_permission_and_mapping_validation_are_explicit() {
    let mut f = fixture();
    let mut s = source("g");
    s.location = "http://guide.example/feed".into();
    assert!(save_source(&mut f.c, &s, 0).is_err());
    s.allow_http = true;
    save_source(&mut f.c, &s, 0).unwrap();
    assert!(list_sources(&f.c).unwrap()[0].allow_http);
    replace_guide(&mut f.c, "g", 1, &feed("X"), 3000, &AtomicBool::new(false)).unwrap();
    assert!(save_mapping(&mut f.c, &mapping("g", "app-a", "catalog-b")).is_err());
    save_mapping(&mut f.c, &mapping("g", "app-a", "catalog-a")).unwrap();
    let mut changed = source("g");
    changed.revision = 2;
    changed.location = "https://guide.example/other".into();
    save_source(&mut f.c, &changed, 2).unwrap();
    assert_eq!(list_mappings(&f.c).unwrap().len(), 1);
    assert_eq!(
        list_channels(&f.c, "g", "", None, 100)
            .unwrap()
            .channels
            .len(),
        1
    );
    let coverage = source_coverage(&f.c, "g").unwrap();
    assert_eq!(coverage.source_revision, 3);
    assert_eq!(coverage.published_revision, Some(2));
    remove_source(&mut f.c, "g", 3).unwrap();
    assert_eq!(list_mappings(&f.c).unwrap().len(), 1);
}
fn suggestion_query(id: &str, name: &str) -> GuideSuggestionQuery {
    GuideSuggestionQuery {
        guide_source_id: id.into(),
        expected_source_revision: 2,
        expected_published_revision: Some(2),
        provider_id: None,
        name: name.into(),
    }
}
#[test]
fn indexed_suggestions_preserve_exact_provider_precedence_and_complete_name_scope() {
    let mut f = fixture();
    let mut data = feed("X");
    data.channels[0].names = vec!["ＦＯＯ  News".into(), "Foo News".into()];
    data.channels.push(GuideChannel {
        id: "other".into(),
        names: vec!["Foo News HD".into()],
    });
    save_source(&mut f.c, &source("g"), 0).unwrap();
    replace_guide(&mut f.c, "g", 1, &data, 3000, &AtomicBool::new(false)).unwrap();
    install(&mut f.c, "elsewhere", "Y");
    let mut q = suggestion_query("g", "foo\u{feff}news");
    let found = lookup_suggestions(&f.c, &q).unwrap();
    assert!(matches!(found.r#match, SuggestionMatch::DisplayName));
    assert_eq!(found.candidate_count, 1); // repeated normalized aliases do not create ambiguity
    assert_eq!(found.candidates_preview[0].xmltv_channel_id, "xml-a");
    assert!(found.review_required);
    q.provider_id = Some("other".into());
    assert!(matches!(
        lookup_suggestions(&f.c, &q).unwrap().r#match,
        SuggestionMatch::ProviderId
    ));
    q.provider_id = Some("OTHER".into());
    assert!(matches!(
        lookup_suggestions(&f.c, &q).unwrap().r#match,
        SuggestionMatch::DisplayName
    ));
    q.provider_id = None;
    q.name = "foo".into();
    assert_eq!(lookup_suggestions(&f.c, &q).unwrap().candidate_count, 0); // no substring/HD stripping
    q.name = "Channel A".into();
    assert_eq!(lookup_suggestions(&f.c, &q).unwrap().candidate_count, 0); // no cross-source names
}
#[test]
fn suggestion_ambiguity_counts_every_match_but_preview_is_bounded_and_revision_fenced() {
    let mut f = fixture();
    let mut data = feed("X");
    data.channels = (0..25)
        .map(|n| GuideChannel {
            id: format!("id-{n:02}"),
            names: vec!["Same".into(), "SAME".into()],
        })
        .collect();
    data.programs.clear();
    save_source(&mut f.c, &source("g"), 0).unwrap();
    replace_guide(&mut f.c, "g", 1, &data, 3000, &AtomicBool::new(false)).unwrap();
    let mut q = suggestion_query("g", "same");
    let result = lookup_suggestions(&f.c, &q).unwrap();
    assert!(matches!(result.r#match, SuggestionMatch::Ambiguous));
    assert_eq!(result.candidate_count, 25);
    assert_eq!(result.candidates_preview.len(), 20);
    assert!(!result.preview_complete);
    q.expected_source_revision = 1;
    assert!(lookup_suggestions(&f.c, &q).is_err());
    q.expected_source_revision = 2;
    let mut edited = source("g");
    edited.revision = 2;
    edited.location = "https://guide.example/new".into();
    save_source(&mut f.c, &edited, 2).unwrap();
    assert!(lookup_suggestions(&f.c, &q).is_err());
    q.expected_source_revision = 3;
    let stale = lookup_suggestions(&f.c, &q).unwrap();
    assert!(matches!(stale.cache_status, SuggestionCacheStatus::Stale));
    assert_eq!(stale.candidate_count, 0);
    assert!(stale.candidates_preview.is_empty());
    save_source(&mut f.c, &source("new"), 0).unwrap();
    q.guide_source_id = "new".into();
    q.expected_source_revision = 1;
    q.expected_published_revision = None;
    assert!(matches!(
        lookup_suggestions(&f.c, &q).unwrap().cache_status,
        SuggestionCacheStatus::Unavailable
    ));
}
#[test]
fn alias_refresh_cancellation_rolls_back_and_survives_file_reopen() {
    let mut f = fixture();
    install(&mut f.c, "g", "X");
    let mut data = feed("New");
    data.channels[0].names = vec!["Changed".into()];
    let flag = AtomicBool::new(false);
    assert!(replace_inner(&mut f.c, "g", 2, &data, 4000, &flag, |p| {
        if p == usize::MAX {
            flag.store(true, Ordering::Release);
        }
        Ok(())
    })
    .is_err());
    let path = f._dir.path().join("guide.sqlite3");
    drop(f.c);
    let reopened = Connection::open(path).unwrap();
    assert_eq!(
        lookup_suggestions(&reopened, &suggestion_query("g", "Channel A"))
            .unwrap()
            .candidate_count,
        1
    );
    assert_eq!(
        lookup_suggestions(&reopened, &suggestion_query("g", "Changed"))
            .unwrap()
            .candidate_count,
        0
    );
}
#[test]
fn suggestions_migration_backfills_atomically_and_refuses_invalid_names() {
    let mut f = fixture();
    install(&mut f.c, "g", "X");
    f.c.execute_batch("DROP TABLE guide_channel_name;PRAGMA user_version=3")
        .unwrap();
    f.c.execute("UPDATE guide_channel SET names_json='[]'", [])
        .unwrap();
    assert!(migrate_suggestions(&mut f.c).is_err());
    assert_eq!(
        f.c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        f.c.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='guide_channel_name'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    f.c.execute("UPDATE guide_channel SET names_json='[\"Ｃhannel A\"]'", [])
        .unwrap();
    migrate_suggestions(&mut f.c).unwrap();
    migrate_suggestions(&mut f.c).unwrap();
    migrate(&mut f.c).unwrap();
    assert_eq!(
        lookup_suggestions(&f.c, &suggestion_query("g", "channel a"))
            .unwrap()
            .candidate_count,
        1
    );
    let plan: String =
        f.c.query_row(
            "EXPLAIN QUERY PLAN SELECT channel_id FROM guide_channel_name WHERE guide_source_id='g' AND normalized_name='channel a'",
            [],
            |r| r.get(3),
        )
        .unwrap();
    assert!(plan.contains("guide_channel_name_exact"));
}
#[test]
fn now_context_admits_only_latest_started_unknown_in_exact_channel() {
    let mut f = fixture();
    save_source(&mut f.c, &source("g"), 0).unwrap();
    let mut data = feed("Historical unknown");
    data.programs[0].stop_ms = None;
    data.programs.push(GuideProgram {
        channel_id: "xml-a".into(),
        start_ms: 6000,
        stop_ms: Some(7000),
        title: "Future".into(),
        description: None,
        categories: Vec::new(),
    });
    replace_guide(&mut f.c, "g", 1, &data, 4000, &AtomicBool::new(false)).unwrap();
    save_mapping(&mut f.c, &mapping("g", "app-a", "catalog-a")).unwrap();
    let mut q = query("g", &["app-a"]);
    q.window_start_ms = 4000;
    assert_eq!(query_programs(&f.c, &q).unwrap().programs.len(), 1);
    q.context_at_ms = Some(4000);
    let page = query_programs(&f.c, &q).unwrap();
    assert_eq!(page.programs.len(), 2);
    assert_eq!(page.programs[0].stop_ms, None);
    // A later started known entry, even already ended, makes the old unknown historical.
    data.programs.push(GuideProgram {
        channel_id: "xml-a".into(),
        start_ms: 2000,
        stop_ms: Some(3000),
        title: "Later ended".into(),
        description: None,
        categories: Vec::new(),
    });
    replace_guide(&mut f.c, "g", 2, &data, 4500, &AtomicBool::new(false)).unwrap();
    assert_eq!(query_programs(&f.c, &q).unwrap().programs.len(), 1);
    data.programs.push(GuideProgram {
        channel_id: "xml-a".into(),
        start_ms: 3500,
        stop_ms: None,
        title: "Latest unknown".into(),
        description: None,
        categories: Vec::new(),
    });
    data.programs.push(GuideProgram {
        channel_id: "xml-a".into(),
        start_ms: 3500,
        stop_ms: Some(5000),
        title: "Concurrent known".into(),
        description: None,
        categories: Vec::new(),
    });
    replace_guide(&mut f.c, "g", 3, &data, 4600, &AtomicBool::new(false)).unwrap();
    let page = query_programs(&f.c, &q).unwrap();
    assert_eq!(page.programs.len(), 3);
    assert!(page
        .programs
        .iter()
        .any(|p| p.title == "Latest unknown" && p.stop_ms.is_none()));
    assert!(!page
        .programs
        .iter()
        .any(|p| p.title == "Historical unknown"));
}
#[test]
fn now_context_scope_range_and_cursor_are_guarded() {
    let mut f = fixture();
    install(&mut f.c, "g", "Known");
    save_mapping(&mut f.c, &mapping("g", "app-a", "catalog-a")).unwrap();
    let mut q = query("g", &["app-a"]);
    q.context_at_ms = Some(1000);
    assert_eq!(query_programs(&f.c, &q).unwrap().programs.len(), 1);
    for context in [-1, 10000] {
        q.context_at_ms = Some(context);
        assert!(query_programs(&f.c, &q).is_err());
    }
    q.context_at_ms = Some(1000);
    q.guide_source_id.clear();
    assert!(query_programs(&f.c, &q).is_err());
    q.guide_source_id = "g".into();
    q.app_channel_ids.clear();
    assert!(query_programs(&f.c, &q).is_err());
    q.app_channel_ids = vec!["app-a".into()];
    q.search = "Known".into();
    assert!(query_programs(&f.c, &q).is_err());
    q.search.clear();
    q.app_channel_ids = vec!["app-b".into()];
    assert!(query_programs(&f.c, &q).unwrap().programs.is_empty());
    q.app_channel_ids = vec!["app-a".into()];
    let mut data = feed("Known");
    data.programs.push(GuideProgram {
        channel_id: "xml-a".into(),
        start_ms: 3000,
        stop_ms: None,
        title: "Next".into(),
        description: None,
        categories: Vec::new(),
    });
    replace_guide(&mut f.c, "g", 2, &data, 4000, &AtomicBool::new(false)).unwrap();
    q.page_size = 1;
    q.cursor = query_programs(&f.c, &q).unwrap().next_cursor;
    assert!(q.cursor.is_some());
    q.context_at_ms = Some(1001);
    assert_eq!(query_programs(&f.c, &q).unwrap_err(), "guide-stale-cursor");
    q.context_at_ms = None;
    assert_eq!(query_programs(&f.c, &q).unwrap_err(), "guide-stale-cursor");
}

#[test]
fn commit_and_match_preserves_stream_variants_existing_mappings_and_exact_id_scope() {
    let mut f = fixture();
    f.c.execute_batch("ALTER TABLE channel ADD COLUMN provider_id TEXT;UPDATE channel SET provider_id='xml-a' WHERE id='app-a';INSERT INTO channel VALUES('duplicate-1','catalog-a','collision'),('duplicate-2','catalog-b','collision'),('missing','catalog-a',NULL),('case-only','catalog-a','XML-A'),('removed-match','catalog-a','removed-id');INSERT INTO removed VALUES('removed-match');").unwrap();
    install(&mut f.c, "other", "Existing");
    save_mapping(&mut f.c, &mapping("other", "app-b", "catalog-b")).unwrap();
    save_source(&mut f.c, &source("g"), 0).unwrap();
    let mut data = feed("New");
    for id in ["collision", "removed-id"] {
        data.channels.push(GuideChannel {
            id: id.into(),
            names: vec!["Same display name".into()],
        });
    }
    let receipt =
        replace_guide_and_match(&mut f.c, "g", 1, &data, 3000, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        (
            receipt.source_revision,
            receipt.matched,
            receipt.unmatched,
            receipt.preserved_mappings
        ),
        (2, 3, 2, 1)
    );
    let mappings = list_mappings(&f.c).unwrap();
    assert_eq!(mappings.len(), 4);
    for variant in ["duplicate-1", "duplicate-2"] {
        assert!(mappings.iter().any(|m| m.app_channel_id == variant
            && m.guide_source_id == "g"
            && m.xmltv_channel_id == "collision"));
    }
    assert_eq!(
        f.c.query_row(
            "SELECT count(*) FROM channel WHERE id IN ('duplicate-1','duplicate-2')",
            [],
            |r| { r.get::<_, i64>(0) }
        )
        .unwrap(),
        2
    );
    assert!(mappings.iter().any(|m| m.app_channel_id == "app-a"
        && m.guide_source_id == "g"
        && m.xmltv_channel_id == "xml-a"));
    assert!(mappings
        .iter()
        .any(|m| m.app_channel_id == "app-b" && m.guide_source_id == "other"));
    let again =
        replace_guide_and_match(&mut f.c, "g", 2, &data, 4000, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        (again.matched, again.unmatched, again.preserved_mappings),
        (0, 2, 4)
    );
}
#[test]
fn commit_and_match_cancellation_and_stale_revision_roll_back_schedule_and_mapping_together() {
    let mut f = fixture();
    f.c.execute_batch("ALTER TABLE channel ADD COLUMN provider_id TEXT;UPDATE channel SET provider_id='xml-a' WHERE id='app-a';")
        .unwrap();
    install(&mut f.c, "g", "Old");
    let flag = AtomicBool::new(false);
    assert!(
        replace_and_match_inner(&mut f.c, "g", 2, &feed("New"), 4000, &flag, || {
            flag.store(true, Ordering::SeqCst);
            Ok(())
        })
        .is_err()
    );
    assert!(list_mappings(&f.c).unwrap().is_empty());
    assert_eq!(list_sources(&f.c).unwrap()[0].revision, 2);
    assert_eq!(
        f.c.query_row(
            "SELECT title FROM guide_program WHERE guide_source_id='g'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "Old"
    );
    flag.store(false, Ordering::SeqCst);
    assert_eq!(
        replace_guide_and_match(&mut f.c, "g", 1, &feed("Stale"), 5000, &flag).unwrap_err(),
        "guide-stale-revision"
    );
    assert!(list_mappings(&f.c).unwrap().is_empty());
}

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

fn reviewed_fixture() -> (
    Fixture,
    super::super::reviewed_aliases::ReviewedAliases,
    ParsedGuide,
) {
    use super::super::reviewed_aliases::{AliasPair, ReviewedAliases};
    let mut f = fixture();
    f.c.execute_batch("ALTER TABLE metadata ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 7;ALTER TABLE channel ADD COLUMN provider_id TEXT;UPDATE channel SET provider_id='PGATour.us@SD';").unwrap();
    let mut src = source("pluto");
    src.location =
        "https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/PlutoTV/us.xml.gz".into();
    save_source(&mut f.c, &src, 0).unwrap();
    let mut data = feed("New PGA");
    data.channels[0].id = "5de94dacb394a300099fa22a".into();
    data.programs[0].channel_id = data.channels[0].id.clone();
    let aliases = ReviewedAliases {
        schema_version: 1,
        guide_location: src.location,
        provenance_location: "https://raw.githubusercontent.com/iptv-org/epg/master/sites/pluto.tv/pluto.tv_us.channels.xml".into(),
        provenance_sha256: "dc1eaca8b90b1d227850f81fb02793c74a804c473eb26dd674cd1eaa8084c89e".into(),
        pairs: vec![
            AliasPair {
                catalog_source_id: "catalog-a".into(),
                app_channel_id: "app-a".into(),
                provider_id: "PGATour.us@SD".into(),
                xmltv_channel_id: data.channels[0].id.clone(),
            },
            AliasPair {
                catalog_source_id: "catalog-b".into(),
                app_channel_id: "app-b".into(),
                provider_id: "PGATour.us@SD".into(),
                xmltv_channel_id: data.channels[0].id.clone(),
            },
        ],
    };
    (f, aliases, data)
}
#[test]
fn reviewed_pluto_aliases_publish_distinct_variants_and_retained_aliases_authorize_refresh() {
    let (mut f, aliases, data) = reviewed_fixture();
    let flag = AtomicBool::new(false);
    let receipt = replace_guide_if_matched_with_aliases(
        &mut f.c,
        "pluto",
        1,
        "7",
        &data,
        6000,
        &flag,
        Some(&aliases),
    )
    .unwrap();
    assert!(receipt.committed);
    assert_eq!((receipt.matched, receipt.preserved_mappings), (2, 0));
    let mappings = list_mappings(&f.c).unwrap();
    assert_eq!(mappings.len(), 2);
    assert!(mappings
        .iter()
        .all(|m| m.xmltv_channel_id == data.channels[0].id));
    let receipt = replace_guide_if_matched_with_aliases(
        &mut f.c,
        "pluto",
        2,
        "7",
        &data,
        7000,
        &flag,
        Some(&aliases),
    )
    .unwrap();
    assert!(receipt.committed);
    assert_eq!((receipt.matched, receipt.preserved_mappings), (2, 2));
    assert_eq!(list_mappings(&f.c).unwrap().len(), 2);
}
#[test]
fn reviewed_pluto_aliases_preserve_other_feed_mapping_without_authorizing_empty_publication() {
    let (mut f, aliases, data) = reviewed_fixture();
    install(&mut f.c, "other", "Other");
    save_mapping(&mut f.c, &mapping("other", "app-a", "catalog-a")).unwrap();
    save_mapping(&mut f.c, &mapping("other", "app-b", "catalog-b")).unwrap();
    let before = database_revision(&f.c).unwrap();
    let reply = replace_guide_if_matched_with_aliases(
        &mut f.c,
        "pluto",
        1,
        "7",
        &data,
        6000,
        &AtomicBool::new(false),
        Some(&aliases),
    )
    .unwrap();
    assert!(!reply.committed);
    assert_eq!(reply.matched, 0);
    assert_eq!(database_revision(&f.c).unwrap(), before);
    assert_eq!(source_coverage(&f.c, "pluto").unwrap().program_count, 0);
    assert!(list_mappings(&f.c)
        .unwrap()
        .iter()
        .all(|m| m.guide_source_id == "other"));
}
#[test]
fn reviewed_pluto_aliases_whole_refusal_preserves_schedule_and_revision() {
    let (mut f, aliases, data) = reviewed_fixture();
    let flag = AtomicBool::new(false);
    let before = database_revision(&f.c).unwrap();
    for mut invalid in [
        aliases.clone(),
        aliases.clone(),
        aliases.clone(),
        aliases.clone(),
    ]
    .into_iter()
    .enumerate()
    {
        match invalid.0 {
            0 => invalid.1.provenance_sha256 = "0".repeat(64),
            1 => invalid.1.pairs[0].provider_id = "PGATour.us".into(),
            2 => invalid.1.pairs[0].catalog_source_id = "wrong-source".into(),
            _ => invalid.1.pairs.push(invalid.1.pairs[0].clone()),
        }
        assert!(replace_guide_if_matched_with_aliases(
            &mut f.c,
            "pluto",
            1,
            "7",
            &data,
            6000,
            &flag,
            Some(&invalid.1)
        )
        .is_err());
    }
    assert_eq!(
        replace_guide_if_matched_with_aliases(
            &mut f.c,
            "pluto",
            1,
            "8",
            &data,
            6000,
            &flag,
            Some(&aliases)
        )
        .unwrap_err(),
        "catalog-revision-stale"
    );
    assert_eq!(
        replace_guide_if_matched_with_aliases(
            &mut f.c,
            "pluto",
            2,
            "7",
            &data,
            6000,
            &flag,
            Some(&aliases)
        )
        .unwrap_err(),
        "guide-stale-revision"
    );
    f.c.execute("INSERT INTO removed VALUES('app-a')", [])
        .unwrap();
    assert!(replace_guide_if_matched_with_aliases(
        &mut f.c,
        "pluto",
        1,
        "7",
        &data,
        6000,
        &flag,
        Some(&aliases)
    )
    .is_err());
    assert_eq!(database_revision(&f.c).unwrap(), before);
    assert_eq!(source_coverage(&f.c, "pluto").unwrap().program_count, 0);
    assert!(list_mappings(&f.c).unwrap().is_empty());
}
#[test]
fn reviewed_pluto_aliases_precommit_cancel_rolls_back_and_changed_source_refuses() {
    let (mut f, aliases, data) = reviewed_fixture();
    let flag = AtomicBool::new(false);
    let before = database_revision(&f.c).unwrap();
    let result = match_inner(
        &mut f.c,
        "pluto",
        1,
        Some(7),
        Some(&aliases),
        &data,
        6000,
        &flag,
        || {
            flag.store(true, Ordering::Release);
            Ok(())
        },
    );
    assert_eq!(result.unwrap_err(), "guide-cancelled");
    assert_eq!(database_revision(&f.c).unwrap(), before);
    assert!(list_mappings(&f.c).unwrap().is_empty());
    assert_eq!(source_coverage(&f.c, "pluto").unwrap().program_count, 0);
    flag.store(false, Ordering::Release);
    let mut changed = source("pluto");
    changed.revision = 1;
    changed.location = "https://changed.example/guide".into();
    save_source(&mut f.c, &changed, 1).unwrap();
    assert!(replace_guide_if_matched_with_aliases(
        &mut f.c,
        "pluto",
        2,
        "7",
        &data,
        6000,
        &flag,
        Some(&aliases)
    )
    .is_err());
    assert_eq!(source_coverage(&f.c, "pluto").unwrap().program_count, 0);
}
