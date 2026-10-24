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
use crate::guide::{
    conditional,
    parser::{GuideChannel, GuideProgram, ParsedGuide},
};
use std::sync::atomic::AtomicBool;
const DAY: i64 = 86_400_000;
fn fixture() -> (Connection, GuideSource, ParsedGuide) {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;PRAGMA user_version=1;CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,revision INTEGER,automatic_guide_updates INTEGER CHECK(automatic_guide_updates IS NULL OR automatic_guide_updates IN(0,1)));INSERT INTO metadata VALUES(1,0,1);CREATE TABLE preference(singleton INTEGER PRIMARY KEY,source_refresh_cadence TEXT,auto_source_refresh INTEGER);INSERT INTO preference VALUES(1,'off',0);").unwrap();
    db::migrate(&mut c).unwrap();
    c.execute_batch("PRAGMA user_version=3;").unwrap();
    db::migrate_suggestions(&mut c).unwrap();
    let source = GuideSource {
        id: "guide".into(),
        name: "Fixture".into(),
        kind: "url".into(),
        location: "https://fixture.invalid/guide.xml".into(),
        allow_http: false,
        revision: 0,
        updated_ms: None,
    };
    db::save_source(&mut c, &source, 0).unwrap();
    let source = db::list_sources(&c).unwrap().remove(0);
    let feed = ParsedGuide {
        channels: vec![GuideChannel {
            id: "channel".into(),
            names: vec!["Channel".into()],
        }],
        programs: vec![GuideProgram {
            channel_id: "channel".into(),
            start_ms: 1000,
            stop_ms: Some(5 * DAY),
            title: "Last good".into(),
            description: None,
            categories: vec![],
        }],
    };
    db::replace_guide_conditional(
        &mut c,
        &source,
        &feed,
        2000,
        &validators(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let source = db::list_sources(&c).unwrap().remove(0);
    (c, source, feed)
}
fn validators() -> conditional::Validators {
    conditional::Validators {
        etag: Some("\"fixture\"".into()),
        last_modified: None,
    }
}
#[test]
fn guide_on_source_off_plans_and_claims_daily_independently() {
    let (mut c, source, _) = fixture();
    let due = 2000 + DAY;
    assert_eq!(plan(&c, 0).unwrap().sources[0].next_due_ms, due);
    assert!(
        !claim(&mut c, &source.id, source.revision, due - 1)
            .unwrap()
            .2
    );
    assert!(claim(&mut c, &source.id, source.revision, due).unwrap().2);
    for cadence in ["hourly", "weekly", "monthly", "off"] {
        c.execute("UPDATE preference SET source_refresh_cadence=?1", [cadence])
            .unwrap();
        assert_eq!(plan(&c, due).unwrap().sources[0].next_due_ms, due + DAY);
        assert_eq!(next_after_success(&c, due).unwrap(), due + DAY);
    }
}
#[test]
fn guide_off_source_on_does_not_claim_or_create_attempt_state() {
    let (mut c, source, _) = fixture();
    c.execute_batch(
        "UPDATE metadata SET automatic_guide_updates=0;UPDATE preference SET source_refresh_cadence='hourly',auto_source_refresh=1;",
    )
    .unwrap();
    assert!(plan(&c, 2 * DAY).unwrap().sources.is_empty());
    assert_eq!(
        claim(&mut c, &source.id, source.revision, 2 * DAY).unwrap_err(),
        "guide-refresh-disabled"
    );
    assert_eq!(
        next_after_success(&c, 2 * DAY).unwrap_err(),
        "guide-refresh-disabled"
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='guide_refresh_state'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(db::list_sources(&c).unwrap()[0], source);
}
#[test]
fn legacy_absence_and_null_remain_enabled_but_invalid_values_refuse() {
    let (c, _, _) = fixture();
    c.execute("UPDATE metadata SET automatic_guide_updates=NULL", [])
        .unwrap();
    assert_eq!(next_after_success(&c, 2000).unwrap(), 2000 + DAY);
    c.execute_batch("ALTER TABLE metadata DROP COLUMN automatic_guide_updates;")
        .unwrap();
    assert_eq!(next_after_success(&c, 2000).unwrap(), 2000 + DAY);
    c.execute_batch("ALTER TABLE metadata ADD COLUMN automatic_guide_updates INTEGER;UPDATE metadata SET automatic_guide_updates=2;")
        .unwrap();
    assert_eq!(
        plan(&c, 2000).err().unwrap(),
        "guide-refresh-invalid-policy"
    );
    c.execute("DELETE FROM metadata", []).unwrap();
    assert_eq!(
        plan(&c, 2000).err().unwrap(),
        "guide-refresh-invalid-policy"
    );
    c.execute_batch(
        "ALTER TABLE metadata DROP COLUMN automatic_guide_updates;PRAGMA user_version=11;",
    )
    .unwrap();
    assert_eq!(
        plan(&c, 2000).err().unwrap(),
        "guide-refresh-invalid-policy"
    );
}
#[test]
fn held_claim_cannot_publish_200_or_revalidate_304_after_permission_off() {
    let (mut c, source, mut feed) = fixture();
    let due = 2000 + DAY;
    assert!(claim(&mut c, &source.id, source.revision, due).unwrap().2);
    let cached = conditional::read(&c, &source).unwrap().unwrap();
    c.execute("UPDATE metadata SET automatic_guide_updates=0", [])
        .unwrap();
    feed.programs[0].title = "Obsolete replacement".into();
    assert_eq!(
        db::replace_guide_conditional(
            &mut c,
            &source,
            &feed,
            due + 1000,
            &validators(),
            &AtomicBool::new(false)
        )
        .unwrap_err(),
        "guide-refresh-disabled"
    );
    assert_eq!(
        conditional::revalidate(
            &mut c,
            &source,
            &cached,
            &conditional::Validators::default(),
            due + 1000,
            &AtomicBool::new(false)
        )
        .unwrap_err(),
        "guide-refresh-disabled"
    );
    assert_eq!(db::list_sources(&c).unwrap()[0], source);
    assert_eq!(
        conditional::read(&c, &source).unwrap().unwrap().validators,
        cached.validators
    );
    assert_eq!(
        c.query_row("SELECT title FROM guide_program", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "Last good"
    );
    assert_eq!(
        c.query_row("SELECT checked_ms FROM guide_http_cache", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        2000
    );
    assert_eq!(
        c.query_row("SELECT attempted_ms FROM guide_refresh_state", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        due
    );
    // The automatic permission is not a prohibition on explicit manual publication.
    db::replace_guide(
        &mut c,
        &source.id,
        source.revision,
        &feed,
        due + 2000,
        &AtomicBool::new(false),
    )
    .unwrap();
}
#[test]
fn canceled_publication_keeps_last_good_and_source_revision() {
    let (mut c, source, feed) = fixture();
    assert_eq!(
        db::replace_guide_conditional(
            &mut c,
            &source,
            &feed,
            3000,
            &validators(),
            &AtomicBool::new(true)
        )
        .unwrap_err(),
        "canceled"
    );
    assert_eq!(db::list_sources(&c).unwrap()[0], source);
    assert_eq!(
        conditional::read(&c, &source).unwrap().unwrap().validators,
        validators()
    );
    assert_eq!(
        claim(&mut c, &source.id, source.revision + 1, 2 * DAY).unwrap_err(),
        "guide-stale-revision"
    );
}
