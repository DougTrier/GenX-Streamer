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
use std::fs;

fn digest(path: &Path) -> Vec<u8> {
    Sha256::digest(fs::read(path).unwrap()).to_vec()
}

#[test]
fn exclusive_startup_lock_does_not_restore_stale_backup() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let catalog = r#"{"schemaVersion":1,"sources":[],"channels":[]}"#;
    store
        .write_pair(
            catalog,
            r#"{"schemaVersion":1,"sources":[],"favorites":[],"removedChannels":[],"volume":0.5,"muted":false,"panelWidth":300.0}"#,
        )
        .unwrap();
    store
        .write_pair(
            catalog,
            r#"{"schemaVersion":1,"sources":[],"favorites":[],"removedChannels":[],"volume":0.6,"muted":false,"panelWidth":300.0}"#,
        )
        .unwrap();
    let main = root.path().join(DB);
    let backup = root.path().join(BACKUP);
    let original = store.read_pair().unwrap();
    let backup_before = digest(&backup);
    let main_before = digest(&main);
    let connection = connect(&main, false).unwrap();
    connection.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert!(!root.path().join(format!("{DB}-journal")).exists());
    let started = std::time::Instant::now();
    let error = PairStore::new(root.path().into()).err().unwrap();
    assert!(started.elapsed() < Duration::from_secs(4));
    connection.execute_batch("ROLLBACK").unwrap();
    drop(connection);
    // Record observations before asserting the error category to retain any
    // attempted replacement evidence from the historical implementation.
    let main_unchanged = digest(&main) == main_before;
    let backup_unchanged = digest(&backup) == backup_before;
    println!("exclusive-startup fixture: error={error}, main_unchanged={main_unchanged}, backup_unchanged={backup_unchanged}");
    assert_eq!(error, "sqlite-storage-busy");
    assert!(main_unchanged);
    assert!(backup_unchanged);
    assert_eq!(
        PairStore::new(root.path().into())
            .unwrap()
            .read_pair()
            .unwrap(),
        original
    );
}

#[test]
fn inaccessible_main_is_refused_without_replacing_directory_or_backup() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let catalog = r#"{"schemaVersion":1,"sources":[],"channels":[]}"#;
    let preferences = r#"{"schemaVersion":1,"sources":[],"favorites":[],"removedChannels":[],"volume":0.5,"muted":false,"panelWidth":300.0}"#;
    store.write_pair(catalog, preferences).unwrap();
    let main = root.path().join(DB);
    let held = root.path().join("owned-main-held.sqlite3");
    let backup = root.path().join(BACKUP);
    let before = digest(&backup);
    fs::rename(&main, &held).unwrap();
    fs::create_dir(&main).unwrap();
    fs::write(main.join("owned-sentinel"), b"preserve").unwrap();
    let error = PairStore::new(root.path().into()).err().unwrap();
    assert_eq!(error, "sqlite-recovery-inspection-failed");
    assert_eq!(digest(&backup), before);
    assert_eq!(fs::read(main.join("owned-sentinel")).unwrap(), b"preserve");
    assert!(held.is_file());
}

#[test]
fn only_typed_corruption_codes_admit_replacement() {
    for code in [rusqlite::ffi::SQLITE_CORRUPT, rusqlite::ffi::SQLITE_NOTADB] {
        let error = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(code), None);
        assert!(matches!(
            inspect_sql::<()>(Err(error)),
            Err(InspectionFailure::Corrupt)
        ));
    }
    for code in [rusqlite::ffi::SQLITE_BUSY, rusqlite::ffi::SQLITE_LOCKED] {
        let error = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(code), None);
        assert!(matches!(
            inspect_sql::<()>(Err(error)),
            Err(InspectionFailure::Refused("sqlite-storage-busy"))
        ));
    }
    for code in [
        rusqlite::ffi::SQLITE_IOERR,
        rusqlite::ffi::SQLITE_READONLY,
        rusqlite::ffi::SQLITE_CANTOPEN,
        rusqlite::ffi::SQLITE_PERM,
    ] {
        let error = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(code), None);
        assert!(matches!(
            inspect_sql::<()>(Err(error)),
            Err(InspectionFailure::Refused(
                "sqlite-recovery-inspection-failed"
            ))
        ));
    }
}
