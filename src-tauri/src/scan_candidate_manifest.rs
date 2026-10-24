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
    let exists:bool=sql(c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_manifest_namespace')", [], |r| r.get(0)))?;
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
pub(crate) fn replacement_guard(
    c: &Connection,
    manifest_id: &str,
    context: &Context<'_>,
) -> Result<Option<(Option<String>, Option<String>, bool)>, String> {
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
) -> Result<Option<(Option<String>, Option<String>, bool)>, String> {
    if !sql(c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_manifest_replacement')", [], |r| r.get::<_, bool>(0)))? {
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
    if sql(c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_activation_row')", [], |r| r.get::<_, bool>(0)))? {
        let stale = activation_guard::stale(c, manifest_id)?;
        if stale { return Err("source-snapshot-revision-stale".into()); }
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
        let previous: Value = serde_json::from_str(&raw).map_err(|_| ERR)?;
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
/// Admission proof is private native data. Protection happens after the read transaction ends.
pub struct PreparedPage {
    pub binding: String,
    pub plaintext: Vec<u8>,
    request: Append,
    header: Header,
    url_bytes: u64,
    plain_hash: String,
    origin_rows: Vec<origin_directory::OriginRow>,
}
fn candidate_metadata(c: &Connection, stored: &Stored, ordinal: usize) -> Result<Value, String> {
    candidate_metadata_image(c, stored, ordinal, false).map(|(value, _)| value)
}
fn candidate_metadata_image(
    c: &Connection,
    stored: &Stored,
    ordinal: usize,
    capture_image: bool,
) -> Result<(Value, Option<CandidateImage>), String> {
    let raw: String = sql(c.query_row(
        "SELECT metadata FROM scan_manifest_candidate WHERE manifest_id=?1 AND ordinal=?2",
        params![stored.header.manifest_id, ordinal as i64],
        |r| r.get(0),
    ))?;
    if raw.len() > PAGE_LIMIT {
        return Err(ERR.into());
    }
    let tuple: Value = serde_json::from_str(&raw).map_err(|_| ERR)?;
    let source_index = tuple[1].as_u64().filter(|n| *n < 100).ok_or(ERR)? as usize;
    let category_index = tuple[4].as_u64().filter(|n| *n < 100_000).ok_or(ERR)? as i64;
    let category: String = sql(c.query_row(
        "SELECT contents FROM scan_manifest_category WHERE manifest_id=?1 AND ordinal=?2",
        params![stored.header.manifest_id, category_index],
        |r| r.get(0),
    ))?;
    if category.len() > 16_384 {
        return Err(ERR.into());
    }
    let source = stored.authority["review"]["sources"]
        .as_array()
        .and_then(|sources| sources.get(source_index))
        .ok_or(ERR)?;
    let value = crate::scan_checkpoint::manifest_candidate_parts(
        &tuple,
        &json!(category),
        source,
        &stored.authority["review"]["sessionRevision"],
    )?;
    Ok((
        value,
        capture_image.then(|| CandidateImage {
            ordinal,
            metadata_hash: Sha256::digest(raw.as_bytes()).into(),
            category_index,
            category_hash: Sha256::digest(category.as_bytes()).into(),
        }),
    ))
}
impl Drop for PreparedPage {
    fn drop(&mut self) {
        self.plaintext.zeroize();
        for entry in &mut self.request.entries {
            entry.urls.zeroize();
        }
    }
}
fn binding(
    c: &Connection,
    stored: &Stored,
    metadata: &[Value],
    indices: impl Iterator<Item = usize>,
) -> Result<String, String> {
    let header = &stored.header;
    let namespace: String = sql(c.query_row(
        "SELECT namespace FROM scan_manifest_namespace WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    let bindings: Vec<Value> = metadata
        .iter()
        .zip(indices)
        .map(|(candidate, index)| {
            let definition = stored.authority["sourceDefinitions"]
                .as_array()
                .and_then(|definitions| {
                    definitions
                        .iter()
                        .find(|d| d["source"]["id"] == candidate["sourceId"])
                })
                .ok_or(ERR)?;
            Ok(json!([
                index,
                candidate["key"],
                candidate["sourceId"],
                candidate["sourceFingerprint"],
                definition["definitionFingerprint"],
                candidate["reference"]
            ]))
        })
        .collect::<Result<_, String>>()?;
    let binding = encode(&json!([
        "genx-scan-candidates-v1",
        namespace,
        header.manifest_id,
        header.job_id,
        header.review_digest,
        bindings
    ]))?;
    if binding.len() > BINDING_LIMIT {
        return Err("scan-manifest-binding-limit".into());
    }
    Ok(binding)
}
pub(crate) fn prepare_page(
    c: &Connection,
    request: Append,
    context: &Context<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<PreparedPage, String> {
    check_cas(
        context,
        &request.expected_catalog_revision,
        &request.expected_checkpoint_revision,
    )?;
    let mut raw_bytes = 0usize;
    for entry in &request.entries {
        if entry.urls.is_empty() || entry.urls.len() > 16 {
            return Err("scan-manifest-page-limit".into());
        }
        for url in &entry.urls {
            if url.len() > 16_384 {
                return Err("scan-manifest-page-limit".into());
            }
            raw_bytes = raw_bytes.checked_add(url.len()).ok_or(ERR)?;
            if raw_bytes > PAGE_LIMIT {
                return Err("scan-manifest-page-limit".into());
            }
        }
    }
    if request.entries.is_empty()
        || request.entries.len() > 64
        || encode(&request)?.len() > PAGE_LIMIT
    {
        return Err("scan-manifest-page-limit".into());
    }
    let old = stored(c, &request.manifest_id)?;
    authority(c, &old, context)?;
    if old.state != 0 || old.header.manifest_revision != request.expected_manifest_revision {
        return Err("scan-manifest-revision-stale".into());
    }
    let mut metadata = Vec::new();
    let mut url_bytes = 0u64;
    for (offset, entry) in request.entries.iter().enumerate() {
        check()?;
        if entry.candidate_index != old.header.next_index + offset
            || entry.candidate_index >= old.header.candidate_count
        {
            return Err("scan-manifest-order-invalid".into());
        }
        let candidate = candidate_metadata(c, &old, entry.candidate_index)?;
        crate::scan_checkpoint::manifest_urls(&candidate, &entry.urls)?;
        url_bytes += entry.urls.iter().map(|u| u.len() as u64).sum::<u64>();
        metadata.push(candidate);
    }
    if old.url_bytes + url_bytes > URL_LIMIT {
        return Err("scan-manifest-url-limit".into());
    }
    let binding = binding(
        c,
        &old,
        &metadata,
        request.entries.iter().map(|entry| entry.candidate_index),
    )?;
    let plaintext = encode(&request.entries)?.into_bytes();
    if plaintext.len() > PAGE_LIMIT {
        return Err("scan-manifest-page-limit".into());
    }
    let plain_hash = digest(&plaintext);
    let origin_rows = origin_directory::derive_rows(&metadata, &request.entries)?;
    Ok(PreparedPage {
        binding,
        plaintext,
        request,
        header: old.header,
        url_bytes,
        plain_hash,
        origin_rows,
    })
}
pub(crate) fn append_page(
    c: &Connection,
    prepared: &PreparedPage,
    ciphertext: &[u8],
    context: &Context<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Header, String> {
    check()?;
    check_cas(
        context,
        &prepared.request.expected_catalog_revision,
        &prepared.request.expected_checkpoint_revision,
    )?;
    let old = stored(c, &prepared.header.manifest_id)?;
    authority(c, &old, context)?;
    if old.state != 0
        || old.header.manifest_revision != prepared.header.manifest_revision
        || old.header.next_index != prepared.header.next_index
    {
        return Err("scan-manifest-revision-stale".into());
    }
    if digest(&prepared.plaintext) != prepared.plain_hash
        || crate::scan_checkpoint::revision(&old.header.manifest_revision)? == i64::MAX
    {
        return Err(ERR.into());
    }
    if ciphertext.is_empty()
        || ciphertext.len() > CIPHER_PAGE_LIMIT
        || old.cipher_bytes + ciphertext.len() as u64 > CIPHER_LIMIT
    {
        return Err("scan-manifest-cipher-limit".into());
    }
    sql(c.execute(
        "INSERT INTO scan_manifest_page VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            old.header.manifest_id,
            old.header.next_index as i64,
            prepared.request.entries.len() as i64,
            prepared.binding,
            prepared.plain_hash,
            ciphertext
        ],
    ))?;
    sql(c.execute("UPDATE scan_manifest SET revision=revision+1,next_index=next_index+?1,url_bytes=url_bytes+?2,cipher_bytes=cipher_bytes+?3 WHERE id=?4",params![prepared.request.entries.len() as i64,prepared.url_bytes as i64,ciphertext.len() as i64,old.header.manifest_id]))?;
    origin_directory::append_capture(c, &old.header.manifest_id, &prepared.origin_rows)?;
    check()?;
    Ok(stored(c, &old.header.manifest_id)?.header)
}
pub(crate) fn seal_seed(
    c: &Connection,
    request: &Seal,
    context: &Context<'_>,
) -> Result<String, String> {
    let old = seal_metadata(c, request, context)?;
    let seed: String = sql(c.query_row(
        "SELECT seed FROM scan_manifest WHERE id=?1",
        [&old.header.manifest_id],
        |r| r.get(0),
    ))?;
    if seed.len() > 20 * 1024 * 1024 {
        return Err(ERR.into());
    }
    Ok(seed)
}
fn seal_metadata(c: &Connection, request: &Seal, context: &Context<'_>) -> Result<Stored, String> {
    check_cas(
        context,
        &request.expected_catalog_revision,
        &request.expected_checkpoint_revision,
    )?;
    let old = stored(c, &request.manifest_id)?;
    authority(c, &old, context)?;
    if old.state != 0 || old.header.manifest_revision != request.expected_manifest_revision {
        return Err("scan-manifest-revision-stale".into());
    }
    if old.header.next_index != old.header.candidate_count {
        return Err("scan-manifest-incomplete".into());
    }
    let mut pages=sql(c.prepare("SELECT start_index,item_count FROM scan_manifest_page WHERE manifest_id=?1 ORDER BY start_index"))?;
    let rows = sql(pages.query_map([&request.manifest_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
    }))?;
    let mut covered = 0;
    for row in rows {
        let (start, count) = sql(row)?;
        if start != covered || count <= 0 || count > 64 {
            return Err("scan-manifest-incomplete".into());
        }
        covered += count;
    }
    if covered != old.header.candidate_count as i64 {
        return Err("scan-manifest-incomplete".into());
    }
    Ok(old)
}
pub(crate) fn seal(c: &Connection, request: &Seal) -> Result<(), String> {
    let revision = crate::scan_checkpoint::revision(&request.expected_manifest_revision)?;
    if revision == i64::MAX {
        return Err("scan-manifest-revision-stale".into());
    }
    if sql(c.execute("UPDATE scan_manifest SET state=1,revision=revision+1 WHERE id=?1 AND state=0 AND revision=?2",params![request.manifest_id,revision]))?!=1{return Err("scan-manifest-revision-stale".into());}
    Ok(())
}
fn current_job(
    c: &Connection,
    context: &Context<'_>,
    job: &str,
    digest: &str,
) -> Result<(), String> {
    let _ = context;
    let (current, present): (Option<String>, bool) = sql(c.query_row(
        "SELECT job_id,typeof(contents)!='null' FROM scan_checkpoint WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    if !present || current.as_deref() != Some(job) || digest.len() != 64 {
        return Err("scan-manifest-job-stale".into());
    }
    Ok(())
}
pub(crate) fn find(c: &Connection, request: &Find, context: &Context<'_>) -> Result<Found, String> {
    check_cas(
        context,
        &request.expected_catalog_revision,
        &request.expected_checkpoint_revision,
    )?;
    current_job(c, context, &request.job_id, &request.review_digest)?;
    if !present(c)? {
        return Ok(Found {
            schema_version: 1,
            status: "absent",
            header: None,
        });
    }
    let id = sql(c
        .query_row(
            "SELECT id FROM scan_manifest WHERE job_id=?1 AND review_digest=?2 AND state=1",
            params![request.job_id, request.review_digest],
            |r| r.get::<_, String>(0),
        )
        .optional())?;
    let Some(id) = id else {
        return Ok(Found {
            schema_version: 1,
            status: "absent",
            header: None,
        });
    };
    let old = stored(c, &id)?;
    authority(c, &old, context)?;
    Ok(Found {
        schema_version: 1,
        status: "sealed",
        header: Some(old.header),
    })
}
pub struct EncryptedPage {
    pub binding: String,
    pub ciphertext: Vec<u8>,
    header: Header,
    start_index: usize,
    count: usize,
    plain_hash: String,
    metadata: Vec<Value>,
    images: Vec<CandidateImage>,
    namespace: String,
    authority_hash: [u8; 32],
}
struct CandidateImage {
    ordinal: usize,
    metadata_hash: [u8; 32],
    category_index: i64,
    category_hash: [u8; 32],
}
// Private complete image proof; only a fully authenticated cached page may retain it.
pub(crate) struct ReadIdentity {
    header: Header,
    start_index: usize,
    count: usize,
    binding: String,
    plain_hash: String,
    ciphertext: Zeroizing<Vec<u8>>,
    images: Vec<CandidateImage>,
    namespace: String,
    authority_hash: [u8; 32],
}
impl EncryptedPage {
    pub(crate) fn take_identity(&mut self) -> ReadIdentity {
        ReadIdentity {
            header: self.header.clone(),
            start_index: self.start_index,
            count: self.count,
            binding: self.binding.clone(),
            plain_hash: self.plain_hash.clone(),
            ciphertext: Zeroizing::new(self.ciphertext.clone()),
            images: std::mem::take(&mut self.images),
            namespace: self.namespace.clone(),
            authority_hash: self.authority_hash,
        }
    }
}
pub(crate) fn read_page(
    c: &Connection,
    request: &Read,
    context: &Context<'_>,
) -> Result<EncryptedPage, String> {
    if request.start_index >= 100_000 {
        return Err("scan-manifest-order-invalid".into());
    }
    check_cas(
        context,
        &request.expected_catalog_revision,
        &request.expected_checkpoint_revision,
    )?;
    current_job(c, context, &request.job_id, &request.review_digest)?;
    let old = stored(c, &request.manifest_id)?;
    authority(c, &old, context)?;
    if old.state != 1
        || old.header.job_id != request.job_id
        || old.header.review_digest != request.review_digest
    {
        return Err("scan-manifest-job-stale".into());
    }
    let (count,binding,plain_hash,ciphertext)=sql(c.query_row("SELECT item_count,binding,plain_hash,ciphertext FROM scan_manifest_page WHERE manifest_id=?1 AND start_index=?2",params![request.manifest_id,request.start_index as i64],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Vec<u8>>(3)?))).optional())?.ok_or("scan-manifest-page-absent")?;
    if count <= 0
        || count > 64
        || binding.len() > BINDING_LIMIT
        || ciphertext.is_empty()
        || ciphertext.len() > CIPHER_PAGE_LIMIT
    {
        return Err(ERR.into());
    }
    let count = count as usize;
    let mut metadata = Vec::with_capacity(count);
    let mut images = Vec::with_capacity(count);
    for ordinal in request.start_index..request.start_index + count {
        let (value, image) = candidate_metadata_image(c, &old, ordinal, true)?;
        metadata.push(value);
        images.push(image.ok_or(ERR)?);
    }
    if self::binding(
        c,
        &old,
        &metadata,
        request.start_index..request.start_index + count,
    )? != binding
    {
        return Err("scan-manifest-binding-mismatch".into());
    }
    Ok(EncryptedPage {
        binding,
        ciphertext,
        header: old.header,
        start_index: request.start_index,
        count,
        plain_hash,
        metadata,
        images,
        namespace: sql(c.query_row(
            "SELECT namespace FROM scan_manifest_namespace WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?,
        authority_hash: Sha256::digest(encode(&old.authority)?.as_bytes()).into(),
    })
}
pub(crate) fn verify_read(
    c: &Connection,
    request: &Read,
    context: &Context<'_>,
    page: &EncryptedPage,
) -> Result<(), String> {
    check_cas(
        context,
        &request.expected_catalog_revision,
        &request.expected_checkpoint_revision,
    )?;
    current_job(c, context, &request.job_id, &request.review_digest)?;
    let old = stored(c, &request.manifest_id)?;
    authority(c, &old, context)?;
    if old.state != 1
        || old.header.manifest_revision != page.header.manifest_revision
        || old.header.manifest_id != page.header.manifest_id
    {
        return Err("scan-manifest-revision-stale".into());
    }
    Ok(())
}
// A cache hit still reads all relevant bytes in the current SQL snapshot. It
// avoids decrypting/parsing/rebuilding the page; it is not an O(1) index proof.
pub(crate) fn verify_cached_read(
    c: &Connection,
    request: &Read,
    context: &Context<'_>,
    image: &ReadIdentity,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    check()?;
    check_cas(
        context,
        &request.expected_catalog_revision,
        &request.expected_checkpoint_revision,
    )?;
    current_job(c, context, &request.job_id, &request.review_digest)?;
    let old = stored(c, &request.manifest_id)?;
    authority(c, &old, context)?;
    if old.state != 1
        || encode(&old.header)? != encode(&image.header)?
        || Sha256::digest(encode(&old.authority)?.as_bytes()).as_slice() != image.authority_hash
    {
        return Err("scan-manifest-revision-stale".into());
    }
    let namespace: String = sql(c.query_row(
        "SELECT namespace FROM scan_manifest_namespace WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    if namespace != image.namespace {
        return Err("scan-manifest-binding-mismatch".into());
    }
    let exact:bool=sql(c.query_row("SELECT EXISTS(SELECT 1 FROM scan_manifest_page WHERE manifest_id=?1 AND start_index=?2 AND item_count=?3 AND binding COLLATE BINARY=?4 AND plain_hash COLLATE BINARY=?5 AND ciphertext=?6)",
        params![request.manifest_id,image.start_index as i64,image.count as i64,image.binding,image.plain_hash,image.ciphertext.as_slice()],|r|r.get(0)))?;
    if !exact {
        return Err("scan-manifest-authentication-failed".into());
    }
    let mut statement=sql(c.prepare("SELECT ordinal,metadata FROM scan_manifest_candidate WHERE manifest_id=?1 AND ordinal>=?2 AND ordinal<?3 ORDER BY ordinal"))?;
    let mut rows = sql(statement.query(params![
        request.manifest_id,
        image.start_index as i64,
        (image.start_index + image.count) as i64
    ]))?;
    for expected in &image.images {
        check()?;
        let row = sql(rows.next())?.ok_or("scan-manifest-binding-mismatch")?;
        let ordinal: i64 = sql(row.get(0))?;
        let raw: String = sql(row.get(1))?;
        if ordinal != expected.ordinal as i64
            || raw.len() > PAGE_LIMIT
            || Sha256::digest(raw.as_bytes()).as_slice() != expected.metadata_hash
        {
            return Err("scan-manifest-binding-mismatch".into());
        }
    }
    if sql(rows.next())?.is_some() || image.images.len() != image.count {
        return Err("scan-manifest-binding-mismatch".into());
    }
    let mut categories = std::collections::BTreeMap::new();
    for expected in &image.images {
        if categories
            .insert(expected.category_index, expected.category_hash)
            .is_some_and(|previous| previous != expected.category_hash)
        {
            return Err("scan-manifest-binding-mismatch".into());
        }
    }
    let placeholders = (2..=categories.len() + 1)
        .map(|n| format!("?{n}"))
        .collect::<Vec<_>>()
        .join(",");
    let query=format!("SELECT ordinal,contents FROM scan_manifest_category WHERE manifest_id=?1 AND ordinal IN({placeholders}) ORDER BY ordinal");
    let mut args = vec![rusqlite::types::Value::Text(request.manifest_id.clone())];
    args.extend(
        categories
            .keys()
            .map(|index| rusqlite::types::Value::Integer(*index)),
    );
    let mut statement = sql(c.prepare(&query))?;
    let mut rows = sql(statement.query(rusqlite::params_from_iter(args)))?;
    for (index, hash) in categories {
        check()?;
        let row = sql(rows.next())?.ok_or("scan-manifest-binding-mismatch")?;
        let ordinal: i64 = sql(row.get(0))?;
        let raw: String = sql(row.get(1))?;
        if ordinal != index
            || raw.len() > 16384
            || Sha256::digest(raw.as_bytes()).as_slice() != hash
        {
            return Err("scan-manifest-binding-mismatch".into());
        }
    }
    if sql(rows.next())?.is_some() {
        return Err("scan-manifest-binding-mismatch".into());
    }
    check()
}
pub fn finish_page(page: EncryptedPage, plaintext: Vec<u8>) -> Result<Page, String> {
    Ok(finish_page_authenticated(page, plaintext)?.into_legacy())
}
/// Native-only result after exact plaintext/binding/URL metadata validation.
/// Root must additionally finish the same-generation SQL verify_read before delivery.
pub(crate) struct AuthenticatedPage {
    pub page: Page,
    pub metadata: Vec<Value>,
}
impl AuthenticatedPage {
    pub(crate) fn selected(&self, index: usize) -> Result<Self, String> {
        let offset = index
            .checked_sub(self.page.start_index)
            .ok_or("scan-resume-page-invalid")?;
        let entry = self
            .page
            .entries
            .get(offset)
            .ok_or("scan-resume-page-invalid")?;
        let metadata = self
            .metadata
            .get(offset)
            .ok_or("scan-resume-page-invalid")?;
        if entry.candidate_index != index {
            return Err("scan-resume-page-invalid".into());
        }
        Ok(Self {
            page: Page {
                schema_version: self.page.schema_version,
                manifest_id: self.page.manifest_id.clone(),
                job_id: self.page.job_id.clone(),
                review_digest: self.page.review_digest.clone(),
                manifest_revision: self.page.manifest_revision.clone(),
                start_index: index,
                next_index: index + 1,
                entries: vec![entry.clone()],
            },
            metadata: vec![metadata.clone()],
        })
    }
    fn into_legacy(mut self) -> Page {
        std::mem::replace(
            &mut self.page,
            Page {
                schema_version: 1,
                manifest_id: String::new(),
                job_id: String::new(),
                review_digest: String::new(),
                manifest_revision: String::new(),
                start_index: 0,
                next_index: 0,
                entries: Vec::new(),
            },
        )
    }
}
impl Drop for AuthenticatedPage {
    fn drop(&mut self) {
        for entry in &mut self.page.entries {
            for url in &mut entry.urls {
                url.zeroize();
            }
        }
    }
}
pub(crate) fn finish_page_authenticated(
    page: EncryptedPage,
    plaintext: Vec<u8>,
) -> Result<AuthenticatedPage, String> {
    let plaintext = Zeroizing::new(plaintext);
    if plaintext.len() > PAGE_LIMIT || digest(&plaintext) != page.plain_hash {
        return Err("scan-manifest-authentication-failed".into());
    }
    let entries: Vec<Entry> = serde_json::from_slice(&plaintext).map_err(|_| ERR)?;
    if entries.len() != page.count
        || entries
            .iter()
            .enumerate()
            .any(|(i, e)| e.candidate_index != page.start_index + i)
    {
        return Err(ERR.into());
    }
    for (entry, metadata) in entries.iter().zip(&page.metadata) {
        crate::scan_checkpoint::manifest_urls(metadata, &entry.urls)?;
    }
    let result = Page {
        schema_version: 1,
        manifest_id: page.header.manifest_id,
        job_id: page.header.job_id,
        review_digest: page.header.review_digest,
        manifest_revision: page.header.manifest_revision,
        start_index: page.start_index,
        next_index: page.start_index + entries.len(),
        entries,
    };
    if encode(&result)?.len() > PAGE_LIMIT {
        return Err("scan-manifest-page-limit".into());
    }
    Ok(AuthenticatedPage {
        page: result,
        metadata: page.metadata,
    })
}
pub(crate) fn discard_job(c: &Connection, job: Option<&str>) -> Result<(), String> {
    if present(c)? {
        if let Some(job) = job {
            sql(c.execute("DELETE FROM scan_manifest WHERE job_id=?1", [job]))?;
        }
    }
    Ok(())
}
pub(crate) fn bind_checkpoint(
    c: &Connection,
    job: Option<&str>,
    digest: Option<&str>,
) -> Result<(), String> {
    if present(c)? {
        match (job, digest) {
            (Some(job), Some(digest)) => {
                sql(c.execute(
                    "DELETE FROM scan_manifest WHERE state=1 AND (job_id<>?1 OR review_digest<>?2)",
                    params![job, digest],
                ))?;
            }
            _ => {
                sql(c.execute("DELETE FROM scan_manifest WHERE state=1", []))?;
            }
        }
    }
    Ok(())
}
#[cfg(test)]
#[path = "scan_candidate_manifest_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "scan_manifest_presence_tests.rs"]
mod presence_tests;
