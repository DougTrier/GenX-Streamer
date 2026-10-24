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
#[tokio::test]
async fn retained_ack_after_five_second_observation_keeps_exact_ticket_and_native_join() {
    let owner = Arc::new(CloseOwner::default());
    let mut first = owner.begin_retained().unwrap();
    let ticket = first.ticket.clone();
    let ack = first.acknowledgment.take().unwrap();
    let (native, _) = owner.native_drain().unwrap();
    native.complete(Ok(()));
    let actual = owner.clone();
    let producer_ticket = ticket.clone();
    let producer = tokio::spawn(async move {
        actual
            .join_cleanup(&producer_ticket, ack, &native, true, || {})
            .await
            .unwrap();
        actual.settle(&producer_ticket, Ok(()), None);
    });
    assert!(tokio::time::timeout(
        std::time::Duration::from_secs(5),
        first.completion.settled()
    )
    .await
    .is_err());
    owner.observation_deadline(&ticket);
    let pending = owner.snapshot(&ticket).unwrap();
    assert!(pending.running);
    assert_eq!(pending.stage, CloseStage::Frontend);
    assert_eq!(pending.reason, Some(CloseReason::ObservationDeadline));
    assert!(pending.native_settled);
    assert!(!pending.frontend_settled);
    let retry = owner.begin_retained().unwrap();
    let duplicate = owner.begin_retained().unwrap();
    assert_eq!(retry.ticket, ticket);
    assert_eq!(duplicate.ticket, ticket);
    assert!(retry.acknowledgment.is_none());
    assert!(Arc::ptr_eq(&retry.completion, &first.completion));
    owner.acknowledge(&ticket, CleanupResult::Drained).unwrap();
    owner.acknowledge(&ticket, CleanupResult::Drained).unwrap();
    first.completion.settled().await.unwrap();
    producer.await.unwrap();
    assert_eq!(owner.snapshot(&ticket).unwrap().stage, CloseStage::Settled);
    assert_eq!(owner.begin_retained().unwrap().ticket, ticket);
}
#[tokio::test]
async fn failed_frontend_waits_native_settlement_before_retry_and_never_reports_success() {
    let owner = Arc::new(CloseOwner::default());
    let mut first = owner.begin_retained().unwrap();
    let ticket = first.ticket.clone();
    let ack = first.acknowledgment.take().unwrap();
    let (native, _) = owner.native_drain().unwrap();
    let actual = owner.clone();
    let producer_ticket = ticket.clone();
    let pending_native = native.clone();
    let producer = tokio::spawn(async move {
        let result = actual
            .join_cleanup(&producer_ticket, ack, &pending_native, true, || {})
            .await;
        assert_eq!(
            result,
            Err(("frontend-cleanup-failed", CloseReason::FrontendFailed))
        );
        actual.settle(
            &producer_ticket,
            Err("frontend-cleanup-failed"),
            Some(CloseReason::FrontendFailed),
        );
    });
    owner.acknowledge(&ticket, CleanupResult::Failed).unwrap();
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(10),
        first.completion.settled()
    )
    .await
    .is_err());
    assert_eq!(owner.begin_retained().unwrap().ticket, ticket);
    assert_eq!(owner.snapshot(&ticket).unwrap().stage, CloseStage::Native);
    native.complete(Ok(()));
    assert_eq!(
        first.completion.settled().await,
        Err("frontend-cleanup-failed")
    );
    producer.await.unwrap();
    let next = owner.begin_retained().unwrap();
    assert!(next.ticket.generation > ticket.generation);
    assert!(next.acknowledgment.is_some());
    owner.settle(&ticket, Ok(()), None);
    assert!(owner.snapshot(&next.ticket).unwrap().running);
    assert_eq!(
        owner.acknowledge(&ticket, CleanupResult::Drained),
        Err("cleanup-ack-obsolete")
    );
}
#[tokio::test]
async fn native_failure_does_not_abandon_pending_frontend_or_promote_it_to_drained() {
    let owner = Arc::new(CloseOwner::default());
    let mut first = owner.begin_retained().unwrap();
    let ticket = first.ticket.clone();
    let ack = first.acknowledgment.take().unwrap();
    let (native, _) = owner.native_drain().unwrap();
    native.complete(Err("native-stop-unconfirmed"));
    let actual = owner.clone();
    let producer_ticket = ticket.clone();
    let producer = tokio::spawn(async move {
        let result = actual
            .join_cleanup(&producer_ticket, ack, &native, true, || {})
            .await;
        assert_eq!(
            result,
            Err(("native-stop-unconfirmed", CloseReason::NativeFailed))
        );
        actual.settle(
            &producer_ticket,
            Err("native-stop-unconfirmed"),
            Some(CloseReason::NativeFailed),
        );
    });
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(10),
        first.completion.settled()
    )
    .await
    .is_err());
    assert_eq!(owner.begin_retained().unwrap().ticket, ticket);
    owner.acknowledge(&ticket, CleanupResult::Drained).unwrap();
    assert_eq!(
        first.completion.settled().await,
        Err("native-stop-unconfirmed")
    );
    producer.await.unwrap();
    assert_eq!(
        owner.snapshot(&ticket).unwrap().reason,
        Some(CloseReason::NativeFailed)
    );
}
#[tokio::test]
async fn final_owned_work_remains_pending_after_both_cleanup_joins() {
    let owner = Arc::new(CloseOwner::default());
    let work = Arc::new(WorkOwner::default());
    let guard = work.acquire();
    let mut first = owner.begin_retained().unwrap();
    let ticket = first.ticket.clone();
    let ack = first.acknowledgment.take().unwrap();
    let (native, _) = owner.native_drain().unwrap();
    native.complete(Ok(()));
    let actual = owner.clone();
    let pending_work = work.clone();
    let producer_ticket = ticket.clone();
    let producer = tokio::spawn(async move {
        actual
            .join_cleanup(&producer_ticket, ack, &native, true, || {})
            .await
            .unwrap();
        actual.phase(&producer_ticket, CloseStage::FinalNativeDrain);
        pending_work.drained().await;
        actual.settle(&producer_ticket, Ok(()), None);
    });
    owner.acknowledge(&ticket, CleanupResult::Drained).unwrap();
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(10),
        first.completion.settled()
    )
    .await
    .is_err());
    assert_eq!(
        owner.snapshot(&ticket).unwrap().stage,
        CloseStage::FinalNativeDrain
    );
    assert_eq!(work.count(), 1);
    assert_eq!(owner.begin_retained().unwrap().ticket, ticket);
    drop(guard);
    first.completion.settled().await.unwrap();
    producer.await.unwrap();
}
#[test]
fn fixed_snapshot_never_serializes_ticket_or_backend_error_payload() {
    let owner = CloseOwner::default();
    let attempt = owner.begin_retained().unwrap();
    owner.settle(
        &attempt.ticket,
        Err("private-stream-url"),
        Some(CloseReason::NativeFailed),
    );
    let text = serde_json::to_string(&owner.snapshot(&attempt.ticket).unwrap()).unwrap();
    assert!(!text.contains(&attempt.ticket.request_id));
    assert!(!text.contains("private-stream-url"));
    assert!(text.contains("native-failed"));
    assert!(text.contains("\"stage\":\"failed\""));
}
#[test]
fn late_observation_cannot_mark_terminal_or_superseded_attempt_blocked() {
    let owner = CloseOwner::default();
    let first = owner.begin_retained().unwrap();
    owner.settle(
        &first.ticket,
        Err("frontend-cleanup-failed"),
        Some(CloseReason::FrontendFailed),
    );
    assert!(!owner.observation_deadline(&first.ticket));
    assert_eq!(
        owner.snapshot(&first.ticket).unwrap().reason,
        Some(CloseReason::FrontendFailed)
    );
    let retry = owner.begin_retained().unwrap();
    assert!(!owner.observation_deadline(&first.ticket));
    assert_eq!(owner.snapshot(&retry.ticket).unwrap().reason, None);
    owner.settle(&retry.ticket, Ok(()), None);
    assert!(!owner.observation_deadline(&retry.ticket));
    assert_eq!(
        owner.snapshot(&retry.ticket).unwrap().stage,
        CloseStage::Settled
    );
}
#[tokio::test]
async fn exact_ack_duplicate_conflict_and_retry_fences() {
    let owner = CloseOwner::default();
    let (t, rx) = owner.begin().unwrap().unwrap();
    assert!(owner.begin().unwrap().is_none());
    let mut wrong = t.clone();
    wrong.generation += 1;
    assert!(owner.acknowledge(&wrong, CleanupResult::Drained).is_err());
    owner.acknowledge(&t, CleanupResult::Failed).unwrap();
    assert_eq!(rx.await.unwrap(), CleanupResult::Failed);
    owner.acknowledge(&t, CleanupResult::Failed).unwrap();
    assert_eq!(
        owner.acknowledge(&t, CleanupResult::Drained),
        Err("cleanup-ack-conflict")
    );
    owner.finish(&t);
    let (next, _) = owner.begin().unwrap().unwrap();
    assert!(next.generation > t.generation);
    assert_eq!(
        owner.acknowledge(&t, CleanupResult::Drained),
        Err("cleanup-ack-obsolete")
    );
}
#[tokio::test]
async fn timed_out_attempt_cannot_acknowledge_retry() {
    let owner = CloseOwner::default();
    let (t, rx) = owner.begin().unwrap().unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(10), rx)
            .await
            .is_err()
    );
    owner.finish(&t);
    let (next, rx) = owner.begin().unwrap().unwrap();
    assert!(owner.acknowledge(&t, CleanupResult::Drained).is_err());
    owner.acknowledge(&next, CleanupResult::Drained).unwrap();
    assert_eq!(rx.await.unwrap(), CleanupResult::Drained);
}
#[tokio::test]
async fn canceled_wait_does_not_release_actual_worker() {
    let owner = Arc::new(WorkOwner::default());
    let guard = owner.acquire();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(10), owner.drained())
            .await
            .is_err()
    );
    assert_eq!(owner.count(), 1);
    drop(guard);
    owner.drained().await;
    assert_eq!(owner.count(), 0);
}
#[tokio::test]
async fn abandoned_blocking_awaiter_cannot_claim_worker_settled() {
    let owner = Arc::new(WorkOwner::default());
    let guard = owner.acquire();
    let (started, start) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let job = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let _ = started.send(());
        wait.recv().unwrap();
    });
    start.await.unwrap();
    drop(job); // Tokio does not cancel an already-running blocking closure.
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(10), owner.drained())
            .await
            .is_err()
    );
    assert_eq!(owner.count(), 1);
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(1), owner.drained())
        .await
        .unwrap();
    assert_eq!(owner.count(), 0);
}
#[test]
fn generation_is_javascript_safe_and_exhaustion_refuses() {
    let owner = CloseOwner::default();
    owner.state.lock().unwrap().0 = 9_007_199_254_740_991;
    assert_eq!(owner.begin().unwrap_err(), "close-generation-exhausted");
}
#[tokio::test]
async fn timeout_and_frontend_failure_do_not_discard_pending_native_join() {
    let owner = CloseOwner::default();
    let (drain, start) = owner.native_drain().unwrap();
    assert!(start);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(10), drain.settled())
            .await
            .is_err()
    );
    let (retry, start) = owner.native_drain().unwrap();
    assert!(!start);
    assert!(Arc::ptr_eq(&drain, &retry));
    drain.complete(Ok(()));
    retry.settled().await.unwrap();
    let (done, start) = owner.native_drain().unwrap();
    assert!(!start);
    done.settled().await.unwrap();
}
#[tokio::test]
async fn failed_native_join_is_retryable_without_replacing_pending_work() {
    let owner = CloseOwner::default();
    let (drain, _) = owner.native_drain().unwrap();
    drain.complete(Err("native-stop-unconfirmed"));
    assert!(drain.settled().await.is_err());
    let (retry, start) = owner.native_drain().unwrap();
    assert!(start);
    assert!(!Arc::ptr_eq(&drain, &retry));
    retry.complete(Ok(()));
    retry.settled().await.unwrap();
}
#[tokio::test]
async fn retained_lan_deadline_can_retry_actual_native_join() {
    let owner = CloseOwner::default();
    let (drain, _) = owner.native_drain().unwrap();
    drain.complete(Err("lan-stop-deadline"));
    let (retry, start) = owner.native_drain().unwrap();
    assert!(start);
    assert!(!Arc::ptr_eq(&drain, &retry));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(5), retry.settled())
            .await
            .is_err()
    );
    retry.complete(Ok(()));
    retry.settled().await.unwrap();
}
