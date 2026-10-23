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
mod tests {
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
}
