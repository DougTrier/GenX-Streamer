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

//! Opt-in measurements on an explicitly owned external clone, never installation data.
use super::*;
use crate::{guide::retention, storage::Store};
use rusqlite::types::ValueRef;
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};

fn digest_file(path: &Path) -> String {
    let mut file = File::open(path).expect("owned-clone-file-unavailable");
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let read = file.read(&mut buffer).expect("owned-clone-read-failed");
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    format!("{:x}", digest.finalize())
}

// Every table except the five explicitly changed by Guide retention must keep
// its exact row multiset. This includes channel headers, mappings and user data.
fn protected(c: &Connection) -> BTreeMap<String, (usize, String)> {
    let tables = c
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let mut result = BTreeMap::new();
    for table in tables {
        if matches!(
            table.as_str(),
            "guide_source"
                | "guide_program"
                | "guide_http_cache"
                | "guide_projection_v1"
                | "guide_meta"
        ) {
            continue;
        }
        let mut statement = c
            .prepare(&format!("SELECT * FROM \"{}\"", table.replace('"', "\"\"")))
            .unwrap();
        let columns = statement.column_count();
        let mut rows = statement.query([]).unwrap();
        let mut hashes = Vec::<[u8; 32]>::new();
        while let Some(row) = rows.next().unwrap() {
            assert!(hashes.len() < 1_600_000, "owned-clone-row-limit");
            let mut digest = Sha256::new();
            digest.update((columns as u64).to_be_bytes());
            for column in 0..columns {
                match row.get_ref(column).unwrap() {
                    ValueRef::Null => digest.update([0]),
                    ValueRef::Integer(v) => {
                        digest.update([1]);
                        digest.update(v.to_be_bytes());
                    }
                    ValueRef::Real(v) => {
                        digest.update([2]);
                        digest.update(v.to_bits().to_be_bytes());
                    }
                    ValueRef::Text(v) => {
                        digest.update([3]);
                        digest.update((v.len() as u64).to_be_bytes());
                        digest.update(v);
                    }
                    ValueRef::Blob(v) => {
                        digest.update([4]);
                        digest.update((v.len() as u64).to_be_bytes());
                        digest.update(v);
                    }
                }
            }
            hashes.push(digest.finalize().into());
        }
        hashes.sort_unstable();
        let mut digest = Sha256::new();
        for hash in &hashes {
            digest.update(hash);
        }
        result.insert(table, (hashes.len(), format!("{:x}", digest.finalize())));
    }
    result
}

fn metrics(store: &Store) -> Value {
    store
        .with_guide_read(|c| {
            let number = |query: &str| c.query_row(query, [], |r| r.get::<_, i64>(0)).unwrap();
            Ok(json!({"schema":number("PRAGMA user_version"),
            "pages":number("PRAGMA page_count"),"pageSize":number("PRAGMA page_size"),
            "freePages":number("PRAGMA freelist_count"),
            "programmes":number("SELECT count(*) FROM guide_program"),
            "headers":number("SELECT count(*) FROM guide_channel")}))
        })
        .unwrap()
}

/// The caller creates a NEW external Temp/genx-guide-retention-bench-* directory,
/// copies the two CLOSED snapshot primaries plus their active Archive authority
/// companion, and writes all three SHA256 values in .genx-guide-retention-owned.json.
/// Missing backup peers may be repaired inside
/// this clone only. Hashing warms caches; timings below are Windows warm-process
/// measurements, not cold TV performance or production compaction acceptance.
#[test]
#[ignore = "requires an explicitly owned external private clone and serialized execution"]
fn benchmark_owned_private_guide_retention() {
    let supplied =
        PathBuf::from(std::env::var_os("TMG_GUIDE_BENCH_ROOT").expect("owned-clone-root-required"));
    for relative in [
        DB,
        "archive-library-v1/archive.sqlite3",
        "archive-authority-v1",
        ".genx-guide-retention-owned.json",
    ] {
        refuse_database_links(&supplied.join(relative)).expect("owned-clone-link-refused");
    }
    let root = fs::canonicalize(&supplied).expect("owned-clone-root-unavailable");
    let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
    assert!(root.starts_with(&temp), "external-temp-clone-required");
    assert!(
        root.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("genx-guide-retention-bench-"),
        "dedicated-owned-clone-required"
    );
    let marker_bytes = fs::read(root.join(".genx-guide-retention-owned.json")).unwrap();
    assert!(marker_bytes.len() <= 1024, "owned-clone-marker-limit");
    let marker: Value = serde_json::from_slice(&marker_bytes).expect("owned-clone-marker-invalid");
    for (key, relative) in [
        ("mainSha256", DB),
        ("archiveSha256", "archive-library-v1/archive.sqlite3"),
        ("witnessSha256", "archive-authority-v1"),
    ] {
        let expected = marker[key].as_str().expect("owned-clone-hash-required");
        assert!(
            expected.len() == 64 && expected.bytes().all(|b| b.is_ascii_hexdigit()),
            "owned-clone-hash-invalid"
        );
        assert_eq!(
            digest_file(&root.join(relative)),
            expected,
            "owned-clone-input-mismatch"
        );
        for suffix in ["-journal", "-wal", "-shm"] {
            assert!(
                !root.join(format!("{relative}{suffix}")).exists(),
                "owned-clone-must-be-closed"
            );
        }
    }
    let started = Instant::now();
    let initial = Store::new(root.clone(), "owned-clone-benchmark".into()).unwrap();
    let preparation_ms = started.elapsed().as_secs_f64() * 1000.0;
    drop(initial);
    let started = Instant::now();
    let store = Store::new(root.clone(), "owned-clone-benchmark".into()).unwrap();
    let warm_before_ms = started.elapsed().as_secs_f64() * 1000.0;
    let before = metrics(&store);
    let preserved = store.with_guide_read(|c| Ok(protected(c))).unwrap();
    let archive_hash = digest_file(&root.join("archive-library-v1/archive.sqlite3"));
    let before_bytes = fs::metadata(root.join(DB)).unwrap().len();
    let cancelled = Arc::new(AtomicBool::new(false));
    let authority = crate::guide::reviewed_crosswalk::pinned_fixture();
    let plan = store
        .with_guide_read(|c| {
            retention::prepare_cleanup(c, 1_792_022_400_000, Some(&authority), &cancelled)
        })
        .unwrap();
    let backups_before = serde_json::to_value(crate::storage_timings::snapshot()).unwrap()
        ["backup"]["count"]
        .as_u64()
        .unwrap();
    let started = Instant::now();
    let receipt = store
        .with_guide_maintenance_preflight_checked(
            |c| retention::cleanup_receipt_if_unchanged(c, &plan),
            |c, check| retention::commit_cleanup(c, &plan, &cancelled, check),
            cancelled.clone(),
            || Ok(()),
        )
        .unwrap();
    let maintenance_ms = started.elapsed().as_secs_f64() * 1000.0;
    let backups_after = serde_json::to_value(crate::storage_timings::snapshot()).unwrap()["backup"]
        ["count"]
        .as_u64()
        .unwrap();
    let after = metrics(&store);
    assert_eq!(
        store.with_guide_read(|c| Ok(protected(c))).unwrap(),
        preserved,
        "protected-tables-changed"
    );
    assert_eq!(
        digest_file(&root.join("archive-library-v1/archive.sqlite3")),
        archive_hash,
        "archive-changed"
    );
    let integrity = store
        .with_guide_read(|c| {
            let quick: String = sql(c.query_row("PRAGMA quick_check", [], |r| r.get(0)))?;
            let mut statement = sql(c.prepare("PRAGMA foreign_key_check"))?;
            let rows = sql(statement.query_map([], |_| Ok(())))?;
            let foreign = sql(rows.collect::<rusqlite::Result<Vec<_>>>())?.len();
            Ok((quick, foreign))
        })
        .unwrap();
    let after_bytes = fs::metadata(root.join(DB)).unwrap().len();
    drop(store);
    let started = Instant::now();
    let reopened = Store::new(root.clone(), "owned-clone-benchmark".into()).unwrap();
    let warm_after_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(metrics(&reopened), after, "reopen-state-changed");
    let report = json!({"scope":"OWNED_CLONE_WINDOWS_WARM_MEASUREMENTS_NOT_DEVICE_ACCEPTANCE",
        "preparationMs":preparation_ms,"warmBeforeMs":warm_before_ms,"warmAfterMs":warm_after_ms,
        "maintenanceMs":maintenance_ms,"before":before,"after":after,"beforeBytes":before_bytes,
        "afterBytes":after_bytes,"backupCount":backups_after-backups_before,"maintenance":receipt,
        "protectedTables":preserved.len(),"archiveUnchanged":true,"quickCheck":integrity.0,"foreignKeyViolations":integrity.1});
    println!("GENX_GUIDE_CLONE_BENCH {}", report);
    assert_eq!(integrity, ("ok".to_owned(), 0));
    assert!(
        receipt.fatal_verification.is_none(),
        "fatal-maintenance-verification"
    );
    assert!(
        receipt.value.programs_removed > 0,
        "owned-clone-no-retention-work"
    );
    assert_eq!(
        backups_after - backups_before,
        1,
        "expected-one-verified-preimage"
    );
    assert!(
        matches!(
            receipt.compaction,
            guide_maintenance::Compaction::Compacted { .. }
        ),
        "physical-compaction-not-completed"
    );
    assert!(after_bytes < before_bytes, "physical-file-did-not-shrink");
}
