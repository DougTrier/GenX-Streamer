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

//! A title's files: listing, resolving and verifying them, removing missing
//! ones, and download progress.

use super::*;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilesQuery {
    pub schema_version: u32,
    pub request_id: String,
    pub title_ref: String,
    pub expected_revision: String,
    pub offset: usize,
    pub page_size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    pub file_ref: String,
    pub title: String,
    pub file_name: String,
    pub item_id: String,
    pub format: String,
    pub duration_seconds: Option<f64>,
    pub size_bytes: Option<String>,
    pub availability: &'static str,
    pub observed_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_facts: Option<crate::archive_provider_catalog::Facts>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesPage {
    pub schema_version: u32,
    pub revision: String,
    pub title_ref: String,
    pub total_count: usize,
    pub offset: usize,
    pub files: Vec<FileRow>,
    pub more: bool,
}

pub(crate) fn files(
    c: &Connection,
    q: &FilesQuery,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<FilesPage, String> {
    query_valid(q.schema_version, &q.request_id, q.offset, q.page_size, 1000)?;
    if !hex_ref(&q.title_ref) {
        return Err("archive-query-invalid".into());
    }
    if crate::archive_provider_catalog::title_exists(c, &q.title_ref)? {
        return crate::archive_provider_catalog::files(c, q, check);
    }
    let tx = sql(c.unchecked_transaction())?;
    let rev = current(&tx)?;
    if revision(&q.expected_revision)? != rev {
        return Err("archive-revision-stale".into());
    }
    let total: i64 = sql(tx.query_row(
        "SELECT count(*) FROM archive_file_v1 WHERE title_ref=?1 AND eligible=1",
        [&q.title_ref],
        |r| r.get(0),
    ))?;
    if !(0..=1000).contains(&total) {
        return Err("archive-file-limit".into());
    }
    let mut stmt=sql(tx.prepare("SELECT f.file_ref,f.file_title,f.file_name,f.item_id,f.duration_seconds,f.size_bytes,f.observed_ms FROM archive_file_v1 f JOIN archive_title_v1 t ON t.title_ref=f.title_ref WHERE f.title_ref=?1 AND f.eligible=1 ORDER BY f.file_name LIMIT ?2 OFFSET ?3"))?;
    let mut rows = sql(stmt.query(params![q.title_ref, q.page_size as i64, q.offset as i64]))?;
    let mut files = Vec::new();
    while let Some(r) = sql(rows.next())? {
        check()?;
        let file_name: String = sql(r.get(2))?;
        let metadata_title: Option<String> = sql(r.get(1))?;
        let title = metadata_title
            .filter(|s| text(s, 512))
            .unwrap_or_else(|| file_name_label(&file_name));
        files.push(FileRow {
            file_ref: sql(r.get(0))?,
            title,
            file_name,
            item_id: sql(r.get(3))?,
            duration_seconds: sql(r.get(4))?,
            size_bytes: Some(sql(r.get(5))?),
            provider_facts: None,
            observed_ms: sql(r.get(6))?,
            format: "h.264".into(),
            availability: "unverified",
        });
    }
    drop(rows);
    drop(stmt);
    check()?;
    sql(tx.commit())?;
    Ok(FilesPage {
        schema_version: 1,
        revision: rev.to_string(),
        title_ref: q.title_ref.clone(),
        total_count: total as usize,
        offset: q.offset,
        more: q.offset + files.len() < total as usize,
        files,
    })
}

pub(crate) fn file_name_label(name: &str) -> String {
    if name.len() <= 512 {
        return name.to_owned();
    }
    // Keep the filename suffix visible when a long provider directory dominates.
    // This changes presentation only; the exact file identity is retained.
    let mut prefix = 384;
    while !name.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let mut suffix = name.len() - 125;
    while !name.is_char_boundary(suffix) {
        suffix += 1;
    }
    format!("{}…{}", &name[..prefix], &name[suffix..])
}

pub(crate) fn hex_ref(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadReceipt {
    pub schema_version: u32,
    pub committed: bool,
    pub revision: String,
    pub confirmed_dead: usize,
    pub title_count: usize,
}

pub(crate) fn remove_confirmed_missing(
    c: &mut Connection,
    file_ref: &str,
    expected: &str,
    evidence: &crate::archive_discovery::MissingEvidence,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<DeadReceipt, String> {
    if !hex_ref(file_ref) || !evidence.fresh() {
        return Err("archive-dead-proof-invalid".into());
    }
    check()?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let rev = current(&tx)?;
    if rev != revision(expected)? {
        return Err("archive-revision-stale".into());
    }
    if rev == i64::MAX {
        return Err("archive-revision-exhausted".into());
    }
    let row: Option<(String, String)> = sql(tx
        .query_row(
            "SELECT item_id,file_name FROM archive_file_v1 WHERE file_ref=?1",
            [file_ref],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional())?;
    let count = if let Some((item, name)) = row {
        if !evidence.matches(&item, &name) {
            return Err("archive-dead-proof-invalid".into());
        }
        sql(tx.execute("DELETE FROM archive_file_v1 WHERE file_ref=?1", [file_ref]))?
    } else {
        0
    };
    if count > 0 {
        sql(tx.execute("DELETE FROM archive_title_v1 WHERE NOT EXISTS(SELECT 1 FROM archive_file_v1 f WHERE f.title_ref=archive_title_v1.title_ref AND f.eligible=1)",[]))?;
        sql(tx.execute(
            "UPDATE archive_catalog_meta_v1 SET revision=revision+1 WHERE singleton=1",
            [],
        ))?;
    }
    let total: i64 = sql(tx.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r.get(0)))?;
    check()?;
    if !evidence.fresh() {
        return Err("archive-dead-proof-invalid".into());
    }
    crate::archive_library_store::finalize(&tx, false, check)?;
    check()?;
    if !evidence.fresh() {
        return Err("archive-dead-proof-invalid".into());
    }
    sql(tx.commit())?;
    Ok(DeadReceipt {
        schema_version: 1,
        committed: true,
        revision: (rev + i64::from(count > 0)).to_string(),
        confirmed_dead: count,
        title_count: total as usize,
    })
}

/// Native-only file authority for the future playback owner, never bridge data.
pub(crate) struct ResolvedFile {
    pub item_id: String,
    pub file_name: String,
    pub size_bytes: String,
    pub sha1: Option<String>,
    pub servers: Vec<String>,
    pub duration_seconds: Option<f64>,
    pub provider_index: Option<u32>,
    pub public: Option<crate::archive_provider_catalog::Resolved>,
}

pub(crate) fn resolve(
    c: &Connection,
    file_ref: &str,
    expected: &str,
) -> Result<ResolvedFile, String> {
    if !hex_ref(file_ref) {
        return Err("archive-file-invalid".into());
    }
    let tx = sql(c.unchecked_transaction())?;
    if current(&tx)? != revision(expected)? {
        return Err("archive-revision-stale".into());
    }
    let file = read_resolved(&tx, file_ref)?;
    sql(tx.commit())?;
    Ok(file)
}

/// Capture exact eligible file and its actual display metadata in one snapshot.
/// Download persistence remains independent of later provider-row deletion.
pub(crate) fn resolve_download(
    c: &Connection,
    file_ref: &str,
    expected: &str,
) -> Result<(ResolvedFile, String, String, String), String> {
    if !hex_ref(file_ref) {
        return Err("archive-file-invalid".into());
    }
    let tx = sql(c.unchecked_transaction())?;
    if current(&tx)? != revision(expected)? {
        return Err("archive-revision-stale".into());
    }
    let file = read_resolved(&tx, file_ref)?;
    if file.public.is_some() {
        return Err("public-archive-download-unsupported".into());
    }
    let (title_ref, title, file_title) = sql(tx.query_row(
        "SELECT t.title_ref,t.title,COALESCE(f.file_title,f.file_name) FROM archive_file_v1 f JOIN archive_title_v1 t ON t.title_ref=f.title_ref WHERE f.file_ref=?1",
        [file_ref], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    ))?;
    sql(tx.commit())?;
    Ok((file, title_ref, title, file_title))
}

pub(super) fn read_resolved(c: &Connection, file_ref: &str) -> Result<ResolvedFile, String> {
    if crate::archive_provider_catalog::file_exists(c, file_ref)? {
        return crate::archive_provider_catalog::resolve(c, file_ref);
    }
    if removed(c, "file", file_ref)? {
        return Err("archive-file-unavailable".into());
    }
    let raw:(String,String,String,Option<String>,String,Option<f64>,Option<u32>)=sql(c.query_row("SELECT item_id,file_name,size_bytes,sha1,servers,duration_seconds,provider_index FROM archive_file_v1 WHERE file_ref=?1 AND eligible=1 AND format='h.264'",[file_ref],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional())?.ok_or("archive-file-unavailable")?;
    if removed(c, "title", &opaque(&["archive-item-v1", &raw.0]))? {
        return Err("archive-file-unavailable".into());
    }
    let servers: Vec<String> = serde_json::from_str(&raw.4).map_err(|_| "archive-file-invalid")?;
    if !text(&raw.0, 100)
        || !raw
            .0
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || !text(&raw.1, 1024)
        || raw.1.starts_with('/')
        || raw.1.contains('\\')
        || raw
            .1
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
        || opaque(&["archive-file-v1", &raw.0, &raw.1]) != file_ref
        || raw
            .2
            .parse::<u64>()
            .ok()
            .is_none_or(|n| n == 0 || n > 64 * 1024 * 1024 * 1024)
        || servers.len() > 3
        || servers.iter().any(|s| {
            s.len() > 253
                || !s.starts_with("ia")
                || !s.ends_with(".archive.org")
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        })
    {
        return Err("archive-file-invalid".into());
    }
    Ok(ResolvedFile {
        item_id: raw.0,
        file_name: raw.1,
        size_bytes: raw.2,
        sha1: raw.3,
        servers,
        duration_seconds: raw.5,
        provider_index: raw.6,
        public: None,
    })
}

pub(crate) fn verify_live(
    c: &Connection,
    file_ref: &str,
    expected: &ResolvedFile,
) -> Result<(), String> {
    if !hex_ref(file_ref) {
        return Err("archive-file-invalid".into());
    }
    if let Some(public) = &expected.public {
        return crate::archive_provider_catalog::verify_live(c, file_ref, public);
    }
    let live = read_resolved(c, file_ref)?;
    if live.public.is_some()
        || live.item_id != expected.item_id
        || live.file_name != expected.file_name
        || live.size_bytes != expected.size_bytes
        || live.sha1 != expected.sha1
        || live.servers != expected.servers
    {
        return Err("archive-file-changed".into());
    }
    Ok(())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgressQuery {
    #[serde(default)]
    pub decade: Option<i64>,
    pub schema_version: u32,
    pub request_id: String,
    pub query: String,
    pub year: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressReply {
    pub schema_version: u32,
    pub revision: String,
    pub year: Option<i64>,
    pub next_page: u32,
    pub complete: bool,
    pub capacity_reached: bool,
    pub retry_after_ms: Option<i64>,
    pub title_count: usize,
}

pub(crate) fn progress(c: &Connection, q: &ProgressQuery) -> Result<ProgressReply, String> {
    if q.schema_version != 1
        || !valid_decade(q.decade)
        || q.year
            .zip(q.decade)
            .is_some_and(|(y, d)| !(d..=d + 9).contains(&y))
        || !text(&q.request_id, 256)
        || q.query.len() > 256
        || q.query.chars().any(char::is_control)
        || q.year.is_some_and(|y| !(1960..=1999).contains(&y))
        || (q.year.is_none() && q.query.trim().is_empty())
    {
        return Err("archive-query-invalid".into());
    }
    let tx = sql(c.unchecked_transaction())?;
    let rev = current(&tx)?;
    let hash = search_scope_hash(&q.query, q.decade);
    let saved: Option<(u32, bool, Option<i64>)> = sql(tx
        .query_row(
            "SELECT next_page,complete,retry_after_ms FROM archive_progress_v1 WHERE year=?1 AND query_hash=?2",
            params![q.year.unwrap_or(0), hash],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional())?;
    let (next, complete, retry) = saved.unwrap_or((1, false, None));
    let count: i64 = sql(tx.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r.get(0)))?;
    if !(0..=1400).contains(&count) {
        return Err("archive-title-limit".into());
    }
    sql(tx.commit())?;
    Ok(ProgressReply {
        schema_version: 1,
        revision: rev.to_string(),
        year: q.year,
        next_page: next,
        complete,
        capacity_reached: next == 21 && !complete,
        retry_after_ms: retry,
        title_count: count as usize,
    })
}
