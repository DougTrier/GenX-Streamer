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
        sql(c
            .query_row(
                "SELECT schema_version,revision,job_id,contents FROM scan_checkpoint WHERE singleton=1",
                [],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional())?
        .ok_or(ERR)?
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

// This module's parts, by area, are in scan_checkpoint/.
mod fingerprints;
pub use fingerprints::*;
mod validation;
use validation::*;
