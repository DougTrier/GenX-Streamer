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

//! Real operational checkpoint deltas share the catalog/health transaction.
use super::*;

fn seed(store: &PairStore, value: &Value) -> Value {
    let reference = scan_checkpoint::reference_fixture(value);
    store
        .write_pair_with_scan(
            &RecordPair::default(),
            None,
            (Some("1"), None),
            Some((&save(&reference), "0")),
            || Ok(()),
        )
        .unwrap();
    reference
}
fn delta(reference: &Value, observations: Vec<Value>, keys: Vec<&str>) -> Mutation {
    Mutation::Advance {
        job_id: "job-a".into(),
        review_digest: reference["reviewDigest"].as_str().unwrap().into(),
        observations,
        published_keys: keys.into_iter().map(str::to_owned).collect(),
    }
}
fn progress(
    store: &PairStore,
    mutation: &Mutation,
    catalog: &str,
    checkpoint: &str,
) -> Result<CommitReceipt, String> {
    store.write_pair_with_scan(
        &RecordPair::default(),
        None,
        (Some(catalog), None),
        Some((mutation, checkpoint)),
        || Ok(()),
    )
}
fn stored(store: &PairStore) -> Value {
    serde_json::from_str(
        store
            .read_scan_checkpoint()
            .unwrap()
            .checkpoint
            .as_ref()
            .unwrap(),
    )
    .unwrap()
}
fn denied() -> Value {
    json!({"channelId":"key-a","sourceId":"public","fingerprint":"scope-a","platform":"windows","observedAt":scan_now(),"verdict":"AccessDenied","evidence":{"kind":"http","status":403}})
}

#[test]
fn advance_paired_publication_health_and_restart_preserve_immutable_v2_review() {
    let (dir, store, mut catalog, _prefs, mut value) = fixture();
    let reference = seed(&store, &value);
    publish(&mut value, &mut catalog);
    let mutation = delta(
        &reference,
        value["observations"].as_array().unwrap().clone(),
        vec!["key-a"],
    );
    let wire = serde_json::to_string(&mutation).unwrap();
    assert!(wire.len() < 1024);
    assert!(!wire.contains("review\":"));
    assert!(!wire.contains("example.com"));
    let fingerprint =
        crate::health_storage::fingerprint(&catalog["sources"][0], &catalog["channels"][0], 0)
            .unwrap();
    let health = json!({"schemaVersion":1,"records":[{"schemaVersion":1,"channelId":"saved-id","sourceId":"public","checkedUrlOrdinal":0,"targetFingerprint":fingerprint,"platform":"windows","observerProfile":"resource-v1","observedAt":scan_now(),"verdict":"Reachable","evidence":{"kind":"recognized-media-response"},"origin":"local"}]}).to_string();
    let before = store.read_snapshot().unwrap();
    let receipt = store
        .write_pair_with_scan(
            &RecordPair {
                catalog: Some(catalog.to_string()),
                preferences: None,
            },
            Some(&health),
            (Some("1"), Some(&before.health_revision)),
            Some((&mutation, "1")),
            || Ok(()),
        )
        .unwrap();
    assert!(receipt.committed);
    assert_eq!(receipt.catalog_revision, "2");
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("2"));
    drop(store);
    let store = PairStore::new(dir.path().to_owned()).unwrap();
    let restored = stored(&store);
    assert_eq!(restored["schemaVersion"], 2);
    assert_eq!(restored["review"], reference["review"]);
    assert_eq!(
        restored["sourceDefinitions"],
        reference["sourceDefinitions"]
    );
    assert_eq!(restored["reviewDigest"], reference["reviewDigest"]);
    assert_eq!(restored["catalogRevision"], "2");
    assert_eq!(restored["observations"], value["observations"]);
    assert_eq!(restored["publishedKeys"], json!(["key-a"]));
    let snapshot = store.read_snapshot().unwrap();
    let records: Value = serde_json::from_str(snapshot.health.as_ref().unwrap()).unwrap();
    assert_eq!(records["records"].as_array().unwrap().len(), 1);
    assert_eq!(records["records"][0]["channelId"], "saved-id");
}

#[test]
fn advance_standalone_settled_denial_and_exact_retry_are_idempotent() {
    let (_dir, store, _catalog, _prefs, value) = fixture();
    let reference = seed(&store, &value);
    let mutation = delta(&reference, vec![denied()], vec![]);
    let before = store.read_pair().unwrap();
    progress(&store, &mutation, "1", "1").unwrap();
    let first = stored(&store);
    progress(&store, &mutation, "1", "2").unwrap();
    assert_eq!(first, stored(&store));
    assert_eq!(stored(&store)["observations"].as_array().unwrap().len(), 1);
    assert_eq!(before, store.read_pair().unwrap());
    assert_eq!(
        progress(&store, &mutation, "1", "1").unwrap_err(),
        "scan-checkpoint-revision-stale"
    );
}

#[test]
fn advance_conflicting_replay_unknown_key_and_duplicate_delta_refuse_without_mutation() {
    let (_dir, store, _catalog, _prefs, value) = fixture();
    let reference = seed(&store, &value);
    let observation = denied();
    progress(
        &store,
        &delta(&reference, vec![observation.clone()], vec![]),
        "1",
        "1",
    )
    .unwrap();
    let before = stored(&store);
    let mut conflict = observation.clone();
    conflict["evidence"]["status"] = json!(401);
    let mut unknown = observation.clone();
    unknown["channelId"] = json!("unknown");
    for mutation in [
        delta(&reference, vec![conflict], vec![]),
        delta(&reference, vec![unknown], vec![]),
        delta(&reference, vec![observation.clone(), observation], vec![]),
        delta(&reference, vec![], vec!["key-a", "key-a"]),
        delta(&reference, vec![], vec!["key-a"]),
    ] {
        assert!(progress(&store, &mutation, "1", "2").is_err());
        assert_eq!(stored(&store), before);
        assert_eq!(
            store.read_scan_checkpoint().unwrap().checkpoint_revision,
            "2"
        );
    }
}

#[test]
fn advance_requires_seed_v2_and_exact_job_digest_catalog_and_checkpoint_cas() {
    let (_dir, store, _catalog, _prefs, value) = fixture();
    let reference = scan_checkpoint::reference_fixture(&value);
    let mutation = delta(&reference, vec![], vec![]);
    assert_eq!(
        progress(&store, &mutation, "1", "0").unwrap_err(),
        "scan-checkpoint-advance-unavailable"
    );
    progress(&store, &save(&value), "1", "0").unwrap();
    assert_eq!(
        progress(&store, &mutation, "1", "1").unwrap_err(),
        "scan-checkpoint-advance-requires-v2"
    );
    let (_dir, store, _catalog, _prefs, value) = fixture();
    let reference = seed(&store, &value);
    for (job, digest) in [("other", "a".repeat(64)), ("job-a", "a".repeat(64))] {
        let mutation = Mutation::Advance {
            job_id: job.into(),
            review_digest: digest,
            observations: vec![],
            published_keys: vec![],
        };
        assert_eq!(
            progress(&store, &mutation, "1", "1").unwrap_err(),
            "scan-checkpoint-job-stale"
        );
    }
    let mutation = delta(&reference, vec![], vec![]);
    assert_eq!(
        progress(&store, &mutation, "0", "1").unwrap_err(),
        "catalog-revision-stale"
    );
    assert_eq!(
        progress(&store, &mutation, "1", "0").unwrap_err(),
        "scan-checkpoint-revision-stale"
    );
    assert_eq!(stored(&store), reference);
}

#[test]
fn advance_pair_failure_before_commit_rolls_back_catalog_health_and_checkpoint() {
    let (_dir, store, mut catalog, _prefs, mut value) = fixture();
    let reference = seed(&store, &value);
    publish(&mut value, &mut catalog);
    let mutation = delta(
        &reference,
        value["observations"].as_array().unwrap().clone(),
        vec!["key-a"],
    );
    let before = store.read_snapshot().unwrap();
    let checkpoint = stored(&store);
    let mut connection = connect(&store.root.join(DB), false).unwrap();
    let result = PairStore::apply_with_scan(
        &mut connection,
        &RecordPair {
            catalog: Some(catalog.to_string()),
            preferences: None,
        },
        Some("{\"schemaVersion\":1,\"records\":[]}"),
        (Some(1), Some(before.health_revision.parse().unwrap())),
        Some((&mutation, 1, scan_now())),
        |phase| {
            if phase == Phase::BeforeCommit {
                Err("canceled".into())
            } else {
                Ok(())
            }
        },
    );
    assert_eq!(result.unwrap_err(), "canceled");
    let after = store.read_snapshot().unwrap();
    assert_eq!(before.pair, after.pair);
    assert_eq!(before.health, after.health);
    assert_eq!(before.catalog_revision, after.catalog_revision);
    assert_eq!(before.health_revision, after.health_revision);
    assert_eq!(stored(&store), checkpoint);
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "1"
    );
}

#[test]
fn advance_refuses_policy_shift_expired_checkpoint_and_unsettled_evidence() {
    let (_dir, store, _catalog, prefs, value) = fixture();
    let reference = seed(&store, &value);
    let mut changed = prefs.clone();
    changed["preferredRegion"] = json!({"country":"US","origin":"manual"});
    let mutation = delta(&reference, vec![], vec![]);
    assert!(store
        .write_pair_with_scan(
            &RecordPair {
                catalog: None,
                preferences: Some(changed.to_string())
            },
            None,
            (Some("1"), None),
            Some((&mutation, "1")),
            || Ok(())
        )
        .is_err());
    assert_eq!(stored(&store), reference);
    let mut unsettled = denied();
    unsettled["verdict"] = json!("NotChecked");
    unsettled["evidence"] = json!({"kind":"http","status":200});
    assert!(progress(
        &store,
        &delta(&reference, vec![unsettled], vec![]),
        "1",
        "1"
    )
    .is_err());
    let mut connection = connect(&store.root.join(DB), false).unwrap();
    assert!(PairStore::apply_with_scan(
        &mut connection,
        &RecordPair::default(),
        None,
        (Some(1), None),
        Some((&mutation, 1, scan_now() + 86_400_001)),
        |_| Ok(())
    )
    .is_err());
    assert_eq!(stored(&store), reference);
}

#[test]
fn advance_count_and_serialized_byte_limits_refuse_whole_delta() {
    let (_dir, store, _catalog, _prefs, value) = fixture();
    let reference = seed(&store, &value);
    let many = delta(&reference, vec![denied(); 100_001], vec![]);
    assert_eq!(
        progress(&store, &many, "1", "1").unwrap_err(),
        "scan-checkpoint-too-large"
    );
    let mut oversized = denied();
    oversized["privateUnrecognizedField"] = json!("x".repeat(20 * 1024 * 1024));
    assert_eq!(
        progress(
            &store,
            &delta(&reference, vec![oversized], vec![]),
            "1",
            "1"
        )
        .unwrap_err(),
        "scan-checkpoint-too-large"
    );
    assert_eq!(stored(&store), reference);
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "1"
    );
}

#[test]
fn advance_checkpoint_sql_write_refusal_rolls_back_publication_and_old_progress() {
    let (_dir, store, mut catalog, _prefs, mut value) = fixture();
    let reference = seed(&store, &value);
    publish(&mut value, &mut catalog);
    let mutation = delta(
        &reference,
        value["observations"].as_array().unwrap().clone(),
        vec!["key-a"],
    );
    let before = store.read_snapshot().unwrap();
    let mut connection = connect(&store.root.join(DB), false).unwrap();
    connection.execute_batch("CREATE TEMP TRIGGER checkpoint_disk_refusal BEFORE UPDATE ON scan_checkpoint BEGIN SELECT RAISE(ABORT,'fixture disk refusal'); END;").unwrap();
    let error = PairStore::apply_with_scan(
        &mut connection,
        &RecordPair {
            catalog: Some(catalog.to_string()),
            preferences: None,
        },
        None,
        (Some(1), None),
        Some((&mutation, 1, scan_now())),
        |_| Ok(()),
    )
    .unwrap_err();
    assert_eq!(error, "scan-checkpoint-storage-failed");
    let after = store.read_snapshot().unwrap();
    assert_eq!(before, after);
    assert_eq!(stored(&store), reference);
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "1"
    );
}

#[test]
fn parsed_advance_revalidates_corrupt_immutable_review_and_preserves_every_record() {
    let (_dir, store, _catalog, _prefs, value) = fixture();
    let reference = seed(&store, &value);
    let mut altered = reference.clone();
    altered["review"]["candidates"][0]["channel"]["category"] =
        json!("Changed without matching digest");
    let connection = connect(&store.root.join(DB), false).unwrap();
    connection
        .execute(
            "UPDATE scan_checkpoint SET contents=?1 WHERE singleton=1",
            params![altered.to_string()],
        )
        .unwrap();
    drop(connection);
    let before = store.read_snapshot().unwrap();
    assert_eq!(
        progress(&store, &delta(&reference, vec![denied()], vec![]), "1", "1").unwrap_err(),
        "scan-checkpoint-invalid"
    );
    assert_eq!(store.read_snapshot().unwrap(), before);
    let connection = connect(&store.root.join(DB), false).unwrap();
    let raw: String = connection
        .query_row(
            "SELECT contents FROM scan_checkpoint WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), altered);
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "invalid"
    );
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "1"
    );
}

#[test]
fn parsed_advance_validation_cancellation_rolls_back_without_a_false_receipt() {
    let (_dir, store, catalog, prefs, value) = fixture();
    let reference = seed(&store, &value);
    let before = store.read_snapshot().unwrap();
    let mutation = delta(&reference, vec![denied()], vec![]);
    let mut calls = 0;
    let mut connection = connect(&store.root.join(DB), false).unwrap();
    {
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        let result = scan_checkpoint::apply(
            &transaction,
            &mutation,
            1,
            &prefs,
            &catalog,
            (1, 1, scan_now()),
            || {
                calls += 1;
                if calls == 3 {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
        );
        assert_eq!(result.unwrap_err(), "canceled");
        assert_eq!(calls, 3);
    }
    assert_eq!(store.read_snapshot().unwrap(), before);
    assert_eq!(stored(&store), reference);
}

#[test]
fn parsed_advance_preserves_escaped_unicode_metadata_and_the_save_wire_shape() {
    let (_dir, store, _catalog, _prefs, mut value) = fixture();
    value["review"]["candidates"][0]["channel"]["name"] = json!("Quoted \"Channel\" \\ Σ 📺");
    value["review"]["candidates"][0]["channel"]["category"] = json!("儿童 🎬");
    let reference = seed(&store, &value);
    let observation = denied();
    progress(
        &store,
        &delta(&reference, vec![observation.clone()], vec![]),
        "1",
        "1",
    )
    .unwrap();
    let updated = stored(&store);
    assert_eq!(updated["review"], reference["review"]);
    assert_eq!(updated["reviewDigest"], reference["reviewDigest"]);
    assert_eq!(updated["observations"], json!([observation]));
    assert!(
        store
            .read_scan_checkpoint()
            .unwrap()
            .checkpoint
            .unwrap()
            .len()
            <= 20 * 1024 * 1024
    );
}
