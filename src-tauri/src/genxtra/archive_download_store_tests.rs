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

//! Isolated ordinary-file/SQLite fixtures, not public-media decoder evidence.
use super::*;
fn fixture() -> (tempfile::TempDir, DownloadStore) {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("archive-downloads-v1");
    let store = DownloadStore::open(&directory, true, &mut || Ok(()))
        .unwrap()
        .unwrap();
    (root, store)
}
fn bytes(len: usize, variant: u8) -> Vec<u8> {
    let mut b = vec![variant; len];
    b[..8].copy_from_slice(b"\0\0\0\x18ftyp");
    b
}
fn capture(len: usize) -> Capture {
    let item = "controlled-item";
    let name = "season/episode.mp4";
    Capture {
        file: archive_catalog::ResolvedFile {
            item_id: item.into(),
            file_name: name.into(),
            size_bytes: len.to_string(),
            sha1: None,
            servers: vec![],
            duration_seconds: None,
            provider_index: None,
            public: None,
        },
        file_ref: archive_catalog::opaque(&["archive-file-v1", item, name]),
        title_ref: archive_catalog::opaque(&["archive-item-v1", item]),
        title: "Controlled title".into(),
        file_title: "Episode fixture".into(),
    }
}
fn body(store: &DownloadStore, id: u64, data: &[u8]) -> CompletedBody {
    let download_ref = format!("{id:064x}");
    let managed_name = format!("{download_ref}.mp4");
    let path = store.directory.join(&managed_name);
    std::fs::write(&path, data).unwrap();
    OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .sync_all()
        .unwrap();
    CompletedBody {
        download_ref,
        managed_name,
        size_bytes: data.len().to_string(),
        local_sha256: format!("{:x}", Sha256::digest(data)),
        provider_sha1_verified: false,
        completed_ms: 1000,
    }
}
fn complete(store: &DownloadStore, id: u64) -> Receipt {
    let data = bytes(131072, id as u8);
    let b = body(store, id, &data);
    store
        .complete(&capture(data.len()), &b, &mut || Ok(()))
        .unwrap()
}
fn assert_matching(store: &DownloadStore) {
    let a = snapshot(&connect(&store.directory.join(DB), false).unwrap(), true).unwrap();
    let b = snapshot(
        &connect(&store.directory.join(BACKUP), false).unwrap(),
        true,
    )
    .unwrap();
    assert!(
        a == b,
        "latest mirrors must match logicalnamespace/revisions/digest/rows"
    );
}

#[test]
fn completion_ack_has_latest_verified_mirror_and_bounded_url_free_wire() {
    let (_root, store) = fixture();
    let r = complete(&store, 1);
    assert!(r.committed && r.changed && r.entry.available);
    assert_eq!(r.revision, "1");
    assert_eq!(r.entry.integrity, "size-verified");
    assert_matching(&store);
    let wire = serde_json::to_string(&store.list().unwrap()).unwrap();
    assert!(
        !wire.contains("https:") && !wire.contains("managed_name") && !wire.contains("directory")
    );
    assert_eq!(store.list().unwrap().entries.len(), 1);
    assert!(store.preflight(&capture(131072)).is_err());
}
#[test]
fn exact_completion_retry_never_acknowledges_another_published_body() {
    let (_root, store) = fixture();
    let data = bytes(64, 1);
    let b = body(&store, 1, &data);
    let first = store
        .complete(&capture(data.len()), &b, &mut || Ok(()))
        .unwrap();
    let second = store
        .complete(&capture(data.len()), &b, &mut || Ok(()))
        .unwrap();
    assert!(!second.changed);
    assert_eq!(first.revision, second.revision);
    let mut changed = b;
    changed.local_sha256 = "f".repeat(64);
    assert!(store
        .complete(&capture(data.len()), &changed, &mut || Ok(()))
        .is_err());
    assert_matching(&store);
}
#[test]
fn single_copy_corruption_recovers_latest_acknowledged_completion() {
    for target in [DB, BACKUP] {
        let (_root, store) = fixture();
        complete(&store, 1);
        std::fs::write(store.directory.join(target), b"controlled corrupt SQLite").unwrap();
        let recovered = DownloadStore::open(&store.directory, false, &mut || Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(recovered.list().unwrap().entries.len(), 1);
        assert_matching(&recovered);
    }
}
#[test]
fn removal_cannot_resurrect_after_either_copy_corrupts_even_when_unlink_failed() {
    for target in [DB, BACKUP] {
        let (_root, store) = fixture();
        let r = complete(&store, 1);
        let removed = store
            .remove(&r.entry.download_ref, &r.revision, &mut || Ok(()))
            .unwrap();
        assert!(removed.committed && removed.changed);
        assert!(store.directory.join(&removed.managed_name).is_file());
        assert_matching(&store);
        std::fs::write(store.directory.join(target), b"controlled corrupt SQLite").unwrap();
        let recovered = DownloadStore::open(&store.directory, false, &mut || Ok(()))
            .unwrap()
            .unwrap();
        let pending = recovered.list().unwrap();
        assert_eq!(pending.entries.len(), 1);
        assert!(!pending.entries[0].available);
        assert_eq!(pending.entries[0].cleanup_pending, Some(true));
        assert!(recovered
            .local(&removed.download_ref, &removed.revision, &mut || Ok(()))
            .is_err());
        let retry = recovered
            .remove(&removed.download_ref, &removed.revision, &mut || Ok(()))
            .unwrap();
        assert!(!retry.changed);
        assert_eq!(retry.managed_name, removed.managed_name);
        std::fs::remove_file(recovered.directory.join(&retry.managed_name)).unwrap();
        assert!(recovered.list().unwrap().entries.is_empty());
        assert_matching(&recovered);
    }
}
#[test]
fn contradictory_namespace_identity_or_same_revision_payload_fails_closed() {
    let (_root, a) = fixture();
    let (_other, b) = fixture();
    std::fs::copy(b.directory.join(DB), a.directory.join(BACKUP)).unwrap();
    assert!(DownloadStore::open(&a.directory, false, &mut || Ok(())).is_err());
    let (_root, a) = fixture();
    complete(&a, 1);
    let mut s = a.read().unwrap();
    s.entries[0].title = "Different valid unacknowledged history".into();
    let c = connect(&a.directory.join(DB), false).unwrap();
    let raw = serde_json::to_string(&s.entries[0]).unwrap();
    c.execute("UPDATE download_entry SET record=?1", [raw])
        .unwrap();
    let d = digest(
        &s.namespace,
        s.revision,
        s.bookmark_revision,
        &s.entries,
        &s.bookmarks,
    )
    .unwrap();
    c.execute("UPDATE download_meta SET digest=?1", [d])
        .unwrap();
    drop(c);
    assert!(DownloadStore::open(&a.directory, false, &mut || Ok(())).is_err());
}
#[test]
fn both_corrupt_copies_refuse_instead_of_creating_an_empty_library() {
    let (_root, s) = fixture();
    complete(&s, 1);
    for name in [DB, BACKUP] {
        std::fs::write(s.directory.join(name), b"broken").unwrap();
    }
    assert!(DownloadStore::open(&s.directory, true, &mut || Ok(())).is_err());
    assert!(s.directory.join(format!("{:064x}.mp4", 1)).exists());
}
#[test]
fn unsupported_schema_and_busy_database_do_not_restore_a_stale_copy() {
    let (_root, s) = fixture();
    complete(&s, 1);
    let c = connect(&s.directory.join(DB), false).unwrap();
    c.execute_batch("PRAGMA user_version=2").unwrap();
    drop(c);
    let before = std::fs::read(s.directory.join(DB)).unwrap();
    assert!(DownloadStore::open(&s.directory, false, &mut || Ok(())).is_err());
    assert_eq!(std::fs::read(s.directory.join(DB)).unwrap(), before);
    let (_root, s) = fixture();
    complete(&s, 1);
    let c = connect(&s.directory.join(DB), false).unwrap();
    c.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let before = std::fs::read(s.directory.join(DB)).unwrap();
    assert!(DownloadStore::open(&s.directory, false, &mut || Ok(())).is_err());
    assert_eq!(std::fs::read(s.directory.join(DB)).unwrap(), before);
    c.execute_batch("ROLLBACK").unwrap();
}
#[test]
fn cancel_before_commit_rolls_back_namespace_and_late_abort_cannot_erase_commit() {
    let (_root, s) = fixture();
    let data = bytes(64, 1);
    let b = body(&s, 1, &data);
    let journal = s.directory.join(format!("{DB}-journal"));
    let mut crossed = false;
    let e = s.complete(&capture(data.len()), &b, &mut || {
        if journal.exists() {
            crossed = true;
            return Err("canceled".into());
        }
        Ok(())
    });
    assert!(e.is_err() && crossed);
    assert!(s.list().unwrap().entries.is_empty());
    assert_matching(&s);
    let mut abort_now = false;
    let result = s.complete(&capture(data.len()), &b, &mut || {
        if abort_now {
            return Err("canceled".into());
        }
        if journal.exists() {
            abort_now = true;
        }
        Ok(())
    });
    assert!(result.unwrap().committed && abort_now);
    assert_matching(&s);
}
#[test]
fn committed_before_mirror_failure_is_repair_required_and_newer_valid_commit_recovers() {
    let (_root, s) = fixture();
    let data = bytes(64, 1);
    let b = body(&s, 1, &data);
    let journal = s.directory.join(format!("{DB}-journal"));
    let backup = s.directory.join(BACKUP);
    let saved = s.directory.join("owned-prewrite-mirror");
    let mut injected = false;
    let result = s.complete(&capture(data.len()), &b, &mut || {
        if journal.exists() && !injected {
            std::fs::rename(&backup, &saved).unwrap();
            std::fs::create_dir(&backup).unwrap();
            injected = true;
        }
        Ok(())
    });
    assert_eq!(result.err().as_deref(), Some(REPAIR));
    assert!(injected);
    assert_eq!(s.read().unwrap().entries.len(), 1);
    assert!(s.directory.join(&b.managed_name).is_file());
    std::fs::remove_dir(&backup).unwrap();
    std::fs::rename(&saved, &backup).unwrap();
    let recovered = DownloadStore::open(&s.directory, false, &mut || Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(recovered.list().unwrap().entries.len(), 1);
    assert_matching(&recovered);
}
#[test]
fn managed_names_lengths_and_provider_digest_claims_are_not_caller_paths() {
    for mode in 0..4 {
        let (_root, s) = fixture();
        let data = bytes(64, 1);
        let mut b = body(&s, 1, &data);
        let mut c = capture(data.len());
        match mode {
            0 => b.managed_name = "../outside.mp4".into(),
            1 => b.size_bytes = "064".into(),
            2 => b.local_sha256 = "not-a-digest".into(),
            _ => c.file.sha1 = Some("a".repeat(40)),
        };
        assert!(s.complete(&c, &b, &mut || Ok(())).is_err());
        assert!(s.list().unwrap().entries.is_empty());
        assert_matching(&s);
    }
}
#[test]
fn offline_open_hashes_the_retained_ordinary_handle_and_cancel_releases_it() {
    let (_root, s) = fixture();
    let r = complete(&s, 1);
    let data = bytes(131072, 1);
    let body = s
        .local(&r.entry.download_ref, &r.revision, &mut || Ok(()))
        .unwrap();
    assert_eq!(body.read_chunk(5, 73).unwrap(), data[5..78]);
    assert_eq!(body.read_chunk(131000, 72).unwrap(), data[131000..]);
    assert!(body.read_chunk(0, 65537).is_err());
    drop(body);
    let mut calls = 0;
    assert!(s
        .local(&r.entry.download_ref, &r.revision, &mut || {
            calls += 1;
            if calls >= 3 {
                Err("canceled".into())
            } else {
                Ok(())
            }
        })
        .is_err());
    assert!(OpenOptions::new()
        .write(true)
        .open(s.directory.join(format!("{}.mp4", r.entry.download_ref)))
        .is_ok());
}
#[test]
fn corrupted_or_missing_media_never_silently_streams_or_becomes_complete_from_orphans() {
    let (_root, s) = fixture();
    let r = complete(&s, 1);
    let path = s.directory.join(format!("{}.mp4", r.entry.download_ref));
    let mut data = std::fs::read(&path).unwrap();
    data[30] ^= 1;
    std::fs::write(&path, data).unwrap();
    assert!(s
        .local(&r.entry.download_ref, &r.revision, &mut || Ok(()))
        .is_err());
    std::fs::remove_file(path).unwrap();
    assert!(!s.list().unwrap().entries[0].available);
    assert!(s
        .local(&r.entry.download_ref, &r.revision, &mut || Ok(()))
        .is_err());
    let (_root, empty) = fixture();
    body(&empty, 99, &bytes(64, 1));
    assert!(empty.list().unwrap().entries.is_empty());
}
#[test]
fn local_bookmarks_bind_exact_bytes_and_never_inherit_a_different_edition() {
    let (_root, s) = fixture();
    let r = complete(&s, 1);
    let body = s
        .local(&r.entry.download_ref, &r.revision, &mut || Ok(()))
        .unwrap();
    let proof = body.proof.clone();
    drop(body);
    let p = archive_bookmarks::Position {
        position_ms: 12500,
        duration_ms: Some(100000),
        completed: false,
        observed_ms: 1,
    };
    let before = s.read_bookmark(&proof).unwrap();
    assert!(before.position.is_none());
    let saved = s
        .save_bookmark(&proof, &before.revision, &p, &mut || Ok(()))
        .unwrap();
    assert!(saved.changed);
    assert_eq!(
        s.read_bookmark(&proof)
            .unwrap()
            .position
            .unwrap()
            .position_ms,
        12500
    );
    assert!(
        !s.save_bookmark(&proof, &saved.revision, &p, &mut || Ok(()))
            .unwrap()
            .changed
    );
    assert_matching(&s);
    let removed = s
        .remove(proof.download_ref(), &r.revision, &mut || Ok(()))
        .unwrap();
    assert!(s.read_bookmark(&proof).is_err());
    std::fs::remove_file(s.directory.join(removed.managed_name)).unwrap();
    let newer = complete(&s, 2);
    let body = s
        .local(&newer.entry.download_ref, &newer.revision, &mut || Ok(()))
        .unwrap();
    assert_ne!(body.proof.identity(), proof.identity());
    assert!(s.read_bookmark(&body.proof).unwrap().position.is_none());
}
#[test]
fn main_store_and_remote_removal_are_independent_of_saved_content_and_local_bookmarks() {
    let root = tempfile::tempdir().unwrap();
    let store = crate::storage::Store::new(root.path().into(), "download-fixture".into()).unwrap();
    let data = bytes(64, 1);
    let c = capture(data.len());
    store.with_archive_fixture_write(|db|{db.execute("INSERT INTO archive_title_v1(title_ref,item_id,title,kind,curated,searched,downloads,observed_ms,search_text) VALUES(?1,?2,'Controlled title','movie',0,1,0,0,'controlled')",params![c.title_ref,c.file.item_id]).map_err(|_|ERR)?;db.execute("INSERT INTO archive_file_v1(file_ref,title_ref,item_id,file_name,format,size_bytes,servers,observed_ms,eligible,file_title) VALUES(?1,?2,?3,?4,'h.264',?5,'[]',0,1,'Episode fixture')",params![c.file_ref,c.title_ref,c.file.item_id,c.file.file_name,c.file.size_bytes]).map_err(|_|ERR)?;db.execute("UPDATE archive_catalog_meta_v1 SET revision=1",[]).map_err(|_|ERR)?;Ok(())}).unwrap();
    let main = root.path().join("genx.sqlite3");
    let main_before = std::fs::read(&main).unwrap();
    let backup_before = std::fs::read(root.path().join("genx.sqlite3.backup")).unwrap();
    let (captured, directory) = store.archive_download_capture(&c.file_ref, "1").unwrap();
    let namespace = DownloadStore { directory };
    let b = body(&namespace, 1, &data);
    let r = store
        .commit_archive_download_checked(&captured, &b, || Ok(()))
        .unwrap();
    assert_eq!(std::fs::read(&main).unwrap(), main_before);
    assert_eq!(
        std::fs::read(root.path().join("genx.sqlite3.backup")).unwrap(),
        backup_before
    );
    store
        .with_archive_fixture_write(|db| {
            db.execute("DELETE FROM archive_title_v1", [])
                .map_err(|_| ERR)?;
            Ok(())
        })
        .unwrap();
    let local = store
        .open_archive_download_checked(&r.entry.download_ref, &r.revision, || Ok(()))
        .unwrap();
    assert_eq!(local.read_chunk(0, data.len()).unwrap(), data);
    assert_eq!(
        store.list_archive_downloads().unwrap().entries[0].title,
        "Controlled title"
    );
    let position = archive_bookmarks::Position {
        position_ms: 10,
        duration_ms: Some(1000),
        completed: false,
        observed_ms: 1,
    };
    let bookmark = store.read_archive_download_bookmark(&local.proof).unwrap();
    store
        .write_archive_download_bookmark_checked(
            &local.proof,
            &bookmark.revision,
            &position,
            || Ok(()),
        )
        .unwrap();
    assert_eq!(
        store
            .read_archive_download_bookmark(&local.proof)
            .unwrap()
            .position
            .unwrap()
            .position_ms,
        10
    );
}

pub(crate) fn local_fixture(directory: &Path) -> (Receipt, Vec<u8>) {
    let store = DownloadStore::open(directory, true, &mut || Ok(()))
        .unwrap()
        .unwrap();
    let data = bytes(131072, 1);
    let b = body(&store, 1, &data);
    let r = store
        .complete(&capture(data.len()), &b, &mut || Ok(()))
        .unwrap();
    (r, data)
}
pub(crate) fn local_proxy_fixture() -> (tempfile::TempDir, LocalBody, Vec<u8>) {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("archive-downloads-v1");
    let (r, data) = local_fixture(&directory);
    let store = DownloadStore::open(&directory, false, &mut || Ok(()))
        .unwrap()
        .unwrap();
    let body = store
        .local(&r.entry.download_ref, &r.revision, &mut || Ok(()))
        .unwrap();
    (root, body, data)
}

#[test]
fn latest_valid_replica_repairs_logical_metadata_corruption_without_losing_acknowledged_entry() {
    for change in [
        "UPDATE download_meta SET digest='invalid'",
        "UPDATE download_meta SET revision=-1",
        "UPDATE download_meta SET revision='bad-type'",
        "DELETE FROM download_meta",
        "UPDATE download_entry SET record='malformed-json'",
        "ALTER TABLE download_entry RENAME COLUMN record TO wrong_record",
    ] {
        let (_root, store) = fixture();
        complete(&store, 1);
        let c = connect(&store.directory.join(DB), false).unwrap();
        c.execute_batch(change).unwrap();
        drop(c);
        let recovered = DownloadStore::open(&store.directory, false, &mut || Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(recovered.list().unwrap().entries.len(), 1);
        assert_matching(&recovered);
    }
}
#[test]
fn persisted_oversized_record_is_bounded_before_string_allocation_and_recovers_other_replica() {
    let (_root, store) = fixture();
    complete(&store, 1);
    let c = connect(&store.directory.join(DB), false).unwrap();
    c.execute_batch("PRAGMA ignore_check_constraints=ON;UPDATE download_entry SET record=printf('%10000s','x');")
        .unwrap();
    drop(c);
    let recovered = DownloadStore::open(&store.directory, false, &mut || Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(recovered.list().unwrap().entries.len(), 1);
    assert_matching(&recovered);
}

#[test]
fn unrecognizable_copy_with_unresolved_journal_is_never_opened_or_replaced() {
    for target in [DB, BACKUP] {
        let (_root, store) = fixture();
        complete(&store, 1);
        let path = store.directory.join(target);
        let corrupt = b"controlled corrupt SQLite with journal";
        std::fs::write(&path, corrupt).unwrap();
        let journal = store.directory.join(format!("{target}-journal"));
        std::fs::write(&journal, b"unresolved controlled journal").unwrap();
        let other = store.directory.join(if target == DB { BACKUP } else { DB });
        let before = std::fs::read(&other).unwrap();
        assert!(
            matches!(DownloadStore::open(&store.directory, false, &mut || Ok(())), Err(e) if e == REPAIR)
        );
        assert_eq!(std::fs::read(&path).unwrap(), corrupt);
        assert_eq!(
            std::fs::read(&journal).unwrap(),
            b"unresolved controlled journal"
        );
        assert_eq!(std::fs::read(&other).unwrap(), before);
    }
}
