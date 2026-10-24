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

//! The archive discovery commands the app calls: discovery steps, item files,
//! removal, favorites, catalog queries and progress.

use super::*;

#[tauri::command]
pub async fn archive_discover_step(
    request: StepRequest,
    app: tauri::AppHandle,
) -> Result<catalog::StepReceipt, String> {
    validate(&request)?;
    let query_hash = catalog::search_scope_hash(&request.query, request.decade);
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        // One actual online step, including final publication. Queued callers
        // remain canceled/owned and cannot create an unbounded fetch fanout.
        let admission = Instant::now() + Duration::from_secs(20);
        let pending = DISCOVERY_OWNER.lock();
        tokio::pin!(pending);
        let _step_owner = loop {
            check(&owner, admission)?;
            tokio::select! {
                guard=&mut pending => break guard,
                _=tokio::time::sleep(Duration::from_millis(50)) => {
                }
            }
        };
        let captured = request.clone();
        let hash = query_hash.clone();
        let (_, generation) = owner
            .storage(None, move |s, check| {
                check()?;
                s.with_archive_read(|c| {
                    catalog::prepare(
                        c,
                        &captured.expected_revision,
                        captured.year.unwrap_or(0),
                        captured.page,
                        &hash,
                        captured.restart,
                    )
                })
            })
            .await?;
        let step = acquire(owner.clone(), &request).await?;
        owner.check()?;
        let (receipt, _) = owner
            .storage(Some(generation), move |s, check| {
                check()?;
                s.with_archive_write_checked(
                    &request.expected_revision,
                    |_| Ok(None),
                    |c, check| {
                        catalog::commit_view(
                            c,
                            &request.expected_revision,
                            catalog::SearchPage {
                                year: request.year,
                                page: request.page,
                                query_hash: &query_hash,
                                restart: request.restart,
                            },
                            step,
                            request
                                .view
                                .as_ref()
                                .map(|view| (request.query.as_str(), request.decade, view)),
                            check,
                        )
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
pub async fn archive_item_files_progress(
    request: catalog::FileProgressQuery,
    app: tauri::AppHandle,
) -> Result<catalog::FileProgressReply, String> {
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        let (reply, _) = owner
            .storage(None, move |s, check| {
                s.with_archive_read(|c| catalog::item_progress(c, &request, check))
            })
            .await?;
        Ok(reply)
    })
    .await
}

#[tauri::command]
pub async fn archive_item_files_step(
    request: catalog::FileStepRequest,
    app: tauri::AppHandle,
) -> Result<catalog::FileStepReceipt, String> {
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        let deadline = Instant::now() + Duration::from_secs(20);
        let pending = DISCOVERY_OWNER.lock();
        tokio::pin!(pending);
        let _guard = loop {
            check(&owner, deadline)?;
            tokio::select! {
                g=&mut pending => break g,
                _=tokio::time::sleep(Duration::from_millis(50)) => {
                }
            }
        };
        let captured_request = request.clone();
        let (capture, generation) = owner
            .storage(None, move |s, check| {
                check()?;
                s.with_archive_read(|c| catalog::item_prepare(c, &captured_request))
            })
            .await?;
        let client = client(&owner, deadline).await?;
        let budget = Arc::new(AtomicUsize::new(0));
        let result = acquire_file_page(
            &client,
            &capture.item_id,
            capture.downloads,
            owner.clone(),
            deadline,
            budget,
            Some(&capture.page),
            request.restart,
            capture.page.curation_year,
        )
        .await?;
        let Metadata::Title(title) = result else {
            return Err("archive-item-unavailable".into());
        };
        check(&owner, deadline)?;
        let year = capture.page.curation_year;
        let step = catalog::PreparedStep {
            item_page: true,
            titles: vec![*title],
            deleted: Vec::new(),
            examined: 1,
            unknown_year: 0,
            transient_failures: 0,
            unavailable: 0,
            capacity_reached: false,
            next_page: None,
            observed_ms: catalog::now_ms()?,
        };
        let (receipt, _) = owner
            .storage(Some(generation), move |s, check| {
                s.with_archive_write_checked(
                    &request.expected_revision,
                    |_| Ok(None),
                    |c, check| {
                        catalog::commit(
                            c,
                            &request.expected_revision,
                            catalog::SearchPage {
                                year,
                                page: 1,
                                query_hash: "item-page",
                                restart: false,
                            },
                            step,
                            check,
                        )
                    },
                    check,
                )
            })
            .await?;
        let progress = receipt
            .file_page_progress
            .ok_or("archive-committed-receipt-invalid")?;
        Ok(catalog::FileStepReceipt {
            schema_version: 1,
            committed: true,
            revision: receipt.revision,
            progress,
            admitted: receipt.files_admitted,
            confirmed_dead: 0,
        })
    })
    .await
}

#[tauri::command]
pub async fn archive_remove_title(
    request: catalog::RemoveTitleRequest,
    app: tauri::AppHandle,
) -> Result<catalog::RemovalReceipt, String> {
    removal_owned(
        request.schema_version,
        request.request_id,
        request.expected_revision,
        request.explicit_action,
        catalog::RemovalScope::TitleRef(request.title_ref),
        None,
        app,
    )
    .await
}

#[tauri::command]
pub async fn archive_remove_file(
    request: catalog::RemoveFileRequest,
    app: tauri::AppHandle,
) -> Result<catalog::RemovalReceipt, String> {
    removal_owned(
        request.schema_version,
        request.request_id,
        request.expected_revision,
        request.explicit_action,
        catalog::RemovalScope::FileRef(request.file_ref),
        Some(request.title_ref),
        app,
    )
    .await
}

#[tauri::command]
pub async fn archive_clear_library(
    request: catalog::ClearLibraryRequest,
    app: tauri::AppHandle,
) -> Result<catalog::RemovalReceipt, String> {
    removal_owned(
        request.schema_version,
        request.request_id,
        request.expected_revision,
        request.explicit_action,
        catalog::RemovalScope::All,
        None,
        app,
    )
    .await
}

pub(super) async fn removal_owned(
    schema: u32,
    request_id: String,
    expected: String,
    explicit: bool,
    scope: catalog::RemovalScope,
    title_ref: Option<String>,
    app: tauri::AppHandle,
) -> Result<catalog::RemovalReceipt, String> {
    if schema != 1 || !catalog::text(&request_id, 256) || !explicit {
        return Err("archive-removal-invalid".into());
    }
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let captured = expected.clone();
        let (_, generation) = owner
            .storage(None, move |s, check| {
                check()?;
                s.with_archive_read(|c| {
                    if catalog::current(c)? != catalog::revision(&captured)? {
                        return Err("archive-revision-stale".into());
                    }
                    Ok(())
                })
            })
            .await?;
        let retire = scope.clone();
        let (mut receipt, _) = owner
            .storage(Some(generation), move |s, check| {
                s.with_archive_write_checked(
                    &expected,
                    |_| Ok(None),
                    |c, check| catalog::remove(c, &scope, title_ref.as_deref(), &expected, check),
                    check,
                )
            })
            .await?;
        // Publication has already committed. Join cleanup without reporting a
        // late cancellation as a failed durable removal; retain failed handles.
        receipt.cleanup_pending = cleanup_removed(&retire).await;
        Ok(receipt)
    })
    .await
}

/// Post-COMMIT cleanup has no authority to undo or erase the durable receipt.
/// Join both original owners even when one reports cleanup failure.
pub(crate) async fn cleanup_removed(scope: &catalog::RemovalScope) -> bool {
    let (playback, download) = tokio::join!(
        crate::archive_playback_owner::revoke_removed(scope),
        crate::archive_download_owner::revoke_removed(scope),
    );
    playback.is_err() || download.is_err()
}

#[tauri::command]
pub async fn archive_set_favorite(
    request: catalog::FavoriteRequest,
    app: tauri::AppHandle,
) -> Result<catalog::FavoriteReceipt, String> {
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        let captured = request.clone();
        let (_, generation) = owner
            .storage(None, move |s, check| {
                check()?;
                s.with_archive_read(|c| {
                    if catalog::current(c)? != catalog::revision(&captured.expected_revision)? {
                        return Err("archive-revision-stale".into());
                    }
                    Ok(())
                })
            })
            .await?;
        let (receipt, _) = owner
            .storage(Some(generation), move |s, check| {
                check()?;
                s.with_archive_write_checked(
                    &request.expected_revision,
                    |_| Ok(None),
                    |c, check| catalog::set_favorite(c, &request, check),
                    check,
                )
            })
            .await?;
        Ok(receipt)
    })
    .await
}

#[tauri::command]
pub async fn archive_query_catalog(
    request: catalog::Query,
    app: tauri::AppHandle,
) -> Result<catalog::Page, String> {
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        let (page, _) = owner
            .storage(None, move |s, check| {
                s.with_archive_read(|c| catalog::query(c, &request, check))
            })
            .await?;
        Ok(page)
    })
    .await
}

#[tauri::command]
pub async fn archive_title_files(
    request: catalog::FilesQuery,
    app: tauri::AppHandle,
) -> Result<catalog::FilesPage, String> {
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        let (page, _) = owner
            .storage(None, move |s, check| {
                s.with_archive_read(|c| catalog::files(c, &request, check))
            })
            .await?;
        Ok(page)
    })
    .await
}

#[tauri::command]
pub async fn archive_discovery_progress(
    request: catalog::ProgressQuery,
    app: tauri::AppHandle,
) -> Result<catalog::ProgressReply, String> {
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        let (page, _) = owner
            .storage(None, move |s, check| {
                check()?;
                s.with_archive_read(|c| catalog::progress(c, &request))
            })
            .await?;
        Ok(page)
    })
    .await
}
