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
    c.execute_batch("ALTER TABLE channel ADD COLUMN name TEXT NOT NULL DEFAULT '';ALTER TABLE channel ADD COLUMN category TEXT NOT NULL DEFAULT '';").unwrap();
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
        geography: serde_json::Map::new(),
        ppv: false,
        sports: None,
        history_ids: None,
        hide_adult: None,
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

// This module's parts, by area, are in database/tests/.
#[path = "database/tests/daily_and_guarded.rs"]
mod daily_and_guarded;
#[path = "database/tests/migration_and_paging.rs"]
mod migration_and_paging;
#[path = "database/tests/now_and_matching.rs"]
mod now_and_matching;
#[path = "database/tests/refresh_and_queries.rs"]
mod refresh_and_queries;
#[path = "database/tests/reviewed_aliases.rs"]
mod reviewed_aliases;
#[path = "database/tests/suggestions.rs"]
mod suggestions;

#[test]
fn sports_programmes_match_full_teams_categories_and_only_matching_ppv_before_page() {
    let mut f = fixture();
    let c = &mut f.c;
    save_source(c, &source("sports"), 0).unwrap();
    let mut data = feed("Chicago Bears at Green Bay Packers");
    for (n, title, category) in [
        (1, "NFL PPV Event", "NFL PPV"),
        (2, "NBA PPV Finals", "Basketball PPV"),
        (3, "Bears at Cardinals", "Sports"),
        (4, "Category Only", "NFL"),
    ] {
        let mut p = data.programs[0].clone();
        p.start_ms += n * 100;
        p.title = title.into();
        p.categories = vec![crate::guide::category::GuideCategory {
            text: category.into(),
            language: None,
        }];
        data.programs.push(p);
    }
    replace_guide(c, "sports", 1, &data, 3000, &AtomicBool::new(false)).unwrap();
    save_mapping(c, &mapping("sports", "app-a", "catalog-a")).unwrap();
    let mut q = query("sports", &["app-a"]);
    q.search = "NFL".into();
    q.sports = Some(crate::catalog::sports::Scope {
        sport: None,
        league: None,
        include_ppv: true,
        window_start_ms: 0,
        window_end_ms: 7 * 86400000,
        vocabulary_version: serde_json::from_str::<serde_json::Value>(
            crate::catalog::sports::VOCABULARY,
        )
        .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    });
    let p = query_programs(c, &q).unwrap();
    assert_eq!(
        p.programs
            .iter()
            .map(|p| p.title.as_str())
            .collect::<Vec<_>>(),
        [
            "Chicago Bears at Green Bay Packers",
            "NFL PPV Event",
            "Category Only"
        ]
    );
    q.page_size = 1;
    let first = query_programs(c, &q).unwrap();
    q.cursor = first.next_cursor;
    assert_eq!(
        query_programs(c, &q).unwrap().programs[0].title,
        "NFL PPV Event"
    );
    q.sports.as_mut().unwrap().include_ppv = false;
    assert_eq!(query_programs(c, &q).unwrap_err(), "guide-stale-cursor");
    q.cursor = None;
    q.page_size = 100;
    assert_eq!(query_programs(c, &q).unwrap().programs.len(), 2);
    q.ppv = true;
    assert_eq!(
        query_programs(c, &q).unwrap().programs[0].title,
        "NFL PPV Event"
    );
}

#[test]
fn sports_programme_cursor_binds_literal_punctuation_and_spacing() {
    let mut f = fixture();
    let c = &mut f.c;
    save_source(c, &source("punctuation"), 0).unwrap();
    let mut data = feed("foo bar");
    let mut second = data.programs[0].clone();
    second.start_ms = 1100;
    data.programs.push(second.clone());
    second.start_ms = 1200;
    second.title = "foo-bar".into();
    data.programs.push(second);
    replace_guide(c, "punctuation", 1, &data, 3000, &AtomicBool::new(false)).unwrap();
    save_mapping(c, &mapping("punctuation", "app-a", "catalog-a")).unwrap();
    let mut q = query("punctuation", &["app-a"]);
    q.search = "foo bar".into();
    q.page_size = 1;
    q.sports = Some(crate::catalog::sports::Scope {
        sport: None,
        league: None,
        include_ppv: false,
        window_start_ms: 0,
        window_end_ms: 10000,
        vocabulary_version: serde_json::from_str::<serde_json::Value>(
            crate::catalog::sports::VOCABULARY,
        )
        .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    });
    q.cursor = query_programs(c, &q).unwrap().next_cursor;
    assert!(q.cursor.is_some());
    assert_eq!(query_programs(c, &q).unwrap().programs[0].start_ms, 1100);
    q.search = "foo-bar".into();
    assert_eq!(query_programs(c, &q).unwrap_err(), "guide-stale-cursor");
    q.search = "foo  bar".into();
    assert_eq!(query_programs(c, &q).unwrap_err(), "guide-stale-cursor");
}

#[test]
fn sports_collegiate_programme_context_admits_observed_acc_programme_query() {
    let mut f = fixture();
    let c = &mut f.c;
    c.execute_batch(
        "UPDATE channel SET name='ACC Digital Network (1080p)',category='Sports' WHERE id='app-a'",
    )
    .unwrap();
    let mut data = feed("Miami vs. Duke (11.30.19) Football Replay");
    data.programs[0].description = Some("Duke takes down Miami in future Blue Devils head coach Manny Diaz's first year with the Hurricanes.".into());
    save_source(c, &source("college"), 0).unwrap();
    replace_guide(c, "college", 1, &data, 3000, &AtomicBool::new(false)).unwrap();
    save_mapping(c, &mapping("college", "app-a", "catalog-a")).unwrap();
    let mut q = query("college", &["app-a"]);
    q.search = "Football".into();
    q.sports = Some(crate::catalog::sports::Scope {
        sport: Some("american-football".into()),
        league: None,
        include_ppv: true,
        window_start_ms: 0,
        window_end_ms: 10_000,
        vocabulary_version: serde_json::from_str::<serde_json::Value>(
            crate::catalog::sports::VOCABULARY,
        )
        .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    });
    let page = query_programs(c, &q).unwrap();
    assert_eq!(page.programs.len(), 1);
    assert_eq!(page.programs[0].title, data.programs[0].title);
    q.search = "NFL".into();
    assert!(query_programs(c, &q).unwrap().programs.is_empty());
}
