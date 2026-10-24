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

//! Account-scoped metadata preferences. Stable identities survive media refresh;
//! no preference row references a transient stream grant or plaintext URL.
//! The native work owner spans preparation and the exact root/revision CAS.
use crate::scan_manifest_work::{self, Context};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const ERR: &str = "account-preferences-invalid";
const MAX_ROWS: i64 = 100_000;
const MAX_BYTES: i64 = 20 * 1024 * 1024;
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS account_preferences_meta_v1(
 account_id TEXT PRIMARY KEY REFERENCES account_vault_meta_v1(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL CHECK(revision>=0));
 CREATE TABLE IF NOT EXISTS account_channel_preferences_v1(
 account_id TEXT NOT NULL REFERENCES account_preferences_meta_v1(account_id) ON DELETE CASCADE,
 channel_id TEXT NOT NULL,favorite INTEGER NOT NULL CHECK(favorite IN(0,1)),
 removed INTEGER NOT NULL CHECK(removed IN(0,1)),category TEXT,
 PRIMARY KEY(account_id,channel_id));
 CREATE INDEX IF NOT EXISTS account_preferences_removed_v1 ON account_channel_preferences_v1(account_id,removed,channel_id);
 CREATE INDEX IF NOT EXISTS account_preferences_favorite_v1 ON account_channel_preferences_v1(account_id,favorite,channel_id);";
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Mutation {
    Favorite {
        #[serde(rename = "channelId")]
        channel_id: String,
        favorite: bool,
    },
    Remove {
        #[serde(rename = "channelId")]
        channel_id: String,
    },
    Restore {
        #[serde(rename = "channelId")]
        channel_id: String,
    },
    Category {
        #[serde(rename = "channelId")]
        channel_id: String,
        #[serde(deserialize_with = "category_value")]
        category: Option<String>,
    },
    RestoreAll {},
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub schema_version: u8,
    pub account_id: String,
    pub expected_account_revision: String,
    pub expected_media_revision: String,
    pub expected_preferences_revision: String,
    pub mutation: Mutation,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    pub schema_version: u8,
    pub committed: bool,
    pub account_id: String,
    pub account_revision: String,
    pub media_revision: String,
    pub preferences_revision: String,
    pub changed: bool,
    pub cleanup_pending: bool,
    // Root joins playback cleanup for this stable identity before IPC ACK.
    #[serde(skip)]
    pub removed_channel_id: Option<String>,
}
#[derive(PartialEq, Eq)]
struct AccountFence {
    account_revision: i64,
    media_revision: i64,
    secret_ref: String,
    batch_id: String,
    origin: String,
}
pub(crate) struct Prepared {
    request: Request,
    fence: AccountFence,
    root_generation: u64,
}
#[derive(Default, PartialEq, Eq)]
struct Row {
    favorite: bool,
    removed: bool,
    category: Option<String>,
}
fn category_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}
fn sql<T>(value: rusqlite::Result<T>) -> Result<T, String> {
    value.map_err(|e| {
        crate::storage_transaction::sql_error_code(&e, "account-preferences-storage-failed")
    })
}
fn opaque(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn scoped(value: &str, account: &str) -> bool {
    value
        .strip_prefix(&format!("account-{account}-"))
        .is_some_and(|v| {
            v.len() == 64
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}
fn decimal(value: &str, zero: bool) -> Result<i64, String> {
    if value.is_empty()
        || value.len() > 19
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(ERR.into());
    }
    value
        .parse::<i64>()
        .ok()
        .filter(|v| *v > 0 || (zero && *v == 0))
        .ok_or_else(|| ERR.into())
}
fn channel(mutation: &Mutation) -> Option<&str> {
    match mutation {
        Mutation::Favorite { channel_id, .. }
        | Mutation::Remove { channel_id }
        | Mutation::Restore { channel_id }
        | Mutation::Category { channel_id, .. } => Some(channel_id),
        Mutation::RestoreAll {} => None,
    }
}
fn validate(request: &Request) -> Result<(), String> {
    if request.schema_version != 1
        || !opaque(&request.account_id)
        || channel(&request.mutation).is_some_and(|v| !scoped(v, &request.account_id))
    {
        return Err(ERR.into());
    }
    decimal(&request.expected_account_revision, false)?;
    decimal(&request.expected_media_revision, false)?;
    decimal(&request.expected_preferences_revision, true)?;
    if let Mutation::Category {
        category: Some(value),
        ..
    } = &request.mutation
    {
        if value.len() > 16384 || value.chars().any(char::is_control) || value.contains("://") {
            return Err(ERR.into());
        }
    }
    Ok(())
}
fn table(c: &Connection, name: &str) -> Result<bool, String> {
    sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get::<_, bool>(0),
    ))
}
pub(crate) fn present(c: &Connection) -> Result<bool, String> {
    let meta = table(c, "account_preferences_meta_v1")?;
    let rows = table(c, "account_channel_preferences_v1")?;
    if meta != rows {
        return Err(ERR.into());
    }
    Ok(meta)
}
/// Read-only zero for an uninitialized account; no migration/write from queries.
pub(crate) fn revision(c: &Connection, account: &str) -> Result<i64, String> {
    if !opaque(account) {
        return Err(ERR.into());
    }
    if !present(c)? {
        return Ok(0);
    }
    let value = sql(c
        .query_row(
            "SELECT revision FROM account_preferences_meta_v1 WHERE account_id=?1",
            [account],
            |r| r.get::<_, i64>(0),
        )
        .optional())?;
    match value {
        Some(value) if value >= 0 => Ok(value),
        Some(_) => Err(ERR.into()),
        None => {
            if sql(c.query_row(
                "SELECT EXISTS(SELECT 1 FROM account_channel_preferences_v1 WHERE account_id=?1)",
                [account],
                |r| r.get::<_, bool>(0),
            ))? {
                return Err(ERR.into());
            }
            Ok(0)
        }
    }
}
pub(crate) fn is_removed(c: &Connection, account: &str, channel_id: &str) -> Result<bool, String> {
    if !opaque(account) || !scoped(channel_id, account) {
        return Err(ERR.into());
    }
    if !present(c)? {
        return Ok(false);
    }
    revision(c, account)?;
    let value = sql(c.query_row("SELECT removed FROM account_channel_preferences_v1 WHERE account_id=?1 AND channel_id=?2",params![account,channel_id],|r| r.get::<_,i64>(0)).optional())?;
    match value {
        None | Some(0) => Ok(false),
        Some(1) => Ok(true),
        Some(_) => Err(ERR.into()),
    }
}
pub(crate) fn initialize(c: &Connection) -> Result<(), String> {
    present(c)?;
    if !sql(c.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, bool>(0)))? {
        return Err("account-preferences-storage-policy".into());
    }
    if !table(c, "account_vault_meta_v1")? {
        return Err("account-sign-in-required".into());
    }
    sql(c.execute_batch(SCHEMA))
}
fn account_fence(c: &Connection, request: &Request) -> Result<AccountFence, String> {
    if !table(c, "account_vault_meta_v1")? {
        return Err("account-sign-in-required".into());
    }
    let account = sql(c.query_row("SELECT m.revision,m.secret_ref,m.server_origin,m.allow_http,v.active,v.revision FROM account_vault_meta_v1 m JOIN account_vault_versions_v1 v ON v.id=m.id WHERE m.id=?1",[&request.account_id],|r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?))).optional())?.ok_or("account-removed")?;
    if account.0 <= 0 || account.0 != account.5 || account.4 != 1 || !opaque(&account.1) {
        return Err("account-sign-in-required".into());
    }
    let origin = reqwest::Url::parse(&account.2).map_err(|_| "account-origin-refused")?;
    if !crate::account_vault::origin_allowed(&origin, &account.2, account.3 != 0) {
        return Err("account-origin-refused".into());
    }
    if account.0 != decimal(&request.expected_account_revision, false)? {
        return Err("account-revision-conflict".into());
    }
    if !table(c, "account_media_catalog_v1")? {
        return Err("account-media-not-collected".into());
    }
    let media = sql(c.query_row("SELECT account_revision,secret_ref,batch_id,revision FROM account_media_catalog_v1 WHERE account_id=?1",[&request.account_id],|r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?))).optional())?.ok_or("account-media-not-collected")?;
    if media.0 != account.0 || media.1 != account.1 {
        return Err("account-media-reference-revoked".into());
    }
    if media.3 <= 0 || !opaque(&media.2) {
        return Err(ERR.into());
    }
    if media.3 != decimal(&request.expected_media_revision, false)? {
        return Err("account-media-revision-conflict".into());
    }
    Ok(AccountFence {
        account_revision: account.0,
        media_revision: media.3,
        secret_ref: media.1,
        batch_id: media.2,
        origin: account.2,
    })
}
pub(crate) fn prepare(
    c: &Connection,
    request: Request,
    generation: u64,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Prepared, String> {
    validate(&request)?;
    check()?;
    let tx = sql(c.unchecked_transaction())?;
    let fence = account_fence(&tx, &request)?;
    if revision(&tx, &request.account_id)? != decimal(&request.expected_preferences_revision, true)?
    {
        return Err("account-preferences-revision-conflict".into());
    }
    check()?;
    sql(tx.commit())?;
    Ok(Prepared {
        request,
        fence,
        root_generation: generation,
    })
}
fn read_row(c: &Connection, account: &str, id: &str) -> Result<Option<Row>, String> {
    let value = sql(c.query_row("SELECT favorite,removed,category FROM account_channel_preferences_v1 WHERE account_id=?1 AND channel_id=?2",params![account,id],|r| Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?))).optional())?;
    value
        .map(|(favorite, removed, category)| {
            if !(0..=1).contains(&favorite)
                || !(0..=1).contains(&removed)
                || category.as_ref().is_some_and(|v| {
                    v.len() > 16384 || v.chars().any(char::is_control) || v.contains("://")
                })
            {
                return Err(ERR.into());
            }
            Ok(Row {
                favorite: favorite == 1,
                removed: removed == 1,
                category,
            })
        })
        .transpose()
}
fn live_channel(c: &Connection, account: &str, id: &str) -> Result<bool, String> {
    sql(c.query_row("SELECT EXISTS(SELECT 1 FROM account_media_entry_v1 e JOIN account_media_catalog_v1 cat ON cat.account_id=e.account_id JOIN account_vault_meta_v1 m ON m.id=cat.account_id AND m.revision=cat.account_revision AND m.secret_ref=cat.secret_ref JOIN account_vault_versions_v1 v ON v.id=m.id AND v.active=1 AND v.revision=m.revision JOIN account_media_page_v1 p ON p.page_ref=e.page_ref AND p.account_id=e.account_id AND p.batch_id=cat.batch_id JOIN account_vault_references_v1 r ON r.reference=e.stream_ref AND r.account_id=e.account_id AND r.account_revision=cat.account_revision AND r.purpose='media' WHERE e.account_id=?1 AND e.channel_id=?2)",params![account,id],|r| r.get::<_,bool>(0)))
}
fn bounds(c: &Connection, account: &str) -> Result<(), String> {
    // JSON1 counts exact UTF-8 escaped metadata bytes, without a whole-account
    // Rust allocation. Boolean tags and nullable categories match export shape.
    let (rows,bytes) = sql(c.query_row("SELECT COUNT(*),COALESCE(SUM(length(CAST(json_object('channelId',channel_id,'favorite',json(CASE favorite WHEN 1 THEN 'true' ELSE 'false' END),'removed',json(CASE removed WHEN 1 THEN 'true' ELSE 'false' END),'category',category) AS BLOB))+1),0)+2 FROM account_channel_preferences_v1 WHERE account_id=?1",[account],|r| Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?))))?;
    if rows < 0 || rows > MAX_ROWS || bytes < 0 || bytes > MAX_BYTES {
        return Err("account-preferences-too-large".into());
    }
    Ok(())
}
pub(crate) fn commit(
    c: &mut Connection,
    prepared: Prepared,
    generation: u64,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Receipt, String> {
    check()?;
    if generation != prepared.root_generation {
        return Err("account-storage-changed".into());
    }
    let request = prepared.request;
    validate(&request)?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let actual = account_fence(&tx, &request)?;
    if actual != prepared.fence {
        return Err("account-media-reference-revoked".into());
    }
    initialize(&tx)?;
    let expected = decimal(&request.expected_preferences_revision, true)?;
    if revision(&tx, &request.account_id)? != expected {
        return Err("account-preferences-revision-conflict".into());
    }
    bounds(&tx, &request.account_id)?;
    let changed = if let Mutation::RestoreAll {} = &request.mutation {
        sql(tx.execute(
            "UPDATE account_channel_preferences_v1 SET removed=0 WHERE account_id=?1 AND removed=1",
            [&request.account_id],
        ))? > 0
    } else {
        let id = channel(&request.mutation).ok_or(ERR)?;
        let previous = read_row(&tx, &request.account_id, id)?;
        let mut next = previous
            .as_ref()
            .map(|row| Row {
                favorite: row.favorite,
                removed: row.removed,
                category: row.category.clone(),
            })
            .unwrap_or_default();
        match &request.mutation {
            Mutation::Favorite { favorite, .. } => next.favorite = *favorite,
            Mutation::Remove { .. } => next.removed = true,
            Mutation::Restore { .. } => next.removed = false,
            Mutation::Category { category, .. } => next.category = category.clone(),
            Mutation::RestoreAll {} => unreachable!(),
        }
        let changed = previous.as_ref().unwrap_or(&Row::default()) != &next;
        if changed {
            if previous.is_none() && !live_channel(&tx, &request.account_id, id)? {
                return Err("account-channel-unavailable".into());
            }
            // Preserve prior choices and recoverable missing identities. Restore
            // only changes flags; it never inserts or synthesizes media rows.
            sql(tx.execute("INSERT INTO account_preferences_meta_v1(account_id,revision) VALUES(?1,?2) ON CONFLICT(account_id) DO NOTHING",params![request.account_id,expected]))?;
            sql(tx.execute("INSERT INTO account_channel_preferences_v1 VALUES(?1,?2,?3,?4,?5) ON CONFLICT(account_id,channel_id) DO UPDATE SET favorite=excluded.favorite,removed=excluded.removed,category=excluded.category",params![request.account_id,id,next.favorite,next.removed,next.category]))?;
        }
        changed
    };
    let next_revision = if changed {
        if expected == i64::MAX {
            return Err("account-preferences-revision-exhausted".into());
        }
        if sql(tx.execute("UPDATE account_preferences_meta_v1 SET revision=revision+1 WHERE account_id=?1 AND revision=?2",params![request.account_id,expected]))?!=1 { return Err("account-preferences-revision-conflict".into()); }
        bounds(&tx, &request.account_id)?;
        expected + 1
    } else {
        expected
    };
    check()?;
    if account_fence(&tx, &request)? != actual {
        return Err("account-media-reference-revoked".into());
    }
    let removed_channel_id = match &request.mutation {
        Mutation::Remove { channel_id } => Some(channel_id.clone()),
        _ => None,
    };
    sql(tx.commit())?;
    // Actual COMMIT is completion even if the observer cancels immediately after.
    Ok(Receipt {
        schema_version: 1,
        committed: true,
        account_id: request.account_id,
        account_revision: actual.account_revision.to_string(),
        media_revision: actual.media_revision.to_string(),
        preferences_revision: next_revision.to_string(),
        changed,
        cleanup_pending: false,
        removed_channel_id,
    })
}
struct Progress<'a> {
    c: &'a Connection,
    active: bool,
}
impl Progress<'_> {
    fn clear(&mut self) -> Result<(), String> {
        sql(self.c.progress_handler(0, None::<fn() -> bool>))?;
        self.active = false;
        Ok(())
    }
}
impl Drop for Progress<'_> {
    fn drop(&mut self) {
        if self.active {
            let _ = self.c.progress_handler(0, None::<fn() -> bool>);
        }
    }
}
fn commit_owned(
    c: &mut Connection,
    prepared: Prepared,
    generation: u64,
    owner: Arc<Context>,
) -> Result<Receipt, String> {
    let observer = owner.clone();
    sql(c.progress_handler(1000, Some(move || observer.check().is_err())))?;
    // The raw connection reference is not held over any await. Drop the guard
    // before return; the dedicated storage connection also closes on scope exit.
    let result = commit(c, prepared, generation, || owner.check());
    let mut progress = Progress { c, active: true };
    let cleanup = progress.clear();
    match result {
        Ok(receipt) => {
            let _ = cleanup;
            Ok(receipt)
        }
        Err(error) => {
            owner.check()?;
            cleanup?;
            Err(error)
        }
    }
}
pub(crate) async fn write(
    request: Request,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Receipt, String> {
    validate(&request)?;
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (prepared, generation) = owner
            .storage_with_generation(None, move |store, current, check| {
                store.with_guide_read(|c| prepare(c, request, current, check))
            })
            .await?;
        owner.check()?;
        let writer = owner.clone();
        let (receipt, _) = owner
            .storage_with_generation(Some(generation), move |store, current, check| {
                check()?;
                store.with_guide_write(|c| commit_owned(c, prepared, current, writer))
            })
            .await?;
        Ok(receipt)
    })
    .await
}
