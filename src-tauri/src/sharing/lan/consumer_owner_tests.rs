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

use super::*;
use std::time::Duration;

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(30)
}
fn owners() -> ConsumerOwners {
    let owners = ConsumerOwners::new();
    owners.register("first", deadline()).unwrap();
    owners.register("second", deadline()).unwrap();
    owners.publish(1).unwrap();
    owners
}
#[test]
fn per_viewer_media_and_control_slots_do_not_borrow_from_another_consumer() {
    let owners = owners();
    let mut first = Vec::new();
    for _ in 0..4 {
        first.push(owners.admit_media("first", 1).unwrap());
    }
    assert_eq!(
        owners.admit_media("first", 1).err(),
        Some("consumer-media-limit")
    );
    let second = owners.admit_media("second", 1).unwrap();
    let control = owners.admit_control("first").unwrap();
    assert_eq!(
        owners.admit_control("first").err(),
        Some("consumer-control-limit")
    );
    assert_eq!(owners.stats().unwrap().media_requests, 5);
    drop(first.pop());
    first.push(owners.admit_media("first", 1).unwrap());
    owners.stop().unwrap();
    owners.stop().unwrap();
    assert_eq!(
        owners.stats().unwrap(),
        ConsumerStats {
            viewers: 0,
            media_requests: 5,
            control_requests: 1
        }
    );
    drop(first);
    drop(second);
    drop(control);
    assert_eq!(
        owners.stats().unwrap(),
        ConsumerStats {
            viewers: 0,
            media_requests: 0,
            control_requests: 0
        }
    );
}
#[tokio::test]
async fn pause_cancels_old_media_permanently_but_preserves_control_and_other_viewer() {
    let owners = owners();
    let mut first = owners.admit_media("first", 1).unwrap();
    let control = owners.admit_control("first").unwrap();
    let second = owners.admit_media("second", 1).unwrap();
    owners.heartbeat("first", true, deadline()).unwrap();
    assert!(!first.valid());
    assert!(control.valid());
    assert!(second.valid());
    assert_eq!(
        owners.admit_media("first", 1).err(),
        Some("consumer-paused")
    );
    owners.heartbeat("first", false, deadline()).unwrap();
    assert!(!first.valid());
    tokio::time::timeout(Duration::from_millis(100), first.cancelled())
        .await
        .unwrap();
    let new_media = owners.admit_media("first", 1).unwrap();
    assert!(new_media.valid());
    owners.publish(2).unwrap();
    assert!(!new_media.valid());
    assert!(!second.valid());
    assert!(control.valid());
}
#[tokio::test]
async fn lease_refresh_rearms_old_deadline_without_canceling_request() {
    let owners = ConsumerOwners::new();
    let old = Instant::now() + Duration::from_millis(30);
    owners.register("viewer", old).unwrap();
    owners.publish(1).unwrap();
    let mut permit = owners.admit_media("viewer", 1).unwrap();
    // Poll the cancellation future before refresh, so it has armed the original deadline.
    {
        let wait = permit.cancelled();
        tokio::pin!(wait);
        tokio::select! {
            _ = &mut wait => panic!("fresh lease canceled"),
            _ = tokio::time::sleep(Duration::from_millis(1)) => {}
        }
        owners
            .heartbeat("viewer", false, Instant::now() + Duration::from_secs(2))
            .unwrap();
        owners.expire(old).unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(60), &mut wait)
            .await
            .is_err());
    }
    assert!(permit.valid());
    owners.revoke("viewer").unwrap();
    tokio::time::timeout(Duration::from_millis(100), permit.cancelled())
        .await
        .unwrap();
}
#[tokio::test]
async fn revoked_and_expired_tokens_cannot_resurrect_old_media_or_control() {
    let owners = owners();
    let mut media = owners.admit_media("first", 1).unwrap();
    let mut control = owners.admit_control("first").unwrap();
    owners.revoke("first").unwrap();
    owners.revoke("first").unwrap();
    owners.register("first", deadline()).unwrap();
    assert!(!media.valid());
    assert!(!control.valid());
    tokio::time::timeout(Duration::from_millis(100), media.cancelled())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_millis(100), control.cancelled())
        .await
        .unwrap();
    let replacement = owners.admit_media("first", 1).unwrap();
    drop(media);
    drop(control);
    assert!(replacement.valid());
    assert_eq!(owners.stats().unwrap().media_requests, 1);
    owners
        .expire(Instant::now() + Duration::from_secs(31))
        .unwrap();
    assert!(!replacement.valid());
    assert_eq!(
        owners.heartbeat("first", false, deadline()),
        Err("consumer-unauthorized")
    );
}
#[tokio::test]
async fn wall_clock_expiry_cancels_without_background_task_or_expire_call() {
    let owners = ConsumerOwners::new();
    owners
        .register("viewer", Instant::now() + Duration::from_millis(20))
        .unwrap();
    owners.publish(1).unwrap();
    let mut permit = owners.admit_control("viewer").unwrap();
    tokio::time::timeout(Duration::from_secs(1), permit.cancelled())
        .await
        .unwrap();
    assert!(!permit.valid());
    assert_eq!(
        owners.admit_control("viewer").err(),
        Some("consumer-unauthorized")
    );
}
#[tokio::test]
async fn publication_invalidation_and_stop_cancel_issued_requests_without_revival() {
    let owners = owners();
    let mut media = owners.admit_media("first", 1).unwrap();
    let mut control = owners.admit_control("first").unwrap();
    owners.publish(1).unwrap();
    assert!(media.valid());
    owners.invalidate_publication().unwrap();
    tokio::time::timeout(Duration::from_millis(100), media.cancelled())
        .await
        .unwrap();
    assert!(control.valid());
    assert_eq!(owners.publish(1), Err("consumer-revision-stale"));
    owners.publish(2).unwrap();
    assert!(!media.valid());
    owners.stop().unwrap();
    owners.stop().unwrap();
    tokio::time::timeout(Duration::from_millis(100), control.cancelled())
        .await
        .unwrap();
    assert_eq!(
        owners.register("third", deadline()),
        Err("consumer-owner-stopped")
    );
    assert_eq!(
        owners.admit_control("first").err(),
        Some("consumer-owner-stopped")
    );
}
#[test]
fn registry_limit_and_owner_drop_are_fail_closed() {
    let owners = ConsumerOwners::new();
    assert_eq!(
        owners.register("", deadline()),
        Err("consumer-token-invalid")
    );
    assert_eq!(
        owners.register("expired", Instant::now()),
        Err("consumer-lease-expired")
    );
    for i in 0..8 {
        owners.register(&i.to_string(), deadline()).unwrap();
    }
    assert_eq!(
        owners.register("ninth", deadline()),
        Err("consumer-viewer-limit")
    );
    assert_eq!(
        owners.register("0", deadline()),
        Err("consumer-already-registered")
    );
    assert_eq!(
        owners.admit_media("0", 1).err(),
        Some("consumer-revision-stale")
    );
    owners.publish(1).unwrap();
    let permit = owners.admit_media("0", 1).unwrap();
    drop(owners);
    assert!(!permit.valid());
}
#[test]
fn revoke_and_reregister_cannot_bypass_aggregate_unsettled_request_bounds() {
    let owners = ConsumerOwners::new();
    owners.publish(1).unwrap();
    let mut media = Vec::new();
    let mut control = Vec::new();
    for i in 0..8 {
        let token = i.to_string();
        owners.register(&token, deadline()).unwrap();
        for _ in 0..4 {
            media.push(owners.admit_media(&token, 1).unwrap());
        }
        control.push(owners.admit_control(&token).unwrap());
    }
    owners.revoke("0").unwrap();
    owners.register("0", deadline()).unwrap();
    assert_eq!(
        owners.admit_media("0", 1).err(),
        Some("consumer-total-media-limit")
    );
    assert_eq!(
        owners.admit_control("0").err(),
        Some("consumer-total-control-limit")
    );
    // Only dropping settled requests releases the global slots.
    drop(media.pop());
    drop(control.pop());
    let next_media = owners.admit_media("0", 1).unwrap();
    let next_control = owners.admit_control("0").unwrap();
    assert_eq!(owners.stats().unwrap().media_requests, 32);
    assert_eq!(owners.stats().unwrap().control_requests, 8);
    drop(media);
    drop(control);
    drop(next_media);
    drop(next_control);
    assert_eq!(owners.stats().unwrap().media_requests, 0);
    assert_eq!(owners.stats().unwrap().control_requests, 0);
}
