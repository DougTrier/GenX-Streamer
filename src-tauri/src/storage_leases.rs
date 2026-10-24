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

//! Root identity is retained through work; replacement waits for every lease.
use crate::{storage::Store, storage_transaction::RecordSnapshot};
use std::ops::{Deref, DerefMut};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    RwLock, RwLockReadGuard, RwLockWriteGuard,
};

struct Generation {
    number: u64,
    initializing: bool,
    store: Result<Store, String>,
}
pub(crate) struct StoreOwner(RwLock<Generation>);
#[derive(Clone, Copy)]
pub(crate) struct InitialTicket {
    generation: u64,
}
pub(crate) struct ReadLease<'a>(RwLockReadGuard<'a, Generation>);
pub(crate) struct ExclusiveLease<'a>(RwLockWriteGuard<'a, Generation>);
impl ReadLease<'_> {
    /// Bind work that releases the synchronous root lease before awaiting OS crypto.
    pub(crate) fn generation(&self) -> u64 {
        self.0.number
    }
}

impl Deref for ReadLease<'_> {
    type Target = Result<Store, String>;
    fn deref(&self) -> &Self::Target {
        &self.0.store
    }
}
impl Deref for ExclusiveLease<'_> {
    type Target = Result<Store, String>;
    fn deref(&self) -> &Self::Target {
        &self.0.store
    }
}
impl DerefMut for ExclusiveLease<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0.store
    }
}
impl StoreOwner {
    pub(crate) fn new(store: Result<Store, String>) -> Self {
        Self(RwLock::new(Generation {
            number: 1,
            initializing: false,
            store,
        }))
    }
    pub(crate) fn initializing() -> (Self, InitialTicket) {
        (
            Self(RwLock::new(Generation {
                number: 1,
                initializing: true,
                store: Err("storage-initializing".into()),
            })),
            InitialTicket { generation: 1 },
        )
    }
    pub(crate) fn install_initial(
        &self,
        ticket: InitialTicket,
        store: Result<Store, String>,
        closing: &AtomicBool,
        publish_target: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut current = self.0.write().map_err(|_| "storage-lock")?;
        if current.number != ticket.generation || !current.initializing {
            return Err("storage-startup-obsolete".into());
        }
        if closing.load(Ordering::SeqCst) {
            return Err("application-closing".into());
        }
        // No root lease crosses opening. Adoption and target publication share this exact fence.
        if let Err(error) = publish_target() {
            current.store = Err(error.clone());
            current.initializing = false;
            return Err(error);
        }
        current.store = store;
        current.initializing = false;
        Ok(())
    }
    pub(crate) fn read(&self) -> Result<ReadLease<'_>, String> {
        let _time = crate::storage_timings::measure(crate::storage_timings::Stage::ReadAdmission);
        self.0
            .read()
            .map(ReadLease)
            .map_err(|_| "storage-lock".into())
    }
    pub(crate) fn exclusive(&self) -> Result<ExclusiveLease<'_>, String> {
        let _time =
            crate::storage_timings::measure(crate::storage_timings::Stage::ReplacementAdmission);
        let mut current = self.0.write().map_err(|_| "storage-lock")?;
        current.number = current
            .number
            .checked_add(1)
            .ok_or("storage-generation-exhausted")?;
        current.initializing = false;
        Ok(ExclusiveLease(current))
    }
    /// A failed post-maintenance verification can revoke only the root it inspected.
    /// Call after releasing its read lease; acquiring this write lease joins other readers.
    pub(crate) fn quarantine_after_maintenance(&self, generation: u64) -> Result<bool, String> {
        let mut current = self.0.write().map_err(|_| "storage-lock")?;
        if current.number != generation || current.initializing {
            return Ok(false);
        }
        let next = current
            .number
            .checked_add(1)
            .ok_or("storage-generation-exhausted")?;
        current.number = next;
        current.initializing = false;
        current.store = Err("storage-maintenance-verification-failed".into());
        Ok(true)
    }
    pub(crate) fn read_initial(&self, succeeded: &AtomicBool) -> Result<RecordSnapshot, String> {
        let lease = self.read()?;
        if lease.0.initializing {
            return Err("storage-initializing".into());
        }
        let generation = lease.0.number;
        let result = lease
            .as_ref()
            .map_err(Clone::clone)
            .and_then(Store::read_snapshot);
        // A replacement cannot cross this success publication while the read
        // lease still owns the original root.
        if result.is_ok() {
            succeeded.store(true, Ordering::SeqCst);
        }
        drop(lease);
        if let Err(error) = &result {
            self.poison_initial(generation, error, succeeded)?;
        }
        result
    }
    pub(crate) fn read_guide_capture(
        &self,
        succeeded: &AtomicBool,
    ) -> Result<crate::storage_transaction::GuideCaptureSnapshot, String> {
        let lease = self.read()?;
        // A narrow read cannot establish startup health or recover a poisoned root.
        if !succeeded.load(Ordering::SeqCst) {
            return Err("storage-not-ready".into());
        }
        lease.as_ref().map_err(Clone::clone)?.read_guide_capture()
    }
    fn poison_initial(
        &self,
        generation: u64,
        error: &str,
        succeeded: &AtomicBool,
    ) -> Result<(), String> {
        let mut current = self.0.write().map_err(|_| "storage-lock")?;
        if current.number == generation && !succeeded.load(Ordering::SeqCst) {
            current.number = current
                .number
                .checked_add(1)
                .ok_or("storage-generation-exhausted")?;
            current.store = Err(error.to_owned());
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "storage_lease_tests.rs"]
mod tests;
