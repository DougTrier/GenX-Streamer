//! One native resume episode. Admission, crypto, probes and publication retain leases.
//! Cancellation marks ownership closed; payload retirement waits for actual lease drops.
use crate::close_owner::{WorkGuard, WorkOwner};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, Weak,
};
const ERR: &str = "scan-resume-registry-lock";

enum Slot<T> {
    Opening {
        request_id: String,
        canceled: bool,
        work: Arc<WorkOwner>,
    },
    Active {
        request_id: String,
        plan_id: String,
        actor: Arc<Actor<T>>,
    },
}
struct Actor<T> {
    closing: AtomicBool,
    data: Mutex<T>,
    work: Arc<WorkOwner>,
}
pub(crate) struct Registry<T> {
    closing: AtomicBool,
    slot: Mutex<Option<Slot<T>>>,
    work: Arc<WorkOwner>,
}
impl<T> Default for Registry<T> {
    fn default() -> Self {
        Self {
            closing: AtomicBool::new(false),
            slot: Mutex::new(None),
            work: Arc::new(WorkOwner::default()),
        }
    }
}
pub(crate) struct Opening<T> {
    registry: Arc<Registry<T>>,
    request_id: String,
    installed: bool,
    _work: WorkGuard,
    _opening_work: WorkGuard,
}
pub(crate) struct Lease<T> {
    registry: Weak<Registry<T>>,
    actor: Arc<Actor<T>>,
    actor_work: Option<WorkGuard>,
    _registry_work: WorkGuard,
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
impl<T> Registry<T> {
    pub(crate) fn begin(self: &Arc<Self>, request_id: &str) -> Result<Opening<T>, String> {
        if !identifier(request_id) {
            return Err("invalid-request-id".into());
        }
        let mut slot = self.slot.lock().map_err(|_| ERR)?;
        if self.closing.load(Ordering::SeqCst) {
            return Err("application-closing".into());
        }
        if slot.is_some() {
            return Err("scan-resume-owner-busy".into());
        }
        let work = self.work.acquire();
        let opening_work = Arc::new(WorkOwner::default());
        let opening_guard = opening_work.acquire();
        *slot = Some(Slot::Opening {
            request_id: request_id.into(),
            canceled: false,
            work: opening_work,
        });
        Ok(Opening {
            registry: self.clone(),
            request_id: request_id.into(),
            installed: false,
            _work: work,
            _opening_work: opening_guard,
        })
    }
    pub(crate) fn acquire(self: &Arc<Self>, plan_id: &str) -> Result<Lease<T>, String> {
        let slot = self.slot.lock().map_err(|_| ERR)?;
        if self.closing.load(Ordering::SeqCst) {
            return Err("application-closing".into());
        }
        let Some(Slot::Active {
            plan_id: current,
            actor,
            ..
        }) = slot.as_ref()
        else {
            return Err("scan-resume-plan-unavailable".into());
        };
        if current != plan_id || actor.closing.load(Ordering::SeqCst) {
            return Err("scan-resume-plan-stale".into());
        }
        Ok(Lease {
            registry: Arc::downgrade(self),
            actor: actor.clone(),
            actor_work: Some(actor.work.acquire()),
            _registry_work: self.work.acquire(),
        })
    }
    /// The opener request remains identifiable after its IPC reply. A lost/late-aborted
    /// opening therefore cannot leave an unclaimable native allocation behind.
    pub(crate) fn cancel_open(&self, request_id: &str) -> Result<(), String> {
        let mut slot = self.slot.lock().map_err(|_| ERR)?;
        match slot.as_mut() {
            Some(Slot::Opening {
                request_id: id,
                canceled,
                ..
            }) if id == request_id => *canceled = true,
            Some(Slot::Active {
                request_id: id,
                actor,
                ..
            }) if id == request_id => {
                actor.closing.store(true, Ordering::SeqCst);
                if actor.work.count() == 0 {
                    *slot = None;
                }
            }
            _ => (),
        }
        Ok(())
    }
    fn retire(&self, actor: &Arc<Actor<T>>) {
        if let Ok(mut slot) = self.slot.lock() {
            if matches!(slot.as_ref(), Some(Slot::Active { actor: current, .. }) if Arc::ptr_eq(current, actor) && actor.closing.load(Ordering::SeqCst) && actor.work.count() == 0)
            {
                *slot = None;
            }
        }
    }
    /// Join only the opener's actual admission/allocation work after a lost or
    /// refused reply. An unrelated episode is never closed by this operation.
    pub(crate) async fn close_open(&self, request_id: &str) -> Result<(), String> {
        if !identifier(request_id) {
            return Err("invalid-request-id".into());
        }
        let (work, actor) = {
            let mut slot = self.slot.lock().map_err(|_| ERR)?;
            match slot.as_mut() {
                Some(Slot::Opening {
                    request_id: id,
                    canceled,
                    work,
                }) if id == request_id => {
                    *canceled = true;
                    (Some(work.clone()), None)
                }
                Some(Slot::Active {
                    request_id: id,
                    actor,
                    ..
                }) if id == request_id => {
                    actor.closing.store(true, Ordering::SeqCst);
                    (Some(actor.work.clone()), Some(actor.clone()))
                }
                _ => (None, None),
            }
        };
        if let Some(work) = work {
            work.drained().await;
        }
        if let Some(actor) = actor {
            self.retire(&actor);
        }
        Ok(())
    }
    pub(crate) async fn close(&self, plan_id: &str) -> Result<(), String> {
        let actor = {
            let slot = self.slot.lock().map_err(|_| ERR)?;
            match slot.as_ref() {
                None => return Ok(()),
                Some(Slot::Active {
                    plan_id: current,
                    actor,
                    ..
                }) if current == plan_id => {
                    actor.closing.store(true, Ordering::SeqCst);
                    actor.clone()
                }
                _ => return Err("scan-resume-plan-stale".into()),
            }
        };
        actor.work.drained().await;
        self.retire(&actor);
        Ok(())
    }
    pub(crate) async fn shutdown(&self) -> Result<(), String> {
        {
            let mut slot = self.slot.lock().map_err(|_| ERR)?;
            self.closing.store(true, Ordering::SeqCst);
            match slot.as_mut() {
                Some(Slot::Opening { canceled, .. }) => *canceled = true,
                Some(Slot::Active { actor, .. }) => actor.closing.store(true, Ordering::SeqCst),
                None => (),
            }
        }
        self.work.drained().await;
        *self.slot.lock().map_err(|_| ERR)? = None;
        Ok(())
    }
}
impl<T> Opening<T> {
    pub(crate) fn install(mut self, plan_id: &str, data: T) -> Result<(), String> {
        if !identifier(plan_id) {
            return Err("scan-resume-plan-invalid".into());
        }
        {
            let mut slot = self.registry.slot.lock().map_err(|_| ERR)?;
            if self.registry.closing.load(Ordering::SeqCst) {
                return Err("application-closing".into());
            }
            if !matches!(slot.as_ref(), Some(Slot::Opening { request_id, canceled: false, .. }) if request_id == &self.request_id)
            {
                return Err("canceled".into());
            }
            *slot = Some(Slot::Active {
                request_id: self.request_id.clone(),
                plan_id: plan_id.into(),
                actor: Arc::new(Actor {
                    closing: AtomicBool::new(false),
                    data: Mutex::new(data),
                    work: Arc::new(WorkOwner::default()),
                }),
            });
        }
        self.installed = true;
        Ok(())
    }
}
impl<T> Drop for Opening<T> {
    fn drop(&mut self) {
        if !self.installed {
            if let Ok(mut slot) = self.registry.slot.lock() {
                if matches!(slot.as_ref(), Some(Slot::Opening { request_id, .. }) if request_id == &self.request_id)
                {
                    *slot = None;
                }
            }
        }
    }
}
impl<T> Lease<T> {
    pub(crate) fn check(&self) -> Result<(), String> {
        if self.actor.closing.load(Ordering::SeqCst) {
            Err("canceled".into())
        } else {
            Ok(())
        }
    }
    pub(crate) fn with<R>(
        &self,
        action: impl FnOnce(&mut T) -> Result<R, String>,
    ) -> Result<R, String> {
        let mut data = self.actor.data.lock().map_err(|_| ERR)?;
        self.check()?;
        action(&mut data)
    }
    /// Actual settled transport/COMMIT cleanup must run even after a late close.
    /// Only native retained owners call this; it is not exposed as an IPC rebase.
    pub(crate) fn settle<R>(
        &self,
        action: impl FnOnce(&mut T) -> Result<R, String>,
    ) -> Result<R, String> {
        let mut data = self.actor.data.lock().map_err(|_| ERR)?;
        action(&mut data)
    }
}
impl<T> Drop for Lease<T> {
    fn drop(&mut self) {
        drop(self.actor_work.take());
        if let Some(registry) = self.registry.upgrade() {
            registry.retire(&self.actor);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn close_waits_actual_leases_and_late_settlement_can_preserve_ack() {
        let registry = Arc::new(Registry::default());
        registry
            .begin("opening-a")
            .unwrap()
            .install("plan-a", 0usize)
            .unwrap();
        let lease = registry.acquire("plan-a").unwrap();
        let closer = registry.clone();
        let close = tokio::spawn(async move { closer.close("plan-a").await });
        tokio::task::yield_now().await;
        assert!(!close.is_finished());
        assert!(registry.acquire("plan-a").is_err());
        assert!(lease.with(|_| Ok(())).is_err());
        lease
            .settle(|value| {
                *value = 1;
                Ok(())
            })
            .unwrap();
        drop(lease);
        close.await.unwrap().unwrap();
        registry
            .begin("opening-b")
            .unwrap()
            .install("plan-b", 2)
            .unwrap();
        registry.close("plan-b").await.unwrap();
    }
    #[test]
    fn canceled_open_cannot_install_and_retry_waits_for_actual_admission_drop() {
        let registry = Arc::new(Registry::<usize>::default());
        let opening = registry.begin("opening-a").unwrap();
        registry.cancel_open("opening-a").unwrap();
        assert!(registry.begin("opening-b").is_err());
        assert!(opening.install("plan-a", 1).is_err());
        assert!(registry.begin("opening-b").is_ok());
    }
    #[test]
    fn lost_reply_cancel_retires_only_exact_opener_after_all_actual_work() {
        let registry = Arc::new(Registry::default());
        registry
            .begin("opening-a")
            .unwrap()
            .install("plan-a", 1)
            .unwrap();
        let lease = registry.acquire("plan-a").unwrap();
        registry.cancel_open("unrelated").unwrap();
        assert!(lease.check().is_ok());
        registry.cancel_open("opening-a").unwrap();
        assert!(lease.check().is_err());
        assert!(registry.begin("opening-b").is_err());
        drop(lease);
        assert!(registry.begin("opening-b").is_ok());
    }
    #[tokio::test]
    async fn shutdown_joins_inflight_admission_and_permanently_refuses_new_work() {
        let registry = Arc::new(Registry::<usize>::default());
        let opening = registry.begin("opening-a").unwrap();
        let closer = registry.clone();
        let close = tokio::spawn(async move { closer.shutdown().await });
        tokio::task::yield_now().await;
        assert!(!close.is_finished());
        assert!(opening.install("plan-a", 1).is_err());
        close.await.unwrap().unwrap();
        assert!(registry.begin("opening-b").is_err());
    }
}
