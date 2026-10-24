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
#[path = "close_owner_tests.rs"]
mod tests;
