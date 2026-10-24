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

//! Timed startup admission retains actual SQLite refusal and recovery gates.
use super::*;

fn phase(name: &str) -> u64 {
    serde_json::to_value(crate::storage_timings::snapshot()).unwrap()["startup"][name]["count"]
        .as_u64()
        .unwrap()
}

fn downgrade_fixture_to_schema9(c: &Connection) {
    // A real v9 fixture has none of the later endpoint/Archive/bookmark tables.
    // Merely changing user_version on the current schema creates false collisions.
    c.execute_batch("PRAGMA foreign_keys=OFF;
        DROP TABLE public_archive_variant_v1;DROP TABLE public_archive_item_v1;DROP TABLE public_archive_preference_v1;DROP TABLE public_archive_removal_v1;DROP TABLE public_archive_checkpoint_v1;
        DROP TABLE catalog_endpoint_projection_v1;
        DROP TABLE archive_bookmark_v1;DROP TABLE archive_bookmark_meta_v1;
        DROP TABLE archive_file_v1;DROP TABLE archive_item_progress_v1;
        DROP TABLE archive_progress_v1;DROP TABLE archive_preferences_v1;
        DROP TABLE archive_removal_v1;DROP TABLE archive_title_v1;DROP TABLE archive_catalog_meta_v1;
        DROP TABLE channel_category_override;ALTER TABLE metadata DROP COLUMN automatic_guide_updates;
        PRAGMA user_version=9;PRAGMA foreign_keys=ON;").unwrap();
}

#[test]
fn healthy_reopen_records_coherent_inspection_without_mutating_canonical_data() {
    let root = tempfile::tempdir().unwrap();
    // Establish the current application root, including the one-time Archive
    // handoff. A schema16 PairStore is a migration fixture, not a healthy reopen.
    crate::storage::Store::new(root.path().into(), "fixture".into()).unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let before_pair = store.read_pair().unwrap();
    let path = root.path().join(DB);
    let bytes = std::fs::read(&path).unwrap();
    let names = [
        "storeOpen",
        "recoveryInspection",
        "inspectionQuickCheck",
        "inspectionForeignKeys",
        "inspectionOpen",
        "inspectionConfigure",
        "inspectionSchema",
        "inspectionPagerRead",
    ];
    let before: Vec<_> = names.iter().map(|name| phase(name)).collect();
    let target = crate::storage::StorageTarget {
        path: root.path().into(),
        mode: "fixture".into(),
        require_existing: true,
        require_database: true,
    };
    let opened = crate::storage::Store::open_target(&target).unwrap();
    assert_eq!(opened.read("catalog").unwrap(), before_pair.catalog);
    assert_eq!(opened.read("preferences").unwrap(), before_pair.preferences);
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    // Other concurrently running fixtures may also recover a database. At least
    // this real reopen must publish every completed admission phase.
    for (name, count) in names.iter().zip(before) {
        assert!(phase(name) > count, "missing phase {name}");
    }
    let mut phases = Vec::new();
    store.recover_observed(|phase| phases.push(phase)).unwrap();
    assert_eq!(
        phases,
        vec![
            RecoveryPhase::SchemaChecked,
            RecoveryPhase::QuickCheck,
            RecoveryPhase::ForeignKeys,
            RecoveryPhase::ProofReused
        ]
    );
}

#[test]
fn unsupported_schema_refusal_is_timed_and_leaves_database_and_backup_unchanged() {
    let root = tempfile::tempdir().unwrap();
    PairStore::new(root.path().into()).unwrap();
    let path = root.path().join(DB);
    let connection = connect(&path, false).unwrap();
    connection.execute_batch("PRAGMA user_version=99").unwrap();
    drop(connection);
    let original = std::fs::read(&path).unwrap();
    let before = phase("recoveryInspection");
    assert_eq!(
        PairStore::new(root.path().into()).err().unwrap(),
        "sqlite-unsupported-schema"
    );
    assert!(phase("recoveryInspection") > before);
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert!(!root.path().join(BACKUP).exists());
}

#[test]
fn coherent_inspection_prevents_writer_commit_between_quick_and_foreign_key_checks() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let writer = connect(&root.path().join(DB), false).unwrap();
    writer.busy_timeout(Duration::ZERO).unwrap();
    let mut tried = false;
    let mut phases = Vec::new();
    store
        .recover_observed(|phase| {
            phases.push(phase);
            if phase == RecoveryPhase::QuickCheck {
                writer
                    .execute_batch("BEGIN IMMEDIATE;PRAGMA user_version=99")
                    .unwrap();
                let error = writer.execute_batch("COMMIT").unwrap_err();
                assert_eq!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy)
                );
                writer.execute_batch("ROLLBACK").unwrap();
                tried = true;
            }
        })
        .unwrap();
    assert!(tried);
    assert_eq!(
        phases,
        vec![
            RecoveryPhase::SchemaChecked,
            RecoveryPhase::QuickCheck,
            RecoveryPhase::ForeignKeys,
            RecoveryPhase::ProofReused
        ]
    );
    assert_eq!(
        writer
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        16
    );
}

#[test]
fn bounded_pager_candidates_preserve_full_inspection_and_canonical_bytes() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let path = root.path().join(DB);
    let before = std::fs::read(&path).unwrap();
    assert_eq!(InspectionPager::DEFAULT.cache_kib, 8192);
    assert_eq!(InspectionPager::DEFAULT.mmap_bytes, 268435456);
    for pager in [
        InspectionPager {
            cache_kib: 8192,
            mmap_bytes: 268435457,
        },
        InspectionPager {
            cache_kib: 32769,
            mmap_bytes: 268435456,
        },
        InspectionPager {
            cache_kib: 1023,
            mmap_bytes: 268435456,
        },
    ] {
        let mut observed = false;
        assert_eq!(
            inspect_existing_database_with_pager(&path, &mut |_| observed = true, pager),
            Err("sqlite-inspection-pager-invalid".into())
        );
        assert!(!observed, "invalid pager must be refused before inspection");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
    for cache_kib in [8192, 16384, 32768] {
        for mmap_bytes in [0, 134217728, 268435456] {
            let mut phases = Vec::new();
            assert_eq!(
                inspect_existing_database_with_pager(
                    &path,
                    &mut |phase| phases.push(phase),
                    InspectionPager {
                        cache_kib,
                        mmap_bytes
                    }
                )
                .unwrap(),
                Inspection::HealthyCurrent
            );
            assert_eq!(
                phases,
                vec![
                    RecoveryPhase::SchemaChecked,
                    RecoveryPhase::QuickCheck,
                    RecoveryPhase::ForeignKeys
                ]
            );
            assert_eq!(std::fs::read(&path).unwrap(), before);
        }
    }
    // Foreign-key damage remains a failed whole-store inspection for every candidate.
    let c = connect(&path, false).unwrap();
    c.execute_batch(
        "PRAGMA foreign_keys=OFF;INSERT INTO channel(id,source_id,name,category,ordinal) VALUES('orphan','missing','Fixture','News',0)",
    )
    .unwrap();
    drop(c);
    let damaged = std::fs::read(&path).unwrap();
    for cache_kib in [8192, 16384, 32768] {
        for mmap_bytes in [0, 134217728, 268435456] {
            assert_eq!(
                inspect_existing_database_with_pager(
                    &path,
                    &mut |_| {},
                    InspectionPager {
                        cache_kib,
                        mmap_bytes
                    }
                )
                .unwrap(),
                Inspection::Corrupt
            );
            assert_eq!(std::fs::read(&path).unwrap(), damaged);
        }
    }
    std::fs::write(&path, b"controlled structural corruption").unwrap();
    for cache_kib in [8192, 16384, 32768] {
        for mmap_bytes in [0, 134217728, 268435456] {
            assert_eq!(
                inspect_existing_database_with_pager(
                    &path,
                    &mut |_| {},
                    InspectionPager {
                        cache_kib,
                        mmap_bytes
                    }
                )
                .unwrap(),
                Inspection::Corrupt
            );
            assert_eq!(
                std::fs::read(&path).unwrap(),
                b"controlled structural corruption"
            );
        }
    }
    drop(store);
}

/// Explicit isolated benchmark only. Never discovers or copies a user profile.
/// Set TMG_STARTUP_BENCH_DB to an already closed private clone under external Temp,
/// TMG_STARTUP_BENCH_SHA256 to its confirmed hash and put that hash in the sibling
/// .genx-startup-bench-owned marker. Output is numeric/redacted. Hashing warms OS
/// caches: this is an order-balanced warm comparison, never cold-device proof.
#[test]
#[ignore = "requires an explicitly owned external private clone and serialized execution"]
fn benchmark_closed_private_clone_inspection_pagers() {
    let path = PathBuf::from(
        std::env::var_os("TMG_STARTUP_BENCH_DB").expect("private-clone-path-required"),
    );
    let expected = std::env::var("TMG_STARTUP_BENCH_SHA256")
        .expect("private-clone-hash-required")
        .to_lowercase();
    assert!(
        expected.len() == 64 && expected.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "private-clone-hash-invalid"
    );
    refuse_database_links(&path).expect("private-clone-link-refused");
    let path = std::fs::canonicalize(path).expect("private-clone-unavailable");
    let temp = std::fs::canonicalize(std::env::temp_dir()).unwrap();
    assert!(path.starts_with(&temp), "external-temp-clone-required");
    assert!(
        path.parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("genx-startup-pager-bench-"),
        "dedicated-owned-benchmark-copy-required"
    );
    let marker = path.parent().unwrap().join(".genx-startup-bench-owned");
    assert_eq!(
        std::fs::read_to_string(marker)
            .expect("private-clone-marker-required")
            .trim(),
        expected,
        "private-clone-marker-mismatch"
    );
    let closed = || {
        for suffix in ["-journal", "-wal", "-shm"] {
            let sibling = path.with_file_name(format!(
                "{}{suffix}",
                path.file_name().unwrap().to_string_lossy()
            ));
            assert!(!sibling.exists(), "private-clone-must-be-closed");
        }
    };
    closed();
    let hash = || {
        let mut file = File::open(&path).expect("private-clone-unavailable");
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let read = file.read(&mut buffer).expect("private-clone-read-failed");
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
        format!("{:x}", digest.finalize())
    };
    assert_eq!(hash(), expected, "private-clone-source-mismatch");
    let candidates = [
        InspectionPager {
            cache_kib: 8192,
            mmap_bytes: 134217728,
        },
        InspectionPager::DEFAULT,
        InspectionPager {
            cache_kib: 16384,
            mmap_bytes: 134217728,
        },
        InspectionPager {
            cache_kib: 16384,
            mmap_bytes: 268435456,
        },
        InspectionPager {
            cache_kib: 32768,
            mmap_bytes: 134217728,
        },
        InspectionPager {
            cache_kib: 32768,
            mmap_bytes: 268435456,
        },
    ];
    let budget = std::time::Instant::now();
    let mut results = Vec::new();
    for index in [0, 1, 2, 3, 4, 5, 5, 4, 3, 2, 1, 0] {
        if budget.elapsed() > Duration::from_secs(180) {
            break;
        }
        closed();
        let started = std::time::Instant::now();
        let mut phase_times = Vec::new();
        let result = inspect_database_with_access(
            &path,
            &mut |_| {
                phase_times.push(started.elapsed().as_secs_f64() * 1000.0);
            },
            candidates[index],
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        );
        let snapshot = serde_json::to_value(crate::storage_timings::snapshot()).unwrap();
        println!(
            "STARTUP_PAGER_BENCH {}",
            json!({"caseIndex":index,"readOnly":true,"cacheKib":candidates[index].cache_kib,
            "requestedMmapBytes":candidates[index].mmap_bytes,"elapsedMs":started.elapsed().as_secs_f64()*1000.0,
            "phaseElapsedMs":phase_times,"effectivePager":snapshot["startup"]["pager"],
            "healthyCurrent":matches!(&result, Ok(Inspection::HealthyCurrent))})
        );
        results.push(result);
    }
    closed();
    assert_eq!(hash(), expected, "private-clone-was-modified");
    assert_eq!(
        results.len(),
        candidates.len() * 2,
        "benchmark-budget-exhausted-after-joined-run"
    );
    assert!(
        results
            .into_iter()
            .all(|result| result == Ok(Inspection::HealthyCurrent)),
        "full-inspection-not-confirmed"
    );
}

#[test]
fn foreign_key_violation_is_never_reused_and_restores_only_verified_backup() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let catalog = r#"{"schemaVersion":1,"sources":[],"channels":[]}"#;
    let prefs = r#"{"schemaVersion":1,"sources":[],"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":300}"#;
    store.write_pair(catalog, prefs).unwrap();
    store.write_pair(catalog, prefs).unwrap();
    let backup = root.path().join(BACKUP);
    let backup_bytes = std::fs::read(&backup).unwrap();
    let expected = PairStore::read_connection(&connect(&backup, true).unwrap()).unwrap();
    let writer = connect(&root.path().join(DB), false).unwrap();
    writer
        .execute_batch(
            "PRAGMA foreign_keys=OFF;INSERT INTO channel(id,source_id,name,category,ordinal) VALUES('orphan','missing','Orphan','News',0)",
        )
        .unwrap();
    drop(writer);
    let mut phases = Vec::new();
    store.recover_observed(|phase| phases.push(phase)).unwrap();
    assert!(!phases.contains(&RecoveryPhase::ProofReused));
    assert!(phases.contains(&RecoveryPhase::Migration));
    assert!(phases.contains(&RecoveryPhase::FinalIntegrity));
    assert_eq!(store.read_pair().unwrap(), expected);
    assert_eq!(std::fs::read(backup).unwrap(), backup_bytes);
}

#[test]
fn legacy_schema_migration_and_journal_conversion_require_final_verification() {
    for mode in ["schema9", "wal"] {
        let root = tempfile::tempdir().unwrap();
        let store = PairStore::new(root.path().into()).unwrap();
        let original = store.read_pair().unwrap();
        let writer = connect(&root.path().join(DB), false).unwrap();
        match mode {
            "schema9" => downgrade_fixture_to_schema9(&writer),
            "wal" => {
                let journal = writer
                    .query_row("PRAGMA journal_mode=WAL", [], |r| r.get::<_, String>(0))
                    .unwrap();
                assert_eq!(journal, "wal");
            }
            _ => unreachable!(),
        }
        drop(writer);
        let mut phases = Vec::new();
        store.recover_observed(|phase| phases.push(phase)).unwrap();
        assert!(!phases.contains(&RecoveryPhase::ProofReused));
        assert!(phases.contains(&RecoveryPhase::Migration));
        assert!(phases.contains(&RecoveryPhase::FinalIntegrity));
        assert_eq!(store.read_pair().unwrap(), original);
        let connection = connect(&root.path().join(DB), true).unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            16
        );
        assert_eq!(
            connection
                .query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "delete"
        );
        if mode == "schema9" {
            let backup = connect(&root.path().join(BACKUP), true).unwrap();
            assert_eq!(
                backup
                    .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                9
            );
            integrity(&backup).unwrap();
        }
    }
}

#[test]
fn mutation_path_final_foreign_key_failure_is_not_hidden_by_prior_inspection() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let writer = connect(&root.path().join(DB), false).unwrap();
    downgrade_fixture_to_schema9(&writer);
    drop(writer);
    let mut injected = false;
    let error=store.recover_observed(|phase| {
        if phase==RecoveryPhase::FinalIntegrity {
            let writer=connect(&root.path().join(DB),false).unwrap();
            writer.execute_batch("PRAGMA foreign_keys=OFF;INSERT INTO channel(id,source_id,name,category,ordinal) VALUES('orphan','missing','Orphan','News',0)").unwrap();
            injected=true;
        }
    }).unwrap_err();
    assert!(injected);
    assert_eq!(error, "sqlite-integrity-failed");
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    integrity(&backup).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        9
    );
}

#[test]
fn new_database_and_corrupt_main_restoration_still_run_final_integrity() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore {
        root: root.path().into(),
        require_database: false,
        page_cache: Default::default(),
    };
    let mut creation = Vec::new();
    store
        .recover_observed(|phase| creation.push(phase))
        .unwrap();
    assert_eq!(
        creation,
        vec![RecoveryPhase::Migration, RecoveryPhase::FinalIntegrity]
    );
    let c = connect(&root.path().join(DB), false).unwrap();
    store.backup(&c).unwrap();
    drop(c);
    let backup_before = std::fs::read(root.path().join(BACKUP)).unwrap();
    std::fs::write(root.path().join(DB), b"corrupt fixture bytes").unwrap();
    let mut restored = Vec::new();
    store
        .recover_observed(|phase| restored.push(phase))
        .unwrap();
    assert!(!restored.contains(&RecoveryPhase::ProofReused));
    assert!(restored.contains(&RecoveryPhase::FinalIntegrity));
    assert_eq!(
        std::fs::read(root.path().join(BACKUP)).unwrap(),
        backup_before
    );
    integrity(&connect(&root.path().join(DB), true).unwrap()).unwrap();
}
