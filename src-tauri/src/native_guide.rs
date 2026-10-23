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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preview {
    ticket: String,
    source_id: String,
    source_revision: i64,
    channels: usize,
    programs: usize,
    first_start_ms: Option<i64>,
    last_start_ms: Option<i64>,
    last_known_stop_ms: Option<i64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    proposed: bool,
}
async fn preview(
    source_id: String,
    request_id: String,
    bytes: Option<Vec<u8>>,
    app: tauri::AppHandle,
) -> Result<Preview, String> {
    preview_admitted(source_id, request_id, bytes, None, None, None, app).await
}
async fn preview_admitted(
    source_id: String,
    request_id: String,
    bytes: Option<Vec<u8>>,
    admission: Option<FileAdmission>,
    proposed_source: Option<db::GuideSource>,
    mapping_receipt: Option<crate::guide::mapping_admission::Receipt>,
    app: tauri::AppHandle,
) -> Result<Preview, String> {
    let lookup = source_id.clone();
    let captured_now = guide_now()?;
    let expected_root = mapping_receipt
        .as_ref()
        .map(crate::guide::mapping_admission::root)
        .transpose()?;
    let (retention_scope, root_generation) =
        store_generation(&app, expected_root, move |storage| {
            storage.with_guide_read(|c| {
                if let Some(receipt) = mapping_receipt {
                    if receipt.mapping.guide_source_id != lookup {
                        return Err("guide-mapping-scope-changed".into());
                    }
                    let tx = c
                        .unchecked_transaction()
                        .map_err(|_| "guide-database-operation-failed")?;
                    crate::guide::mapping_admission::verify(
                        &tx,
                        &receipt,
                        receipt.source_revision,
                        true,
                    )?;
                    let scope = crate::guide::retention::capture(&tx, &lookup, captured_now)?;
                    tx.commit().map_err(|_| "guide-database-operation-failed")?;
                    Ok(scope)
                } else if let Some(source) = proposed_source {
                    let tx = c
                        .unchecked_transaction()
                        .map_err(|_| "guide-database-operation-failed")?;
                    let scope =
                        crate::guide::retention::capture_proposed(&tx, source, captured_now)?;
                    tx.commit().map_err(|_| "guide-database-operation-failed")?;
                    Ok(scope)
                } else {
                    crate::guide::retention::capture_snapshot(c, &lookup, captured_now)
                }
            })
        })
        .await?;
    if let Some(expected) = expected_root {
        crate::guide::mapping_admission::same_generation(expected, root_generation)?;
    }
    let source = retention_scope.source.clone();
    if admission
        .as_ref()
        .is_some_and(|a| a.revision != source.revision)
    {
        return Err("guide-stale-revision".into());
    }
    if (source.kind == "url") == bytes.is_some() {
        return Err("guide-input-kind-mismatch".into());
    }
    let state = app.state::<NativeState>();
    let mut cancel = state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .register(request_id.clone())?;
    let owner = app.state::<Arc<NativeGuides>>().inner().clone();
    let result = async {
        let (generation, canceled, _active) = match admission { Some(admission) => owner.admit_upload(&source_id, &request_id, admission)?, None => owner.begin(&source_id, &request_id)? };
        let permit = tokio::select! {
            permit = owner.parser.clone().acquire_owned() => permit.map_err(|_| "guide-owner-closed")?,
            _ = &mut cancel => { canceled.store(true, Ordering::SeqCst); return Err("canceled".into()); }
        };
        if canceled.load(Ordering::SeqCst) { return Err("canceled".into()); }
        let bytes = match bytes {
            Some(bytes) => bytes,
            None => tokio::select! {
                input = input::fetch(&source.location, source.allow_http, &canceled) => input?,
                _ = &mut cancel => { canceled.store(true, Ordering::SeqCst); return Err("canceled".into()); }
            },
        };
        let flag = canceled.clone();
        let work=state.admit_work()?;
        let mut worker = tauri::async_runtime::spawn_blocking(move || {
            let _work=work;
            let expanded = input::expand(bytes, &flag)?;
            parser::parse_guide_cancelable(&expanded, &flag)
        });
        let parsed = tokio::select! {
            parsed = &mut worker => parsed.map_err(|_| "guide-parser-worker-failed")??,
            _ = &mut cancel => { canceled.store(true, Ordering::SeqCst); let _ = worker.await; return Err("canceled".into()); }
        };
        drop(permit);
        let first_start_ms = parsed.programs.iter().map(|p| p.start_ms).min();
        let last_start_ms = parsed.programs.iter().map(|p| p.start_ms).max();
        let last_known_stop_ms = parsed.programs.iter().filter_map(|p| p.stop_ms).max();
        let channels = parsed.channels.len(); let programs = parsed.programs.len();
        let proposed = crate::guide::retention::is_proposed(&retention_scope);
        let ticket = owner.stage(Stage { request_id: request_id.clone(), source_id: source_id.clone(), source_revision: source.revision, root_generation, retention_scope: Some(retention_scope), generation, parsed: Arc::new(parsed), canceled, created: Instant::now() })?;
        Ok(Preview { ticket, source_id, source_revision: source.revision, channels, programs, first_start_ms, last_start_ms, last_known_stop_ms, proposed })
    }.await;
    state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .finish(&request_id);
    result
}

#[tauri::command]
pub(crate) async fn guide_preview(
    source_id: String,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Preview, String> {
    preview(source_id, request_id, None, app).await
}
#[tauri::command]
pub(crate) async fn guide_preview_mapped(
    receipt: crate::guide::mapping_admission::Receipt,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Preview, String> {
    crate::guide::mapping_admission::root(&receipt)?;
    preview_admitted(
        receipt.mapping.guide_source_id.clone(),
        request_id,
        None,
        None,
        None,
        Some(receipt),
        app,
    )
    .await
}
#[tauri::command]
pub(crate) async fn guide_save_mapping_receipt(
    mapping: db::GuideMapping,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<crate::guide::mapping_admission::Receipt, String> {
    crate::scan_manifest_work::owned(request_id, app, move |owner| async move {
        let final_owner = owner.clone();
        let (receipt, _) = owner
            .storage_with_generation(None, move |store, generation, check| {
                store.with_guide_write_checked(
                    |c| {
                        crate::guide::mapping_admission::save(c, mapping, generation, &mut || {
                            final_owner.check()
                        })
                    },
                    check,
                )
            })
            .await?;
        Ok(receipt)
    })
    .await
}
#[tauri::command]
pub(crate) async fn guide_mapped_schedule_status(
    receipt: crate::guide::mapping_admission::Receipt,
    expected_source_revision: i64,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<crate::guide::mapping_admission::Status, String> {
    let generation = crate::guide::mapping_admission::root(&receipt)?;
    crate::scan_manifest_work::owned(request_id, app, move |owner| async move {
        let now = guide_now()?;
        let (status, _) = owner
            .storage(Some(generation), move |store, check| {
                check()?;
                store.with_guide_read(|c| {
                    crate::guide::mapping_admission::status(
                        c,
                        &receipt,
                        expected_source_revision,
                        now,
                    )
                })
            })
            .await?;
        Ok(status)
    })
    .await
}
/// Explicit Find may inspect a new HTTPS suggestion without saving configuration.
#[tauri::command]
pub(crate) async fn guide_preview_proposed_source(
    source: db::GuideSource,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Preview, String> {
    preview_admitted(
        source.id.clone(),
        request_id,
        None,
        None,
        Some(source),
        None,
        app,
    )
    .await
}
#[tauri::command]
pub(crate) async fn guide_file_begin(
    source_id: String,
    request_id: String,
    total_bytes: usize,
    app: tauri::AppHandle,
) -> Result<UploadStarted, String> {
    let valid_id = |id: &str| {
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    if !valid_id(&source_id) || !valid_id(&request_id) {
        return Err("guide-file-header-invalid".into());
    }
    let lookup = source_id.clone();
    let source = store(&app, move |storage| {
        storage.with_guide_read(|c| {
            db::list_sources(c)?
                .into_iter()
                .find(|source| source.id == lookup)
                .ok_or_else(|| "guide-source-missing".into())
        })
    })
    .await?;
    if source.kind != "file" {
        return Err("guide-input-kind-mismatch".into());
    }
    let state = app.state::<NativeState>();
    if state.closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    let mut requests = state.requests.lock().map_err(|_| "request-lock")?;
    requests.admit_pending(&request_id)?;
    app.state::<Arc<NativeGuides>>().start_upload(
        source_id,
        request_id,
        source.revision,
        total_bytes,
    )
}
#[tauri::command]
pub(crate) fn guide_file_append(
    upload_id: String,
    offset: usize,
    bytes: Vec<u8>,
    app: tauri::AppHandle,
) -> Result<UploadProgress, String> {
    if app.state::<NativeState>().closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    app.state::<Arc<NativeGuides>>()
        .append_upload(&upload_id, offset, bytes)
}
#[tauri::command]
pub(crate) async fn guide_file_finish(
    upload_id: String,
    app: tauri::AppHandle,
) -> Result<Preview, String> {
    if app.state::<NativeState>().closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    let upload = app.state::<Arc<NativeGuides>>().take_upload(&upload_id)?;
    if let Some(timer) = upload.timer {
        timer.abort();
        let _ = timer.await;
    }
    preview_admitted(
        upload.source_id,
        upload.request_id,
        Some(upload.bytes),
        Some(upload.admission),
        None,
        None,
        app,
    )
    .await
}
#[tauri::command]
pub(crate) fn guide_file_discard(upload_id: String, app: tauri::AppHandle) -> Result<(), String> {
    app.state::<Arc<NativeGuides>>().discard_upload(&upload_id)
}
#[tauri::command]
pub(crate) async fn guide_preview_file(
    request: tauri::ipc::Request<'_>,
    app: tauri::AppHandle,
) -> Result<Preview, String> {
    let header = |name| -> Result<String, String> {
        let id = request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .ok_or("guide-file-header-invalid")?;
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("guide-file-header-invalid".into());
        }
        Ok(id.into())
    };
    let source = header("x-genx-guide-source")?;
    let id = header("x-genx-guide-request")?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) if bytes.len() <= input::INPUT_LIMIT => bytes.clone(),
        tauri::ipc::InvokeBody::Raw(_) => return Err("guide-input-too-large".into()),
        _ => return Err("guide-file-body-invalid".into()),
    };
    preview(source, id, Some(bytes), app).await
}
async fn commit_projected(
    ticket: String,
    expected_revision: i64,
    allow_empty: bool,
    match_mode: bool,
    expected_catalog: Option<String>,
    aliases: Option<crate::guide::reviewed_aliases::ReviewedAliases>,
    app: tauri::AppHandle,
) -> Result<db::CommitIfMatched, String> {
    let guide_owner = app.state::<Arc<NativeGuides>>().inner().clone();
    let stage = guide_owner.ticket(&ticket)?;
    if expected_revision != stage.source_revision {
        return Err("guide-stale-revision".into());
    }
    if stage.parsed.programs.is_empty() && !allow_empty {
        return Err("guide-empty-confirmation-required".into());
    }
    let active = guide_owner.active_commit(&ticket, stage.canceled.clone())?;
    let request_id = stage.request_id.clone();
    let result = crate::scan_manifest_work::owned(request_id, app, move |context| async move {
        let _active = active;
        let scope = stage
            .retention_scope
            .clone()
            .ok_or("guide-retention-scope-missing")?;
        let prepared = scope.clone();
        context
            .storage(Some(stage.root_generation), move |store, check| {
                check()?;
                store.with_guide_read(|c| {
                    let tx = c
                        .unchecked_transaction()
                        .map_err(|_| "guide-database-operation-failed")?;
                    crate::guide::retention::verify(&tx, &prepared)?;
                    tx.commit()
                        .map_err(|_| "guide-database-operation-failed".to_string())
                })
            })
            .await?;
        let authority = if scope.source.kind == "url"
            && scope.source.location == crate::guide::reviewed_crosswalk::FEED
        {
            crate::guide::reviewed_crosswalk::acquire(context.clone())
                .await?
                .authority
        } else {
            None
        };
        if scope.source.kind == "url"
            && scope.source.location == crate::guide::reviewed_crosswalk::FEED
            && authority.is_none()
        {
            return Err("guide-retention-identity-unavailable".into());
        }
        context.check()?;
        if stage.canceled.load(Ordering::SeqCst) {
            return Err("canceled".into());
        }
        let request = crate::guide::retention::Request {
            scope,
            authority,
            aliases,
            automatic: false,
            allow_empty,
        };
        let (receipt, _) = context
            .storage(Some(stage.root_generation), move |store, check| {
                let mut guard = || {
                    check()?;
                    if stage.canceled.load(Ordering::SeqCst) {
                        Err("canceled".into())
                    } else {
                        Ok(())
                    }
                };
                store.with_guide_write_checked(
                    |c| {
                        let now = guide_now()?;
                        if match_mode {
                            db::replace_guide_match_projected(
                                c,
                                &request,
                                expected_catalog.as_deref(),
                                &stage.parsed,
                                now,
                                &stage.canceled,
                            )
                        } else {
                            let revision = db::replace_guide_projected(
                                c,
                                &request,
                                &stage.parsed,
                                now,
                                &stage.canceled,
                            )?;
                            Ok(db::CommitIfMatched {
                                committed: true,
                                source_revision: revision,
                                matched: 0,
                                unmatched: 0,
                                preserved_mappings: 0,
                            })
                        }
                    },
                    &mut guard,
                )
            })
            .await?;
        Ok(receipt)
    })
    .await?;
    // Disposal cannot turn a crossed durable commit into a cancellation error.
    let _ = guide_owner.discard(&ticket);
    Ok(result)
}
#[tauri::command]
pub(crate) async fn guide_commit(
    ticket: String,
    expected_revision: i64,
    allow_empty: bool,
    app: tauri::AppHandle,
) -> Result<i64, String> {
    Ok(commit_projected(
        ticket,
        expected_revision,
        allow_empty,
        false,
        None,
        None,
        app,
    )
    .await?
    .source_revision)
}
#[tauri::command]
pub(crate) async fn guide_commit_and_match(
    ticket: String,
    expected_revision: i64,
    allow_empty: bool,
    app: tauri::AppHandle,
) -> Result<db::CommitAndMatch, String> {
    let result = commit_projected(
        ticket,
        expected_revision,
        allow_empty,
        true,
        None,
        None,
        app,
    )
    .await?;
    Ok(db::CommitAndMatch {
        source_revision: result.source_revision,
        matched: result.matched,
        unmatched: result.unmatched,
        preserved_mappings: result.preserved_mappings,
    })
}
#[tauri::command]
pub(crate) async fn guide_commit_if_matched(
    ticket: String,
    expected_guide_revision: i64,
    expected_catalog_revision: String,
    aliases: Option<crate::guide::reviewed_aliases::ReviewedAliases>,
    app: tauri::AppHandle,
) -> Result<db::CommitIfMatched, String> {
    commit_projected(
        ticket,
        expected_guide_revision,
        false,
        true,
        Some(expected_catalog_revision),
        aliases,
        app,
    )
    .await
}

#[tauri::command]
pub(crate) async fn guide_discard(ticket: String, app: tauri::AppHandle) -> Result<(), String> {
    let owner = app.state::<Arc<NativeGuides>>().inner().clone();
    let work = app.state::<NativeState>().work.acquire();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        owner.discard(&ticket)
    })
    .await
    .map_err(|_| "guide-worker-failed".to_string())?
}
#[tauri::command]
pub(crate) async fn guide_sources(app: tauri::AppHandle) -> Result<Vec<db::GuideSource>, String> {
    store(&app, |s| s.with_guide_read(db::list_sources)).await
}
#[tauri::command]
pub(crate) async fn guide_save_source(
    source: db::GuideSource,
    expected_revision: i64,
    app: tauri::AppHandle,
) -> Result<db::GuideSource, String> {
    app.state::<Arc<NativeGuides>>().invalidate(&source.id)?;
    store(&app, move |s| {
        s.with_guide_write_preflight_checked(
            |c| db::preflight_save_source(c, &source, expected_revision),
            |c, check| db::save_source_checked(c, &source, expected_revision, check),
            || Ok(()),
        )
    })
    .await
}
#[tauri::command]
pub(crate) async fn guide_remove_source(
    id: String,
    expected_revision: i64,
    app: tauri::AppHandle,
) -> Result<(), String> {
    app.state::<Arc<NativeGuides>>().invalidate(&id)?;
    store(&app, move |s| {
        s.with_guide_write(|c| db::remove_source(c, &id, expected_revision))
    })
    .await
}
#[tauri::command]
pub(crate) async fn guide_mappings(app: tauri::AppHandle) -> Result<Vec<db::GuideMapping>, String> {
    store(&app, |s| s.with_guide_read(db::list_mappings)).await
}
#[tauri::command]
pub(crate) async fn guide_save_mapping(
    mapping: db::GuideMapping,
    app: tauri::AppHandle,
) -> Result<(), String> {
    store(&app, move |s| {
        s.with_guide_write(|c| db::save_mapping(c, &mapping))
    })
    .await
}
#[tauri::command]
pub(crate) async fn guide_remove_mapping(
    catalog_source_id: String,
    app_channel_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    store(&app, move |s| {
        s.with_guide_write(|c| db::remove_mapping(c, &catalog_source_id, &app_channel_id))
    })
    .await
}
#[tauri::command]
pub(crate) async fn guide_programs(
    query: db::ProgramQuery,
    app: tauri::AppHandle,
) -> Result<db::ProgramPage, String> {
    store(&app, move |s| {
        s.with_guide_read(|c| db::query_programs(c, &query))
    })
    .await
}
#[tauri::command]
pub(crate) async fn guide_listed_channels(
    query: crate::guide::listed_channels::Query,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<crate::guide::listed_channels::Page, String> {
    use crate::guide::listed_channels;
    let generation = listed_channels::cursor(&query)?.map(|v| v.root_generation);
    crate::scan_manifest_work::owned(request_id, app, move |context| async move {
        let during = context.clone();
        let (page, _) = context
            .storage_with_generation(generation, move |store, actual, check| {
                check()?;
                store.with_guide_read(|c| {
                    listed_channels::query(
                        c,
                        &query,
                        actual,
                        Arc::new(move || during.check().is_err()),
                    )
                })
            })
            .await?;
        context.check()?;
        Ok(page)
    })
    .await
}
#[tauri::command]
pub(crate) async fn guide_selected_summary(
    catalog_source_id: String,
    app_channel_id: String,
    at_ms: i64,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<db::SelectedSummary, String> {
    let state = app.state::<NativeState>();
    let work = state.admit_work()?;
    let receiver = state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .register(request_id.clone())?;
    let receiver = Mutex::new(receiver);
    let closing = state.closing.clone();
    let owned = state.store.clone();
    let query = db::SummaryQuery {
        catalog_source_id,
        app_channel_id,
        at_ms,
        request_id,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        let canceled = Arc::new(AtomicBool::new(false));
        let check: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
            if closing.load(Ordering::SeqCst) {
                canceled.store(true, Ordering::SeqCst);
            }
            if let Ok(mut receiver) = receiver.lock() {
                if !matches!(
                    receiver.try_recv(),
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty)
                ) {
                    canceled.store(true, Ordering::SeqCst);
                }
            } else {
                canceled.store(true, Ordering::SeqCst);
            }
            canceled.load(Ordering::SeqCst)
        });
        if check() {
            return Err("canceled".into());
        }
        let storage = owned.read().map_err(|_| "storage-lock")?;
        if check() {
            return Err("canceled".into());
        }
        storage
            .as_ref()
            .map_err(Clone::clone)?
            .with_guide_read(|c| db::selected_summary(c, &query, check))
    })
    .await
    .map_err(|_| "guide-worker-failed".to_string())?
}
#[tauri::command]
pub(crate) async fn guide_visible_summaries(
    channels: Vec<db::SummaryIdentity>,
    at_ms: i64,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<db::VisibleSummaries, String> {
    let state = app.state::<NativeState>();
    let work = state.admit_work()?;
    let receiver = state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .register(request_id.clone())?;
    let receiver = Mutex::new(receiver);
    let closing = state.closing.clone();
    let owned = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        let canceled = Arc::new(AtomicBool::new(false));
        let check: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
            if closing.load(Ordering::SeqCst) {
                canceled.store(true, Ordering::SeqCst);
            }
            if let Ok(mut receiver) = receiver.lock() {
                if !matches!(
                    receiver.try_recv(),
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty)
                ) {
                    canceled.store(true, Ordering::SeqCst);
                }
            } else {
                canceled.store(true, Ordering::SeqCst);
            }
            canceled.load(Ordering::SeqCst)
        });
        if check() {
            return Err("canceled".into());
        }
        let storage = owned.read().map_err(|_| "storage-lock")?;
        if check() {
            return Err("canceled".into());
        }
        storage
            .as_ref()
            .map_err(Clone::clone)?
            .with_guide_read(|c| db::visible_summaries(c, &request_id, at_ms, &channels, check))
    })
    .await
    .map_err(|_| "guide-worker-failed".to_string())?
}
#[tauri::command]
pub(crate) async fn guide_channel_coverage(
    query: crate::guide::channel_coverage::CoverageRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<crate::guide::channel_coverage::ChannelCoverage, String> {
    let state = app.state::<NativeState>();
    let work = state.admit_work()?;
    let receiver = state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .register(request_id.clone())?;
    let receiver = Mutex::new(receiver);
    let closing = state.closing.clone();
    let owned = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        let canceled = Arc::new(AtomicBool::new(false));
        let check: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
            if closing.load(Ordering::SeqCst) {
                canceled.store(true, Ordering::SeqCst);
            }
            if let Ok(mut receiver) = receiver.lock() {
                if !matches!(
                    receiver.try_recv(),
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty)
                ) {
                    canceled.store(true, Ordering::SeqCst);
                }
            } else {
                canceled.store(true, Ordering::SeqCst);
            }
            canceled.load(Ordering::SeqCst)
        });
        if check() {
            return Err("canceled".into());
        }
        let storage = owned.read().map_err(|_| "storage-lock")?;
        if check() {
            return Err("canceled".into());
        }
        storage
            .as_ref()
            .map_err(Clone::clone)?
            .with_guide_read(|c| crate::guide::channel_coverage::query(c, &query, check))
    })
    .await
    .map_err(|_| "guide-worker-failed".to_string())?
}
#[tauri::command]
pub(crate) async fn guide_channels(
    source_id: String,
    search: String,
    after_id: Option<db::GuideChannelCursor>,
    page_size: usize,
    app: tauri::AppHandle,
) -> Result<db::GuideChannelPage, String> {
    store(&app, move |s| {
        s.with_guide_read(|c| {
            db::list_channels(c, &source_id, &search, after_id.as_ref(), page_size)
        })
    })
    .await
}
/// Explicit export for a separately run grabber: reads saved IDs, fetches the
/// published guides.json once (bounded), and returns a channels.xml text.
#[tauri::command]
pub(crate) async fn guide_grabber_channels(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<crate::guide::grabber_export::GrabberExport, String> {
    let providers = store(&app, |s| {
        s.with_guide_read(crate::guide::crosswalk_pack::catalog_provider_ids)
    })
    .await?;
    let state = app.state::<NativeState>();
    let work = state.admit_work()?;
    let receiver = state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .register(request_id.clone())?;
    let canceled = AtomicBool::new(false);
    let rows = tokio::select! {
        rows = crate::guide::grabber_export::fetch_rows(&canceled) => rows,
        _ = receiver => Err("guide-grabber-canceled".into()),
    };
    state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .finish(&request_id);
    drop(work);
    let rows = rows?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::guide::grabber_export::build(
            &rows,
            &providers,
            crate::guide::crosswalk_pack::loaded(),
        )
    })
    .await
    .map_err(|_| "guide-worker-failed".to_string())?
}
/// Read-only: publisher feeds whose embedded exact tuples cover saved channels.
#[tauri::command]
pub(crate) async fn guide_pack_suggestions(
    app: tauri::AppHandle,
) -> Result<Vec<crate::guide::crosswalk_pack::FeedSuggestion>, String> {
    store(&app, move |s| {
        s.with_guide_read(crate::guide::crosswalk_pack::suggestions_from_catalog)
    })
    .await
}
#[tauri::command]
pub(crate) async fn guide_coverage(
    source_id: String,
    app: tauri::AppHandle,
) -> Result<db::SourceCoverage, String> {
    store(&app, move |s| {
        s.with_guide_read(|c| {
            let tx = c
                .unchecked_transaction()
                .map_err(|_| "guide-database-operation-failed")?;
            let scope = crate::guide::retention::capture(&tx, &source_id, guide_now()?)?;
            let cached = crate::guide::reviewed_crosswalk::cached_only();
            let mut coverage = db::source_coverage(&tx, &source_id)?;
            let (compatible, interests) =
                crate::guide::retention::compatibility(&tx, &scope, cached.authority.as_deref())?;
            coverage.projection_compatible = Some(compatible);
            coverage.projection_interest_count = interests;
            coverage.mapped_targets = Some(crate::guide::refresh::mapped_targets(
                &tx,
                &source_id,
                guide_now()?,
            )?);
            tx.commit().map_err(|_| "guide-database-operation-failed")?;
            Ok(coverage)
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn guide_suggest_mapping(
    query: db::GuideSuggestionQuery,
    app: tauri::AppHandle,
) -> Result<db::GuideSuggestions, String> {
    store(&app, move |s| {
        s.with_guide_read(|c| db::lookup_suggestions(c, &query))
    })
    .await
}

fn guide_now() -> Result<i64, String> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "guide-clock-unavailable")?
            .as_millis(),
    )
    .map_err(|_| "guide-clock-unavailable".into())
}
#[tauri::command]
pub(crate) async fn guide_refresh_plan(
    app: tauri::AppHandle,
) -> Result<crate::guide::refresh::RefreshPlan, String> {
    let now = guide_now()?;
    store(&app, move |s| {
        s.with_guide_read(|c| crate::guide::refresh::plan(c, now))
    })
    .await
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefreshResult {
    request_id: String,
    source_id: String,
    status: &'static str,
    source_revision: i64,
    next_due_ms: i64,
    updated_ms: Option<i64>,
}
async fn network_owned<T>(
    future: impl std::future::Future<Output = Result<T, String>>,
    context: &crate::scan_manifest_work::Context,
    flag: &AtomicBool,
) -> Result<T, String> {
    tokio::pin!(future);
    loop {
        if let Err(error) = context.check() {
            flag.store(true, Ordering::SeqCst);
            return Err(error);
        }
        if flag.load(Ordering::SeqCst) {
            return Err("canceled".into());
        }
        tokio::select! {result=&mut future=>return result,_=tokio::time::sleep(Duration::from_millis(20))=>{}}
    }
}
#[tauri::command]
pub(crate) async fn guide_refresh_due(
    source_id: String,
    expected_revision: i64,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<RefreshResult, String> {
    let owner = app.state::<Arc<NativeGuides>>().inner().clone();
    let Some((_generation, flag, active)) = owner.begin_automatic(&source_id, &request_id)? else {
        return Ok(RefreshResult {
            request_id,
            source_id,
            status: "deferred",
            source_revision: expected_revision,
            next_due_ms: guide_now()?
                .checked_add(60000)
                .ok_or("guide-clock-unavailable")?,
            updated_ms: None,
        });
    };
    crate::scan_manifest_work::owned(request_id.clone(),app,move|context|async move{
        let _active=active;let _permit=network_owned(async{owner.parser.clone().acquire_owned().await.map_err(|_|"guide-owner-closed".to_string())},&context,&flag).await?;
        let lookup=source_id.clone();let canceled=flag.clone();let now=guide_now()?;
        let ((source,next_due,claimed,scope),generation)=context.storage(None,move|store,check|{
            let mut guard=||{check()?;if canceled.load(Ordering::SeqCst){Err("canceled".into())}else{Ok(())}};
            let (source,next_due,claimed)=store.with_guide_write_preflight_checked(|c|crate::guide::refresh::preflight_claim(c,&lookup,expected_revision,now),|c,check|crate::guide::refresh::claim_checked(c,&lookup,expected_revision,now,check),&mut guard)?;
            let scope=store.with_guide_read(|c|crate::guide::retention::capture_snapshot(c,&lookup,now))?;if scope.source!=source{return Err("guide-stale-revision".into());}Ok((source,next_due,claimed,scope))
        }).await?;
        if !claimed{return Ok(RefreshResult{request_id,source_id,status:"not-due",source_revision:source.revision,next_due_ms:next_due,updated_ms:source.updated_ms});}
        let authority=if source.location==crate::guide::reviewed_crosswalk::FEED{crate::guide::reviewed_crosswalk::acquire(context.clone()).await?.authority}else{None};
        if source.location==crate::guide::reviewed_crosswalk::FEED&&authority.is_none(){return Err("guide-retention-identity-unavailable".into());}
        let request=Arc::new(crate::guide::retention::Request{scope,authority,aliases:None,automatic:true,allow_empty:false});
        let lookup=request.clone();let (cached,_)=context.storage(Some(generation),move|store,check|{check()?;store.with_guide_read(|c|{let tx=c.unchecked_transaction().map_err(|_|"guide-database-operation-failed")?;let cached=crate::guide::conditional::read_projected(&tx,&lookup)?;tx.commit().map_err(|_|"guide-database-operation-failed")?;Ok(cached)})}).await?;
        let fetched=network_owned(input::fetch_conditional(&source.location,source.allow_http,cached.as_ref(),&flag),&context,&flag).await?;
        let (bytes,validators)=match fetched{
            input::ConditionalFetch::Body(bytes,validators)=>(bytes,validators),
            input::ConditionalFetch::NotModified(received)=>{
                let cached=cached.ok_or("guide-not-modified-without-cache")?;let canceled=flag.clone();let checked=guide_now()?;
                context.storage(Some(generation),move|store,check|{let mut guard=||{check()?;if canceled.load(Ordering::SeqCst){Err("canceled".into())}else{Ok(())}};store.with_guide_write_checked(|c|crate::guide::conditional::revalidate_projected(c,&request,&cached,&received,checked,&canceled),&mut guard)}).await?;
                return Ok(RefreshResult{request_id,source_id,status:"not-modified",source_revision:source.revision,next_due_ms:next_due,updated_ms:source.updated_ms});
            }
        };
        let canceled=flag.clone();let mut worker=tauri::async_runtime::spawn_blocking(move||{let expanded=input::expand(bytes,&canceled)?;parser::parse_guide_cancelable(&expanded,&canceled)});
        let parsed=loop{tokio::select!{r=&mut worker=>break r.map_err(|_|"guide-parser-worker-failed")??,_=tokio::time::sleep(Duration::from_millis(20))=>{if let Err(e)=context.check(){flag.store(true,Ordering::SeqCst);let _=worker.await;return Err(e);}if flag.load(Ordering::SeqCst){let _=worker.await;return Err("canceled".into());}}}};
        let canceled=flag.clone();let ((revision,next_due,updated),_)=context.storage(Some(generation),move|store,check|{
            let mut guard=||{check()?;if canceled.load(Ordering::SeqCst){Err("canceled".into())}else{Ok(())}};
            store.with_guide_write_checked(|c|{let updated=guide_now()?;let due=crate::guide::refresh::next_after_feed(c,&request.scope.source,&parsed,updated,&canceled)?;let revision=db::replace_guide_conditional_projected(c,&request,&parsed,updated,&validators,&canceled)?;Ok((revision,due,updated))},&mut guard)
        }).await?;
        Ok(RefreshResult{request_id,source_id,status:"refreshed",source_revision:revision,next_due_ms:next_due,updated_ms:Some(updated)})
    }).await
}

#[cfg(test)]
mod automatic_refresh_tests {
    use super::*;
    #[test]
    fn automatic_refresh_never_cancels_manual_preview_and_manual_supersedes_automatic() {
        let owner = Arc::new(NativeGuides::default());
        let (_, manual, active) = owner.begin("s", "manual").unwrap();
        assert!(owner.begin_automatic("s", "auto").unwrap().is_none());
        assert!(!manual.load(Ordering::SeqCst));
        drop(active);
        let (_, automatic, active) = owner.begin_automatic("s", "auto").unwrap().unwrap();
        let (_, manual, _manual_active) = owner.begin("s", "manual2").unwrap();
        assert!(automatic.load(Ordering::SeqCst));
        assert!(!manual.load(Ordering::SeqCst));
        drop(active);
    }
}

/// Connect exact canonical identifiers against explicitly selected published caches.
#[tauri::command]
pub(crate) async fn guide_connect_cached_catalog(
    expected_catalog_revision: String,
    sources: Vec<crate::guide::cached_matching::CachedSource>,
    aliases: Option<Vec<crate::guide::reviewed_aliases::ReviewedAliases>>,
    request_id: String,
    cache_only: Option<bool>,
    app: tauri::AppHandle,
) -> Result<crate::guide::cached_matching::CachedConnection, String> {
    // The retained request/work owner spans prepare, optional HTTPS metadata,
    // joined parsing and final COMMIT even if its IPC observer disappears.
    crate::scan_manifest_work::owned(request_id, app, move |owner| async move {
        let cache_only = cache_only.unwrap_or(false);
        if aliases
            .as_ref()
            .is_some_and(|a| a.len() > 100 || a.iter().map(|a| a.pairs.len()).sum::<usize>() > 1024)
        {
            return Err("guide-cache-match-limit".into());
        }
        if sources.is_empty() {
            let read_owner = owner.clone();
            let (receipt, _) = owner
                .storage(None, move |store, check| {
                    check()?;
                    store.with_guide_read(|c| {
                        crate::guide::cached_matching::connect_empty_cached(
                            c,
                            &expected_catalog_revision,
                            aliases.as_deref().unwrap_or(&[]),
                            cache_only,
                            &|| read_owner.check().is_err(),
                        )
                    })
                })
                .await?;
            return Ok(receipt);
        }
        let captured_sources = sources.clone();
        let captured_revision = expected_catalog_revision.clone();
        let prepare_owner = owner.clone();
        let (eligible, generation) = owner
            .storage(None, move |store, check| {
                check()?;
                store.with_guide_read(|c| {
                    if cache_only {
                        crate::guide::refresh::require_automatic_updates(c)?;
                    }
                    crate::guide::cached_matching::prepare_scope(
                        c,
                        &captured_revision,
                        &captured_sources,
                        &|| prepare_owner.check().is_err(),
                    )
                })
            })
            .await?;
        // No SQLite or root lease crosses this network/CPU work.
        let acquired = if eligible && cache_only {
            crate::guide::reviewed_crosswalk::cached_only()
        } else if eligible {
            crate::guide::reviewed_crosswalk::acquire(owner.clone()).await?
        } else {
            crate::guide::reviewed_crosswalk::Acquisition::not_requested()
        };
        owner.check()?;
        let commit_owner = owner.clone();
        let (receipt, _) = owner
            .storage(Some(generation), move |store, check| {
                check()?;
                store.with_guide_write_preflight_checked(
                    |c| {
                        crate::guide::cached_matching::preflight_connection(
                            c,
                            &expected_catalog_revision,
                            &sources,
                            aliases.as_deref().unwrap_or(&[]),
                            acquired.authority.as_deref(),
                            acquired.outcome.clone(),
                            &|| commit_owner.check().is_err(),
                            cache_only,
                        )
                    },
                    |c, _check| {
                        let connect = if cache_only {
                            crate::guide::cached_matching::connect_automatic_cached
                        } else {
                            crate::guide::cached_matching::connect_with_crosswalk
                        };
                        connect(
                            c,
                            &expected_catalog_revision,
                            &sources,
                            aliases.as_deref().unwrap_or(&[]),
                            acquired.authority.as_deref(),
                            acquired.outcome.clone(),
                            &|| commit_owner.check().is_err(),
                        )
                    },
                    check,
                )
            })
            .await?;
        // Preserve the actual committed receipt if cancellation arrives later.
        Ok(receipt)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetentionMaintenance {
    maintenance: crate::storage_transaction::guide_maintenance::Maintenance<
        crate::guide::retention::CleanupReceipt,
    >,
    root_generation: u64,
    quarantined: bool,
    quarantine_error: Option<String>,
}
/// Explicit Guide maintenance only. Opening a viewing screen never invokes it.
#[tauri::command]
pub(crate) async fn guide_retention_cleanup(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<RetentionMaintenance, String> {
    let guide_owner = app.state::<Arc<NativeGuides>>().inner().clone();
    let (_, flag, active) = guide_owner.begin("guide-retention-maintenance", &request_id)?;
    let store_owner = app.state::<NativeState>().store.clone();
    crate::scan_manifest_work::owned(request_id, app, move |context| async move {
        let _active = active;
        let (eligible, generation) = context
            .storage(None, move |store, check| {
                check()?;
                store.with_guide_read(|c| {
                    Ok(db::list_sources(c)?.iter().any(|s| {
                        s.kind == "url" && s.location == crate::guide::reviewed_crosswalk::FEED
                    }))
                })
            })
            .await?;
        let authority = if eligible {
            crate::guide::reviewed_crosswalk::acquire(context.clone())
                .await?
                .authority
        } else {
            None
        };
        if eligible && authority.is_none() {
            return Err("guide-retention-identity-unavailable".into());
        }
        let now = guide_now()?;
        let canceled = flag.clone();
        let (plan, _) = context
            .storage(Some(generation), move |store, check| {
                check()?;
                store.with_guide_read(|c| {
                    crate::guide::retention::prepare_cleanup(
                        c,
                        now,
                        authority.as_deref(),
                        &canceled,
                    )
                })
            })
            .await?;
        let plan = Arc::new(plan);
        let canceled = flag.clone();
        let (maintenance, root_generation) = context
            .storage(Some(generation), move |store, check| {
                let mut guard = || {
                    check()?;
                    if canceled.load(Ordering::SeqCst) {
                        Err("canceled".into())
                    } else {
                        Ok(())
                    }
                };
                store.with_guide_maintenance_preflight_checked(
                    |c| crate::guide::retention::cleanup_receipt_if_unchanged(c, &plan),
                    |c, check| crate::guide::retention::commit_cleanup(c, &plan, &canceled, check),
                    canceled.clone(),
                    &mut guard,
                )
            })
            .await?;
        // Only this exact failed root is quarantined, after all read leases
        // used by the maintenance operation have been released. Preserve receipt.
        let (mut quarantined, mut quarantine_error) = (false, None);
        if maintenance.fatal_verification.is_some() {
            match store_owner.quarantine_after_maintenance(root_generation) {
                Ok(value) => quarantined = value,
                Err(error) => quarantine_error = Some(error),
            }
        }
        Ok(RetentionMaintenance {
            maintenance,
            root_generation,
            quarantined,
            quarantine_error,
        })
    })
    .await
}
