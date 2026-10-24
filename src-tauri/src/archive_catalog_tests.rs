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
include!("archive_date_assessment_tests.rs");
fn database() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;CREATE TABLE unrelated_station(id TEXT PRIMARY KEY);INSERT INTO unrelated_station VALUES('station-retained');").unwrap();
    let tx = c.transaction().unwrap();
    install(&tx).unwrap();
    crate::archive_bookmarks::install(&tx).unwrap();
    tx.commit().unwrap();
    c
}
#[test]
fn archive_library_clear_resets_bookmarks_in_same_cas_transaction_and_cancel_rolls_all_back() {
    let mut c = database();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![title("chosen", Some(1964), 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    let reference = opaque(&["archive-file-v1", "chosen", "one.mp4"]);
    c.execute(
        "UPDATE archive_file_v1 SET sha1=?1",
        ["0123456789abcdef0123456789abcdef01234567"],
    )
    .unwrap();
    let file = resolve(&c, &reference, "1").unwrap();
    let proof = crate::archive_bookmarks::capture(&reference, &file).unwrap();
    let position = crate::archive_bookmarks::Position {
        position_ms: 12345,
        duration_ms: Some(60000),
        completed: false,
        observed_ms: 1000,
    };
    crate::archive_bookmarks::save(&mut c, &proof, "0", &position, || Ok(())).unwrap();
    let checks = std::cell::Cell::new(0);
    assert!(remove(&mut c, &RemovalScope::All, None, "1", &mut || {
        checks.set(checks.get() + 1);
        if checks.get() == 3 {
            Err("canceled".into())
        } else {
            Ok(())
        }
    })
    .is_err());
    assert_eq!(current(&c).unwrap(), 1);
    assert!(crate::archive_bookmarks::read(&c, &proof)
        .unwrap()
        .position
        .is_some());
    let receipt = remove(&mut c, &RemovalScope::All, None, "1", &mut || Ok(())).unwrap();
    assert!(receipt.committed);
    assert_eq!(receipt.revision, "2");
    assert!(!serde_json::to_string(&receipt)
        .unwrap()
        .contains("bookmark"));
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_bookmark_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT revision FROM archive_bookmark_meta_v1", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        2
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM unrelated_station", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    // Empty Clear also revokes an earlier captured bookmark revision.
    remove(&mut c, &RemovalScope::All, None, "2", &mut || Ok(())).unwrap();
    assert_eq!(
        c.query_row("SELECT revision FROM archive_bookmark_meta_v1", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        3
    );
}
fn title(id: &str, year: Option<i64>, downloads: i64) -> PreparedTitle {
    PreparedTitle {
        partial: None,
        item_id: id.into(),
        title: "Identical provider title".into(),
        search_aliases: "identical provider title".into(),
        kind: "tv",
        year,
        rights: None,
        downloads,
        servers: vec!["ia800000.us.archive.org".into()],
        all_file_names: vec!["one.mp4".into(), "two.mp4".into()],
        files: vec![
            PreparedFile {
                provider_index: None,
                original: Some("one.mpg".into()),
                file_title: None,
                name: "one.mp4".into(),
                size: "100".into(),
                duration: Some(60.0),
                sha1: None,
            },
            PreparedFile {
                provider_index: None,
                original: Some("two.mpg".into()),
                file_title: None,
                name: "two.mp4".into(),
                size: "200".into(),
                duration: None,
                sha1: None,
            },
        ],
    }
}
fn step(titles: Vec<PreparedTitle>) -> PreparedStep {
    PreparedStep {
        item_page: false,
        titles,
        deleted: Vec::new(),
        examined: 12,
        unknown_year: 0,
        transient_failures: 0,
        unavailable: 0,
        capacity_reached: false,
        next_page: None,
        observed_ms: 1_000_000,
    }
}
fn page(next: u32, expected: Option<u32>) -> PreparedPage {
    PreparedPage {
        provider_count: 2000,
        next_offset: next,
        fingerprint: "a".repeat(64),
        scanned_bytes: 1000,
        curation_year: None,
        expected_offset: expected,
        expected_fingerprint: expected.map(|_| "a".repeat(64)),
        capacity: false,
    }
}

// This module's parts, by area, are in archive_catalog/tests/.
#[path = "archive_catalog/tests/pages.rs"]
mod pages;
#[path = "archive_catalog/tests/removal_and_migration.rs"]
mod removal_and_migration;
#[path = "archive_catalog/tests/search_metadata.rs"]
mod search_metadata;
use search_metadata::*;
#[path = "archive_catalog/tests/languages.rs"]
mod languages;
#[path = "archive_catalog/tests/ranking_and_favorites.rs"]
mod ranking_and_favorites;
#[path = "archive_catalog/tests/refresh_and_observed.rs"]
mod refresh_and_observed;
#[path = "archive_catalog/tests/relevance.rs"]
mod relevance;
#[path = "archive_catalog/tests/visible_yield.rs"]
mod visible_yield;
