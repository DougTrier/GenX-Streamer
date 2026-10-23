use super::*;
use crate::scan_batch::{Batch, Patch};
fn setup() -> (tempfile::TempDir, PairStore, Value, Value) {
    let dir = tempfile::tempdir().unwrap();
    let store = PairStore::new(dir.path().into()).unwrap();
    let source = json!({"id":"public","name":"Public","kind":"url","location":"https://public.invalid/list.m3u","allowHttp":false});
    let channel = json!({"id":"old","sourceId":"public","providerId":"old-provider","name":"Same name","category":"News","urls":["https://public.invalid/old.m3u8"]});
    let catalog = json!({"schemaVersion":1,"sources":[source.clone()],"channels":[channel]});
    let prefs = json!({"schemaVersion":1,"sources":[source],"favorites":["old"],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":300.0});
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    (dir, store, catalog, prefs)
}
fn batch(store: &PairStore, catalog: &Value, prefs: &Value) -> Batch {
    let revision = store.read_scan_commit_revisions().unwrap();
    let channel = json!({"id":"new","sourceId":"public","providerId":"new-provider","name":"Same name","category":"Sports","urls":["https://public.invalid/new.m3u8"]});
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
        incoming_health: vec![],
        expected_catalog_revision: revision.catalog_revision,
        expected_health_revision: revision.health_revision,
        scan_checkpoint: None,
        expected_checkpoint_revision: None,
    }
}
fn health(source: &Value, channel: &Value, verdict: &str, evidence: Value, observed: u64) -> Value {
    json!({"schemaVersion":1,"channelId":channel["id"],"sourceId":source["id"],"checkedUrlOrdinal":0,"targetFingerprint":crate::health_storage::fingerprint(source,channel,0).unwrap(),"platform":"windows","observerProfile":"fixture","observedAt":observed,"verdict":verdict,"evidence":evidence,"origin":"local"})
}

#[test]
fn compact_batch_preserves_ordinals_and_health_and_returns_only_scalar_ack() {
    let (dir, store, catalog, prefs) = setup();
    let old = health(
        &catalog["sources"][0],
        &catalog["channels"][0],
        "PlayedHere",
        json!({"kind":"decoded","before":{"mediaTime":1,"decodedFrames":1,"width":1920,"height":1080},"after":{"mediaTime":2,"decodedFrames":2,"width":1920,"height":1080},"elapsedMilliseconds":1000}),
        100,
    );
    store
        .write_health_guarded(
            &json!({"schemaVersion":1,"records":[old.clone()]}).to_string(),
            "1",
            "0",
            || Ok(()),
        )
        .unwrap();
    let mut request = batch(&store, &catalog, &prefs);
    request.incoming_health = vec![health(
        &catalog["sources"][0],
        &request.catalog_patch.channels[0],
        "Reachable",
        json!({"kind":"recognized-media-response"}),
        101,
    )];
    let receipt = store.commit_scan_batch(&request, || Ok(())).unwrap();
    let reply = serde_json::to_value(&receipt).unwrap();
    assert_eq!(reply.as_object().unwrap().len(), 3);
    assert!(reply.get("catalog").is_none() && reply.get("health").is_none());
    drop(store);
    let store = PairStore::new(dir.path().into()).unwrap();
    let saved = store.read_snapshot().unwrap();
    let actual: Value = serde_json::from_str(saved.pair.catalog.as_ref().unwrap()).unwrap();
    assert_eq!(actual["channels"][0], catalog["channels"][0]);
    assert_eq!(actual["channels"][1], request.catalog_patch.channels[0]);
    let records: Value = serde_json::from_str(saved.health.as_ref().unwrap()).unwrap();
    assert_eq!(records["records"].as_array().unwrap().len(), 2);
    assert!(records["records"].as_array().unwrap().contains(&old));
    let revisions = serde_json::to_value(store.read_scan_commit_revisions().unwrap()).unwrap();
    assert_eq!(revisions.as_object().unwrap().len(), 3);
    assert_eq!(revisions["schemaVersion"], 1);
}

#[test]
fn compact_batch_rejects_stale_cas_bad_authority_counts_reassignment_and_evidence() {
    let (_dir, store, catalog, prefs) = setup();
    let before = store.read_snapshot().unwrap();
    for kind in [
        "catalog-cas",
        "health-cas",
        "base-count",
        "final-count",
        "grant",
        "missing-pref",
        "reassignment",
        "duplicate",
        "health-target",
        "checkpoint-pair",
        "too-many",
    ] {
        let mut request = batch(&store, &catalog, &prefs);
        match kind {
            "catalog-cas" => request.expected_catalog_revision = "0".into(),
            "health-cas" => request.expected_health_revision = "1".into(),
            "base-count" => request.catalog_patch.base_channel_count = 0,
            "final-count" => request.catalog_patch.final_channel_count = 3,
            "grant" => request.authorized_sources[0]["allowHttp"] = json!(true),
            "missing-pref" => request.next_preferences["sources"] = json!([]),
            "reassignment" => {
                request.catalog_patch.channels[0]["id"] = json!("old");
                request.catalog_patch.channels[0]["sourceId"] = json!("foreign");
            }
            "duplicate" => request
                .catalog_patch
                .channels
                .push(request.catalog_patch.channels[0].clone()),
            "health-target" => {
                let mut h = health(
                    &catalog["sources"][0],
                    &request.catalog_patch.channels[0],
                    "Reachable",
                    json!({"kind":"recognized-media-response"}),
                    100,
                );
                h["targetFingerprint"] = json!("a".repeat(64));
                request.incoming_health.push(h);
            }
            "checkpoint-pair" => request.expected_checkpoint_revision = Some("0".into()),
            "too-many" => {
                request.catalog_patch.channels = vec![request.catalog_patch.channels[0].clone(); 65]
            }
            _ => unreachable!(),
        }
        assert!(
            store.commit_scan_batch(&request, || Ok(())).is_err(),
            "accepted {kind}"
        );
        assert_eq!(store.read_snapshot().unwrap(), before, "mutated {kind}");
    }
}

#[test]
fn compact_batch_cancel_and_sql_failure_rollback_and_postcommit_cancel_keeps_ack() {
    let (_dir, store, catalog, prefs) = setup();
    let before = store.read_snapshot().unwrap();
    let request = batch(&store, &catalog, &prefs);
    assert_eq!(
        store
            .commit_scan_batch_with_phase(&request, |phase| if phase == Phase::AfterCatalog {
                Err("canceled".into())
            } else {
                Ok(())
            })
            .unwrap_err(),
        "canceled"
    );
    assert_eq!(store.read_snapshot().unwrap(), before);
    let connection = connect(&store.root.join(DB), false).unwrap();
    connection.execute_batch("CREATE TRIGGER batch_disk_error BEFORE INSERT ON channel BEGIN SELECT RAISE(ABORT,'controlled failure'); END;").unwrap();
    assert!(store.commit_scan_batch(&request, || Ok(())).is_err());
    assert_eq!(store.read_snapshot().unwrap(), before);
    connection
        .execute_batch("DROP TRIGGER batch_disk_error")
        .unwrap();
    let mut saw_commit = false;
    let receipt = store
        .commit_scan_batch_with_phase(&request, |phase| {
            if phase == Phase::AfterCommit {
                saw_commit = true;
                Err("canceled".into())
            } else {
                Ok(())
            }
        })
        .unwrap();
    assert!(receipt.committed);
    assert!(saw_commit);
    assert_eq!(store.read_snapshot().unwrap().catalog_revision, "2");
}

#[test]
fn compact_batch_competing_writer_after_backup_is_fenced_by_same_transaction_cas() {
    let (_dir, store, catalog, prefs) = setup();
    let request = batch(&store, &catalog, &prefs);
    let mut changed = catalog.clone();
    changed["channels"][0]["name"] = json!("Concurrent edit");
    let mut wrote = false;
    let error = store
        .commit_scan_batch_with_phase(&request, |phase| {
            if phase == Phase::AfterBackup && !wrote {
                wrote = true;
                store.write_pair(&changed.to_string(), &prefs.to_string())?;
            }
            Ok(())
        })
        .unwrap_err();
    assert_eq!(error, "catalog-revision-stale");
    let actual: Value =
        serde_json::from_str(store.read_pair().unwrap().catalog.as_ref().unwrap()).unwrap();
    assert_eq!(actual["channels"], changed["channels"]);
    assert_eq!(actual["sources"][0]["id"], changed["sources"][0]["id"]);
    assert_ne!(actual["sources"][0]["allowHttp"], true);
}

#[test]
fn compact_batch_unselected_old_source_survives_without_authorization_or_patch_churn() {
    let (_dir, store, mut catalog, mut prefs) = setup();
    let failed = json!({"id":"unused","name":"Unused source","kind":"url","location":"https://public.invalid/unused.m3u"});
    catalog["sources"]
        .as_array_mut()
        .unwrap()
        .push(failed.clone());
    prefs["sources"] = catalog["sources"].clone();
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    let mut request = batch(&store, &catalog, &prefs);
    request.catalog_patch.base_source_count = 2;
    request.catalog_patch.final_source_count = 2;
    request.authorized_sources.truncate(1);
    store.commit_scan_batch(&request, || Ok(())).unwrap();
    let saved: Value =
        serde_json::from_str(store.read_pair().unwrap().catalog.as_ref().unwrap()).unwrap();
    assert_eq!(saved["sources"][1], failed);
    assert_eq!(saved["channels"].as_array().unwrap().len(), 2);
}

#[test]
fn compact_batch_shared_core_atomic_checkpoint_refusal_does_not_publish_catalog() {
    let (_dir, store, catalog, prefs) = setup();
    let before = store.read_snapshot().unwrap();
    let mut request = batch(&store, &catalog, &prefs);
    request.scan_checkpoint = Some(crate::scan_checkpoint::Mutation::Advance {
        job_id: "missing".into(),
        review_digest: "a".repeat(64),
        observations: vec![],
        published_keys: vec![],
    });
    request.expected_checkpoint_revision = Some("0".into());
    assert_eq!(
        store.commit_scan_batch(&request, || Ok(())).unwrap_err(),
        "scan-checkpoint-advance-unavailable"
    );
    assert_eq!(store.read_snapshot().unwrap(), before);
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "absent"
    );
}

#[test]
fn compact_batch_publishes_reference_checkpoint_health_and_catalog_together() {
    let (_dir, store, catalog, prefs) = setup();
    let mut request = batch(&store, &catalog, &prefs);
    let source = &catalog["sources"][0];
    let mut candidate = request.catalog_patch.channels[0].clone();
    candidate.as_object_mut().unwrap().remove("id");
    let mut checkpoint = json!({"schemaVersion":1,"jobId":"batch-job","createdAtMs":scan_now(),"catalogRevision":"1","policyFingerprint":"","sourceDefinitions":[{"source":source,"definitionFingerprint":crate::scan_checkpoint::source_fingerprint(source).unwrap()}],"budgetMs":20000,"platform":"windows","observerProfile":"fixture","review":{"sessionRevision":"session","query":"","status":"completed","sources":[{"sourceId":"public","fingerprint":"scope","status":"completed","inspected":1,"matched":1,"warnings":0}],"candidates":[{"key":"new-key","sourceId":"public","sourceFingerprint":"scope","sessionRevision":"session","channel":candidate}],"counts":{"inspected":1,"matched":1,"failedSources":0,"canceledSources":0}},"observations":[],"publishedKeys":[]});
    checkpoint["policyFingerprint"] =
        json!(crate::scan_checkpoint::policy_fingerprint(&checkpoint, &prefs).unwrap());
    let reference = crate::scan_checkpoint::reference_fixture(&checkpoint);
    let seed = crate::scan_checkpoint::Mutation::Save {
        checkpoint: reference.to_string(),
    };
    store
        .write_pair_with_scan(
            &RecordPair::default(),
            None,
            (Some("1"), None),
            Some((&seed, "0")),
            || Ok(()),
        )
        .unwrap();
    request.incoming_health = vec![health(
        source,
        &request.catalog_patch.channels[0],
        "Reachable",
        json!({"kind":"recognized-media-response"}),
        scan_now(),
    )];
    request.scan_checkpoint = Some(crate::scan_checkpoint::Mutation::Advance {
        job_id: "batch-job".into(),
        review_digest: reference["reviewDigest"].as_str().unwrap().into(),
        observations: vec![
            json!({"channelId":"new-key","sourceId":"public","fingerprint":"scope","platform":"windows","observedAt":scan_now(),"verdict":"Reachable","evidence":{"kind":"recognized-media-response"}}),
        ],
        published_keys: vec!["new-key".into()],
    });
    request.expected_checkpoint_revision = Some("1".into());
    let receipt = store.commit_scan_batch(&request, || Ok(())).unwrap();
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("2"));
    assert_eq!(receipt.catalog_revision, "2");
    let saved = store.read_scan_checkpoint().unwrap();
    assert_eq!(saved.checkpoint_status, "valid");
    let body: Value = serde_json::from_str(saved.checkpoint.as_ref().unwrap()).unwrap();
    assert_eq!(body["schemaVersion"], 2);
    assert_eq!(body["publishedKeys"], json!(["new-key"]));
    assert_eq!(body["review"], reference["review"]);
    assert_eq!(body["catalogRevision"], "2");
    let snapshot = store.read_snapshot().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(snapshot.health.as_ref().unwrap()).unwrap()["records"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn compact_batch_accepts_exactly_64_unique_changes_and_refuses_65_before_publication() {
    let (_dir, store, catalog, prefs) = setup();
    let mut request = batch(&store, &catalog, &prefs);
    let template = request.catalog_patch.channels[0].clone();
    request.catalog_patch.channels = (0..64)
        .map(|index| {
            let mut channel = template.clone();
            channel["id"] = json!(format!("new-{index}"));
            channel
        })
        .collect();
    request.catalog_patch.final_channel_count = 65;
    let mut excessive = batch(&store, &catalog, &prefs);
    excessive.catalog_patch.channels = (0..65)
        .map(|index| {
            let mut channel = template.clone();
            channel["id"] = json!(format!("new-{index}"));
            channel
        })
        .collect();
    excessive.catalog_patch.final_channel_count = 66;
    assert_eq!(
        store.commit_scan_batch(&excessive, || Ok(())).unwrap_err(),
        "scan-batch-invalid"
    );
    assert_eq!(
        store.read_scan_commit_revisions().unwrap().catalog_revision,
        "1"
    );
    store.commit_scan_batch(&request, || Ok(())).unwrap();
    let actual: Value =
        serde_json::from_str(store.read_pair().unwrap().catalog.as_ref().unwrap()).unwrap();
    assert_eq!(actual["channels"].as_array().unwrap().len(), 65);
    assert_eq!(actual["channels"][0]["id"], "old");
    assert_eq!(actual["channels"][64]["id"], "new-63");
}

#[test]
fn compact_wire_refuses_unknown_fields_and_whole_oversize_patch_without_data_changes() {
    let (_dir, store, catalog, prefs) = setup();
    let request = batch(&store, &catalog, &prefs);
    let mut raw = serde_json::to_value(&request).unwrap();
    raw["catalogText"] = json!("not an admitted field");
    assert!(serde_json::from_value::<Batch>(raw).is_err());
    let before = store.read_snapshot().unwrap();
    let mut oversized = batch(&store, &catalog, &prefs);
    oversized.catalog_patch.channels[0]["name"] = json!("x".repeat(20 * 1024 * 1024));
    assert_eq!(
        store.commit_scan_batch(&oversized, || Ok(())).unwrap_err(),
        "scan-batch-too-large"
    );
    assert_eq!(store.read_snapshot().unwrap(), before);
}

#[test]
fn compact_empty_patch_accepts_health_for_unchanged_saved_target() {
    let (_dir, store, catalog, prefs) = setup();
    let mut request = batch(&store, &catalog, &prefs);
    request.catalog_patch.channels.clear();
    request.catalog_patch.final_channel_count = 1;
    request.incoming_health = vec![health(
        &catalog["sources"][0],
        &catalog["channels"][0],
        "Reachable",
        json!({"kind":"recognized-media-response"}),
        100,
    )];
    let original = store.read_pair().unwrap();
    let receipt = store.commit_scan_batch(&request, || Ok(())).unwrap();
    assert!(receipt.committed);
    assert_eq!(receipt.catalog_revision, "1");
    assert_eq!(receipt.health_revision, "1");
    assert_eq!(store.read_pair().unwrap(), original);
    let saved = store.read_snapshot().unwrap();
    let body: Value = serde_json::from_str(saved.health.as_ref().unwrap()).unwrap();
    assert_eq!(body["records"], json!(request.incoming_health));
}

#[test]
fn compact_empty_patch_unknown_health_target_rolls_back_every_record() {
    let (_dir, store, catalog, prefs) = setup();
    let mut request = batch(&store, &catalog, &prefs);
    let unknown = request.catalog_patch.channels[0].clone();
    request.catalog_patch.channels.clear();
    request.catalog_patch.final_channel_count = 1;
    request.incoming_health = vec![health(
        &catalog["sources"][0],
        &unknown,
        "Reachable",
        json!({"kind":"recognized-media-response"}),
        100,
    )];
    let original = store.read_snapshot().unwrap();
    assert_eq!(
        store.commit_scan_batch(&request, || Ok(())).unwrap_err(),
        "health-target-mismatch"
    );
    assert_eq!(store.read_snapshot().unwrap(), original);
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "absent"
    );
}
