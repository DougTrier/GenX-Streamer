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

//! Saving guides and their sources and channel mappings.

use super::*;

pub(super) async fn commit_projected(
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
