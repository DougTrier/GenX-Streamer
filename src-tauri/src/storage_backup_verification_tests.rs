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

//! Synthetic large snapshots; cancellation interrupts SQL and joins its producer.
use super::*;
use std::time::Instant;

fn fixture(mebibytes: usize) -> (tempfile::TempDir, PairStore) {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    store.write_pair(r#"{"schemaVersion":1,"sources":[],"channels":[]}"#, r#"{"schemaVersion":1,"sources":[],"favorites":["missing-favorite"],"removedChannels":["missing-removal"],"volume":0.5,"muted":false,"panelWidth":300}"#).unwrap();
    let mut c = connect(&root.path().join(DB), false).unwrap();
    let tx = c.transaction().unwrap();
    crate::scan_checkpoint::ensure(&tx).unwrap();
    crate::scan_candidate_manifest::ensure(&tx).unwrap();
    tx.execute_batch("CREATE TABLE verification_blob(id INTEGER PRIMARY KEY,payload BLOB NOT NULL);CREATE TABLE verification_parent(id INTEGER PRIMARY KEY);CREATE TABLE verification_child(id INTEGER PRIMARY KEY,parent INTEGER NOT NULL REFERENCES verification_parent(id));WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20000) INSERT INTO verification_parent SELECT x FROM n;INSERT INTO verification_child SELECT id,id FROM verification_parent;INSERT INTO scan_manifest VALUES('fixture','fixture-job','fixture-digest',1,0,1,'{}','{}',1,1,10,64);INSERT INTO scan_manifest_candidate VALUES('fixture',0,'fixture-metadata');INSERT INTO scan_manifest_page VALUES('fixture',0,1,'fixture-binding','fixture-hash',x'0102030405060708');INSERT INTO scan_manifest_category VALUES('fixture',0,'News');").unwrap();
    {
        let mut insert = tx
            .prepare("INSERT INTO verification_blob VALUES(?1,zeroblob(32768))")
            .unwrap();
        for n in 0..mebibytes * 32 {
            insert.execute([n as i64]).unwrap();
        }
    }
    tx.commit().unwrap();
    store.backup(&c).unwrap();
    (root, store)
}
fn image(root: &Path) -> (Vec<u8>, Vec<u8>) {
    (
        std::fs::read(root.join(DB)).unwrap(),
        std::fs::read(root.join(BACKUP)).unwrap(),
    )
}
fn names(root: &Path) -> Vec<std::ffi::OsString> {
    let mut names = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    names.sort();
    names
}

#[test]
fn backup_verification_cancellation_in_actual_quickcheck_and_foreignkeys_preserves_preimage() {
    for target in [
        BackupPhase::QuickCheckProgress,
        BackupPhase::ForeignKeyProgress,
    ] {
        let (root, store) = fixture(8);
        let source = connect(&root.path().join(DB), true).unwrap();
        let before = image(root.path());
        let before_names = names(root.path());
        let mut observed = false;
        let result = store.backup_observed(&source, &mut |phase| {
            if phase == target {
                observed = true;
                return Err("canceled".into());
            }
            Ok(())
        });
        assert_eq!(result.unwrap_err(), "canceled");
        assert!(observed);
        assert_eq!(image(root.path()), before);
        assert_eq!(names(root.path()), before_names);
        assert!(source.is_autocommit());
        // Joined cleanup closes the private verification connection. Another
        // real full backup succeeds immediately, with every namespace intact.
        store.backup(&source).unwrap();
        assert_eq!(image(root.path()), before);
    }
}

#[test]
fn backup_verification_authority_unwind_joins_waiting_sql_and_releases_temporary_image() {
    let (root, store) = fixture(8);
    let source = connect(&root.path().join(DB), true).unwrap();
    let before = image(root.path());
    let before_names = names(root.path());
    let mut observed = false;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        store.backup_observed(&source, &mut |phase| {
            if phase == BackupPhase::QuickCheckProgress {
                observed = true;
                panic!("owned fixture authority panic");
            }
            Ok(())
        })
    }));
    assert!(result.is_err());
    assert!(observed);
    assert_eq!(image(root.path()), before);
    assert_eq!(names(root.path()), before_names);
    store.backup(&source).unwrap();
}

#[test]
fn backup_verification_success_still_refuses_foreignkey_corruption_without_replacement() {
    let (root, store) = fixture(8);
    let before_backup = std::fs::read(root.path().join(BACKUP)).unwrap();
    let source = connect(&root.path().join(DB), false).unwrap();
    source
        .execute_batch(
            "PRAGMA foreign_keys=OFF;UPDATE verification_child SET parent=-1 WHERE id=1;",
        )
        .unwrap();
    let mut quickcheck = false;
    let mut foreignkeys = false;
    let result = store.backup_observed(&source, &mut |phase| {
        quickcheck |= phase == BackupPhase::QuickCheckProgress;
        foreignkeys |= phase == BackupPhase::ForeignKeyProgress;
        Ok(())
    });
    assert_eq!(result.unwrap_err(), "sqlite-integrity-failed");
    assert!(quickcheck && foreignkeys);
    assert_eq!(
        std::fs::read(root.path().join(BACKUP)).unwrap(),
        before_backup
    );
}

#[test]
fn backup_verification_large_fixture_reports_owned_handshake_overhead_and_full_copy_phases() {
    // These measurements intentionally use process-wide production counters.
    // Isolate the benchmark from unrelated parallel tests' real backups rather
    // than weakening the exact one-copy/verification assertions below.
    const CHILD: &str = "GENX_BACKUP_PHASE_FIXTURE_CHILD";
    if std::env::var_os(CHILD).as_deref() != Some(std::ffi::OsStr::new("1")) {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "storage_transaction::backup_verification_tests::backup_verification_large_fixture_reports_owned_handshake_overhead_and_full_copy_phases",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        println!("{}", String::from_utf8_lossy(&result.stdout));
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }
    let (root, store) = fixture(64);
    let source = connect(&root.path().join(DB), true).unwrap();
    let image_bytes = std::fs::metadata(root.path().join(DB)).unwrap().len();
    assert!(image_bytes >= 64 * 1024 * 1024);
    let direct = Instant::now();
    {
        let copy = connect(&root.path().join(BACKUP), true).unwrap();
        // Direct and owned verification must use the same pager; otherwise
        // their difference would conflate read policy with worker handoffs.
        copy.execute_batch(&InspectionPager::DEFAULT.configuration().unwrap()).unwrap();
        integrity(&copy).unwrap();
    }
    let direct_ms = direct.elapsed().as_secs_f64() * 1000.0;
    let owned = Instant::now();
    let mut callbacks = 0;
    verify_backup_owned(&root.path().join(BACKUP), &mut |_| {
        callbacks += 1;
        Ok(())
    })
    .unwrap();
    let owned_ms = owned.elapsed().as_secs_f64() * 1000.0;
    assert!(callbacks > 0);
    let before = image(root.path());
    let phase_before = serde_json::to_value(crate::storage_timings::snapshot()).unwrap();
    let started = Instant::now();
    store.backup(&source).unwrap();
    let backup_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(image(root.path()), before);
    let phases = serde_json::to_value(crate::storage_timings::snapshot()).unwrap();
    let mut measured = serde_json::Map::new();
    for name in ["copy", "quickCheck", "foreignKeys", "sync", "replace"] {
        let current = &phases["backupPhases"][name];
        let prior = &phase_before["backupPhases"][name];
        let calls = current["count"].as_u64().unwrap() - prior["count"].as_u64().unwrap();
        assert_eq!(calls, 1);
        measured.insert(name.into(), json!({"count":calls,"totalMs":current["totalMs"].as_f64().unwrap()-prior["totalMs"].as_f64().unwrap()}));
    }
    println!(
        "{}",
        json!({"fixture":"synthetic-64MiB-payload-20000-FK-rows-v1","imageBytes":image_bytes,"requestedPager":{"cacheKiB":InspectionPager::DEFAULT.cache_kib,"mmapBytes":InspectionPager::DEFAULT.mmap_bytes},"directVerificationMs":direct_ms,"ownedVerificationMs":owned_ms,"handshakeCallbacks":callbacks,"ownedMinusDirectMs":owned_ms-direct_ms,"fullVerifiedBackupMs":backup_ms,"fullBackupPhases":measured,"scope":"controlled local fixture, identical requested pager in both modes, not Android throughput acceptance"})
    );
}

#[test]
fn verifier_read_pager_is_connection_local_and_unmapped_fallback_checks_all_foreign_keys() {
    let (root, _store) = fixture(8);
    let path = root.path().join(DB);
    let default_cache = connect(&path, true).unwrap()
        .query_row("PRAGMA cache_size", [], |row| row.get::<_, i64>(0)).unwrap();
    let before = image(root.path());
    for mmap_bytes in [0, InspectionPager::DEFAULT.mmap_bytes] {
        let connection = connect(&path, true).unwrap();
        let pager = InspectionPager { cache_kib: 8192, mmap_bytes };
        connection.execute_batch(&pager.configuration().unwrap()).unwrap();
        assert_eq!(connection.query_row("PRAGMA cache_size", [], |row| row.get::<_, i64>(0)).unwrap(), -8192);
        let effective_mmap = connection.query_row("PRAGMA mmap_size", [], |row| row.get::<_, i64>(0)).unwrap();
        assert!((0..=mmap_bytes as i64).contains(&effective_mmap), "VFS may decline mapping, never exceed the bound");
        integrity(&connection).unwrap();
        drop(connection);
        assert_eq!(image(root.path()), before);
        assert_eq!(connect(&path, true).unwrap().query_row("PRAGMA cache_size", [], |row| row.get::<_, i64>(0)).unwrap(), default_cache);
    }
    let writer = connect(&path, false).unwrap();
    writer.execute_batch("PRAGMA foreign_keys=OFF;UPDATE verification_child SET parent=-1 WHERE id=20000;").unwrap();
    drop(writer);
    let corrupted = image(root.path());
    for mmap_bytes in [0, InspectionPager::DEFAULT.mmap_bytes] {
        let connection = connect(&path, true).unwrap();
        connection.execute_batch(&InspectionPager { cache_kib: 8192, mmap_bytes }.configuration().unwrap()).unwrap();
        assert_eq!(integrity(&connection), Err("sqlite-integrity-failed".into()));
        drop(connection);
        assert_eq!(image(root.path()), corrupted);
    }
}


#[test]
fn rendezvous_first_each_phase_and_exact_interval_boundary_are_deterministic() {
    let start = Instant::now();
    let mut gate = BackupRendezvous::default();
    assert_eq!(gate.due(BackupPhase::QuickCheckProgress, start), Ok(true));
    // A slow original-owner response must not consume verifier execution time.
    let replied = start + Duration::from_secs(5);
    assert_eq!(gate.grant(BackupPhase::QuickCheckProgress, replied), Ok(()));
    assert_eq!(gate.due(BackupPhase::QuickCheckProgress, replied), Ok(false));
    assert_eq!(gate.due(BackupPhase::QuickCheckProgress, replied + Duration::from_micros(9_999)), Ok(false));
    assert_eq!(gate.due(BackupPhase::QuickCheckProgress, replied + Duration::from_millis(10)), Ok(true));
    let next_reply = replied + Duration::from_millis(13);
    gate.grant(BackupPhase::QuickCheckProgress, next_reply).unwrap();
    assert_eq!(gate.due(BackupPhase::ForeignKeyProgress, next_reply), Ok(true));
    gate.grant(BackupPhase::ForeignKeyProgress, next_reply).unwrap();
    assert_eq!(gate.due(BackupPhase::ForeignKeyProgress, next_reply + Duration::from_millis(1)), Ok(false));
}

#[test]
fn rendezvous_backwards_observation_or_reply_permanently_refuses_continuation() {
    let start = Instant::now();
    for backwards_reply in [false, true] {
        let mut gate = BackupRendezvous::default();
        gate.due(BackupPhase::QuickCheckProgress, start).unwrap();
        gate.grant(BackupPhase::QuickCheckProgress, start).unwrap();
        let later = start + Duration::from_millis(10);
        assert_eq!(gate.due(BackupPhase::QuickCheckProgress, later), Ok(true));
        let backwards = start + Duration::from_millis(9);
        let refused = if backwards_reply {
            gate.grant(BackupPhase::QuickCheckProgress, backwards)
        } else {
            gate.due(BackupPhase::ForeignKeyProgress, backwards).map(|_| ())
        };
        assert_eq!(refused, Err(()));
        assert_eq!(gate.due(BackupPhase::ForeignKeyProgress, later + Duration::from_secs(1)), Err(()));
    }
}

#[test]
fn rendezvous_dense_observation_policy_bounds_expensive_handoffs() {
    let start = Instant::now();
    let mut gate = BackupRendezvous::default();
    let mut handoffs = 0;
    for tick in 0..=50_000 {
        let now = start + Duration::from_micros(tick);
        if gate.due(BackupPhase::QuickCheckProgress, now).unwrap() {
            handoffs += 1;
            gate.grant(BackupPhase::QuickCheckProgress, now).unwrap();
        }
    }
    assert_eq!(handoffs, 6);
    assert_eq!(gate.due(BackupPhase::ForeignKeyProgress, start + Duration::from_millis(50)), Ok(true));
}

#[test]
fn backup_borrowed_root_authority_revoked_after_grant_cannot_publish() {
    let (root, store) = fixture(8);
    let source = connect(&root.path().join(DB), true).unwrap();
    let before = image(root.path());
    let before_names = names(root.path());
    // Deliberately borrowed authority, like the retained Store-generation guard.
    // This tests verifier propagation; actual root replacement has separate Store tests.
    let generation = std::cell::Cell::new(7);
    let mut first_grant = false;
    let mut synchronized = false;
    let result = store.backup_observed(&source, &mut |phase| {
        if generation.get() != 7 {
            return Err("root-generation-changed".into());
        }
        synchronized |= matches!(phase, BackupPhase::BeforeSync | BackupPhase::BeforeReplace);
        if phase == BackupPhase::QuickCheckProgress && !first_grant {
            first_grant = true;
            generation.set(8); // Revoked just after the authority granted this rendezvous.
        }
        Ok(())
    });
    assert_eq!(result.unwrap_err(), "root-generation-changed");
    assert!(first_grant);
    assert!(!synchronized);
    assert_eq!(image(root.path()), before);
    assert_eq!(names(root.path()), before_names);
    assert!(source.is_autocommit());
    store.backup(&source).unwrap(); // Definite join; verifier/temp image are not orphaned.
    assert_eq!(image(root.path()), before);
}

#[test]
fn cancellation_after_last_sql_grant_is_still_checked_before_sync_and_replace() {
    for (grant, refused_at) in [
        (BackupPhase::ForeignKeyProgress, BackupPhase::BeforeSync),
        (BackupPhase::BeforeSync, BackupPhase::BeforeReplace),
    ] {
        let (root, store) = fixture(8);
        let source = connect(&root.path().join(DB), true).unwrap();
        let before = image(root.path());
        let before_names = names(root.path());
        let mut canceled = false;
        let mut final_guard = false;
        let result = store.backup_observed(&source, &mut |phase| {
            if phase == grant { canceled = true; }
            if phase == refused_at {
                final_guard = true;
                if canceled { return Err("canceled".into()); }
            }
            Ok(())
        });
        assert_eq!(result.unwrap_err(), "canceled");
        assert!(canceled && final_guard);
        assert_eq!(image(root.path()), before);
        assert_eq!(names(root.path()), before_names);
        assert!(source.is_autocommit());
        store.backup(&source).unwrap();
        assert_eq!(image(root.path()), before);
    }
}
