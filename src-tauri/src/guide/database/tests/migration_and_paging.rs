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

//! Guide database tests: versioned migration, atomic refresh, source scope,
//! Unicode search and stale cursors.

use super::*;

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
