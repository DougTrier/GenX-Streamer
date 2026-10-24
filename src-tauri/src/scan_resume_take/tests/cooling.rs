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

//! Scan resume take tests: the cooling period after the first acknowledgement.

use super::*;

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
