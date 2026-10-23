//! Private original-index publication preparation. SQL/Plan authority and COMMIT stay with caller.
//! Only <=64 positively checked, authenticated candidates enter this module; negative checks
//! remain checkpoint observations and never manufacture canonical catalog/health identities.
use crate::scan_batch::Patch;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

const ERR: &str = "scan-resume-reconcile-invalid";
pub(crate) struct Context<'a> {
    pub catalog: &'a Value,
    pub preferences: &'a Value,
    pub source_policies: &'a [Value],
    pub session_revision: &'a str,
    pub platform: &'a str,
    pub observer_profile: &'a str,
}
pub(crate) struct Selected<'a> {
    pub original_index: usize,
    pub candidate: &'a Value,
    pub observation: &'a Value,
}
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Mapping {
    pub original_index: usize,
    pub channel_id: String,
}
pub(crate) struct Prepared {
    pub catalog_patch: Patch,
    pub next_preferences: Value,
    pub incoming_health: Vec<Value>,
    pub mappings: Vec<Mapping>,
}
fn array<'a>(v: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    v[key].as_array().ok_or_else(|| ERR.into())
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key].as_str().ok_or_else(|| ERR.into())
}
fn encoded(v: &Value) -> Result<String, String> {
    serde_json::to_string(v).map_err(|_| ERR.into())
}
fn ecma_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn normalized(s: &str) -> String {
    s.nfkc()
        .collect::<String>()
        .trim_matches(ecma_space)
        .to_lowercase()
}
pub(crate) fn metadata(c: &Value) -> Result<String, String> {
    encoded(&json!([
        c["sourceId"],
        c.get("providerId").unwrap_or(&json!("")),
        normalized(string(c, "name")?),
        normalized(string(c, "category")?)
    ]))
}
pub(crate) fn provider(c: &Value) -> Result<String, String> {
    encoded(&json!([
        c["sourceId"],
        c.get("providerId").unwrap_or(&Value::Null)
    ]))
}
fn base(c: &Value) -> Result<String, String> {
    encoded(&json!([
        c["sourceId"],
        c.get("providerId").unwrap_or(&Value::Null),
        c["name"],
        c["category"],
        c["urls"]
    ]))
}
fn exact(c: &Value) -> Result<String, String> {
    let geo = c
        .get("geography")
        .map(|g| json!([g.get("country"), g.get("region"), g.get("state")]))
        .unwrap_or(Value::Null);
    let provenance = c
        .get("geographyProvenance")
        .map(|p| {
            p.as_array().ok_or(ERR).map(|rows| {
                Value::Array(
                    rows.iter()
                        .map(|p| {
                            json!([
                                p["field"],
                                p["value"],
                                p["sourceId"],
                                p.get("providerId"),
                                p["kind"],
                                p["scope"]
                            ])
                        })
                        .collect(),
                )
            })
        })
        .transpose()?
        .unwrap_or(Value::Null);
    encoded(&json!([
        c["sourceId"],
        c.get("providerId").unwrap_or(&Value::Null),
        c["name"],
        c["category"],
        c["urls"],
        geo,
        provenance
    ]))
}
fn compatible(candidate: &Value, old: &Value) -> bool {
    ["country", "region", "state"].iter().all(|field| {
        candidate["geography"]
            .get(field)
            .is_none_or(|v| old["geography"].get(field) == Some(v))
    }) && candidate
        .get("geographyProvenance")
        .is_none_or(|v| old.get("geographyProvenance") == Some(v))
}
fn component(s: &str) -> String {
    let mut result = String::new();
    for byte in s.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            result.push(byte as char);
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}
fn geography(candidate: &Value, prior: Option<&Value>) -> Value {
    let mut result = candidate.clone();
    let mut geo = prior
        .and_then(|p| p["geography"].as_object())
        .cloned()
        .unwrap_or_default();
    if let Some(g) = candidate["geography"].as_object() {
        geo.extend(g.clone());
    }
    if geo
        .get("state")
        .and_then(Value::as_str)
        .is_some_and(|state| {
            !state.starts_with(&format!(
                "{}-",
                geo.get("country").and_then(Value::as_str).unwrap_or("")
            ))
        })
    {
        geo.remove("state");
    }
    if !geo.is_empty() {
        let mut provenance = Vec::new();
        for field in ["country", "region", "state"] {
            let Some(value) = geo.get(field) else {
                continue;
            };
            let find = |v: &Value| {
                v["geographyProvenance"]
                    .as_array()
                    .and_then(|a| {
                        a.iter()
                            .find(|p| p["field"] == field && &p["value"] == value)
                    })
                    .cloned()
            };
            if let Some(p) = find(candidate).or_else(|| prior.and_then(find)) {
                provenance.push(p);
            }
        }
        result["geography"] = Value::Object(geo);
        if !provenance.is_empty() {
            result["geographyProvenance"] = Value::Array(provenance);
        }
    }
    result
}
fn normalize_source(source: &Value) -> Value {
    let mut source = source.clone();
    if let Some(raw) = source["mediaMime"].as_str() {
        // Source inspection may retain a Content-Type header; same normalization as TS.
        let mime = raw
            .split(';')
            .next()
            .unwrap_or("")
            .trim_matches(ecma_space)
            .to_ascii_lowercase();
        if !raw.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
            && mime.len() <= 128
            && mime.split('/').count() == 2
            && mime.split('/').all(|s| !s.is_empty())
            && mime
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".+-/".contains(&b))
        {
            source["mediaMime"] = json!(mime);
        }
    }
    source
}

/// The context is a canonical SQL snapshot. The rows and ambiguity callback must come from
/// the same admitted Plan/manifest; this is not a public client-controlled reconciliation API.
pub(crate) fn prepare(
    context: Context<'_>,
    selected: &[Selected<'_>],
    ambiguous: &impl Fn(&Value) -> Result<(bool, bool), String>,
    create_id: &mut impl FnMut() -> String,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<Prepared, String> {
    check()?;
    let old_sources = array(context.catalog, "sources")?;
    let old_channels = array(context.catalog, "channels")?;
    if selected.is_empty()
        || selected.len() > 64
        || context.source_policies.len() > 100
        || old_sources.len() > 100
        || old_channels.len() > 100_000
    {
        return Err(ERR.into());
    }
    let mut policies = HashMap::new();
    for p in context.source_policies {
        let source = p.get("source").ok_or(ERR)?;
        let id = string(source, "id")?;
        if string(p, "capturedFingerprint")?.is_empty()
            || string(p, "definitionFingerprint")?.len() != 64
            || policies.insert(id, p).is_some()
        {
            return Err(ERR.into());
        }
    }
    let mut indices = HashSet::new();
    let mut keys = HashSet::new();
    for row in selected {
        check()?;
        let c = row.candidate;
        let o = row.observation;
        let policy = policies.get(string(c, "sourceId")?).ok_or(ERR)?;
        if row.original_index >= 100_000
            || !indices.insert(row.original_index)
            || !keys.insert(string(c, "key")?)
            || c["sourceId"] != c["channel"]["sourceId"]
            || c["sourceFingerprint"] != policy["capturedFingerprint"]
            || c["sessionRevision"] != context.session_revision
            || o["channelId"] != c["key"]
            || o["sourceId"] != c["sourceId"]
            || o["fingerprint"] != c["sourceFingerprint"]
            || o["platform"] != context.platform
            || !matches!(o["verdict"].as_str(), Some("Reachable" | "PlayedHere"))
        {
            return Err(ERR.into());
        }
    }
    let mut updates: HashMap<String, Value> = HashMap::new();
    let mut appended = Vec::new();
    let mut sources = old_sources.clone();
    let old_ids: HashMap<_, _> = old_channels
        .iter()
        .map(|c| Ok((string(c, "id")?.to_owned(), c)))
        .collect::<Result<_, String>>()?;
    if old_ids.len() != old_channels.len() {
        return Err(ERR.into());
    }
    let mut health_by_index = HashMap::new();
    let mut mappings = Vec::new();
    for policy in context.source_policies {
        let source = normalize_source(policy.get("source").ok_or(ERR)?);
        let sid = string(&source, "id")?;
        let group: Vec<_> = selected
            .iter()
            .filter(|s| s.candidate["sourceId"] == sid)
            .collect();
        if group.is_empty() {
            continue;
        }
        let mut mini: Vec<_> = group
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let mut c = s.candidate["channel"].clone();
                c["id"] = json!(format!("admission-{i}"));
                c
            })
            .collect();
        crate::storage_transaction::validate_checkpoint_catalog(
            &json!({"schemaVersion":1,"sources":[source],"channels":mini}),
        )?;
        mini.clear();
        let previous: Vec<_> = old_channels
            .iter()
            .filter(|c| c["sourceId"] == sid)
            .collect();
        let mut old_exact: HashMap<String, Vec<&Value>> = HashMap::new();
        let mut old_base: HashMap<String, Vec<&Value>> = HashMap::new();
        let mut old_meta: HashMap<String, Vec<&Value>> = HashMap::new();
        let mut old_provider: HashMap<String, Vec<&Value>> = HashMap::new();
        for (i, c) in previous.iter().enumerate() {
            if i % 128 == 0 {
                check()?;
            }
            old_exact.entry(exact(c)?).or_default().push(c);
            old_base.entry(base(c)?).or_default().push(c);
            old_meta.entry(metadata(c)?).or_default().push(c);
            if c["providerId"].as_str().is_some_and(|s| !s.is_empty()) {
                old_provider.entry(provider(c)?).or_default().push(c);
            }
        }
        let mut exact_count = HashMap::<String, usize>::new();
        let mut meta_count = HashMap::<String, usize>::new();
        let mut provider_count = HashMap::<String, usize>::new();
        for row in &group {
            let c = &row.candidate["channel"];
            *exact_count.entry(exact(c)?).or_default() += 1;
            *meta_count.entry(metadata(c)?).or_default() += 1;
            if c["providerId"].as_str().is_some_and(|s| !s.is_empty()) {
                *provider_count.entry(provider(c)?).or_default() += 1;
            }
        }
        let mut used = HashSet::new();
        for row in group {
            check()?;
            let c = &row.candidate["channel"];
            let ek = exact(c)?;
            let mk = metadata(c)?;
            let pk = provider(c)?;
            let exacts = old_exact.get(&ek).cloned().unwrap_or_else(|| {
                old_base
                    .get(&base(c).unwrap_or_default())
                    .map(|a| a.iter().copied().filter(|old| compatible(c, old)).collect())
                    .unwrap_or_default()
            });
            let mut id = None;
            if exacts.len() == 1 && !used.contains(string(exacts[0], "id")?) {
                id = Some(string(exacts[0], "id")?.to_owned());
            } else if !exacts.is_empty()
                && exact_count[&ek] == 1
                && exacts
                    .iter()
                    .all(|old| exact(old).ok() == exact(exacts[0]).ok())
            {
                let best = exacts
                    .iter()
                    .min_by(|a, b| {
                        a["id"]
                            .as_str()
                            .unwrap_or("")
                            .encode_utf16()
                            .cmp(b["id"].as_str().unwrap_or("").encode_utf16())
                    })
                    .ok_or(ERR)?;
                if !used.contains(string(best, "id")?) {
                    id = Some(string(best, "id")?.to_owned());
                }
            }
            let (ambiguous_provider, ambiguous_metadata) = ambiguous(c)?;
            if id.is_none()
                && c["providerId"].as_str().is_some_and(|s| !s.is_empty())
                && provider_count.get(&pk) == Some(&1)
                && !ambiguous_provider
            {
                let matching = old_provider.get(&pk);
                if matching.is_some_and(|a| a.len() == 1) {
                    id = Some(string(matching.unwrap()[0], "id")?.to_owned());
                } else if matching.is_none_or(Vec::is_empty) {
                    id = Some(format!(
                        "provider:{}:{}",
                        component(sid),
                        component(string(c, "providerId")?)
                    ));
                }
            }
            if id.is_none()
                && old_meta.get(&mk).is_some_and(|a| a.len() == 1)
                && meta_count.get(&mk) == Some(&1)
                && !ambiguous_metadata
            {
                id = Some(string(old_meta[&mk][0], "id")?.to_owned());
            }
            let (id, generated) = match id {
                Some(id) if !used.contains(&id) => (id, false),
                _ => (create_id(), true),
            };
            if id.is_empty()
                || id.len() > 16_384
                || !used.insert(id.clone())
                || (generated && old_ids.contains_key(&id))
                || updates.get(&id).is_some_and(|old| old["sourceId"] != sid)
                || old_ids.get(&id).is_some_and(|old| old["sourceId"] != sid)
            {
                return Err(ERR.into());
            }
            let mut channel = geography(c, old_ids.get(&id).copied());
            channel["id"] = json!(id);
            if !old_ids.contains_key(&id) {
                appended.push(id.clone());
            }
            let fingerprint = crate::health_storage::fingerprint(&source, &channel, 0)?;
            let observed = row.observation;
            health_by_index.insert(row.original_index,json!({"schemaVersion":1,"channelId":id,"sourceId":sid,"checkedUrlOrdinal":0,"targetFingerprint":fingerprint,
                "platform":context.platform,"observerProfile":context.observer_profile,"observedAt":observed["observedAt"],"verdict":observed["verdict"],"evidence":observed["evidence"],"origin":"local"}));
            mappings.push(Mapping {
                original_index: row.original_index,
                channel_id: id.clone(),
            });
            updates.insert(id, channel);
        }
        if let Some(i) = sources.iter().position(|s| s["id"] == sid) {
            sources[i] = source.clone();
        } else {
            sources.push(source.clone());
        }
    }
    let channels: Vec<_> = old_channels
        .iter()
        .filter_map(|old| {
            updates
                .get(old["id"].as_str().unwrap_or(""))
                .filter(|new| *new != old)
                .cloned()
        })
        .chain(appended.iter().filter_map(|id| updates.get(id).cloned()))
        .collect();
    if sources.len() > 100 || old_channels.len() + appended.len() > 100_000 {
        return Err(ERR.into());
    }
    let changed_sources = sources
        .iter()
        .filter(|s| old_sources.iter().find(|old| old["id"] == s["id"]) != Some(*s))
        .cloned()
        .collect();
    let mut next_preferences = context.preferences.clone();
    next_preferences["sources"] = json!(sources);
    let incoming_health: Vec<_> = selected
        .iter()
        .map(|s| health_by_index.remove(&s.original_index).ok_or(ERR))
        .collect::<Result<_, _>>()?;
    let admitted = crate::health_storage::parse(&encoded(
        &json!({"schemaVersion":1,"records":incoming_health}),
    )?)?;
    let incoming_health = admitted
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ERR)?;
    check()?;
    Ok(Prepared {
        catalog_patch: Patch {
            schema_version: 1,
            base_source_count: old_sources.len() as u32,
            base_channel_count: old_channels.len() as u32,
            final_source_count: sources.len() as u32,
            final_channel_count: (old_channels.len() + appended.len()) as u32,
            sources: changed_sources,
            channels,
        },
        next_preferences,
        incoming_health,
        mappings,
    })
}
#[cfg(test)]
#[path = "scan_resume_reconcile_tests.rs"]
mod tests;
