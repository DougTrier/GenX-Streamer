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

//! Previewing a guide before it is saved: from a URL, a mapped source or an
//! uploaded file.

use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preview {
    pub(super) ticket: String,
    pub(super) source_id: String,
    pub(super) source_revision: i64,
    pub(super) channels: usize,
    pub(super) programs: usize,
    pub(super) first_start_ms: Option<i64>,
    pub(super) last_start_ms: Option<i64>,
    pub(super) last_known_stop_ms: Option<i64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(super) proposed: bool,
}

pub(super) async fn preview(
    source_id: String,
    request_id: String,
    bytes: Option<Vec<u8>>,
    app: tauri::AppHandle,
) -> Result<Preview, String> {
    preview_admitted(source_id, request_id, bytes, None, None, None, app).await
}

pub(super) async fn preview_admitted(
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
        let (generation, canceled, _active) = match admission {
            Some(admission) => owner.admit_upload(&source_id, &request_id, admission)?,
            None => owner.begin(&source_id, &request_id)?,
        };
        let permit = tokio::select! {
            permit = owner.parser.clone().acquire_owned() => permit.map_err(|_| "guide-owner-closed")?,
            _ = &mut cancel => { canceled.store(true, Ordering::SeqCst); return Err("canceled".into()); }
        };
        if canceled.load(Ordering::SeqCst) {
            return Err("canceled".into());
        }
        let bytes = match bytes {
            Some(bytes) => bytes,
            None => tokio::select! {
                input = input::fetch(&source.location, source.allow_http, &canceled) => input?,
                _ = &mut cancel => { canceled.store(true, Ordering::SeqCst); return Err("canceled".into()); }
            },
        };
        let flag = canceled.clone();
        let work = state.admit_work()?;
        let mut worker = tauri::async_runtime::spawn_blocking(move || {
            let _work = work;
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
        let channels = parsed.channels.len();
        let programs = parsed.programs.len();
        let proposed = crate::guide::retention::is_proposed(&retention_scope);
        let ticket = owner.stage(Stage {
            request_id: request_id.clone(),
            source_id: source_id.clone(),
            source_revision: source.revision,
            root_generation,
            retention_scope: Some(retention_scope),
            generation,
            parsed: Arc::new(parsed),
            canceled,
            created: Instant::now(),
        })?;
        Ok(Preview {
            ticket,
            source_id,
            source_revision: source.revision,
            channels,
            programs,
            first_start_ms,
            last_start_ms,
            last_known_stop_ms,
            proposed,
        })
    }
    .await;
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
