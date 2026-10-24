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

//! Native guide ownership: bounded previews, cancellation, revision guards and off-thread SQLite.
use crate::{
    guide::{database as db, input, parser},
    storage::Store,
    NativeState,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tokio::sync::{Notify, Semaphore};

#[derive(Clone)]
struct Stage {
    request_id: String,
    source_id: String,
    source_revision: i64,
    root_generation: u64,
    retention_scope: Option<crate::guide::retention::Scope>,
    generation: u64,
    parsed: Arc<parser::ParsedGuide>,
    canceled: Arc<AtomicBool>,
    created: Instant,
}
#[derive(Default)]
struct Ownership {
    closed: bool,
    next: u64,
    latest: HashMap<String, (u64, Arc<AtomicBool>)>,
    active: HashMap<String, Arc<AtomicBool>>,
    stages: HashMap<String, Stage>,
    uploads: HashMap<String, FileUpload>,
}
const FILE_CHUNK: usize = 32 * 1024;
#[derive(Clone)]
struct FileAdmission {
    generation: u64,
    revision: i64,
    canceled: Arc<AtomicBool>,
}
struct FileUpload {
    source_id: String,
    request_id: String,
    admission: FileAdmission,
    deadline: Instant,
    total: usize,
    bytes: Vec<u8>,
    timer: Option<tokio::task::JoinHandle<()>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadStarted {
    upload_id: String,
    chunk_bytes: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadProgress {
    received_bytes: usize,
}
pub(crate) struct NativeGuides {
    ownership: Mutex<Ownership>,
    parser: Arc<Semaphore>,
    drained: Notify,
}
impl Default for NativeGuides {
    fn default() -> Self {
        Self {
            ownership: Mutex::new(Ownership::default()),
            parser: Arc::new(Semaphore::new(1)),
            drained: Notify::new(),
        }
    }
}
impl Ownership {
    fn release_finished_generations(&mut self) {
        // The generation entry owns one token. Active work, staged previews,
        // uploads and take_upload/admit_upload transfers own additional tokens.
        // Never drop their supersession fence while any such owner survives.
        self.latest
            .retain(|_, (_, flag)| Arc::strong_count(flag) > 1);
    }
    fn prune(&mut self) {
        self.uploads.retain(|_, upload| {
            let keep = Instant::now() < upload.deadline
                && !upload.admission.canceled.load(Ordering::SeqCst);
            if !keep {
                upload.admission.canceled.store(true, Ordering::SeqCst);
                if let Some(timer) = &upload.timer {
                    timer.abort();
                }
            }
            keep
        });
        self.stages.retain(|_, stage| {
            let keep = stage.created.elapsed() < Duration::from_secs(120)
                && !stage.canceled.load(Ordering::SeqCst);
            if !keep {
                stage.canceled.store(true, Ordering::SeqCst);
            }
            keep
        });
        self.release_finished_generations();
    }
}
struct Active {
    owner: Arc<NativeGuides>,
    id: String,
}
impl Drop for Active {
    fn drop(&mut self) {
        if let Ok(mut state) = self.owner.ownership.lock() {
            state.active.remove(&self.id);
            state.release_finished_generations();
            if state.active.is_empty() {
                self.owner.drained.notify_one();
            }
        }
    }
}
impl NativeGuides {
    fn start_upload(
        self: &Arc<Self>,
        source_id: String,
        request_id: String,
        revision: i64,
        total: usize,
    ) -> Result<UploadStarted, String> {
        self.start_upload_for(
            source_id,
            request_id,
            revision,
            total,
            Duration::from_secs(120),
        )
    }
    fn start_upload_for(
        self: &Arc<Self>,
        source_id: String,
        request_id: String,
        revision: i64,
        total: usize,
        lifetime: Duration,
    ) -> Result<UploadStarted, String> {
        if total == 0 || total > input::INPUT_LIMIT {
            return Err("guide-input-too-large".into());
        }
        let mut state = self.ownership.lock().map_err(|_| "guide-owner-lock")?;
        state.prune();
        if state.closed {
            return Err("application-closing".into());
        }
        if !state.uploads.is_empty() || state.active.contains_key(&request_id) {
            return Err("guide-upload-busy".into());
        }
        let mut buffer = Vec::new();
        buffer
            .try_reserve_exact(total)
            .map_err(|_| "guide-upload-memory-unavailable")?;
        if let Some((_, flag)) = state.latest.get(&source_id) {
            flag.store(true, Ordering::SeqCst);
        }
        state.stages.retain(|_, stage| stage.source_id != source_id);
        state.next = state
            .next
            .checked_add(1)
            .ok_or("guide-generation-exhausted")?;
        let generation = state.next;
        let canceled = Arc::new(AtomicBool::new(false));
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| "guide-ticket-unavailable")?;
        let upload_id: String = random.iter().map(|b| format!("{b:02x}")).collect();
        state
            .latest
            .insert(source_id.clone(), (generation, canceled.clone()));
        let weak = Arc::downgrade(self);
        let expired_id = upload_id.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep(lifetime).await;
            if let Some(owner) = weak.upgrade() {
                if let Ok(mut state) = owner.ownership.lock() {
                    if let Some(upload) = state.uploads.remove(&expired_id) {
                        upload.admission.canceled.store(true, Ordering::SeqCst);
                    }
                    state.release_finished_generations();
                }
            }
        });
        state.uploads.insert(
            upload_id.clone(),
            FileUpload {
                source_id,
                request_id,
                admission: FileAdmission {
                    generation,
                    revision,
                    canceled,
                },
                deadline: Instant::now() + lifetime,
                total,
                bytes: buffer,
                timer: Some(timer),
            },
        );
        Ok(UploadStarted {
            upload_id,
            chunk_bytes: FILE_CHUNK,
        })
    }
    fn append_upload(
        &self,
        id: &str,
        offset: usize,
        bytes: Vec<u8>,
    ) -> Result<UploadProgress, String> {
        let mut state = self.ownership.lock().map_err(|_| "guide-owner-lock")?;
        state.prune();
        if state.closed {
            return Err("application-closing".into());
        }
        let mut upload = state.uploads.remove(id).ok_or("guide-upload-expired")?;
        if bytes.is_empty()
            || bytes.len() > FILE_CHUNK
            || offset != upload.bytes.len()
            || bytes.len() > upload.total.saturating_sub(offset)
        {
            upload.admission.canceled.store(true, Ordering::SeqCst);
            if let Some(timer) = &upload.timer {
                timer.abort();
            }
            drop(upload);
            state.release_finished_generations();
            return Err("guide-upload-chunk-invalid".into());
        }
        upload.bytes.extend_from_slice(&bytes);
        let received_bytes = upload.bytes.len();
        state.uploads.insert(id.into(), upload);
        Ok(UploadProgress { received_bytes })
    }
    fn take_upload(&self, id: &str) -> Result<FileUpload, String> {
        let mut state = self.ownership.lock().map_err(|_| "guide-owner-lock")?;
        state.prune();
        if state.closed {
            return Err("application-closing".into());
        }
        let upload = state.uploads.remove(id).ok_or("guide-upload-expired")?;
        if let Some(timer) = &upload.timer {
            timer.abort();
        }
        if upload.bytes.len() != upload.total {
            upload.admission.canceled.store(true, Ordering::SeqCst);
            drop(upload);
            state.release_finished_generations();
            return Err("guide-upload-incomplete".into());
        }
        Ok(upload)
    }
    fn discard_upload(&self, id: &str) -> Result<(), String> {
        let mut state = self.ownership.lock().map_err(|_| "guide-owner-lock")?;
        if let Some(upload) = state.uploads.remove(id) {
            upload.admission.canceled.store(true, Ordering::SeqCst);
            if let Some(timer) = upload.timer {
                timer.abort();
            }
        }
        state.release_finished_generations();
        Ok(())
    }
    fn admit_upload(
        self: &Arc<Self>,
        source_id: &str,
        request_id: &str,
        admission: FileAdmission,
    ) -> Result<(u64, Arc<AtomicBool>, Active), String> {
        let mut state = self.ownership.lock().map_err(|_| "guide-owner-lock")?;
        state.prune();
        if state.closed
            || admission.canceled.load(Ordering::SeqCst)
            || state
                .latest
                .get(source_id)
                .is_none_or(|(generation, _)| *generation != admission.generation)
        {
            return Err("canceled".into());
        }
        if state.active.len() >= 4 || state.active.contains_key(request_id) {
            return Err("guide-preview-busy".into());
        }
        state
            .active
            .insert(request_id.into(), admission.canceled.clone());
        Ok((
            admission.generation,
            admission.canceled,
            Active {
                owner: self.clone(),
                id: request_id.into(),
            },
        ))
    }
    pub(crate) fn cancel_request(&self, request_id: &str) -> Result<(), String> {
        let mut state = self.ownership.lock().map_err(|_| "guide-owner-lock")?;
        if let Some(flag) = state.active.get(request_id) {
            flag.store(true, Ordering::SeqCst);
        }
        for stage in state.stages.values() {
            if stage.request_id == request_id {
                stage.canceled.store(true, Ordering::SeqCst);
            }
        }
        state.uploads.retain(|_, upload| {
            if upload.request_id == request_id {
                upload.admission.canceled.store(true, Ordering::SeqCst);
                if let Some(timer) = &upload.timer {
                    timer.abort();
                }
                false
            } else {
                true
            }
        });
        state.prune();
        Ok(())
    }
    fn begin_automatic(
        self: &Arc<Self>,
        source_id: &str,
        request_id: &str,
    ) -> Result<Option<(u64, Arc<AtomicBool>, Active)>, String> {
        let mut state = self.ownership.lock().map_err(|_| "guide-owner-lock")?;
        state.prune();
        if state.closed {
            return Err("application-closing".into());
        }
        if !state.active.is_empty() || !state.stages.is_empty() || !state.uploads.is_empty() {
            return Ok(None);
        }
        state.next = state
            .next
            .checked_add(1)
            .ok_or("guide-generation-exhausted")?;
        let generation = state.next;
        let flag = Arc::new(AtomicBool::new(false));
        state
            .latest
            .insert(source_id.into(), (generation, flag.clone()));
        state.active.insert(request_id.into(), flag.clone());
        Ok(Some((
            generation,
            flag,
            Active {
                owner: self.clone(),
                id: request_id.into(),
            },
        )))
    }
    fn begin(
        self: &Arc<Self>,
        source_id: &str,
        request_id: &str,
    ) -> Result<(u64, Arc<AtomicBool>, Active), String> {
        let mut state = self.ownership.lock().map_err(|_| "guide-owner-lock")?;
        state.prune();
        if state.closed {
            return Err("application-closing".into());
        }
        if state.active.len() >= 4 || state.active.contains_key(request_id) {
            return Err("guide-preview-busy".into());
        }
        if let Some((_, old)) = state.latest.get(source_id) {
            old.store(true, Ordering::SeqCst);
        }
        state.stages.retain(|_, stage| stage.source_id != source_id);
        state.next = state
            .next
            .checked_add(1)
            .ok_or("guide-generation-exhausted")?;
        let generation = state.next;
        let canceled = Arc::new(AtomicBool::new(false));
        state
            .latest
            .insert(source_id.into(), (generation, canceled.clone()));
        state.active.insert(request_id.into(), canceled.clone());
        Ok((
            generation,
            canceled,
            Active {
                owner: self.clone(),
                id: request_id.into(),
            },
        ))
    }
    fn stage(&self, stage: Stage) -> Result<String, String> {
        let mut state = self.ownership.lock().map_err(|_| "guide-owner-lock")?;
        state.prune();
        if state.closed
            || stage.canceled.load(Ordering::SeqCst)
            || state
                .latest
                .get(&stage.source_id)
                .is_none_or(|(generation, _)| *generation != stage.generation)
        {
            return Err("canceled".into());
        }
        if state.stages.len() >= 2 {
            return Err("guide-preview-ticket-limit".into());
        }
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| "guide-ticket-unavailable")?;
        let ticket: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        state.stages.insert(ticket.clone(), stage);
        Ok(ticket)
    }
    fn ticket(&self, ticket: &str) -> Result<Stage, String> {
        let mut state = self.ownership.lock().map_err(|_| "guide-owner-lock")?;
        state.prune();
        if state.closed {
            return Err("application-closing".into());
        }
        state
            .stages
            .get(ticket)
            .cloned()
            .ok_or_else(|| "guide-preview-expired".into())
    }
    fn active_commit(
        self: &Arc<Self>,
        ticket: &str,
        flag: Arc<AtomicBool>,
    ) -> Result<Active, String> {
        let mut state = self.ownership.lock().map_err(|_| "guide-owner-lock")?;
        if state.closed || flag.load(Ordering::SeqCst) {
            return Err("canceled".into());
        }
        let id = format!("commit-{ticket}");
        if state.active.len() >= 4 || state.active.contains_key(&id) {
            return Err("guide-commit-busy".into());
        }
        state.active.insert(id.clone(), flag);
        Ok(Active {
            owner: self.clone(),
            id,
        })
    }
    fn discard(&self, ticket: &str) -> Result<(), String> {
        let mut state = self.ownership.lock().map_err(|_| "guide-owner-lock")?;
        if let Some(stage) = state.stages.remove(ticket) {
            stage.canceled.store(true, Ordering::SeqCst);
        }
        state.release_finished_generations();
        Ok(())
    }
    fn invalidate(&self, id: &str) -> Result<(), String> {
        let mut state = self.ownership.lock().map_err(|_| "guide-owner-lock")?;
        if let Some((_, flag)) = state.latest.remove(id) {
            flag.store(true, Ordering::SeqCst);
        }
        state.stages.retain(|_, stage| stage.source_id != id);
        state.prune();
        Ok(())
    }
    pub(crate) async fn shutdown(&self) -> Result<(), &'static str> {
        let timers = {
            let mut state = self.ownership.lock().map_err(|_| "guide-owner-lock")?;
            state.closed = true;
            for flag in state.active.values() {
                flag.store(true, Ordering::SeqCst);
            }
            for (_, flag) in state.latest.values() {
                flag.store(true, Ordering::SeqCst);
            }
            state.stages.clear();
            state
                .uploads
                .drain()
                .filter_map(|(_, upload)| upload.timer)
                .collect::<Vec<_>>()
        };
        for timer in timers {
            timer.abort();
            let _ = timer.await;
        }
        loop {
            if self
                .ownership
                .lock()
                .map_err(|_| "guide-owner-lock")?
                .active
                .is_empty()
            {
                return Ok(());
            }
            self.drained.notified().await;
        }
    }
}

#[cfg(test)]
#[path = "native_guide_tests.rs"]
mod tests;

async fn store<R: Send + 'static>(
    app: &tauri::AppHandle,
    operation: impl FnOnce(&Store) -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    let state = app.state::<NativeState>();
    if state.closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    let work = state.admit_work()?;
    let owned = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        let storage = owned.read().map_err(|_| "storage-lock")?;
        operation(storage.as_ref().map_err(Clone::clone)?)
    })
    .await
    .map_err(|_| "guide-worker-failed".to_string())?
}

async fn store_generation<R: Send + 'static>(
    app: &tauri::AppHandle,
    expected: Option<u64>,
    operation: impl FnOnce(&Store) -> Result<R, String> + Send + 'static,
) -> Result<(R, u64), String> {
    let state = app.state::<NativeState>();
    let work = state.admit_work()?;
    let owned = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        let lease = owned.read().map_err(|_| "storage-lock")?;
        if expected.is_some_and(|e| e != lease.generation()) {
            return Err("scan-manifest-root-changed".into());
        }
        let value = operation(lease.as_ref().map_err(Clone::clone)?)?;
        Ok((value, lease.generation()))
    })
    .await
    .map_err(|_| "guide-worker-failed".to_string())?
}

// This module's parts, by area, are in native_guide/.
mod previews;
pub(crate) use previews::*;
mod commits;
pub(crate) use commits::*;
mod queries;
pub(crate) use queries::*;
mod refresh;
pub(crate) use refresh::*;
