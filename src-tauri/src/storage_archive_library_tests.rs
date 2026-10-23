//! Canonical-to-Archive authority integration, using real independent files.
use super::*;
use crate::{archive_catalog as archive, archive_library_store as library, storage::Store};
use sha2::{Digest, Sha256};
use std::fs;

fn legacy() -> (tempfile::TempDir, String) {
    let root = tempfile::tempdir().unwrap();
    let pair = PairStore::new(root.path().into()).unwrap();
    let title = archive::opaque(&["archive-item-v1", "legacy"]);
    let file = archive::opaque(&["archive-file-v1", "legacy", "movie.mp4"]);
    pair.with_guide_write(|c| {
        c.execute_batch("CREATE TABLE migration_live_sentinel(payload BLOB NOT NULL);INSERT INTO migration_live_sentinel VALUES(zeroblob(1048576));").unwrap();
        c.execute("INSERT INTO archive_title_v1(title_ref,item_id,title,kind,curated,searched,downloads,observed_ms,search_text) VALUES(?1,'legacy','Legacy title','movie',0,1,3,1,'Legacy title')", [&title]).unwrap();
        c.execute("INSERT INTO archive_file_v1(file_ref,title_ref,item_id,file_name,format,size_bytes,servers,observed_ms,eligible) VALUES(?1,?2,'legacy','movie.mp4','h.264','100','[]',1,1)",params![file,title]).unwrap();
        c.execute("INSERT INTO archive_preferences_v1 VALUES(?1,'legacy','Legacy title',NULL,1)", [&title]).unwrap();
        c.execute("INSERT INTO archive_removal_v1 VALUES('file',?1,'legacy',?2,'Hidden file','hidden.mp4',1)",params!["b".repeat(64),title]).unwrap();
        c.execute("INSERT INTO archive_bookmark_v1 VALUES(?1,'legacy','movie.mp4','100',?2,1000,5000,0,1)",params![file,"a".repeat(40)]).unwrap();
        c.execute_batch("UPDATE archive_catalog_meta_v1 SET revision=7;UPDATE archive_bookmark_meta_v1 SET revision=2;").unwrap();
        Ok(())
    }).unwrap();
    let digest = pair
        .with_guide_read(|c| library::source_fingerprint(c, &mut || Ok(())))
        .unwrap();
    (root, digest)
}
fn clear(store: &Store) {
    let receipt = store
        .with_archive_write_checked(
            "7",
            |_| Ok(None),
            |c, check| archive::remove(c, &archive::RemovalScope::All, None, "7", check),
            || Ok(()),
        )
        .unwrap();
    assert!(receipt.committed);
}
#[test]
fn archive_handoff_preserves_exact_rows_and_changes_only_archive_authority() {
    let (root, digest) = legacy();
    let store = Store::new(root.path().into(), "test".into()).unwrap();
    assert_eq!(
        store
            .with_archive_read(|c| library::source_fingerprint(c, &mut || Ok(())))
            .unwrap(),
        digest
    );
    store
        .with_guide_read(|c| {
            assert_eq!(archive_binding(c)?.source_revision, 7);
            assert_eq!(archive_binding(c)?.source_bookmark_revision, 2);
            assert_eq!(
                c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                19
            );
            assert_eq!(
                c.query_row(
                    "SELECT length(payload) FROM migration_live_sentinel",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                1048576
            );
            Ok(())
        })
        .unwrap();
    let main_before = fs::read(root.path().join(DB)).unwrap();
    clear(&store);
    assert_eq!(fs::read(root.path().join(DB)).unwrap(), main_before);
    assert!(
        fs::metadata(root.path().join("archive-library-v1/archive.sqlite3"))
            .unwrap()
            .len()
            < 1048576
    );
    assert_eq!(
        library::inspect(root.path()).unwrap().unwrap().phase,
        library::Phase::Active
    );
}
#[test]
fn archive_handoff_restored_legacy_main_cannot_resurrect_cleared_titles() {
    let (root, _) = legacy();
    let old = fs::read(root.path().join(DB)).unwrap();
    let store = Store::new(root.path().into(), "test".into()).unwrap();
    clear(&store);
    drop(store);
    fs::write(root.path().join(DB), old).unwrap();
    let reopened = Store::new(root.path().into(), "test".into()).unwrap();
    reopened
        .with_archive_read(|c| {
            assert_eq!(archive::current(c)?, 8);
            assert_eq!(
                c.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            Ok(())
        })
        .unwrap();
    reopened
        .with_guide_read(|c| archive_binding(c).map(|_| ()))
        .unwrap();
}
#[test]
fn archive_handoff_prepared_export_resumes_once_and_stale_writer_cannot_publish() {
    let (root, _) = legacy();
    let c = connect(&root.path().join(DB), false).unwrap();
    let lease = library::lock_root(root.path()).unwrap();
    library::prepare(&lease, &c, &mut || Ok(())).unwrap();
    drop(c);
    drop(lease);
    let store = Store::new(root.path().into(), "test".into()).unwrap();
    clear(&store);
    let archive_path = root.path().join("archive-library-v1/archive.sqlite3");
    let before = fs::read(&archive_path).unwrap();
    assert_eq!(
        store
            .with_archive_write_checked("7", |_| Ok(Some(())), |_, _| Ok(()), || Ok(()))
            .unwrap_err(),
        "archive-revision-stale"
    );
    assert_eq!(fs::read(archive_path).unwrap(), before);
}
#[test]
fn archive_handoff_invalid_witness_blocks_main_recovery_without_overwriting_either() {
    let (root, _) = legacy();
    let store = Store::new(root.path().into(), "test".into()).unwrap();
    drop(store);
    let before = fs::read(root.path().join(DB)).unwrap();
    fs::write(root.path().join("archive-authority-v1"), b"invalid witness").unwrap();
    assert!(Store::new(root.path().into(), "test".into()).is_err());
    assert_eq!(fs::read(root.path().join(DB)).unwrap(), before);
    assert_eq!(
        fs::read(root.path().join("archive-authority-v1")).unwrap(),
        b"invalid witness"
    );
}

#[test]
fn archive_handoff_missing_authority_cannot_restore_legacy_main_before_refusal() {
    let (root, _) = legacy();
    let legacy = fs::read(root.path().join(DB)).unwrap();
    let store = Store::new(root.path().into(), "test".into()).unwrap();
    clear(&store);
    drop(store);
    fs::remove_file(root.path().join("archive-library-v1/archive.sqlite3")).unwrap();
    fs::remove_file(
        root.path()
            .join("archive-library-v1/archive.sqlite3.backup"),
    )
    .unwrap();
    fs::write(root.path().join(DB), b"corrupt canonical").unwrap();
    fs::write(root.path().join(BACKUP), &legacy).unwrap();
    let witness = fs::read(root.path().join("archive-authority-v1")).unwrap();
    assert!(Store::new(root.path().into(), "test".into()).is_err());
    assert_eq!(
        fs::read(root.path().join(DB)).unwrap(),
        b"corrupt canonical"
    );
    assert_eq!(fs::read(root.path().join(BACKUP)).unwrap(), legacy);
    assert_eq!(
        fs::read(root.path().join("archive-authority-v1")).unwrap(),
        witness
    );
}

#[test]
fn archive_handoff_missing_witness_cannot_restore_legacy_main_over_committed_namespace() {
    let (root, _) = legacy();
    let legacy = fs::read(root.path().join(DB)).unwrap();
    let store = Store::new(root.path().into(), "test".into()).unwrap();
    clear(&store);
    drop(store);
    fs::remove_file(root.path().join("archive-authority-v1")).unwrap();
    fs::write(root.path().join(DB), b"corrupt canonical").unwrap();
    fs::write(root.path().join(BACKUP), &legacy).unwrap();
    let namespace = fs::read(root.path().join("archive-library-v1/archive.sqlite3")).unwrap();
    assert!(Store::new(root.path().into(), "test".into()).is_err());
    assert_eq!(
        fs::read(root.path().join(DB)).unwrap(),
        b"corrupt canonical"
    );
    assert_eq!(fs::read(root.path().join(BACKUP)).unwrap(), legacy);
    assert_eq!(
        fs::read(root.path().join("archive-library-v1/archive.sqlite3")).unwrap(),
        namespace
    );
    assert!(!root.path().join("archive-authority-v1").exists());
}

#[test]
fn archive_handoff_prepared_refuses_wrong_legacy_backup_before_replacing_main() {
    let (root, _) = legacy();
    let wrong = fs::read(root.path().join(DB)).unwrap();
    let pair = PairStore::new(root.path().into()).unwrap();
    pair.with_guide_write(|c| {
        c.execute_batch("UPDATE archive_catalog_meta_v1 SET revision=8;")
            .unwrap();
        Ok(())
    })
    .unwrap();
    let lease = library::lock_root(root.path()).unwrap();
    let source = connect(&root.path().join(DB), true).unwrap();
    library::prepare(&lease, &source, &mut || Ok(())).unwrap();
    drop(source);
    drop(lease);
    drop(pair);
    fs::write(root.path().join(DB), b"corrupt canonical").unwrap();
    fs::write(root.path().join(BACKUP), &wrong).unwrap();
    assert!(Store::new(root.path().into(), "test".into()).is_err());
    assert_eq!(
        fs::read(root.path().join(DB)).unwrap(),
        b"corrupt canonical"
    );
    assert_eq!(fs::read(root.path().join(BACKUP)).unwrap(), wrong);
}

#[test]
fn archive_handoff_active_refuses_other_namespace_canonical_peer_before_replacement() {
    let (root, _) = legacy();
    let first = Store::new(root.path().into(), "test".into()).unwrap();
    clear(&first);
    drop(first);
    let (other, _) = legacy();
    let second = Store::new(other.path().into(), "test".into()).unwrap();
    drop(second);
    let foreign = fs::read(other.path().join(DB)).unwrap();
    let witness = fs::read(root.path().join("archive-authority-v1")).unwrap();
    fs::write(root.path().join(BACKUP), &foreign).unwrap();
    fs::write(root.path().join(DB), b"corrupt canonical").unwrap();
    assert!(Store::new(root.path().into(), "test".into()).is_err());
    assert_eq!(
        fs::read(root.path().join(DB)).unwrap(),
        b"corrupt canonical"
    );
    assert_eq!(fs::read(root.path().join(BACKUP)).unwrap(), foreign);
    assert_eq!(
        fs::read(root.path().join("archive-authority-v1")).unwrap(),
        witness
    );
    fs::write(root.path().join(DB), &foreign).unwrap();
    assert!(Store::new(root.path().into(), "test".into()).is_err());
    assert_eq!(fs::read(root.path().join(DB)).unwrap(), foreign);
}

#[test]
fn archive_handoff_existing_authority_never_creates_blank_canonical_root() {
    let (root, _) = legacy();
    let store = Store::new(root.path().into(), "test".into()).unwrap();
    drop(store);
    let witness = fs::read(root.path().join("archive-authority-v1")).unwrap();
    let archive = fs::read(root.path().join("archive-library-v1/archive.sqlite3")).unwrap();
    fs::remove_file(root.path().join(DB)).unwrap();
    fs::remove_file(root.path().join(BACKUP)).unwrap();
    assert!(Store::new(root.path().into(), "test".into()).is_err());
    assert!(!root.path().join(DB).exists());
    assert!(!root.path().join(BACKUP).exists());
    assert_eq!(
        fs::read(root.path().join("archive-authority-v1")).unwrap(),
        witness
    );
    assert_eq!(
        fs::read(root.path().join("archive-library-v1/archive.sqlite3")).unwrap(),
        archive
    );
}

#[test]
fn archive_handoff_other_process_cannot_recover_while_initialization_locked() {
    let (root, _) = legacy();
    let before = fs::read(root.path().join(DB)).unwrap();
    fs::write(root.path().join(BACKUP), &before).unwrap();
    fs::write(root.path().join(DB), b"corrupt canonical").unwrap();
    let lease = library::lock_root(root.path()).unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "storage_transaction::archive_library_tests::archive_handoff_open_child",
            "--ignored",
            "--nocapture",
        ])
        .env("GENX_ARCHIVE_OPEN_ROOT", root.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("archive-library-storage-busy"));
    assert_eq!(
        fs::read(root.path().join(DB)).unwrap(),
        b"corrupt canonical"
    );
    assert_eq!(fs::read(root.path().join(BACKUP)).unwrap(), before);
    drop(lease);
}

#[test]
#[ignore = "Owned child-process fixture; parent supplies locked external temporary root"]
fn archive_handoff_open_child() {
    let root = std::path::PathBuf::from(
        std::env::var_os("GENX_ARCHIVE_OPEN_ROOT").expect("parent fixture root"),
    );
    match Store::new(root, "test".into()) {
        Err(error) => {
            assert_eq!(error, "archive-library-storage-busy");
            println!("{error}");
        }
        Ok(_) => panic!("another process admitted recovery under an exclusive initialization lock"),
    }
}

fn non_archive_digest(c: &Connection) -> String {
    let mut hash = Sha256::new();
    let mut names=c.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'archive_%' AND name NOT LIKE 'public_archive_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap();
    let rows = names
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .unwrap();
    for table in rows {
        let (name, schema) = table.unwrap();
        hash.update(schema.as_bytes());
        let quoted = name.replace('"', "\"\"");
        let mut columns = c
            .prepare(&format!("PRAGMA table_info(\"{quoted}\")"))
            .unwrap();
        let order = columns
            .query_map([], |r| Ok((r.get::<_, i64>(5)?, r.get::<_, String>(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let mut keys = order
            .iter()
            .filter(|(ordinal, _)| *ordinal > 0)
            .cloned()
            .collect::<Vec<_>>();
        keys.sort_by_key(|(ordinal, _)| *ordinal);
        let order = if keys.is_empty() {
            "rowid".into()
        } else {
            keys.into_iter()
                .map(|(_, name)| format!("\"{}\"", name.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(",")
        };
        let mut statement = c
            .prepare(&format!("SELECT * FROM \"{quoted}\" ORDER BY {order}"))
            .unwrap();
        let columns = statement.column_count();
        let mut rows = statement.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            for column in 0..columns {
                use rusqlite::types::ValueRef;
                match row.get_ref(column).unwrap() {
                    ValueRef::Null => hash.update([0]),
                    ValueRef::Integer(n) => {
                        hash.update([1]);
                        hash.update(n.to_le_bytes());
                    }
                    ValueRef::Real(n) => {
                        hash.update([2]);
                        hash.update(n.to_bits().to_le_bytes());
                    }
                    ValueRef::Text(b) | ValueRef::Blob(b) => {
                        hash.update([
                            if matches!(row.get_ref(column).unwrap(), ValueRef::Text(_)) {
                                3
                            } else {
                                4
                            },
                        ]);
                        hash.update((b.len() as u64).to_le_bytes());
                        hash.update(b);
                    }
                }
            }
        }
    }
    format!("{:x}", hash.finalize())
}
#[test]
#[ignore = "Manual immutable schema16 snapshot clone; set GENX_ARCHIVE_TEST_CANONICAL, never modifies input"]
fn archive_real_snapshot_migration_profile() {
    let input = std::path::PathBuf::from(
        std::env::var_os("GENX_ARCHIVE_TEST_CANONICAL")
            .expect("explicit immutable snapshot required"),
    );
    let source = Connection::open_with_flags(&input, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        source
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        16
    );
    let expected = library::source_fingerprint(&source, &mut || Ok(())).unwrap();
    let outside = non_archive_digest(&source);
    let root = tempfile::tempdir().unwrap();
    fs::copy(&input, root.path().join(DB)).unwrap();
    let start = std::time::Instant::now();
    let store = Store::new(root.path().into(), "test".into()).unwrap();
    let migration_ms = start.elapsed().as_millis();
    assert_eq!(
        store
            .with_archive_read(|c| library::source_fingerprint(c, &mut || Ok(())))
            .unwrap(),
        expected
    );
    assert_eq!(
        store
            .with_guide_read(|c| Ok(non_archive_digest(c)))
            .unwrap(),
        outside
    );
    let main_before = fs::read(root.path().join(DB)).unwrap();
    let revision = store
        .with_archive_read(archive::current)
        .unwrap()
        .to_string();
    let start = std::time::Instant::now();
    store
        .with_archive_write_checked(
            &revision,
            |_| Ok(None),
            |c, check| archive::remove(c, &archive::RemovalScope::All, None, &revision, check),
            || Ok(()),
        )
        .unwrap();
    let changing_ms = start.elapsed().as_millis();
    assert_eq!(fs::read(root.path().join(DB)).unwrap(), main_before);
    let next = store
        .with_archive_read(archive::current)
        .unwrap()
        .to_string();
    let start = std::time::Instant::now();
    store
        .with_archive_write_checked(
            &next,
            |_| Ok(Some(())),
            |_, _| panic!("proved no-op cannot write"),
            || Ok(()),
        )
        .unwrap();
    let noop_ms = start.elapsed().as_millis();
    assert_eq!(
        library::source_fingerprint(&source, &mut || Ok(())).unwrap(),
        expected
    );
    assert_eq!(non_archive_digest(&source), outside);
    println!(
        "archive-real-clone-profile {}",
        serde_json::json!({"sourceBytes":fs::metadata(input).unwrap().len(),"namespaceBytes":fs::metadata(root.path().join("archive-library-v1/archive.sqlite3")).unwrap().len(),"migrationMs":migration_ms,"changingClearMs":changing_ms,"provedNoopMs":noop_ms,"archiveRowsExactBeforeClear":true,"nonArchiveRowsExact":true,"inputUnchanged":true,"networkUsed":false,"deviceProof":false})
    );
}
