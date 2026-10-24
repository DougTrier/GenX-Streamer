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
