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

//! Removing titles, files or the whole library, and favorites.

use super::*;

#[derive(Clone)]
pub(crate) enum RemovalScope {
    TitleRef(String),
    FileRef(String),
    All,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveTitleRequest {
    pub schema_version: u32,
    pub request_id: String,
    pub title_ref: String,
    pub expected_revision: String,
    pub explicit_action: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveFileRequest {
    pub schema_version: u32,
    pub request_id: String,
    pub title_ref: String,
    pub file_ref: String,
    pub expected_revision: String,
    pub explicit_action: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearLibraryRequest {
    pub schema_version: u32,
    pub request_id: String,
    pub expected_revision: String,
    pub explicit_action: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalReceipt {
    pub schema_version: u32,
    pub committed: bool,
    pub revision: String,
    pub removed_titles: usize,
    pub removed_files: usize,
    pub removed_favorites: usize,
    pub cleared_progress: usize,
    pub cleanup_pending: bool,
}

pub(super) fn removed(c: &Connection, scope: &str, reference: &str) -> Result<bool, String> {
    sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM archive_removal_v1 WHERE scope=?1 AND reference=?2)",
        params![scope, reference],
        |r| r.get(0),
    ))
}

pub(crate) fn remove(
    c: &mut Connection,
    scope: &RemovalScope,
    title_ref: Option<&str>,
    expected: &str,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<RemovalReceipt, String> {
    if title_ref.is_some_and(|s| !hex_ref(s))
        || match scope {
            RemovalScope::TitleRef(s) | RemovalScope::FileRef(s) => !hex_ref(s),
            RemovalScope::All => false,
        }
    {
        return Err("archive-removal-invalid".into());
    }
    check()?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let old = current(&tx)?;
    if old != revision(expected)? {
        return Err("archive-revision-stale".into());
    }
    let next = old.checked_add(1).ok_or("archive-revision-exhausted")?;
    let mut receipt = RemovalReceipt {
        schema_version: 1,
        committed: true,
        revision: expected.to_owned(),
        removed_titles: 0,
        removed_files: 0,
        removed_favorites: 0,
        cleared_progress: 0,
        cleanup_pending: false,
    };
    let mut changed = false;
    let public_handled = if matches!(scope, RemovalScope::All) {
        false
    } else {
        crate::archive_provider_catalog::remove_in_transaction(&tx, scope, title_ref, &mut receipt)?
    };
    if public_handled {
        changed = true;
    } else {
        match scope {
            RemovalScope::All => {
                crate::archive_bookmarks::reset_library_in_transaction(&tx, check)?;
                receipt.removed_titles = sql(tx.query_row(
                    "SELECT count(*) FROM archive_title_v1",
                    [],
                    |r| r.get::<_, i64>(0),
                ))? as usize;
                receipt.removed_files = sql(tx.query_row(
                    "SELECT count(*) FROM archive_file_v1",
                    [],
                    |r| r.get::<_, i64>(0),
                ))? as usize;
                receipt.removed_favorites = sql(tx.query_row(
                    "SELECT count(*) FROM archive_preferences_v1 WHERE favorite=1",
                    [],
                    |r| r.get::<_, i64>(0),
                ))? as usize;
                receipt.cleared_progress = sql(tx.query_row(
                    "SELECT (SELECT count(*) FROM archive_progress_v1)+(SELECT count(*) FROM archive_item_progress_v1)",
                    [],
                    |r| r.get::<_, i64>(0),
                ))? as usize;
                for table in [
                    "archive_item_progress_v1",
                    "archive_file_v1",
                    "archive_title_v1",
                    "archive_preferences_v1",
                    "archive_progress_v1",
                    "archive_removal_v1",
                ] {
                    check()?;
                    sql(tx.execute(&format!("DELETE FROM {table}"), []))?;
                }
                // Empty clear still invalidates every already-captured producer.
                changed = true;
            }
            RemovalScope::TitleRef(reference) => {
                let row: Option<(String, String)> = sql(tx
                    .query_row(
                        "SELECT item_id,title FROM archive_title_v1 WHERE title_ref=?1",
                        [reference],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional())?;
                let row = match row {
                    Some(row) => Some(row),
                    None => sql(tx
                        .query_row(
                            "SELECT item_id,title FROM archive_preferences_v1 WHERE title_ref=?1",
                            [reference],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional())?,
                };
                if let Some((id, name)) = row {
                    if opaque(&["archive-item-v1", &id]) != *reference {
                        return Err("archive-removal-scope-invalid".into());
                    }
                    sql(tx.execute(
                        "INSERT INTO archive_removal_v1 VALUES('title',?1,?2,?1,?3,NULL,?4) ON CONFLICT(scope,reference) DO NOTHING",
                        params![reference, id, name, next],
                    ))?;
                    receipt.removed_files = sql(tx.query_row(
                        "SELECT count(*) FROM archive_file_v1 WHERE title_ref=?1",
                        [reference],
                        |r| r.get::<_, i64>(0),
                    ))? as usize;
                    receipt.cleared_progress = sql(tx.query_row(
                        "SELECT count(*) FROM archive_item_progress_v1 WHERE item_id=?1",
                        [&id],
                        |r| r.get::<_, i64>(0),
                    ))? as usize;
                    receipt.removed_favorites = sql(tx.query_row(
                        "SELECT count(*) FROM archive_preferences_v1 WHERE title_ref=?1 AND favorite=1",
                        [reference],
                        |r| r.get::<_, i64>(0),
                    ))? as usize;
                    sql(tx.execute(
                        "DELETE FROM archive_preferences_v1 WHERE title_ref=?1",
                        [reference],
                    ))?;
                    receipt.removed_titles = sql(tx.execute(
                        "DELETE FROM archive_title_v1 WHERE title_ref=?1",
                        [reference],
                    ))?;
                    changed = true;
                } else if !removed(&tx, "title", reference)? {
                    return Err("archive-title-unavailable".into());
                }
            }
            RemovalScope::FileRef(reference) => {
                let requested_title = title_ref.ok_or("archive-removal-scope-invalid")?;
                let row:Option<(String,String,String,String)>=sql(tx.query_row("SELECT f.item_id,f.title_ref,f.file_name,COALESCE(f.file_title,t.title) FROM archive_file_v1 f JOIN archive_title_v1 t ON t.title_ref=f.title_ref WHERE f.file_ref=?1",[reference],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?;
                if let Some((id, title, name, display)) = row {
                    if title != requested_title
                        || opaque(&["archive-file-v1", &id, &name]) != *reference
                    {
                        return Err("archive-removal-scope-invalid".into());
                    }
                    sql(tx.execute(
                        "INSERT INTO archive_removal_v1 VALUES('file',?1,?2,?3,?4,?5,?6) ON CONFLICT(scope,reference) DO NOTHING",
                        params![reference, id, title, display, name, next],
                    ))?;
                    receipt.removed_files = sql(
                        tx.execute("DELETE FROM archive_file_v1 WHERE file_ref=?1", [reference])
                    )?;
                    changed = true;
                } else {
                    let saved: Option<String> = sql(tx
                        .query_row(
                            "SELECT title_ref FROM archive_removal_v1 WHERE scope='file' AND reference=?1",
                            [reference],
                            |r| r.get(0),
                        )
                        .optional())?;
                    if saved.as_deref() != Some(requested_title) {
                        return Err("archive-removal-scope-invalid".into());
                    }
                }
            }
        }
    }
    if matches!(scope, RemovalScope::All) {
        crate::archive_provider_catalog::remove_in_transaction(
            &tx,
            scope,
            title_ref,
            &mut receipt,
        )?;
    }
    if changed {
        catalog_bounds(&tx)?;
        sql(tx.execute(
            "UPDATE archive_catalog_meta_v1 SET revision=?1 WHERE singleton=1 AND revision=?2",
            params![next, old],
        ))?;
        receipt.revision = next.to_string();
    }
    crate::archive_library_store::finalize(&tx, matches!(scope, RemovalScope::All), check)?;
    check()?;
    sql(tx.commit())?;
    Ok(receipt)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FavoriteRequest {
    pub schema_version: u32,
    pub request_id: String,
    pub title_ref: String,
    pub expected_revision: String,
    pub value: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteReceipt {
    pub schema_version: u32,
    pub committed: bool,
    pub revision: String,
    pub title_ref: String,
    pub favorite: bool,
}

pub(super) fn catalog_bounds(c: &Connection) -> Result<i64, String> {
    let (preferences,preference_bytes):(i64,i64)=sql(c.query_row("SELECT count(*),COALESCE(sum(length(CAST(title_ref AS BLOB))+length(CAST(item_id AS BLOB))+length(CAST(title AS BLOB))+128),0) FROM archive_preferences_v1",[],|r|Ok((r.get(0)?,r.get(1)?))))?;
    if preferences > 10000 || preference_bytes > 4 * 1024 * 1024 {
        return Err("archive-preferences-limit".into());
    }
    let (total,bytes):(i64,i64)=sql(c.query_row("SELECT (SELECT count(*) FROM archive_title_v1),(SELECT COALESCE(sum(length(CAST(title AS BLOB))+length(CAST(item_id AS BLOB))+COALESCE(length(CAST(rights AS BLOB)),0)+length(CAST(search_text AS BLOB))+256),0) FROM archive_title_v1)+(SELECT COALESCE(sum(length(CAST(file_name AS BLOB))+length(CAST(item_id AS BLOB))+length(CAST(servers AS BLOB))+COALESCE(length(CAST(original_identity AS BLOB)),0)+COALESCE(length(CAST(file_title AS BLOB)),0)+256),0) FROM archive_file_v1)",[],|r|Ok((r.get(0)?,r.get(1)?))))?;
    let progress_bytes: i64 = sql(c.query_row(
        "SELECT count(*)*256 FROM archive_item_progress_v1",
        [],
        |r| r.get(0),
    ))?;
    let (removal_count,removal_bytes):(i64,i64)=sql(c.query_row("SELECT count(*),COALESCE(sum(length(CAST(reference AS BLOB))+length(CAST(item_id AS BLOB))+length(CAST(title_ref AS BLOB))+length(CAST(display_name AS BLOB))+COALESCE(length(CAST(file_name AS BLOB)),0)+128),0) FROM archive_removal_v1",[],|r|Ok((r.get(0)?,r.get(1)?))))?;
    if removal_count > 10000 || removal_bytes > 4 * 1024 * 1024 {
        return Err("archive-removals-limit".into());
    }
    let public = if crate::archive_provider_catalog::installed(c)? {
        sql(
            c.query_row("SELECT count(*) FROM public_archive_item_v1", [], |r| {
                r.get::<_, i64>(0)
            }),
        )?
    } else {
        0
    };
    if total + public > 1400
        || bytes
            .checked_add(preference_bytes)
            .and_then(|b| b.checked_add(progress_bytes))
            .and_then(|b| b.checked_add(removal_bytes))
            .is_none_or(|b| b > 20 * 1024 * 1024)
    {
        return Err("archive-catalog-limit".into());
    }
    Ok(total + public)
}

pub(crate) fn set_favorite(
    c: &mut Connection,
    r: &FavoriteRequest,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<FavoriteReceipt, String> {
    if r.schema_version != 1 || !text(&r.request_id, 256) || !hex_ref(&r.title_ref) {
        return Err("archive-favorite-invalid".into());
    }
    if crate::archive_provider_catalog::title_exists(c, &r.title_ref)? {
        return crate::archive_provider_catalog::set_favorite(c, r, check);
    }
    let expected = revision(&r.expected_revision)?;
    check()?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    if current(&tx)? != expected {
        return Err("archive-revision-stale".into());
    }
    let live:Option<(String,String,Option<i64>)>=sql(tx.query_row("SELECT item_id,title,release_year FROM archive_title_v1 t WHERE title_ref=?1 AND EXISTS(SELECT 1 FROM archive_file_v1 f WHERE f.title_ref=t.title_ref AND f.eligible=1)",[&r.title_ref],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional())?;
    let saved: Option<(String, String, Option<i64>, bool)> = sql(tx
        .query_row(
            "SELECT item_id,title,release_year,favorite FROM archive_preferences_v1 WHERE title_ref=?1",
            [&r.title_ref],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional())?;
    let metadata = match (live, saved.as_ref()) {
        (Some(metadata), _) => metadata,
        (None, Some((id, title, year, _))) if !r.value => (id.clone(), title.clone(), *year),
        _ => return Err("archive-title-unavailable".into()),
    };
    if opaque(&["archive-item-v1", &metadata.0]) != r.title_ref {
        return Err("archive-favorite-invalid".into());
    }
    let changed = saved.as_ref().is_some_and(|s| s.3) != r.value;
    let mut result_revision = expected;
    if changed {
        result_revision = expected
            .checked_add(1)
            .ok_or("archive-revision-exhausted")?;
        sql(tx.execute(
            "INSERT INTO archive_preferences_v1 VALUES(?1,?2,?3,?4,?5) ON CONFLICT(title_ref) DO UPDATE SET favorite=excluded.favorite",
            params![r.title_ref, metadata.0, metadata.1, metadata.2, r.value],
        ))?;
        catalog_bounds(&tx)?;
        if sql(tx.execute(
            "UPDATE archive_catalog_meta_v1 SET revision=?1 WHERE singleton=1 AND revision=?2",
            params![result_revision, expected],
        ))? != 1
        {
            return Err("archive-revision-stale".into());
        }
    }
    crate::archive_library_store::finalize(&tx, false, check)?;
    check()?;
    sql(tx.commit())?;
    Ok(FavoriteReceipt {
        schema_version: 1,
        committed: true,
        revision: result_revision.to_string(),
        title_ref: r.title_ref.clone(),
        favorite: r.value,
    })
}
