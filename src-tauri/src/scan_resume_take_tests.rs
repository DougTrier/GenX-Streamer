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

//! Actual SQLite page acquisition; XOR stands in for joined platform crypto only.
use super::*;
use crate::{
    scan_candidate_manifest::{Append, Begin, Seal},
    storage_transaction::PairStore,
};
use std::sync::atomic::{AtomicBool, Ordering};
fn xor(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().map(|b| b ^ 0xa5).collect()
}
fn fixture() -> (Arc<Registry<Episode>>, Arc<PairStore>, tempfile::TempDir) {
    fixture_count(32)
}
fn fixture_count(total: usize) -> (Arc<Registry<Episode>>, Arc<PairStore>, tempfile::TempDir) {
    fixture_shape(total, false)
}
fn fixture_shape(
    total: usize,
    same_origin: bool,
) -> (Arc<Registry<Episode>>, Arc<PairStore>, tempfile::TempDir) {
    let (packed, prefs, catalog, metadata, entries, _, _) =
        crate::scan_checkpoint::resume_plan::tests::fixture(total);
    let mut raw = packed;
    raw["schemaVersion"] = json!(1);
    raw["createdAtMs"] = json!(now());
    for key in ["reviewDigest", "categoryTable", "publishedIndices"] {
        raw.as_object_mut().unwrap().remove(key);
    }
    raw["publishedKeys"] = json!([]);
    let entries: Vec<_> = entries
        .into_iter()
        .map(|mut entry| {
            entry.urls = vec![if same_origin {
                format!("https://one-origin.example/{0}.ts", entry.candidate_index)
            } else {
                format!("https://origin-{}.example/live.ts", entry.candidate_index)
            }];
            entry
        })
        .collect();
    raw["review"]["candidates"] = json!(metadata
        .iter()
        .zip(&entries)
        .map(|(m, e)| {
            let mut m = m.clone();
            m.as_object_mut().unwrap().remove("reference");
            m["channel"]["urls"] = json!(e.urls);
            m
        })
        .collect::<Vec<_>>());
    let raw = crate::scan_checkpoint::packed_fixture(&raw);
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(PairStore::new(dir.path().to_owned()).unwrap());
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    let mut header = store
        .begin_scan_candidate_manifest(
            &Begin {
                schema_version: 1,
                checkpoint: raw.to_string(),
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
        manifest_id: header.manifest_id,
        expected_manifest_revision: header.manifest_revision,
        expected_catalog_revision: "1".into(),
        expected_checkpoint_revision: "0".into(),
    };
    let proof = store
        .prepare_scan_candidate_manifest_seal(&seal, || Ok(()))
        .unwrap();
    store
        .seal_protected_scan_candidate_manifest(&seal, &proof, &xor(&proof.plaintext), || Ok(()))
        .unwrap();
    let proof = store
        .prepare_scan_resume_admission("1", "1", 7, "android", "fixture", || Ok(()))
        .unwrap();
    let plaintext = xor(&proof.encrypted_capsule.ciphertext);
    let admitted = store
        .finish_scan_resume_admission(proof, plaintext, || Ok(()))
        .unwrap();
    let registry = Arc::new(Registry::default());
    registry
        .begin("fixture-opening")
        .unwrap()
        .install(
            if same_origin {
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            } else {
                "fixture-plan"
            },
            Episode::admitted(admitted.plan, admitted.directory).unwrap(),
        )
        .unwrap();
    (registry, store, dir)
}
fn request() -> Take {
    Take {
        schema_version: 1,
        plan_id: "fixture-plan".into(),
        limit: 16,
        blocked_origins: vec![],
        take_timing_version: None,
    }
}
async fn hydrate(
    store: Arc<PairStore>,
    fence: Fence,
    job: String,
    digest: String,
    index: usize,
) -> Result<AuthenticatedPage, String> {
    let proof = store.prepare_scan_resume_page(fence, &job, &digest, index, || Ok(()))?;
    let plaintext = xor(&proof.encrypted_page.ciphertext);
    store.finish_scan_resume_page(proof, plaintext, || Ok(()))
}

// Real encrypted-page admission and real SQLite publication; transport evidence
// is an explicit controlled held receipt, not a claim of network inspection.
async fn first_ack_with_cooling(
    retry_after: u64,
    version: u8,
) -> (
    Arc<Registry<Episode>>,
    Arc<PairStore>,
    tempfile::TempDir,
    Take,
    u64,
) {
    first_ack_with_cooling_count(retry_after, version, 2).await
}
async fn first_ack_with_cooling_count(
    retry_after: u64,
    version: u8,
    total: usize,
) -> (
    Arc<Registry<Episode>>,
    Arc<PairStore>,
    tempfile::TempDir,
    Take,
    u64,
) {
    use crate::scan_resume_commit_owner::{commit_for_test, Commit, Observation, Revisions};
    let (registry, store, dir) = fixture_shape(total, true);
    let mut next = request();
    next.schema_version = version;
    next.limit = 1;
    next.plan_id = "a".repeat(64);
    let storage = store.clone();
    let first = take_with(
        next.clone_for_test(),
        registry.acquire(&next.plan_id).unwrap(),
        move |f, j, d, i| hydrate(storage.clone(), f, j, d, i),
        || Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(first.rows[0].row.candidate_index, 0);
    let lease = registry.acquire(&next.plan_id).unwrap();
    let observed_at = now();
    let (observation, fence) = lease.with(|episode| {
        let held = &episode.cache[&0];
        let id = held.reservation.id.clone();
        let observation = json!({"channelId":held.metadata["key"],"sourceId":held.metadata["sourceId"],"fingerprint":held.metadata["sourceFingerprint"],"platform":"android","observedAt":observed_at,"verdict":"Reachable","evidence":{"kind":"recognized-media-response"}});
        episode.scheduler.start_probe(&id)?;
        episode.scheduler.finish_probe(&id,observed_at,retry_after)?;
        episode.cache.get_mut(&0).unwrap().observation=Some(observation.clone());
        // This fixture accounts for the held echo exactly as the native probe does.
        let bytes=serde_json::to_vec(&observation).unwrap().len();
        episode.cache.get_mut(&0).unwrap().bytes+=bytes;
        episode.cache_bytes+=bytes;
        Ok((observation,episode.plan.fence()))
    }).unwrap();
    let ack = commit_for_test(
        &lease,
        &Commit {
            schema_version: version,
            plan_id: next.plan_id.clone(),
            expected_revisions: Revisions {
                catalog_revision: fence.catalog.to_string(),
                health_revision: fence.health.to_string(),
                checkpoint_revision: fence.checkpoint.to_string(),
            },
            observations: vec![Observation {
                candidate_index: 0,
                observation,
            }],
            publication_indices: vec![0],
        },
        &store,
    )
    .unwrap();
    assert_eq!(
        ack["counts"],
        json!({"total":total,"checked":1,"responded":1,"published":1})
    );
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "2"
    );
    lease
        .with(|e| {
            assert!(e.cache.is_empty());
            assert_eq!(e.plan.counts().checked, 1);
            Ok(())
        })
        .unwrap();
    drop(lease);
    (registry, store, dir, next, observed_at)
}

impl Take {
    fn clone_for_test(&self) -> Self {
        Self {
            schema_version: self.schema_version,
            plan_id: self.plan_id.clone(),
            limit: self.limit,
            blocked_origins: self.blocked_origins.clone(),
            take_timing_version: self.take_timing_version,
        }
    }
}

// This module's parts, by area, are in scan_resume_take/tests/.
#[path = "scan_resume_take/tests/cached.rs"]
mod cached;
#[path = "scan_resume_take/tests/cooling.rs"]
mod cooling;
#[path = "scan_resume_take/tests/negotiation.rs"]
mod negotiation;
#[path = "scan_resume_take/tests/pages_and_crypto.rs"]
mod pages_and_crypto;
