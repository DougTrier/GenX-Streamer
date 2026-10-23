//! Actual PairStore transaction integration; XOR is a fixture, not OS crypto proof.
use super::{origin_directory, tests as fixture, *};
use rusqlite::Connection;

#[test]
fn protected_store_seal_acknowledges_checkpoint_and_capsule_together() {
    let (dir, store, checkpoint, entries) = fixture::fixture(65);
    let mut header = store
        .begin_scan_candidate_manifest(&fixture::begin_request(&checkpoint), || Ok(()))
        .unwrap();
    for page in entries.chunks(64) {
        header = fixture::append(&store, &header, page);
    }
    let request = fixture::seal_request(&header);
    let prepared = store
        .prepare_scan_candidate_manifest_seal(&request, || Ok(()))
        .unwrap();
    let cipher: Vec<_> = prepared.plaintext.iter().map(|b| b ^ 0xa5).collect();
    let before = store.read_pair().unwrap();
    let receipt = store
        .seal_protected_scan_candidate_manifest(&request, &prepared, &cipher, || Ok(()))
        .unwrap();
    assert!(receipt.committed);
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("1"));
    assert_eq!(store.read_pair().unwrap(), before);
    let connection = Connection::open(dir.path().join("genx.sqlite3")).unwrap();
    let prefs = serde_json::from_str(before.preferences.as_ref().unwrap()).unwrap();
    let catalog = serde_json::from_str(before.catalog.as_ref().unwrap()).unwrap();
    let context = Context {
        preferences: &prefs,
        catalog: &catalog,
        catalog_revision: 1,
        checkpoint_revision: 1,
        now: fixture::now(),
    };
    let find = Find {
        job_id: header.job_id,
        review_digest: header.review_digest,
        expected_catalog_revision: "1".into(),
        expected_checkpoint_revision: "1".into(),
    };
    let encrypted =
        origin_directory::prepare_open(&connection, &find, &context, || Ok(())).unwrap();
    let plain = encrypted.ciphertext.iter().map(|b| b ^ 0xa5).collect();
    let admitted =
        origin_directory::finish_open(&connection, &find, &encrypted, plain, &context, || Ok(()))
            .unwrap();
    assert_eq!(admitted.rows.len(), 65);
}

#[test]
fn cancellation_at_each_store_seal_boundary_preserves_retry_and_pair() {
    let mut failures = 0;
    let mut acknowledgments = 0;
    for fail_at in 1..=24 {
        let (dir, store, checkpoint, entries) = fixture::fixture(2);
        let header = store
            .begin_scan_candidate_manifest(&fixture::begin_request(&checkpoint), || Ok(()))
            .unwrap();
        let header = fixture::append(&store, &header, &entries);
        let request = fixture::seal_request(&header);
        let prepared = store
            .prepare_scan_candidate_manifest_seal(&request, || Ok(()))
            .unwrap();
        let cipher: Vec<_> = prepared.plaintext.iter().map(|b| b ^ 0xa5).collect();
        let before = store.read_pair().unwrap();
        let mut calls = 0;
        let result =
            store.seal_protected_scan_candidate_manifest(&request, &prepared, &cipher, || {
                calls += 1;
                if calls == fail_at {
                    Err("controlled-cancel".into())
                } else {
                    Ok(())
                }
            });
        assert_eq!(store.read_pair().unwrap(), before);
        match result {
            Err(_) => {
                failures += 1;
                assert_eq!(
                    store.read_scan_checkpoint().unwrap().checkpoint_status,
                    "absent"
                );
                let connection = Connection::open(dir.path().join("genx.sqlite3")).unwrap();
                let state: i64 = connection
                    .query_row(
                        "SELECT state FROM scan_manifest_origin_directory",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(state, 0);
                assert!(
                    store
                        .seal_protected_scan_candidate_manifest(
                            &request,
                            &prepared,
                            &cipher,
                            || Ok(())
                        )
                        .unwrap()
                        .committed
                );
            }
            Ok(receipt) => {
                acknowledgments += 1;
                assert!(receipt.committed);
                assert_eq!(receipt.checkpoint_revision.as_deref(), Some("1"));
            }
        }
    }
    assert!(failures > 8);
    assert!(acknowledgments > 0);
}
