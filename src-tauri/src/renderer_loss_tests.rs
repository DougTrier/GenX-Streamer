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
use std::sync::atomic::{AtomicUsize, Ordering};
fn registered(owner: &RendererLossOwner) -> RegisteredView {
    owner.register_view(-7, "main-private-marker").unwrap()
}
fn begin(owner: &RendererLossOwner) -> LossTicket {
    let view = registered(owner);
    owner
        .begin_loss(&view, LossReason::Crashed, 11)
        .unwrap()
        .ticket
}
fn removed(owner: &RendererLossOwner, ticket: &LossTicket) {
    owner
        .confirm_view_removed(
            ticket,
            ViewRemovalReceipt {
                view: ticket.view.clone(),
                removed_from_hierarchy: true,
                destroyed: true,
                owned_references_cleared: true,
            },
        )
        .unwrap();
}
fn finish(accepted: bool) -> crate::android_task_finish::FinishReceipt {
    serde_json::from_value(serde_json::json!({"schemaVersion":1,"adapterVersion":"activity-finish-v1","platform":"android","requestAccepted":accepted,"activityFinishing":accepted,"taskRoot":true})).unwrap()
}
struct Guard(Arc<AtomicUsize>);
impl Guard {
    fn acquire(counter: &Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter.clone())
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
#[test]
fn healthy_registration_rotation_identity_and_diagnostics_are_bounded() {
    let owner = RendererLossOwner::default();
    assert!(owner.admission_open());
    for id in ["", "line\nsecret", &"x".repeat(129)] {
        assert_eq!(
            owner.register_view(1, id).unwrap_err(),
            "renderer-view-invalid"
        )
    }
    let old = registered(&owner);
    assert_eq!(old.activity_id(), -7);
    assert_eq!(old.view_id(), "main-private-marker");
    let new = owner.register_view(8, "main").unwrap();
    assert_ne!(old.epoch(), new.epoch());
    assert_eq!(
        owner
            .begin_loss(&old, LossReason::Unknown, 1)
            .err()
            .unwrap(),
        "renderer-view-mismatch"
    );
    assert_eq!(
        owner
            .begin_loss(&new, LossReason::Unknown, 0)
            .err()
            .unwrap(),
        "renderer-generation-invalid"
    );
    let admission = owner.begin_loss(&new, LossReason::SystemKilled, 2).unwrap();
    assert!(admission.start);
    assert!(!owner.admission_open());
    assert_eq!(
        owner.register_view(8, "replacement").unwrap_err(),
        "renderer-recovery-active"
    );
    let json = serde_json::to_string(&owner.snapshot().unwrap()).unwrap();
    assert!(!json.contains("viewId"));
    assert!(!json.contains("activity"));
    assert!(!json.contains("private-marker"));
    assert!(json.len() < 512);
}
#[test]
fn duplicate_notification_and_native_proof_never_fabricate_frontend_drained() {
    let owner = RendererLossOwner::default();
    let ticket = begin(&owner);
    assert_eq!(ticket.closing_generation(), 11);
    let duplicate = owner
        .begin_loss(ticket.view(), LossReason::Unknown, 11)
        .unwrap();
    assert!(!duplicate.start);
    assert_eq!(duplicate.ticket, ticket);
    assert_eq!(
        owner
            .begin_loss(ticket.view(), LossReason::Crashed, 12)
            .err()
            .unwrap(),
        "renderer-generation-mismatch"
    );
    assert_eq!(
        owner.frontend_outcome(&ticket).unwrap_err(),
        "renderer-removal-unconfirmed"
    );
    assert_eq!(
        owner
            .confirm_view_removed(
                &ticket,
                ViewRemovalReceipt {
                    view: ticket.view.clone(),
                    removed_from_hierarchy: true,
                    destroyed: false,
                    owned_references_cleared: true
                }
            )
            .unwrap_err(),
        "renderer-removal-unconfirmed"
    );
    removed(&owner, &ticket);
    assert_eq!(
        owner.frontend_outcome(&ticket).unwrap(),
        FrontendOutcome::RendererGone(LossReason::Crashed)
    );
    assert_eq!(
        owner.begin_task_finish(&ticket).unwrap_err(),
        "renderer-native-drain-unconfirmed"
    );
}
#[tokio::test]
async fn held_native_work_survives_waiter_timeout_and_duplicate_loss_then_actual_join() {
    let owner = Arc::new(RendererLossOwner::default());
    let ticket = begin(&owner);
    removed(&owner, &ticket);
    let guards = Arc::new(AtomicUsize::new(0));
    let (enter, entered) = tokio::sync::oneshot::channel();
    let (release, held) = tokio::sync::oneshot::channel();
    assert!(owner
        .start_native_owned(&ticket, Guard::acquire(&guards), async move {
            enter.send(()).unwrap();
            held.await.unwrap();
            Ok(())
        })
        .unwrap());
    entered.await.unwrap();
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(5),
        owner.native_settled(&ticket)
    )
    .await
    .is_err());
    assert_eq!(guards.load(Ordering::SeqCst), 1);
    assert_eq!(owner.snapshot().unwrap().phase, Phase::NativeRunning);
    assert!(!owner
        .start_native_owned(&ticket, Guard::acquire(&guards), async { Ok(()) })
        .unwrap());
    assert_eq!(guards.load(Ordering::SeqCst), 1);
    assert!(
        !owner
            .begin_loss(ticket.view(), LossReason::Crashed, 11)
            .unwrap()
            .start
    );
    assert_eq!(
        owner.begin_task_finish(&ticket).unwrap_err(),
        "renderer-native-drain-unconfirmed"
    );
    release.send(()).unwrap();
    owner.native_settled(&ticket).await.unwrap();
    assert_eq!(guards.load(Ordering::SeqCst), 0);
    assert_eq!(owner.snapshot().unwrap().native_attempts, 1);
    assert!(owner.begin_task_finish(&ticket).unwrap());
    assert!(!owner.begin_task_finish(&ticket).unwrap());
    assert!(owner.accept_task_finish(&ticket, finish(true)).unwrap());
    assert!(!owner.accept_task_finish(&ticket, finish(true)).unwrap());
    assert_eq!(owner.snapshot().unwrap().phase, Phase::Exited);
    assert!(!owner.admission_open());
}
#[tokio::test]
async fn failed_operation_is_joined_and_retained_then_only_failed_native_phase_retries() {
    let owner = RendererLossOwner::default();
    let ticket = begin(&owner);
    removed(&owner, &ticket);
    let guards = Arc::new(AtomicUsize::new(0));
    owner
        .start_native_owned(&ticket, Guard::acquire(&guards), async {
            Err(NativeFailure::CleanupFailed)
        })
        .unwrap();
    assert_eq!(
        owner.native_settled(&ticket).await.unwrap_err(),
        NativeFailure::CleanupFailed
    );
    assert_eq!(guards.load(Ordering::SeqCst), 0);
    assert_eq!(
        owner.begin_task_finish(&ticket).unwrap_err(),
        "renderer-native-drain-unconfirmed"
    );
    assert!(owner
        .start_native_owned(&ticket, Guard::acquire(&guards), async { Ok(()) })
        .unwrap());
    owner.native_settled(&ticket).await.unwrap();
    assert_eq!(guards.load(Ordering::SeqCst), 0);
    assert_eq!(owner.snapshot().unwrap().native_attempts, 2);
    assert!(!owner
        .start_native_owned(&ticket, Guard::acquire(&guards), async {
            panic!("must never run")
        })
        .unwrap());
    assert_eq!(guards.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn operation_panic_is_actual_join_failure_not_success() {
    let owner = RendererLossOwner::default();
    let ticket = begin(&owner);
    removed(&owner, &ticket);
    let guards = Arc::new(AtomicUsize::new(0));
    owner
        .start_native_owned(&ticket, Guard::acquire(&guards), async {
            panic!("controlled native fixture panic")
        })
        .unwrap();
    assert_eq!(
        owner.native_settled(&ticket).await.unwrap_err(),
        NativeFailure::JoinFailed
    );
    assert_eq!(guards.load(Ordering::SeqCst), 0);
    assert_eq!(
        owner.snapshot().unwrap().failure,
        Some(NativeFailure::JoinFailed)
    );
}
#[tokio::test]
async fn aborted_waiter_stale_generation_and_invalid_finish_do_not_release_recovery() {
    let owner = Arc::new(RendererLossOwner::default());
    let ticket = begin(&owner);
    removed(&owner, &ticket);
    let (release, held) = tokio::sync::oneshot::channel();
    owner
        .start_native_owned(&ticket, (), async move {
            held.await.unwrap();
            Ok(())
        })
        .unwrap();
    let waiter_owner = owner.clone();
    let waiter_ticket = ticket.clone();
    let waiter = tokio::spawn(async move { waiter_owner.native_settled(&waiter_ticket).await });
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    let mut stale = ticket.clone();
    stale.closing_generation += 1;
    assert_eq!(
        owner.begin_task_finish(&stale).unwrap_err(),
        "renderer-generation-mismatch"
    );
    release.send(()).unwrap();
    owner.native_settled(&ticket).await.unwrap();
    owner.begin_task_finish(&ticket).unwrap();
    assert_eq!(
        owner
            .accept_task_finish(&ticket, finish(false))
            .unwrap_err(),
        "activity-finish-unconfirmed"
    );
    assert!(!owner.snapshot().unwrap().exit_accepted);
    assert!(owner.begin_task_finish(&ticket).unwrap());
    assert!(owner.accept_task_finish(&ticket, finish(true)).unwrap());
}
#[tokio::test]
async fn native_owner_drop_does_not_drop_admitted_operation_or_its_guard() {
    let owner = RendererLossOwner::default();
    let ticket = begin(&owner);
    removed(&owner, &ticket);
    let guards = Arc::new(AtomicUsize::new(0));
    let (release, held) = tokio::sync::oneshot::channel();
    let (done, joined) = tokio::sync::oneshot::channel();
    owner
        .start_native_owned(&ticket, Guard::acquire(&guards), async move {
            held.await.unwrap();
            done.send(()).unwrap();
            Ok(())
        })
        .unwrap();
    drop(owner);
    assert_eq!(guards.load(Ordering::SeqCst), 1);
    release.send(()).unwrap();
    joined.await.unwrap();
    // The operation completion signal precedes guard drop; await its actual
    // release with a bounded test deadline rather than guessing from the signal.
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while guards.load(Ordering::SeqCst) != 0 {
            tokio::task::yield_now().await
        }
    })
    .await
    .unwrap();
}
