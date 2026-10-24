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

//! Private encrypted original scan URLs. No export or diagnostic returns stored ciphertext/URLs.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

pub const PAGE_LIMIT: usize = 1024 * 1024;
pub const CIPHER_PAGE_LIMIT: usize = PAGE_LIMIT + 16 * 1024;
pub const BINDING_LIMIT: usize = 128 * 1024;
const URL_LIMIT: u64 = 64 * 1024 * 1024;
const CIPHER_LIMIT: u64 = 96 * 1024 * 1024;
const ERR: &str = "scan-manifest-invalid";
#[path = "scan_manifest_activation_guard.rs"]
pub(crate) mod activation_guard;
#[path = "scan_manifest_origin_directory.rs"]
pub(crate) mod origin_directory;
#[cfg(test)]
#[path = "scan_manifest_protected_seal_tests.rs"]
mod protected_seal_tests;
fn sql<T>(value: rusqlite::Result<T>) -> Result<T, String> {
    value.map_err(|error| {
        crate::storage_transaction::sql_error_code(&error, "scan-manifest-storage-failed")
    })
}
fn encode(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| ERR.into())
}
fn digest(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn opaque(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ERR.into());
    }
    Ok(())
}
fn random_id() -> Result<String, String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| "scan-manifest-random-failed")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn present(c: &Connection) -> Result<bool, String> {
    let exists: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_manifest_namespace')",
        [],
        |r| r.get(0),
    ))?;
    if exists {
        let version: i64 = sql(c.query_row(
            "SELECT schema_version FROM scan_manifest_namespace WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        if version != 1 {
            return Err("scan-manifest-version-unsupported".into());
        }
    }
    Ok(exists)
}
pub(crate) fn ensure(c: &Connection) -> Result<(), String> {
    let _ = present(c)?;
    sql(c.execute_batch("CREATE TABLE IF NOT EXISTS scan_manifest_namespace(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),namespace TEXT NOT NULL);CREATE TABLE IF NOT EXISTS scan_manifest(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,review_digest TEXT NOT NULL,revision INTEGER NOT NULL,state INTEGER NOT NULL CHECK(state IN(0,1)),created_at INTEGER NOT NULL,seed TEXT NOT NULL,authority TEXT NOT NULL,candidate_count INTEGER NOT NULL,next_index INTEGER NOT NULL,url_bytes INTEGER NOT NULL,cipher_bytes INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS scan_manifest_candidate(manifest_id TEXT NOT NULL REFERENCES scan_manifest(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(manifest_id,ordinal));CREATE TABLE IF NOT EXISTS scan_manifest_page(manifest_id TEXT NOT NULL REFERENCES scan_manifest(id) ON DELETE CASCADE,start_index INTEGER NOT NULL,item_count INTEGER NOT NULL,binding TEXT NOT NULL,plain_hash TEXT NOT NULL,ciphertext BLOB NOT NULL,PRIMARY KEY(manifest_id,start_index));"))?;
    sql(c.execute_batch("CREATE TABLE IF NOT EXISTS scan_manifest_category(manifest_id TEXT NOT NULL REFERENCES scan_manifest(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,contents TEXT NOT NULL,PRIMARY KEY(manifest_id,ordinal));"))?;
    sql(c.execute_batch("CREATE TABLE IF NOT EXISTS scan_manifest_replacement(manifest_id TEXT PRIMARY KEY REFERENCES scan_manifest(id) ON DELETE CASCADE,prior_job_id TEXT,prior_review_digest TEXT,catalog_revision INTEGER NOT NULL,checkpoint_revision INTEGER NOT NULL,allow_unfinished INTEGER NOT NULL CHECK(allow_unfinished IN(0,1)));"))?;
    if !sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM scan_manifest_namespace)",
        [],
        |r| r.get::<_, bool>(0),
    ))? {
        sql(c.execute(
            "INSERT INTO scan_manifest_namespace VALUES(1,1,?1)",
            [random_id()?],
        ))?;
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Begin {
    pub schema_version: u8,
    pub checkpoint: String,
    pub expected_catalog_revision: String,
    pub expected_checkpoint_revision: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub candidate_index: usize,
    pub urls: Vec<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Append {
    pub manifest_id: String,
    pub expected_manifest_revision: String,
    pub expected_catalog_revision: String,
    pub expected_checkpoint_revision: String,
    pub entries: Vec<Entry>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Seal {
    pub manifest_id: String,
    pub expected_manifest_revision: String,
    pub expected_catalog_revision: String,
    pub expected_checkpoint_revision: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Find {
    pub job_id: String,
    pub review_digest: String,
    pub expected_catalog_revision: String,
    pub expected_checkpoint_revision: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Read {
    pub manifest_id: String,
    pub job_id: String,
    pub review_digest: String,
    pub start_index: usize,
    pub expected_catalog_revision: String,
    pub expected_checkpoint_revision: String,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub schema_version: u8,
    pub manifest_id: String,
    pub manifest_revision: String,
    pub job_id: String,
    pub review_digest: String,
    pub candidate_count: usize,
    pub next_index: usize,
}
pub struct Found {
    pub schema_version: u8,
    pub status: &'static str,
    pub header: Option<Header>,
}
impl Serialize for Found {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut value = match &self.header {
            Some(header) => serde_json::to_value(header).map_err(serde::ser::Error::custom)?,
            None => json!({"schemaVersion":self.schema_version}),
        };
        value["status"] = json!(self.status);
        value.serialize(serializer)
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub schema_version: u8,
    pub manifest_id: String,
    pub job_id: String,
    pub review_digest: String,
    pub manifest_revision: String,
    pub start_index: usize,
    pub next_index: usize,
    pub entries: Vec<Entry>,
}
#[derive(Clone, Copy)]
pub struct Context<'a> {
    pub preferences: &'a Value,
    pub catalog: &'a Value,
    pub catalog_revision: i64,
    pub checkpoint_revision: i64,
    pub now: u64,
}
struct Stored {
    header: Header,
    state: i64,
    authority: Value,
    url_bytes: u64,
    cipher_bytes: u64,
}
fn stored(c: &Connection, id: &str) -> Result<Stored, String> {
    if !present(c)? {
        return Err("scan-manifest-absent".into());
    }
    opaque(id)?;
    let row=sql(c.query_row("SELECT job_id,review_digest,revision,state,authority,candidate_count,next_index,url_bytes,cipher_bytes FROM scan_manifest WHERE id=?1", [id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?,r.get::<_,i64>(7)?,r.get::<_,i64>(8)?))).optional())?.ok_or("scan-manifest-absent")?;
    if row.2 < 0
        || row.5 < 0
        || row.6 < 0
        || row.7 < 0
        || row.8 < 0
        || row.5 > 100_000
        || row.6 > row.5
        || row.4.len() > 4 * 1024 * 1024
        || row.7 > URL_LIMIT as i64
        || row.8 > CIPHER_LIMIT as i64
    {
        return Err(ERR.into());
    }
    Ok(Stored {
        header: Header {
            schema_version: 1,
            manifest_id: id.into(),
            job_id: row.0,
            review_digest: row.1,
            manifest_revision: row.2.to_string(),
            candidate_count: row.5 as usize,
            next_index: row.6 as usize,
        },
        state: row.3,
        authority: serde_json::from_str(&row.4).map_err(|_| ERR)?,
        url_bytes: row.7 as u64,
        cipher_bytes: row.8 as u64,
    })
}
pub(crate) fn check_cas(
    context: &Context<'_>,
    catalog: &str,
    checkpoint: &str,
) -> Result<(), String> {
    if crate::scan_checkpoint::revision(catalog)? != context.catalog_revision {
        return Err("catalog-revision-stale".into());
    }
    if crate::scan_checkpoint::revision(checkpoint)? != context.checkpoint_revision {
        return Err("scan-checkpoint-revision-stale".into());
    }
    Ok(())
}
/// The scan job and digest a replacement manifest is bound to, and whether
/// it may proceed.
pub(crate) type ReplacementGuard = (Option<String>, Option<String>, bool);
pub(crate) fn replacement_guard(
    c: &Connection,
    manifest_id: &str,
    context: &Context<'_>,
) -> Result<Option<ReplacementGuard>, String> {
    // Autocommit callers also need one coherent snapshot across every guard seek.
    // Existing checked write/read transactions retain their own snapshot/lease.
    if c.is_autocommit() {
        let tx = sql(c.unchecked_transaction())?;
        let result = replacement_guard_in_snapshot(&tx, manifest_id, context)?;
        sql(tx.commit())?;
        return Ok(result);
    }
    replacement_guard_in_snapshot(c, manifest_id, context)
}
fn replacement_guard_in_snapshot(
    c: &Connection,
    manifest_id: &str,
    context: &Context<'_>,
) -> Result<Option<ReplacementGuard>, String> {
    if !sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_manifest_replacement')",
        [],
        |r| r.get::<_, bool>(0),
    ))? {
        return Ok(None);
    }
    let binding = sql(c.query_row("SELECT prior_job_id,prior_review_digest,catalog_revision,checkpoint_revision,allow_unfinished FROM scan_manifest_replacement WHERE manifest_id=?1", [manifest_id], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, bool>(4)?))).optional())?;
    let Some((job, digest, catalog, checkpoint, allow)) = binding else {
        return Ok(None);
    };
    check_cas(context, &catalog.to_string(), &checkpoint.to_string())?;
    let identity = sql(c.query_row("SELECT job_id,CASE WHEN contents IS NULL THEN NULL ELSE json_extract(contents,'$.reviewDigest') END FROM scan_checkpoint WHERE singleton=1", [], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?))))?;
    if identity != (job.clone(), digest.clone()) {
        return Err("scan-checkpoint-job-stale".into());
    }
    if sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_activation_row')",
        [],
        |r| r.get::<_, bool>(0),
    ))? {
        let stale = activation_guard::stale(c, manifest_id)?;
        if stale {
            return Err("source-snapshot-revision-stale".into());
        }
    }
    Ok(Some((job, digest, allow)))
}
fn authority(c: &Connection, stored: &Stored, context: &Context<'_>) -> Result<(), String> {
    if stored.state == 0 {
        replacement_guard(c, &stored.header.manifest_id, context)?;
    }
    crate::scan_checkpoint::manifest_authority(
        &stored.authority,
        context.preferences,
        context.catalog,
        context.catalog_revision,
        context.now,
    )
}
pub(crate) fn begin(
    c: &Connection,
    request: &Begin,
    context: &Context<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Header, String> {
    begin_inner(c, request, context, None, &mut check)
}
pub(crate) fn begin_replacement(
    c: &Connection,
    request: &Begin,
    context: &Context<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Header, String> {
    begin_inner(c, request, context, Some(false), &mut check)
}
pub(crate) fn begin_full_recheck_replacement(
    c: &Connection,
    request: &Begin,
    context: &Context<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Header, String> {
    begin_inner(c, request, context, Some(true), &mut check)
}
fn begin_inner(
    c: &Connection,
    request: &Begin,
    context: &Context<'_>,
    replacement: Option<bool>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Header, String> {
    if request.schema_version != 1 {
        return Err(ERR.into());
    }
    check_cas(
        context,
        &request.expected_catalog_revision,
        &request.expected_checkpoint_revision,
    )?;
    let seed = crate::scan_checkpoint::manifest_seed(
        &request.checkpoint,
        context.preferences,
        context.catalog,
        context.catalog_revision,
        context.now,
        &mut check,
    )?;
    ensure(c)?;
    let prior = crate::scan_checkpoint::read(c, context.catalog_revision)?;
    if prior.checkpoint_status == "invalid" {
        return Err("scan-checkpoint-clear-required".into());
    }
    let job = seed["jobId"].as_str().ok_or(ERR)?;
    let prior_identity = if let Some(allow_unfinished) = replacement {
        let identity = if allow_unfinished {
            crate::scan_checkpoint::full_recheck_replacement_identity(
                &prior,
                context.now,
                &mut check,
            )?
        } else {
            crate::scan_checkpoint::completed_replacement_identity(&prior)?
        };
        if prior.job_id.as_deref() == Some(job) {
            return Err("scan-checkpoint-job-stale".into());
        }
        Some(identity)
    } else if prior.job_id.as_deref().is_some_and(|old| old != job) {
        return Err("scan-checkpoint-job-stale".into());
    } else {
        None
    };
    if let Some(raw) = prior.checkpoint.as_ref().filter(|_| replacement.is_none()) {
        let previous: Value = serde_json::from_str(raw).map_err(|_| ERR)?;
        if previous["schemaVersion"] != 3
            || previous["reviewDigest"] != seed["reviewDigest"]
            || previous != seed
        {
            return Err("scan-checkpoint-job-stale".into());
        }
    }
    // Staging cleanup is local, bounded by the two-manifest admission cap; never deletes sealed jobs.
    sql(c.execute(
        "DELETE FROM scan_manifest WHERE state=0 AND created_at<?1 AND job_id<>?2",
        params![context.now.saturating_sub(86_400_000) as i64, job],
    ))?;
    if prior.job_id.is_none() || replacement.is_some() {
        // No published job owns staging; a new explicitly admitted job fences abandoned work.
        sql(c.execute(
            "DELETE FROM scan_manifest WHERE state=0 AND job_id<>?1",
            [job],
        ))?;
    }
    let existing = sql(c
        .query_row(
            "SELECT id,state,seed FROM scan_manifest WHERE job_id=?1",
            [job],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional())?;
    if let Some((id, state, old_seed)) = existing {
        if state != 0
            || old_seed.len() > 20 * 1024 * 1024
            || serde_json::from_str::<Value>(&old_seed).map_err(|_| ERR)? != seed
        {
            return Err("scan-manifest-job-exists".into());
        }
        // A fresh ID fences any old prepared crypto work; a sealed job is never replaced.
        sql(c.execute("DELETE FROM scan_manifest WHERE id=?1 AND state=0", [id]))?;
    }
    if sql(c.query_row("SELECT COUNT(*) FROM scan_manifest", [], |r| {
        r.get::<_, i64>(0)
    }))? >= 2
    {
        return Err("scan-manifest-capacity".into());
    }
    let id = random_id()?;
    let candidates = seed["review"]["candidates"].as_array().ok_or(ERR)?;
    let mut header = seed.clone();
    header["review"]["candidates"] = json!([]);
    for field in ["categoryTable", "observations", "publishedIndices"] {
        header.as_object_mut().ok_or(ERR)?.remove(field);
    }
    sql(c.execute(
        "INSERT INTO scan_manifest VALUES(?1,?2,?3,0,0,?4,?5,?6,?7,0,0,0)",
        params![
            id,
            job,
            seed["reviewDigest"].as_str().ok_or(ERR)?,
            seed["createdAtMs"].as_i64().ok_or(ERR)?,
            request.checkpoint,
            encode(&header)?,
            candidates.len() as i64
        ],
    ))?;
    if let Some((job, digest)) = prior_identity {
        sql(c.execute(
            "INSERT INTO scan_manifest_replacement VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                id,
                job,
                digest,
                context.catalog_revision,
                context.checkpoint_revision,
                replacement.unwrap_or(false)
            ],
        ))?;
    }
    origin_directory::begin_capture(c, &id)?;
    let mut insert = sql(c.prepare("INSERT INTO scan_manifest_candidate VALUES(?1,?2,?3)"))?;
    for (index, candidate) in candidates.iter().enumerate() {
        if index.is_multiple_of(128) {
            check()?;
        }
        sql(insert.execute(params![id, index as i64, encode(candidate)?]))?;
    }
    let mut category_insert =
        sql(c.prepare("INSERT INTO scan_manifest_category VALUES(?1,?2,?3)"))?;
    for (ordinal, category) in seed["categoryTable"]
        .as_array()
        .ok_or(ERR)?
        .iter()
        .enumerate()
    {
        if ordinal.is_multiple_of(128) {
            check()?;
        }
        sql(category_insert.execute(params![id, ordinal as i64, category.as_str().ok_or(ERR)?]))?;
    }
    check()?;
    Ok(stored(c, &id)?.header)
}
#[cfg(test)]
#[path = "scan_candidate_manifest_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "scan_manifest_presence_tests.rs"]
mod presence_tests;

// This module's parts, by area, are in scan_candidate_manifest/.
mod writes;
pub use writes::*;
mod reads;
pub use reads::*;
