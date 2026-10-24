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
use crate::storage_budget::{occupied_bytes, with_guide_limit};
use serde_json::Value;

fn seeded() -> Fixture {
    let mut f = fixture();
    f.c.execute_batch("ALTER TABLE channel ADD COLUMN provider_id TEXT;UPDATE channel SET provider_id='xml-a' WHERE id='app-a';ALTER TABLE metadata ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 0;").unwrap();
    save_source(&mut f.c, &source("g"), 0).unwrap();
    let s = list_sources(&f.c).unwrap().remove(0);
    let mut old = feed("Last good");
    old.programs[0].stop_ms = Some(10_000);
    replace_guide_conditional(
        &mut f.c,
        &s,
        &old,
        2000,
        &super::super::super::conditional::Validators {
            etag: Some("\"old\"".into()),
            last_modified: None,
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    save_mapping(&mut f.c, &mapping("g", "app-a", "catalog-a")).unwrap();
    f
}
fn snapshot(c: &Connection) -> Value {
    let mut stmt = c.prepare("SELECT guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,description,search_text,categories_json,categories_key FROM guide_program ORDER BY guide_source_id,ordinal").unwrap();
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<i64>>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, String>(9)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let validators: (String,i64,Option<String>,Option<String>,i64) = c.query_row("SELECT fingerprint,published_revision,etag,last_modified,checked_ms FROM guide_http_cache WHERE source_id='g'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    serde_json::json!({"sources":list_sources(c).unwrap(),"mappings":list_mappings(c).unwrap(),"programs":rows,"validators":validators,"revision":database_revision(c).unwrap()})
}

#[test]
fn every_guide_feed_entry_refuses_growth_atomically_including_validators_and_mappings() {
    for path in [
        "manual",
        "checkpointed",
        "conditional",
        "publish",
        "match",
        "if-matched",
    ] {
        let mut f = seeded();
        let before = snapshot(&f.c);
        let limit = occupied_bytes(&f.c).unwrap();
        let mut next = feed("Growing");
        next.programs[0].stop_ms = Some(10_000);
        next.programs[0].description = Some("x".repeat(65_536));
        let flag = AtomicBool::new(false);
        let error = with_guide_limit(limit, || match path {
            "manual" => replace_guide(&mut f.c, "g", 2, &next, 3000, &flag).map(|_| ()),
            "checkpointed" => {
                replace_inner(&mut f.c, "g", 2, &next, 3000, &flag, |_| Ok(())).map(|_| ())
            }
            "conditional" => {
                let s = list_sources(&f.c).unwrap().remove(0);
                replace_guide_conditional(
                    &mut f.c,
                    &s,
                    &next,
                    3000,
                    &super::super::super::conditional::Validators {
                        etag: Some("\"new\"".into()),
                        last_modified: None,
                    },
                    &flag,
                )
                .map(|_| ())
            }
            "publish" => {
                let mut s = list_sources(&f.c).unwrap().remove(0);
                s.name = "Edited".into();
                s.updated_ms = None;
                publish_source(&mut f.c, &s, 2, &next, 3000, &flag).map(|_| ())
            }
            "match" => replace_guide_and_match(&mut f.c, "g", 2, &next, 3000, &flag).map(|_| ()),
            _ => replace_guide_if_matched(&mut f.c, "g", 2, "0", &next, 3000, &flag).map(|_| ()),
        })
        .unwrap_err();
        assert_eq!(error, "guide-storage-budget-exceeded", "{path}");
        assert_eq!(snapshot(&f.c), before, "{path}");
        let reopened = Connection::open(f._dir.path().join("guide.sqlite3")).unwrap();
        assert_eq!(snapshot(&reopened), before, "{path}");
    }
}

#[test]
fn legacy_above_guide_limit_can_replace_without_growth_or_reduce_rows() {
    let mut f = seeded();
    let mut large = feed("Large");
    large.programs[0].description = Some("x".repeat(65_536));
    replace_guide(&mut f.c, "g", 2, &large, 3000, &AtomicBool::new(false)).unwrap();
    let occupied = occupied_bytes(&f.c).unwrap();
    with_guide_limit(0, || {
        replace_guide(&mut f.c, "g", 3, &large, 4000, &AtomicBool::new(false))
    })
    .unwrap();
    assert_eq!(occupied_bytes(&f.c).unwrap(), occupied);
    with_guide_limit(0, || {
        replace_guide(
            &mut f.c,
            "g",
            4,
            &feed("Reduced"),
            5000,
            &AtomicBool::new(false),
        )
    })
    .unwrap();
    assert!(occupied_bytes(&f.c).unwrap() < occupied);
    assert_eq!(list_mappings(&f.c).unwrap().len(), 1);
}

#[test]
fn guide_budget_does_not_replace_cancellation_or_stale_revision_guards() {
    let mut f = seeded();
    let before = snapshot(&f.c);
    with_guide_limit(0, || {
        assert_eq!(
            replace_guide(
                &mut f.c,
                "g",
                1,
                &feed("Stale"),
                3000,
                &AtomicBool::new(false)
            )
            .unwrap_err(),
            "guide-stale-revision"
        );
        assert_eq!(
            replace_guide(
                &mut f.c,
                "g",
                2,
                &feed("Canceled"),
                3000,
                &AtomicBool::new(true)
            )
            .unwrap_err(),
            "guide-cancelled"
        );
    });
    assert_eq!(snapshot(&f.c), before);
}
