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

//! Guide database tests: the now-playing context, and commit-and-match.

use super::*;

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
