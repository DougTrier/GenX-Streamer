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

//! Private operational scan state. Never part of catalog exports or diagnostics.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const LIMIT: usize = 20 * 1024 * 1024;
const DAY: u64 = 86_400_000;
const ERR: &str = "scan-checkpoint-invalid";
#[cfg(test)]
#[path = "scan_full_recheck_tests.rs"]
mod full_recheck_tests;
#[path = "scan_checkpoint_packed.rs"]
mod packed;
#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Mutation {
    // Native indexed activation only. IPC cannot deserialize this authority.
    #[serde(skip)]
    Replace {
        checkpoint: String,
        prior_job_id: Option<String>,
        prior_review_digest: Option<String>,
        allow_unfinished: bool,
    },
    Save {
        checkpoint: String,
    },
    Discard {
        #[serde(rename = "jobId")]
        job_id: String,
    },
    Advance {
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "reviewDigest")]
        review_digest: String,
        observations: Vec<Value>,
        #[serde(rename = "publishedKeys")]
        published_keys: Vec<String>,
    },
}
struct BoundedDelta(usize);
impl std::io::Write for BoundedDelta {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > LIMIT.saturating_sub(self.0) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "checkpoint delta limit",
            ));
        }
        self.0 += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
struct BoundedCheckpointBytes(Vec<u8>);
impl std::io::Write for BoundedCheckpointBytes {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > LIMIT.saturating_sub(self.0.len()) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "checkpoint size limit",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn advance_value(
    prior: &Snapshot,
    mutation: &Mutation,
    before_revision: i64,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    let Mutation::Advance {
        job_id,
        review_digest,
        observations,
        published_keys,
    } = mutation
    else {
        return Err(ERR.into());
    };
    if job_id.trim().is_empty()
        || job_id.len() > 128
        || job_id.chars().any(char::is_control)
        || review_digest.len() != 64
        || !review_digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ERR.into());
    }
    if observations.len() > 100_000 || published_keys.len() > 100_000 {
        return Err("scan-checkpoint-too-large".into());
    }
    serde_json::to_writer(&mut BoundedDelta(0), mutation)
        .map_err(|_| "scan-checkpoint-too-large")?;
    if prior.checkpoint_status == "invalid" {
        return Err("scan-checkpoint-clear-required".into());
    }
    if prior.checkpoint.is_none() {
        return Err("scan-checkpoint-advance-unavailable".into());
    }
    if prior.job_id.as_deref() != Some(job_id) {
        return Err("scan-checkpoint-job-stale".into());
    }
    let mut value: Value = serde_json::from_str(
        prior
            .checkpoint
            .as_deref()
            .ok_or("scan-checkpoint-advance-unavailable")?,
    )
    .map_err(|_| ERR)?;
    if value["schemaVersion"] != 2 && value["schemaVersion"] != 3 {
        return Err("scan-checkpoint-advance-requires-v2".into());
    }
    if value["jobId"] != *job_id || value["reviewDigest"] != *review_digest {
        return Err("scan-checkpoint-job-stale".into());
    }
    if revision(value["catalogRevision"].as_str().ok_or(ERR)?)? != before_revision {
        return Err("catalog-revision-stale".into());
    }
    if value["schemaVersion"] == 3 {
        return packed::advance(value, mutation, &mut check);
    }
    let existing = list(&value, "observations", 100_000)?;
    let mut indexes: HashMap<String, usize> = HashMap::new();
    for (index, observation) in existing.iter().enumerate() {
        check()?;
        let key = text(observation, "channelId", 256, false)?;
        if indexes.insert(key.into(), index).is_some() {
            return Err(ERR.into());
        }
    }
    let mut delta_observations = HashSet::new();
    for observation in observations {
        check()?;
        let key = text(observation, "channelId", 256, false)?;
        if !delta_observations.insert(key) {
            return Err(ERR.into());
        }
        if let Some(index) = indexes.get(key) {
            if value["observations"][*index] != *observation {
                return Err("scan-checkpoint-progress-conflict".into());
            }
            continue;
        }
        let stored = value["observations"].as_array_mut().ok_or(ERR)?;
        if stored.len() == 100_000 {
            return Err("scan-checkpoint-too-large".into());
        }
        indexes.insert(key.into(), stored.len());
        stored.push(observation.clone());
    }
    let mut keys: HashSet<String> = HashSet::new();
    for key in list(&value, "publishedKeys", 100_000)? {
        check()?;
        let key = key.as_str().ok_or(ERR)?;
        if !keys.insert(key.into()) {
            return Err(ERR.into());
        }
    }
    let mut delta_keys = HashSet::new();
    for key in published_keys {
        check()?;
        if key.trim().is_empty() || key.len() > 256 || key.chars().any(char::is_control) {
            return Err(ERR.into());
        }
        if !delta_keys.insert(key) {
            return Err(ERR.into());
        }
        if !keys.insert(key.clone()) {
            continue;
        }
        let stored = value["publishedKeys"].as_array_mut().ok_or(ERR)?;
        if stored.len() == 100_000 {
            return Err("scan-checkpoint-too-large".into());
        }
        stored.push(json!(key));
    }
    Ok(value)
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub checkpoint: Option<String>,
    pub checkpoint_status: &'static str,
    pub job_id: Option<String>,
    pub checkpoint_revision: String,
    pub catalog_revision: String,
}
/// A fresh refresh cannot silently discard an unfinished acknowledged job.
pub(crate) fn completed_replacement_identity(
    prior: &Snapshot,
) -> Result<(Option<String>, Option<String>), String> {
    if prior.checkpoint_status == "invalid" {
        return Err("scan-checkpoint-clear-required".into());
    }
    let Some(raw) = prior.checkpoint.as_ref() else {
        if prior.job_id.is_some() {
            return Err(ERR.into());
        }
        return Ok((None, None));
    };
    let value: Value = serde_json::from_str(raw).map_err(|_| ERR)?;
    if value["schemaVersion"] != 3 {
        return Err("scan-checkpoint-continue-required".into());
    }
    let candidates = list(&value["review"], "candidates", 100_000)?;
    let observations = list(&value, "observations", 100_000)?;
    let published: HashSet<usize> = list(&value, "publishedIndices", 100_000)?
        .iter()
        .map(|v| {
            v.as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .ok_or(ERR.into())
        })
        .collect::<Result<_, String>>()?;
    if observations.len() != candidates.len() {
        return Err("scan-checkpoint-continue-required".into());
    }
    let mut seen = HashSet::new();
    for row in observations {
        let index = row[0]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or(ERR)?;
        let verdict = row[2].as_str().ok_or(ERR)?;
        if index >= candidates.len()
            || !seen.insert(index)
            || matches!(verdict, "NotChecked" | "Canceled")
            || (matches!(verdict, "Reachable" | "PlayedHere") && !published.contains(&index))
        {
            return Err("scan-checkpoint-continue-required".into());
        }
    }
    let job = text(&value, "jobId", 128, false)?.to_owned();
    if prior.job_id.as_deref() != Some(&job) {
        return Err(ERR.into());
    }
    Ok((
        Some(job),
        Some(text(&value, "reviewDigest", 64, false)?.to_owned()),
    ))
}
/// Explicit full recheck retires old progress only after fresh authority seals.
/// This validates retained data structurally; it does not authorize resuming it.
pub(crate) fn full_recheck_replacement_identity(
    prior: &Snapshot,
    now: u64,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<(Option<String>, Option<String>), String> {
    if prior.checkpoint_status == "invalid" {
        return Err("scan-checkpoint-clear-required".into());
    }
    let Some(raw) = &prior.checkpoint else {
        return completed_replacement_identity(prior);
    };
    let value: Value = serde_json::from_str(raw).map_err(|_| "scan-checkpoint-clear-required")?;
    if value["schemaVersion"] != 3 {
        return Err("scan-checkpoint-continue-required".into());
    }
    let value = packed::validate_retained(value, now, check).map_err(|e| {
        if e == ERR {
            "scan-checkpoint-clear-required".into()
        } else {
            e
        }
    })?;
    let job = text(&value, "jobId", 128, false)?.to_owned();
    if prior.job_id.as_deref() != Some(&job) {
        return Err("scan-checkpoint-clear-required".into());
    }
    Ok((
        Some(job),
        Some(text(&value, "reviewDigest", 64, false)?.to_owned()),
    ))
}
pub fn revision(value: &str) -> Result<i64, String> {
    if value.is_empty()
        || !value.bytes().all(|b| b.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err("scan-checkpoint-revision-invalid".into());
    }
    value
        .parse()
        .map_err(|_| "scan-checkpoint-revision-invalid".into())
}
fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|error| {
        crate::storage_transaction::sql_error_code(&error, "scan-checkpoint-storage-failed")
    })
}
fn object(v: &Value, allowed: &[&str]) -> Result<(), String> {
    let o = v.as_object().ok_or(ERR)?;
    if o.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(ERR.into());
    }
    Ok(())
}
fn text<'a>(v: &'a Value, k: &str, max: usize, empty: bool) -> Result<&'a str, String> {
    let s = v[k].as_str().ok_or(ERR)?;
    if s.len() > max || (!empty && s.trim().is_empty()) || s.chars().any(|c| c.is_control()) {
        return Err(ERR.into());
    }
    Ok(s)
}
fn list<'a>(v: &'a Value, k: &str, max: usize) -> Result<&'a Vec<Value>, String> {
    let a = v[k].as_array().ok_or(ERR)?;
    if a.len() > max {
        return Err(ERR.into());
    }
    Ok(a)
}
fn hash(v: &Value) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(v).map_err(|_| ERR)?)
    ))
}
fn safe_url(raw: &str, source: bool, http: bool) -> Result<(), String> {
    let u = reqwest::Url::parse(raw).map_err(|_| ERR)?;
    if !(u.scheme() == "https" || (http && u.scheme() == "http"))
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || (source && u.query().is_some())
    {
        return Err("scan-checkpoint-source-not-resumable".into());
    }
    // Decode percent escapes before checking account credential path grammar.
    let mut decoded = String::new();
    let bytes = u.path().as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|_| ERR)?;
            decoded.push(u8::from_str_radix(hex, 16).map_err(|_| ERR)? as char);
            i += 3
        } else {
            decoded.push(bytes[i] as char);
            i += 1
        }
    }
    let parts: Vec<_> = decoded.split('/').filter(|p| !p.is_empty()).collect();
    if parts.last().is_some_and(|p| {
        matches!(
            p.to_ascii_lowercase().as_str(),
            "get.php" | "player_api.php"
        )
    }) || (parts.len() >= 3
        && matches!(
            parts[0].to_ascii_lowercase().as_str(),
            "live" | "movie" | "series"
        ))
    {
        return Err("scan-checkpoint-source-not-resumable".into());
    }
    Ok(())
}
pub fn source_fingerprint(s: &Value) -> Result<String, String> {
    hash(&json!([
        s["id"],
        s["name"],
        s["kind"],
        s["location"],
        s["allowHttp"].as_bool().unwrap_or(false),
        s.get("contentKind").unwrap_or(&Value::Null),
        s.get("mediaMime").unwrap_or(&Value::Null)
    ]))
}
pub(crate) fn policy_fingerprint(v: &Value, p: &Value) -> Result<String, String> {
    let providers = match p.get("reviewedChannelProviders") {
        None => Value::Null,
        Some(a) => Value::Array(
            a.as_array()
                .ok_or(ERR)?
                .iter()
                .map(|s| {
                    json!([
                        s["id"],
                        s["name"],
                        s["location"],
                        s["provenance"],
                        s["allowHttp"].as_bool().unwrap_or(false)
                    ])
                })
                .collect(),
        ),
    };
    let region = match p.get("preferredRegion") {
        None => Value::Null,
        Some(r) => json!([
            r["country"],
            r.get("state").unwrap_or(&Value::Null),
            r.get("postal").unwrap_or(&Value::Null),
            r["origin"]
        ]),
    };
    let definitions: Vec<_> = list(v, "sourceDefinitions", 100)?
        .iter()
        .map(|d| d["definitionFingerprint"].clone())
        .collect();
    hash(&json!([
        providers,
        region,
        v["budgetMs"],
        v["platform"],
        v["observerProfile"],
        definitions
    ]))
}
fn number(v: &Value, k: &str, max: u64) -> Result<u64, String> {
    v[k].as_u64()
        .filter(|n| *n <= max)
        .ok_or_else(|| ERR.into())
}
fn published_matches(candidate: &Value, canonical: &Value) -> bool {
    if ["sourceId", "providerId", "name", "category"]
        .iter()
        .any(|k| candidate.get(k) != canonical.get(k))
    {
        return false;
    }
    if candidate.get("geography").is_some_and(|geography| {
        geography.as_object().is_none_or(|fields| {
            fields.iter().any(|(field, value)| {
                canonical.get("geography").and_then(|g| g.get(field)) != Some(value)
            })
        })
    }) || candidate
        .get("geographyProvenance")
        .is_some_and(|value| canonical.get("geographyProvenance") != Some(value))
    {
        return false;
    }
    let Some(urls) = canonical["urls"].as_array() else {
        return false;
    };
    let Some(wanted) = candidate["urls"].as_array() else {
        return false;
    };
    let mut cursor = 0;
    for url in wanted {
        let Some(offset) = urls[cursor..].iter().position(|v| v == url) else {
            return false;
        };
        cursor += offset + 1;
    }
    true
}

fn channel_tuple(c: &Value, urls: Value) -> Value {
    let geo = c
        .get("geography")
        .map(|g| {
            json!([
                g.get("country").unwrap_or(&Value::Null),
                g.get("region").unwrap_or(&Value::Null),
                g.get("state").unwrap_or(&Value::Null)
            ])
        })
        .unwrap_or(Value::Null);
    let provenance = c
        .get("geographyProvenance")
        .and_then(Value::as_array)
        .map(|items| {
            Value::Array(
                items
                    .iter()
                    .map(|p| {
                        json!([
                            p["field"],
                            p["value"],
                            p["sourceId"],
                            p.get("providerId").unwrap_or(&Value::Null),
                            p["kind"],
                            p["scope"]
                        ])
                    })
                    .collect(),
            )
        })
        .unwrap_or(Value::Null);
    json!([
        c["sourceId"],
        c.get("providerId").unwrap_or(&Value::Null),
        c["name"],
        c["category"],
        urls,
        geo,
        provenance
    ])
}
fn reference_review_digest(review: &Value) -> Result<String, String> {
    let sources: Vec<_> = list(review, "sources", 100)?
        .iter()
        .map(|s| {
            json!([
                s["sourceId"],
                s["fingerprint"],
                s["status"],
                s["inspected"],
                s["matched"],
                s["warnings"]
            ])
        })
        .collect();
    let candidates: Vec<_> = list(review, "candidates", 100_000)?
        .iter()
        .map(|c| {
            json!([
                c["key"],
                c["sourceId"],
                c["sourceFingerprint"],
                c["sessionRevision"],
                channel_tuple(&c["channel"], json!([])),
                c["reference"]["candidateDigest"],
                c["reference"]["urlHashes"]
            ])
        })
        .collect();
    let n = &review["counts"];
    hash(&json!([
        review["sessionRevision"],
        review["query"],
        review["status"],
        sources,
        [
            n["inspected"],
            n["matched"],
            n["failedSources"],
            n["canceledSources"]
        ],
        candidates
    ]))
}
fn digest_field(v: &Value, k: &str) -> Result<(), String> {
    let s = text(v, k, 64, false)?;
    if s.len() != 64
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ERR.into());
    }
    Ok(())
}
fn reference_metadata(c: &Value) -> Result<(), String> {
    let ch = &c["channel"];
    object(
        ch,
        &[
            "sourceId",
            "providerId",
            "name",
            "category",
            "geography",
            "geographyProvenance",
        ],
    )?;
    text(ch, "sourceId", 256, false)?;
    text(ch, "name", 16_384, false)?;
    text(ch, "category", 16_384, true)?;
    if ch.get("providerId").is_some() {
        text(ch, "providerId", 16_384, false)?;
    }
    if let Some(g) = ch.get("geography") {
        object(g, &["country", "region", "state"])?;
        for (k, max) in [("country", 2), ("region", 32), ("state", 11)] {
            if g.get(k).is_none() {
                continue;
            }
            let value = text(g, k, max, false)?;
            let valid = match k {
                "country" => value.len() == 2 && value.bytes().all(|b| b.is_ascii_uppercase()),
                "region" => value.bytes().all(|b| {
                    b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_' || b == b'-'
                }),
                _ => {
                    value.len() >= 4
                        && g["country"]
                            .as_str()
                            .is_some_and(|country| value.starts_with(&format!("{country}-")))
                        && value[3..]
                            .bytes()
                            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
                }
            };
            if !valid {
                return Err(ERR.into());
            }
        }
    }
    if ch.get("geographyProvenance").is_some() {
        let mut seen = HashSet::new();
        for p in list(ch, "geographyProvenance", 3)? {
            object(
                p,
                &["field", "value", "sourceId", "providerId", "kind", "scope"],
            )?;
            let field = text(p, "field", 32, false)?;
            if !matches!(field, "country" | "region" | "state")
                || !seen.insert(field)
                || p["value"] != ch["geography"][field]
                || p["sourceId"] != ch["sourceId"]
                || !matches!(
                    p["kind"].as_str(),
                    Some("provider" | "m3u" | "registry" | "user")
                )
                || !matches!(
                    p["scope"].as_str(),
                    Some(
                        "channel-origin" | "provider-declared" | "country-group" | "user-reviewed"
                    )
                )
            {
                return Err(ERR.into());
            }
            text(p, "value", 32, false)?;
            text(p, "sourceId", 256, false)?;
            if p.get("providerId").is_some() {
                text(p, "providerId", 16_384, false)?;
            }
        }
    }
    let reference = &c["reference"];
    object(reference, &["candidateDigest", "urlHashes"])?;
    digest_field(reference, "candidateDigest")?;
    let hashes = list(reference, "urlHashes", 16)?;
    if hashes.is_empty() {
        return Err(ERR.into());
    }
    let mut seen = HashSet::new();
    for h in hashes {
        let s = h.as_str().ok_or(ERR)?;
        if s.len() != 64
            || !s
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !seen.insert(s)
        {
            return Err(ERR.into());
        }
    }
    Ok(())
}
fn reference_matches(candidate: &Value, target: &Value) -> Result<bool, String> {
    let mut wanted = Vec::new();
    let mut index = 0;
    let urls = target["urls"].as_array().ok_or(ERR)?;
    for expected in list(&candidate["reference"], "urlHashes", 16)? {
        let mut found = false;
        while index < urls.len() {
            let url = &urls[index];
            index += 1;
            if hash(url)? == expected.as_str().ok_or(ERR)? {
                wanted.push(url.clone());
                found = true;
                break;
            }
        }
        if !found {
            return Ok(false);
        }
    }
    let mut resolved = candidate["channel"].clone();
    resolved["urls"] = Value::Array(wanted);
    Ok(published_matches(&resolved, target)
        && hash(&channel_tuple(&resolved, resolved["urls"].clone()))?
            == candidate["reference"]["candidateDigest"]
                .as_str()
                .ok_or(ERR)?)
}

#[cfg(test)]
pub(crate) fn reference_fixture(value: &Value) -> Value {
    let mut output = value.clone();
    output["schemaVersion"] = json!(2);
    for candidate in output["review"]["candidates"].as_array_mut().unwrap() {
        let urls = candidate["channel"]["urls"].clone();
        let candidate_digest = hash(&channel_tuple(&candidate["channel"], urls.clone())).unwrap();
        let hashes: Vec<_> = urls
            .as_array()
            .unwrap()
            .iter()
            .map(|u| hash(u).unwrap())
            .collect();
        candidate["channel"].as_object_mut().unwrap().remove("urls");
        candidate["reference"] = json!({"candidateDigest":candidate_digest,"urlHashes":hashes});
    }
    output["reviewDigest"] = json!(reference_review_digest(&output["review"]).unwrap());
    output
}

#[cfg(test)]
pub(crate) fn packed_fixture(value: &Value) -> Value {
    packed::fixture(&reference_fixture(value))
}
#[cfg(test)]
pub(crate) fn packed_redigest(value: &mut Value) {
    packed::redigest(value);
}

pub fn validate(
    raw: &str,
    prefs: &Value,
    catalog: &Value,
    current_revision: i64,
    now: u64,
) -> Result<Value, String> {
    validate_guarded(raw, prefs, catalog, current_revision, now, &mut || Ok(()))
}

/// Private native manifest admission uses the existing packed identity and source policy.
pub(crate) fn manifest_seed(
    raw: &str,
    prefs: &Value,
    catalog: &Value,
    revision: i64,
    now: u64,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    let value = validate_guarded(raw, prefs, catalog, revision, now, check)?;
    if value["schemaVersion"] != 3 {
        return Err("scan-manifest-format-unsupported".into());
    }
    Ok(value)
}
// First-stage native-only compact resume primitive. No capability or endpoint is enabled.
#[path = "scan_resume_plan.rs"]
pub(crate) mod resume_plan;

pub(crate) fn resume_candidate(value: &Value, ordinal: usize) -> Result<Value, String> {
    let raw = value["review"]["candidates"]
        .as_array()
        .and_then(|rows| rows.get(ordinal))
        .ok_or(ERR)?;
    packed::candidate(value, raw)
}
pub(crate) fn manifest_authority(
    header: &Value,
    prefs: &Value,
    catalog: &Value,
    revision: i64,
    now: u64,
) -> Result<(), String> {
    let mut header = header.clone();
    header["catalogRevision"] = json!(revision.to_string());
    validate_header(&header, prefs, catalog, revision, now, true)?;
    Ok(())
}
pub(crate) fn manifest_candidate_parts(
    raw: &Value,
    category: &Value,
    source: &Value,
    session: &Value,
) -> Result<Value, String> {
    packed::candidate_parts(raw, category, source, session)
}
pub(crate) fn manifest_urls(candidate: &Value, urls: &[String]) -> Result<(), String> {
    let expected = candidate["reference"]["urlHashes"].as_array().ok_or(ERR)?;
    if urls.is_empty() || urls.len() > 16 || urls.len() != expected.len() {
        return Err("scan-manifest-url-mismatch".into());
    }
    let mut seen = HashSet::new();
    for (url, expected) in urls.iter().zip(expected) {
        if url.len() > 16_384 || url.chars().any(char::is_control) || !seen.insert(url) {
            return Err(ERR.into());
        }
        // This URL exists only in an authenticated encrypted manifest page.
        // Keep source/legacy plaintext restrictions in safe_url unchanged, but
        // never infer credentials from a stream path. Fragment metadata remains
        // byte-exact and hash-bound; it does not confer a network/HTTP grant.
        let parsed = reqwest::Url::parse(url).map_err(|_| ERR)?;
        if !matches!(parsed.scheme(), "https" | "http")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("scan-checkpoint-source-not-resumable".into());
        }
        if hash(&json!(url))? != expected.as_str().ok_or(ERR)? {
            return Err("scan-manifest-url-mismatch".into());
        }
    }
    if hash(&channel_tuple(&candidate["channel"], json!(urls)))?
        != candidate["reference"]["candidateDigest"]
            .as_str()
            .ok_or(ERR)?
    {
        return Err("scan-manifest-candidate-mismatch".into());
    }
    Ok(())
}
fn validate_guarded(
    raw: &str,
    prefs: &Value,
    catalog: &Value,
    current_revision: i64,
    now: u64,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    check()?;
    if raw.len() > LIMIT {
        return Err("scan-checkpoint-too-large".into());
    }
    let v: Value = serde_json::from_str(raw).map_err(|_| ERR)?;
    validate_value_guarded(v, prefs, catalog, current_revision, now, check)
}
struct Header<'a> {
    created: u64,
    definitions: &'a Vec<Value>,
    sources: HashMap<&'a str, &'a Value>,
    fingerprints: HashMap<&'a str, &'a str>,
    review: &'a Value,
}
fn validate_header<'a>(
    v: &'a Value,
    prefs: &Value,
    catalog: &Value,
    current_revision: i64,
    now: u64,
    referenced: bool,
) -> Result<Header<'a>, String> {
    validate_header_scope(v, Some((prefs, catalog, current_revision)), now, referenced)
}
fn validate_header_scope<'a>(
    v: &'a Value,
    authority: Option<(&Value, &Value, i64)>,
    now: u64,
    referenced: bool,
) -> Result<Header<'a>, String> {
    text(v, "jobId", 128, false)?;
    text(v, "platform", 256, false)?;
    text(v, "observerProfile", 256, false)?;
    let created = number(v, "createdAtMs", 8_640_000_000_000_000)?;
    if created > now || (authority.is_some() && now - created > DAY) {
        return Err("scan-checkpoint-expired".into());
    }
    if !matches!(v["budgetMs"].as_u64(), Some(20_000 | 45_000 | 60_000)) {
        return Err(ERR.into());
    }
    let stored_revision = revision(text(v, "catalogRevision", 19, false)?)?;
    if let Some((prefs, _, current_revision)) = authority {
        if stored_revision != current_revision {
            return Err("catalog-revision-stale".into());
        }
        if v.get("preferredRegion") != prefs.get("preferredRegion") {
            return Err("scan-checkpoint-policy-stale".into());
        }
    }
    digest_field(v, "policyFingerprint")?;
    let definitions = list(v, "sourceDefinitions", 100)?;
    if definitions.is_empty() {
        return Err(ERR.into());
    }
    let mut sources = HashMap::new();
    for d in definitions {
        object(d, &["source", "definitionFingerprint"])?;
        let s = &d["source"];
        object(
            s,
            &[
                "id",
                "name",
                "kind",
                "location",
                "allowHttp",
                "contentKind",
                "mediaMime",
            ],
        )?;
        if referenced && s["kind"] != "url" {
            return Err("scan-checkpoint-source-not-resumable".into());
        }
        let id = text(s, "id", 256, false)?;
        text(s, "name", 16384, false)?;
        let location = text(s, "location", 16384, false)?;
        if s.get("allowHttp").is_some_and(|v| !v.is_boolean()) {
            return Err(ERR.into());
        }
        let http = s["allowHttp"].as_bool().unwrap_or(false);
        if s["kind"] == "url" {
            safe_url(location, true, http)?;
        } else if s["kind"] != "file" {
            return Err(ERR.into());
        }
        if let Some((prefs, catalog, _)) = authority {
            let canonical = catalog["sources"]
                .as_array()
                .ok_or(ERR)?
                .iter()
                .find(|source| source["id"] == id);
            if let Some(saved) = canonical {
                if source_fingerprint(saved)? != source_fingerprint(s)? {
                    return Err("scan-checkpoint-policy-stale".into());
                }
            } else {
                if s["kind"] != "url" {
                    return Err("scan-checkpoint-source-not-resumable".into());
                }
                let admitted = prefs
                    .get("reviewedChannelProviders")
                    .and_then(Value::as_array)
                    .is_some_and(|configured| {
                        configured.iter().any(|p| {
                            p["location"] == location
                                && p["allowHttp"].as_bool().unwrap_or(false) == http
                        })
                    });
                if !admitted {
                    return Err("scan-checkpoint-policy-stale".into());
                }
            }
        }
        if d["definitionFingerprint"] != source_fingerprint(s)? || sources.insert(id, s).is_some() {
            return Err(ERR.into());
        }
    }
    if let Some((prefs, _, _)) = authority {
        if v["policyFingerprint"] != policy_fingerprint(v, prefs)? {
            return Err("scan-checkpoint-policy-stale".into());
        }
    }
    let review = &v["review"];
    object(
        review,
        &[
            "sessionRevision",
            "query",
            "status",
            "sources",
            "candidates",
            "counts",
        ],
    )?;
    if review["status"] != "completed" {
        return Err(ERR.into());
    }
    text(review, "sessionRevision", 256, false)?;
    text(review, "query", 256, true)?;
    let mut fingerprints = HashMap::new();
    for s in list(review, "sources", 100)? {
        object(
            s,
            &[
                "sourceId",
                "fingerprint",
                "status",
                "inspected",
                "matched",
                "warnings",
            ],
        )?;
        let id = text(s, "sourceId", 256, false)?;
        let fp = text(s, "fingerprint", 256, false)?;
        if !sources.contains_key(id) || fingerprints.insert(id, fp).is_some() {
            return Err(ERR.into());
        }
        if !matches!(
            s["status"].as_str(),
            Some("completed" | "failed" | "canceled")
        ) {
            return Err(ERR.into());
        }
        for k in ["inspected", "matched", "warnings"] {
            number(s, k, 100_000)?;
        }
    }
    if fingerprints.len() != sources.len() {
        return Err(ERR.into());
    }
    let counts = &review["counts"];
    object(
        counts,
        &["inspected", "matched", "failedSources", "canceledSources"],
    )?;
    for k in ["inspected", "matched"] {
        number(counts, k, 100_000)?;
    }
    for k in ["failedSources", "canceledSources"] {
        number(counts, k, 100)?;
    }
    Ok(Header {
        created,
        definitions,
        sources,
        fingerprints,
        review,
    })
}

fn validate_evidence(
    observed_at: &Value,
    declared: &Value,
    e: &Value,
    created: u64,
    now: u64,
) -> Result<(), String> {
    let at = observed_at
        .as_u64()
        .filter(|n| *n <= 8_640_000_000_000_000)
        .ok_or(ERR)?;
    if at < created || at > now {
        return Err(ERR.into());
    }
    let kind = e["kind"].as_str().ok_or(ERR)?;
    let verdict = match kind {
        "recognized-media-response" => {
            object(e, &["kind"])?;
            "Reachable"
        }
        "http" => {
            object(e, &["kind", "status", "contentRecognized"])?;
            let status = number(e, "status", 599)?;
            if status < 100 {
                return Err(ERR.into());
            }
            if e.get("contentRecognized").is_some_and(|v| !v.is_boolean()) {
                return Err(ERR.into());
            }
            if (200..300).contains(&status) && e["contentRecognized"] == true {
                "Reachable"
            } else if [401, 403, 451].contains(&status) {
                "AccessDenied"
            } else if status >= 400 {
                "TemporaryUnavailable"
            } else {
                "NotChecked"
            }
        }
        "timeout" | "slow" => {
            object(e, &["kind"])?;
            "TimedOut"
        }
        "unsupported" => {
            object(e, &["kind"])?;
            "UnsupportedHere"
        }
        "network-failure" | "host-down" => {
            object(e, &["kind"])?;
            "TemporaryUnavailable"
        }
        "decoded" => {
            object(e, &["kind", "before", "after", "elapsedMilliseconds"])?;
            let mut samples = Vec::new();
            for k in ["before", "after"] {
                let d = &e[k];
                object(d, &["mediaTime", "decodedFrames", "width", "height"])?;
                let t = d["mediaTime"]
                    .as_f64()
                    .filter(|n| n.is_finite() && *n >= 0.0)
                    .ok_or(ERR)?;
                let frames = number(d, "decodedFrames", 9_007_199_254_740_991)?;
                if number(d, "width", 16384)? == 0 || number(d, "height", 16384)? == 0 {
                    return Err(ERR.into());
                }
                samples.push((t, frames));
            }
            if e["elapsedMilliseconds"]
                .as_f64()
                .is_none_or(|n| !n.is_finite() || n <= 0.0)
                || samples[1].0 <= samples[0].0
                || samples[1].1 <= samples[0].1
            {
                return Err(ERR.into());
            }
            "PlayedHere"
        }
        _ => return Err(ERR.into()),
    };
    if verdict == "NotChecked" || declared != verdict {
        return Err(ERR.into());
    }
    Ok(())
}

fn validate_value_guarded(
    mut v: Value,
    prefs: &Value,
    catalog: &Value,
    current_revision: i64,
    now: u64,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    if v["schemaVersion"] == 3 {
        return packed::validate(v, prefs, catalog, current_revision, now, check);
    }
    object(
        &v,
        &[
            "schemaVersion",
            "jobId",
            "createdAtMs",
            "catalogRevision",
            "policyFingerprint",
            "sourceDefinitions",
            "budgetMs",
            "platform",
            "observerProfile",
            "preferredRegion",
            "review",
            "observations",
            "publishedKeys",
            "reviewDigest",
        ],
    )?;
    if v["schemaVersion"] != 1 && v["schemaVersion"] != 2 {
        return Err(ERR.into());
    }
    let referenced = v["schemaVersion"] == 2;
    if referenced {
        digest_field(&v, "reviewDigest")?;
    } else if v.get("reviewDigest").is_some() {
        return Err(ERR.into());
    }
    let Header {
        created,
        definitions,
        sources,
        fingerprints,
        review,
    } = validate_header(&v, prefs, catalog, current_revision, now, referenced)?;
    let mut candidates = HashMap::new();
    let mut synthetic = Vec::new();
    for (n, c) in list(review, "candidates", 100_000)?.iter().enumerate() {
        if n % 128 == 0 {
            check()?;
        }
        object(
            c,
            &[
                "key",
                "sourceId",
                "sourceFingerprint",
                "sessionRevision",
                "channel",
                "reference",
            ],
        )?;
        let key = text(c, "key", 256, false)?;
        let sid = text(c, "sourceId", 256, false)?;
        if c["sessionRevision"] != review["sessionRevision"]
            || fingerprints.get(sid).copied() != c["sourceFingerprint"].as_str()
            || c["channel"]["sourceId"] != sid
            || candidates.insert(key, c).is_some()
        {
            return Err(ERR.into());
        }
        let ch = &c["channel"];
        if referenced {
            if sources.get(sid).ok_or(ERR)?["kind"] != "url" {
                return Err("scan-checkpoint-source-not-resumable".into());
            }
            reference_metadata(c)?;
            continue;
        }
        if c.get("reference").is_some() {
            return Err(ERR.into());
        }
        object(
            ch,
            &[
                "sourceId",
                "providerId",
                "name",
                "category",
                "urls",
                "geography",
                "geographyProvenance",
            ],
        )?;
        sources.get(sid).ok_or(ERR)?;
        for u in list(ch, "urls", 16)? {
            safe_url(u.as_str().ok_or(ERR)?, false, true)?;
        }
        let mut copy = ch.clone();
        copy["id"] = json!(format!("checkpoint-{n}"));
        synthetic.push(copy);
    }
    if !referenced {
        crate::storage_transaction::validate_checkpoint_catalog(
            &json!({"schemaVersion":1,"sources":definitions.iter().map(|d|{let mut source=d["source"].clone();source["allowHttp"]=json!(true);source}).collect::<Vec<_>>(),"channels":synthetic}),
        )?;
    }
    if referenced && reference_review_digest(review)? != v["reviewDigest"].as_str().ok_or(ERR)? {
        return Err(ERR.into());
    }
    let mut observed = HashMap::new();
    for (n, o) in list(&v, "observations", 100_000)?.iter().enumerate() {
        if n % 128 == 0 {
            check()?;
        }
        object(
            o,
            &[
                "channelId",
                "sourceId",
                "fingerprint",
                "platform",
                "observedAt",
                "verdict",
                "evidence",
            ],
        )?;
        let key = text(o, "channelId", 256, false)?;
        let c = candidates.get(key).ok_or(ERR)?;
        if observed.insert(key, o).is_some()
            || o["sourceId"] != c["sourceId"]
            || o["fingerprint"] != c["sourceFingerprint"]
            || o["platform"] != v["platform"]
        {
            return Err(ERR.into());
        }
        validate_evidence(
            &o["observedAt"],
            &o["verdict"],
            &o["evidence"],
            created,
            now,
        )?;
    }
    let mut published = HashSet::new();
    let targets = catalog["channels"].as_array().ok_or(ERR)?;
    let identity = |c: &Value| {
        serde_json::to_string(&json!([
            c["sourceId"],
            c.get("providerId").unwrap_or(&Value::Null),
            c["name"],
            c["category"]
        ]))
        .map_err(|_| ERR.to_string())
    };
    let mut target_index: HashMap<String, Vec<&Value>> = HashMap::new();
    for (n, target) in targets.iter().enumerate() {
        if n % 128 == 0 {
            check()?;
        }
        target_index
            .entry(identity(target)?)
            .or_default()
            .push(target);
    }
    let mut comparisons = 0usize;

    for (n, key) in list(&v, "publishedKeys", 100_000)?.iter().enumerate() {
        if n % 128 == 0 {
            check()?;
        }
        let key = key.as_str().ok_or(ERR)?;
        let o = observed.get(key).ok_or(ERR)?;
        if !published.insert(key)
            || !matches!(o["verdict"].as_str(), Some("Reachable" | "PlayedHere"))
        {
            return Err(ERR.into());
        }
        let c = candidates.get(key).ok_or(ERR)?;
        let mut matched = false;
        if let Some(targets) = target_index.get(&identity(&c["channel"])?) {
            for target in targets {
                comparisons += 1;
                if comparisons.is_multiple_of(128) {
                    check()?;
                }
                if comparisons > 1_000_000 {
                    return Err("scan-checkpoint-target-validation-limit".into());
                }
                if (referenced && reference_matches(c, target)?)
                    || (!referenced && published_matches(&c["channel"], target))
                {
                    matched = true;
                    break;
                }
            }
        }
        if !matched {
            return Err("scan-checkpoint-unpublished-channel".into());
        }
        let sid = c["sourceId"].as_str().ok_or(ERR)?;
        let canonical_source = catalog["sources"]
            .as_array()
            .ok_or(ERR)?
            .iter()
            .find(|s| s["id"] == sid)
            .ok_or(ERR)?;
        if source_fingerprint(canonical_source)?
            != source_fingerprint(sources.get(sid).ok_or(ERR)?)?
        {
            return Err("scan-checkpoint-policy-stale".into());
        }
    }
    v["catalogRevision"] = json!(current_revision.to_string());
    Ok(v)
}

pub fn ensure(c: &Connection) -> Result<(), String> {
    sql(c.execute_batch("CREATE TABLE IF NOT EXISTS scan_checkpoint(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),revision INTEGER NOT NULL CHECK(revision>=0),job_id TEXT,contents TEXT);INSERT OR IGNORE INTO scan_checkpoint VALUES(1,1,0,NULL,NULL);"))
}
pub(crate) struct CapturedCheckpoint(i64, i64, Option<String>, Option<String>);
impl CapturedCheckpoint {
    pub(crate) fn has_contents(&self) -> bool {
        self.3.is_some()
    }
}
pub fn read(c: &Connection, catalog_revision: i64) -> Result<Snapshot, String> {
    finish(capture(c)?, catalog_revision)
}
pub(crate) fn capture(c: &Connection) -> Result<CapturedCheckpoint, String> {
    let exists: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_checkpoint')",
        [],
        |r| r.get(0),
    ))?;
    let row = if exists {
        sql(c.query_row("SELECT schema_version,revision,job_id,contents FROM scan_checkpoint WHERE singleton=1",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?))).optional())?.ok_or(ERR)?
    } else {
        (1, 0, None, None)
    };
    Ok(CapturedCheckpoint(row.0, row.1, row.2, row.3))
}
pub(crate) fn finish(
    captured: CapturedCheckpoint,
    catalog_revision: i64,
) -> Result<Snapshot, String> {
    let CapturedCheckpoint(version, rev, job, raw) = captured;
    if rev < 0 || catalog_revision < 0 {
        return Err(ERR.into());
    }
    let job_valid = job
        .as_ref()
        .is_none_or(|s| !s.trim().is_empty() && s.len() <= 128 && !s.chars().any(char::is_control));
    let contents_valid = raw.as_ref().is_none_or(|raw| {
        raw.len() <= LIMIT
            && serde_json::from_str::<Value>(raw).is_ok_and(|v| {
                (v["schemaVersion"] == 1 || v["schemaVersion"] == 2 || v["schemaVersion"] == 3)
                    && v["jobId"].as_str() == job.as_deref()
                    && object(
                        &v,
                        if v["schemaVersion"] == 3 {
                            packed::FIELDS
                        } else {
                            &[
                                "schemaVersion",
                                "jobId",
                                "createdAtMs",
                                "catalogRevision",
                                "policyFingerprint",
                                "sourceDefinitions",
                                "budgetMs",
                                "platform",
                                "observerProfile",
                                "preferredRegion",
                                "review",
                                "observations",
                                "publishedKeys",
                                "reviewDigest",
                            ]
                        },
                    )
                    .is_ok()
            })
    });
    let valid = version == 1 && job_valid && contents_valid && (job.is_some() == raw.is_some());
    let status = if !valid {
        "invalid"
    } else if raw.is_none() {
        "absent"
    } else {
        "valid"
    };
    Ok(Snapshot {
        checkpoint: if valid { raw } else { None },
        checkpoint_status: status,
        job_id: if job_valid { job } else { None },
        checkpoint_revision: rev.to_string(),
        catalog_revision: catalog_revision.to_string(),
    })
}

pub fn apply(
    c: &Connection,
    mutation: &Mutation,
    expected: i64,
    prefs: &Value,
    catalog: &Value,
    revisions: (i64, i64, u64),
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<String, String> {
    let (before_revision, after_revision, now) = revisions;
    ensure(c)?;
    let mut prior = read(c, before_revision)?;
    let rev = revision(&prior.checkpoint_revision)?;
    if rev != expected {
        return Err("scan-checkpoint-revision-stale".into());
    }
    if rev == i64::MAX {
        return Err("scan-checkpoint-revision-exhausted".into());
    }
    let (job, raw) = match mutation {
        Mutation::Advance { .. } => {
            let merged = advance_value(&prior, mutation, before_revision, &mut check)?;
            // The stored text is parsed; free it before validation and re-encoding.
            prior.checkpoint = None;
            // Count exact escaped UTF-8 bytes without allocating another full JSON string.
            let mut encoded_size = BoundedDelta(0);
            serde_json::to_writer(&mut encoded_size, &merged)
                .map_err(|_| "scan-checkpoint-too-large")?;
            // Preserve the guard formerly executed before re-parsing the encoded value.
            check()?;
            let mut validated =
                validate_value_guarded(merged, prefs, catalog, before_revision, now, &mut check)?;
            crate::scan_candidate_manifest::bind_checkpoint(
                c,
                prior.job_id.as_deref(),
                validated["reviewDigest"].as_str(),
            )?;
            validated["catalogRevision"] = json!(after_revision.to_string());
            let mut encoded = BoundedCheckpointBytes(Vec::with_capacity(
                encoded_size.0.saturating_add(20).min(LIMIT),
            ));
            serde_json::to_writer(&mut encoded, &validated)
                .map_err(|_| "scan-checkpoint-too-large")?;
            let raw = String::from_utf8(encoded.0).map_err(|_| ERR)?;
            (prior.job_id.clone(), Some(raw))
        }
        Mutation::Replace {
            checkpoint,
            prior_job_id,
            prior_review_digest,
            allow_unfinished,
        } => {
            let identity = if *allow_unfinished {
                full_recheck_replacement_identity(&prior, now, &mut check)?
            } else {
                completed_replacement_identity(&prior)?
            };
            if identity != (prior_job_id.clone(), prior_review_digest.clone()) {
                return Err("scan-checkpoint-job-stale".into());
            }
            let mut v =
                validate_guarded(checkpoint, prefs, catalog, before_revision, now, &mut check)?;
            if v["schemaVersion"] != 3
                || !list(&v, "observations", 100_000)?.is_empty()
                || !list(&v, "publishedIndices", 100_000)?.is_empty()
            {
                return Err(ERR.into());
            }
            let job = text(&v, "jobId", 128, false)?.to_owned();
            if prior.job_id.as_deref() == Some(&job) {
                return Err("scan-checkpoint-job-stale".into());
            }
            crate::scan_candidate_manifest::bind_checkpoint(
                c,
                Some(&job),
                v["reviewDigest"].as_str(),
            )?;
            v["catalogRevision"] = json!(after_revision.to_string());
            let mut bytes = BoundedCheckpointBytes(Vec::new());
            serde_json::to_writer(&mut bytes, &v).map_err(|_| "scan-checkpoint-too-large")?;
            (
                Some(job),
                Some(String::from_utf8(bytes.0).map_err(|_| ERR)?),
            )
        }
        Mutation::Save { checkpoint } => {
            let mut v =
                validate_guarded(checkpoint, prefs, catalog, before_revision, now, &mut check)?;
            let job = text(&v, "jobId", 128, false)?.to_owned();
            if prior.checkpoint_status == "invalid" {
                return Err("scan-checkpoint-clear-required".into());
            }
            if let Some(old_raw) = &prior.checkpoint {
                let old: Value = serde_json::from_str(old_raw).map_err(|_| ERR)?;
                if revision(old["catalogRevision"].as_str().ok_or(ERR)?)? != before_revision {
                    return Err("catalog-revision-stale".into());
                }
                if (old["schemaVersion"] == 3 || v["schemaVersion"] == 3)
                    && old["schemaVersion"] != v["schemaVersion"]
                {
                    return Err("scan-checkpoint-job-stale".into());
                }
                for key in [
                    "createdAtMs",
                    "policyFingerprint",
                    "sourceDefinitions",
                    "budgetMs",
                    "platform",
                    "observerProfile",
                    "preferredRegion",
                    "review",
                    "categoryTable",
                ] {
                    check()?;
                    if old.get(key) != v.get(key) {
                        return Err("scan-checkpoint-job-stale".into());
                    }
                }
                if v["schemaVersion"] == 3 {
                    packed::preserve_progress(&old, &v, &mut check)?;
                } else {
                    let new_published: HashSet<_> =
                        list(&v, "publishedKeys", 100_000)?.iter().collect();
                    if list(&old, "publishedKeys", 100_000)?
                        .iter()
                        .any(|key| !new_published.contains(key))
                    {
                        return Err("scan-checkpoint-progress-stale".into());
                    }
                    let new_observations: HashMap<_, _> = list(&v, "observations", 100_000)?
                        .iter()
                        .map(|o| (&o["channelId"], o))
                        .collect();
                    for previous in list(&old, "observations", 100_000)? {
                        check()?;
                        let current = new_observations
                            .get(&previous["channelId"])
                            .ok_or("scan-checkpoint-progress-stale")?;
                        if current["observedAt"].as_u64() < previous["observedAt"].as_u64() {
                            return Err("scan-checkpoint-progress-stale".into());
                        }
                    }
                }
            }
            if let Some(old_job) = &prior.job_id {
                if *old_job != job {
                    return Err("scan-checkpoint-job-stale".into());
                }
            }
            crate::scan_candidate_manifest::bind_checkpoint(
                c,
                Some(&job),
                v["reviewDigest"].as_str(),
            )?;
            v["catalogRevision"] = json!(after_revision.to_string());
            let raw = if v["schemaVersion"] == 3 {
                let mut bytes = BoundedCheckpointBytes(Vec::new());
                serde_json::to_writer(&mut bytes, &v).map_err(|_| "scan-checkpoint-too-large")?;
                String::from_utf8(bytes.0).map_err(|_| ERR)?
            } else {
                serde_json::to_string(&v).map_err(|_| ERR)?
            };
            if raw.len() > LIMIT {
                return Err("scan-checkpoint-too-large".into());
            }
            (Some(job), Some(raw))
        }
        Mutation::Discard { job_id } => {
            if job_id.trim().is_empty()
                || job_id.len() > 128
                || job_id.chars().any(char::is_control)
            {
                return Err(ERR.into());
            }
            if prior.checkpoint_status == "invalid" && prior.job_id.is_none() {
                return Err("scan-checkpoint-invalid".into());
            }
            if let Some(old_job) = &prior.job_id {
                if *old_job != *job_id {
                    return Err("scan-checkpoint-job-stale".into());
                }
            }
            (None, None)
        }
    };
    sql(c.execute(
        "UPDATE scan_checkpoint SET revision=?1,job_id=?2,contents=?3 WHERE singleton=1",
        params![rev + 1, job, raw],
    ))?;
    if let Mutation::Discard { job_id } = mutation {
        crate::scan_candidate_manifest::discard_job(c, Some(job_id))?;
    }
    Ok((rev + 1).to_string())
}
