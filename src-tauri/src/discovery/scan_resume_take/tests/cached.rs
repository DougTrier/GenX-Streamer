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

//! Scan resume take tests: cached takes and same-page reservations.

use super::*;

pub(super) async fn cached_fixture_hydrate(
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
