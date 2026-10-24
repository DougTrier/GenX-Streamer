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

//! Scan resume take tests: cached pages, decryption and origin binding.

use super::*;

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
                    &[cached.row.candidate["channel"]["urls"][0]
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
    assert!(serde_json::from_value::<Take>(
        json!({"schemaVersion":1,"planId":"fixture-plan","limit":16,"blockedOrigins":[],"unexpected":true})
    )
    .is_err());
    assert!(origin(&"A".repeat(64)).is_err());
    assert!(origin(&"0".repeat(63)).is_err());
    registry.close("fixture-plan").await.unwrap();
}
