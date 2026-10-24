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

//! Reversible exact-endpoint browse projection. Canonical records, grants,
//! preferences, guide mappings and candidate order remain their own authority.
use rusqlite::{params, Connection, Transaction};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const POLICY: &str = "exact-ordered-endpoints-policy-v2";
fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| {
        crate::storage_transaction::sql_error_code(&e, "catalog-endpoint-database-failed")
    })
}
pub fn present(c: &Connection) -> Result<bool, String> {
    sql(c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='catalog_endpoint_projection_v1')", [], |r| r.get(0)))
}
/// Caller owns the backed schema migration and its transaction/revision fence.
pub fn install(tx: &Transaction<'_>) -> Result<(), String> {
    sql(tx.execute_batch("CREATE TABLE catalog_endpoint_projection_v1(channel_id TEXT PRIMARY KEY REFERENCES channel(id) ON DELETE CASCADE,endpoint_key BLOB NOT NULL CHECK(length(endpoint_key)=32));CREATE INDEX catalog_endpoint_projection_key_v1 ON catalog_endpoint_projection_v1(endpoint_key,channel_id);"))?;
    rebuild(tx)?;
    crate::catalog_query::advance_view_revision(tx, true)
}
fn field(hash: &mut Sha256, text: Option<&str>) {
    hash.update([u8::from(text.is_some())]);
    if let Some(text) = text {
        hash.update((text.len() as u64).to_be_bytes());
        hash.update(text.as_bytes());
    }
}
fn collect(
    tx: &Transaction<'_>,
    scope: Option<&str>,
    bytes: &mut usize,
    count: &mut usize,
) -> Result<bool, String> {
    // Streaming join: no whole-catalog URL vector and no per-row SQL lookup.
    let statement = if scope.is_some() {
        "SELECT c.id,s.allow_http,s.content_kind,s.media_mime,u.ordinal,u.url FROM channel c JOIN source s ON s.id=c.source_id LEFT JOIN channel_url u ON u.channel_id=c.id WHERE c.id=?1 ORDER BY u.ordinal"
    } else {
        "SELECT c.id,s.allow_http,s.content_kind,s.media_mime,u.ordinal,u.url FROM channel c JOIN source s ON s.id=c.source_id LEFT JOIN channel_url u ON u.channel_id=c.id ORDER BY c.id,u.ordinal"
    };
    let mut read = sql(tx.prepare(statement))?;
    let mut rows = match scope {
        Some(id) => sql(read.query([id]))?,
        None => sql(read.query([]))?,
    };
    let mut write = sql(tx.prepare("INSERT INTO catalog_endpoint_projection_v1 VALUES(?1,?2) ON CONFLICT(channel_id) DO UPDATE SET endpoint_key=excluded.endpoint_key WHERE endpoint_key<>excluded.endpoint_key"))?;
    let mut current: Option<String> = None;
    let mut hash = Sha256::new();
    let mut url_count = 0i64;
    let mut changed = false;
    while let Some(row) = sql(rows.next())? {
        let id: String = sql(row.get(0))?;
        if current.as_deref() != Some(&id) {
            if let Some(previous) = current.take() {
                if url_count == 0 {
                    return Err("catalog-endpoint-invalid".into());
                }
                changed |= sql(write.execute(params![previous, hash.finalize().to_vec()]))? > 0;
            }
            *count += 1;
            if *count > 100_000 || id.is_empty() || id.len() > 16_384 {
                return Err("catalog-endpoint-limit".into());
            }
            hash = Sha256::new();
            field(&mut hash, Some(POLICY));
            let allow_http: i64 = sql(row.get(1))?;
            if !(0..=1).contains(&allow_http) {
                return Err("catalog-endpoint-invalid".into());
            }
            hash.update([allow_http as u8]);
            let content_kind: Option<String> = sql(row.get(2))?;
            let media_mime: Option<String> = sql(row.get(3))?;
            if [content_kind.as_ref(), media_mime.as_ref()]
                .into_iter()
                .flatten()
                .any(|s| s.len() > 128)
            {
                return Err("catalog-endpoint-invalid".into());
            }
            // A catalog MIME describes the imported list, not this channel's
            // playback endpoint. Legacy uninspected lists have neither label.
            // Keep explicit direct-media policies and HTTP grants distinct.
            if content_kind.as_deref() == Some("catalog") {
                field(&mut hash, None);
                field(&mut hash, None);
            } else {
                field(&mut hash, content_kind.as_deref());
                field(&mut hash, media_mime.as_deref());
            }
            current = Some(id);
            url_count = 0;
        }
        let ordinal: Option<i64> = sql(row.get(4))?;
        let url: Option<String> = sql(row.get(5))?;
        if let Some(url) = url {
            if url_count >= 16 || ordinal != Some(url_count) || url.is_empty() || url.len() > 16_384
            {
                return Err("catalog-endpoint-invalid".into());
            }
            *bytes = bytes
                .checked_add(url.len())
                .ok_or("catalog-endpoint-limit")?;
            if *bytes > 20 * 1024 * 1024 {
                return Err("catalog-endpoint-limit".into());
            }
            field(&mut hash, Some(&url));
            url_count += 1;
        }
    }
    if let Some(id) = current {
        if url_count == 0 {
            return Err("catalog-endpoint-invalid".into());
        }
        changed |= sql(write.execute(params![id, hash.finalize().to_vec()]))? > 0;
    }
    Ok(changed)
}
pub fn rebuild(tx: &Transaction<'_>) -> Result<bool, String> {
    let deleted = sql(tx.execute("DELETE FROM catalog_endpoint_projection_v1 WHERE channel_id NOT IN(SELECT id FROM channel)", []))? > 0;
    Ok(collect(tx, None, &mut 0, &mut 0)? || deleted)
}
/// Compact ACK changes only supplied identities; transaction rollback handles failure.
pub fn reconcile(tx: &Transaction<'_>, ids: &[String]) -> Result<bool, String> {
    let mut seen = HashSet::new();
    if ids.len() > 64
        || ids
            .iter()
            .any(|id| id.is_empty() || id.len() > 16_384 || !seen.insert(id))
    {
        return Err("catalog-endpoint-invalid-scope".into());
    }
    let mut bytes = 0;
    let mut count = 0;
    let mut changed = false;
    for id in ids {
        changed |= sql(tx.execute("DELETE FROM catalog_endpoint_projection_v1 WHERE channel_id=?1 AND NOT EXISTS(SELECT 1 FROM channel WHERE id=?1)", [id]))? > 0;
        changed |= collect(tx, Some(id), &mut bytes, &mut count)?;
    }
    Ok(changed)
}
/// Live user choices partition endpoint groups. Source metadata remains aliases.
/// All reads use the caller's same SQLite snapshot. ROW_NUMBER is bounded by the
/// admitted 100k canonical rows, avoiding quadratic pairwise conflict scans.
pub const MEMBERS_CTE: &str = "WITH endpoint_members AS MATERIALIZED(SELECT e.channel_id,e.endpoint_key,c.ordinal,EXISTS(SELECT 1 FROM favorite f WHERE f.id=c.id) AS preferred,(SELECT o.category FROM channel_category_override o WHERE o.channel_id=c.id) AS custom_category,(SELECT m.guide_source_id FROM guide_mapping m WHERE m.app_channel_id=c.id AND m.catalog_source_id=c.source_id) AS guide_source,(SELECT m.xmltv_channel_id FROM guide_mapping m WHERE m.app_channel_id=c.id AND m.catalog_source_id=c.source_id) AS guide_channel,ROW_NUMBER() OVER(PARTITION BY e.endpoint_key,EXISTS(SELECT 1 FROM favorite f WHERE f.id=c.id),(SELECT o.category FROM channel_category_override o WHERE o.channel_id=c.id),(SELECT m.guide_source_id FROM guide_mapping m WHERE m.app_channel_id=c.id AND m.catalog_source_id=c.source_id),(SELECT m.xmltv_channel_id FROM guide_mapping m WHERE m.app_channel_id=c.id AND m.catalog_source_id=c.source_id) ORDER BY c.ordinal,c.id) AS position FROM catalog_endpoint_projection_v1 e JOIN channel c ON c.id=e.channel_id WHERE NOT EXISTS(SELECT 1 FROM removed r WHERE r.id=c.id)) ";
pub const SAME_GROUP: &str = "am.endpoint_key=em.endpoint_key AND am.preferred=em.preferred AND am.custom_category IS em.custom_category AND am.guide_source IS em.guide_source AND am.guide_channel IS em.guide_channel";
/// Bounded opaque identities only; never exposes endpoint keys or stream URLs.
/// Callers must separately retain source grants and current mutation fences.
pub fn members(
    c: &Connection,
    id: &str,
    after: Option<&str>,
    limit: usize,
) -> Result<Vec<String>, String> {
    if id.is_empty()
        || id.len() > 16_384
        || !(1..=64).contains(&limit)
        || after.is_some_and(|s| s.len() > 16_384)
    {
        return Err("catalog-endpoint-invalid-scope".into());
    }
    let query = format!("{MEMBERS_CTE} SELECT am.channel_id FROM endpoint_members em JOIN endpoint_members am ON {SAME_GROUP} WHERE em.channel_id=?1 AND (?2 IS NULL OR am.channel_id>?2) ORDER BY am.channel_id LIMIT ?3");
    let mut statement = sql(c.prepare(&query))?;
    let rows = sql(statement.query_map(params![id, after, limit as i64], |r| r.get(0)))?;
    sql(rows.collect())
}
pub fn representative(c: &Connection, id: &str) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension;
    if id.is_empty() || id.len() > 16_384 {
        return Err("catalog-endpoint-invalid-scope".into());
    }
    let query = format!("{MEMBERS_CTE} SELECT em.channel_id FROM endpoint_members am JOIN endpoint_members em ON {SAME_GROUP} WHERE am.channel_id=?1 AND em.position=1");
    sql(c.query_row(&query, [id], |r| r.get(0)).optional())
}
