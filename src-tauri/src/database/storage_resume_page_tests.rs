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

//! Real indexed SQLite lookup and authenticated page results. XOR is not OS crypto.
use super::*;
use crate::scan_candidate_manifest::{Append, Begin, Seal};
struct Fixture {
    store: PairStore,
    dir: tempfile::TempDir,
    job: String,
    digest: String,
    fence: Fence,
}
fn xor(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().map(|b| b ^ 0xa5).collect()
}
fn fixture(count: usize, category: &str) -> Fixture {
    let (packed, prefs, catalog, metadata, entries, _, _) =
        crate::scan_checkpoint::resume_plan::tests::fixture(count);
    let mut raw = packed;
    raw["schemaVersion"] = json!(1);
    raw["createdAtMs"] = json!(scan_now());
    for key in ["reviewDigest", "categoryTable", "publishedIndices"] {
        raw.as_object_mut().unwrap().remove(key);
    }
    raw["publishedKeys"] = json!([]);
    raw["review"]["candidates"] = json!(metadata
        .iter()
        .zip(&entries)
        .map(|(metadata, entry)| {
            let mut candidate = metadata.clone();
            candidate.as_object_mut().unwrap().remove("reference");
            candidate["channel"]["category"] = json!(category);
            candidate["channel"]["urls"] = json!(entry.urls);
            candidate
        })
        .collect::<Vec<_>>());
    let checkpoint = crate::scan_checkpoint::packed_fixture(&raw);
    let dir = tempfile::tempdir().unwrap();
    let store = PairStore::new(dir.path().to_owned()).unwrap();
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    let mut header = store
        .begin_scan_candidate_manifest(
            &Begin {
                schema_version: 1,
                checkpoint: checkpoint.to_string(),
                expected_catalog_revision: "1".into(),
                expected_checkpoint_revision: "0".into(),
            },
            || Ok(()),
        )
        .unwrap();
    for entries in entries.chunks(64) {
        let page = store
            .prepare_scan_candidate_manifest_page(
                Append {
                    manifest_id: header.manifest_id.clone(),
                    expected_manifest_revision: header.manifest_revision.clone(),
                    expected_catalog_revision: "1".into(),
                    expected_checkpoint_revision: "0".into(),
                    entries: entries.to_vec(),
                },
                || Ok(()),
            )
            .unwrap();
        header = store
            .append_scan_candidate_manifest_page(&page, &xor(&page.plaintext), || Ok(()))
            .unwrap();
    }
    let seal = Seal {
        manifest_id: header.manifest_id.clone(),
        expected_manifest_revision: header.manifest_revision.clone(),
        expected_catalog_revision: "1".into(),
        expected_checkpoint_revision: "0".into(),
    };
    let proof = store
        .prepare_scan_candidate_manifest_seal(&seal, || Ok(()))
        .unwrap();
    store
        .seal_protected_scan_candidate_manifest(&seal, &proof, &xor(&proof.plaintext), || Ok(()))
        .unwrap();
    Fixture {
        store,
        dir,
        job: header.job_id,
        digest: header.review_digest,
        fence: Fence {
            root_generation: 7,
            catalog: 1,
            health: 0,
            checkpoint: 1,
        },
    }
}
fn prepare(f: &Fixture, index: usize) -> Result<PreparedResumePage, String> {
    f.store
        .prepare_scan_resume_page(f.fence, &f.job, &f.digest, index, || Ok(()))
}
#[test]
fn original_subcursor_uses_containing_indexed_page_without_omitting_suffix() {
    let f = fixture(130, &"x".repeat(16_384));
    let before = f.store.read_pair().unwrap();
    for (index, start, end) in [
        (0, 0, 64),
        (63, 0, 64),
        (64, 64, 128),
        (127, 64, 128),
        (129, 128, 130),
    ] {
        let proof = prepare(&f, index).unwrap();
        assert_eq!(proof.start_index, start);
        assert_eq!(proof.requested_index, index);
        let plaintext = xor(&proof.encrypted_page.ciphertext);
        let page = f
            .store
            .finish_scan_resume_page(proof, plaintext, || Ok(()))
            .unwrap();
        assert_eq!((page.page.start_index, page.page.next_index), (start, end));
        assert_eq!(page.page.entries.len(), end - start);
        assert_eq!(page.metadata.len(), end - start);
        assert_eq!(page.page.entries[index - start].candidate_index, index);
        assert_eq!(
            page.metadata[index - start]["channel"]["category"]
                .as_str()
                .unwrap()
                .len(),
            16_384
        );
    }
    assert!(prepare(&f, 130).is_err());
    assert_eq!(f.store.read_pair().unwrap(), before);
}
#[test]
fn all_three_sql_fences_and_current_source_grant_are_rechecked_after_crypto() {
    for column in ["catalog_revision", "health_revision"] {
        let f = fixture(65, "News");
        let proof = prepare(&f, 63).unwrap();
        let plaintext = xor(&proof.encrypted_page.ciphertext);
        let c = Connection::open(f.dir.path().join(DB)).unwrap();
        c.execute(&format!("UPDATE metadata SET {column}={column}+1"), [])
            .unwrap();
        assert!(
            matches!(f.store.finish_scan_resume_page(proof,plaintext,||Ok(())),Err(e) if e=="scan-resume-plan-stale")
        );
    }
    let f = fixture(65, "News");
    let proof = prepare(&f, 64).unwrap();
    let plaintext = xor(&proof.encrypted_page.ciphertext);
    let c = Connection::open(f.dir.path().join(DB)).unwrap();
    c.execute("UPDATE scan_checkpoint SET revision=revision+1", [])
        .unwrap();
    assert!(
        matches!(f.store.finish_scan_resume_page(proof,plaintext,||Ok(())),Err(e) if e=="scan-resume-plan-stale")
    );
    c.execute("UPDATE scan_checkpoint SET revision=revision-1", [])
        .unwrap();
    let proof = prepare(&f, 64).unwrap();
    let plaintext = xor(&proof.encrypted_page.ciphertext);
    c.execute("UPDATE source SET allow_http=1", []).unwrap();
    assert!(f
        .store
        .finish_scan_resume_page(proof, plaintext, || Ok(()))
        .is_err());
}
#[test]
fn swapped_plaintext_wrong_identity_and_cancel_refuse_without_progress_write() {
    let f = fixture(130, "News");
    let before = f.store.read_scan_checkpoint().unwrap().checkpoint.unwrap();
    let a = prepare(&f, 63).unwrap();
    let b = prepare(&f, 64).unwrap();
    let plaintext = xor(&b.encrypted_page.ciphertext);
    assert!(
        matches!(f.store.finish_scan_resume_page(a,plaintext,||Ok(())),Err(e) if e=="scan-manifest-authentication-failed")
    );
    assert!(f
        .store
        .prepare_scan_resume_page(f.fence, "different", &f.digest, 0, || Ok(()))
        .is_err());
    let proof = prepare(&f, 64).unwrap();
    let plaintext = xor(&proof.encrypted_page.ciphertext);
    assert!(
        matches!(f.store.finish_scan_resume_page(proof,plaintext,||Err("controlled-cancel".into())),Err(e) if e=="controlled-cancel")
    );
    assert_eq!(
        f.store
            .read_scan_checkpoint()
            .unwrap()
            .checkpoint
            .as_deref(),
        Some(before.as_str())
    );
}

fn cached(f: &Fixture) -> CachedResumePage {
    let proof = prepare(f, 0).unwrap();
    let plaintext = xor(&proof.encrypted_page.ciphertext);
    f.store
        .finish_cached_scan_resume_page(proof, plaintext, || Ok(()))
        .unwrap()
}
#[test]
fn cached_page_rechecks_all_bytes_and_authority_in_fresh_snapshot_without_progress_writes() {
    for mutation in [
        "ciphertext",
        "binding",
        "plain_hash",
        "metadata",
        "category",
        "namespace",
        "manifest_revision",
        "authority",
        "catalog_revision",
        "health_revision",
        "checkpoint_revision",
        "source_grant",
        "source_removed",
        "job",
    ] {
        let f = fixture(65, "News");
        let before = f.store.read_scan_checkpoint().unwrap().checkpoint.unwrap();
        let page = cached(&f);
        let c = Connection::open(f.dir.path().join(DB)).unwrap();
        match mutation {
            "ciphertext" => {
                c.execute(
                    "UPDATE scan_manifest_page SET ciphertext=zeroblob(length(ciphertext)) WHERE start_index=0",
                    [],
                )
                .unwrap();
            }
            "binding" => {
                c.execute(
                    "UPDATE scan_manifest_page SET binding=binding||'x' WHERE start_index=0",
                    [],
                )
                .unwrap();
            }
            "plain_hash" => {
                c.execute(
                    "UPDATE scan_manifest_page SET plain_hash=?1 WHERE start_index=0",
                    ["0".repeat(64)],
                )
                .unwrap();
            }
            "metadata" => {
                let raw: String = c
                    .query_row(
                        "SELECT metadata FROM scan_manifest_candidate WHERE ordinal=1",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                let mut raw: Value = serde_json::from_str(&raw).unwrap();
                raw[3] = json!("Changed station");
                c.execute(
                    "UPDATE scan_manifest_candidate SET metadata=?1 WHERE ordinal=1",
                    [raw.to_string()],
                )
                .unwrap();
            }
            "category" => {
                c.execute(
                    "UPDATE scan_manifest_category SET contents='Changed category'",
                    [],
                )
                .unwrap();
            }
            "namespace" => {
                c.execute("UPDATE scan_manifest_namespace SET namespace='changed'", [])
                    .unwrap();
            }
            "manifest_revision" => {
                c.execute("UPDATE scan_manifest SET revision=revision+1", [])
                    .unwrap();
            }
            "authority" => {
                let raw: String = c
                    .query_row("SELECT authority FROM scan_manifest", [], |r| r.get(0))
                    .unwrap();
                let mut raw: Value = serde_json::from_str(&raw).unwrap();
                raw["query"] = json!("changed");
                c.execute("UPDATE scan_manifest SET authority=?1", [raw.to_string()])
                    .unwrap();
            }
            "catalog_revision" => {
                c.execute(
                    "UPDATE metadata SET catalog_revision=catalog_revision+1",
                    [],
                )
                .unwrap();
            }
            "health_revision" => {
                c.execute("UPDATE metadata SET health_revision=health_revision+1", [])
                    .unwrap();
            }
            "checkpoint_revision" => {
                c.execute("UPDATE scan_checkpoint SET revision=revision+1", [])
                    .unwrap();
            }
            "source_grant" => {
                c.execute("UPDATE source SET allow_http=1", []).unwrap();
            }
            "source_removed" => {
                c.execute("DELETE FROM source", []).unwrap();
            }
            "job" => {
                c.execute("UPDATE scan_checkpoint SET job_id='different'", [])
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            f.store
                .verify_cached_scan_resume_page(&page, f.fence, &f.job, &f.digest, 1, || Ok(()))
                .is_err(),
            "accepted mutation {mutation}"
        );
        let after: String = c
            .query_row("SELECT contents FROM scan_checkpoint", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            after, before,
            "cache verification changed checkpoint contents"
        );
    }
}
#[test]
fn cache_hit_refuses_wrong_generation_identity_index_cancel_and_expired_authority() {
    let f = fixture(65, "News");
    let page = cached(&f);
    let mut wrong = f.fence;
    wrong.root_generation += 1;
    for (fence, job, digest, index) in [
        (wrong, f.job.as_str(), f.digest.as_str(), 1),
        (f.fence, "wrong", f.digest.as_str(), 1),
        (f.fence, f.job.as_str(), "wrong", 1),
        (f.fence, f.job.as_str(), f.digest.as_str(), 64),
    ] {
        assert!(f
            .store
            .verify_cached_scan_resume_page(&page, fence, job, digest, index, || Ok(()))
            .is_err());
    }
    assert_eq!(
        f.store
            .verify_cached_scan_resume_page(&page, f.fence, &f.job, &f.digest, 1, || Err(
                "canceled".into()
            ))
            .err()
            .unwrap(),
        "canceled"
    );
    // Exact same bytes and proof, but a future current clock must expire the authority.
    let mut c = connect(&f.dir.path().join(DB), true).unwrap();
    let tx = c.transaction().unwrap();
    let error = PairStore::manifest_context(&tx, |context| {
        let expired = manifest::Context {
            now: context.now + 8 * 24 * 60 * 60 * 1000,
            ..*context
        };
        manifest::verify_cached_read(&tx, &page.request, &expired, &page.image, || Ok(()))
    })
    .err()
    .unwrap();
    assert_eq!(error, "scan-checkpoint-expired");
}
#[test]
fn cached_finish_rechecks_image_after_crypto_and_cannot_adopt_tampered_metadata() {
    let f = fixture(65, "News");
    let proof = prepare(&f, 0).unwrap();
    let plaintext = xor(&proof.encrypted_page.ciphertext);
    let c = Connection::open(f.dir.path().join(DB)).unwrap();
    c.execute("UPDATE scan_manifest_category SET contents='changed'", [])
        .unwrap();
    assert!(f
        .store
        .finish_cached_scan_resume_page(proof, plaintext, || Ok(()))
        .is_err());
}

#[test]
fn cached_hit_reselects_containing_page_and_refuses_overlapping_unversioned_row() {
    let f = fixture(65, "News");
    let page = cached(&f);
    let before = f.store.read_scan_checkpoint().unwrap().checkpoint.unwrap();
    let c = Connection::open(f.dir.path().join(DB)).unwrap();
    c.execute("INSERT INTO scan_manifest_page(manifest_id,start_index,item_count,binding,plain_hash,ciphertext) SELECT manifest_id,1,1,binding,plain_hash,ciphertext FROM scan_manifest_page WHERE start_index=0",[]).unwrap();
    assert_eq!(
        f.store
            .verify_cached_scan_resume_page(&page, f.fence, &f.job, &f.digest, 1, || Ok(()))
            .err()
            .unwrap(),
        "scan-manifest-page-absent"
    );
    let after: String = c
        .query_row("SELECT contents FROM scan_checkpoint", [], |r| r.get(0))
        .unwrap();
    assert_eq!(after, before);
    // The immutable old page is still usable where it remains the selected page.
    assert_eq!(
        f.store
            .verify_cached_scan_resume_page(&page, f.fence, &f.job, &f.digest, 0, || Ok(()))
            .unwrap()
            .page
            .entries[0]
            .candidate_index,
        0
    );
}
/// TV, October 17, 2026: a long automatic guide commit held the database for
/// more than the 2 s busy timeout and the scan's background page read failed
/// with sqlite-operation-failed, stopping the whole scan. Scan reads must wait
/// out another writer's commit.
#[test]
fn page_read_waits_out_another_writers_long_commit() {
    let f = fixture(10, "News");
    let writer = connect(&f.store.root.join(DB), false).unwrap();
    writer.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(6));
        writer.execute_batch("COMMIT").unwrap();
    });
    let started = std::time::Instant::now();
    let result = prepare(&f, 0);
    release.join().unwrap();
    assert!(result.is_ok(), "{:?}", result.err());
    assert!(started.elapsed() >= std::time::Duration::from_secs(6));
}
#[test]
fn a_lock_held_past_the_timeout_is_reported_as_busy() {
    let f = fixture(1, "News");
    let writer = connect(&f.store.root.join(DB), false).unwrap();
    writer.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let reader = connect(&f.store.root.join(DB), true).unwrap();
    reader.busy_timeout(std::time::Duration::ZERO).unwrap();
    let error = reader
        .query_row("SELECT count(*) FROM sqlite_schema", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap_err();
    assert_eq!(
        sql_error_code(&error, "sqlite-operation-failed"),
        "sqlite-busy"
    );
    writer.execute_batch("COMMIT").unwrap();
}
