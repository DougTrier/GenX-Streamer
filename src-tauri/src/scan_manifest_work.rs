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

//! A retained owner spans SQLite preparation, OS protection, and final admission.
//! No synchronous store lease or SQLite transaction crosses a crypto await.
use crate::{
    close_owner::WorkGuard, requests, storage::Store, storage_leases::StoreOwner, NativeState,
};
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::Manager;

pub(crate) struct Context {
    store: Arc<StoreOwner>,
    ready: Arc<AtomicBool>,
    closing: Arc<AtomicBool>,
    receiver: Mutex<requests::Receiver>,
    _work: WorkGuard,
}
impl Context {
    fn new(request_id: String, app: &tauri::AppHandle) -> Result<Arc<Self>, String> {
        let state = app.state::<NativeState>();
        let work = state.admit_work()?;
        let receiver = state
            .requests
            .lock()
            .map_err(|_| "request-lock")?
            .register(request_id)?;
        let context = Arc::new(Self {
            store: state.store.clone(),
            ready: state.read_succeeded.clone(),
            closing: state.closing.clone(),
            receiver: Mutex::new(receiver),
            _work: work,
        });
        context.check()?;
        Ok(context)
    }
    pub(crate) fn check(&self) -> Result<(), String> {
        if self.closing.load(Ordering::SeqCst) {
            return Err("application-closing".into());
        }
        if !matches!(
            self.receiver.lock().map_err(|_| "request-lock")?.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ) {
            return Err("canceled".into());
        }
        if !self.ready.load(Ordering::SeqCst) {
            return Err("storage-not-ready".into());
        }
        Ok(())
    }
    pub(crate) async fn storage<T: Send + 'static>(
        self: &Arc<Self>,
        generation: Option<u64>,
        operation: impl FnOnce(&Store, &mut dyn FnMut() -> Result<(), String>) -> Result<T, String>
            + Send
            + 'static,
    ) -> Result<(T, u64), String> {
        self.storage_with_generation(generation, move |store, _, check| operation(store, check))
            .await
    }
    pub(crate) async fn storage_with_generation<T: Send + 'static>(
        self: &Arc<Self>,
        generation: Option<u64>,
        operation: impl FnOnce(&Store, u64, &mut dyn FnMut() -> Result<(), String>) -> Result<T, String>
            + Send
            + 'static,
    ) -> Result<(T, u64), String> {
        let context = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            context.check()?;
            let lease = context.store.read()?;
            if generation.is_some_and(|expected| expected != lease.generation()) {
                return Err("scan-manifest-root-changed".into());
            }
            context.check()?;
            let value = operation(
                lease.as_ref().map_err(Clone::clone)?,
                lease.generation(),
                &mut || context.check(),
            )?;
            // A durable COMMIT receipt must survive a subsequent cancellation.
            Ok((value, lease.generation()))
        })
        .await
        .map_err(|_| "scan-manifest-worker-failed".to_string())?
    }
}

pub(crate) async fn owned<T, F, Fut>(
    request_id: String,
    app: tauri::AppHandle,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Arc<Context>) -> Fut + Send + 'static,
    Fut: Future<Output = Result<T, String>> + Send + 'static,
{
    let context = Context::new(request_id, &app)?;
    spawn(context, operation)
        .await
        .map_err(|_| "scan-manifest-worker-failed".to_string())?
}

#[cfg(test)]
pub(crate) fn bookmark_context_fixture() -> (
    tempfile::TempDir,
    Arc<Context>,
    Arc<Context>,
    Arc<crate::close_owner::WorkOwner>,
    requests::Requests,
) {
    let (root, playback, work, mut requests) = tests::fixture();
    let command = Arc::new(Context {
        store: playback.store.clone(),
        ready: playback.ready.clone(),
        closing: playback.closing.clone(),
        receiver: Mutex::new(
            requests
                .register("bookmark-command-fixture".into())
                .unwrap(),
        ),
        _work: work.acquire(),
    });
    (root, command, playback, work, requests)
}
fn spawn<T, F, Fut>(
    context: Arc<Context>,
    operation: F,
) -> tokio::task::JoinHandle<Result<T, String>>
where
    T: Send + 'static,
    F: FnOnce(Arc<Context>) -> Fut + Send + 'static,
    Fut: Future<Output = Result<T, String>> + Send + 'static,
{
    // The producer retains its request and work guards if the observing caller disappears.
    tokio::spawn(async move { operation(context).await })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::close_owner::WorkOwner;
    pub(super) fn fixture() -> (
        tempfile::TempDir,
        Arc<Context>,
        Arc<WorkOwner>,
        requests::Requests,
    ) {
        let root = tempfile::tempdir().unwrap();
        let work = Arc::new(WorkOwner::default());
        let mut requests = requests::Requests::default();
        let receiver = requests.register("manifest-fixture".into()).unwrap();
        let context = Arc::new(Context {
            store: Arc::new(StoreOwner::new(Ok(Store::new(
                root.path().to_owned(),
                "test".into(),
            )
            .unwrap()))),
            ready: Arc::new(AtomicBool::new(true)),
            closing: Arc::new(AtomicBool::new(false)),
            receiver: Mutex::new(receiver),
            _work: work.acquire(),
        });
        (root, context, work, requests)
    }
    #[tokio::test]
    async fn disappearing_observer_does_not_detach_crypto_or_release_close_guard() {
        let (_root, context, work, mut requests) = fixture();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let task = spawn(context, move |context| async move {
            entered_tx.send(()).unwrap();
            release_rx.await.unwrap();
            let result = context.check();
            done_tx.send(result.clone()).unwrap();
            result
        });
        entered_rx.await.unwrap();
        drop(task);
        requests.cancel("manifest-fixture".into()).unwrap();
        assert_eq!(work.count(), 1);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), work.drained())
                .await
                .is_err()
        );
        release_tx.send(()).unwrap();
        assert_eq!(done_rx.await.unwrap().unwrap_err(), "canceled");
        work.drained().await;
        requests.drain_owner().drained().await;
        assert_eq!(work.count(), 0);
    }
    #[tokio::test]
    async fn root_replacement_between_prepare_and_crypto_refuses_final_operation() {
        let (_root, context, _work, _requests) = fixture();
        let (_, generation) = context
            .storage(None, |_, check| {
                check()?;
                Ok(())
            })
            .await
            .unwrap();
        let replacement = tempfile::tempdir().unwrap();
        *context.store.exclusive().unwrap() =
            Ok(Store::new(replacement.path().to_owned(), "test".into()).unwrap());
        let ran = Arc::new(AtomicBool::new(false));
        let observed = ran.clone();
        let error = context
            .storage(Some(generation), move |_, _| {
                observed.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await
            .unwrap_err();
        assert_eq!(error, "scan-manifest-root-changed");
        assert!(!ran.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn actual_operation_receipt_survives_abort_after_its_commit_boundary() {
        let (_root, context, _work, mut requests) = fixture();
        let (value, _) = context
            .storage(None, move |_, check| {
                check()?;
                // The domain transaction tests prove COMMIT; this tests the owner boundary only.
                requests.cancel("manifest-fixture".into())?;
                Ok("durable-receipt")
            })
            .await
            .unwrap();
        assert_eq!(value, "durable-receipt");
        assert_eq!(context.check().unwrap_err(), "canceled");
    }
}

#[cfg(test)]
#[path = "scan_manifest_work_mapping_tests.rs"]
mod mapping_lifecycle_tests;
