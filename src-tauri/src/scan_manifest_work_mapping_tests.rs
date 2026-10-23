//! Real StoreOwner/Context and SQLite; no app, transport, profiles or devices.
//! Preview admission is the production mapping+retention storage core. This does
//! not claim a Tauri command/transport test or physical-guide acceptance.
use super::*;
use crate::guide::{database as db, mapping_admission as admission, retention};

fn mapping() -> db::GuideMapping {
    db::GuideMapping {
        catalog_source_id: "catalog".into(),
        app_channel_id: "channel".into(),
        guide_source_id: "guide".into(),
        xmltv_channel_id: "selected".into(),
    }
}
fn seed(store: &Store) -> Result<(), String> {
    let source = serde_json::json!({"id":"catalog","name":"Fixture source","location":"https://fixture.invalid/channels","kind":"url","allowHttp":false});
    let catalog = serde_json::json!({"schemaVersion":1,"sources":[source.clone()],"channels":[{"id":"channel","sourceId":"catalog","name":"Fixture channel","category":"News","urls":["https://fixture.invalid/live"]}]}).to_string();
    let preferences = serde_json::json!({"schemaVersion":1,"sources":[source],"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":360.0,"automaticGuideUpdates":false}).to_string();
    store.write_guarded(&catalog, &preferences, None, (None, None), || Ok(()))?;
    store.with_guide_write(|c| {
        db::save_source(c, &db::GuideSource {
            id: "guide".into(), name: "Selected guide".into(),
            location: "https://fixture.invalid/guide".into(), kind: "url".into(),
            allow_http: false, revision: 0, updated_ms: None,
        }, 0)?;
        c.execute("INSERT INTO guide_channel(guide_source_id,id,names_json,search_names) VALUES('guide','selected','[\"Selected\"]','selected')", [])
            .map_err(|_| "fixture-guide-header")?;
        Ok(())
    })
}
async fn save(owner: &Arc<Context>) -> admission::Receipt {
    let final_owner = owner.clone();
    owner
        .storage_with_generation(None, move |store, generation, check| {
            store.with_guide_write_checked(
                |c| admission::save(c, mapping(), generation, &mut || final_owner.check()),
                check,
            )
        })
        .await
        .unwrap()
        .0
}
async fn replaced_root_cannot_admit(preview: bool) {
    let (_root, command, reader, _work, _requests) = bookmark_context_fixture();
    command
        .storage(None, |store, check| {
            check()?;
            seed(store)
        })
        .await
        .unwrap();
    let receipt = save(&command).await;
    let original_generation = admission::root(&receipt).unwrap();
    let replacement_root = tempfile::tempdir().unwrap();
    let replacement = Store::new(replacement_root.path().to_owned(), "test".into()).unwrap();
    seed(&replacement).unwrap();
    let other = replacement
        .with_guide_write(|c| {
            admission::save(c, mapping(), original_generation + 1, &mut || Ok(()))
        })
        .unwrap();
    // Identical IDs, catalog/guide revisions, source descriptor and mapping are
    // deliberately sufficient for SQL-only validation. The retained root lease
    // must still refuse this old receipt before domain admission/transport.
    assert_eq!(receipt.catalog_revision, other.catalog_revision);
    assert_eq!(receipt.guide_revision, other.guide_revision);
    assert_eq!(receipt.source_fingerprint, other.source_fingerprint);
    replacement
        .with_guide_read(|c| {
            admission::verify(c, &receipt, receipt.source_revision, true).map(|_| ())
        })
        .unwrap();
    *reader.store.exclusive().unwrap() = Ok(replacement);
    let entered = Arc::new(AtomicBool::new(false));
    let observed = entered.clone();
    let result = reader
        .storage(Some(original_generation), move |store, check| {
            observed.store(true, Ordering::SeqCst);
            check()?;
            store.with_guide_read(|c| {
                if preview {
                    let tx = c
                        .unchecked_transaction()
                        .map_err(|_| "fixture-transaction")?;
                    admission::verify(&tx, &receipt, receipt.source_revision, true)?;
                    retention::capture(&tx, &receipt.mapping.guide_source_id, 100)?;
                    tx.commit().map_err(|_| "fixture-transaction")?;
                } else {
                    admission::status(c, &receipt, receipt.source_revision, 100)?;
                }
                Ok(())
            })
        })
        .await;
    assert_eq!(result.unwrap_err(), "scan-manifest-root-changed");
    assert!(
        !entered.load(Ordering::SeqCst),
        "replaced root entered domain admission"
    );
}
#[tokio::test]
async fn mapped_guide_actual_context_rejects_identical_root_replacement_before_status() {
    replaced_root_cannot_admit(false).await;
}
#[tokio::test]
async fn mapped_guide_actual_context_rejects_identical_root_replacement_before_preview_admission() {
    replaced_root_cannot_admit(true).await;
}
#[tokio::test]
async fn mapped_guide_actual_sql_commit_receipt_survives_late_original_request_abort() {
    let (_root, command, reader, _work, mut requests) = bookmark_context_fixture();
    command
        .storage(None, |store, check| {
            check()?;
            seed(store)
        })
        .await
        .unwrap();
    let (committed_tx, committed_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let owner = command.clone();
    let operation = tokio::spawn(async move {
        let final_owner = owner.clone();
        owner
            .storage_with_generation(None, move |store, generation, check| {
                store.with_guide_write_checked(
                    |c| {
                        let receipt =
                            admission::save(c, mapping(), generation, &mut || final_owner.check())?;
                        // This is after SQLite COMMIT, before storage worker result delivery.
                        committed_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(receipt)
                    },
                    check,
                )
            })
            .await
    });
    committed_rx.await.unwrap();
    requests.cancel("bookmark-command-fixture".into()).unwrap();
    release_tx.send(()).unwrap();
    let (receipt, generation) = operation.await.unwrap().unwrap();
    assert_eq!(receipt.mapping, mapping());
    assert_eq!(admission::root(&receipt).unwrap(), generation);
    assert_eq!(command.check().unwrap_err(), "canceled");
    // An independent, uncanceled Context proves the acknowledged mapping is
    // actually durable and admission-consistent, even with automatic updates Off.
    reader.storage(Some(generation), move |store, check| {
        check()?;
        store.with_guide_read(|c| {
            admission::verify(c, &receipt, receipt.source_revision, true)?;
            let count: i64 = c.query_row("SELECT count(*) FROM guide_mapping WHERE catalog_source_id='catalog' AND app_channel_id='channel' AND guide_source_id='guide' AND xmltv_channel_id='selected'", [], |r| r.get(0)).map_err(|_| "fixture-query")?;
            assert_eq!(count, 1);
            let automatic: Option<i64> = c.query_row("SELECT automatic_guide_updates FROM metadata WHERE singleton=1", [], |r| r.get(0)).map_err(|_| "fixture-query")?;
            assert_eq!(automatic, Some(0));
            Ok(())
        })
    }).await.unwrap();
}
