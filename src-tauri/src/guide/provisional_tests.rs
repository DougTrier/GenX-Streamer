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
use crate::{
    guide::{input, parser, retention},
    storage::Store,
};
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};
const NOW: i64 = 4 * retention::DAY + retention::DAY / 2;
fn descriptor() -> GuideSource {
    GuideSource {
        id: "proposal".into(),
        name: "Proposed guide".into(),
        location: "https://fixture.invalid/new.xml".into(),
        kind: "url".into(),
        allow_http: false,
        revision: 0,
        updated_ms: None,
    }
}
fn fixture() -> (tempfile::TempDir, Store) {
    let root = tempfile::tempdir().unwrap();
    let store = Store::new(root.path().into(), "proposed-guide-fixture".into()).unwrap();
    store.write("catalog", &serde_json::json!({"schemaVersion":1,"sources":[{"id":"catalog","name":"Channels","location":"channels.m3u","kind":"file"}],"channels":[{"id":"live","sourceId":"catalog","providerId":"exact","name":"Live channel","category":"News","urls":["https://fixture.invalid/live.m3u8"]}]}).to_string()).unwrap();
    (root, store)
}
fn scope(store: &Store) -> retention::Scope {
    store
        .with_guide_read(|c| {
            let tx = db::sql(c.unchecked_transaction())?;
            let s = retention::capture_proposed(&tx, descriptor(), NOW)?;
            db::sql(tx.commit())?;
            Ok(s)
        })
        .unwrap()
}
fn request(store: &Store, allow_empty: bool) -> retention::Request {
    retention::Request {
        scope: scope(store),
        authority: None,
        aliases: None,
        automatic: false,
        allow_empty,
    }
}
fn feed() -> parser::ParsedGuide {
    parser::ParsedGuide {
        channels: vec![parser::GuideChannel {
            id: "exact".into(),
            names: vec!["Actual channel".into()],
        }],
        programs: vec![parser::GuideProgram {
            channel_id: "exact".into(),
            start_ms: NOW - 1000,
            stop_ms: Some(NOW + 60000),
            title: "Actual program".into(),
            description: None,
            categories: vec![],
        }],
    }
}
fn publish(
    store: &Store,
    request: &retention::Request,
    feed: &parser::ParsedGuide,
    flag: &AtomicBool,
) -> Result<i64, String> {
    // Same two guard boundaries as native commit: read proof before checked backup,
    // then an independent proof within the publication transaction.
    store.with_guide_read(|c| retention::verify(c, &request.scope))?;
    store.with_guide_write_checked(
        |c| db::replace_guide_projected(c, request, feed, NOW, flag),
        || {
            if flag.load(Ordering::Acquire) {
                Err("canceled".into())
            } else {
                Ok(())
            }
        },
    )
}
fn source_count(store: &Store) -> i64 {
    store
        .with_guide_read(|c| {
            db::sql(c.query_row("SELECT count(*) FROM guide_source", [], |r| r.get(0)))
        })
        .unwrap()
}
fn backup_stamp(root: &std::path::Path) -> SystemTime {
    fs::metadata(root.join("genx.sqlite3.backup"))
        .unwrap()
        .modified()
        .unwrap()
}
fn stamp_old(root: &std::path::Path) {
    fs::File::options()
        .write(true)
        .open(root.join("genx.sqlite3.backup"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH))
        .unwrap();
}

#[test]
fn proposed_guide_failed_input_and_discard_have_no_sql_or_backup_side_effect() {
    let (root, store) = fixture();
    stamp_old(root.path());
    let main = fs::read(root.path().join("genx.sqlite3")).unwrap();
    let backup = fs::read(root.path().join("genx.sqlite3.backup")).unwrap();
    let stamp = backup_stamp(root.path());
    for failure in 0..5 {
        let captured = scope(&store); // The same real read-only capture used before native acquisition.
        let flag = AtomicBool::new(failure == 4);
        let bytes: Result<Vec<u8>, String> = match failure {
            0 => Err("http-404".into()),
            1 => Ok(vec![0; input::INPUT_LIMIT + 1]),
            2 => Ok(vec![0x1f, 0x8b, 0]),
            _ => Ok(b"<tv><channel".to_vec()),
        };
        let result = bytes
            .and_then(|b| input::expand(b, &flag))
            .and_then(|b| parser::parse_guide_cancelable(&b, &flag));
        assert!(result.is_err());
        drop(captured);
        assert_eq!(source_count(&store), 0);
        assert!(
            fs::read(root.path().join("genx.sqlite3")).unwrap() == main,
            "failed admission wrote primary"
        );
        assert!(
            fs::read(root.path().join("genx.sqlite3.backup")).unwrap() == backup,
            "failed admission wrote backup"
        );
        assert_eq!(
            backup_stamp(root.path()),
            stamp,
            "failed admission entered backup"
        );
    }
    drop(scope(&store)); // successful preview disposal also has no persistence.
    assert_eq!(backup_stamp(root.path()), stamp);
    assert_eq!(source_count(&store), 0);
}
#[test]
fn proposed_guide_atomically_creates_published_revision_and_replay_cannot_write() {
    let (root, store) = fixture();
    let r = request(&store, false);
    assert_eq!(source_count(&store), 0);
    assert_eq!(
        publish(&store, &r, &feed(), &AtomicBool::new(false)).unwrap(),
        1
    );
    store
        .with_guide_read(|c| {
            assert_eq!(db::list_sources(c)?[0].revision, 1);
            assert_eq!(
                db::source_coverage(c, "proposal")?.published_revision,
                Some(1)
            );
            assert_eq!(db::source_coverage(c, "proposal")?.program_count, 1);
            retention::validate(c)
        })
        .unwrap();
    stamp_old(root.path());
    let bytes = fs::read(root.path().join("genx.sqlite3")).unwrap();
    assert!(publish(&store, &r, &feed(), &AtomicBool::new(false)).is_err());
    assert_eq!(backup_stamp(root.path()), UNIX_EPOCH);
    assert!(fs::read(root.path().join("genx.sqlite3")).unwrap() == bytes);
    drop(store);
    let reopened = Store::new(root.path().into(), "proposed-guide-fixture".into()).unwrap();
    assert_eq!(source_count(&reopened), 1);
}
#[test]
fn proposed_guide_existing_id_or_location_race_preserves_explicit_source() {
    for same_id in [false, true] {
        let (root, store) = fixture();
        let r = request(&store, false);
        let mut user = descriptor();
        if !same_id {
            user.id = "explicit-user".into();
        }
        user.name = "User choice".into();
        store
            .with_guide_write(|c| db::save_source(c, &user, 0))
            .unwrap();
        stamp_old(root.path());
        assert!(publish(&store, &r, &feed(), &AtomicBool::new(false)).is_err());
        assert_eq!(source_count(&store), 1);
        assert_eq!(backup_stamp(root.path()), UNIX_EPOCH);
        assert_eq!(
            store.with_guide_read(db::list_sources).unwrap()[0].name,
            "User choice"
        );
    }
}
#[test]
fn proposed_guide_catalog_removal_and_source_removal_fences_are_not_overwritten() {
    for removal in [false, true] {
        let (root, store) = fixture();
        let r = request(&store, false);
        if removal {
            let saved = store
                .with_guide_write(|c| db::save_source(c, &descriptor(), 0))
                .unwrap();
            store
                .with_guide_write(|c| db::remove_source(c, &saved.id, saved.revision))
                .unwrap();
        } else {
            store.write("preferences",r#"{"schemaVersion":1,"sources":[],"favorites":[],"removedChannels":["live"],"volume":0.5,"muted":false,"panelWidth":300}"#).unwrap();
        }
        stamp_old(root.path());
        assert!(publish(&store, &r, &feed(), &AtomicBool::new(false)).is_err());
        assert_eq!(source_count(&store), 0);
        assert_eq!(backup_stamp(root.path()), UNIX_EPOCH);
    }
}
#[test]
fn proposed_guide_transaction_failure_rolls_back_descriptor_and_schedule() {
    let (_root, store) = fixture();
    store
        .with_guide_write(|c| {
            db::sql(c.execute_batch(
                "CREATE TRIGGER refuse_proposed_program BEFORE INSERT ON guide_program BEGIN SELECT RAISE(ABORT,'fixture refusal');END;",
            ))
        })
        .unwrap();
    let r = request(&store, false);
    assert!(publish(&store, &r, &feed(), &AtomicBool::new(false)).is_err());
    assert_eq!(source_count(&store), 0);
    assert_eq!(
        store
            .with_guide_read(|c| db::sql(c.query_row(
                "SELECT count(*) FROM guide_program",
                [],
                |r| r.get::<_, i64>(0)
            )))
            .unwrap(),
        0
    );
}
#[test]
fn proposed_guide_cancellation_after_source_insert_rolls_back_everything() {
    let (_root, store) = fixture();
    let r = request(&store, false);
    let flag = Arc::new(AtomicBool::new(false));
    let interrupted = flag.clone();
    let result = store.with_guide_write_checked(
        |c| {
            c.update_hook(Some(
                move |_: rusqlite::hooks::Action, _: &str, table: &str, _: i64| {
                    if table == "guide_source" {
                        interrupted.store(true, Ordering::Release);
                    }
                },
            ))
            .unwrap();
            db::replace_guide_projected(c, &r, &feed(), NOW, &flag)
        },
        || Ok(()),
    );
    assert!(result.is_err());
    assert!(flag.load(Ordering::Acquire));
    assert_eq!(source_count(&store), 0);
}
#[test]
fn proposed_guide_empty_requires_explicit_confirmation_and_never_fabricates_schedule() {
    let (_root, store) = fixture();
    let empty = parser::ParsedGuide {
        channels: vec![],
        programs: vec![],
    };
    assert!(publish(
        &store,
        &request(&store, false),
        &empty,
        &AtomicBool::new(false)
    )
    .is_err());
    assert_eq!(source_count(&store), 0);
    assert_eq!(
        publish(
            &store,
            &request(&store, true),
            &empty,
            &AtomicBool::new(false)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        store
            .with_guide_read(|c| db::source_coverage(c, "proposal"))
            .unwrap()
            .program_count,
        0
    );
}
#[test]
fn proposed_guide_refuses_capacity_and_ungranted_descriptors() {
    let (_root, store) = fixture();
    for mutation in 0..4 {
        let mut s = descriptor();
        match mutation {
            0 => s.allow_http = true,
            1 => s.location = "http://fixture.invalid/x".into(),
            2 => s.revision = 1,
            _ => s.kind = "file".into(),
        };
        assert!(store
            .with_guide_read(|c| retention::capture_proposed(c, s, NOW))
            .is_err());
    }
    store.with_guide_write(|c| { for i in 0..1000 { db::sql(c.execute("INSERT INTO guide_source(id,name,location,kind,allow_http,revision) VALUES(?1,'Explicit','https://fixture.invalid/existing','url',0,1)",[format!("existing-{i}")]))?; } Ok(()) }).unwrap();
    assert!(
        matches!(store.with_guide_read(|c|retention::capture_proposed(c,descriptor(),NOW)),Err(e) if e=="guide-source-limit")
    );
}

#[test]
fn proposed_guide_removed_provider_choice_is_a_final_native_scope_fence() {
    let (root, store) = fixture();
    let mut preferences = serde_json::json!({"schemaVersion":1,"sources":[],"favorites":[],"removedChannels":[],"volume":0.5,"muted":false,"panelWidth":300,"reviewedGuideProviders":[{"id":"suggestion","name":"Guide","location":"https://fixture.invalid/new.xml","provenance":"https://publisher.invalid/index","limitations":"Unverified"}]});
    store
        .write("preferences", &preferences.to_string())
        .unwrap();
    let r = request(&store, false);
    preferences["reviewedGuideProviders"] = serde_json::json!([]);
    store
        .write("preferences", &preferences.to_string())
        .unwrap();
    stamp_old(root.path());
    assert!(publish(&store, &r, &feed(), &AtomicBool::new(false)).is_err());
    assert_eq!(source_count(&store), 0);
    assert_eq!(backup_stamp(root.path()), UNIX_EPOCH);
}

#[test]
fn explicit_configuration_save_remains_durable_when_later_preview_is_bad() {
    let (root, store) = fixture();
    stamp_old(root.path());
    // Negative control: this is the preserved explicit-user configuration path,
    // and reproduces why using it for speculative suggestions was expensive.
    store
        .with_guide_write(|c| db::save_source(c, &descriptor(), 0))
        .unwrap();
    assert!(parser::parse_guide(b"<tv><channel").is_err());
    assert_eq!(source_count(&store), 1);
    assert_ne!(backup_stamp(root.path()), UNIX_EPOCH);
}
