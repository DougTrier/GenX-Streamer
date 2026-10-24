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

//! Reading the saved guide: programs, channels, summaries, coverage and
//! mapping suggestions.

use super::*;

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

pub(super) fn guide_now() -> Result<i64, String> {
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
