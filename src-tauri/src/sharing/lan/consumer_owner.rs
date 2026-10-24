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

//! Consumer-scoped admission and cancellation only: no network, token diagnostics or tasks.
//! Integration must race each owned request against its permit and drop it after settlement.
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tokio::sync::watch;

const MAX_VIEWERS: usize = 8;
const MEDIA_PER_VIEWER: usize = 4;
const CONTROL_PER_VIEWER: usize = 1;

#[derive(Clone, Copy)]
struct Lease {
    deadline: Instant,
    paused: bool,
    revoked: bool,
    media_epoch: u64,
    revision: Option<u64>,
}
struct Viewer {
    updates: watch::Sender<Lease>,
    media: AtomicUsize,
    controls: AtomicUsize,
}
#[derive(Default)]
struct Totals {
    media: AtomicUsize,
    controls: AtomicUsize,
}
struct State {
    viewers: HashMap<String, Arc<Viewer>>,
    revision: Option<u64>,
    last_revision: u64,
    media_epoch: u64,
    stopped: bool,
}

pub struct ConsumerOwners {
    state: Mutex<State>,
    totals: Arc<Totals>,
}
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConsumerStats {
    pub viewers: usize,
    /// Live owned requests, including canceled work that has not yet settled/dropped.
    pub media_requests: usize,
    pub control_requests: usize,
}
impl Default for ConsumerOwners {
    fn default() -> Self {
        Self::new()
    }
}
impl ConsumerOwners {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                viewers: HashMap::new(),
                revision: None,
                last_revision: 0,
                media_epoch: 0,
                stopped: false,
            }),
            totals: Arc::new(Totals::default()),
        }
    }
    pub fn register(&self, token: &str, deadline: Instant) -> Result<(), &'static str> {
        if token.is_empty() || token.len() > 256 || token.chars().any(char::is_control) {
            return Err("consumer-token-invalid");
        }
        let now = Instant::now();
        if deadline <= now {
            return Err("consumer-lease-expired");
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "consumer-state-unavailable")?;
        if state.stopped {
            return Err("consumer-owner-stopped");
        }
        expire_locked(&mut state, now);
        if state.viewers.contains_key(token) {
            return Err("consumer-already-registered");
        }
        if state.viewers.len() >= MAX_VIEWERS {
            return Err("consumer-viewer-limit");
        }
        let (updates, _) = watch::channel(Lease {
            deadline,
            paused: false,
            revoked: false,
            media_epoch: state.media_epoch,
            revision: state.revision,
        });
        state.viewers.insert(
            token.to_owned(),
            Arc::new(Viewer {
                updates,
                media: AtomicUsize::new(0),
                controls: AtomicUsize::new(0),
            }),
        );
        Ok(())
    }
    pub fn heartbeat(
        &self,
        token: &str,
        paused: bool,
        deadline: Instant,
    ) -> Result<(), &'static str> {
        let now = Instant::now();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "consumer-state-unavailable")?;
        if state.stopped {
            return Err("consumer-owner-stopped");
        }
        expire_locked(&mut state, now);
        let viewer = state.viewers.get(token).ok_or("consumer-unauthorized")?;
        if deadline <= now {
            revoke_locked(&mut state, token);
            return Err("consumer-lease-expired");
        }
        let mut lease = *viewer.updates.borrow();
        if paused && !lease.paused {
            // A later unpause cannot resurrect media issued before this transition.
            lease.media_epoch = lease
                .media_epoch
                .checked_add(1)
                .ok_or("consumer-generation-limit")?;
        }
        lease.paused = paused;
        lease.deadline = deadline;
        viewer.updates.send_replace(lease);
        Ok(())
    }
    pub fn revoke(&self, token: &str) -> Result<(), &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "consumer-state-unavailable")?;
        revoke_locked(&mut state, token);
        Ok(())
    }
    pub fn expire(&self, now: Instant) -> Result<(), &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "consumer-state-unavailable")?;
        expire_locked(&mut state, now);
        Ok(())
    }
    /// Install a fresh policy-issued revision. Same current revision is idempotent.
    pub fn publish(&self, revision: u64) -> Result<(), &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "consumer-state-unavailable")?;
        if state.stopped {
            return Err("consumer-owner-stopped");
        }
        if state.revision == Some(revision) {
            return Ok(());
        }
        if revision == 0 || revision <= state.last_revision {
            return Err("consumer-revision-stale");
        }
        advance_media_epoch(&mut state)?;
        state.revision = Some(revision);
        state.last_revision = revision;
        notify_publication(&state);
        Ok(())
    }
    pub fn invalidate_publication(&self) -> Result<(), &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "consumer-state-unavailable")?;
        advance_media_epoch(&mut state)?;
        state.revision = None;
        notify_publication(&state);
        Ok(())
    }
    /// Permanent close; an intentional later server start uses a new owner.
    pub fn stop(&self) -> Result<(), &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "consumer-state-unavailable")?;
        state.stopped = true;
        state.revision = None;
        for (_, viewer) in state.viewers.drain() {
            revoke_viewer(&viewer);
        }
        Ok(())
    }
    pub fn admit_media(&self, token: &str, revision: u64) -> Result<MediaPermit, &'static str> {
        self.admit(token, Some(revision)).map(MediaPermit)
    }
    pub fn admit_control(&self, token: &str) -> Result<ControlPermit, &'static str> {
        self.admit(token, None).map(ControlPermit)
    }
    fn admit(&self, token: &str, revision: Option<u64>) -> Result<Permit, &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "consumer-state-unavailable")?;
        if state.stopped {
            return Err("consumer-owner-stopped");
        }
        expire_locked(&mut state, Instant::now());
        let viewer = state.viewers.get(token).ok_or("consumer-unauthorized")?;
        let lease = *viewer.updates.borrow();
        let kind = if let Some(revision) = revision {
            if lease.paused {
                return Err("consumer-paused");
            }
            if lease.revision != Some(revision) {
                return Err("consumer-revision-stale");
            }
            if viewer.media.load(Ordering::Acquire) >= MEDIA_PER_VIEWER {
                return Err("consumer-media-limit");
            }
            if self.totals.media.load(Ordering::Acquire) >= MAX_VIEWERS * MEDIA_PER_VIEWER {
                return Err("consumer-total-media-limit");
            }
            viewer.media.fetch_add(1, Ordering::AcqRel);
            self.totals.media.fetch_add(1, Ordering::AcqRel);
            Kind::Media {
                epoch: lease.media_epoch,
                revision,
            }
        } else {
            if viewer.controls.load(Ordering::Acquire) >= CONTROL_PER_VIEWER {
                return Err("consumer-control-limit");
            }
            if self.totals.controls.load(Ordering::Acquire) >= MAX_VIEWERS * CONTROL_PER_VIEWER {
                return Err("consumer-total-control-limit");
            }
            viewer.controls.fetch_add(1, Ordering::AcqRel);
            self.totals.controls.fetch_add(1, Ordering::AcqRel);
            Kind::Control
        };
        Ok(Permit {
            viewer: viewer.clone(),
            totals: self.totals.clone(),
            updates: viewer.updates.subscribe(),
            kind,
        })
    }
    #[cfg(test)]
    pub fn stats(&self) -> Result<ConsumerStats, &'static str> {
        let state = self
            .state
            .lock()
            .map_err(|_| "consumer-state-unavailable")?;
        let now = Instant::now();
        Ok(ConsumerStats {
            viewers: state
                .viewers
                .values()
                .filter(|viewer| viewer.updates.borrow().deadline > now)
                .count(),
            media_requests: self.totals.media.load(Ordering::Acquire),
            control_requests: self.totals.controls.load(Ordering::Acquire),
        })
    }
}
impl Drop for ConsumerOwners {
    fn drop(&mut self) {
        // Even poisoned state must invalidate permits before the last owner disappears.
        let state = self
            .state
            .get_mut()
            .unwrap_or_else(|poison| poison.into_inner());
        for viewer in state.viewers.values() {
            revoke_viewer(viewer);
        }
    }
}
fn advance_media_epoch(state: &mut State) -> Result<(), &'static str> {
    // Viewer pauses can advance their epochs independently; publication must exceed all of them.
    let maximum = state
        .viewers
        .values()
        .map(|viewer| viewer.updates.borrow().media_epoch)
        .max()
        .unwrap_or(state.media_epoch)
        .max(state.media_epoch);
    state.media_epoch = maximum.checked_add(1).ok_or("consumer-generation-limit")?;
    Ok(())
}
fn notify_publication(state: &State) {
    for viewer in state.viewers.values() {
        let mut lease = *viewer.updates.borrow();
        lease.media_epoch = state.media_epoch;
        lease.revision = state.revision;
        viewer.updates.send_replace(lease);
    }
}
fn revoke_viewer(viewer: &Viewer) {
    let mut lease = *viewer.updates.borrow();
    lease.revoked = true;
    viewer.updates.send_replace(lease);
}
fn revoke_locked(state: &mut State, token: &str) {
    if let Some(viewer) = state.viewers.remove(token) {
        revoke_viewer(&viewer);
    }
}
fn expire_locked(state: &mut State, now: Instant) {
    state.viewers.retain(|_, viewer| {
        if viewer.updates.borrow().deadline <= now {
            revoke_viewer(viewer);
            false
        } else {
            true
        }
    });
}

#[derive(Clone, Copy)]
enum Kind {
    Media { epoch: u64, revision: u64 },
    Control,
}
struct Permit {
    viewer: Arc<Viewer>,
    totals: Arc<Totals>,
    updates: watch::Receiver<Lease>,
    kind: Kind,
}
impl Permit {
    fn valid_lease(&self, lease: Lease) -> bool {
        !lease.revoked
            && lease.deadline > Instant::now()
            && match self.kind {
                Kind::Control => true,
                Kind::Media { epoch, revision } => {
                    !lease.paused && lease.media_epoch == epoch && lease.revision == Some(revision)
                }
            }
    }
    fn valid(&self) -> bool {
        self.valid_lease(*self.updates.borrow())
    }
    async fn cancelled(&mut self) {
        loop {
            let lease = *self.updates.borrow_and_update();
            if !self.valid_lease(lease) {
                return;
            }
            tokio::select! {
                changed = self.updates.changed() => {
                    if changed.is_err() { return; }
                }
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(lease.deadline)) => {
                    // A heartbeat could have won the same scheduling tick: re-read its deadline.
                }
            }
        }
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        match self.kind {
            Kind::Media { .. } => {
                self.viewer.media.fetch_sub(1, Ordering::AcqRel);
                self.totals.media.fetch_sub(1, Ordering::AcqRel);
            }
            Kind::Control => {
                self.viewer.controls.fetch_sub(1, Ordering::AcqRel);
                self.totals.controls.fetch_sub(1, Ordering::AcqRel);
            }
        }
    }
}
pub struct MediaPermit(Permit);
impl MediaPermit {
    pub fn valid(&self) -> bool {
        self.0.valid()
    }
    pub async fn cancelled(&mut self) {
        self.0.cancelled().await;
    }
}
pub struct ControlPermit(Permit);
impl ControlPermit {
    pub fn valid(&self) -> bool {
        self.0.valid()
    }
    pub async fn cancelled(&mut self) {
        self.0.cancelled().await;
    }
}

#[cfg(test)]
#[path = "consumer_owner_tests.rs"]
mod tests;
