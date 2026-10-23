//! Real SQLite operations; observers are operation-local, never process globals.
use super::pair_reuse_tests::{batch, fixture};
use super::*;

fn value_stages() -> Vec<PairCaptureStage> {
    vec![
        PairCaptureStage::Before,
        PairCaptureStage::BeforeCatalogReuse,
        PairCaptureStage::BeforeDeltaReuse,
        PairCaptureStage::After,
        PairCaptureStage::AfterHealthReuse,
        PairCaptureStage::AfterCheckpointReuse,
    ]
}

#[test]
fn compact_batch_validates_exact_sql_before_after_once_and_reuses_each_consumer() {
    let (root, store, catalog, prefs) = fixture();
    let request = batch(&catalog, &prefs, true);
    let mut stages = Vec::new();
    let mut backups = 0;
    let receipt = store
        .commit_scan_batch_values_observed(
            &request,
            &mut |phase| {
                if phase == Phase::BeforeBackup {
                    backups += 1;
                }
                Ok(())
            },
            Some(&mut |stage| stages.push(stage)),
        )
        .unwrap();
    assert_eq!(stages, value_stages());
    assert_eq!(backups, 1);
    assert_eq!(receipt.catalog_revision, "2");
    assert_eq!(receipt.health_revision, "1");
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("1"));
    let connection = connect(&root.path().join(DB), true).unwrap();
    let snapshot = PairStore::read_connection_validated(&connection).unwrap();
    assert_eq!(snapshot.pair, store.read_pair().unwrap());
    assert_eq!(
        snapshot.catalog,
        snapshot
            .pair
            .catalog
            .as_deref()
            .map(parse)
            .transpose()
            .unwrap()
    );
    assert_eq!(
        snapshot.preferences,
        snapshot
            .pair
            .preferences
            .as_deref()
            .map(parse)
            .transpose()
            .unwrap()
    );
    assert_eq!(
        snapshot.catalog.as_ref().unwrap()["channels"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        snapshot.preferences.as_ref().unwrap()["automaticGuideUpdates"],
        false
    );
    assert_eq!(
        snapshot.preferences.as_ref().unwrap()["channelCategoryOverrides"][0]["category"],
        "Local"
    );
    drop(connection);
    assert_eq!(
        PairStore::new(root.path().into())
            .unwrap()
            .read_snapshot()
            .unwrap(),
        store.read_snapshot().unwrap()
    );
}

#[test]
fn compact_and_full_exact_outputs_match_for_legacy_absence_and_explicit_guide_choices() {
    for flag in [None, Some(false), Some(true)] {
        let (_left, compact, catalog, mut prefs) = fixture();
        let (_right, full, _, _) = fixture();
        prefs
            .as_object_mut()
            .unwrap()
            .remove("automaticGuideUpdates");
        if let Some(flag) = flag {
            prefs["automaticGuideUpdates"] = json!(flag);
        }
        compact
            .write_pair(&catalog.to_string(), &prefs.to_string())
            .unwrap();
        full.write_pair(&catalog.to_string(), &prefs.to_string())
            .unwrap();
        let request = batch(&catalog, &prefs, true);
        let mut expanded = catalog.clone();
        expanded["channels"]
            .as_array_mut()
            .unwrap()
            .extend(request.catalog_patch.channels.clone());
        let health = json!({"schemaVersion":1,"records":request.incoming_health}).to_string();
        let actual = compact.commit_scan_batch(&request, || Ok(())).unwrap();
        let expected = full
            .write_pair_with_scan(
                &RecordPair {
                    catalog: Some(expanded.to_string()),
                    preferences: Some(prefs.to_string()),
                },
                Some(&health),
                (Some("1"), Some("0")),
                Some((request.scan_checkpoint.as_ref().unwrap(), "0")),
                || Ok(()),
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        assert_eq!(
            compact.read_snapshot().unwrap(),
            full.read_snapshot().unwrap()
        );
        assert_eq!(
            serde_json::to_value(compact.read_scan_checkpoint().unwrap()).unwrap(),
            serde_json::to_value(full.read_scan_checkpoint().unwrap()).unwrap()
        );
        let saved = parse(compact.read_pair().unwrap().preferences.as_ref().unwrap()).unwrap();
        assert_eq!(
            saved.get("automaticGuideUpdates").and_then(Value::as_bool),
            flag
        );
    }
}

#[test]
fn corrupted_sql_source_is_not_hidden_by_reused_values_or_mutated_on_refusal() {
    let (root, store, catalog, prefs) = fixture();
    let request = batch(&catalog, &prefs, true);
    let connection = connect(&root.path().join(DB), false).unwrap();
    connection
        .execute(
            "UPDATE source SET media_mime='text/plain; charset=utf-8' WHERE id='public'",
            [],
        )
        .unwrap();
    assert_eq!(
        PairStore::read_connection_validated(&connection).unwrap_err(),
        "record-invalid-mime"
    );
    let revisions: (i64, i64, i64) = connection
        .query_row(
            "SELECT revision,catalog_revision,health_revision FROM metadata",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    drop(connection);
    let mut stages = Vec::new();
    assert_eq!(
        store
            .commit_scan_batch_values_observed(
                &request,
                &mut |_| Ok(()),
                Some(&mut |stage| stages.push(stage))
            )
            .unwrap_err(),
        "record-invalid-mime"
    );
    assert!(stages.is_empty());
    let connection = connect(&root.path().join(DB), true).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT media_mime FROM source WHERE id='public'", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "text/plain; charset=utf-8"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT revision,catalog_revision,health_revision FROM metadata",
                [],
                |r| Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?
                ))
            )
            .unwrap(),
        revisions
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM channel", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn stale_revisions_and_post_write_failure_preserve_complete_original_snapshot() {
    let (_root, store, catalog, prefs) = fixture();
    let before = store.read_snapshot().unwrap();
    let checkpoint_before = serde_json::to_value(store.read_scan_checkpoint().unwrap()).unwrap();
    for stale in ["catalog", "health", "checkpoint"] {
        let mut request = batch(&catalog, &prefs, true);
        let code = match stale {
            "catalog" => {
                request.expected_catalog_revision = "0".into();
                "catalog-revision-stale"
            }
            "health" => {
                request.expected_health_revision = "1".into();
                "health-revision-stale"
            }
            _ => {
                request.expected_checkpoint_revision = Some("1".into());
                "scan-checkpoint-revision-stale"
            }
        };
        assert_eq!(
            store.commit_scan_batch(&request, || Ok(())).unwrap_err(),
            code
        );
        assert_eq!(store.read_snapshot().unwrap(), before);
        assert_eq!(
            serde_json::to_value(store.read_scan_checkpoint().unwrap()).unwrap(),
            checkpoint_before
        );
    }
    let request = batch(&catalog, &prefs, true);
    let mut written = false;
    let mut stages = Vec::new();
    assert_eq!(
        store
            .commit_scan_batch_values_observed(
                &request,
                &mut |phase| {
                    if phase == Phase::AfterCatalog {
                        written = true;
                    }
                    if written && phase == Phase::BeforeCommit {
                        Err("fixture-refusal".into())
                    } else {
                        Ok(())
                    }
                },
                Some(&mut |stage| stages.push(stage))
            )
            .unwrap_err(),
        "fixture-refusal"
    );
    assert!(written);
    assert!(stages.contains(&PairCaptureStage::AfterHealthReuse));
    assert!(stages.contains(&PairCaptureStage::AfterCheckpointReuse));
    assert_eq!(store.read_snapshot().unwrap(), before);
    assert_eq!(
        serde_json::to_value(store.read_scan_checkpoint().unwrap()).unwrap(),
        checkpoint_before
    );
}

#[test]
fn cancellation_after_actual_commit_keeps_durable_receipt_and_reopened_checkpoint() {
    let (root, store, catalog, prefs) = fixture();
    let request = batch(&catalog, &prefs, true);
    let mut committed = false;
    let mut stages = Vec::new();
    let receipt = store
        .commit_scan_batch_values_observed(
            &request,
            &mut |phase| {
                if phase == Phase::AfterCommit {
                    committed = true;
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
            Some(&mut |stage| stages.push(stage)),
        )
        .unwrap();
    assert!(committed && receipt.committed);
    assert_eq!(stages, value_stages());
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("1"));
    let reopened = PairStore::new(root.path().into()).unwrap();
    assert_eq!(
        reopened.read_snapshot().unwrap(),
        store.read_snapshot().unwrap()
    );
    let checkpoint = reopened.read_scan_checkpoint().unwrap();
    assert_eq!(checkpoint.checkpoint_status, "valid");
    assert_eq!(checkpoint.checkpoint_revision, "1");
    assert_eq!(checkpoint.catalog_revision, "2");
}
