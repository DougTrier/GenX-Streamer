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

use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use tokio::sync::{oneshot, Notify};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloseTicket {
    pub request_id: String,
    pub generation: u64,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CleanupResult {
    Drained,
    Failed,
}
struct Attempt {
    ticket: CloseTicket,
    running: bool,
    result: Option<CleanupResult>,
    sender: Option<oneshot::Sender<CleanupResult>>,
    completion: Arc<NativeDrain>,
    stage: CloseStage,
    reason: Option<CloseReason>,
    frontend_settled: bool,
    native_settled: bool,
}
pub struct RetainedAttempt {
    pub ticket: CloseTicket,
    pub acknowledgment: Option<oneshot::Receiver<CleanupResult>>,
    pub completion: Arc<NativeDrain>,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CloseStage {
    Starting,
    FrontendAndNative,
    Frontend,
    Native,
    FinalNativeDrain,
    #[cfg(target_os = "android")]
    ActivityFinish,
    Settled,
    Failed,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CloseReason {
    ObservationDeadline,
    EventUnavailable,
    FrontendFailed,
    FrontendUnconfirmed,
    NativeFailed,
    RequestLock,
    #[cfg(target_os = "android")]
    ActivityUnconfirmed,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseSnapshot {
    pub schema_version: u8,
    pub generation: u64,
    pub running: bool,
    pub stage: CloseStage,
    pub reason: Option<CloseReason>,
    pub frontend_settled: bool,
    pub native_settled: bool,
}
#[derive(Default)]
pub struct CloseOwner {
    state: Mutex<(u64, Option<Attempt>)>,
    native: Mutex<Option<Arc<NativeDrain>>>,
    #[cfg(any(target_os = "android", test))]
    activity: Mutex<Option<Arc<NativeDrain>>>,
    #[cfg(any(target_os = "android", test))]
    exit_acknowledged: std::sync::atomic::AtomicBool,
}
impl CloseOwner {
    #[cfg(any(target_os = "android", test))]
    pub fn accept_activity_exit(&self, ticket: &CloseTicket) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        state.1.as_ref().is_some_and(|a| a.ticket == *ticket)
            && !self.exit_acknowledged.swap(true, Ordering::SeqCst)
    }
    #[cfg(any(target_os = "android", test))]
    pub fn activity_drain(&self) -> Result<(Arc<NativeDrain>, bool), &'static str> {
        Self::retained_drain(&self.activity)
    }
    pub fn native_drain(&self) -> Result<(Arc<NativeDrain>, bool), &'static str> {
        Self::retained_drain(&self.native)
    }
    fn retained_drain(
        slot: &Mutex<Option<Arc<NativeDrain>>>,
    ) -> Result<(Arc<NativeDrain>, bool), &'static str> {
        let mut current = slot.lock().map_err(|_| "close-owner-lock")?;
        if let Some(drain) = current.as_ref() {
            if !matches!(
                *drain.result.lock().map_err(|_| "close-owner-lock")?,
                Some(Err(_))
            ) {
                return Ok((drain.clone(), false));
            }
        }
        let drain = Arc::new(NativeDrain::default());
        *current = Some(drain.clone());
        Ok((drain, true))
    }

    #[cfg(test)]
    pub fn begin(
        &self,
    ) -> Result<Option<(CloseTicket, oneshot::Receiver<CleanupResult>)>, &'static str> {
        let mut state = self.state.lock().map_err(|_| "close-owner-lock")?;
        if state.1.as_ref().is_some_and(|a| a.running) {
            return Ok(None);
        }
        let (ticket, receiver) = Self::create_attempt(&mut state)?;
        Ok(Some((ticket, receiver)))
    }
    fn create_attempt(
        state: &mut (u64, Option<Attempt>),
    ) -> Result<(CloseTicket, oneshot::Receiver<CleanupResult>), &'static str> {
        let generation = state
            .0
            .checked_add(1)
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or("close-generation-exhausted")?;
        let mut bytes = [0; 16];
        getrandom::fill(&mut bytes).map_err(|_| "close-random-unavailable")?;
        let id = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let ticket = CloseTicket {
            request_id: format!("close-{id}"),
            generation,
        };
        let (sender, receiver) = oneshot::channel();
        state.0 = generation;
        state.1 = Some(Attempt {
            ticket: ticket.clone(),
            running: true,
            result: None,
            sender: Some(sender),
            completion: Arc::new(NativeDrain::default()),
            stage: CloseStage::Starting,
            reason: None,
            frontend_settled: false,
            native_settled: false,
        });
        Ok((ticket, receiver))
    }
    pub fn begin_retained(&self) -> Result<RetainedAttempt, &'static str> {
        let mut state = self.state.lock().map_err(|_| "close-owner-lock")?;
        if let Some(attempt) = state
            .1
            .as_ref()
            .filter(|attempt| attempt.running || attempt.stage == CloseStage::Settled)
        {
            return Ok(RetainedAttempt {
                ticket: attempt.ticket.clone(),
                acknowledgment: None,
                completion: attempt.completion.clone(),
            });
        }
        let (ticket, receiver) = Self::create_attempt(&mut state)?;
        Ok(RetainedAttempt {
            ticket,
            acknowledgment: Some(receiver),
            completion: state
                .1
                .as_ref()
                .expect("created attempt")
                .completion
                .clone(),
        })
    }
    pub fn snapshot(&self, ticket: &CloseTicket) -> Option<CloseSnapshot> {
        let state = self.state.lock().ok()?;
        let attempt = state
            .1
            .as_ref()
            .filter(|attempt| attempt.ticket == *ticket)?;
        Some(CloseSnapshot {
            schema_version: 1,
            generation: ticket.generation,
            running: attempt.running,
            stage: attempt.stage,
            reason: attempt.reason,
            frontend_settled: attempt.frontend_settled,
            native_settled: attempt.native_settled,
        })
    }
    pub fn phase(&self, ticket: &CloseTicket, stage: CloseStage) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(attempt) = state
                .1
                .as_mut()
                .filter(|attempt| attempt.ticket == *ticket && attempt.running)
            {
                attempt.stage = stage;
            }
        }
    }
    pub fn joined(&self, ticket: &CloseTicket, frontend: bool) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(attempt) = state
                .1
                .as_mut()
                .filter(|attempt| attempt.ticket == *ticket && attempt.running)
            {
                if frontend {
                    attempt.frontend_settled = true;
                } else {
                    attempt.native_settled = true;
                }
                attempt.stage = match (attempt.frontend_settled, attempt.native_settled) {
                    (true, false) => CloseStage::Native,
                    (false, true) => CloseStage::Frontend,
                    _ => CloseStage::FrontendAndNative,
                };
            }
        }
    }
    pub fn observation_deadline(&self, ticket: &CloseTicket) -> bool {
        if let Ok(mut state) = self.state.lock() {
            if let Some(attempt) = state
                .1
                .as_mut()
                .filter(|attempt| attempt.ticket == *ticket && attempt.running)
            {
                attempt.reason = Some(CloseReason::ObservationDeadline);
                return true;
            }
        }
        false
    }
    pub async fn join_cleanup(
        &self,
        ticket: &CloseTicket,
        ack: impl std::future::Future<Output = Result<CleanupResult, oneshot::error::RecvError>>,
        native: &NativeDrain,
        emitted: bool,
        notify: impl Fn(),
    ) -> Result<(), (&'static str, CloseReason)> {
        self.phase(ticket, CloseStage::FrontendAndNative);
        notify();
        let frontend = async {
            let result = if emitted {
                match ack.await {
                    Ok(CleanupResult::Drained) => Ok(()),
                    Ok(CleanupResult::Failed) => {
                        Err(("frontend-cleanup-failed", CloseReason::FrontendFailed))
                    }
                    Err(_) => Err((
                        "frontend-cleanup-unconfirmed",
                        CloseReason::FrontendUnconfirmed,
                    )),
                }
            } else {
                Err(("cleanup-event-unavailable", CloseReason::EventUnavailable))
            };
            self.joined(ticket, true);
            notify();
            result
        };
        let native_join = async {
            let result = native
                .settled()
                .await
                .map_err(|error| (error, CloseReason::NativeFailed));
            self.joined(ticket, false);
            notify();
            result
        };
        // Never short-circuit an independent owned join on a confirmed failure.
        let (frontend, native) = tokio::join!(frontend, native_join);
        frontend?;
        native
    }
    pub fn settle(
        &self,
        ticket: &CloseTicket,
        result: Result<(), &'static str>,
        reason: Option<CloseReason>,
    ) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(attempt) = state
                .1
                .as_mut()
                .filter(|attempt| attempt.ticket == *ticket && attempt.running)
            {
                attempt.running = false;
                attempt.sender = None;
                attempt.stage = if result.is_ok() {
                    CloseStage::Settled
                } else {
                    CloseStage::Failed
                };
                attempt.reason = reason;
                attempt.completion.complete(result);
            }
        }
    }
    pub fn acknowledge(
        &self,
        ticket: &CloseTicket,
        result: CleanupResult,
    ) -> Result<(), &'static str> {
        let mut state = self.state.lock().map_err(|_| "close-owner-lock")?;
        let attempt = state.1.as_mut().ok_or("cleanup-ack-obsolete")?;
        if attempt.ticket != *ticket || !attempt.running {
            return Err("cleanup-ack-obsolete");
        }
        if let Some(previous) = attempt.result {
            return if previous == result {
                Ok(())
            } else {
                Err("cleanup-ack-conflict")
            };
        }
        attempt.result = Some(result);
        if let Some(sender) = attempt.sender.take() {
            sender.send(result).map_err(|_| "cleanup-ack-obsolete")?
        }
        Ok(())
    }
    #[cfg(test)]
    pub fn finish(&self, ticket: &CloseTicket) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(a) = state.1.as_mut() {
                if a.ticket == *ticket {
                    a.running = false;
                    a.sender = None;
                }
            }
        }
    }
}

#[derive(Default)]
pub struct NativeDrain {
    result: Mutex<Option<Result<(), &'static str>>>,
    notify: Notify,
}
impl NativeDrain {
    pub fn complete(&self, result: Result<(), &'static str>) {
        if let Ok(mut slot) = self.result.lock() {
            if slot.is_none() {
                *slot = Some(result);
                self.notify.notify_waiters();
            }
        }
    }
    pub async fn settled(&self) -> Result<(), &'static str> {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(result) = *self.result.lock().map_err(|_| "close-owner-lock")? {
                return result;
            }
            notified.await;
        }
    }
}
#[derive(Default, Debug)]
pub struct WorkOwner {
    count: AtomicUsize,
    notify: Notify,
}
#[derive(Debug)]
pub struct WorkGuard(Arc<WorkOwner>);
impl WorkOwner {
    pub fn acquire(self: &Arc<Self>) -> WorkGuard {
        self.count.fetch_add(1, Ordering::SeqCst);
        WorkGuard(self.clone())
    }
    pub fn count(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
    pub async fn drained(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.count() == 0 {
                return;
            }
            notified.await;
        }
    }
}
impl Drop for WorkGuard {
    fn drop(&mut self) {
        self.0.count.fetch_sub(1, Ordering::SeqCst);
        self.0.notify.notify_waiters();
    }
}
#[cfg(test)]
mod tests {
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
}
