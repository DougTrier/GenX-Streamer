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

//! Controlled SQLite/cipher-boundary fixtures. XOR below is a test transform, not security proof.
use super::*;
use crate::{
    scan_checkpoint,
    storage_transaction::{PairStore, RecordPair},
};
pub(super) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
pub(super) fn fixture(count: usize) -> (tempfile::TempDir, PairStore, Value, Vec<Entry>) {
    let (dir, store, value, entries) = original_fixture(count);
    (dir, store, scan_checkpoint::packed_fixture(&value), entries)
}
fn original_fixture(count: usize) -> (tempfile::TempDir, PairStore, Value, Vec<Entry>) {
    let dir = tempfile::tempdir().unwrap();
    let store = PairStore::new(dir.path().to_owned()).unwrap();
    let source = json!({"id":"public","name":"Public","kind":"url","location":"https://example.com/public.m3u","allowHttp":false});
    let catalog = json!({"schemaVersion":1,"sources":[source.clone()],"channels":[]});
    let prefs = json!({"schemaVersion":1,"sources":[source.clone()],"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":300.0});
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    let entries: Vec<_> = (0..count)
        .map(|candidate_index| Entry {
            candidate_index,
            urls: vec![
                format!("https://example.com/original-{candidate_index}.m3u8?public=1"),
                format!("http://example.com/alternate-{candidate_index}.ts"),
            ],
        })
        .collect();
    let candidates:Vec<Value>=entries.iter().map(|entry|json!({"key":format!("key-{}",entry.candidate_index),"sourceId":"public","sourceFingerprint":"scope-a","sessionRevision":"session-a","channel":{"sourceId":"public","providerId":format!("station-{}",entry.candidate_index),"name":format!("Station {}",entry.candidate_index),"category":"News","urls":entry.urls}})).collect();
    let mut value = json!({"schemaVersion":1,"jobId":"job-a","createdAtMs":now(),"catalogRevision":"1","policyFingerprint":"","sourceDefinitions":[{"source":source.clone(),"definitionFingerprint":scan_checkpoint::source_fingerprint(&source).unwrap()}],"budgetMs":20000,"platform":"windows","observerProfile":"fixture","review":{"sessionRevision":"session-a","query":"","status":"completed","sources":[{"sourceId":"public","fingerprint":"scope-a","status":"completed","inspected":count,"matched":count,"warnings":0}],"candidates":candidates,"counts":{"inspected":count,"matched":count,"failedSources":0,"canceledSources":0}},"observations":[],"publishedKeys":[]});
    value["policyFingerprint"] =
        json!(scan_checkpoint::policy_fingerprint(&value, &prefs).unwrap());
    (dir, store, value, entries)
}
pub(super) fn begin_request(checkpoint: &Value) -> Begin {
    Begin {
        schema_version: 1,
        checkpoint: checkpoint.to_string(),
        expected_catalog_revision: "1".into(),
        expected_checkpoint_revision: "0".into(),
    }
}
pub(super) fn append(store: &PairStore, header: &Header, entries: &[Entry]) -> Header {
    let request = Append {
        manifest_id: header.manifest_id.clone(),
        expected_manifest_revision: header.manifest_revision.clone(),
        expected_catalog_revision: "1".into(),
        expected_checkpoint_revision: "0".into(),
        entries: entries.to_vec(),
    };
    let prepared = store
        .prepare_scan_candidate_manifest_page(request, || Ok(()))
        .unwrap();
    let cipher: Vec<_> = prepared.plaintext.iter().map(|b| b ^ 0xa5).collect();
    store
        .append_scan_candidate_manifest_page(&prepared, &cipher, || Ok(()))
        .unwrap()
}
pub(super) fn seal_request(header: &Header) -> Seal {
    Seal {
        manifest_id: header.manifest_id.clone(),
        expected_manifest_revision: header.manifest_revision.clone(),
        expected_catalog_revision: "1".into(),
        expected_checkpoint_revision: "0".into(),
    }
}
pub(super) fn read_request(header: &Header, start: usize) -> Read {
    Read {
        manifest_id: header.manifest_id.clone(),
        job_id: header.job_id.clone(),
        review_digest: header.review_digest.clone(),
        start_index: start,
        expected_catalog_revision: "1".into(),
        expected_checkpoint_revision: "1".into(),
    }
}
#[test]
fn atomic_seal_reopen_and_page_recovery_needs_no_online_source() {
    let (dir, store, checkpoint, entries) = fixture(65);
    let before = store.read_pair().unwrap();
    let mut header = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "absent"
    );
    header = append(&store, &header, &entries[..64]);
    assert!(store
        .seal_scan_candidate_manifest(&seal_request(&header), || Ok(()))
        .is_err());
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "absent"
    );
    header = append(&store, &header, &entries[64..]);
    let receipt = store
        .seal_scan_candidate_manifest(&seal_request(&header), || Ok(()))
        .unwrap();
    assert!(receipt.committed);
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("1"));
    assert_eq!(receipt.catalog_revision, "1");
    assert_eq!(store.read_pair().unwrap(), before);
    drop(store);
    let store = PairStore::new(dir.path().to_owned()).unwrap();
    let found = store
        .find_scan_candidate_manifest(
            &Find {
                job_id: header.job_id.clone(),
                review_digest: header.review_digest.clone(),
                expected_catalog_revision: "1".into(),
                expected_checkpoint_revision: "1".into(),
            },
            || Ok(()),
        )
        .unwrap();
    assert_eq!(found.status, "sealed");
    assert_eq!(found.header.as_ref().unwrap().next_index, 65);
    for start in [0, 64] {
        let request = read_request(&header, start);
        let page = store
            .read_scan_candidate_manifest_page(&request, || Ok(()))
            .unwrap();
        let plain = page.ciphertext.iter().map(|b| b ^ 0xa5).collect();
        let output = store
            .finish_scan_candidate_manifest_page(&request, page, plain, || Ok(()))
            .unwrap();
        assert_eq!(output.entries[0].urls, entries[start].urls);
        assert!(encode(&output).unwrap().len() < PAGE_LIMIT);
    }
    let c = Connection::open(dir.path().join("genx.sqlite3")).unwrap();
    let raw: Vec<u8> = c
        .query_row(
            "SELECT ciphertext FROM scan_manifest_page LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!String::from_utf8_lossy(&raw).contains("original-"));
}
#[test]
fn ordinal_hash_alternate_duplicate_capacity_and_cas_refusals_preserve_job() {
    let (_dir, store, checkpoint, entries) = fixture(2);
    let header = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    for kind in 0..5 {
        let mut request = Append {
            manifest_id: header.manifest_id.clone(),
            expected_manifest_revision: "0".into(),
            expected_catalog_revision: "1".into(),
            expected_checkpoint_revision: "0".into(),
            entries: entries.clone(),
        };
        match kind {
            0 => request.entries[0].candidate_index = 1,
            1 => request.entries[0].urls.reverse(),
            2 => request.entries[0].urls[0] = "https://example.com/replacement.ts".into(),
            3 => request.expected_checkpoint_revision = "1".into(),
            _ => request.entries = vec![entries[0].clone(); 65],
        };
        assert!(store
            .prepare_scan_candidate_manifest_page(request, || Ok(()))
            .is_err());
    }
    let appended = append(&store, &header, &entries);
    let replay = Append {
        manifest_id: header.manifest_id.clone(),
        expected_manifest_revision: "0".into(),
        expected_catalog_revision: "1".into(),
        expected_checkpoint_revision: "0".into(),
        entries,
    };
    assert!(store
        .prepare_scan_candidate_manifest_page(replay, || Ok(()))
        .is_err());
    assert_eq!(appended.next_index, 2);
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "absent"
    );
}
#[test]
fn failed_seal_rolls_back_checkpoint_and_manifest_and_retry_is_exact() {
    let (_dir, store, checkpoint, entries) = fixture(1);
    let header = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    let header = append(&store, &header, &entries);
    let mut calls = 0;
    let result = store.seal_scan_candidate_manifest(&seal_request(&header), || {
        calls += 1;
        if calls > 3 {
            Err("controlled-cancel".into())
        } else {
            Ok(())
        }
    });
    assert!(result.is_err());
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "absent"
    );
    assert!(
        store
            .seal_scan_candidate_manifest(&seal_request(&header), || Ok(()))
            .unwrap()
            .committed
    );
}
#[test]
fn decrypt_tamper_post_crypto_revision_and_atomic_discard_are_refused() {
    let (dir, store, checkpoint, entries) = fixture(1);
    let header = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    let header = append(&store, &header, &entries);
    store
        .seal_scan_candidate_manifest(&seal_request(&header), || Ok(()))
        .unwrap();
    let request = read_request(&header, 0);
    let page = store
        .read_scan_candidate_manifest_page(&request, || Ok(()))
        .unwrap();
    let mut plain: Vec<_> = page.ciphertext.iter().map(|b| b ^ 0xa5).collect();
    plain[0] ^= 1;
    assert!(store
        .finish_scan_candidate_manifest_page(&request, page, plain, || Ok(()))
        .is_err());
    let page = store
        .read_scan_candidate_manifest_page(&request, || Ok(()))
        .unwrap();
    let plain = page.ciphertext.iter().map(|b| b ^ 0xa5).collect();
    store
        .write_pair_with_scan(
            &RecordPair::default(),
            None,
            (Some("1"), None),
            Some((
                &scan_checkpoint::Mutation::Discard {
                    job_id: "job-a".into(),
                },
                "1",
            )),
            || Ok(()),
        )
        .unwrap();
    assert!(store
        .finish_scan_candidate_manifest_page(&request, page, plain, || Ok(()))
        .is_err());
    let c = Connection::open(dir.path().join("genx.sqlite3")).unwrap();
    let remaining: i64 = c
        .query_row("SELECT COUNT(*) FROM scan_manifest", [], |r| r.get(0))
        .unwrap();
    assert_eq!(remaining, 0);
}
#[test]
fn missing_page_cannot_seal_and_swapped_bindings_cannot_decrypt() {
    let (dir, store, checkpoint, entries) = fixture(2);
    let header = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    let header = append(&store, &header, &entries[..1]);
    let header = append(&store, &header, &entries[1..]);
    let c = Connection::open(dir.path().join("genx.sqlite3")).unwrap();
    c.execute("DELETE FROM scan_manifest_page WHERE start_index=1", [])
        .unwrap();
    assert!(store
        .seal_scan_candidate_manifest(&seal_request(&header), || Ok(()))
        .is_err());
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "absent"
    );
}
#[test]
fn large_original_queues_are_bounded_paged_and_restartable() {
    for count in [13_241, 63_193] {
        let (dir, store, checkpoint, entries) = fixture(count);
        let mut header = store
            .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
            .unwrap();
        for page in entries.chunks(64) {
            header = append(&store, &header, page);
        }
        store
            .seal_scan_candidate_manifest(&seal_request(&header), || Ok(()))
            .unwrap();
        drop(store);
        let store = PairStore::new(dir.path().to_owned()).unwrap();
        let start = (count - 1) / 64 * 64;
        let request = read_request(&header, start);
        let page = store
            .read_scan_candidate_manifest_page(&request, || Ok(()))
            .unwrap();
        let plain = page.ciphertext.iter().map(|b| b ^ 0xa5).collect();
        let output = store
            .finish_scan_candidate_manifest_page(&request, page, plain, || Ok(()))
            .unwrap();
        assert_eq!(output.next_index, count);
        assert!(output.entries.len() <= 64);
    }
}
#[test]
fn exact_unsealed_retry_fences_old_prepared_work_and_preserves_sealed_job() {
    let (_dir, store, checkpoint, entries) = fixture(1);
    let first = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    let prepared = store
        .prepare_scan_candidate_manifest_page(
            Append {
                manifest_id: first.manifest_id.clone(),
                expected_manifest_revision: "0".into(),
                expected_catalog_revision: "1".into(),
                expected_checkpoint_revision: "0".into(),
                entries: entries.clone(),
            },
            || Ok(()),
        )
        .unwrap();
    let cipher: Vec<_> = prepared.plaintext.iter().map(|b| b ^ 0xa5).collect();
    let second = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    assert_ne!(first.manifest_id, second.manifest_id);
    assert_eq!(
        store
            .append_scan_candidate_manifest_page(&prepared, &cipher, || Ok(()))
            .err()
            .unwrap(),
        "scan-manifest-absent"
    );
    let second = append(&store, &second, &entries);
    store
        .seal_scan_candidate_manifest(&seal_request(&second), || Ok(()))
        .unwrap();
    let before = store.read_scan_checkpoint().unwrap();
    let mut retry = begin_request(&checkpoint);
    retry.expected_checkpoint_revision = "1".into();
    assert!(store
        .begin_scan_candidate_manifest(&retry, || Ok(()))
        .is_err());
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint,
        before.checkpoint
    );
}
#[test]
fn current_policy_change_after_crypto_refuses_append_without_progress_or_checkpoint_change() {
    let (dir, store, checkpoint, entries) = fixture(1);
    let header = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    let prepared = store
        .prepare_scan_candidate_manifest_page(
            Append {
                manifest_id: header.manifest_id.clone(),
                expected_manifest_revision: "0".into(),
                expected_catalog_revision: "1".into(),
                expected_checkpoint_revision: "0".into(),
                entries,
            },
            || Ok(()),
        )
        .unwrap();
    let cipher: Vec<_> = prepared.plaintext.iter().map(|b| b ^ 0xa5).collect();
    let pair = store.read_pair().unwrap();
    let mut prefs: Value = serde_json::from_str(pair.preferences.as_ref().unwrap()).unwrap();
    prefs["preferredRegion"] = json!({"country":"US","origin":"manual"});
    store
        .write_record_guarded("preferences", &prefs.to_string(), Some("1"), || Ok(()))
        .unwrap();
    assert_eq!(
        store
            .append_scan_candidate_manifest_page(&prepared, &cipher, || Ok(()))
            .err()
            .unwrap(),
        "scan-checkpoint-policy-stale"
    );
    let c = Connection::open(dir.path().join("genx.sqlite3")).unwrap();
    let next: i64 = c
        .query_row("SELECT next_index FROM scan_manifest", [], |r| r.get(0))
        .unwrap();
    assert_eq!(next, 0);
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "absent"
    );
}
#[test]
fn swapped_binding_is_rejected_before_platform_decryption() {
    let (dir, store, checkpoint, entries) = fixture(1);
    let header = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    let header = append(&store, &header, &entries);
    store
        .seal_scan_candidate_manifest(&seal_request(&header), || Ok(()))
        .unwrap();
    let c = Connection::open(dir.path().join("genx.sqlite3")).unwrap();
    c.execute(
        "UPDATE scan_manifest_page SET binding='foreign-job-binding'",
        [],
    )
    .unwrap();
    assert!(store
        .read_scan_candidate_manifest_page(&read_request(&header, 0), || Ok(()))
        .is_err());
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "valid"
    );
}
#[test]
fn sqlite_disk_full_append_rolls_back_staging_and_preserves_canonical_pair() {
    let (dir, store, checkpoint, entries) = fixture(1);
    let before = store.read_pair().unwrap();
    let header = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    let prepared = store
        .prepare_scan_candidate_manifest_page(
            Append {
                manifest_id: header.manifest_id.clone(),
                expected_manifest_revision: "0".into(),
                expected_catalog_revision: "1".into(),
                expected_checkpoint_revision: "0".into(),
                entries,
            },
            || Ok(()),
        )
        .unwrap();
    let cipher: Vec<_> = prepared.plaintext.iter().map(|b| b ^ 0xa5).collect();
    let mut c = Connection::open(dir.path().join("genx.sqlite3")).unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;CREATE TABLE manifest_fixture_fill(value BLOB)")
        .unwrap();
    let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    c.execute_batch(&format!("PRAGMA max_page_count={pages}"))
        .unwrap();
    loop {
        match c.execute(
            "INSERT INTO manifest_fixture_fill VALUES(zeroblob(1000))",
            [],
        ) {
            Ok(_) => {}
            Err(error) => {
                assert_eq!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DiskFull)
                );
                break;
            }
        }
    }
    let pair = store.read_pair().unwrap();
    let preferences: Value = serde_json::from_str(pair.preferences.as_ref().unwrap()).unwrap();
    let catalog: Value = serde_json::from_str(pair.catalog.as_ref().unwrap()).unwrap();
    let tx = c.transaction().unwrap();
    let context = Context {
        preferences: &preferences,
        catalog: &catalog,
        catalog_revision: 1,
        checkpoint_revision: 0,
        now: now(),
    };
    assert!(append_page(
        &tx,
        &prepared,
        &vec![0; CIPHER_PAGE_LIMIT],
        &context,
        || Ok(())
    )
    .is_err());
    drop(tx);
    assert_eq!(store.read_pair().unwrap(), before);
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "absent"
    );
    let next: i64 = c
        .query_row("SELECT next_index FROM scan_manifest", [], |r| r.get(0))
        .unwrap();
    assert_eq!(next, 0);
    assert!(!cipher.is_empty());
}
#[test]
fn shared_long_category_is_stored_once_and_checkpoint_association_is_digest_bound() {
    let (dir, store, packed, entries) = fixture(128);
    let mut runtime = packed.clone();
    runtime["schemaVersion"] = json!(1);
    for key in ["reviewDigest", "categoryTable", "publishedIndices"] {
        runtime.as_object_mut().unwrap().remove(key);
    }
    runtime["publishedKeys"] = json!([]);
    runtime["review"]["candidates"]=json!(entries.iter().map(|entry|json!({"key":format!("key-{}",entry.candidate_index),"sourceId":"public","sourceFingerprint":"scope-a","sessionRevision":"session-a","channel":{"sourceId":"public","providerId":format!("station-{}",entry.candidate_index),"name":format!("Station {}",entry.candidate_index),"category":"x".repeat(16_384),"urls":entry.urls}})).collect::<Vec<_>>());
    let checkpoint = scan_checkpoint::packed_fixture(&runtime);
    let mut header = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    let c = Connection::open(dir.path().join("genx.sqlite3")).unwrap();
    let category_bytes: i64 = c
        .query_row(
            "SELECT SUM(length(CAST(contents AS BLOB))) FROM scan_manifest_category",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(category_bytes, 16_384);
    let indexed_bytes: i64 = c
        .query_row(
            "SELECT SUM(length(CAST(metadata AS BLOB))) FROM scan_manifest_candidate",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(indexed_bytes < 100_000);
    for page in entries.chunks(64) {
        header = append(&store, &header, page);
    }
    store
        .seal_scan_candidate_manifest(&seal_request(&header), || Ok(()))
        .unwrap();
    let request = read_request(&header, 0);
    let page = store
        .read_scan_candidate_manifest_page(&request, || Ok(()))
        .unwrap();
    let plain = page.ciphertext.iter().map(|b| b ^ 0xa5).collect();
    store
        .finish_scan_candidate_manifest_page(&request, page, plain, || Ok(()))
        .unwrap();
    // Simulate incompatible private association: same-job Save must atomically invalidate it.
    c.execute(
        "UPDATE scan_manifest SET review_digest=?1",
        ["f".repeat(64)],
    )
    .unwrap();
    store
        .write_pair_with_scan(
            &RecordPair::default(),
            None,
            (Some("1"), None),
            Some((
                &scan_checkpoint::Mutation::Save {
                    checkpoint: checkpoint.to_string(),
                },
                "1",
            )),
            || Ok(()),
        )
        .unwrap();
    let remaining: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM scan_manifest WHERE state=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 0);
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "valid"
    );
}
#[test]
fn fresh_explicit_job_cleans_only_unpublished_abandoned_staging() {
    let (dir, store, checkpoint, _) = fixture(1);
    let first = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    let mut second = checkpoint.clone();
    second["jobId"] = json!("job-b");
    let next = store
        .begin_scan_candidate_manifest(&begin_request(&second), || Ok(()))
        .unwrap();
    assert_eq!(next.job_id, "job-b");
    assert_ne!(next.manifest_id, first.manifest_id);
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "absent"
    );
    let c = Connection::open(dir.path().join("genx.sqlite3")).unwrap();
    let rows: i64 = c
        .query_row("SELECT COUNT(*) FROM scan_manifest", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1);
}
#[test]
fn unknown_operational_version_refuses_without_interpreting_or_repairing_manifest() {
    let (dir, store, checkpoint, entries) = fixture(1);
    let header = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    let header = append(&store, &header, &entries);
    store
        .seal_scan_candidate_manifest(&seal_request(&header), || Ok(()))
        .unwrap();
    let before = store.read_scan_checkpoint().unwrap().checkpoint;
    let c = Connection::open(dir.path().join("genx.sqlite3")).unwrap();
    c.execute_batch(
        "PRAGMA ignore_check_constraints=ON;UPDATE scan_manifest_namespace SET schema_version=2",
    )
    .unwrap();
    let error = store
        .read_scan_candidate_manifest_page(&read_request(&header, 0), || Ok(()))
        .err()
        .unwrap();
    assert_eq!(error, "scan-manifest-version-unsupported");
    assert_eq!(store.read_scan_checkpoint().unwrap().checkpoint, before);
    let version: i64 = c
        .query_row(
            "SELECT schema_version FROM scan_manifest_namespace",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(version, 2);
}
#[test]
fn persisted_reviewed_providers_and_region_support_full_manifest_lifecycle() {
    let (dir, store, mut checkpoint, entries) = fixture(3);
    let pair = store.read_pair().unwrap();
    let mut prefs: Value = serde_json::from_str(pair.preferences.as_ref().unwrap()).unwrap();
    prefs["reviewedChannelProviders"] = json!([{"id":"reviewed-public","name":"Reviewed public","location":"https://example.com/public.m3u","provenance":"https://example.com/research","allowHttp":false}]);
    prefs["preferredRegion"] =
        json!({"country":"US","state":"US-IL","postal":"00501","origin":"manual"});
    store
        .write_record_guarded("preferences", &prefs.to_string(), Some("1"), || Ok(()))
        .unwrap();
    checkpoint["preferredRegion"] = prefs["preferredRegion"].clone();
    checkpoint["policyFingerprint"] =
        json!(scan_checkpoint::policy_fingerprint(&checkpoint, &prefs).unwrap());
    let before = store.read_pair().unwrap();
    let header = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    let header = append(&store, &header, &entries);
    let receipt = store
        .seal_scan_candidate_manifest(&seal_request(&header), || Ok(()))
        .unwrap();
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("1"));
    drop(store);
    let store = PairStore::new(dir.path().to_owned()).unwrap();
    let found = store
        .find_scan_candidate_manifest(
            &Find {
                job_id: header.job_id.clone(),
                review_digest: header.review_digest.clone(),
                expected_catalog_revision: "1".into(),
                expected_checkpoint_revision: "1".into(),
            },
            || Ok(()),
        )
        .unwrap();
    assert_eq!(found.status, "sealed");
    let request = read_request(&header, 0);
    let page = store
        .read_scan_candidate_manifest_page(&request, || Ok(()))
        .unwrap();
    let plain = page.ciphertext.iter().map(|b| b ^ 0xa5).collect();
    let output = store
        .finish_scan_candidate_manifest_page(&request, page, plain, || Ok(()))
        .unwrap();
    assert_eq!(output.entries[0].urls, entries[0].urls);
    assert_eq!(store.read_pair().unwrap(), before);
}

#[test]
fn encrypted_original_stream_paths_and_fragments_roundtrip_without_plaintext_policy_change() {
    let urls = [
        "https://stream.fixture.invalid/live/channel-private/index.m3u8",
        "https://stream.fixture.invalid/MOVIE/channel-private/index.ts#fragment-private",
        "https://stream.fixture.invalid/%73eries/channel-private/index.ts",
        "https://stream.fixture.invalid/live/channel-private/%69ndex.m3u8?public=1#exact%20fragment-private",
        "https://stream.fixture.invalid/get.php?stream=channel-private#fragment-private",
        "https://stream.fixture.invalid/player_api.php?stream=channel-private",
        "http://stream.fixture.invalid/live/channel-private/index.ts#fragment-private",
    ];
    let (dir, store, mut original, mut entries) = original_fixture(urls.len());
    for (index, url) in urls.iter().enumerate() {
        entries[index].urls = vec![(*url).to_owned()];
        original["review"]["candidates"][index]["channel"]["urls"] = json!(entries[index].urls);
    }
    let before = store.read_pair().unwrap();
    let catalog: Value = serde_json::from_str(before.catalog.as_ref().unwrap()).unwrap();
    let prefs: Value = serde_json::from_str(before.preferences.as_ref().unwrap()).unwrap();
    // The legacy plaintext checkpoint still rejects these same path heuristics.
    assert_eq!(
        scan_checkpoint::validate(&original.to_string(), &prefs, &catalog, 1, now()).unwrap_err(),
        "scan-checkpoint-source-not-resumable"
    );
    let checkpoint = scan_checkpoint::packed_fixture(&original);
    let header = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    let prepared = store
        .prepare_scan_candidate_manifest_page(
            Append {
                manifest_id: header.manifest_id.clone(),
                expected_manifest_revision: "0".into(),
                expected_catalog_revision: "1".into(),
                expected_checkpoint_revision: "0".into(),
                entries: entries.clone(),
            },
            || Ok(()),
        )
        .unwrap();
    #[cfg(windows)]
    let ciphertext =
        crate::windows_manifest_protector::seal(&prepared.binding, &prepared.plaintext).unwrap();
    #[cfg(not(windows))]
    let ciphertext: Vec<u8> = prepared.plaintext.iter().map(|byte| byte ^ 0xa5).collect();
    let header = store
        .append_scan_candidate_manifest_page(&prepared, &ciphertext, || Ok(()))
        .unwrap();
    drop(prepared);
    let receipt = store
        .seal_scan_candidate_manifest(&seal_request(&header), || Ok(()))
        .unwrap();
    assert!(receipt.committed);
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("1"));
    assert_eq!(store.read_pair().unwrap(), before);
    let persisted = store.read_scan_checkpoint().unwrap().checkpoint.unwrap();
    assert!(!persisted.contains("channel-private") && !persisted.contains("fragment-private"));
    drop(store);
    let store = PairStore::new(dir.path().to_owned()).unwrap();
    let request = read_request(&header, 0);
    let encrypted = store
        .read_scan_candidate_manifest_page(&request, || Ok(()))
        .unwrap();
    #[cfg(windows)]
    let plaintext =
        crate::windows_manifest_protector::open(&encrypted.binding, &encrypted.ciphertext).unwrap();
    #[cfg(not(windows))]
    let plaintext = encrypted
        .ciphertext
        .iter()
        .map(|byte| byte ^ 0xa5)
        .collect();
    let recovered = store
        .finish_scan_candidate_manifest_page(&request, encrypted, plaintext, || Ok(()))
        .unwrap();
    assert_eq!(recovered.entries.len(), entries.len());
    for (actual, expected) in recovered.entries.iter().zip(&entries) {
        assert_eq!(actual.candidate_index, expected.candidate_index);
        assert_eq!(actual.urls, expected.urls);
    }
    // Storing a pending HTTP destination does not create an HTTP grant.
    let canonical: Value =
        serde_json::from_str(store.read_pair().unwrap().catalog.as_ref().unwrap()).unwrap();
    assert_ne!(canonical["sources"][0]["allowHttp"], true);
    let connection = Connection::open(dir.path().join("genx.sqlite3")).unwrap();
    let cipher: Vec<u8> = connection
        .query_row("SELECT ciphertext FROM scan_manifest_page", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(!String::from_utf8_lossy(&cipher).contains("channel-private"));
    assert!(!String::from_utf8_lossy(&cipher).contains("fragment-private"));
}

#[test]
fn encrypted_stream_url_authority_refusals_preserve_staging_and_canonical_records() {
    for url in [
        "https://user:password@stream.fixture.invalid/live/channel/index.m3u8",
        "https://user@stream.fixture.invalid/live/channel/index.m3u8",
        "file:///live/channel/index.m3u8",
        "data:text/plain,channel",
        "https://stream.fixture.invalid/live/channel/index.m3u8\n",
    ] {
        let (dir, store, mut original, mut entries) = original_fixture(1);
        entries[0].urls = vec![url.to_owned()];
        original["review"]["candidates"][0]["channel"]["urls"] = json!(entries[0].urls);
        let checkpoint = scan_checkpoint::packed_fixture(&original);
        let before = store.read_pair().unwrap();
        let header = store
            .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
            .unwrap();
        let request = Append {
            manifest_id: header.manifest_id.clone(),
            expected_manifest_revision: "0".into(),
            expected_catalog_revision: "1".into(),
            expected_checkpoint_revision: "0".into(),
            entries,
        };
        assert!(store
            .prepare_scan_candidate_manifest_page(request, || Ok(()))
            .is_err());
        assert_eq!(store.read_pair().unwrap(), before);
        assert_eq!(
            store.read_scan_checkpoint().unwrap().checkpoint_status,
            "absent"
        );
        let connection = Connection::open(dir.path().join("genx.sqlite3")).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM scan_manifest_page", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn encrypted_stream_path_changes_and_fragment_changes_remain_exact_hash_bound() {
    let (_dir, store, mut original, mut entries) = original_fixture(1);
    entries[0].urls =
        vec!["https://stream.fixture.invalid/live/channel/index.m3u8#original".into()];
    original["review"]["candidates"][0]["channel"]["urls"] = json!(entries[0].urls);
    let checkpoint = scan_checkpoint::packed_fixture(&original);
    let header = store
        .begin_scan_candidate_manifest(&begin_request(&checkpoint), || Ok(()))
        .unwrap();
    for changed in [
        "https://stream.fixture.invalid/live/channel/index.m3u8#changed",
        "https://stream.fixture.invalid/live/other/index.m3u8#original",
    ] {
        let request = Append {
            manifest_id: header.manifest_id.clone(),
            expected_manifest_revision: "0".into(),
            expected_catalog_revision: "1".into(),
            expected_checkpoint_revision: "0".into(),
            entries: vec![Entry {
                candidate_index: 0,
                urls: vec![changed.into()],
            }],
        };
        assert_eq!(
            store
                .prepare_scan_candidate_manifest_page(request, || Ok(()))
                .err()
                .unwrap(),
            "scan-manifest-url-mismatch"
        );
    }
    let header = append(&store, &header, &entries);
    assert!(
        store
            .seal_scan_candidate_manifest(&seal_request(&header), || Ok(()))
            .unwrap()
            .committed
    );
    let request = read_request(&header, 0);
    let encrypted = store
        .read_scan_candidate_manifest_page(&request, || Ok(()))
        .unwrap();
    let mut plaintext: Vec<u8> = encrypted
        .ciphertext
        .iter()
        .map(|byte| byte ^ 0xa5)
        .collect();
    plaintext[0] ^= 1;
    assert_eq!(
        store
            .finish_scan_candidate_manifest_page(&request, encrypted, plaintext, || Ok(()))
            .err()
            .unwrap(),
        "scan-manifest-authentication-failed"
    );
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "1"
    );
}

#[test]
fn plaintext_source_descriptor_credential_and_fragment_restrictions_remain_unchanged() {
    for location in [
        "https://source.fixture.invalid/live/channel/index.m3u8",
        "https://source.fixture.invalid/%6cive/channel/index.m3u8",
        "https://source.fixture.invalid/get.php?username=fixture",
        "https://source.fixture.invalid/player_api.php",
        "https://source.fixture.invalid/public.m3u#fragment",
    ] {
        let (_dir, store, mut original, _) = original_fixture(1);
        let before = store.read_pair().unwrap();
        let mut catalog: Value = serde_json::from_str(before.catalog.as_ref().unwrap()).unwrap();
        let mut prefs: Value = serde_json::from_str(before.preferences.as_ref().unwrap()).unwrap();
        original["sourceDefinitions"][0]["source"]["location"] = json!(location);
        let source = original["sourceDefinitions"][0]["source"].clone();
        original["sourceDefinitions"][0]["definitionFingerprint"] =
            json!(scan_checkpoint::source_fingerprint(&source).unwrap());
        catalog["sources"][0] = source.clone();
        prefs["sources"][0] = source;
        original["policyFingerprint"] =
            json!(scan_checkpoint::policy_fingerprint(&original, &prefs).unwrap());
        assert_eq!(
            scan_checkpoint::validate(&original.to_string(), &prefs, &catalog, 1, now())
                .unwrap_err(),
            "scan-checkpoint-source-not-resumable"
        );
        let packed = scan_checkpoint::packed_fixture(&original);
        assert_eq!(
            scan_checkpoint::validate(&packed.to_string(), &prefs, &catalog, 1, now()).unwrap_err(),
            "scan-checkpoint-source-not-resumable"
        );
        assert_eq!(store.read_pair().unwrap(), before);
        assert_eq!(
            store.read_scan_checkpoint().unwrap().checkpoint_status,
            "absent"
        );
    }
}
