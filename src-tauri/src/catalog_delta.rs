//! Changed-only canonical writes within the caller-owned validated IMMEDIATE transaction.
use super::sql;
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
fn rows<'a>(value: &'a Value, key: &str) -> Result<&'a [Value], String> {
    value[key]
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| "catalog-invalid".into())
}
fn id(value: &Value) -> Result<&str, String> {
    value["id"].as_str().ok_or_else(|| "catalog-invalid".into())
}
fn text(value: &Value) -> SqlValue {
    value
        .as_str()
        .map(|text| SqlValue::Text(text.into()))
        .unwrap_or(SqlValue::Null)
}
fn source_fields(value: &Value, ordinal: usize) -> Vec<SqlValue> {
    vec![
        text(&value["id"]),
        text(&value["name"]),
        text(&value["location"]),
        text(&value["kind"]),
        SqlValue::Integer(i64::from(value["allowHttp"].as_bool().unwrap_or(false))),
        text(&value["contentKind"]),
        text(&value["mediaMime"]),
        SqlValue::Integer(ordinal as i64),
    ]
}
fn channel_fields(value: &Value, ordinal: usize) -> Result<Vec<SqlValue>, String> {
    let provenance = value
        .get("geographyProvenance")
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| "record-encoding-failed")?
        .map(SqlValue::Text)
        .unwrap_or(SqlValue::Null);
    Ok(vec![
        text(&value["id"]),
        text(&value["sourceId"]),
        text(&value["providerId"]),
        text(&value["name"]),
        text(&value["category"]),
        SqlValue::Integer(ordinal as i64),
        text(&value["geography"]["country"]),
        text(&value["geography"]["region"]),
        text(&value["geography"]["state"]),
        provenance,
    ])
}
/// Modern (schema>=5) canonical delta, on the caller's connection/transaction.
/// No BEGIN/COMMIT, PRAGMA, backup, metadata revision or health/checkpoint writes here.
pub(crate) fn apply(c: &Connection, old: Option<&Value>, new: &Value) -> Result<(), String> {
    let old_sources = old.map(|v| rows(v, "sources")).transpose()?.unwrap_or(&[]);
    let old_channels = old.map(|v| rows(v, "channels")).transpose()?.unwrap_or(&[]);
    let obsolete_source_ids: Vec<String> = if old.is_some() {
        old_sources
            .iter()
            .map(|v| id(v).map(str::to_owned))
            .collect::<Result<_, _>>()?
    } else {
        // A preferences-only store may already contain source rows without a catalog.
        let mut statement = sql(c.prepare("SELECT id FROM source"))?;
        let ids = sql(statement.query_map([], |r| r.get::<_, String>(0)))?;
        sql(ids.collect())?
    };
    let sources = rows(new, "sources")?;
    let channels = rows(new, "channels")?;
    let old_channel_index: HashMap<&str, (usize, &Value)> = old_channels
        .iter()
        .enumerate()
        .map(|(i, v)| Ok((id(v)?, (i, v))))
        .collect::<Result<_, String>>()?;
    let new_source_ids: HashSet<&str> = sources.iter().map(id).collect::<Result<_, _>>()?;
    let new_channel_ids: HashSet<&str> = channels.iter().map(id).collect::<Result<_, _>>()?;
    write_sources(c, old_sources, sources)?;
    write_channels(
        c,
        channels
            .iter()
            .enumerate()
            .map(|(ordinal, channel)| ChannelChange {
                ordinal,
                channel,
                previous: channel["id"]
                    .as_str()
                    .and_then(|key| old_channel_index.get(key))
                    .copied(),
            }),
        &mut |_| {},
    )?;
    // Move surviving channels first, then remove obsolete children and parents.
    for v in old_channels {
        if !new_channel_ids.contains(id(v)?) {
            sql(c.execute("DELETE FROM channel WHERE id=?1", params![id(v)?]))?;
        }
    }
    for key in obsolete_source_ids {
        if !new_source_ids.contains(key.as_str()) {
            sql(c.execute("DELETE FROM source WHERE id=?1", params![key]))?;
        }
    }
    Ok(())
}

fn write_sources(c: &Connection, old: &[Value], sources: &[Value]) -> Result<(), String> {
    let old_index: HashMap<&str, (usize, &Value)> = old
        .iter()
        .enumerate()
        .map(|(i, v)| Ok((id(v)?, (i, v))))
        .collect::<Result<_, String>>()?;
    let mut source_upsert = sql(c.prepare("INSERT INTO source(id,name,location,kind,allow_http,content_kind,media_mime,ordinal) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET name=excluded.name,location=excluded.location,kind=excluded.kind,allow_http=excluded.allow_http,content_kind=excluded.content_kind,media_mime=excluded.media_mime,ordinal=excluded.ordinal"))?;
    for (i, v) in sources.iter().enumerate() {
        let fields = source_fields(v, i);
        if old_index
            .get(id(v)?)
            .is_none_or(|(j, old)| source_fields(old, *j) != fields)
        {
            sql(source_upsert.execute(params_from_iter(fields)))?;
        }
    }
    Ok(())
}
struct ChannelChange<'a> {
    ordinal: usize,
    channel: &'a Value,
    previous: Option<(usize, &'a Value)>,
}
fn write_channels<'a>(
    c: &Connection,
    changes: impl IntoIterator<Item = ChannelChange<'a>>,
    visit: &mut impl FnMut(&str),
) -> Result<(), String> {
    let mut channel_upsert = sql(c.prepare("INSERT INTO channel(id,source_id,provider_id,name,category,ordinal,country,region,state,geography_provenance) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,provider_id=excluded.provider_id,name=excluded.name,category=excluded.category,ordinal=excluded.ordinal,country=excluded.country,region=excluded.region,state=excluded.state,geography_provenance=excluded.geography_provenance"))?;
    let mut url_insert =
        sql(c.prepare("INSERT INTO channel_url(channel_id,ordinal,url) VALUES(?1,?2,?3)"))?;
    for change in changes {
        let (i, v, previous) = (change.ordinal, change.channel, change.previous);
        let key = id(v)?;
        visit(key);
        let fields = channel_fields(v, i)?;
        let unchanged = previous
            .map(|(j, old)| channel_fields(old, j))
            .transpose()?
            == Some(fields.clone());
        if !unchanged {
            sql(channel_upsert.execute(params_from_iter(fields)))?;
        }
        let old_urls = previous
            .map(|(_, old)| rows(old, "urls"))
            .transpose()?
            .unwrap_or(&[]);
        let new_urls = rows(v, "urls")?;
        // Delete changed positions first: URL swaps must not violate UNIQUE(channel_id,url).
        for (ordinal, url) in old_urls.iter().enumerate() {
            if new_urls.get(ordinal) != Some(url) {
                sql(c.execute(
                    "DELETE FROM channel_url WHERE channel_id=?1 AND ordinal=?2",
                    params![key, ordinal as i64],
                ))?;
            }
        }
        for (ordinal, url) in new_urls.iter().enumerate() {
            if old_urls.get(ordinal) != Some(url) {
                sql(url_insert.execute(params![key, ordinal as i64, url.as_str()]))?;
            }
        }
    }
    Ok(())
}
/// This is private to the canonical store module, never a wire/caller-supplied
/// bypass. The caller derives ALL identities from an admitted compact patch.
/// Check unchanged identity/ordinal/metadata before any DML as defense in depth.
pub(super) fn apply_compact(
    c: &Connection,
    old: Option<&Value>,
    new: &Value,
    ids: &[String],
) -> Result<(), String> {
    apply_compact_observed(c, old, new, ids, &mut |_| {})
}
fn apply_compact_observed(
    c: &Connection,
    old: Option<&Value>,
    new: &Value,
    ids: &[String],
    visit: &mut impl FnMut(&str),
) -> Result<(), String> {
    if ids.len() > 64 {
        return Err("catalog-compact-scope-invalid".into());
    }
    apply_scope(c, old, new, ids, visit)
}
/// Exact internal admitted chunk groups; the legacy entry remains limited64.
pub(super) fn apply_groups(
    c: &Connection,
    old: Option<&Value>,
    new: &Value,
    groups: &[Vec<String>],
) -> Result<(), String> {
    if groups.is_empty() || groups.len() > 4 || groups.iter().any(|g| g.len() > 64) {
        return Err("catalog-compact-scope-invalid".into());
    }
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for group in groups {
        let mut unique = HashSet::new();
        for id in group {
            if !unique.insert(id) {
                return Err("catalog-compact-scope-invalid".into());
            }
            if seen.insert(id) {
                ids.push(id.clone());
            }
        }
    }
    apply_scope(c, old, new, &ids, &mut |_| {})
}
fn apply_scope(
    c: &Connection,
    old: Option<&Value>,
    new: &Value,
    ids: &[String],
    visit: &mut impl FnMut(&str),
) -> Result<(), String> {
    const ERR: &str = "catalog-compact-scope-invalid";
    if ids.len() > 256 {
        return Err(ERR.into());
    }
    let scope: HashSet<&str> = ids.iter().map(String::as_str).collect();
    if scope.len() != ids.len() {
        return Err(ERR.into());
    }
    let old_sources = old
        .map(|value| rows(value, "sources"))
        .transpose()?
        .unwrap_or(&[]);
    let sources = rows(new, "sources")?;
    let old_channels = old
        .map(|value| rows(value, "channels"))
        .transpose()?
        .unwrap_or(&[]);
    let channels = rows(new, "channels")?;
    if sources.len() < old_sources.len()
        || channels.len() < old_channels.len()
        || sources.len() > 100
        || channels.len() > 100_000
    {
        return Err(ERR.into());
    }
    for (prior, next) in old_sources.iter().zip(sources) {
        if id(prior)? != id(next)? {
            return Err(ERR.into());
        }
    }
    let mut changes = Vec::with_capacity(ids.len());
    let mut found = HashSet::new();
    for (ordinal, channel) in channels.iter().enumerate() {
        let key = id(channel)?;
        let previous = old_channels.get(ordinal);
        if let Some(prior) = previous {
            if id(prior)? != key {
                return Err(ERR.into());
            }
        }
        if scope.contains(key) {
            if !found.insert(key) {
                return Err(ERR.into());
            }
            changes.push(ChannelChange {
                ordinal,
                channel,
                previous: previous.map(|v| (ordinal, v)),
            });
        } else if previous != Some(channel) {
            return Err(ERR.into());
        }
    }
    if found.len() != scope.len() {
        return Err(ERR.into());
    }
    if old.is_none() {
        // A preferences-only store may contain source rows requiring ordinary
        // full-path cleanup; do not omit that existing semantic behavior.
        return apply(c, None, new);
    }
    write_sources(c, old_sources, sources)?;
    write_channels(c, changes, visit)
}
#[cfg(test)]
#[path = "catalog_delta_compact_tests.rs"]
mod compact_tests;
