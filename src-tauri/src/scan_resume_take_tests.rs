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

#[tokio::test]
async fn actual_first_ack_cooling_waits_then_takes_only_remaining_work_for_both_protocols() {
    use std::{cell::Cell, rc::Rc};
    for version in [1, 2] {
        for retry_after in [0, 60_000] {
            let (registry, store, _dir, request, started) =
                first_ack_with_cooling(retry_after, version).await;
            let clock = Rc::new(Cell::new(started));
            let read = clock.clone();
            let advance = clock.clone();
            let waits = Rc::new(Cell::new(0u64));
            let waited = waits.clone();
            let storage = store.clone();
            let reply = take_with_timing(
                request.clone_for_test(),
                registry.acquire(&request.plan_id).unwrap(),
                move |f, j, d, i| hydrate(storage.clone(), f, j, d, i),
                || Ok(()),
                move || read.get(),
                move |delay| {
                    advance.set(advance.get() + delay);
                    waited.set(waited.get() + delay);
                    std::future::ready(())
                },
            )
            .await
            .unwrap();
            assert!(waits.get() >= 350.max(retry_after));
            assert_eq!(reply.rows.len(), 1);
            assert_eq!(
                reply.rows[0].row.candidate_index, 1,
                "acknowledged key must never be reprobed"
            );
            assert_eq!(reply.capacity_blocked, None);
            assert_eq!(
                serde_json::to_value(&reply)
                    .unwrap()
                    .as_object()
                    .unwrap()
                    .len(),
                4,
                "wire shape is unchanged"
            );
            registry.close(&request.plan_id).await.unwrap();
        }
    }
}

#[tokio::test]
async fn cooling_cancel_and_backwards_clock_release_take_without_losing_durable_ack() {
    use std::{cell::Cell, rc::Rc};
    for backwards in [false, true] {
        let (registry, store, _dir, request, started) = first_ack_with_cooling(60_000, 2).await;
        let clock = Rc::new(Cell::new(started));
        let read = clock.clone();
        let advance = clock.clone();
        let canceled = Rc::new(Cell::new(false));
        let checked = canceled.clone();
        let cancel = canceled.clone();
        let storage = store.clone();
        let error = take_with_timing(
            request.clone_for_test(),
            registry.acquire(&request.plan_id).unwrap(),
            move |f, j, d, i| hydrate(storage.clone(), f, j, d, i),
            move || {
                if checked.get() {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
            move || read.get(),
            move |_| {
                if backwards {
                    advance.set(started - 1)
                } else {
                    cancel.set(true)
                };
                std::future::ready(())
            },
        )
        .await
        .err()
        .unwrap();
        assert_eq!(
            error,
            if backwards {
                "scan-resume-clock-invalid"
            } else {
                "canceled"
            }
        );
        registry
            .acquire(&request.plan_id)
            .unwrap()
            .with(|e| {
                assert!(!e.taking);
                assert!(e.cache.is_empty());
                assert_eq!(e.plan.counts().checked, 1);
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store.read_scan_checkpoint().unwrap().checkpoint_revision,
            "2"
        );
        let storage = store.clone();
        let reply = take_with_timing(
            request.clone_for_test(),
            registry.acquire(&request.plan_id).unwrap(),
            move |f, j, d, i| hydrate(storage.clone(), f, j, d, i),
            || Ok(()),
            move || started + 60_000,
            |_| std::future::ready(()),
        )
        .await
        .unwrap();
        assert_eq!(reply.rows[0].row.candidate_index, 1);
        registry.close(&request.plan_id).await.unwrap();
    }
}

#[tokio::test]
async fn cooling_nonadvancing_clock_has_bounded_owned_wait_and_no_hydration() {
    let (registry, store, _dir, request, started) = first_ack_with_cooling(60_000, 2).await;
    let waited = std::cell::Cell::new(0u64);
    let error = take_with_timing(
        request.clone_for_test(),
        registry.acquire(&request.plan_id).unwrap(),
        |_, _, _, _| std::future::ready(Err("fixture-must-not-hydrate".into())),
        || Ok(()),
        move || started,
        |delay| {
            waited.set(waited.get() + delay);
            std::future::ready(())
        },
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error, "scan-resume-clock-invalid");
    assert_eq!(waited.get(), 60_000);
    registry
        .acquire(&request.plan_id)
        .unwrap()
        .with(|e| {
            assert!(!e.taking);
            assert!(e.cache.is_empty());
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "2"
    );
    registry.close(&request.plan_id).await.unwrap();
}

#[tokio::test]
async fn real_cooling_timer_cancellation_is_joined_and_releases_take_owner() {
    let (registry, store, _dir, request, _) = first_ack_with_cooling(60_000, 2).await;
    let canceled = Arc::new(AtomicBool::new(false));
    let checked = canceled.clone();
    let worker_registry = registry.clone();
    let storage = store.clone();
    let next = request.clone_for_test();
    let task = tokio::spawn(async move {
        take_with(
            next,
            worker_registry.acquire(&"a".repeat(64)).unwrap(),
            move |f, j, d, i| hydrate(storage.clone(), f, j, d, i),
            move || {
                if checked.load(Ordering::SeqCst) {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
        )
        .await
    });
    loop {
        if registry
            .acquire(&request.plan_id)
            .unwrap()
            .with(|e| Ok(e.taking))
            .unwrap()
        {
            break;
        }
        tokio::task::yield_now().await;
    }
    canceled.store(true, Ordering::SeqCst);
    assert_eq!(task.await.unwrap().err().unwrap(), "canceled");
    registry
        .acquire(&request.plan_id)
        .unwrap()
        .with(|e| {
            assert!(!e.taking);
            assert!(e.cache.is_empty());
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "2"
    );
    registry.close(&request.plan_id).await.unwrap();
}
#[tokio::test]
async fn actual_pages_cache_only_selected_rows_and_authenticate_origin() {
    let (registry, store, _dir) = fixture();
    let storage = store.clone();
    let reply = take_with(
        request(),
        registry.acquire("fixture-plan").unwrap(),
        move |f, j, d, i| hydrate(storage.clone(), f, j, d, i),
        || Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(reply.rows.len(), 16);
    assert!(serde_json::to_vec(&reply).unwrap().len() <= RESPONSE_BYTES);
    let lease = registry.acquire("fixture-plan").unwrap();
    lease
        .with(|episode| {
            assert_eq!(episode.cache.len(), 16);
            assert!(!episode.taking);
            assert!(episode.cache_bytes <= CACHE_BYTES);
            for row in &reply.rows {
                let cached = &episode.cache[&row.row.candidate_index];
                assert_eq!(cached.reservation.id, row.reservation_id);
                episode.plan.verify_original(
                    cached.reservation.ordinal,
                    &cached.metadata,
                    &vec![cached.row.candidate["channel"]["urls"][0]
                        .as_str()
                        .unwrap()
                        .to_owned()],
                )?;
                assert_eq!(token(&cached.reservation.origin), row.origin_token);
            }
            Ok(())
        })
        .unwrap();
    drop(lease);
    registry.close("fixture-plan").await.unwrap();
}
#[tokio::test]
async fn cancellation_after_actual_decrypt_releases_all_unreturned_and_resets_take() {
    let (registry, store, _dir) = fixture();
    let canceled = Arc::new(AtomicBool::new(false));
    let changed = canceled.clone();
    let checked = canceled.clone();
    let result = take_with(
        request(),
        registry.acquire("fixture-plan").unwrap(),
        move |f, j, d, i| {
            let store = store.clone();
            let changed = changed.clone();
            async move {
                let page = hydrate(store, f, j, d, i).await?;
                changed.store(true, Ordering::SeqCst);
                Ok(page)
            }
        },
        move || {
            if checked.load(Ordering::SeqCst) {
                Err("canceled".into())
            } else {
                Ok(())
            }
        },
    )
    .await;
    assert!(matches!(result,Err(e)if e=="canceled"));
    let lease = registry.acquire("fixture-plan").unwrap();
    lease
        .with(|episode| {
            assert!(!episode.taking);
            assert!(episode.cache.is_empty());
            assert_eq!(episode.cache_bytes, 0);
            assert_eq!(
                episode
                    .scheduler
                    .reserve(16, &[], now(), crate::scan_resume_runtime::plan_id)?
                    .len(),
                16
            );
            Ok(())
        })
        .unwrap();
    drop(lease);
    registry.close("fixture-plan").await.unwrap();
}
#[tokio::test]
async fn held_crypto_keeps_registry_close_waiting_until_actual_settlement() {
    let (registry, store, _dir) = fixture();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let mut entered = Some(entered_tx);
    let mut release = Some(release_rx);
    let lease = registry.acquire("fixture-plan").unwrap();
    let task = tokio::spawn(take_with(
        request(),
        lease,
        move |f, j, d, i| {
            let store = store.clone();
            let entered = entered.take();
            let release = release.take();
            async move {
                if let Some(entered) = entered {
                    entered.send(()).unwrap();
                }
                if let Some(release) = release {
                    release.await.unwrap();
                }
                hydrate(store, f, j, d, i).await
            }
        },
        || Ok(()),
    ));
    entered_rx.await.unwrap();
    let competing = take_with(
        request(),
        registry.acquire("fixture-plan").unwrap(),
        |_, _, _, _| async { Err("unexpected-hydration".into()) },
        || Ok(()),
    )
    .await;
    assert!(matches!(competing, Err(e) if e=="scan-resume-take-busy"));
    let closer = registry.clone();
    let closing = tokio::spawn(async move { closer.close("fixture-plan").await });
    tokio::task::yield_now().await;
    assert!(!closing.is_finished());
    release_tx.send(()).unwrap();
    assert!(matches!(task.await.unwrap(),Err(e)if e=="canceled"));
    closing.await.unwrap().unwrap();
    assert!(registry.acquire("fixture-plan").is_err());
}
#[tokio::test]
async fn changed_origin_binding_refuses_and_releases_whole_unreturned_batch() {
    let (registry, store, _dir) = fixture();
    registry
        .acquire("fixture-plan")
        .unwrap()
        .with(|episode| {
            episode.origins.get_mut(&0).unwrap().origin_token[0] ^= 1;
            Ok(())
        })
        .unwrap();
    let result = take_with(
        request(),
        registry.acquire("fixture-plan").unwrap(),
        move |f, j, d, i| hydrate(store.clone(), f, j, d, i),
        || Ok(()),
    )
    .await;
    assert!(matches!(result,Err(e)if e=="scan-origin-binding-mismatch"));
    registry
        .acquire("fixture-plan")
        .unwrap()
        .with(|episode| {
            assert!(!episode.taking);
            assert!(episode.cache.is_empty());
            assert_eq!(
                episode
                    .scheduler
                    .reserve(16, &[], now(), crate::scan_resume_runtime::plan_id)?
                    .len(),
                16
            );
            Ok(())
        })
        .unwrap();
    registry.close("fixture-plan").await.unwrap();
}
#[tokio::test]
async fn cache_budget_failure_and_malformed_request_do_not_leak_reservations() {
    let (registry, store, _dir) = fixture();
    registry
        .acquire("fixture-plan")
        .unwrap()
        .with(|episode| {
            episode.cache_bytes = CACHE_BYTES;
            Ok(())
        })
        .unwrap();
    let result = take_with(
        request(),
        registry.acquire("fixture-plan").unwrap(),
        move |f, j, d, i| hydrate(store.clone(), f, j, d, i),
        || Ok(()),
    )
    .await;
    assert!(matches!(result,Err(e)if e=="scan-resume-cache-full"));
    registry
        .acquire("fixture-plan")
        .unwrap()
        .with(|episode| {
            assert!(!episode.taking);
            assert!(episode.cache.is_empty());
            assert_eq!(
                episode
                    .scheduler
                    .reserve(16, &[], now(), crate::scan_resume_runtime::plan_id)?
                    .len(),
                16
            );
            Ok(())
        })
        .unwrap();
    assert!(serde_json::from_value::<Take>(json!({"schemaVersion":1,"planId":"fixture-plan","limit":16,"blockedOrigins":[],"unexpected":true})).is_err());
    assert!(origin(&"A".repeat(64)).is_err());
    assert!(origin(&"0".repeat(63)).is_err());
    registry.close("fixture-plan").await.unwrap();
}

#[tokio::test]
async fn negotiated_byte_pressure_releases_unreturned_and_legacy_still_refuses() {
    let (registry, store, _dir) = fixture();
    let storage = store.clone();
    take_with(
        request(),
        registry.acquire("fixture-plan").unwrap(),
        move |f, j, d, i| hydrate(storage.clone(), f, j, d, i),
        || Ok(()),
    )
    .await
    .unwrap();
    registry
        .acquire("fixture-plan")
        .unwrap()
        .with(|e| {
            e.cache_bytes = CACHE_BYTES;
            Ok(())
        })
        .unwrap();
    let mut v2 = request();
    v2.schema_version = 2;
    v2.take_timing_version = Some(1);
    let storage = store.clone();
    let reply = take_with(
        v2,
        registry.acquire("fixture-plan").unwrap(),
        move |f, j, d, i| hydrate(storage.clone(), f, j, d, i),
        || Ok(()),
    )
    .await
    .unwrap();
    assert!(reply.rows.is_empty());
    assert!(!reply.exhausted);
    assert_eq!(reply.capacity_blocked, Some(true));
    // Artificial byte saturation isolates budget handling; encrypted page/metadata/origin are real fixture bindings.
    let storage = store.clone();
    assert_eq!(
        take_with(
            request(),
            registry.acquire("fixture-plan").unwrap(),
            move |f, j, d, i| hydrate(storage.clone(), f, j, d, i),
            || Ok(())
        )
        .await
        .err()
        .unwrap(),
        "scan-resume-cache-full"
    );
    let lease = registry.acquire("fixture-plan").unwrap();
    lease
        .with(|e| {
            assert!(!e.taking);
            assert_eq!(e.cache.len(), 16);
            assert_eq!(
                e.scheduler
                    .reserve(16, &[], now(), crate::scan_resume_runtime::plan_id)?
                    .len(),
                16
            );
            Ok(())
        })
        .unwrap();
    drop(lease);
    registry.close("fixture-plan").await.unwrap();
}

#[tokio::test]
async fn negotiated_take_clamps_last_slot_and_reports_full_capacity_without_hydration() {
    let (registry, store, _dir) = fixture_count(257);
    for round in 0..16 {
        let mut r = request();
        r.schema_version = 2;
        if round == 0 {
            r.limit = 15;
        }
        let storage = store.clone();
        let response = take_with(
            r,
            registry.acquire("fixture-plan").unwrap(),
            move |f, j, d, i| hydrate(storage.clone(), f, j, d, i),
            || Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(response.rows.len(), if round == 0 { 15 } else { 16 });
    }
    assert_eq!(
        take_with(
            request(),
            registry.acquire("fixture-plan").unwrap(),
            |_, _, _, _| async { panic!("legacy capacity refusal must not hydrate") },
            || Ok(())
        )
        .await
        .err()
        .unwrap(),
        "scan-resume-cache-full"
    );
    let mut r = request();
    r.schema_version = 2;
    let storage = store.clone();
    let response = take_with(
        r,
        registry.acquire("fixture-plan").unwrap(),
        move |f, j, d, i| hydrate(storage.clone(), f, j, d, i),
        || Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(response.rows.len(), 1);
    let mut r = request();
    r.schema_version = 2;
    r.take_timing_version = Some(1);
    let response = take_with(
        r,
        registry.acquire("fixture-plan").unwrap(),
        |_, _, _, _| async { panic!("full cache must not hydrate") },
        || Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(response.capacity_blocked, Some(true));
    assert!(response.rows.is_empty());
    assert!(!response.exhausted);
    registry
        .acquire("fixture-plan")
        .unwrap()
        .with(|e| {
            assert_eq!(e.cache.len(), 256);
            assert!(!e.taking);
            Ok(())
        })
        .unwrap();
    registry.close("fixture-plan").await.unwrap();
}

#[tokio::test]
async fn negotiated_timing_distinguishes_cooling_with_retained_observation_from_capacity() {
    for retry in [350, 60_000] {
        let (registry, store, _dir, mut r, started) =
            first_ack_with_cooling_count(retry, 2, 4).await;
        r.take_timing_version = Some(1);
        let reply = take_with_timing(
            r.clone_for_test(),
            registry.acquire(&r.plan_id).unwrap(),
            |_, _, _, _| async { panic!("cooling must not hydrate") },
            || Ok(()),
            || started,
            |_| async { panic!("negotiated cooling must return an owned shared hint") },
        )
        .await
        .unwrap();
        assert!(reply.rows.is_empty());
        assert!(!reply.exhausted);
        assert_eq!(reply.capacity_blocked, None);
        assert_eq!(reply.cooling_delay_ms, Some(retry));
        let storage = store.clone();
        let page = take_with_timing(
            r.clone_for_test(),
            registry.acquire(&r.plan_id).unwrap(),
            move |f, j, d, i| hydrate(storage.clone(), f, j, d, i),
            || Ok(()),
            || started + retry,
            |_| async { panic!("eligible work must not wait") },
        )
        .await
        .unwrap();
        assert_eq!(page.rows[0].row.candidate_index, 1);
        let cooling_at = now();
        registry.acquire(&r.plan_id).unwrap().with(|e| {
            let id=e.cache[&1].reservation.id.clone();
            e.scheduler.start_probe(&id)?; e.scheduler.finish_probe(&id,cooling_at,retry)?;
            let held=e.cache.get_mut(&1).unwrap();
            held.observation=Some(json!({"channelId":held.metadata["key"],"sourceId":held.metadata["sourceId"],"fingerprint":held.metadata["sourceFingerprint"],"platform":"android","observedAt":cooling_at,"verdict":"Timeout","evidence":{"kind":"timeout"}}));
            let bytes=serde_json::to_vec(held.observation.as_ref().unwrap()).unwrap().len();
            held.bytes+=bytes; e.cache_bytes+=bytes;
            Ok(())
        }).unwrap();
        let reply = take_with_timing(
            r.clone_for_test(),
            registry.acquire(&r.plan_id).unwrap(),
            |_, _, _, _| async { panic!("retained cooling must not hydrate") },
            || Ok(()),
            || cooling_at,
            |_| async { panic!("retained cooling must not wait or force commit") },
        )
        .await
        .unwrap();
        assert_eq!(reply.cooling_delay_ms, Some(retry));
        assert_eq!(reply.capacity_blocked, None);
        assert_eq!(
            serde_json::to_value(&reply)
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            5
        );
        registry
            .acquire(&r.plan_id)
            .unwrap()
            .with(|e| {
                assert_eq!(e.cache.len(), 1);
                assert!(!e.taking);
                assert_eq!(e.plan.counts().checked, 1);
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store.read_scan_checkpoint().unwrap().checkpoint_revision,
            "2"
        );
        registry.close(&r.plan_id).await.unwrap();
    }
}
#[tokio::test]
async fn timing_opt_in_requires_supported_version_and_window_and_releases_on_cancel() {
    for (schema, timing) in [(1, 1), (2, 0), (2, 2)] {
        let (registry, _store, _dir) = fixture();
        let mut r = request();
        r.schema_version = schema;
        r.take_timing_version = Some(timing);
        assert_eq!(
            take_with(
                r,
                registry.acquire("fixture-plan").unwrap(),
                |_, _, _, _| async { panic!("malformed timing must not hydrate") },
                || Ok(())
            )
            .await
            .err()
            .unwrap(),
            ERR
        );
        registry.close("fixture-plan").await.unwrap();
    }
    let (registry, store, _dir, mut r, started) = first_ack_with_cooling(60_000, 2).await;
    r.take_timing_version = Some(1);
    let canceled = std::cell::Cell::new(false);
    let result = take_with_timing(
        r.clone_for_test(),
        registry.acquire(&r.plan_id).unwrap(),
        |_, _, _, _| async { panic!("canceled timing must not hydrate") },
        || {
            if canceled.get() {
                Err("canceled".into())
            } else {
                Ok(())
            }
        },
        || {
            canceled.set(true);
            started
        },
        |_| std::future::ready(()),
    )
    .await;
    assert_eq!(result.err().unwrap(), "canceled");
    registry
        .acquire(&r.plan_id)
        .unwrap()
        .with(|e| {
            assert!(!e.taking);
            assert!(e.cache.is_empty());
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "2"
    );
    registry.close(&r.plan_id).await.unwrap();
    for timing in [json!(1.5), json!(-1), json!("1"), json!(256)] {
        assert!(serde_json::from_value::<Take>(json!({"schemaVersion":2,"planId":"fixture-plan","limit":16,"blockedOrigins":[],"takeTimingVersion":timing})).is_err());
    }
}

async fn cached_fixture_hydrate(
    cache: Arc<tokio::sync::Mutex<Option<CachedResumePage>>>,
    store: Arc<PairStore>,
    fence: Fence,
    job: String,
    digest: String,
    index: usize,
    decrypts: Arc<std::sync::atomic::AtomicUsize>,
) -> Result<AuthenticatedPage, String> {
    let old = cache.lock().await.take();
    let acquire_store = store.clone();
    let acquire_job = job.clone();
    let acquire_digest = digest.clone();
    let verify_job = job.clone();
    let verify_digest = digest.clone();
    let (page, selected) = request_local_page(
        old,
        fence,
        &job,
        &digest,
        index,
        move || async move {
            let proof = acquire_store.prepare_scan_resume_page(
                fence,
                &acquire_job,
                &acquire_digest,
                index,
                || Ok(()),
            )?;
            decrypts.fetch_add(1, Ordering::SeqCst);
            let plaintext = xor(&proof.encrypted_page.ciphertext);
            acquire_store.finish_cached_scan_resume_page(proof, plaintext, || Ok(()))
        },
        move |page| async move {
            let selected = store.verify_cached_scan_resume_page(
                &page,
                fence,
                &verify_job,
                &verify_digest,
                index,
                || Ok(()),
            )?;
            Ok((page, selected))
        },
    )
    .await?;
    *cache.lock().await = Some(page);
    Ok(selected)
}
#[tokio::test]
async fn one_take_sixteen_same_page_reservations_decrypt_once_and_drop_request_cache() {
    let (registry, store, _dir) = fixture_count(65);
    let cache = Arc::new(tokio::sync::Mutex::new(None));
    let weak = Arc::downgrade(&cache);
    let decrypts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = decrypts.clone();
    let reply = take_with(
        request(),
        registry.acquire("fixture-plan").unwrap(),
        move |f, j, d, i| {
            cached_fixture_hydrate(cache.clone(), store.clone(), f, j, d, i, counted.clone())
        },
        || Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(reply.rows.len(), 16);
    assert_eq!(decrypts.load(Ordering::SeqCst), 1);
    assert!(weak.upgrade().is_none());
    assert_eq!(
        reply
            .rows
            .iter()
            .map(|r| r.row.candidate_index)
            .collect::<Vec<_>>(),
        (0..16).collect::<Vec<_>>()
    );
    registry.close("fixture-plan").await.unwrap();
}
#[tokio::test]
async fn request_local_single_page_replaces_at_boundary_and_never_reuses_after_new_take() {
    let (registry, store, _dir) = fixture_count(130);
    let cache = Arc::new(tokio::sync::Mutex::new(None));
    let decrypts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let lease = registry.acquire("fixture-plan").unwrap();
    let (fence, job, digest) = lease
        .with(|e| {
            Ok((
                e.plan.fence(),
                e.plan.header()["jobId"].as_str().unwrap().to_owned(),
                e.plan.header()["reviewDigest"].as_str().unwrap().to_owned(),
            ))
        })
        .unwrap();
    drop(lease);
    for i in 56..72 {
        let page = cached_fixture_hydrate(
            cache.clone(),
            store.clone(),
            fence,
            job.clone(),
            digest.clone(),
            i,
            decrypts.clone(),
        )
        .await
        .unwrap();
        assert_eq!(page.page.entries.len(), 1);
        assert_eq!(page.page.entries[0].candidate_index, i);
    }
    assert_eq!(decrypts.load(Ordering::SeqCst), 2);
    // Single MRU page: revisiting the previous page must decrypt afresh.
    cached_fixture_hydrate(
        cache.clone(),
        store.clone(),
        fence,
        job.clone(),
        digest.clone(),
        56,
        decrypts.clone(),
    )
    .await
    .unwrap();
    assert_eq!(decrypts.load(Ordering::SeqCst), 3);
    drop(cache);
    let fresh = Arc::new(tokio::sync::Mutex::new(None));
    cached_fixture_hydrate(fresh, store, fence, job, digest, 56, decrypts.clone())
        .await
        .unwrap();
    assert_eq!(decrypts.load(Ordering::SeqCst), 4);
    registry.close("fixture-plan").await.unwrap();
}
#[tokio::test]
async fn cached_take_byte_pressure_and_cancel_release_all_unreturned_ownership() {
    for cancel in [false, true] {
        let (registry, store, _dir) = fixture_count(65);
        let cache = Arc::new(tokio::sync::Mutex::new(None));
        let weak = Arc::downgrade(&cache);
        let decrypts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let canceled = Arc::new(AtomicBool::new(false));
        let changed = canceled.clone();
        let checking = canceled.clone();
        let reg = registry.clone();
        let mut r = request();
        r.schema_version = 2;
        r.take_timing_version = Some(1);
        let result = take_with(
            r,
            registry.acquire("fixture-plan").unwrap(),
            move |f, j, d, i| {
                let cache = cache.clone();
                let store = store.clone();
                let decrypts = decrypts.clone();
                let changed = changed.clone();
                let reg = reg.clone();
                async move {
                    let page = cached_fixture_hydrate(cache, store, f, j, d, i, decrypts).await?;
                    if cancel {
                        changed.store(true, Ordering::SeqCst);
                    } else {
                        reg.acquire("fixture-plan")?.with(|e| {
                            e.cache_bytes = CACHE_BYTES;
                            Ok(())
                        })?;
                    }
                    Ok(page)
                }
            },
            move || {
                if checking.load(Ordering::SeqCst) {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
        )
        .await;
        assert_eq!(
            result.err().unwrap(),
            if cancel {
                "canceled"
            } else {
                "scan-resume-candidate-too-large"
            }
        );
        assert!(weak.upgrade().is_none());
        registry
            .acquire("fixture-plan")
            .unwrap()
            .with(|e| {
                assert!(!e.taking);
                assert!(e.cache.is_empty());
                assert_eq!(
                    e.scheduler
                        .reserve(16, &[], now(), crate::scan_resume_runtime::plan_id)?
                        .len(),
                    16
                );
                Ok(())
            })
            .unwrap();
        registry.close("fixture-plan").await.unwrap();
    }
}
