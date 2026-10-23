//! Page-copy fixtures use synthetic data/ciphertext, never installation keys.
use super::*;

fn pair(n: u32) -> RecordPair {
    let sources = json!([{"id":"source","name":"Fixture","kind":"file","location":"fixture.m3u"}]);
    RecordPair {
        catalog: Some(json!({"schemaVersion":1,"sources":sources,"channels":[{"id":format!("channel-{n}"),"sourceId":"source","name":"Fixture channel","category":"Sports","urls":["https://example.invalid/live.m3u8"]}]}).to_string()),
        preferences: Some(json!({"schemaVersion":1,"sources":sources,"favorites":["missing-favorite"],"removedChannels":["missing-removed"],"volume":0.5,"muted":true,"panelWidth":350}).to_string()),
    }
}

fn fixture() -> (tempfile::TempDir, PairStore) {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let pair = pair(7);
    store
        .write_pair(
            pair.catalog.as_ref().unwrap(),
            pair.preferences.as_ref().unwrap(),
        )
        .unwrap();
    let c = connect(&root.path().join(DB), false).unwrap();
    crate::scan_checkpoint::ensure(&c).unwrap();
    crate::scan_candidate_manifest::ensure(&c).unwrap();
    let catalog = parse(pair.catalog.as_ref().unwrap()).unwrap();
    let fingerprint =
        crate::health_storage::fingerprint(&catalog["sources"][0], &catalog["channels"][0], 0)
            .unwrap();
    crate::health_storage::replace(&c, Some(&json!({"schemaVersion":1,"records":[{"schemaVersion":1,"channelId":"channel-7","sourceId":"source","checkedUrlOrdinal":0,"targetFingerprint":fingerprint,"platform":"windows","observerProfile":"fixture","observedAt":100,"verdict":"Reachable","origin":"local","evidence":{"kind":"recognized-media-response"}}]}).to_string())).unwrap();
    c.execute_batch("INSERT INTO guide_source(id,name,location,kind,allow_http,revision,updated_ms,published_revision) VALUES('guide','Fixture','fixture.xml','file',0,2,100,2);INSERT INTO guide_channel VALUES('guide','channel','[\"Fixture\"]','fixture');INSERT INTO guide_program(guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,description,search_text) VALUES('guide',0,'channel',0,1000,'Fixture program','Fixture description','fixture program');INSERT INTO guide_mapping VALUES('source','channel-7','guide','channel');").unwrap();
    c.execute_batch("CREATE TABLE backup_fixture_blob(id INTEGER PRIMARY KEY,contents BLOB);INSERT INTO backup_fixture_blob VALUES(1,zeroblob(1048576));CREATE INDEX backup_fixture_index ON backup_fixture_blob(id);UPDATE metadata SET revision=17,catalog_revision=8,health_revision=4;UPDATE scan_checkpoint SET revision=6;INSERT INTO scan_manifest VALUES('fixture','fixture-job','fixture-digest',1,0,1,'{}','{}',1,1,10,64);INSERT INTO scan_manifest_candidate VALUES('fixture',0,'fixture-metadata');INSERT INTO scan_manifest_page VALUES('fixture',0,1,'fixture-binding','fixture-hash',x'0102030405060708');INSERT INTO scan_manifest_category VALUES('fixture',0,'News');CREATE TABLE backup_fixture_freelist(contents BLOB);INSERT INTO backup_fixture_freelist VALUES(zeroblob(1048576));DELETE FROM backup_fixture_freelist;").unwrap();
    store.backup(&c).unwrap();
    assert!(
        c.query_row("PRAGMA page_count", [], |r| r.get::<_, i64>(0))
            .unwrap()
            > 64
    );
    (root, store)
}

fn table_dump(c: &Connection) -> Vec<(String, Vec<Vec<rusqlite::types::Value>>)> {
    let mut names = c
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .unwrap();
    let names = names
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    names
        .into_iter()
        .map(|name| {
            let mut query = c
                .prepare(&format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")))
                .unwrap();
            let count = query.column_count();
            let mut rows = query
                .query_map([], |r| {
                    (0..count)
                        .map(|i| r.get::<_, rusqlite::types::Value>(i))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            rows.sort_by_cached_key(|row| format!("{row:?}"));
            (name, rows)
        })
        .collect()
}

fn files(root: &Path) -> Vec<PathBuf> {
    let mut paths = std::fs::read_dir(root)
        .unwrap()
        .map(|p| p.unwrap().path())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

#[test]
fn online_copy_preserves_all_logical_tables_revisions_indexes_ciphertext_and_freelist() {
    let (root, store) = fixture();
    let source = connect(&root.path().join(DB), true).unwrap();
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    assert_eq!(table_dump(&source), table_dump(&backup));
    for pragma in ["page_count", "freelist_count", "user_version"] {
        let a = source
            .query_row(&format!("PRAGMA {pragma}"), [], |r| r.get::<_, i64>(0))
            .unwrap();
        let b = backup
            .query_row(&format!("PRAGMA {pragma}"), [], |r| r.get::<_, i64>(0))
            .unwrap();
        assert_eq!(a, b);
        if pragma == "freelist_count" {
            assert!(a > 0);
        }
    }
    let source_index = source
        .query_row(
            "SELECT rootpage FROM sqlite_schema WHERE name='backup_fixture_index'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap();
    assert_eq!(
        source_index,
        backup
            .query_row(
                "SELECT rootpage FROM sqlite_schema WHERE name='backup_fixture_index'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap()
    );
    assert_eq!(
        backup
            .query_row("SELECT hex(ciphertext) FROM scan_manifest_page", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        "0102030405060708"
    );
    assert_eq!(
        PairStore::read_connection(&source).unwrap(),
        PairStore::read_connection(&backup).unwrap()
    );
    integrity(&backup).unwrap();
    drop(backup);
    drop(source);
    assert_eq!(
        PairStore::new(root.path().into())
            .unwrap()
            .read_pair()
            .unwrap(),
        store.read_pair().unwrap()
    );
}

#[test]
fn source_snapshot_pins_revision_between_steps_and_blocks_external_commit() {
    let (root, store) = fixture();
    let source = connect(&root.path().join(DB), true).unwrap();
    let writer = connect(&root.path().join(DB), false).unwrap();
    writer.busy_timeout(Duration::ZERO).unwrap();
    let mut checked = false;
    store
        .backup_observed(&source, &mut |phase| {
            if phase == BackupPhase::StepCompleted && !checked {
                writer
                    .execute_batch("BEGIN IMMEDIATE;UPDATE metadata SET revision=99")
                    .unwrap();
                let error = writer.execute_batch("COMMIT").unwrap_err();
                assert_eq!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy)
                );
                writer.execute_batch("ROLLBACK").unwrap();
                checked = true;
            }
            Ok(())
        })
        .unwrap();
    assert!(checked);
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    assert_eq!(
        backup
            .query_row("SELECT revision FROM metadata", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        17
    );
    writer
        .execute("UPDATE metadata SET revision=99", [])
        .unwrap();
    assert_eq!(
        backup
            .query_row("SELECT revision FROM metadata", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        17
    );
}

#[test]
fn partial_cancel_and_postcopy_failure_preserve_old_backup_source_and_join_files() {
    for fail_phase in [
        BackupPhase::StepCompleted,
        BackupPhase::BeforeVerify,
        BackupPhase::BeforeReplace,
    ] {
        let (root, store) = fixture();
        let source = connect(&root.path().join(DB), true).unwrap();
        let before_backup = std::fs::read(root.path().join(BACKUP)).unwrap();
        let before_source = std::fs::read(root.path().join(DB)).unwrap();
        let before_files = files(root.path());
        assert_eq!(
            store
                .backup_observed(&source, &mut |phase| if phase == fail_phase {
                    Err("fixture-canceled".into())
                } else {
                    Ok(())
                })
                .unwrap_err(),
            "fixture-canceled"
        );
        assert_eq!(
            std::fs::read(root.path().join(BACKUP)).unwrap(),
            before_backup
        );
        assert_eq!(std::fs::read(root.path().join(DB)).unwrap(), before_source);
        assert_eq!(files(root.path()), before_files);
        assert!(source.is_autocommit());
        store.backup(&source).unwrap();
    }
}

#[test]
fn actual_busy_readonly_and_full_destination_fail_without_promoting_partial_copy() {
    for mode in ["busy", "readonly", "full"] {
        let (root, _store) = fixture();
        let source = connect(&root.path().join(DB), true).unwrap();
        let old_backup = std::fs::read(root.path().join(BACKUP)).unwrap();
        let path = root.path().join("owned-destination.sqlite3");
        let setup = Connection::open(&path).unwrap();
        setup
            .execute_batch(
                "CREATE TABLE sentinel(value TEXT);INSERT INTO sentinel VALUES('unchanged');",
            )
            .unwrap();
        drop(setup);
        let mut destination = connect(&path, mode == "readonly").unwrap();
        destination.busy_timeout(Duration::ZERO).unwrap();
        let other = Connection::open(&path).unwrap();
        if mode == "busy" {
            other.execute_batch("BEGIN IMMEDIATE").unwrap();
        }
        if mode == "full" {
            destination
                .execute_batch("PRAGMA max_page_count=2")
                .unwrap();
        }
        assert_eq!(
            copy_backup_pages(&source, &mut destination, &mut |_| Ok(())).unwrap_err(),
            if mode == "full" {
                "sqlite-storage-full"
            } else {
                "sqlite-operation-failed"
            }
        );
        if mode == "busy" {
            other.execute_batch("ROLLBACK").unwrap();
        }
        assert_eq!(
            destination
                .query_row("SELECT value FROM sentinel", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "unchanged"
        );
        assert!(source.is_autocommit());
        assert_eq!(std::fs::read(root.path().join(BACKUP)).unwrap(), old_backup);
    }
}

#[test]
fn verification_failure_never_replaces_previous_valid_backup() {
    let (root, store) = fixture();
    let source = connect(&root.path().join(DB), true).unwrap();
    let backup = std::fs::read(root.path().join(BACKUP)).unwrap();
    let before = files(root.path());
    assert!(store
        .backup_observed(&source, &mut |phase| {
            if phase == BackupPhase::BeforeVerify {
                let temporary = files(root.path())
                    .into_iter()
                    .find(|path| !before.contains(path))
                    .unwrap();
                std::fs::write(temporary, b"owned corrupt backup fixture").unwrap();
            }
            Ok(())
        })
        .is_err());
    assert_eq!(std::fs::read(root.path().join(BACKUP)).unwrap(), backup);
    assert_eq!(files(root.path()), before);
}

#[test]
fn phase_owned_write_cancel_during_backup_keeps_canonical_and_previous_backup() {
    let (root, store) = fixture();
    let before = store.read_snapshot().unwrap();
    let backup = std::fs::read(root.path().join(BACKUP)).unwrap();
    let pair = pair(8);
    let mut backup_checks = 0;
    assert_eq!(
        store
            .write_records_with_phase(
                &pair,
                None,
                (Some(&before.catalog_revision), None),
                None,
                |phase| {
                    if phase == Phase::DuringBackup {
                        backup_checks += 1;
                        // Initial admission, pinned snapshot, before first step,
                        // then its completion: cancel after real partial work.
                        if backup_checks == 4 {
                            return Err("canceled".into());
                        }
                    }
                    Ok(())
                }
            )
            .unwrap_err(),
        "canceled"
    );
    assert_eq!(backup_checks, 4);
    assert_eq!(store.read_snapshot().unwrap(), before);
    assert_eq!(std::fs::read(root.path().join(BACKUP)).unwrap(), backup);
}

#[test]
fn process_kill_during_partial_copy_does_not_promote_incomplete_backup() {
    const ENVIRONMENT: &str = "GENX_ONLINE_BACKUP_CRASH_FIXTURE";
    if let Some(root) = std::env::var_os(ENVIRONMENT) {
        let root = PathBuf::from(root);
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("genx-online-backup-crash-"));
        let store = PairStore {
            root: root.clone(),
            require_database: true,
            page_cache: Default::default(),
        };
        let source = connect(&root.join(DB), true).unwrap();
        store
            .backup_observed(&source, &mut |phase| {
                if phase == BackupPhase::StepCompleted {
                    std::fs::write(root.join("partial-copy-ready"), b"owned fixture").unwrap();
                    loop {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
                Ok(())
            })
            .unwrap();
        panic!("owned child did not reach partial copy");
    }
    let (original_root, original_store) = fixture();
    let root = tempfile::Builder::new()
        .prefix("genx-online-backup-crash-")
        .tempdir()
        .unwrap();
    std::fs::copy(original_root.path().join(DB), root.path().join(DB)).unwrap();
    std::fs::copy(original_root.path().join(BACKUP), root.path().join(BACKUP)).unwrap();
    let old_backup = std::fs::read(root.path().join(BACKUP)).unwrap();
    let old_source = std::fs::read(root.path().join(DB)).unwrap();
    let expected = original_store.read_snapshot().unwrap();
    struct OwnedChild(std::process::Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = OwnedChild(std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "storage_transaction::online_backup_tests::process_kill_during_partial_copy_does_not_promote_incomplete_backup", "--nocapture"])
        .env(ENVIRONMENT, root.path())
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn().unwrap());
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !root.path().join("partial-copy-ready").exists() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "fixture child exited early"
        );
        assert!(
            std::time::Instant::now() < deadline,
            "fixture child deadline"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    child.0.kill().unwrap();
    assert!(!child.0.wait().unwrap().success());
    assert_eq!(std::fs::read(root.path().join(BACKUP)).unwrap(), old_backup);
    assert_eq!(std::fs::read(root.path().join(DB)).unwrap(), old_source);
    let reopened = PairStore::new(root.path().into()).unwrap();
    assert_eq!(reopened.read_snapshot().unwrap(), expected);
    // An abandoned staging file is never selected as canonical data/backup.
    // Deleting that file is owned by this temporary fixture directory.
}

fn page_value(c: &Connection, pragma: &str) -> i64 {
    c.query_row(&format!("PRAGMA {pragma}"), [], |r| r.get::<_, i64>(0))
        .unwrap()
}

#[test]
fn compact_background_backup_keeps_every_table_without_free_space() {
    let (root, store) = fixture();
    store.compact_backup(std::sync::Arc::new(|| false)).unwrap();
    let source = connect(&root.path().join(DB), true).unwrap();
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    assert_eq!(table_dump(&source), table_dump(&backup));
    assert!(page_value(&source, "freelist_count") > 0);
    assert_eq!(page_value(&backup, "freelist_count"), 0, "compact copy");
    assert!(page_value(&backup, "page_count") < page_value(&source, "page_count"));
    assert_eq!(
        page_value(&backup, "user_version"),
        page_value(&source, "user_version")
    );
    integrity(&backup).unwrap();
    drop(backup);
    drop(source);
    // Recovery reads the compact backup exactly like a page copy.
    std::fs::remove_file(root.path().join(DB)).unwrap();
    std::fs::copy(root.path().join(BACKUP), root.path().join(DB)).unwrap();
    assert_eq!(
        PairStore::new(root.path().into())
            .unwrap()
            .read_pair()
            .unwrap(),
        store.read_pair().unwrap()
    );
}

#[test]
fn an_aborted_background_backup_keeps_the_previous_backup_and_leaves_no_files() {
    // How many abort checks a complete compact backup makes.
    let total = {
        let (_counting_root, counting) = fixture();
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = calls.clone();
        counting
            .compact_backup(std::sync::Arc::new(move || {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                false
            }))
            .unwrap();
        calls.load(std::sync::atomic::Ordering::SeqCst)
    };
    assert!(
        total >= 3,
        "copy, verification and swap are all checked ({total})"
    );
    let (root, store) = fixture();
    let before = std::fs::read(root.path().join(BACKUP)).unwrap();
    let listing = files(root.path());
    for stop_after in [0usize, total / 2, total - 1] {
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = calls.clone();
        let result = store.compact_backup(std::sync::Arc::new(move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= stop_after
        }));
        assert_eq!(
            result.unwrap_err(),
            "storage-backup-deferred",
            "stop after {stop_after}"
        );
        assert_eq!(std::fs::read(root.path().join(BACKUP)).unwrap(), before);
        assert_eq!(files(root.path()), listing, "temporary copy removed");
    }
}

#[test]
fn ordinary_writes_reuse_a_fresh_backup_and_refresh_a_stale_one() {
    let (root, store) = fixture();
    TEST_WRITE_BACKUP_INTERVAL.with(|v| v.set(crate::storage_backup_policy::INTERVAL));
    let backup = root.path().join(BACKUP);
    let before = std::fs::read(&backup).unwrap();
    store
        .with_guide_write(|c| sql(c.execute("UPDATE metadata SET revision=revision+1", [])))
        .unwrap();
    assert_eq!(
        std::fs::read(&backup).unwrap(),
        before,
        "fresh backup reused"
    );
    // Six hours later the next write refreshes it first (capturing the write above).
    std::fs::File::options()
        .write(true)
        .open(&backup)
        .unwrap()
        .set_modified(
            std::time::SystemTime::now()
                - crate::storage_backup_policy::INTERVAL
                - std::time::Duration::from_secs(1),
        )
        .unwrap();
    store
        .with_guide_write(|c| sql(c.execute("UPDATE metadata SET revision=revision+1", [])))
        .unwrap();
    let refreshed = connect(&backup, true).unwrap();
    let source = connect(&root.path().join(DB), true).unwrap();
    assert_eq!(
        refreshed
            .query_row("SELECT revision FROM metadata", [], |r| r.get::<_, i64>(0))
            .unwrap()
            + 1,
        source
            .query_row("SELECT revision FROM metadata", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        "the stale backup was replaced by the image taken just before this write"
    );
    TEST_WRITE_BACKUP_INTERVAL.with(|v| v.set(std::time::Duration::ZERO));
}

#[test]
fn opening_the_store_removes_abandoned_backup_copies_only() {
    let (root, store) = fixture();
    drop(store);
    std::fs::write(root.path().join(".tmpAbC123"), vec![0u8; 4096]).unwrap();
    std::fs::write(root.path().join("notes.txt"), b"keep").unwrap();
    let reopened = PairStore::new(root.path().into()).unwrap();
    assert!(!root.path().join(".tmpAbC123").exists());
    assert!(root.path().join("notes.txt").exists());
    assert!(root.path().join(DB).exists() && root.path().join(BACKUP).exists());
    reopened.read_pair().unwrap();
}
