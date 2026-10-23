//! Bounded automatic-scan transport. Canonical expansion stays inside SQLite ownership.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
const LIMIT: usize = 20 * 1024 * 1024;
const ERR: &str = "scan-batch-invalid";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Patch {
    pub schema_version: u8,
    pub base_source_count: u32,
    pub base_channel_count: u32,
    pub final_source_count: u32,
    pub final_channel_count: u32,
    pub sources: Vec<Value>,
    pub channels: Vec<Value>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Batch {
    pub schema_version: u8,
    pub catalog_patch: Patch,
    pub authorized_sources: Vec<Value>,
    pub next_preferences: Value,
    pub incoming_health: Vec<Value>,
    pub expected_catalog_revision: String,
    pub expected_health_revision: String,
    pub scan_checkpoint: Option<crate::scan_checkpoint::Mutation>,
    pub expected_checkpoint_revision: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Revisions {
    pub schema_version: u8,
    pub catalog_revision: String,
    pub health_revision: String,
}
struct Bound(usize);
impl std::io::Write for Bound {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > LIMIT.saturating_sub(self.0) {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        self.0 += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn bounded(value: &impl Serialize) -> Result<(), String> {
    serde_json::to_writer(&mut Bound(0), value).map_err(|_| "scan-batch-too-large".into())
}
pub(crate) fn validate_envelope(batch: &Batch) -> Result<(i64, i64), String> {
    let p = &batch.catalog_patch;
    if batch.schema_version != 1
        || p.schema_version != 1
        || p.sources.len() > 100
        || p.channels.len() > 64
        || batch.authorized_sources.len() > 100
        || batch.incoming_health.len() > 64
        || p.base_source_count > 100
        || p.final_source_count > 100
        || p.base_channel_count > 100_000
        || p.final_channel_count > 100_000
        || p.final_source_count < p.base_source_count
        || p.final_channel_count < p.base_channel_count
        || batch.scan_checkpoint.is_some() != batch.expected_checkpoint_revision.is_some()
    {
        return Err(ERR.into());
    }
    bounded(p)?;
    bounded(&batch.authorized_sources)?;
    bounded(&batch.next_preferences)?;
    bounded(&batch.incoming_health)?;
    if let Some(mutation) = &batch.scan_checkpoint {
        match mutation {
            crate::scan_checkpoint::Mutation::Save { checkpoint } if checkpoint.len() > LIMIT => {
                return Err("scan-checkpoint-too-large".into())
            }
            crate::scan_checkpoint::Mutation::Advance { .. } => bounded(mutation)?,
            _ => (),
        }
    }
    if let Some(revision) = &batch.expected_checkpoint_revision {
        crate::scan_checkpoint::revision(revision)?;
    }
    Ok((
        crate::scan_checkpoint::revision(&batch.expected_catalog_revision)?,
        crate::scan_checkpoint::revision(&batch.expected_health_revision)?,
    ))
}
fn id(value: &Value) -> Result<&str, String> {
    value["id"].as_str().ok_or_else(|| ERR.into())
}
fn rows<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    value[key].as_array().ok_or_else(|| ERR.into())
}
fn strict(value: &Value, fields: &[&str]) -> Result<(), String> {
    if value
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !fields.contains(&k.as_str())))
    {
        return Err(ERR.into());
    }
    Ok(())
}
fn strict_source(source: &Value) -> Result<(), String> {
    strict(
        source,
        &[
            "id",
            "name",
            "kind",
            "location",
            "allowHttp",
            "contentKind",
            "mediaMime",
        ],
    )
}
fn same_source(left: &Value, right: &Value) -> bool {
    [left, right]
        .iter()
        .all(|source| source.get("allowHttp").is_none_or(Value::is_boolean))
        && left["allowHttp"].as_bool().unwrap_or(false)
            == right["allowHttp"].as_bool().unwrap_or(false)
        && ["id", "name", "kind", "location", "contentKind", "mediaMime"]
            .iter()
            .all(|key| left.get(key) == right.get(key))
}
/// Existing ordinals survive; changed IDs replace in place, new IDs append.
pub(crate) fn expand(
    batch: &Batch,
    old: &Value,
    check: impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    expand_chunks(
        &[&batch.catalog_patch],
        &batch.authorized_sources,
        &batch.next_preferences,
        old,
        check,
    )
}
/// Ordered tentative patches share one private catalog clone/index. No ACK or SQL.
pub(crate) fn expand_chunks(
    patches: &[&Patch],
    authorized_sources: &[Value],
    next_preferences: &Value,
    old: &Value,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    let p = patches.first().ok_or(ERR)?;
    let old_sources = rows(old, "sources")?;
    let old_channels = rows(old, "channels")?;
    if old_sources.len() != p.base_source_count as usize
        || old_channels.len() != p.base_channel_count as usize
    {
        return Err("scan-batch-base-stale".into());
    }
    let mut allowed = HashMap::new();
    for source in authorized_sources {
        check()?;
        strict_source(source)?;
        if allowed.insert(id(source)?, source).is_some() {
            return Err(ERR.into());
        }
    }
    // The captured authorization must agree with the canonical preferences
    // being atomically saved; it cannot grant a source absent from this scope.
    let prefs_sources = rows(next_preferences, "sources")?;
    let mut pref_index = HashMap::new();
    for source in prefs_sources {
        check()?;
        strict_source(source)?;
        if pref_index.insert(id(source)?, source).is_some() {
            return Err(ERR.into());
        }
    }
    for (key, source) in &allowed {
        if !pref_index
            .get(key)
            .is_some_and(|saved| same_source(saved, source))
        {
            return Err("scan-batch-source-refused".into());
        }
    }
    let mut sources = old_sources.clone();
    let mut source_index = HashMap::new();
    for (index, source) in sources.iter().enumerate() {
        check()?;
        if source_index.insert(id(source)?.to_owned(), index).is_some() {
            return Err(ERR.into());
        }
    }
    let mut channels = old_channels.clone();
    let mut channel_index = HashMap::new();
    for (index, channel) in channels.iter().enumerate() {
        check()?;
        if channel_index
            .insert(id(channel)?.to_owned(), index)
            .is_some()
        {
            return Err(ERR.into());
        }
    }
    for p in patches {
        check()?;
        if sources.len() != p.base_source_count as usize
            || channels.len() != p.base_channel_count as usize
        {
            return Err("scan-batch-base-stale".into());
        }
        let mut changed = HashSet::new();
        for source in &p.sources {
            check()?;
            strict_source(source)?;
            let key = id(source)?;
            if !changed.insert(key)
                || !allowed
                    .get(key)
                    .is_some_and(|saved| same_source(saved, source))
            {
                return Err("scan-batch-source-refused".into());
            }
            if let Some(index) = source_index.get(key) {
                sources[*index] = source.clone();
            } else {
                source_index.insert(key.into(), sources.len());
                sources.push(source.clone());
            }
        }
        let mut changed = HashSet::new();
        for channel in &p.channels {
            check()?;
            strict(
                channel,
                &[
                    "id",
                    "sourceId",
                    "providerId",
                    "name",
                    "category",
                    "urls",
                    "geography",
                    "geographyProvenance",
                ],
            )?;
            let key = id(channel)?;
            let source_id = channel["sourceId"].as_str().ok_or(ERR)?;
            let source = source_index.get(source_id).map(|index| &sources[*index]);
            if !changed.insert(key)
                || !allowed
                    .get(source_id)
                    .zip(source)
                    .is_some_and(|(allowed, source)| same_source(allowed, source))
            {
                return Err("scan-batch-source-refused".into());
            }
            if let Some(index) = channel_index.get(key) {
                if channels[*index]["sourceId"] != source_id {
                    return Err("scan-batch-source-refused".into());
                }
                channels[*index] = channel.clone();
            } else {
                channel_index.insert(key.into(), channels.len());
                channels.push(channel.clone());
            }
        }
        if sources.len() != p.final_source_count as usize
            || channels.len() != p.final_channel_count as usize
        {
            return Err(ERR.into());
        }
    }
    if prefs_sources.len() != sources.len()
        || !prefs_sources
            .iter()
            .zip(&sources)
            .all(|(pref, source)| same_source(pref, source))
    {
        return Err("scan-batch-source-refused".into());
    }
    // SQLite omits an explicit false grant on read. Preserve the validated
    // caller's equivalent representation without changing grant authority.
    sources.clone_from(prefs_sources);
    let catalog = json!({"schemaVersion":1,"sources":sources,"channels":channels});
    bounded(&catalog)?;
    Ok(catalog)
}
