//! Exact-channel user categories. Canonical provider metadata and identity remain unchanged.
use super::sql;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
const LIMIT: usize = 20 * 1024 * 1024;
fn fail() -> String {
    "record-invalid-category-override".into()
}
fn field<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str, String> {
    let text = v[key].as_str().ok_or_else(fail)?;
    if text.trim().is_empty()
        || text.len() > max
        || text.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}')
    {
        return Err(fail());
    }
    Ok(text)
}
pub(super) fn validate(raw: Option<&Value>) -> Result<Vec<Value>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let rows = raw.as_array().ok_or_else(fail)?;
    if rows.len() > 100000 {
        return Err("record-category-override-limit".into());
    }
    let mut ids = HashSet::new();
    let mut bytes = 2;
    for (index, row) in rows.iter().enumerate() {
        if row
            .as_object()
            .ok_or_else(fail)?
            .keys()
            .any(|key| !matches!(key.as_str(), "channelId" | "category"))
        {
            return Err(fail());
        }
        let id = field(row, "channelId", 16384)?;
        let category = field(row, "category", 512)?;
        if category.trim() != category || !ids.insert(id) {
            return Err(fail());
        }
        bytes += serde_json::to_vec(row)
            .map_err(|_| "record-encoding-failed")?
            .len()
            + usize::from(index != 0);
        if bytes > LIMIT {
            return Err("record-category-override-limit".into());
        }
    }
    Ok(rows.clone())
}
/// Capture bounded raw columns; finish_pair performs pure validation after the read transaction.
pub(super) fn capture(c: &Connection) -> Result<Vec<Value>, String> {
    let mut statement = sql(c.prepare(
        "SELECT channel_id,category,ordinal FROM channel_category_override ORDER BY ordinal",
    ))?;
    let mut rows = sql(statement.query([]))?;
    let mut out = Vec::new();
    let mut bytes = 2;
    while let Some(row) = sql(rows.next())? {
        let id: String = sql(row.get(0))?;
        let category: String = sql(row.get(1))?;
        let ordinal: i64 = sql(row.get(2))?;
        if out.len() >= 100000
            || ordinal != out.len() as i64
            || id.len() > 16384
            || category.len() > 512
        {
            return Err(fail());
        }
        bytes += id.len() + category.len() + 32;
        if bytes > LIMIT {
            return Err("record-category-override-limit".into());
        }
        out.push(json!({"channelId":id,"category":category}));
    }
    Ok(out)
}
pub(super) fn semantic(c: &Connection) -> Result<BTreeMap<String, String>, String> {
    capture(c)?
        .into_iter()
        .map(|row| {
            Ok((
                field(&row, "channelId", 16384)?.to_owned(),
                field(&row, "category", 512)?.to_owned(),
            ))
        })
        .collect()
}
pub(super) fn replace(c: &Connection, raw: Option<&Value>) -> Result<(), String> {
    let new = validate(raw)?;
    let old = capture(c)?;
    let old_index: HashMap<&str, (usize, &Value)> = old
        .iter()
        .enumerate()
        .map(|(i, row)| Ok((field(row, "channelId", 16384)?, (i, row))))
        .collect::<Result<_, String>>()?;
    let ids: HashSet<&str> = new
        .iter()
        .map(|row| field(row, "channelId", 16384))
        .collect::<Result<_, _>>()?;
    for (ordinal, row) in new.iter().enumerate() {
        let id = field(row, "channelId", 16384)?;
        let category = field(row, "category", 512)?;
        if old_index.get(id).is_none_or(|(previous, old)| {
            *previous != ordinal || old["category"] != row["category"]
        }) {
            sql(c.execute("INSERT INTO channel_category_override(channel_id,category,ordinal) VALUES(?1,?2,?3) ON CONFLICT(channel_id) DO UPDATE SET category=excluded.category,ordinal=excluded.ordinal",params![id,category,ordinal as i64]))?;
        }
    }
    for row in &old {
        let id = field(row, "channelId", 16384)?;
        if !ids.contains(id) {
            sql(c.execute(
                "DELETE FROM channel_category_override WHERE channel_id=?1",
                params![id],
            ))?;
        }
    }
    Ok(())
}
