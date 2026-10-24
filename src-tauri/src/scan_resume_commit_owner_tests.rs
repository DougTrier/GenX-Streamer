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

//! Controlled native cache + actual SQLite core. No device/crypto/network acceptance.
use super::*;
use crate::{
    scan_checkpoint,
    scan_resume_owner::{Scheduler, Work},
    scan_resume_runtime::HeldCandidate,
    storage_transaction::{PairStore, RecordPair},
};
struct Fixture {
    _dir: tempfile::TempDir,
    store: PairStore,
    registry: Arc<Registry<Episode>>,
    request: Commit,
}
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let store = PairStore::new(dir.path().into()).unwrap();
    let source = json!({"id":"s","name":"Fixture","kind":"url","location":"https://fixture.invalid/index.m3u"});
    let catalog = json!({"schemaVersion":1,"sources":[source.clone()],"channels":[]});
    let prefs = json!({"schemaVersion":1,"sources":[source.clone()],"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":360.0,"automaticGuideUpdates":false});
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    let pair = store.read_pair().unwrap();
    let catalog: Value = serde_json::from_str(pair.catalog.as_ref().unwrap()).unwrap();
    let prefs: Value = serde_json::from_str(pair.preferences.as_ref().unwrap()).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let candidates:Vec<_>=(0..2).map(|i|json!({"key":format!("key-{i}"),"sourceId":"s","sourceFingerprint":"capture","sessionRevision":"session","channel":{"sourceId":"s","providerId":format!("provider-{i}"),"name":format!("Station {i}"),"category":"News","urls":[format!("https://fixture.invalid/{i}.m3u8")]}})).collect();
    let mut raw = json!({"schemaVersion":1,"jobId":"owned-commit-fixture","createdAtMs":now,"catalogRevision":"1","sourceDefinitions":[{"source":source.clone(),"definitionFingerprint":scan_checkpoint::source_fingerprint(&source).unwrap()}],"budgetMs":20000,"platform":"android","observerProfile":"fixture","review":{"sessionRevision":"session","query":"","status":"completed","sources":[{"sourceId":"s","fingerprint":"capture","status":"completed","inspected":2,"matched":2,"warnings":0}],"candidates":candidates,"counts":{"inspected":2,"matched":2,"failedSources":0,"canceledSources":0}},"observations":[],"publishedKeys":[]});
    raw["policyFingerprint"] = json!(scan_checkpoint::policy_fingerprint(&raw, &prefs).unwrap());
    let raw = scan_checkpoint::packed_fixture(&raw);
    store
        .write_pair_with_scan(
            &RecordPair::default(),
            None,
            (Some("1"), Some("0")),
            Some((
                &scan_checkpoint::Mutation::Save {
                    checkpoint: raw.to_string(),
                },
                "0",
            )),
            || Ok(()),
        )
        .unwrap();
    let plan = Plan::admit(
        &raw.to_string(),
        scan_checkpoint::resume_plan::Context {
            catalog: &catalog,
            preferences: &prefs,
            fence: Fence {
                root_generation: 7,
                catalog: 1,
                health: 0,
                checkpoint: 1,
            },
            now,
            platform: "android",
            observer_profile: "fixture",
        },
        &mut || Ok(()),
    )
    .unwrap();
    let mut scheduler =
        Scheduler::new([(0, [0; 32], Work::Probe), (1, [1; 32], Work::Probe)]).unwrap();
    let mut nonce = 0;
    let reservations = scheduler
        .reserve(2, &[], now, || {
            nonce += 1;
            Ok(format!("{nonce:064x}"))
        })
        .unwrap();
    let mut cache = std::collections::HashMap::new();
    let mut observations = Vec::new();
    for reservation in reservations {
        let i = reservation.ordinal;
        scheduler.start_probe(&reservation.id).unwrap();
        scheduler.finish_probe(&reservation.id, now, 0).unwrap();
        let observation = json!({"channelId":format!("key-{i}"),"sourceId":"s","fingerprint":"capture","platform":"android","observedAt":now,"verdict":"Reachable","evidence":{"kind":"recognized-media-response"}});
        observations.push(Observation {
            candidate_index: i,
            observation: observation.clone(),
        });
        cache.insert(
            i,
            HeldCandidate {
                reservation,
                row: scan_checkpoint::resume_plan::Row {
                    candidate_index: i,
                    candidate: candidates[i].clone(),
                    work: "probe",
                    observation: None,
                },
                metadata: scan_checkpoint::resume_candidate(&raw, i).unwrap(),
                observation: Some(observation),
                bytes: 100,
            },
        );
    }
    let episode = Episode {
        plan,
        scheduler,
        origins: std::collections::HashMap::new(),
        cache,
        cache_bytes: 200,
        taking: false,
        latest_projection: None,
        quarantined: false,
        transport_memo: Default::default(),
        origin_failures: Default::default(),
    };
    let registry = Arc::new(Registry::default());
    let id = "a".repeat(64);
    registry
        .begin("commit-fixture")
        .unwrap()
        .install(&id, episode)
        .unwrap();
    Fixture {
        _dir: dir,
        store,
        registry,
        request: Commit {
            schema_version: 1,
            plan_id: id,
            expected_revisions: Revisions {
                catalog_revision: "1".into(),
                health_revision: "0".into(),
                checkpoint_revision: "1".into(),
            },
            observations,
            publication_indices: vec![0, 1],
        },
    }
}
fn execute_actual(f: &Fixture) -> Result<Value, String> {
    let lease = f.registry.acquire(&f.request.plan_id)?;
    execute(&lease, &f.request, |plan, rows| {
        f.store
            .commit_scan_resume_selection(plan, 7, rows, || lease.check())
    })
}
#[test]
fn actual_sql_ack_advances_plan_once_and_retires_only_committed_cache() {
    let f = fixture();
    let ack = execute_actual(&f).unwrap();
    assert_eq!(ack["committed"], true);
    assert_eq!(
        ack["counts"],
        json!({"total":2,"checked":2,"responded":2,"published":2})
    );
    assert_eq!(ack["checkpointRevision"], "2");
    assert_eq!(ack.as_object().unwrap().len(), 8);
    let lease = f.registry.acquire(&f.request.plan_id).unwrap();
    lease
        .with(|e| {
            assert_eq!(
                serde_json::to_value(e.plan.counts()).unwrap(),
                ack["counts"]
            );
            assert!(e.cache.is_empty());
            assert_eq!(e.cache_bytes, 0);
            assert!(!e.quarantined);
            assert_eq!(e.latest_projection.as_ref().unwrap().channels().len(), 2);
            Ok(())
        })
        .unwrap();
    let pair = f.store.read_pair().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(pair.catalog.as_ref().unwrap()).unwrap()["channels"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(execute_actual(&f).is_err());
    assert_eq!(f.store.read_pair().unwrap(), pair);
}
#[test]
fn forged_observation_index_fence_and_unjoined_probe_refuse_before_dispatch() {
    for reason in [
        "echo",
        "index",
        "fence",
        "publication",
        "duplicate",
        "metadata",
        "active",
        "bytes",
    ] {
        let mut f = fixture();
        let before = f.store.read_snapshot().unwrap();
        let lease = f.registry.acquire(&f.request.plan_id).unwrap();
        match reason {
            "echo" => f.request.observations[0].observation["observedAt"] = json!(0),
            "index" => f.request.observations[0].candidate_index = 9,
            "fence" => f.request.expected_revisions.checkpoint_revision = "0".into(),
            "publication" => f.request.publication_indices = vec![9],
            "duplicate" => f.request.publication_indices = vec![0, 0],
            "metadata" => {
                lease
                    .with(|e| {
                        e.cache.get_mut(&0).unwrap().metadata["key"] = json!("foreign");
                        Ok(())
                    })
                    .unwrap();
            }
            "active" => {
                lease
                    .with(|e| {
                        let mut s =
                            Scheduler::new([(0, [0; 32], Work::Probe), (1, [1; 32], Work::Probe)])?;
                        let mut n = 0;
                        let rs = s.reserve(2, &[], 0, || {
                            n += 1;
                            Ok(format!("{n:064x}"))
                        })?;
                        for r in rs {
                            s.start_probe(&r.id)?;
                        }
                        e.scheduler = s;
                        Ok(())
                    })
                    .unwrap();
            }
            "bytes" => {
                lease
                    .with(|e| {
                        e.cache_bytes = 0;
                        Ok(())
                    })
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let mut dispatched = 0;
        assert!(
            execute(&lease, &f.request, |_, _| {
                dispatched += 1;
                Err("should-not-write".into())
            })
            .is_err(),
            "{reason}"
        );
        assert_eq!(dispatched, 0, "{reason}");
        assert_eq!(f.store.read_snapshot().unwrap().pair, before.pair);
    }
}
#[test]
fn actual_sql_failure_preserves_cache_and_checkpoint_without_ack() {
    let f = fixture();
    let before = f.store.read_snapshot().unwrap();
    let cp = f.store.read_scan_checkpoint().unwrap();
    let lease = f.registry.acquire(&f.request.plan_id).unwrap();
    let mut checks = 0;
    let result = execute(&lease, &f.request, |plan, rows| {
        f.store.commit_scan_resume_selection(plan, 7, rows, || {
            checks += 1;
            if checks == 5 {
                Err("fixture-storage-refused".into())
            } else {
                Ok(())
            }
        })
    });
    assert!(result.is_err());
    assert_eq!(f.store.read_snapshot().unwrap().pair, before.pair);
    assert_eq!(
        f.store.read_scan_checkpoint().unwrap().checkpoint_revision,
        cp.checkpoint_revision
    );
    lease
        .with(|e| {
            assert_eq!(e.cache.len(), 2);
            assert_eq!(e.cache_bytes, 200);
            assert_eq!(e.plan.counts().checked, 0);
            assert!(e.latest_projection.is_none());
            Ok(())
        })
        .unwrap();
}
#[test]
fn late_close_after_actual_commit_returns_ack_and_retires_cache() {
    let f = fixture();
    let lease = f.registry.acquire(&f.request.plan_id).unwrap();
    let ack = execute(&lease, &f.request, |plan, rows| {
        let committed = f
            .store
            .commit_scan_resume_selection(plan, 7, rows, || Ok(()))?;
        f.registry.cancel_open("commit-fixture")?;
        Ok(committed)
    })
    .unwrap();
    assert_eq!(ack["committed"], true);
    assert!(lease.check().is_err());
    lease
        .settle(|e| {
            assert!(e.cache.is_empty());
            assert_eq!(e.plan.counts().published, 2);
            Ok(())
        })
        .unwrap();
}
#[test]
fn positive_checkpoint_only_requeues_publish_without_reprobe_then_commits() {
    let mut f = fixture();
    f.request.publication_indices.clear();
    let ack = execute_actual(&f).unwrap();
    assert_eq!(
        ack["counts"],
        json!({"total":2,"checked":2,"responded":2,"published":0})
    );
    let lease = f.registry.acquire(&f.request.plan_id).unwrap();
    lease
        .with(|e| {
            let mut n = 10;
            let rows = e.scheduler.reserve(2, &[], u64::MAX, || {
                n += 1;
                Ok(format!("{n:064x}"))
            })?;
            assert_eq!(rows.len(), 2);
            for r in rows {
                assert_eq!(r.work, Work::Publish);
                let i = r.ordinal;
                let item = f
                    .request
                    .observations
                    .iter()
                    .find(|v| v.candidate_index == i)
                    .unwrap();
                let raw: Value = serde_json::from_str(
                    f.store.read_scan_checkpoint()?.checkpoint.as_ref().unwrap(),
                )
                .unwrap();
                let mut candidate = scan_checkpoint::resume_candidate(&raw, i)?;
                candidate.as_object_mut().unwrap().remove("reference");
                candidate["channel"]["urls"] = json!([format!("https://fixture.invalid/{i}.m3u8")]);
                e.cache.insert(
                    i,
                    HeldCandidate {
                        reservation: r,
                        row: scan_checkpoint::resume_plan::Row {
                            candidate_index: i,
                            candidate,
                            work: "publish",
                            observation: Some(item.observation.clone()),
                        },
                        metadata: scan_checkpoint::resume_candidate(&raw, i)?,
                        observation: Some(item.observation.clone()),
                        bytes: 100,
                    },
                );
            }
            e.cache_bytes = 200;
            Ok(())
        })
        .unwrap();
    f.request.expected_revisions.checkpoint_revision = "2".into();
    f.request.publication_indices = vec![0, 1];
    let ack = execute_actual(&f).unwrap();
    assert_eq!(
        ack["counts"],
        json!({"total":2,"checked":2,"responded":2,"published":2})
    );
    assert_eq!(ack["checkpointRevision"], "3");
}
#[test]
fn strict_transport_rejects_unknown_fields_and_noncanonical_revisions() {
    let f = fixture();
    let mut value = serde_json::to_value(&f.request).unwrap();
    value["catalogPatch"] = json!({});
    assert!(serde_json::from_value::<Commit>(value).is_err());
    let mut f = fixture();
    f.request.expected_revisions.catalog_revision = "01".into();
    assert!(validate(&f.request).is_err());
}

#[test]
fn authoritative_sql_revision_drift_refuses_unchanged_client_and_plan_fence() {
    let f = fixture();
    let c = rusqlite::Connection::open(f._dir.path().join(crate::storage_transaction::DB)).unwrap();
    c.execute(
        "UPDATE metadata SET catalog_revision=2 WHERE singleton=1",
        [],
    )
    .unwrap();
    drop(c);
    assert!(execute_actual(&f).is_err());
    let lease = f.registry.acquire(&f.request.plan_id).unwrap();
    lease
        .with(|e| {
            assert_eq!(e.cache.len(), 2);
            assert_eq!(e.plan.counts().checked, 0);
            assert!(e.latest_projection.is_none());
            Ok(())
        })
        .unwrap();
    assert_eq!(
        f.store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "1"
    );
    let catalog: Value =
        serde_json::from_str(f.store.read_pair().unwrap().catalog.as_ref().unwrap()).unwrap();
    assert!(catalog["channels"].as_array().unwrap().is_empty());
}

#[test]
fn negative_only_actual_sql_ack_updates_progress_without_fake_health_or_channels() {
    let mut f = fixture();
    f.request.publication_indices.clear();
    for item in &mut f.request.observations {
        item.observation["verdict"] = json!("TimedOut");
        item.observation["evidence"] = json!({"kind":"timeout"});
    }
    let lease = f.registry.acquire(&f.request.plan_id).unwrap();
    lease
        .with(|e| {
            for item in &f.request.observations {
                e.cache.get_mut(&item.candidate_index).unwrap().observation =
                    Some(item.observation.clone());
            }
            Ok(())
        })
        .unwrap();
    let before = f.store.read_snapshot().unwrap();
    let ack = execute_actual(&f).unwrap();
    assert_eq!(
        ack["counts"],
        json!({"total":2,"checked":2,"responded":0,"published":0})
    );
    assert_eq!(ack["catalogRevision"], "1");
    assert_eq!(ack["healthRevision"], "0");
    let after = f.store.read_snapshot().unwrap();
    assert_eq!(after.pair, before.pair);
    assert_eq!(after.health, before.health);
    lease
        .with(|e| {
            assert!(e.cache.is_empty());
            assert_eq!(e.cache_bytes, 0);
            assert!(e.latest_projection.as_ref().unwrap().channels().is_empty());
            Ok(())
        })
        .unwrap();
}

#[test]
fn negotiated_commit_validation_preserves_legacy64_and_one_mib_wire_bound() {
    let request = |version, total| Commit {
        schema_version: version,
        plan_id: "a".repeat(64),
        expected_revisions: Revisions {
            catalog_revision: "1".into(),
            health_revision: "0".into(),
            checkpoint_revision: "1".into(),
        },
        observations: (0..total)
            .map(|i| Observation {
                candidate_index: i,
                observation: json!({"channelId":format!("key-{i}"),"evidence":{"kind":"timeout"}}),
            })
            .collect(),
        publication_indices: vec![],
    };
    assert!(validate(&request(1, 64)).is_ok());
    assert!(validate(&request(1, 65)).is_err());
    assert!(validate(&request(2, 240)).is_ok());
    assert!(validate(&request(2, 241)).is_err());
    assert!(validate(&request(3, 1)).is_err());
    let mut oversized = request(2, 240);
    oversized.observations[0].observation["channelId"] = json!("x".repeat(1024 * 1024));
    assert!(validate(&oversized).is_err());
}
use std::{sync::mpsc, time::Duration};

fn actual_write_from_episode(f: &Fixture, episode: &Episode) -> Result<Committed, String> {
    let urls: Vec<Vec<String>> = f
        .request
        .observations
        .iter()
        .map(|item| {
            episode.cache[&item.candidate_index].row.candidate["channel"]["urls"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect()
        })
        .collect();
    let rows: Vec<_> = f
        .request
        .observations
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let held = &episode.cache[&item.candidate_index];
            CheckedRow {
                original_index: item.candidate_index,
                metadata: &held.metadata,
                urls: &urls[i],
                observation: held.observation.as_ref().unwrap(),
                publish: f
                    .request
                    .publication_indices
                    .contains(&item.candidate_index),
            }
        })
        .collect();
    f.store
        .commit_scan_resume_selection(&episode.plan, 7, &rows, || Ok(()))
}

#[test]
fn real_sql_old_split_unlock_exposes_stale_plan_without_stop_or_external_drift() {
    let f = fixture();
    let lease = f.registry.acquire(&f.request.plan_id).unwrap();
    // Reproduce the former execute boundary: actual SQL COMMIT under actor lock,
    // release actor, let a peer validate, and only then accept the private delta.
    let committed = lease
        .with(|episode| actual_write_from_episode(&f, episode))
        .unwrap();
    assert!(lease.check().is_ok());
    let peer = f.registry.acquire(&f.request.plan_id).unwrap();
    let stale = peer.with(|e| {
        f.store
            .validate_scan_resume_authority(e.plan.fence(), e.plan.header(), || peer.check())
    });
    assert_eq!(stale.unwrap_err(), "scan-resume-plan-stale");
    lease
        .settle(|e| e.plan.accept_delta(&committed.receipt, &committed.delta))
        .unwrap();
    peer.with(|e| {
        f.store
            .validate_scan_resume_authority(e.plan.fence(), e.plan.header(), || peer.check())
    })
    .unwrap();
    assert_eq!(
        f.store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "2"
    );
}

#[test]
fn first_peer_after_commit_unlock_observes_real_sql_and_plan_settled_together() {
    let f = fixture();
    let lease = f.registry.acquire(&f.request.plan_id).unwrap();
    let peer = f.registry.acquire(&f.request.plan_id).unwrap();
    let (start_tx, start_rx) = mpsc::sync_channel(0);
    let (result_tx, result_rx) = mpsc::sync_channel(0);
    std::thread::scope(|scope| {
        let observed_fixture = &f;
        let observed_peer = &peer;
        let observer = scope.spawn(move || {
            start_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            let result = observed_peer.with(|e| {
                assert!(e.cache.is_empty());
                assert_eq!(e.plan.counts().checked, 2);
                assert!(!e.quarantined);
                assert!(e.latest_projection.is_some());
                observed_fixture.store.validate_scan_resume_authority(
                    e.plan.fence(),
                    e.plan.header(),
                    || observed_peer.check(),
                )
            });
            result_tx.send(result).unwrap();
        });
        let ack = execute_observing_unlock(
            &lease,
            &f.request,
            |plan, rows| {
                f.store
                    .commit_scan_resume_selection(plan, 7, rows, || lease.check())
            },
            || {
                // The first instant a peer can hold the actor lock is observable;
                // do not let the commit caller proceed until real authority read ends.
                start_tx.send(()).unwrap();
                result_rx
                    .recv_timeout(Duration::from_secs(3))
                    .unwrap()
                    .unwrap();
            },
        )
        .unwrap();
        observer.join().unwrap();
        assert_eq!(ack["committed"], true);
        assert_eq!(ack["checkpointRevision"], "2");
    });
    // A genuine external SQL drift must still refuse; no broad fence rebasing.
    let c = rusqlite::Connection::open(f._dir.path().join(crate::storage_transaction::DB)).unwrap();
    c.execute(
        "UPDATE metadata SET catalog_revision=catalog_revision+1 WHERE singleton=1",
        [],
    )
    .unwrap();
    let result = peer.with(|e| {
        f.store
            .validate_scan_resume_authority(e.plan.fence(), e.plan.header(), || peer.check())
    });
    assert_eq!(result.unwrap_err(), "scan-resume-plan-stale");
}

#[test]
fn postcommit_private_settlement_failure_quarantines_without_erasing_sql_ack() {
    let f = fixture();
    let lease = f.registry.acquire(&f.request.plan_id).unwrap();
    let ack = execute(&lease, &f.request, |plan, rows| {
        let mut committed = f
            .store
            .commit_scan_resume_selection(plan, 7, rows, || lease.check())?;
        // Controlled internal proof inconsistency after a genuine COMMIT.
        committed.receipt.checkpoint_revision = None;
        Ok(committed)
    })
    .unwrap();
    assert_eq!(ack["committed"], true);
    assert_eq!(
        f.store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "2"
    );
    lease
        .settle(|e| {
            assert!(e.quarantined);
            assert!(e.cache.is_empty());
            assert_eq!(e.cache_bytes, 0);
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn actual_checkpoint_trigger_rollback_keeps_last_ack_and_native_close_joins_failed_owner() {
    let f = fixture();
    let before = f.store.read_snapshot().unwrap();
    let checkpoint = f.store.read_scan_checkpoint().unwrap();
    let sql =
        rusqlite::Connection::open(f._dir.path().join(crate::storage_transaction::DB)).unwrap();
    sql.execute_batch("CREATE TRIGGER owned_test_rollback BEFORE UPDATE OF contents ON scan_checkpoint WHEN OLD.contents IS NOT NULL AND NEW.contents IS NOT NULL BEGIN SELECT RAISE(ABORT,'owned-test-scan-refusal'); END;").unwrap();
    drop(sql);
    let lease = f.registry.acquire(&f.request.plan_id).unwrap();
    let failure = execute(&lease, &f.request, |plan, rows| {
        f.store
            .commit_scan_resume_window_selection(plan, 7, rows, || lease.check())
    });
    assert_eq!(failure.unwrap_err(), "scan-checkpoint-storage-failed");
    assert_eq!(f.store.read_snapshot().unwrap().pair, before.pair);
    assert_eq!(
        f.store.read_scan_checkpoint().unwrap().checkpoint_revision,
        checkpoint.checkpoint_revision
    );
    lease
        .with(|episode| {
            assert_eq!(episode.cache.len(), 2);
            assert_eq!(episode.cache_bytes, 200);
            assert_eq!(episode.plan.counts().checked, 0);
            assert!(episode.latest_projection.is_none());
            Ok(())
        })
        .unwrap();
    let registry = f.registry.clone();
    let plan_id = f.request.plan_id.clone();
    let closing = tokio::spawn(async move { registry.close(&plan_id).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while lease.check().is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        !closing.is_finished(),
        "close must not detach the actual failed commit lease"
    );
    drop(lease);
    tokio::time::timeout(Duration::from_secs(3), closing)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    // Retiring in-memory ownership requires neither a successful SQL write nor
    // removal of the injected trigger. Last durable progress remains intact.
    assert!(f.registry.begin("after-rollback-close").is_ok());
    assert_eq!(
        f.store.read_scan_checkpoint().unwrap().checkpoint_revision,
        checkpoint.checkpoint_revision
    );
}

#[tokio::test]
async fn actual_checkpoint_trigger_rollback_does_not_block_registry_shutdown_after_owner_drop() {
    let f = fixture();
    let sql =
        rusqlite::Connection::open(f._dir.path().join(crate::storage_transaction::DB)).unwrap();
    sql.execute_batch("CREATE TRIGGER owned_test_rollback BEFORE UPDATE OF contents ON scan_checkpoint WHEN OLD.contents IS NOT NULL AND NEW.contents IS NOT NULL BEGIN SELECT RAISE(ABORT,'owned-test-scan-refusal'); END;").unwrap();
    drop(sql);
    assert_eq!(
        execute_actual(&f).unwrap_err(),
        "scan-checkpoint-storage-failed"
    );
    tokio::time::timeout(Duration::from_secs(3), f.registry.shutdown())
        .await
        .unwrap()
        .unwrap();
    assert!(f.registry.begin("after-shutdown").is_err());
}
