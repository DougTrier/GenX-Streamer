use super::*;
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicBool;

fn target(path: &Path, existing: bool) -> Result<StorageTarget, String> {
    Ok(StorageTarget {
        path: path.to_owned(),
        mode: "explicit-directory".into(),
        require_existing: existing,
        require_database: existing,
    })
}
fn seeded(path: &Path) -> Store {
    let store = Store::new(path.to_owned(), "explicit-directory".into()).unwrap();
    store.write_guarded(
        r#"{"schemaVersion":1,"sources":[],"channels":[]}"#,
        r#"{"schemaVersion":1,"sources":[],"favorites":[],"removedChannels":[],"volume":0.5,"muted":false,"panelWidth":300.0}"#,
        None, (None, None), || Ok(()),
    ).unwrap();
    store
}
fn digest(path: &Path) -> Vec<u8> {
    Sha256::digest(fs::read(path).unwrap()).to_vec()
}

#[test]
fn exclusive_startup_retry_reopens_only_same_target_after_release() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("library");
    let store = seeded(&path);
    let original = store.read_snapshot().unwrap();
    let database = path.join(crate::storage_transaction::DB);
    let backup = path.join("genx.sqlite3.backup");
    let before = (digest(&database), digest(&backup));
    let holder = rusqlite::Connection::open(&database).unwrap();
    holder.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let mut current = Store::new(path.clone(), "explicit-directory".into());
    assert_eq!(current.as_ref().err().unwrap(), "sqlite-storage-busy");
    holder.execute_batch("ROLLBACK").unwrap();
    drop(holder);
    assert_eq!(
        retry_same_location(
            &mut current,
            &target(&path, true),
            &AtomicBool::new(false),
            || Ok(())
        )
        .unwrap(),
        "explicit-directory"
    );
    assert_eq!(current.as_ref().unwrap().read_snapshot().unwrap(), original);
    assert_eq!((digest(&database), digest(&backup)), before);
}

#[test]
fn prepared_store_is_verified_even_without_successful_initial_read() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("accepted");
    let store = seeded(&path);
    let original = store.read_snapshot().unwrap();
    let mut current = Ok(store);
    assert_eq!(
        retry_same_location(
            &mut current,
            &Err("old unresolved startup path".into()),
            &AtomicBool::new(false),
            || Ok(())
        )
        .unwrap(),
        "explicit-directory"
    );
    assert_eq!(current.as_ref().unwrap().read_snapshot().unwrap(), original);
}

#[test]
fn missing_required_database_never_creates_blank_or_restores_backup() {
    let root = tempfile::tempdir().unwrap();
    let store = seeded(root.path());
    let database = root.path().join(crate::storage_transaction::DB);
    let backup = root.path().join("genx.sqlite3.backup");
    let before = digest(&backup);
    drop(store);
    fs::rename(&database, root.path().join("owned-held-database")).unwrap();
    let mut current = Err("sqlite-storage-busy".into());
    assert_eq!(
        retry_same_location(
            &mut current,
            &target(root.path(), true),
            &AtomicBool::new(false),
            || Ok(())
        )
        .unwrap_err(),
        "sqlite-required-database-missing"
    );
    assert!(!database.exists());
    assert_eq!(digest(&backup), before);
}

#[test]
fn missing_required_directory_is_not_recreated() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("library");
    drop(seeded(&path));
    fs::rename(&path, root.path().join("owned-moved-library")).unwrap();
    let mut current = Err("sqlite-storage-busy".into());
    assert_eq!(
        retry_same_location(
            &mut current,
            &target(&path, true),
            &AtomicBool::new(false),
            || Ok(())
        )
        .unwrap_err(),
        "storage-choice-directory-unavailable"
    );
    assert!(!path.exists());
}

#[test]
fn deliberate_first_initialization_can_create_only_original_target() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("first-library");
    let mut current = Err("initial unavailable directory".into());
    retry_same_location(
        &mut current,
        &target(&path, false),
        &AtomicBool::new(false),
        || Ok(()),
    )
    .unwrap();
    assert!(path.join(crate::storage_transaction::DB).is_file());
    assert_eq!(
        current.as_ref().unwrap().read_pair().unwrap(),
        crate::storage_transaction::RecordPair::default()
    );
}

#[test]
fn unresolved_and_previously_healthy_error_targets_cannot_fall_back() {
    let mut current = Err("original failed target".into());
    assert_eq!(
        retry_same_location(
            &mut current,
            &Err("storage-directory-invalid".into()),
            &AtomicBool::new(false),
            || Ok(())
        )
        .unwrap_err(),
        "storage-directory-invalid"
    );
    assert_eq!(current.as_ref().err().unwrap(), "original failed target");
    assert_eq!(
        retry_same_location(
            &mut current,
            &Err("ignored target".into()),
            &AtomicBool::new(true),
            || Ok(())
        )
        .unwrap_err(),
        "storage-healthy-switch-refused"
    );
}

#[test]
fn close_before_admission_or_after_verification_prevents_publication() {
    let root = tempfile::tempdir().unwrap();
    drop(seeded(root.path()));
    for reject_at in [0, 1] {
        let mut current = Err("initial failure".into());
        let mut checks = 0;
        assert_eq!(
            retry_same_location(
                &mut current,
                &target(root.path(), true),
                &AtomicBool::new(false),
                || {
                    let check = checks;
                    checks += 1;
                    if check == reject_at {
                        Err("application-closing".into())
                    } else {
                        Ok(())
                    }
                }
            )
            .unwrap_err(),
            "application-closing"
        );
        assert!(current.is_err());
    }
}

#[cfg(windows)]
#[test]
fn explicit_choice_updates_retry_namespace_only_after_bookmark_commit() {
    use crate::storage_recovery::{Bookmarks, RecoveryOwner};
    use std::sync::Arc;
    let root = tempfile::tempdir().unwrap();
    let selected = root.path().join("selected");
    let candidate = seeded(&selected);
    let original = candidate.read_snapshot().unwrap();
    let bookmarks =
        Bookmarks::new(root.path().join("config"), &root.path().join("owned.exe")).unwrap();
    let owner = Arc::new(RecoveryOwner::default());
    let mut current = Err("original startup failure".into());
    let mut retained = target(&root.path().join("original"), false);
    owner
        .begin()
        .unwrap()
        .commit_retained(
            &bookmarks,
            &selected,
            candidate,
            (&mut current, &mut retained),
            &AtomicBool::new(false),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(bookmarks.read().unwrap(), Some(selected.clone()));
    assert_eq!(retained.as_ref().unwrap().path, selected);
    assert!(retained.as_ref().unwrap().require_database);
    current = Err("later initial read failed".into());
    retry_same_location(&mut current, &retained, &AtomicBool::new(false), || Ok(())).unwrap();
    assert_eq!(current.as_ref().unwrap().read_snapshot().unwrap(), original);
}

#[cfg(windows)]
#[test]
fn failed_choice_or_obsolete_owner_preserves_original_retry_target() {
    use crate::storage_recovery::{Bookmarks, RecoveryOwner};
    use std::sync::Arc;
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("blocked-config");
    fs::write(&config, b"owned fixture").unwrap();
    let bookmarks = Bookmarks::new(config, &root.path().join("owned.exe")).unwrap();
    for obsolete in [false, true] {
        let owner = Arc::new(RecoveryOwner::default());
        let choice = owner.begin().unwrap();
        if obsolete {
            owner.cancel();
        }
        let original_path = root.path().join("original");
        let mut retained = target(&original_path, false);
        let mut current = Err("original failure".into());
        let selected = root.path().join("selected");
        assert!(choice
            .commit_retained(
                &bookmarks,
                &selected,
                seeded(&selected),
                (&mut current, &mut retained),
                &AtomicBool::new(false),
                &AtomicBool::new(false)
            )
            .is_err());
        assert_eq!(retained.as_ref().unwrap().path, original_path);
        assert!(current.is_err());
    }
}
