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

//! One retained startup operation. Joining is not a claim that the database opened successfully.
use crate::{
    close_owner::WorkGuard,
    storage::{StorageTarget, Store},
    storage_leases::{InitialTicket, StoreOwner},
};
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tokio::sync::{Mutex as AsyncMutex, Notify};

struct Retained {
    // Borrow while awaiting; a canceled waiter cannot drop the actual producer.
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
    joined: bool,
    store: Arc<StoreOwner>,
    ticket: InitialTicket,
    closing: Arc<AtomicBool>,
}
#[derive(Default)]
pub(crate) struct Owner {
    claimed: AtomicBool,
    task: OnceLock<AsyncMutex<Retained>>,
    started: Notify,
}
impl Owner {
    pub(crate) fn start<R>(
        &self,
        store: Arc<StoreOwner>,
        ticket: InitialTicket,
        target: Arc<Mutex<Result<StorageTarget, String>>>,
        closing: Arc<AtomicBool>,
        work: WorkGuard,
        ready: R,
    ) -> Result<(), String>
    where
        R: Future<Output = ()> + Send + 'static,
    {
        self.start_with(
            store,
            ticket,
            target,
            closing,
            work,
            ready,
            Store::open_target,
        )
    }
    // Test seam: `start` passes the real readiness signal and store opener;
    // tests inject their own `ready` and `open`.
    #[allow(clippy::too_many_arguments)]
    fn start_with<R, F>(
        &self,
        store: Arc<StoreOwner>,
        ticket: InitialTicket,
        target: Arc<Mutex<Result<StorageTarget, String>>>,
        closing: Arc<AtomicBool>,
        work: WorkGuard,
        ready: R,
        open: F,
    ) -> Result<(), String>
    where
        R: Future<Output = ()> + Send + 'static,
        F: FnOnce(&StorageTarget) -> Result<Store, String> + Send + 'static,
    {
        if self.claimed.swap(true, Ordering::SeqCst) {
            return Err("storage-startup-already-started".into());
        }
        use crate::startup_milestones::{self as milestones, Event};
        milestones::mark(Event::StartupAdmitted);
        let fallback = store.clone();
        let stopped = closing.clone();
        let handle = tauri::async_runtime::spawn(async move {
            let _work = work;
            // Android's actual native channel registration precedes all store opening.
            {
                let _time = crate::storage_timings::measure(
                    crate::storage_timings::Stage::RegistrationWait,
                );
                milestones::mark(Event::RegistrationWaitStarted);
                ready.await;
                milestones::mark(Event::RegistrationWaitFinished);
            }
            if closing.load(Ordering::SeqCst) {
                return;
            }
            let failed_store = store.clone();
            let failed_closing = closing.clone();
            let queued =
                crate::storage_timings::measure(crate::storage_timings::Stage::StartupWorkerQueue);
            milestones::mark(Event::WorkerQueued);
            let operation = tauri::async_runtime::spawn_blocking(move || {
                milestones::mark(Event::WorkerStarted);
                drop(queued);
                if closing.load(Ordering::SeqCst) {
                    return;
                }
                let mut captured = match target.lock() {
                    Ok(target) => target.clone(),
                    Err(_) => {
                        let _ = store.install_initial(
                            ticket,
                            Err("storage-lock".into()),
                            &closing,
                            || Ok(()),
                        );
                        return;
                    }
                };
                // Full original open/integrity/migration/backup remains unchanged and outside leases.
                let opened = captured.as_ref().map_err(Clone::clone).and_then(|target| {
                    milestones::mark(Event::StoreOpenStarted);
                    let opened = open(target);
                    milestones::result(Event::StoreOpenFinished, opened.is_ok());
                    opened
                });
                if let Ok(target) = captured.as_mut() {
                    target.require_existing |= target.path.is_dir();
                    target.require_database |=
                        target.path.join(crate::storage_transaction::DB).is_file();
                }
                milestones::mark(Event::StoreInstallStarted);
                let installed = store.install_initial(ticket, opened, &closing, || {
                    *target.lock().map_err(|_| "storage-lock".to_string())? = captured;
                    Ok(())
                });
                milestones::result(Event::StoreInstallFinished, installed.is_ok());
            })
            .await;
            milestones::result(Event::StartupWorkerFinished, operation.is_ok());
            if operation.is_err() {
                let _ = failed_store.install_initial(
                    ticket,
                    Err("storage-startup-worker-failed".into()),
                    &failed_closing,
                    || Ok(()),
                );
            }
        });
        // The once-start claim makes this single assignment authoritative.
        let _ = self.task.set(AsyncMutex::new(Retained {
            handle: Some(handle),
            joined: false,
            store: fallback,
            ticket,
            closing: stopped,
        }));
        self.started.notify_waiters();
        Ok(())
    }
    pub(crate) async fn join(&self) {
        let task = loop {
            let notified = self.started.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(task) = self.task.get() {
                break task;
            }
            notified.await;
        };
        let mut retained = task.lock().await;
        if retained.joined {
            return;
        }
        // Canceling this future releases only the mutex guard. The handle remains in the owner.
        let failed = if let Some(handle) = retained.handle.as_mut() {
            handle.await.is_err()
        } else {
            false
        };
        if failed {
            crate::startup_milestones::result(
                crate::startup_milestones::Event::StartupWorkerFinished,
                false,
            );
            let _ = retained.store.install_initial(
                retained.ticket,
                Err("storage-startup-worker-failed".into()),
                &retained.closing,
                || Ok(()),
            );
        }
        retained.handle.take();
        retained.joined = true;
    }
}

#[cfg(test)]
#[path = "storage_startup_tests.rs"]
mod tests;
