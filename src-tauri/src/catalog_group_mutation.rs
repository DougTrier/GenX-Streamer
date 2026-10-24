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

//! Explicit edits to one currently displayed exact-endpoint group.
//! The caller owns backup, the writer transaction, full canonical validation,
//! cancellation/root fencing and the final COMMIT acknowledgment.
use rusqlite::{params, Connection, Transaction};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub schema_version: u32,
    pub request_id: String,
    pub channel_id: String,
    pub expected_catalog_revision: String,
    pub expected_view_revision: String,
    pub action: Action,
    /// Batch removal (owner design, October 21, 2026): more channels removed
    /// with `channel_id` in the same transaction, each with its group. Remove
    /// only; a channel already gone is skipped.
    #[serde(default)]
    pub more_channel_ids: Vec<String>,
}
pub const BATCH_LIMIT: usize = 5_000;
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Action {
    Remove,
    Favorite {
        value: bool,
    },
    Category {
        #[serde(deserialize_with = "category_value")]
        value: Option<String>,
    },
}
fn category_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}
/// Deliberately not serializable: only the caller's successful COMMIT permits a
/// committed receipt. An error requires rolling back the entire transaction.
pub struct PendingReceipt {
    pub catalog_revision: String,
    pub view_revision: String,
    pub affected_count: usize,
    pub changed: bool,
}
fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| crate::storage_transaction::sql_error_code(&e, "catalog-group-database-failed"))
}
fn revision(text: &str) -> Result<i64, String> {
    if text.is_empty()
        || text.len() > 19
        || !text.bytes().all(|b| b.is_ascii_digit())
        || (text.len() > 1 && text.starts_with('0'))
    {
        return Err("catalog-group-invalid-revision".into());
    }
    text.parse()
        .map_err(|_| "catalog-group-invalid-revision".into())
}
fn identity(text: &str, max: usize) -> bool {
    !text.is_empty() && text.len() <= max && !text.chars().any(char::is_control)
}
struct Temp<'a> {
    connection: &'a Connection,
    members: bool,
    order: bool,
}
impl Drop for Temp<'_> {
    fn drop(&mut self) {
        // Main transaction rollback also rolls back owned TEMP DDL if an error
        // prevents explicit cleanup. Never touch another operation's table.
        if self.order {
            let _ = self
                .connection
                .execute_batch("DROP TABLE IF EXISTS temp.catalog_group_order_v1;");
        }
        if self.members {
            let _ = self
                .connection
                .execute_batch("DROP TABLE IF EXISTS temp.catalog_group_members_v1;");
        }
    }
}
fn count(c: &Connection, table: &str) -> Result<i64, String> {
    let n: i64 = sql(c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)))?;
    if !(0..=100_000).contains(&n) {
        return Err("catalog-group-preference-limit".into());
    }
    Ok(n)
}
fn resequence(c: &Connection, table: &str, id: &str) -> Result<(), String> {
    sql(c.execute("DELETE FROM temp.catalog_group_order_v1", []))?;
    sql(c.execute(&format!("INSERT INTO temp.catalog_group_order_v1 SELECT {id},ROW_NUMBER() OVER(ORDER BY ordinal,{id})-1 FROM {table}"), []))?;
    sql(c.execute(&format!("UPDATE {table} SET ordinal=o.ordinal FROM temp.catalog_group_order_v1 o WHERE {table}.{id}=o.id AND {table}.ordinal<>o.ordinal"), []))?;
    Ok(())
}
/// Must execute under the caller's real IMMEDIATE writer transaction. Capture
/// the compatible visible membership once before editing any partition field.
/// The caller MUST validate the reconstructed canonical preferences (20MiB),
/// check actual ownership again, and COMMIT before returning a success receipt.
pub fn apply(
    tx: &Transaction<'_>,
    request: &Request,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<PendingReceipt, String> {
    check()?;
    if request.schema_version != 1
        || !identity(&request.request_id, 256)
        || !identity(&request.channel_id, 16_384)
        || request.more_channel_ids.len() > BATCH_LIMIT
        || request
            .more_channel_ids
            .iter()
            .any(|id| !identity(id, 16_384))
        || (!request.more_channel_ids.is_empty() && !matches!(request.action, Action::Remove))
    {
        return Err("catalog-group-invalid".into());
    }
    if let Action::Category { value: Some(value) } = &request.action {
        if value.trim().is_empty()
            || value.trim() != value
            || value.len() > 512
            || value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
        {
            return Err("catalog-group-invalid-category".into());
        }
    }
    let expected_catalog = revision(&request.expected_catalog_revision)?;
    let expected_view = revision(&request.expected_view_revision)?;
    let (catalog, view, overall, preferences_present): (i64, i64, i64, bool) = sql(tx.query_row(
        "SELECT m.catalog_revision,p.view_revision,m.revision,m.preferences_present FROM metadata m CROSS JOIN catalog_projection_meta p WHERE m.singleton=1 AND p.singleton=1", [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ))?;
    if catalog != expected_catalog || view != expected_view {
        return Err("catalog-group-revision-stale".into());
    }
    if !preferences_present {
        return Err("catalog-group-preferences-required".into());
    }
    if catalog < 0 || view < 0 || overall < 0 || view == i64::MAX || overall == i64::MAX {
        return Err("storage-revision-exhausted".into());
    }
    if !crate::catalog_endpoint_projection::present(tx)? {
        return Err("catalog-query-projection-stale".into());
    }
    let complete: bool = sql(tx.query_row("SELECT (SELECT count(*) FROM channel)=(SELECT count(*) FROM catalog_endpoint_projection_v1)", [], |r| r.get(0)))?;
    if !complete {
        return Err("catalog-query-projection-stale".into());
    }
    let (canonical_count, canonical_identity_bytes): (i64, i64) = sql(tx.query_row(
        "SELECT count(*),COALESCE(sum(length(CAST(id AS BLOB))),0) FROM channel",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    if !(0..=100_000).contains(&canonical_count)
        || !(0..=20 * 1024 * 1024).contains(&canonical_identity_bytes)
    {
        return Err("catalog-group-preference-limit".into());
    }
    // CREATE (without IF NOT EXISTS) refuses collisions instead of borrowing or
    // deleting a table owned by other native work on this connection.
    sql(tx.execute_batch(
        "CREATE TEMP TABLE catalog_group_members_v1(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL);",
    ))?;
    let mut temp = Temp {
        connection: tx,
        members: true,
        order: false,
    };
    sql(tx.execute_batch(
        "CREATE TEMP TABLE catalog_group_order_v1(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL);",
    ))?;
    temp.order = true;
    let capture = format!("{} INSERT INTO temp.catalog_group_members_v1 SELECT am.channel_id,ROW_NUMBER() OVER(ORDER BY am.ordinal,am.channel_id)-1 FROM endpoint_members em JOIN endpoint_members am ON {} WHERE em.channel_id=?1", crate::catalog_endpoint_projection::MEMBERS_CTE, crate::catalog_endpoint_projection::SAME_GROUP);
    sql(tx.execute(&capture, [&request.channel_id]))?;
    if !request.more_channel_ids.is_empty() {
        // Each further group follows the ones before it; shared members once.
        let more = format!("{} INSERT OR IGNORE INTO temp.catalog_group_members_v1 SELECT am.channel_id,?2+ROW_NUMBER() OVER(ORDER BY am.ordinal,am.channel_id)-1 FROM endpoint_members em JOIN endpoint_members am ON {} WHERE em.channel_id=?1", crate::catalog_endpoint_projection::MEMBERS_CTE, crate::catalog_endpoint_projection::SAME_GROUP);
        let mut statement = sql(tx.prepare(&more))?;
        for id in &request.more_channel_ids {
            check()?;
            let next: i64 = sql(tx.query_row(
                "SELECT COALESCE(max(ordinal)+1,0) FROM temp.catalog_group_members_v1",
                [],
                |r| r.get(0),
            ))?;
            sql(statement.execute(params![id, next]))?;
        }
    }
    let affected_count = count(tx, "temp.catalog_group_members_v1")?;
    if affected_count == 0 {
        return Err("catalog-group-selection-stale".into());
    }
    let identity_bytes: i64 = sql(tx.query_row(
        "SELECT COALESCE(sum(length(CAST(id AS BLOB))),0) FROM temp.catalog_group_members_v1",
        [],
        |r| r.get(0),
    ))?;
    if !(0..=20 * 1024 * 1024).contains(&identity_bytes) {
        return Err("catalog-group-preference-limit".into());
    }
    for table in ["favorite", "removed", "channel_category_override"] {
        count(tx, table)?;
    }
    check()?;
    let changed = match &request.action {
        Action::Remove => {
            let old_count = count(tx, "removed")?;
            let missing: i64 = sql(tx.query_row("SELECT count(*) FROM temp.catalog_group_members_v1 g WHERE NOT EXISTS(SELECT 1 FROM removed r WHERE r.id=g.id)", [], |r| r.get(0)))?;
            if old_count + missing > 100_000 {
                return Err("catalog-group-preference-limit".into());
            }
            let changes = sql(tx.execute("INSERT INTO removed SELECT g.id,?1+ROW_NUMBER() OVER(ORDER BY g.ordinal,g.id)-1 FROM temp.catalog_group_members_v1 g WHERE NOT EXISTS(SELECT 1 FROM removed r WHERE r.id=g.id)", [old_count]))?;
            resequence(tx, "removed", "id")?;
            changes > 0
        }
        Action::Favorite { value: true } => {
            let old_count = count(tx, "favorite")?;
            let missing: i64 = sql(tx.query_row("SELECT count(*) FROM temp.catalog_group_members_v1 g WHERE NOT EXISTS(SELECT 1 FROM favorite f WHERE f.id=g.id)", [], |r| r.get(0)))?;
            if old_count + missing > 100_000 {
                return Err("catalog-group-preference-limit".into());
            }
            let changes = sql(tx.execute("INSERT INTO favorite SELECT g.id,?1+ROW_NUMBER() OVER(ORDER BY g.ordinal,g.id)-1 FROM temp.catalog_group_members_v1 g WHERE NOT EXISTS(SELECT 1 FROM favorite f WHERE f.id=g.id)", [old_count]))?;
            resequence(tx, "favorite", "id")?;
            changes > 0
        }
        Action::Favorite { value: false } => {
            let changes = sql(tx.execute(
                "DELETE FROM favorite WHERE id IN(SELECT id FROM temp.catalog_group_members_v1)",
                [],
            ))?;
            resequence(tx, "favorite", "id")?;
            changes > 0
        }
        Action::Category { value: None } => {
            let changes = sql(tx.execute("DELETE FROM channel_category_override WHERE channel_id IN(SELECT id FROM temp.catalog_group_members_v1)", []))?;
            resequence(tx, "channel_category_override", "channel_id")?;
            changes > 0
        }
        Action::Category { value: Some(value) } => {
            let old_count = count(tx, "channel_category_override")?;
            let missing: i64 = sql(tx.query_row("SELECT count(*) FROM temp.catalog_group_members_v1 g WHERE NOT EXISTS(SELECT 1 FROM channel_category_override o WHERE o.channel_id=g.id)", [], |r| r.get(0)))?;
            if old_count + missing > 100_000 {
                return Err("catalog-group-preference-limit".into());
            }
            let updated = sql(tx.execute("UPDATE channel_category_override SET category=?1 WHERE channel_id IN(SELECT id FROM temp.catalog_group_members_v1) AND category<>?1", [value]))?;
            let inserted = sql(tx.execute("INSERT INTO channel_category_override SELECT g.id,?1,?2+ROW_NUMBER() OVER(ORDER BY g.ordinal,g.id)-1 FROM temp.catalog_group_members_v1 g WHERE NOT EXISTS(SELECT 1 FROM channel_category_override o WHERE o.channel_id=g.id)", params![value, old_count]))?;
            resequence(tx, "channel_category_override", "channel_id")?;
            updated + inserted > 0
        }
    };
    check()?;
    if changed && matches!(&request.action, Action::Category { .. }) {
        // Rewrite only affected search/category postings in bounded batches;
        // all changes remain in this same writer transaction.
        let mut read =
            sql(tx.prepare("SELECT id FROM temp.catalog_group_members_v1 ORDER BY ordinal"))?;
        let mut rows = sql(read.query([]))?;
        let mut batch = Vec::with_capacity(64);
        while let Some(row) = sql(rows.next())? {
            batch.push(sql(row.get::<_, String>(0))?);
            if batch.len() == 64 {
                check()?;
                crate::catalog_query::reconcile_projection(tx, &batch)?;
                batch.clear();
            }
        }
        if !batch.is_empty() {
            check()?;
            crate::catalog_query::reconcile_projection(tx, &batch)?;
        }
    }
    if changed {
        if sql(tx.execute(
            "UPDATE metadata SET revision=revision+1 WHERE singleton=1 AND revision=?1",
            [overall],
        ))? != 1
        {
            return Err("catalog-group-revision-stale".into());
        }
        crate::catalog_query::advance_view_revision(tx, true)?;
    }
    check()?;
    let final_view: i64 = sql(tx.query_row(
        "SELECT view_revision FROM catalog_projection_meta WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    // Explicit cleanup must succeed; Drop is the fallback on every error path.
    sql(tx.execute_batch(
        "DROP TABLE temp.catalog_group_order_v1; DROP TABLE temp.catalog_group_members_v1;",
    ))?;
    temp.order = false;
    temp.members = false;
    drop(temp);
    Ok(PendingReceipt {
        catalog_revision: catalog.to_string(),
        view_revision: final_view.to_string(),
        affected_count: affected_count as usize,
        changed,
    })
}
