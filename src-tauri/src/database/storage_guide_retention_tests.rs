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
    guide::{
        database as db,
        parser::{GuideChannel, GuideProgram, ParsedGuide},
        retention,
    },
    storage::Store,
};
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
fn fixture() -> (tempfile::TempDir, Store) {
    let root = tempfile::tempdir().unwrap();
    let store = Store::new(root.path().into(), "test".into()).unwrap();
    store.with_guide_write(|c|{c.execute_batch("CREATE TABLE retention_sentinel(payload BLOB);INSERT INTO retention_sentinel VALUES(zeroblob(1048576));INSERT INTO source(id,name,location,kind,allow_http,ordinal) VALUES('s','Fixture','https://example.invalid/list','url',0,0);INSERT INTO channel(id,source_id,provider_id,name,category,ordinal) VALUES('c','s','exact','Saved','News',0);").unwrap();db::save_source(c,&db::GuideSource{id:"g".into(),name:"Guide".into(),location:"https://example.invalid/guide".into(),kind:"url".into(),allow_http:false,revision:0,updated_ms:None},0)?;c.execute_batch("VACUUM;").unwrap();Ok(())}).unwrap();
    (root, store)
}
fn now() -> i64 {
    10 * retention::DAY + 10000
}
fn feed() -> ParsedGuide {
    ParsedGuide {
        channels: vec![
            GuideChannel {
                id: "exact".into(),
                names: vec!["Exact".into()],
            },
            GuideChannel {
                id: "foreign".into(),
                names: vec!["Foreign".into()],
            },
        ],
        programs: vec![
            GuideProgram {
                channel_id: "exact".into(),
                start_ms: now(),
                stop_ms: Some(now() + 100000),
                title: "Saved program".into(),
                description: None,
                categories: vec![],
            },
            GuideProgram {
                channel_id: "foreign".into(),
                start_ms: now(),
                stop_ms: Some(now() + 100000),
                title: "Other".into(),
                description: Some("x".repeat(16000)),
                categories: vec![],
            },
        ],
    }
}
fn request(store: &Store) -> retention::Request {
    store
        .with_guide_read(|c| {
            Ok(retention::Request {
                scope: retention::capture_snapshot(c, "g", now())?,
                authority: None,
                aliases: None,
                automatic: false,
                allow_empty: false,
            })
        })
        .unwrap()
}
fn pair(root: &Path) -> PairStore {
    PairStore {
        root: root.into(),
        require_database: true,
        page_cache: Default::default(),
    }
}
fn images(root: &Path) -> (Vec<u8>, Vec<u8>) {
    (
        fs::read(root.join(DB)).unwrap(),
        fs::read(root.join(BACKUP)).unwrap(),
    )
}
fn non_guide(c: &Connection) -> String {
    use rusqlite::types::ValueRef;
    let mut hash = Sha256::new();
    let mut tables = c
        .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'guide_%' ORDER BY name")
        .unwrap();
    let all: Vec<(String, Option<String>)> = tables
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for (name, schema) in all {
        hash.update(name.as_bytes());
        hash.update(schema.unwrap_or_default().as_bytes());
        let mut q = c
            .prepare(&format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")))
            .unwrap();
        let n = q.column_count();
        let mut rows = q.query([]).unwrap();
        let mut values = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            let mut h = Sha256::new();
            for i in 0..n {
                match row.get_ref(i).unwrap() {
                    ValueRef::Null => h.update([0]),
                    ValueRef::Integer(v) => {
                        h.update([1]);
                        h.update(v.to_be_bytes());
                    }
                    ValueRef::Real(v) => {
                        h.update([2]);
                        h.update(v.to_bits().to_be_bytes());
                    }
                    ValueRef::Text(v) => {
                        h.update([3]);
                        h.update((v.len() as u64).to_be_bytes());
                        h.update(v);
                    }
                    ValueRef::Blob(v) => {
                        h.update([4]);
                        h.update((v.len() as u64).to_be_bytes());
                        h.update(v);
                    }
                }
            }
            values.push(<[u8; 32]>::from(h.finalize()));
        }
        values.sort_unstable();
        hash.update((values.len() as u64).to_be_bytes());
        for v in values {
            hash.update(v);
        }
    }
    format!("{:x}", hash.finalize())
}
#[test]
fn schema17_upgrade_is_non_destructive_and_unsupported_future_policy_refuses_older_backup() {
    let (root, store) = fixture();
    store
        .with_guide_write(|c| {
            db::replace_guide(c, "g", 1, &feed(), now() - 5000, &AtomicBool::new(false)).map(|_| ())
        })
        .unwrap();
    let expected = store.with_guide_read(|c| Ok(non_guide(c))).unwrap();
    drop(store);
    {
        let c = connect(&root.path().join(DB), false).unwrap();
        c.execute_batch("DROP TABLE guide_projection_v1;ALTER TABLE preference DROP COLUMN content_library;PRAGMA user_version=17;")
            .unwrap();
    }
    let store = Store::new(root.path().into(), "test".into()).unwrap();
    store
        .with_guide_read(|c| {
            assert_eq!(
                c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                19
            );
            assert_eq!(
                c.query_row("SELECT count(*) FROM guide_program", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                2
            );
            assert_eq!(non_guide(c), expected);
            Ok(())
        })
        .unwrap();
    let r = request(&store);
    store
        .with_guide_write_checked(
            |c| db::replace_guide_projected(c, &r, &feed(), now(), &AtomicBool::new(false)),
            || Ok(()),
        )
        .unwrap();
    store
        .with_guide_write_checked(|_| Ok(()), || Ok(()))
        .unwrap();
    drop(store);
    {
        let c = connect(&root.path().join(DB), false).unwrap();
        c.execute("UPDATE guide_projection_v1 SET policy_version=99", [])
            .unwrap();
    }
    let before = images(root.path());
    let archive = fs::read(root.path().join("archive-library-v1/archive.sqlite3")).unwrap();
    assert_eq!(
        Store::new(root.path().into(), "test".into()).err().unwrap(),
        "guide-projection-policy-unsupported"
    );
    assert_eq!(images(root.path()), before);
    assert_eq!(
        fs::read(root.path().join("archive-library-v1/archive.sqlite3")).unwrap(),
        archive
    );
}
#[test]
fn real_cleanup_one_maintenance_episode_preserves_all_non_guide_rows_and_archive_bytes() {
    let (root, store) = fixture();
    store
        .with_guide_write(|c| {
            db::replace_guide(c, "g", 1, &feed(), now() - 5000, &AtomicBool::new(false)).map(|_| ())
        })
        .unwrap();
    let expected = store.with_guide_read(|c| Ok(non_guide(c))).unwrap();
    let archive = fs::read(root.path().join("archive-library-v1/archive.sqlite3")).unwrap();
    let plan = store
        .with_guide_read(|c| retention::prepare_cleanup(c, now(), None, &AtomicBool::new(false)))
        .unwrap();
    let receipt = store
        .with_guide_maintenance_preflight_checked(
            |c| retention::cleanup_receipt_if_unchanged(c, &plan),
            |c, guard| retention::commit_cleanup(c, &plan, &AtomicBool::new(false), guard),
            Arc::new(AtomicBool::new(false)),
            || Ok(()),
        )
        .unwrap();
    assert_eq!(receipt.value.programs_removed, 1);
    assert!(receipt.fatal_verification.is_none());
    store
        .with_guide_read(|c| {
            assert_eq!(non_guide(c), expected);
            assert_eq!(db::list_sources(c)?[0].updated_ms, Some(now() - 5000));
            assert_eq!(db::source_coverage(c, "g")?.program_count, 1);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        fs::read(root.path().join("archive-library-v1/archive.sqlite3")).unwrap(),
        archive
    );
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    assert_eq!(db::source_coverage(&backup, "g").unwrap().program_count, 2);
}
#[test]
fn projected_actual_sqlite_full_rolls_back_programs_policy_and_revisions() {
    let (root, store) = fixture();
    store
        .with_guide_write_checked(|_| Ok(()), || Ok(()))
        .unwrap();
    let before = images(root.path());
    let r = request(&store);
    let mut f = feed();
    f.programs[0].description = Some("x".repeat(60000));
    let error = store
        .with_guide_write_checked(
            |c| {
                let pages: i64 = c
                    .pragma_query_value(None, "page_count", |r| r.get(0))
                    .unwrap();
                c.pragma_update(None, "max_page_count", pages).unwrap();
                db::replace_guide_projected(c, &r, &f, now(), &AtomicBool::new(false))
            },
            || Ok(()),
        )
        .unwrap_err();
    assert_eq!(error, "sqlite-storage-full");
    assert_eq!(images(root.path()), before);
    store
        .with_guide_read(|c| {
            assert!(retention::status(c, "g")?.is_none());
            assert_eq!(db::list_sources(c)?[0].revision, 1);
            assert_eq!(db::source_coverage(c, "g")?.program_count, 0);
            Ok(())
        })
        .unwrap();
}
#[test]
fn actual_checked_backup_cancellation_preserves_both_peers_before_projection_write() {
    let (root, store) = fixture();
    store
        .with_guide_write_checked(|_| Ok(()), || Ok(()))
        .unwrap();
    let before = images(root.path());
    let c = connect(&root.path().join(DB), false).unwrap();
    let mut seen = false;
    let error = pair(root.path())
        .backup_observed(&c, &mut |phase| {
            if phase == BackupPhase::StepCompleted {
                seen = true;
                return Err("canceled".into());
            }
            Ok(())
        })
        .unwrap_err();
    assert!(seen);
    assert_eq!(error, "canceled");
    assert_eq!(images(root.path()), before);
}
#[test]
fn cold_missing_identity_refuses_without_losing_unmapped_verified_target_or_other_authorities() {
    use crate::guide::reviewed_crosswalk;
    let (root, store) = fixture();
    store
        .with_guide_write(|c| {
            c.execute(
                "UPDATE channel SET provider_id='CBSSportsGolazoNetwork.us@SD'",
                [],
            )
            .unwrap();
            c.execute(
                "UPDATE guide_source SET location=?1",
                [reviewed_crosswalk::FEED],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    let authority = Arc::new(reviewed_crosswalk::pinned_fixture());
    let target = authority
        .target("CBSSportsGolazoNetwork.us@SD")
        .unwrap()
        .to_owned();
    let mut f = feed();
    f.channels[0].id = target.clone();
    f.programs[0].channel_id = target;
    let mut r = request(&store);
    r.authority = Some(authority);
    store
        .with_guide_write_checked(
            |c| db::replace_guide_projected(c, &r, &f, now(), &AtomicBool::new(false)),
            || Ok(()),
        )
        .unwrap();
    store
        .with_guide_write_checked(|_| Ok(()), || Ok(()))
        .unwrap();
    let before = images(root.path());
    let archive = fs::read(root.path().join("archive-library-v1/archive.sqlite3")).unwrap();
    let sources = store.with_guide_read(db::list_sources).unwrap();
    let error = store
        .with_guide_read(|c| retention::prepare_cleanup(c, now(), None, &AtomicBool::new(false)))
        .err()
        .unwrap();
    assert_eq!(error, "guide-retention-identity-unavailable");
    assert_eq!(images(root.path()), before);
    let cold = request(&store);
    let error = store
        .with_guide_write_checked(
            |c| db::replace_guide_projected(c, &cold, &f, now(), &AtomicBool::new(false)),
            || Ok(()),
        )
        .unwrap_err();
    assert_eq!(error, "guide-retention-identity-unavailable");
    assert_eq!(fs::read(root.path().join(DB)).unwrap(), before.0);
    store
        .with_guide_read(|c| {
            assert_eq!(db::source_coverage(c, "g")?.program_count, 1);
            assert_eq!(db::list_sources(c)?, sources);
            assert!(db::list_mappings(c)?.is_empty());
            Ok(())
        })
        .unwrap();
    assert_eq!(
        fs::read(root.path().join("archive-library-v1/archive.sqlite3")).unwrap(),
        archive
    );
}
#[test]
fn canceled_projection_before_commit_preserves_rows_and_late_abort_keeps_commit_receipt() {
    let (root, store) = fixture();
    let r = request(&store);
    let flag = AtomicBool::new(true);
    assert!(store
        .with_guide_write_checked(
            |c| db::replace_guide_projected(c, &r, &feed(), now(), &flag),
            || Ok(())
        )
        .is_err());
    store
        .with_guide_read(|c| {
            assert_eq!(db::source_coverage(c, "g")?.program_count, 0);
            Ok(())
        })
        .unwrap();
    let r = request(&store);
    let flag = AtomicBool::new(false);
    let revision = store
        .with_guide_write_checked(
            |c| {
                let revision = db::replace_guide_projected(c, &r, &feed(), now(), &flag)?;
                flag.store(true, Ordering::Release);
                Ok(revision)
            },
            || Ok(()),
        )
        .unwrap();
    assert_eq!(revision, 2);
    assert!(flag.load(Ordering::Acquire));
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    assert_eq!(db::source_coverage(&backup, "g").unwrap().program_count, 0);
}
