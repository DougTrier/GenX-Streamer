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
use crate::scan_batch::{Batch, Patch};

pub(super) fn fixture() -> (tempfile::TempDir, PairStore, Value, Value) {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let source = json!({"id":"public","name":"Fixture","kind":"url","location":"https://example.invalid/catalog.m3u","allowHttp":false,"contentKind":"catalog","mediaMime":"audio/x-mpegurl"});
    let catalog = json!({"schemaVersion":1,"sources":[source],"channels":[{"id":"old","sourceId":"public","name":"Original","category":"Sports","urls":["https://example.invalid/old.m3u8"]}]});
    let prefs = json!({"schemaVersion":1,"sources":catalog["sources"],"favorites":["old","missing"],"removedChannels":["missing"],"volume":0.5,"muted":false,"panelWidth":350,"automaticGuideUpdates":false,"reviewedChannelProviders":[],"reviewedGuideProviders":[],"preferredRegion":{"country":"US","state":"US-IL","postal":"00501","origin":"manual"},"channelCategoryOverrides":[{"channelId":"old","category":"Local"}]});
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    (root, store, catalog, prefs)
}

pub(super) fn batch(catalog: &Value, prefs: &Value, checkpoint: bool) -> Batch {
    let channel = json!({"id":"new","sourceId":"public","providerId":"new-provider","name":"New station","category":"News","urls":["https://example.invalid/new.m3u8"],"geography":{"country":"US","state":"US-IL"}});
    let now = scan_now();
    let incoming = json!({"schemaVersion":1,"channelId":"new","sourceId":"public","checkedUrlOrdinal":0,"targetFingerprint":crate::health_storage::fingerprint(&catalog["sources"][0],&channel,0).unwrap(),"platform":"windows","observerProfile":"fixture","observedAt":now,"verdict":"Reachable","origin":"local","evidence":{"kind":"recognized-media-response"}});
    let mutation = if checkpoint {
        let mut candidate = channel.clone();
        candidate.as_object_mut().unwrap().remove("id");
        let mut value = json!({"schemaVersion":1,"jobId":"pair-reuse-job","createdAtMs":now,"catalogRevision":"1","policyFingerprint":"","sourceDefinitions":[{"source":catalog["sources"][0],"definitionFingerprint":crate::scan_checkpoint::source_fingerprint(&catalog["sources"][0]).unwrap()}],"budgetMs":20000,"platform":"windows","observerProfile":"fixture","review":{"sessionRevision":"session","query":"","status":"completed","sources":[{"sourceId":"public","fingerprint":"scope","status":"completed","inspected":1,"matched":1,"warnings":0}],"candidates":[{"key":"key-new","sourceId":"public","sourceFingerprint":"scope","sessionRevision":"session","channel":candidate}],"counts":{"inspected":1,"matched":1,"failedSources":0,"canceledSources":0}},"observations":[{"channelId":"key-new","sourceId":"public","fingerprint":"scope","platform":"windows","observedAt":now,"verdict":"Reachable","evidence":{"kind":"recognized-media-response"}}],"publishedKeys":["key-new"]});
        // The checkpoint captures the same effective region as its policy hash;
        // absence is not equivalent to a configured country/state/postal scope.
        if let Some(region) = prefs.get("preferredRegion") {
            value["preferredRegion"] = region.clone();
        }
        value["policyFingerprint"] =
            json!(crate::scan_checkpoint::policy_fingerprint(&value, prefs).unwrap());
        Some(crate::scan_checkpoint::Mutation::Save {
            checkpoint: value.to_string(),
        })
    } else {
        None
    };
    Batch {
        schema_version: 1,
        catalog_patch: Patch {
            schema_version: 1,
            base_source_count: 1,
            base_channel_count: 1,
            final_source_count: 1,
            final_channel_count: 2,
            sources: vec![],
            channels: vec![channel],
        },
        authorized_sources: catalog["sources"].as_array().unwrap().clone(),
        next_preferences: prefs.clone(),
        incoming_health: vec![incoming],
        expected_catalog_revision: "1".into(),
        expected_health_revision: "0".into(),
        expected_checkpoint_revision: mutation.as_ref().map(|_| "0".into()),
        scan_checkpoint: mutation,
    }
}

#[test]
fn compact_checkpoint_batch_captures_before_once_after_once_and_has_one_backup() {
    let (_root, store, catalog, prefs) = fixture();
    let request = batch(&catalog, &prefs, true);
    let mut captures = Vec::new();
    let mut phases = Vec::new();
    let receipt = store
        .commit_scan_batch_observed(
            &request,
            &mut |phase| {
                phases.push(phase);
                Ok(())
            },
            Some(&mut |stage| captures.push(stage)),
        )
        .unwrap();
    assert_eq!(
        captures,
        vec![PairCaptureStage::Before, PairCaptureStage::After]
    );
    assert_eq!(
        phases.iter().filter(|p| **p == Phase::BeforeBackup).count(),
        1
    );
    assert_eq!(
        phases.iter().filter(|p| **p == Phase::AfterBackup).count(),
        1
    );
    assert_eq!(receipt.catalog_revision, "2");
    assert_eq!(receipt.health_revision, "1");
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("1"));
    let checkpoint = store.read_scan_checkpoint().unwrap();
    assert_eq!(checkpoint.checkpoint_status, "valid");
}

#[test]
fn compact_and_full_writes_return_identical_canonical_pair_health_checkpoint_and_receipt() {
    let (_left, compact, catalog, prefs) = fixture();
    let (_right, full, _, _) = fixture();
    let request = batch(&catalog, &prefs, true);
    let mut expanded = catalog.clone();
    expanded["channels"]
        .as_array_mut()
        .unwrap()
        .extend(request.catalog_patch.channels.clone());
    let incoming = json!({"schemaVersion":1,"records":request.incoming_health}).to_string();
    let compact_receipt = compact.commit_scan_batch(&request, || Ok(())).unwrap();
    let full_receipt = full
        .write_pair_with_scan(
            &RecordPair {
                catalog: Some(expanded.to_string()),
                preferences: Some(prefs.to_string()),
            },
            Some(&incoming),
            (Some("1"), Some("0")),
            Some((request.scan_checkpoint.as_ref().unwrap(), "0")),
            || Ok(()),
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(compact_receipt).unwrap(),
        serde_json::to_value(full_receipt).unwrap()
    );
    assert_eq!(
        compact.read_snapshot().unwrap(),
        full.read_snapshot().unwrap()
    );
    assert_eq!(
        serde_json::to_value(compact.read_scan_checkpoint().unwrap()).unwrap(),
        serde_json::to_value(full.read_scan_checkpoint().unwrap()).unwrap()
    );
}

#[test]
fn stale_checkpoint_and_precommit_failure_roll_back_reused_snapshot_writes() {
    let (_root, store, catalog, prefs) = fixture();
    let before = store.read_snapshot().unwrap();
    let checkpoint_before = serde_json::to_value(store.read_scan_checkpoint().unwrap()).unwrap();
    let mut request = batch(&catalog, &prefs, true);
    request.expected_checkpoint_revision = Some("1".into());
    assert_eq!(
        store.commit_scan_batch(&request, || Ok(())).unwrap_err(),
        "scan-checkpoint-revision-stale"
    );
    assert_eq!(store.read_snapshot().unwrap(), before);
    assert_eq!(
        serde_json::to_value(store.read_scan_checkpoint().unwrap()).unwrap(),
        checkpoint_before
    );
    request.expected_checkpoint_revision = Some("0".into());
    let mut wrote_catalog = false;
    assert_eq!(
        store
            .commit_scan_batch_with_phase(&request, |phase| {
                if phase == Phase::AfterCatalog {
                    wrote_catalog = true;
                }
                if phase == Phase::BeforeCommit && wrote_catalog {
                    Err("fixture-canceled".into())
                } else {
                    Ok(())
                }
            })
            .unwrap_err(),
        "fixture-canceled"
    );
    assert!(wrote_catalog);
    assert_eq!(store.read_snapshot().unwrap(), before);
    assert_eq!(
        serde_json::to_value(store.read_scan_checkpoint().unwrap()).unwrap(),
        checkpoint_before
    );
}

#[test]
fn no_op_catalog_keeps_exact_revision_and_late_abort_keeps_durable_ack() {
    let (_root, store, catalog, prefs) = fixture();
    let before = store.read_pair().unwrap();
    let mut request = batch(&catalog, &prefs, false);
    request.catalog_patch.channels.clear();
    request.catalog_patch.final_channel_count = 1;
    request.incoming_health.clear();
    let mut captures = Vec::new();
    let mut after_commit = false;
    let receipt = store
        .commit_scan_batch_observed(
            &request,
            &mut |phase| {
                if phase == Phase::AfterCommit {
                    after_commit = true;
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
            Some(&mut |stage| captures.push(stage)),
        )
        .unwrap();
    assert!(after_commit && receipt.committed);
    assert_eq!(receipt.catalog_revision, "1");
    assert_eq!(store.read_pair().unwrap(), before);
    assert_eq!(
        captures,
        vec![PairCaptureStage::Before, PairCaptureStage::After]
    );
}
