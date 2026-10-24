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

//! Automatic guide refresh, the cached catalog connection and retention
//! clean-up.

use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefreshResult {
    pub(super) request_id: String,
    pub(super) source_id: String,
    pub(super) status: &'static str,
    pub(super) source_revision: i64,
    pub(super) next_due_ms: i64,
    pub(super) updated_ms: Option<i64>,
}

pub(super) async fn network_owned<T>(
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
        tokio::select! {
            result=&mut future => return result,
            _=tokio::time::sleep(Duration::from_millis(20)) => {
            }
        }
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
    crate::scan_manifest_work::owned(request_id.clone(), app, move |context| async move {
        let _active = active;
        let _permit = network_owned(
            async {
                owner
                    .parser
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| "guide-owner-closed".to_string())
            },
            &context,
            &flag,
        )
        .await?;
        let lookup = source_id.clone();
        let canceled = flag.clone();
        let now = guide_now()?;
        let ((source, next_due, claimed, scope), generation) = context
            .storage(None, move |store, check| {
                let mut guard = || {
                    check()?;
                    if canceled.load(Ordering::SeqCst) {
                        Err("canceled".into())
                    } else {
                        Ok(())
                    }
                };
                let (source, next_due, claimed) = store.with_guide_write_preflight_checked(
                    |c| crate::guide::refresh::preflight_claim(c, &lookup, expected_revision, now),
                    |c, check| {
                        crate::guide::refresh::claim_checked(
                            c,
                            &lookup,
                            expected_revision,
                            now,
                            check,
                        )
                    },
                    &mut guard,
                )?;
                let scope = store.with_guide_read(|c| {
                    crate::guide::retention::capture_snapshot(c, &lookup, now)
                })?;
                if scope.source != source {
                    return Err("guide-stale-revision".into());
                }
                Ok((source, next_due, claimed, scope))
            })
            .await?;
        if !claimed {
            return Ok(RefreshResult {
                request_id,
                source_id,
                status: "not-due",
                source_revision: source.revision,
                next_due_ms: next_due,
                updated_ms: source.updated_ms,
            });
        }
        let authority = if source.location == crate::guide::reviewed_crosswalk::FEED {
            crate::guide::reviewed_crosswalk::acquire(context.clone())
                .await?
                .authority
        } else {
            None
        };
        if source.location == crate::guide::reviewed_crosswalk::FEED && authority.is_none() {
            return Err("guide-retention-identity-unavailable".into());
        }
        let request = Arc::new(crate::guide::retention::Request {
            scope,
            authority,
            aliases: None,
            automatic: true,
            allow_empty: false,
        });
        let lookup = request.clone();
        let (cached, _) = context
            .storage(Some(generation), move |store, check| {
                check()?;
                store.with_guide_read(|c| {
                    let tx = c
                        .unchecked_transaction()
                        .map_err(|_| "guide-database-operation-failed")?;
                    let cached = crate::guide::conditional::read_projected(&tx, &lookup)?;
                    tx.commit().map_err(|_| "guide-database-operation-failed")?;
                    Ok(cached)
                })
            })
            .await?;
        let fetched = network_owned(
            input::fetch_conditional(&source.location, source.allow_http, cached.as_ref(), &flag),
            &context,
            &flag,
        )
        .await?;
        let (bytes, validators) = match fetched {
            input::ConditionalFetch::Body(bytes, validators) => (bytes, validators),
            input::ConditionalFetch::NotModified(received) => {
                let cached = cached.ok_or("guide-not-modified-without-cache")?;
                let canceled = flag.clone();
                let checked = guide_now()?;
                context
                    .storage(Some(generation), move |store, check| {
                        let mut guard = || {
                            check()?;
                            if canceled.load(Ordering::SeqCst) {
                                Err("canceled".into())
                            } else {
                                Ok(())
                            }
                        };
                        store.with_guide_write_checked(
                            |c| {
                                crate::guide::conditional::revalidate_projected(
                                    c, &request, &cached, &received, checked, &canceled,
                                )
                            },
                            &mut guard,
                        )
                    })
                    .await?;
                return Ok(RefreshResult {
                    request_id,
                    source_id,
                    status: "not-modified",
                    source_revision: source.revision,
                    next_due_ms: next_due,
                    updated_ms: source.updated_ms,
                });
            }
        };
        let canceled = flag.clone();
        let mut worker = tauri::async_runtime::spawn_blocking(move || {
            let expanded = input::expand(bytes, &canceled)?;
            parser::parse_guide_cancelable(&expanded, &canceled)
        });
        let parsed = loop {
            tokio::select! {
                r = &mut worker => break r.map_err(|_| "guide-parser-worker-failed")??,
                _ = tokio::time::sleep(Duration::from_millis(20)) => {
                    if let Err(e) = context.check() {
                        flag.store(true, Ordering::SeqCst);
                        let _ = worker.await;
                        return Err(e);
                    }
                    if flag.load(Ordering::SeqCst) {
                        let _ = worker.await;
                        return Err("canceled".into());
                    }
                }
            }
        };
        let canceled = flag.clone();
        let ((revision, next_due, updated), _) = context
            .storage(Some(generation), move |store, check| {
                let mut guard = || {
                    check()?;
                    if canceled.load(Ordering::SeqCst) {
                        Err("canceled".into())
                    } else {
                        Ok(())
                    }
                };
                store.with_guide_write_checked(
                    |c| {
                        let updated = guide_now()?;
                        let due = crate::guide::refresh::next_after_feed(
                            c,
                            &request.scope.source,
                            &parsed,
                            updated,
                            &canceled,
                        )?;
                        let revision = db::replace_guide_conditional_projected(
                            c,
                            &request,
                            &parsed,
                            updated,
                            &validators,
                            &canceled,
                        )?;
                        Ok((revision, due, updated))
                    },
                    &mut guard,
                )
            })
            .await?;
        Ok(RefreshResult {
            request_id,
            source_id,
            status: "refreshed",
            source_revision: revision,
            next_due_ms: next_due,
            updated_ms: Some(updated),
        })
    })
    .await
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
                            crate::guide::cached_matching::ConnectionRequest {
                                expected_catalog_revision: &expected_catalog_revision,
                                sources: &sources,
                                aliases: aliases.as_deref().unwrap_or(&[]),
                                authority: acquired.authority.as_deref(),
                                outcome: acquired.outcome.clone(),
                                automatic: cache_only,
                            },
                            &|| commit_owner.check().is_err(),
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
    pub(super) maintenance: crate::storage_transaction::guide_maintenance::Maintenance<
        crate::guide::retention::CleanupReceipt,
    >,
    pub(super) root_generation: u64,
    pub(super) quarantined: bool,
    pub(super) quarantine_error: Option<String>,
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
