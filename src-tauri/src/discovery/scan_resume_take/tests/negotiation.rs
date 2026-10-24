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

//! Scan resume take tests: negotiated byte pressure, capacity and timing.

use super::*;

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
        assert!(serde_json::from_value::<Take>(
            json!({"schemaVersion":2,"planId":"fixture-plan","limit":16,"blockedOrigins":[],"takeTimingVersion":timing})
        )
        .is_err());
    }
}
