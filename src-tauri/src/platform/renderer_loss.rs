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

//! Native proof of renderer loss is distinct from a frontend cleanup ACK.
//! The platform must fence admission and confirm exact-view removal before
//! starting recovery. Owned native work is joined even if every waiter leaves.
use serde::Serialize;
use std::{
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::{sync::Notify, task::JoinHandle};

const MAX_GENERATION: u64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegisteredView {
    activity_id: i32,
    view_id: String,
    epoch: u64,
}
impl RegisteredView {
    pub fn activity_id(&self) -> i32 {
        self.activity_id
    }
    pub fn view_id(&self) -> &str {
        &self.view_id
    }
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LossReason {
    Crashed,
    SystemKilled,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrontendOutcome {
    RendererGone(LossReason),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeFailure {
    CleanupFailed,
    CleanupUnconfirmed,
    JoinFailed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Healthy,
    Received,
    ViewRemoved,
    NativeRunning,
    NativeFailed,
    NativeJoined,
    TaskFinishing,
    Exited,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LossTicket {
    view: RegisteredView,
    closing_generation: u64,
}
impl LossTicket {
    pub fn closing_generation(&self) -> u64 {
        self.closing_generation
    }
    pub fn view(&self) -> &RegisteredView {
        &self.view
    }
}
pub struct Admission {
    pub ticket: LossTicket,
    pub start: bool,
}
/// Created only by the native exact-view cleanup path, never deserialized IPC.
pub struct ViewRemovalReceipt {
    pub view: RegisteredView,
    pub removed_from_hierarchy: bool,
    pub destroyed: bool,
    pub owned_references_cleared: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema_version: u8,
    pub generation: u64,
    pub phase: Phase,
    pub view_removed: bool,
    pub native_attempts: u32,
    pub native_joined: bool,
    pub failure: Option<NativeFailure>,
    pub exit_accepted: bool,
}
#[derive(Default)]
struct State {
    epoch: u64,
    view: Option<RegisteredView>,
    attempt: Option<Arc<Attempt>>,
}
struct Attempt {
    ticket: LossTicket,
    reason: LossReason,
    state: Mutex<AttemptState>,
    notify: Notify,
}
struct AttemptState {
    phase: Phase,
    view_removed: bool,
    native_attempts: u32,
    native_result: Option<Result<(), NativeFailure>>,
    joiner: Option<JoinHandle<()>>,
    exit_accepted: bool,
}
#[derive(Default)]
pub struct RendererLossOwner {
    state: Mutex<State>,
}
impl RendererLossOwner {
    pub fn register_view(
        &self,
        activity_id: i32,
        view_id: &str,
    ) -> Result<RegisteredView, &'static str> {
        if view_id.is_empty()
            || view_id.len() > 128
            || !view_id.is_ascii()
            || view_id.chars().any(char::is_control)
        {
            return Err("renderer-view-invalid");
        }
        let mut state = self.state.lock().map_err(|_| "renderer-owner-lock")?;
        if state.attempt.is_some() {
            return Err("renderer-recovery-active");
        }
        state.epoch = state
            .epoch
            .checked_add(1)
            .filter(|n| *n <= MAX_GENERATION)
            .ok_or("renderer-generation-exhausted")?;
        let view = RegisteredView {
            activity_id,
            view_id: view_id.into(),
            epoch: state.epoch,
        };
        state.view = Some(view.clone());
        Ok(view)
    }
    pub fn admission_open(&self) -> bool {
        self.state.lock().is_ok_and(|state| state.attempt.is_none())
    }
    /// Bind to the exact already-issued closing generation; normal close owns
    /// that generation. This method does not create or acknowledge normal close.
    pub fn begin_loss(
        &self,
        view: &RegisteredView,
        reason: LossReason,
        closing_generation: u64,
    ) -> Result<Admission, &'static str> {
        if closing_generation == 0 || closing_generation > MAX_GENERATION {
            return Err("renderer-generation-invalid");
        }
        let mut state = self.state.lock().map_err(|_| "renderer-owner-lock")?;
        if state.view.as_ref() != Some(view) {
            return Err("renderer-view-mismatch");
        }
        if let Some(attempt) = &state.attempt {
            if attempt.ticket.view != *view
                || attempt.ticket.closing_generation != closing_generation
            {
                return Err("renderer-generation-mismatch");
            }
            return Ok(Admission {
                ticket: attempt.ticket.clone(),
                start: false,
            });
        }
        let ticket = LossTicket {
            view: view.clone(),
            closing_generation,
        };
        state.attempt = Some(Arc::new(Attempt {
            ticket: ticket.clone(),
            reason,
            state: Mutex::new(AttemptState {
                phase: Phase::Received,
                view_removed: false,
                native_attempts: 0,
                native_result: None,
                joiner: None,
                exit_accepted: false,
            }),
            notify: Notify::new(),
        }));
        Ok(Admission {
            ticket,
            start: true,
        })
    }
    fn attempt(&self, ticket: &LossTicket) -> Result<Arc<Attempt>, &'static str> {
        self.state
            .lock()
            .map_err(|_| "renderer-owner-lock")?
            .attempt
            .as_ref()
            .filter(|a| a.ticket == *ticket)
            .cloned()
            .ok_or("renderer-generation-mismatch")
    }
    pub fn confirm_view_removed(
        &self,
        ticket: &LossTicket,
        receipt: ViewRemovalReceipt,
    ) -> Result<(), &'static str> {
        let attempt = self.attempt(ticket)?;
        if receipt.view != ticket.view
            || !receipt.removed_from_hierarchy
            || !receipt.destroyed
            || !receipt.owned_references_cleared
        {
            return Err("renderer-removal-unconfirmed");
        }
        let mut state = attempt.state.lock().map_err(|_| "renderer-owner-lock")?;
        if !state.view_removed {
            state.view_removed = true;
            state.phase = Phase::ViewRemoved;
        }
        Ok(())
    }
    pub fn frontend_outcome(&self, ticket: &LossTicket) -> Result<FrontendOutcome, &'static str> {
        let attempt = self.attempt(ticket)?;
        if !attempt
            .state
            .lock()
            .map_err(|_| "renderer-owner-lock")?
            .view_removed
        {
            return Err("renderer-removal-unconfirmed");
        }
        Ok(FrontendOutcome::RendererGone(attempt.reason))
    }
    /// The operation owns its guard; a second retained task owns its actual
    /// JoinHandle. Dropping/timing out a waiter cannot detach the native work.
    pub fn start_native_owned<F, G>(
        &self,
        ticket: &LossTicket,
        guard: G,
        operation: F,
    ) -> Result<bool, &'static str>
    where
        F: Future<Output = Result<(), NativeFailure>> + Send + 'static,
        G: Send + 'static,
    {
        let attempt = self.attempt(ticket)?;
        let mut state = attempt.state.lock().map_err(|_| "renderer-owner-lock")?;
        if !state.view_removed {
            return Err("renderer-removal-unconfirmed");
        }
        if matches!(
            state.phase,
            Phase::NativeRunning | Phase::NativeJoined | Phase::TaskFinishing | Phase::Exited
        ) {
            return Ok(false);
        }
        state.native_attempts = state
            .native_attempts
            .checked_add(1)
            .ok_or("renderer-attempt-exhausted")?;
        state.native_result = None;
        state.phase = Phase::NativeRunning;
        let operation = tokio::spawn(async move {
            let result = operation.await;
            drop(guard);
            result
        });
        let retained = attempt.clone();
        state.joiner = Some(tokio::spawn(async move {
            let result = operation.await.unwrap_or(Err(NativeFailure::JoinFailed));
            if let Ok(mut state) = retained.state.lock() {
                state.native_result = Some(result);
                state.phase = if result.is_ok() {
                    Phase::NativeJoined
                } else {
                    Phase::NativeFailed
                };
            }
            retained.notify.notify_waiters();
        }));
        Ok(true)
    }
    pub async fn native_settled(&self, ticket: &LossTicket) -> Result<(), NativeFailure> {
        let attempt = self
            .attempt(ticket)
            .map_err(|_| NativeFailure::CleanupUnconfirmed)?;
        loop {
            let notified = attempt.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let (result, started) = {
                let state = attempt
                    .state
                    .lock()
                    .map_err(|_| NativeFailure::CleanupUnconfirmed)?;
                (state.native_result, state.native_attempts > 0)
            };
            if let Some(result) = result {
                return result;
            }
            if !started {
                return Err(NativeFailure::CleanupUnconfirmed);
            }
            notified.await;
        }
    }
    pub fn begin_task_finish(&self, ticket: &LossTicket) -> Result<bool, &'static str> {
        let attempt = self.attempt(ticket)?;
        let mut state = attempt.state.lock().map_err(|_| "renderer-owner-lock")?;
        if state.exit_accepted || state.phase == Phase::TaskFinishing {
            return Ok(false);
        }
        if !state.view_removed || state.native_result != Some(Ok(())) {
            return Err("renderer-native-drain-unconfirmed");
        }
        state.phase = Phase::TaskFinishing;
        Ok(true)
    }
    /// Call only with the existing typed Activity request-acceptance receipt.
    /// This proves neither Activity destruction nor process absence.
    pub fn accept_task_finish(
        &self,
        ticket: &LossTicket,
        receipt: crate::android_task_finish::FinishReceipt,
    ) -> Result<bool, &'static str> {
        let attempt = self.attempt(ticket)?;
        if let Err(error) = receipt.validate() {
            self.task_finish_failed(ticket)?;
            return Err(error);
        }
        let mut state = attempt.state.lock().map_err(|_| "renderer-owner-lock")?;
        if state.exit_accepted {
            return Ok(false);
        }
        if state.phase != Phase::TaskFinishing || state.native_result != Some(Ok(())) {
            return Err("renderer-native-drain-unconfirmed");
        }
        state.exit_accepted = true;
        state.phase = Phase::Exited;
        Ok(true)
    }
    /// Only the owner of an actually SETTLED failed finish transport may call
    /// this. A waiting/deadline-expired transport must retain TaskFinishing.
    pub fn task_finish_failed(&self, ticket: &LossTicket) -> Result<(), &'static str> {
        let attempt = self.attempt(ticket)?;
        let mut state = attempt.state.lock().map_err(|_| "renderer-owner-lock")?;
        if state.exit_accepted {
            return Ok(());
        }
        if state.phase != Phase::TaskFinishing {
            return Err("renderer-finish-not-started");
        }
        state.phase = Phase::NativeJoined;
        Ok(())
    }
    pub fn snapshot(&self) -> Result<Snapshot, &'static str> {
        let state = self.state.lock().map_err(|_| "renderer-owner-lock")?;
        let Some(attempt) = &state.attempt else {
            return Ok(Snapshot {
                schema_version: 1,
                generation: 0,
                phase: Phase::Healthy,
                view_removed: false,
                native_attempts: 0,
                native_joined: false,
                failure: None,
                exit_accepted: false,
            });
        };
        let inner = attempt.state.lock().map_err(|_| "renderer-owner-lock")?;
        Ok(Snapshot {
            schema_version: 1,
            generation: attempt.ticket.closing_generation,
            phase: inner.phase,
            view_removed: inner.view_removed,
            native_attempts: inner.native_attempts,
            native_joined: inner.native_result == Some(Ok(())),
            failure: inner.native_result.and_then(Result::err),
            exit_accepted: inner.exit_accepted,
        })
    }
}
#[cfg(test)]
#[path = "renderer_loss_tests.rs"]
mod tests;
