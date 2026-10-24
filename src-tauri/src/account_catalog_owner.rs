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

//! Retained metadata paging and native-only account media resolution.
//! Only Page implements Serialize. NativeSelection and Authority never cross IPC;
//! callers retain Context through proxy work and join it on stop/background/exit.
use crate::{
    account_media_store,
    scan_manifest_work::{self, Context},
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{future::Future, sync::Arc};

const ERR: &str = "account-catalog-request-invalid";
const PAGE_LIMIT: usize = 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListRequest {
    pub schema_version: u8,
    pub account_id: String,
    pub expected_account_revision: String,
    pub expected_media_revision: Option<String>,
    pub after_id: String,
    pub limit: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    pub schema_version: u8,
    pub account_id: String,
    pub account_revision: String,
    pub media_revision: String,
    pub channels: Vec<account_media_store::Channel>,
    pub next_after_id: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResolveRequest {
    pub schema_version: u8,
    pub account_id: String,
    pub expected_account_revision: String,
    pub expected_media_revision: String,
    pub stream_reference: String,
}
#[derive(Clone, PartialEq, Eq)]
struct Snapshot {
    account_revision: i64,
    media_revision: i64,
    secret_ref: String,
    batch_id: String,
    origin: String,
}
/// Captured native authority contains only opaque identifiers, revisions and an
/// origin. It retains neither credentials nor an account media URL.
#[derive(Clone)]
pub(crate) struct Authority {
    request: ResolveRequest,
    snapshot: Snapshot,
    root_generation: u64,
    pub origin: String,
}
pub(crate) struct NativeSelection {
    pub media: account_media_store::ResolvedMedia,
    pub authority: Authority,
}
fn sql<T>(value: rusqlite::Result<T>) -> Result<T, String> {
    value.map_err(|_| "account-catalog-storage-failed".into())
}
fn opaque(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn decimal(value: &str) -> Result<i64, String> {
    if value.is_empty()
        || value.len() > 19
        || value.starts_with('0')
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("account-revision-invalid".into());
    }
    value
        .parse::<i64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| "account-revision-invalid".into())
}
fn scoped_id(value: &str, account: &str) -> bool {
    value
        .strip_prefix(&format!("account-{account}-"))
        .is_some_and(|suffix| {
            suffix.len() == 64
                && suffix
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}
fn table(c: &Connection, name: &str) -> Result<bool, String> {
    sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get::<_, bool>(0),
    ))
}
fn snapshot(c: &Connection, account: &str) -> Result<Snapshot, String> {
    if !table(c, "account_vault_meta_v1")? {
        return Err("account-sign-in-required".into());
    }
    let metadata = sql(c.query_row("SELECT m.revision,m.secret_ref,m.server_origin,m.allow_http,v.active,v.revision FROM account_vault_meta_v1 m JOIN account_vault_versions_v1 v ON v.id=m.id WHERE m.id=?1",[account],|r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,bool>(3)?,r.get::<_,bool>(4)?,r.get::<_,i64>(5)?))).optional())?
        .ok_or("account-removed")?;
    if metadata.0 <= 0 || metadata.0 != metadata.5 || !metadata.4 || !opaque(&metadata.1) {
        return Err("account-sign-in-required".into());
    }
    let origin_url = reqwest::Url::parse(&metadata.2).map_err(|_| "account-origin-refused")?;
    if !crate::account_vault::origin_allowed(&origin_url, &metadata.2, metadata.3) {
        return Err("account-origin-refused".into());
    }
    if !table(c, "account_media_catalog_v1")? {
        return Err("account-media-not-collected".into());
    }
    let media = sql(c.query_row("SELECT account_revision,secret_ref,batch_id,revision FROM account_media_catalog_v1 WHERE account_id=?1",[account],|r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?))).optional())?
        .ok_or("account-media-not-collected")?;
    if media.0 != metadata.0 || media.1 != metadata.1 {
        return Err("account-media-reference-revoked".into());
    }
    if media.3 <= 0 || !opaque(&media.2) {
        return Err("account-media-invalid".into());
    }
    Ok(Snapshot {
        account_revision: metadata.0,
        media_revision: media.3,
        secret_ref: media.1,
        batch_id: media.2,
        origin: metadata.2,
    })
}
fn expect(actual: &Snapshot, account: &str, media: Option<&str>) -> Result<(), String> {
    if actual.account_revision != decimal(account)? {
        return Err("account-revision-conflict".into());
    }
    if let Some(media) = media {
        if actual.media_revision != decimal(media)? {
            return Err("account-media-revision-conflict".into());
        }
    }
    Ok(())
}
fn validate_list(request: &ListRequest) -> Result<(), String> {
    if request.schema_version != 1
        || !opaque(&request.account_id)
        || request.limit == 0
        || request.limit > 64
        || (!request.after_id.is_empty()
            && (!scoped_id(&request.after_id, &request.account_id)
                || request.expected_media_revision.is_none()))
    {
        return Err(ERR.into());
    }
    decimal(&request.expected_account_revision)?;
    if let Some(media) = &request.expected_media_revision {
        decimal(media)?;
    }
    Ok(())
}
fn validate_resolve(request: &ResolveRequest) -> Result<(), String> {
    if request.schema_version != 1
        || !opaque(&request.account_id)
        || !opaque(&request.stream_reference)
    {
        return Err(ERR.into());
    }
    decimal(&request.expected_account_revision)?;
    decimal(&request.expected_media_revision)?;
    Ok(())
}
/// One deferred read transaction pins metadata and both revisions to one SQLite
/// snapshot. Each subsequent page must present those exact captured revisions.
pub(crate) fn read_page(
    c: &Connection,
    request: &ListRequest,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Page, String> {
    validate_list(request)?;
    check()?;
    let tx = sql(c.unchecked_transaction())?;
    let captured = snapshot(&tx, &request.account_id)?;
    expect(
        &captured,
        &request.expected_account_revision,
        request.expected_media_revision.as_deref(),
    )?;
    let rows = account_media_store::list_channels(
        &tx,
        &request.account_id,
        captured.account_revision as u64,
        &request.after_id,
        request.limit,
    )?;
    let mut channels = Vec::with_capacity(rows.len());
    let mut bytes = 512usize;
    let mut previous = request.after_id.as_str();
    let mut refs = std::collections::HashSet::new();
    for row in &rows {
        check()?;
        if !scoped_id(&row.id, &request.account_id)
            || row.id.as_str() <= previous
            || !opaque(&row.stream_reference)
            || !refs.insert(&row.stream_reference)
        {
            return Err("account-media-invalid".into());
        }
        let size = serde_json::to_vec(row)
            .map_err(|_| "account-media-invalid")?
            .len()
            + 1;
        if bytes + size > PAGE_LIMIT {
            if channels.is_empty() {
                return Err("account-catalog-page-too-large".into());
            }
            break;
        }
        previous = &row.id;
        bytes += size;
        channels.push(row.clone());
    }
    let next_after_id = if let Some(last) = channels.last() {
        let remaining = account_media_store::list_channels(
            &tx,
            &request.account_id,
            captured.account_revision as u64,
            &last.id,
            1,
        )?;
        if remaining.is_empty() {
            None
        } else {
            Some(last.id.clone())
        }
    } else {
        None
    };
    check()?;
    sql(tx.commit())?;
    let page = Page {
        schema_version: 1,
        account_id: request.account_id.clone(),
        account_revision: captured.account_revision.to_string(),
        media_revision: captured.media_revision.to_string(),
        channels,
        next_after_id,
    };
    if serde_json::to_vec(&page)
        .map_err(|_| "account-media-invalid")?
        .len()
        > PAGE_LIMIT
    {
        return Err("account-catalog-page-too-large".into());
    }
    check()?;
    Ok(page)
}
pub(crate) async fn list(
    request: ListRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Page, String> {
    validate_list(&request)?;
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (page, _) = owner
            .storage(None, move |store, check| {
                store.with_guide_read(|c| read_page(c, &request, check))
            })
            .await?;
        owner.check()?;
        Ok(page)
    })
    .await
}
pub(crate) async fn resolve(
    owner: Arc<Context>,
    app: tauri::AppHandle,
    request: ResolveRequest,
) -> Result<NativeSelection, String> {
    validate_resolve(&request)?;
    owner.check()?;
    let root = crate::account_vault_owner::directory(&app).await?;
    owner.check()?;
    let preparation_request = request.clone();
    let ((prepared, captured), generation) = owner
        .storage_with_generation(None, move |store, generation, check| {
            store.with_guide_read(|c| {
                check()?;
                let tx = sql(c.unchecked_transaction())?;
                let captured = snapshot(&tx, &preparation_request.account_id)?;
                expect(
                    &captured,
                    &preparation_request.expected_account_revision,
                    Some(&preparation_request.expected_media_revision),
                )?;
                let prepared = account_media_store::prepare_load(
                    &tx,
                    &preparation_request.account_id,
                    &preparation_request.stream_reference,
                    generation,
                    &mut *check,
                )?;
                check()?;
                sql(tx.commit())?;
                Ok((prepared, captured))
            })
        })
        .await?;
    let opened = account_media_store::open(app, root, prepared, || owner.check()).await?;
    owner.check()?;
    let final_request = request.clone();
    let comparison = captured.clone();
    let (media, _) = owner
        .storage_with_generation(Some(generation), move |store, current, check| {
            store.with_guide_read(|c| {
                let tx = sql(c.unchecked_transaction())?;
                let actual = snapshot(&tx, &final_request.account_id)?;
                expect(
                    &actual,
                    &final_request.expected_account_revision,
                    Some(&final_request.expected_media_revision),
                )?;
                if actual != comparison {
                    return Err("account-media-reference-revoked".into());
                }
                let media = account_media_store::finish_load(&tx, opened, current, &mut *check)?;
                check()?;
                sql(tx.commit())?;
                Ok(media)
            })
        })
        .await?;
    for url in media.urls() {
        owner.check()?;
        let parsed = reqwest::Url::parse(url).map_err(|_| "account-media-invalid")?;
        // The origin comparison pins the scheme (HTTP only by explicit grant).
        if !matches!(parsed.scheme(), "https" | "http")
            || parsed.origin().ascii_serialization() != captured.origin
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("account-origin-refused".into());
        }
    }
    owner.check()?;
    let origin = captured.origin.clone();
    Ok(NativeSelection {
        media,
        authority: Authority {
            request,
            snapshot: captured,
            root_generation: generation,
            origin,
        },
    })
}
/// Proxy-compatible authority check. Capture cloned Context + Authority in the
/// proxy's native async callback and retain them until actual proxy shutdown.
pub(crate) async fn verify(owner: Arc<Context>, authority: Authority) -> Result<(), String> {
    owner.check()?;
    owner
        .storage_with_generation(
            Some(authority.root_generation),
            move |store, generation, check| {
                store.with_guide_read(|c| {
                    let tx = sql(c.unchecked_transaction())?;
                    let current = snapshot(&tx, &authority.request.account_id)?;
                    if current != authority.snapshot {
                        return Err("account-media-reference-revoked".into());
                    }
                    // Checks that the opaque stream itself remains live, not merely its account.
                    account_media_store::prepare_load(
                        &tx,
                        &authority.request.account_id,
                        &authority.request.stream_reference,
                        generation,
                        &mut *check,
                    )?;
                    check()?;
                    sql(tx.commit())?;
                    Ok(())
                })
            },
        )
        .await?;
    owner.check()?;
    Ok(())
}
pub(crate) async fn with_resolved<T, F, Fut>(
    owner: Arc<Context>,
    app: tauri::AppHandle,
    request: ResolveRequest,
    operation: F,
) -> Result<T, String>
where
    F: FnOnce(Arc<Context>, NativeSelection) -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let selected = resolve(owner.clone(), app, request).await?;
    owner.check()?;
    operation(owner, selected).await
}
