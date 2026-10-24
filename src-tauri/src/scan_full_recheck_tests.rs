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

//! Prepared controlled fixtures; no production checkpoint or network access.
use super::*;
fn retained() -> Snapshot {
    let source = json!({"id":"fixture","name":"Fixture","kind":"url","location":"https://example.com/list.m3u"});
    let prefs = json!({});
    let mut value = json!({"schemaVersion":1,"jobId":"prior-fixture","createdAtMs":1000,"catalogRevision":"1","policyFingerprint":"","sourceDefinitions":[{"source":source,"definitionFingerprint":source_fingerprint(&source).unwrap()}],"budgetMs":20000,"platform":"windows","observerProfile":"fixture","review":{"sessionRevision":"fixture","query":"","status":"completed","sources":[{"sourceId":"fixture","fingerprint":"fixture","status":"completed","inspected":1,"matched":1,"warnings":0}],"candidates":[{"key":"fixture","sourceId":"fixture","sourceFingerprint":"fixture","sessionRevision":"fixture","channel":{"sourceId":"fixture","name":"Fixture","category":"News","urls":["https://example.com/media.m3u8"]}}],"counts":{"inspected":1,"matched":1,"failedSources":0,"canceledSources":0}},"observations":[],"publishedKeys":[]});
    value["policyFingerprint"] = json!(policy_fingerprint(&value, &prefs).unwrap());
    let value = packed_fixture(&value);
    Snapshot {
        checkpoint: Some(value.to_string()),
        checkpoint_status: "valid",
        job_id: Some("prior-fixture".into()),
        checkpoint_revision: "4".into(),
        catalog_revision: "2".into(),
    }
}
#[test]
fn explicit_full_recheck_accepts_expired_pending_identity_but_refresh_requires_continue() {
    let prior = retained();
    assert_eq!(
        completed_replacement_identity(&prior).unwrap_err(),
        "scan-checkpoint-continue-required"
    );
    let identity = full_recheck_replacement_identity(&prior, DAY * 3, &mut || Ok(())).unwrap();
    assert_eq!(identity.0.as_deref(), Some("prior-fixture"));
    assert_eq!(identity.1.as_ref().unwrap().len(), 64);
}
#[test]
fn corrupt_review_or_progress_is_never_replacement_authority() {
    for progress in [false, true] {
        let mut prior = retained();
        let mut value: Value = serde_json::from_str(prior.checkpoint.as_ref().unwrap()).unwrap();
        if progress {
            value["publishedIndices"] = json!([0]);
        } else {
            value["review"]["candidates"][0][3] = json!("tampered");
        }
        prior.checkpoint = Some(value.to_string());
        assert_eq!(
            full_recheck_replacement_identity(&prior, DAY * 3, &mut || Ok(())).unwrap_err(),
            "scan-checkpoint-clear-required"
        );
    }
}
#[test]
fn replacement_remains_unavailable_to_ipc_and_cancellation_is_preserved() {
    assert!(serde_json::from_value::<Mutation>(json!({"kind":"replace","checkpoint":"{}","prior_job_id":null,"prior_review_digest":null,"allow_unfinished":true})).is_err());
    assert_eq!(
        full_recheck_replacement_identity(&retained(), DAY * 3, &mut || Err(
            "fixture-canceled".into()
        ))
        .unwrap_err(),
        "fixture-canceled"
    );
}
#[test]
fn each_replacement_stage_requires_exact_retained_identity_and_both_revisions() {
    use crate::scan_candidate_manifest::{replacement_guard, Context};
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE scan_checkpoint(singleton INTEGER PRIMARY KEY,job_id TEXT,contents TEXT);
        CREATE TABLE scan_manifest_replacement(manifest_id TEXT PRIMARY KEY,prior_job_id TEXT,prior_review_digest TEXT,catalog_revision INTEGER,checkpoint_revision INTEGER,allow_unfinished INTEGER);
        INSERT INTO scan_checkpoint VALUES(1,'prior','{\"reviewDigest\":\"digest\"}');
        INSERT INTO scan_manifest_replacement VALUES('stage','prior','digest',2,4,1);").unwrap();
    let prefs = json!({});
    let catalog = json!({});
    let mut context = Context {
        preferences: &prefs,
        catalog: &catalog,
        catalog_revision: 2,
        checkpoint_revision: 4,
        now: 1000,
    };
    assert_eq!(
        replacement_guard(&c, "stage", &context).unwrap(),
        Some((Some("prior".into()), Some("digest".into()), true))
    );
    context.catalog_revision = 3;
    assert_eq!(
        replacement_guard(&c, "stage", &context).unwrap_err(),
        "catalog-revision-stale"
    );
    context.catalog_revision = 2;
    context.checkpoint_revision = 5;
    assert_eq!(
        replacement_guard(&c, "stage", &context).unwrap_err(),
        "scan-checkpoint-revision-stale"
    );
    context.checkpoint_revision = 4;
    for field in ["job_id", "contents"] {
        let tx = c.unchecked_transaction().unwrap();
        if field == "job_id" {
            tx.execute("UPDATE scan_checkpoint SET job_id='other'", [])
                .unwrap();
        } else {
            tx.execute(
                "UPDATE scan_checkpoint SET contents='{\"reviewDigest\":\"other\"}'",
                [],
            )
            .unwrap();
        }
        assert_eq!(
            replacement_guard(&tx, "stage", &context).unwrap_err(),
            "scan-checkpoint-job-stale"
        );
        tx.rollback().unwrap();
    }
}
