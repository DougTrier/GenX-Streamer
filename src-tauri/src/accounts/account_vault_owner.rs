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

//! Native-only device path and retained prepare/crypto/commit orchestration.
use crate::{account_vault, scan_manifest_work};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
// No abandoned envelope can be recovered while another save is sealing it.
static ACCOUNT_WRITER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[cfg(windows)]
use tauri::Manager;

pub(crate) async fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        app.path()
            .app_local_data_dir()
            .map(|p| p.join("device-account-vault"))
            .map_err(|_| "account-vault-path-unavailable".into())
    }
    #[cfg(target_os = "android")]
    {
        return crate::android_manifest_protector::vault_directory(app).await;
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = app;
        Err("account-vault-platform-unavailable".into())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PutReceipt {
    schema_version: u8,
    committed: bool,
    metadata: account_vault::Metadata,
    cleanup_pending: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoveReceipt {
    schema_version: u8,
    committed: bool,
    cleanup_pending: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InspectRequest {
    schema_version: u8,
    account_id: String,
    expected_revision: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InspectReceipt {
    schema_version: u8,
    account_id: String,
    revision: String,
    channels: usize,
    supplied_guide: bool,
    max_connections: Option<u32>,
    // Acquisition establishes provider data availability, never decoder proof.
    playback_verified: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefreshReceipt {
    schema_version: u8,
    committed: bool,
    account_id: String,
    account_revision: String,
    media_revision: String,
    channels: usize,
    /// Provider entries left out as unusable (XC-014); shown, never hidden.
    skipped: usize,
    cleanup_pending: bool,
}

pub(crate) async fn refresh(
    request: InspectRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<RefreshReceipt, String> {
    let crypto_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let _writer = ACCOUNT_WRITER.try_lock().map_err(|_| "account-busy")?;
        let revision = request.revision()?;
        let root = directory(&crypto_app).await?;
        let recovery_root = root.clone();
        owner
            .storage(None, move |store, check| {
                store.with_guide_write(|c| {
                    crate::account_media_store::recover_orphans(c, &recovery_root, check)
                })
            })
            .await?;
        let id = request.account_id;
        let (prepared, generation) = owner
            .storage_with_generation(None, move |store, generation, check| {
                store.with_guide_read(|c| {
                    account_vault::prepare_resolve(c, &id, revision, generation, check)
                })
            })
            .await?;
        owner.check()?;
        let resolved = account_vault::open(crypto_app.clone(), root.clone(), prepared).await?;
        let (resolved, _) = owner
            .storage_with_generation(Some(generation), move |store, current, check| {
                store
                    .with_guide_read(|c| account_vault::finish_resolve(c, resolved, current, check))
            })
            .await?;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "account-clock-unavailable")?
            .as_millis();
        let now_ms = u64::try_from(now_ms).map_err(|_| "account-clock-unavailable")?;
        let catalog = crate::account_acquisition::acquire(&resolved, owner.clone(), now_ms).await?;
        if catalog.account_id != resolved.metadata.id
            || catalog.account_revision != resolved.metadata.revision
        {
            return Err("account-revision-conflict".into());
        }
        let skipped = catalog.skipped;
        let mut inputs = Vec::with_capacity(catalog.entries.len());
        for mut entry in catalog.entries {
            owner.check()?;
            inputs.push(crate::account_media_store::Input {
                stable_id: entry.stable_id,
                provider_id: entry.provider_id,
                name: entry.name,
                category: entry.category,
                epg_id: entry.epg_id,
                urls: std::iter::once(std::mem::take(&mut *entry.media_url))
                    .chain(
                        entry
                            .backup_urls
                            .iter_mut()
                            .map(|u| std::mem::take(&mut **u)),
                    )
                    .collect(),
            });
        }
        let account_id = resolved.metadata.id.clone();
        let (prepared, _) = owner
            .storage_with_generation(Some(generation), move |store, current, check| {
                store.with_guide_write(|c| {
                    let resolved =
                        account_vault::finish_resolve(c, resolved, current, &mut *check)?;
                    let prepared = crate::account_media_store::prepare(
                        c,
                        &resolved.metadata,
                        current,
                        inputs,
                        &mut *check,
                    )?;
                    crate::account_catalog_query::install_indexes(c)?;
                    check()?;
                    Ok(prepared)
                })
            })
            .await?;
        owner.check()?;
        let sealed =
            crate::account_media_store::seal(crypto_app, root.clone(), prepared, || owner.check())
                .await?;
        let (committed, _) = owner
            .storage_with_generation(Some(generation), move |store, current, check| {
                store.with_guide_write(|c| {
                    crate::account_media_store::commit(c, sealed, current, check)
                })
            })
            .await?;
        let media_revision = committed.media_revision;
        let channels = committed.channel_count;
        let playback_cleanup = crate::account_playback_owner::stop_account(&account_id)
            .await
            .is_err();
        // A cleanup failure after COMMIT cannot turn publication into an alleged failure.
        let cleanup_pending = owner
            .storage(Some(generation), move |store, _check| {
                store.with_guide_read(|c| {
                    for page in committed.obsolete_pages {
                        crate::account_media_store::cleanup_page(c, &root, &page)?;
                    }
                    Ok(())
                })
            })
            .await
            .is_err();
        Ok(RefreshReceipt {
            schema_version: 1,
            committed: true,
            account_id,
            account_revision: revision.to_string(),
            media_revision,
            channels,
            skipped,
            cleanup_pending: cleanup_pending || playback_cleanup,
        })
    })
    .await
}
impl InspectRequest {
    pub(crate) fn account_id(&self) -> &str {
        &self.account_id
    }
    pub(crate) fn revision(&self) -> Result<u64, String> {
        let value = &self.expected_revision;
        if self.schema_version != 1
            || self.account_id.len() != 32
            || !self
                .account_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || value.is_empty()
            || value.len() > 19
            || value.starts_with('0')
            || !value.bytes().all(|b| b.is_ascii_digit())
        {
            return Err("account-reference-invalid".into());
        }
        value
            .parse::<u64>()
            .ok()
            .filter(|n| *n <= i64::MAX as u64)
            .ok_or_else(|| "account-revision-invalid".into())
    }
}

pub(crate) async fn inspect(
    request: InspectRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<InspectReceipt, String> {
    let crypto_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let revision = request.revision()?;
        let root = directory(&crypto_app).await?;
        let id = request.account_id;
        let (prepared, generation) = owner
            .storage_with_generation(None, move |store, generation, check| {
                store.with_guide_read(|c| {
                    account_vault::prepare_resolve(c, &id, revision, generation, check)
                })
            })
            .await?;
        owner.check()?;
        let resolved = account_vault::open(crypto_app, root, prepared).await?;
        let (resolved, _) = owner
            .storage_with_generation(Some(generation), move |store, current, check| {
                store
                    .with_guide_read(|c| account_vault::finish_resolve(c, resolved, current, check))
            })
            .await?;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "account-clock-unavailable")?
            .as_millis();
        let now_ms = u64::try_from(now_ms).map_err(|_| "account-clock-unavailable")?;
        let catalog = crate::account_acquisition::acquire(&resolved, owner.clone(), now_ms).await?;
        // Removing/updating the account during network work must invalidate this reply.
        let (resolved, _) = owner
            .storage_with_generation(Some(generation), move |store, current, check| {
                store
                    .with_guide_read(|c| account_vault::finish_resolve(c, resolved, current, check))
            })
            .await?;
        owner.check()?;
        Ok(InspectReceipt {
            schema_version: 1,
            account_id: resolved.metadata.id.clone(),
            revision: resolved.metadata.revision.to_string(),
            channels: catalog.entries.len(),
            supplied_guide: catalog.supplied_guide.is_some(),
            max_connections: catalog.max_connections,
            playback_verified: false,
        })
    })
    .await
}

pub(crate) async fn list(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<account_vault::Metadata>, String> {
    let paths_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let root = directory(&paths_app).await?;
        owner.check()?;
        let (rows, _) = owner
            .storage(None, move |store, check| {
                check()?;
                let mut rows = store.with_guide_read(account_vault::list)?;
                for row in &mut rows {
                    check()?;
                    account_vault::mark_missing(row, &root);
                }
                check()?;
                Ok(rows)
            })
            .await?;
        Ok(rows)
    })
    .await
}
pub(crate) async fn put(
    request: account_vault::Put,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<PutReceipt, String> {
    let crypto_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let _writer = ACCOUNT_WRITER.try_lock().map_err(|_| "account-busy")?;
        let root = directory(&crypto_app).await?;
        owner.check()?;
        let recovery_root = root.clone();
        owner
            .storage(None, move |store, check| {
                store.with_guide_write(|c| account_vault::recover_orphans(c, &recovery_root, check))
            })
            .await?;
        let (prepared, generation) = owner
            .storage_with_generation(None, move |store, generation, check| {
                store.with_guide_write(|c| {
                    account_vault::prepare_put(c, &request, generation, check)
                })
            })
            .await?;
        owner.check()?;
        let sealed = account_vault::seal(crypto_app, root.clone(), prepared).await?;
        owner.check()?;
        let (committed, _) = owner
            .storage_with_generation(Some(generation), move |store, current, check| {
                store.with_guide_write(|c| account_vault::commit_put(c, sealed, current, check))
            })
            .await?;
        let playback_cleanup = crate::account_playback_owner::stop_account(&committed.metadata.id)
            .await
            .is_err();
        // Cleanup is advisory AFTER actual COMMIT; never turn a saved account
        // into an alleged canceled write when cleanup or a late abort fails.
        let cleanup_pending = if let Some(obsolete) = committed.obsolete {
            owner
                .storage(Some(generation), move |store, _check| {
                    store.with_guide_read(|c| {
                        account_vault::cleanup_unreferenced(c, &root, &obsolete)
                    })
                })
                .await
                .is_err()
        } else {
            false
        };
        Ok(PutReceipt {
            schema_version: 1,
            committed: true,
            metadata: committed.metadata,
            cleanup_pending: cleanup_pending || playback_cleanup,
        })
    })
    .await
}
pub(crate) async fn remove(
    request: account_vault::Remove,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<RemoveReceipt, String> {
    let paths_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let _writer = ACCOUNT_WRITER.try_lock().map_err(|_| "account-busy")?;
        let root = directory(&paths_app).await?;
        owner.check()?;
        let account_id = request.account_id.clone();
        let (obsolete, generation) = owner
            .storage(None, move |store, check| {
                store.with_guide_write(|c| account_vault::remove(c, &request, check))
            })
            .await?;
        let playback_cleanup = crate::account_playback_owner::stop_account(&account_id)
            .await
            .is_err();
        let cleanup_pending = owner
            .storage(Some(generation), move |store, _check| {
                store.with_guide_write(|c| {
                    account_vault::cleanup_unreferenced(c, &root, &obsolete)?;
                    // The writer excludes every in-flight media seal. Account
                    // removal cascades page references; erase their orphaned
                    // ciphertext as well as the credential envelope.
                    crate::account_media_store::recover_orphans(c, &root, || Ok(()))?;
                    Ok(())
                })
            })
            .await
            .is_err();
        Ok(RemoveReceipt {
            schema_version: 1,
            committed: true,
            cleanup_pending: cleanup_pending || playback_cleanup,
        })
    })
    .await
}
