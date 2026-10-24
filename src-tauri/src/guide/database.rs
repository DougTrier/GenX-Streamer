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

//! Normalized guide persistence. Caller owns local SQLite policy, backups and blocking execution.
use super::parser::{GuideProgram, ParsedGuide};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    sync::atomic::{AtomicBool, Ordering},
};
use unicode_normalization::UnicodeNormalization;
const WEEK: i64 = 7 * 24 * 60 * 60 * 1000;
const SCHEMA: &str = "
CREATE TABLE guide_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL);
INSERT INTO guide_meta VALUES(1,0);
CREATE TABLE guide_source(id TEXT PRIMARY KEY,name TEXT NOT NULL,location TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('url','file')),allow_http INTEGER NOT NULL CHECK(allow_http IN(0,1)),revision INTEGER NOT NULL,updated_ms INTEGER,published_revision INTEGER);
CREATE TABLE guide_channel(guide_source_id TEXT NOT NULL REFERENCES guide_source(id) ON DELETE CASCADE,id TEXT NOT NULL,names_json TEXT NOT NULL,search_names TEXT NOT NULL,PRIMARY KEY(guide_source_id,id));
CREATE TABLE guide_program(guide_source_id TEXT NOT NULL,ordinal INTEGER NOT NULL,channel_id TEXT NOT NULL,start_ms INTEGER NOT NULL,stop_ms INTEGER,title TEXT NOT NULL,description TEXT,search_text TEXT NOT NULL,categories_json TEXT NOT NULL DEFAULT '[]',categories_key TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(guide_source_id,ordinal),FOREIGN KEY(guide_source_id,channel_id) REFERENCES guide_channel(guide_source_id,id) ON DELETE CASCADE,CHECK(stop_ms IS NULL OR stop_ms>start_ms));
CREATE INDEX guide_program_channel_time ON guide_program(guide_source_id,channel_id,start_ms,ordinal);
CREATE INDEX guide_program_source_time ON guide_program(guide_source_id,start_ms,ordinal);
CREATE INDEX guide_program_global_time ON guide_program(start_ms,guide_source_id,ordinal);
CREATE TABLE guide_mapping(catalog_source_id TEXT NOT NULL,app_channel_id TEXT NOT NULL,guide_source_id TEXT NOT NULL,xmltv_channel_id TEXT NOT NULL,PRIMARY KEY(catalog_source_id,app_channel_id));
CREATE INDEX guide_mapping_target ON guide_mapping(guide_source_id,xmltv_channel_id,app_channel_id);
PRAGMA user_version=2;";
pub(super) fn sql<T>(value: rusqlite::Result<T>) -> Result<T, String> {
    value.map_err(|error| {
        crate::storage_transaction::sql_error_code(&error, "guide-database-operation-failed")
    })
}
fn normalized(value: &str) -> String {
    value.nfkc().collect::<String>().to_lowercase()
}
fn tokens(value: &str) -> Vec<String> {
    static TOKEN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    TOKEN
        .get_or_init(|| regex::Regex::new(r"[\p{L}\p{N}]+").expect("constant token expression"))
        .find_iter(&normalized(value))
        .map(|m| m.as_str().to_owned())
        .collect()
}
pub(super) fn key(value: impl Serialize) -> Result<String, String> {
    let bytes = serde_json::to_vec(&value).map_err(|_| "guide-invalid-query")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCoverage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mapped_targets: Option<super::refresh::MappedTargets>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projection_compatible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projection_interest_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projection: Option<super::retention::Status>,
    pub source_revision: i64,
    pub published_revision: Option<i64>,
    pub channel_count: i64,
    pub program_count: i64,
    pub first_start_ms: Option<i64>,
    pub last_start_ms: Option<i64>,
    pub last_stop_ms: Option<i64>,
    pub unknown_end_count: i64,
}
pub fn source_coverage(c: &Connection, id: &str) -> Result<SourceCoverage, String> {
    valid_text(id, 256, true)?;
    let mut result=sql(c.query_row("SELECT revision,published_revision,(SELECT count(*) FROM guide_channel WHERE guide_source_id=s.id),(SELECT count(*) FROM guide_program WHERE guide_source_id=s.id),(SELECT min(start_ms) FROM guide_program WHERE guide_source_id=s.id),(SELECT max(start_ms) FROM guide_program WHERE guide_source_id=s.id),(SELECT max(stop_ms) FROM guide_program WHERE guide_source_id=s.id),(SELECT count(*) FROM guide_program WHERE guide_source_id=s.id AND stop_ms IS NULL) FROM guide_source s WHERE id=?1",[id],|r|Ok(SourceCoverage{mapped_targets:None,projection_compatible:None,projection_interest_count:None,projection:None,source_revision:r.get(0)?,published_revision:r.get(1)?,channel_count:r.get(2)?,program_count:r.get(3)?,first_start_ms:r.get(4)?,last_start_ms:r.get(5)?,last_stop_ms:r.get(6)?,unknown_end_count:r.get(7)?})))?;
    result.projection = super::retention::status(c, id)?;
    Ok(result)
}
fn cancel(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::Acquire) {
        Err("guide-cancelled".into())
    } else {
        Ok(())
    }
}
pub(super) fn valid_text(value: &str, max: usize, nonempty: bool) -> Result<(), String> {
    if value.len() > max
        || nonempty && value.trim().is_empty()
        || value
            .chars()
            .any(|c| c < ' ' && !matches!(c, '\t' | '\n' | '\r'))
    {
        return Err("guide-invalid-field".into());
    }
    Ok(())
}
pub(super) fn valid_time(value: i64) -> Result<(), String> {
    if !(-62_135_647_200_000..=253_402_351_200_000).contains(&value) {
        Err("guide-invalid-instant".into())
    } else {
        Ok(())
    }
}
pub(crate) fn add_category_columns(c: &Connection) -> Result<(), String> {
    let mut statement = sql(c.prepare("PRAGMA table_info(guide_program)"))?;
    let columns = sql(statement.query_map([], |r| r.get::<_, String>(1)))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "guide-database-operation-failed")?;
    for column in ["categories_json", "categories_key"] {
        if !columns.iter().any(|v| v == column) {
            sql(c.execute_batch(&format!(
                "ALTER TABLE guide_program ADD COLUMN {column} TEXT NOT NULL DEFAULT '[]'"
            )))?;
        }
    }
    Ok(())
}
pub fn migrate(connection: &mut Connection) -> Result<(), String> {
    let version: i64 = sql(connection.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
    if (2..=4).contains(&version) {
        return Ok(());
    }
    if version != 1 {
        return Err("sqlite-unsupported-schema".into());
    }
    let tx = sql(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    sql(tx.execute_batch(SCHEMA))?;
    sql(tx.commit())
}
/// Called after the catalog owner's v3 geography migration. Backfill and version marker are one commit.
pub fn migrate_suggestions(connection: &mut Connection) -> Result<(), String> {
    let version: i64 = sql(connection.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
    if version == 4 {
        return Ok(());
    }
    if version != 3 {
        return Err("sqlite-unsupported-schema".into());
    }
    let tx = sql(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    sql(tx.execute_batch("CREATE TABLE guide_channel_name(guide_source_id TEXT NOT NULL,channel_id TEXT NOT NULL,ordinal INTEGER NOT NULL,name TEXT NOT NULL,normalized_name TEXT NOT NULL,PRIMARY KEY(guide_source_id,channel_id,ordinal),FOREIGN KEY(guide_source_id,channel_id) REFERENCES guide_channel(guide_source_id,id) ON DELETE CASCADE);CREATE INDEX guide_channel_name_exact ON guide_channel_name(guide_source_id,normalized_name,channel_id);"))?;
    {
        let mut read = sql(tx.prepare(
            "SELECT guide_source_id,id,names_json FROM guide_channel ORDER BY guide_source_id,id",
        ))?;
        let mut rows = sql(read.query([]))?;
        while let Some(row) = sql(rows.next())? {
            let source = sql(column_text(row, 0, 256))?;
            let id = sql(column_text(row, 1, 16_384))?;
            let names = sql(column_text(row, 2, 65_536))?;
            let names: Vec<String> =
                serde_json::from_str(&names).map_err(|_| "guide-invalid-stored-channel")?;
            insert_channel_names(&tx, &source, &id, &names)?;
        }
    }
    sql(tx.execute_batch("PRAGMA user_version=4"))?;
    sql(tx.commit())
}
fn exact_name(value: &str) -> String {
    // ECMAScript whitespace, matching the shared NFKC display-name helper (NEL is not whitespace there).
    normalized(value).split(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
}
fn insert_channel_names(
    c: &Connection,
    source: &str,
    id: &str,
    names: &[String],
) -> Result<(), String> {
    valid_text(source, 256, true)?;
    valid_text(id, 16_384, true)?;
    if names.is_empty() || names.len() > 32 {
        return Err("guide-invalid-stored-channel".into());
    }
    let mut insert = sql(c.prepare("INSERT INTO guide_channel_name VALUES(?1,?2,?3,?4,?5)"))?;
    for (ordinal, name) in names.iter().enumerate() {
        valid_text(name, 512, true)?;
        sql(insert.execute(params![source, id, ordinal as i64, name, exact_name(name)]))?;
    }
    Ok(())
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuideSuggestionQuery {
    pub guide_source_id: String,
    pub expected_source_revision: i64,
    pub expected_published_revision: Option<i64>,
    pub provider_id: Option<String>,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SuggestionMatch {
    ProviderId,
    DisplayName,
    Ambiguous,
    Unmatched,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SuggestionCacheStatus {
    Current,
    Stale,
    Unavailable,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideSuggestionCandidate {
    pub xmltv_channel_id: String,
    pub display_name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideSuggestions {
    pub source_revision: i64,
    pub published_revision: Option<i64>,
    pub cache_status: SuggestionCacheStatus,
    pub r#match: SuggestionMatch,
    pub candidate_count: i64,
    pub candidates_preview: Vec<GuideSuggestionCandidate>,
    pub preview_complete: bool,
    pub review_required: bool,
}
/// Counts all exact matches via indexes, returning at most twenty labels for explicit review.
pub fn lookup_suggestions(
    c: &Connection,
    query: &GuideSuggestionQuery,
) -> Result<GuideSuggestions, String> {
    valid_text(&query.guide_source_id, 256, true)?;
    valid_text(&query.name, 512, true)?;
    if let Some(provider) = &query.provider_id {
        valid_text(provider, 16_384, true)?;
    }
    let tx = sql(c.unchecked_transaction())?;
    let (source_revision, published_revision): (i64, Option<i64>) = sql(tx.query_row(
        "SELECT revision,published_revision FROM guide_source WHERE id=?1",
        [&query.guide_source_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    if source_revision != query.expected_source_revision
        || published_revision != query.expected_published_revision
    {
        return Err("guide-stale-revision".into());
    }
    let mut result = GuideSuggestions {
        source_revision,
        published_revision,
        cache_status: SuggestionCacheStatus::Current,
        r#match: SuggestionMatch::Unmatched,
        candidate_count: 0,
        candidates_preview: Vec::new(),
        preview_complete: true,
        review_required: true,
    };
    if published_revision.is_none() {
        result.cache_status = SuggestionCacheStatus::Unavailable;
    } else if published_revision != Some(source_revision) {
        result.cache_status = SuggestionCacheStatus::Stale;
    } else {
        let provider_exists = if let Some(provider) = &query.provider_id {
            sql(tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM guide_channel WHERE guide_source_id=?1 AND id=?2)",
                params![query.guide_source_id, provider],
                |r| r.get::<_, bool>(0),
            ))?
        } else {
            false
        };
        let (condition, value) = if provider_exists {
            (
                "id=?2",
                query.provider_id.as_deref().unwrap_or_default().to_owned(),
            )
        } else {
            ("id IN(SELECT channel_id FROM guide_channel_name WHERE guide_source_id=?1 AND normalized_name=?2)",exact_name(&query.name))
        };
        result.candidate_count = sql(tx.query_row(
            &format!("SELECT count(*) FROM guide_channel WHERE guide_source_id=?1 AND {condition}"),
            params![query.guide_source_id, value],
            |r| r.get(0),
        ))?;
        result.r#match = if provider_exists {
            SuggestionMatch::ProviderId
        } else if result.candidate_count == 1 {
            SuggestionMatch::DisplayName
        } else if result.candidate_count > 1 {
            SuggestionMatch::Ambiguous
        } else {
            SuggestionMatch::Unmatched
        };
        let mut statement=sql(tx.prepare(&format!("SELECT id,(SELECT name FROM guide_channel_name n WHERE n.guide_source_id=g.guide_source_id AND n.channel_id=g.id AND n.ordinal=0) FROM guide_channel g WHERE guide_source_id=?1 AND {condition} ORDER BY id LIMIT 20")))?;
        let rows = sql(
            statement.query_map(params![query.guide_source_id, value], |r| {
                Ok(GuideSuggestionCandidate {
                    xmltv_channel_id: column_text(r, 0, 16_384)?,
                    display_name: column_text(r, 1, 512)?,
                })
            }),
        )?;
        result.candidates_preview = sql(rows.collect())?;
        result.preview_complete = result.candidate_count <= 20;
    }
    sql(tx.commit())?;
    Ok(result)
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuideSource {
    pub id: String,
    pub name: String,
    pub location: String,
    pub kind: String,
    #[serde(default)]
    pub allow_http: bool,
    pub revision: i64,
    pub updated_ms: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuideMapping {
    pub catalog_source_id: String,
    pub app_channel_id: String,
    pub guide_source_id: String,
    pub xmltv_channel_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuideCursor {
    pub guide_source_id: String,
    pub query_key: String,
    pub source_revision: i64,
    pub database_revision: i64,
    pub start_ms: i64,
    pub ordinal: i64,
    pub app_channel_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgramQuery {
    pub guide_source_id: String,
    pub app_channel_ids: Vec<String>,
    pub window_start_ms: i64,
    pub window_end_ms: i64,
    #[serde(default)]
    pub context_at_ms: Option<i64>,
    #[serde(default)]
    pub search: String,
    pub page_size: usize,
    pub cursor: Option<GuideCursor>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappedProgram {
    pub catalog_source_id: String,
    pub app_channel_id: String,
    pub guide_source_id: String,
    pub xmltv_channel_id: String,
    pub start_ms: i64,
    pub stop_ms: Option<i64>,
    pub title: String,
    pub description: Option<String>,
    #[serde(default)]
    pub categories: Vec<super::category::GuideCategory>,
    pub ordinal: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramPage {
    pub programs: Vec<MappedProgram>,
    pub next_cursor: Option<GuideCursor>,
    pub source_revision: i64,
    pub database_revision: i64,
}
fn source_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GuideSource> {
    Ok(GuideSource {
        id: row.get(0)?,
        name: row.get(1)?,
        location: row.get(2)?,
        kind: row.get(3)?,
        allow_http: row.get(4)?,
        revision: row.get(5)?,
        updated_ms: row.get(6)?,
    })
}
pub fn list_sources(c: &Connection) -> Result<Vec<GuideSource>, String> {
    let mut statement = sql(c.prepare(
        "SELECT id,name,location,kind,allow_http,revision,updated_ms FROM guide_source ORDER BY id",
    ))?;
    let rows = sql(statement.query_map([], source_row))?;
    sql(rows.collect())
}
pub fn source_revision(c: &Connection, id: &str) -> Result<i64, String> {
    valid_text(id, 256, true)?;
    sql(c
        .query_row("SELECT revision FROM guide_source WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional())?
    .ok_or_else(|| "guide-source-missing".into())
}
fn database_revision(c: &Connection) -> Result<i64, String> {
    sql(c.query_row(
        "SELECT revision FROM guide_meta WHERE singleton=1",
        [],
        |r| r.get(0),
    ))
}
pub(super) fn advance(c: &Connection) -> Result<(), String> {
    sql(c.execute(
        "UPDATE guide_meta SET revision=revision+1 WHERE singleton=1",
        [],
    ))?;
    Ok(())
}

/// Saving user configuration invalidates previews/cursors. Changed destinations clear only that source's schedules, retaining mappings.
pub(super) fn validate_source(source: &GuideSource, expected_revision: i64) -> Result<(), String> {
    valid_text(&source.id, 256, true)?;
    valid_text(&source.name, 512, true)?;
    valid_text(&source.location, 16_384, true)?;
    if expected_revision < 0
        || expected_revision == i64::MAX
        || source.revision != expected_revision
        || source.updated_ms.is_some()
    {
        return Err("guide-invalid-source-revision".into());
    }
    if source.kind == "url" {
        let url = reqwest::Url::parse(&source.location).map_err(|_| "guide-invalid-url")?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.host_str().is_none()
            || !(url.scheme() == "https" || source.allow_http && url.scheme() == "http")
        {
            return Err("guide-invalid-url".into());
        }
    } else if source.kind != "file" {
        return Err("guide-invalid-source-kind".into());
    }
    Ok(())
}
pub fn save_source(
    c: &mut Connection,
    source: &GuideSource,
    expected_revision: i64,
) -> Result<GuideSource, String> {
    save_source_checked(c, source, expected_revision, &mut || Ok(()))
}
fn previous_source_save(
    c: &Connection,
    source: &GuideSource,
    expected_revision: i64,
) -> Result<Option<GuideSource>, String> {
    validate_source(source, expected_revision)?;
    let previous=sql(c.query_row("SELECT id,name,location,kind,allow_http,revision,updated_ms FROM guide_source WHERE id=?1",[&source.id],source_row).optional())?;
    if previous.as_ref().map_or(0, |s| s.revision) != expected_revision {
        return Err("guide-stale-revision".into());
    }
    if previous.is_none()
        && sql(c.query_row("SELECT count(*) FROM guide_source", [], |r| {
            r.get::<_, i64>(0)
        }))? >= 1000
    {
        return Err("guide-source-limit".into());
    }
    Ok(previous)
}
fn same_source_configuration(a: &GuideSource, b: &GuideSource) -> bool {
    a.id == b.id
        && a.name == b.name
        && a.location == b.location
        && a.kind == b.kind
        && a.allow_http == b.allow_http
}
/// A read snapshot proves only identical configuration at the requested revision.
/// A changed save repeats every admission check after the actual checked backup.
pub(crate) fn preflight_save_source(
    c: &Connection,
    source: &GuideSource,
    expected_revision: i64,
) -> Result<Option<GuideSource>, String> {
    let tx = sql(c.unchecked_transaction())?;
    let previous = previous_source_save(&tx, source, expected_revision)?;
    let unchanged = previous.filter(|old| same_source_configuration(old, source));
    sql(tx.commit())?;
    Ok(unchanged)
}
pub(crate) fn save_source_checked(
    c: &mut Connection,
    source: &GuideSource,
    expected_revision: i64,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<GuideSource, String> {
    validate_source(source, expected_revision)?;
    check()?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let previous = previous_source_save(&tx, source, expected_revision)?;
    if let Some(old) = previous
        .as_ref()
        .filter(|old| same_source_configuration(old, source))
    {
        let receipt = old.clone();
        check()?;
        sql(tx.commit())?;
        return Ok(receipt);
    }
    let updated = previous.as_ref().and_then(|s| s.updated_ms);
    sql(tx.execute("INSERT INTO guide_source(id,name,location,kind,allow_http,revision,updated_ms) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET name=excluded.name,location=excluded.location,kind=excluded.kind,allow_http=excluded.allow_http,revision=excluded.revision,updated_ms=excluded.updated_ms",params![source.id,source.name,source.location,source.kind,source.allow_http,expected_revision+1,updated]))?;
    advance(&tx)?;
    check()?;
    sql(tx.commit())?;
    Ok(GuideSource {
        revision: expected_revision + 1,
        updated_ms: updated,
        ..source.clone()
    })
}
pub fn remove_source(c: &mut Connection, id: &str, expected_revision: i64) -> Result<(), String> {
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    if source_revision(&tx, id)? != expected_revision {
        return Err("guide-stale-revision".into());
    }
    sql(tx.execute("DELETE FROM guide_source WHERE id=?1", [id]))?;
    advance(&tx)?;
    sql(tx.commit())
}
pub(super) fn validate_feed(feed: &ParsedGuide, flag: &AtomicBool) -> Result<(), String> {
    if feed.channels.len() > 100_000 || feed.programs.len() > 500_000 {
        return Err("guide-record-limit".into());
    }
    let mut ids = HashSet::new();
    let mut bytes = 0usize;
    for ch in &feed.channels {
        cancel(flag)?;
        valid_text(&ch.id, 16_384, true)?;
        if ch.names.is_empty() || ch.names.len() > 32 || !ids.insert(ch.id.as_str()) {
            return Err("guide-invalid-channel".into());
        }
        bytes = bytes.saturating_add(ch.id.len());
        for name in &ch.names {
            valid_text(name, 512, true)?;
            bytes = bytes.saturating_add(name.len());
        }
    }
    for p in &feed.programs {
        cancel(flag)?;
        valid_text(&p.title, 16_384, true)?;
        valid_time(p.start_ms)?;
        if !ids.contains(p.channel_id.as_str()) {
            return Err("guide-unknown-channel".into());
        }
        if let Some(stop) = p.stop_ms {
            valid_time(stop)?;
            if stop <= p.start_ms {
                return Err("guide-invalid-end".into());
            }
        }
        if let Some(desc) = &p.description {
            valid_text(desc, 65_536, false)?;
        }
        let categories = super::category::canonicalize(p.categories.clone())?;
        let category_bytes = serde_json::to_vec(&categories)
            .map_err(|_| "guide-invalid-category")?
            .len();
        let category_key = super::category::semantic_key(&categories)?;
        if category_bytes > 32768 || category_key.len() > 65536 {
            return Err("guide-category-byte-limit".into());
        }
        bytes = bytes.saturating_add(category_bytes + category_key.len());
        bytes = bytes.saturating_add(
            p.title.len()
                + p.channel_id.len()
                + p.description.as_ref().map_or(0, String::len)
                + p.categories
                    .iter()
                    .map(|v| v.text.len() + v.language.as_ref().map_or(0, String::len))
                    .sum::<usize>()
                + 32,
        );
    }
    if bytes > 64 * 1024 * 1024 {
        return Err("guide-record-byte-limit".into());
    }
    Ok(())
}
#[cfg(test)]
pub fn replace_guide(
    c: &mut Connection,
    id: &str,
    expected_revision: i64,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
) -> Result<i64, String> {
    replace_inner(c, id, expected_revision, feed, updated_ms, flag, |_| Ok(()))
}
pub(crate) fn replace_guide_projected(
    c: &mut Connection,
    request: &super::retention::Request,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
) -> Result<i64, String> {
    super::retention::publication_window(request, updated_ms)?;
    replace_inner_with_request(
        c,
        &request.scope.source.id,
        request.scope.source.revision,
        feed,
        updated_ms,
        flag,
        |_| Ok(()),
        Some(request),
    )
}
#[cfg(test)]
fn replace_inner(
    c: &mut Connection,
    id: &str,
    expected_revision: i64,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
    checkpoint: impl FnMut(usize) -> Result<(), String>,
) -> Result<i64, String> {
    replace_inner_with_request(
        c,
        id,
        expected_revision,
        feed,
        updated_ms,
        flag,
        checkpoint,
        None,
    )
}
fn replace_inner_with_request(
    c: &mut Connection,
    id: &str,
    expected_revision: i64,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
    mut checkpoint: impl FnMut(usize) -> Result<(), String>,
    request: Option<&super::retention::Request>,
) -> Result<i64, String> {
    if expected_revision < 0 || expected_revision == i64::MAX {
        return Err("guide-invalid-source-revision".into());
    }
    valid_time(updated_ms)?;
    validate_feed(feed, flag)?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let storage_admission = crate::storage_budget::GuideAdmission::capture(&tx)?;
    let projection = request
        .map(|r| super::retention::project(&tx, r, feed, flag))
        .transpose()?;
    let feed = projection.as_ref().map_or(feed, |p| &p.feed);
    if let Some(r) = request {
        super::retention::install_proposed(&tx, &r.scope)?;
    }
    replace_rows(
        &tx,
        id,
        expected_revision,
        feed,
        updated_ms,
        flag,
        &mut checkpoint,
    )?;
    if let (Some(r), Some(p)) = (request, projection.as_ref()) {
        super::retention::record(&tx, r, p, expected_revision + 1)?;
    }
    storage_admission.finish(&tx)?;
    cancel(flag)?;
    sql(tx.commit())?;
    Ok(expected_revision + 1)
}
/// Automatic fetch publishes bytes-derived validators with exactly these rows.
pub(crate) fn replace_guide_conditional_projected(
    c: &mut Connection,
    request: &super::retention::Request,
    feed: &ParsedGuide,
    updated_ms: i64,
    validators: &super::conditional::Validators,
    flag: &AtomicBool,
) -> Result<i64, String> {
    super::retention::publication_window(request, updated_ms)?;
    replace_conditional_inner(
        c,
        &request.scope.source,
        feed,
        updated_ms,
        validators,
        flag,
        Some(request),
    )
}
#[cfg(test)]
pub fn replace_guide_conditional(
    c: &mut Connection,
    source: &GuideSource,
    feed: &ParsedGuide,
    updated_ms: i64,
    validators: &super::conditional::Validators,
    flag: &AtomicBool,
) -> Result<i64, String> {
    replace_conditional_inner(c, source, feed, updated_ms, validators, flag, None)
}
fn replace_conditional_inner(
    c: &mut Connection,
    source: &GuideSource,
    feed: &ParsedGuide,
    updated_ms: i64,
    validators: &super::conditional::Validators,
    flag: &AtomicBool,
    request: Option<&super::retention::Request>,
) -> Result<i64, String> {
    if source.revision < 0 || source.revision == i64::MAX {
        return Err("guide-invalid-source-revision".into());
    }
    valid_time(updated_ms)?;
    super::refresh::admit_schedule(feed, updated_ms, flag)?;
    validate_feed(feed, flag)?;
    validators.valid()?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let storage_admission = crate::storage_budget::GuideAdmission::capture(&tx)?;
    super::refresh::require_automatic_updates(&tx)?;
    let actual = list_sources(&tx)?
        .into_iter()
        .find(|s| s.id == source.id)
        .ok_or("guide-source-missing")?;
    if actual != *source {
        return Err("guide-stale-revision".into());
    }
    let projection = request
        .map(|r| super::retention::project(&tx, r, feed, flag))
        .transpose()?;
    let feed = projection.as_ref().map_or(feed, |p| &p.feed);
    replace_rows(
        &tx,
        &source.id,
        source.revision,
        feed,
        updated_ms,
        flag,
        &mut |_| Ok(()),
    )?;
    if let (Some(r), Some(p)) = (request, projection.as_ref()) {
        super::retention::record(&tx, r, p, source.revision + 1)?;
    }
    super::conditional::record(&tx, source, source.revision + 1, validators, updated_ms)?;
    cancel(flag)?;
    storage_admission.finish(&tx)?;
    cancel(flag)?;
    sql(tx.commit())?;
    Ok(source.revision + 1)
}
pub(super) fn replace_rows(
    tx: &Connection,
    id: &str,
    expected_revision: i64,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
    mut checkpoint: impl FnMut(usize) -> Result<(), String>,
) -> Result<(), String> {
    if source_revision(tx, id)? != expected_revision {
        return Err("guide-stale-revision".into());
    }
    sql(tx.execute("DELETE FROM guide_channel WHERE guide_source_id=?1", [id]))?;
    checkpoint(0)?;
    cancel(flag)?;
    {
        let mut insert = sql(tx.prepare("INSERT INTO guide_channel VALUES(?1,?2,?3,?4)"))?;
        for ch in &feed.channels {
            cancel(flag)?;
            let names = serde_json::to_string(&ch.names).map_err(|_| "guide-invalid-channel")?;
            sql(insert.execute(params![id, ch.id, names, normalized(&ch.names.join("\n"))]))?;
            insert_channel_names(tx, id, &ch.id, &ch.names)?;
        }
    }
    {
        let mut insert =
            sql(tx.prepare("INSERT INTO guide_program(guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,description,search_text,categories_json,categories_key) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"))?;
        // Exact duplicate programs share one stable schedule row, independent of input ordering.
        let mut ordered: Vec<&GuideProgram> = feed.programs.iter().collect();
        ordered.sort_by(|a, b| {
            (
                &a.channel_id,
                a.start_ms,
                a.stop_ms,
                &a.title,
                &a.description,
                super::category::semantic_pairs(&a.categories),
            )
                .cmp(&(
                    &b.channel_id,
                    b.start_ms,
                    b.stop_ms,
                    &b.title,
                    &b.description,
                    super::category::semantic_pairs(&b.categories),
                ))
        });
        ordered.dedup_by(|a, b| {
            a.channel_id == b.channel_id
                && a.start_ms == b.start_ms
                && a.stop_ms == b.stop_ms
                && a.title == b.title
                && a.description == b.description
                && super::category::semantic_pairs(&a.categories)
                    == super::category::semantic_pairs(&b.categories)
        });
        for (i, p) in ordered.iter().enumerate() {
            cancel(flag)?;
            sql(insert.execute(params![
                id,
                i as i64,
                p.channel_id,
                p.start_ms,
                p.stop_ms,
                p.title,
                p.description,
                super::category::search_text(&p.title, p.description.as_deref(), &p.categories),
                serde_json::to_string(&super::category::canonicalize(p.categories.clone())?)
                    .map_err(|_| "guide-invalid-category")?,
                super::category::semantic_key(&p.categories)?
            ]))?;
            checkpoint(i + 1)?;
        }
    }
    sql(tx.execute(
        "UPDATE guide_source SET revision=revision+1,published_revision=revision+1,updated_ms=?2 WHERE id=?1",
        params![id, updated_ms],
    ))?;
    advance(tx)?;
    checkpoint(usize::MAX)?;
    cancel(flag)?;
    Ok(())
}
/// Configuration and the reviewed schedule publish in one commit; failures preserve both prior records.
#[cfg(test)]
pub fn publish_source(
    c: &mut Connection,
    source: &GuideSource,
    expected_revision: i64,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
) -> Result<i64, String> {
    publish_inner(c, source, expected_revision, feed, updated_ms, flag, |_| {
        Ok(())
    })
}
#[cfg(test)]
fn publish_inner(
    c: &mut Connection,
    source: &GuideSource,
    expected_revision: i64,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
    checkpoint: impl FnMut(usize) -> Result<(), String>,
) -> Result<i64, String> {
    validate_source(source, expected_revision)?;
    valid_time(updated_ms)?;
    validate_feed(feed, flag)?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let storage_admission = crate::storage_budget::GuideAdmission::capture(&tx)?;
    let previous: Option<i64> = sql(tx
        .query_row(
            "SELECT revision FROM guide_source WHERE id=?1",
            [&source.id],
            |r| r.get(0),
        )
        .optional())?;
    if previous.unwrap_or(0) != expected_revision {
        return Err("guide-stale-revision".into());
    }
    if previous.is_none()
        && sql(tx.query_row("SELECT count(*) FROM guide_source", [], |r| {
            r.get::<_, i64>(0)
        }))? >= 1000
    {
        return Err("guide-source-limit".into());
    }
    sql(tx.execute("INSERT INTO guide_source(id,name,location,kind,allow_http,revision,updated_ms) VALUES(?1,?2,?3,?4,?5,?6,NULL) ON CONFLICT(id) DO UPDATE SET name=excluded.name,location=excluded.location,kind=excluded.kind,allow_http=excluded.allow_http",params![source.id,source.name,source.location,source.kind,source.allow_http,expected_revision]))?;
    replace_rows(
        &tx,
        &source.id,
        expected_revision,
        feed,
        updated_ms,
        flag,
        checkpoint,
    )?;
    storage_admission.finish(&tx)?;
    cancel(flag)?;
    sql(tx.commit())?;
    Ok(expected_revision + 1)
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitAndMatch {
    pub source_revision: i64,
    pub matched: usize,
    pub unmatched: usize,
    pub preserved_mappings: usize,
}

#[cfg(test)]
pub fn replace_guide_and_match(
    c: &mut Connection,
    id: &str,
    expected_revision: i64,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
) -> Result<CommitAndMatch, String> {
    replace_and_match_inner(c, id, expected_revision, feed, updated_ms, flag, || Ok(()))
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitIfMatched {
    pub committed: bool,
    pub source_revision: i64,
    pub matched: usize,
    pub unmatched: usize,
    pub preserved_mappings: usize,
}
#[cfg(test)]
pub fn replace_guide_if_matched(
    c: &mut Connection,
    id: &str,
    expected_revision: i64,
    expected_catalog: &str,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
) -> Result<CommitIfMatched, String> {
    replace_guide_if_matched_with_aliases(
        c,
        id,
        expected_revision,
        expected_catalog,
        feed,
        updated_ms,
        flag,
        None,
    )
}
#[allow(clippy::too_many_arguments)]
#[cfg(test)]
pub fn replace_guide_if_matched_with_aliases(
    c: &mut Connection,
    id: &str,
    expected_revision: i64,
    expected_catalog: &str,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
    aliases: Option<&super::reviewed_aliases::ReviewedAliases>,
) -> Result<CommitIfMatched, String> {
    if expected_catalog.is_empty()
        || expected_catalog.len() > 19
        || !expected_catalog.bytes().all(|b| b.is_ascii_digit())
        || (expected_catalog.len() > 1 && expected_catalog.starts_with('0'))
    {
        return Err("catalog-revision-invalid".into());
    }
    let expected_catalog = expected_catalog
        .parse::<i64>()
        .map_err(|_| "catalog-revision-invalid")?;
    if feed.programs.is_empty() {
        return Err("guide-empty-confirmation-required".into());
    }
    match_inner(
        c,
        id,
        expected_revision,
        Some(expected_catalog),
        aliases,
        feed,
        updated_ms,
        flag,
        || Ok(()),
    )
}
#[cfg(test)]
fn replace_and_match_inner(
    c: &mut Connection,
    id: &str,
    expected_revision: i64,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
    checkpoint: impl FnOnce() -> Result<(), String>,
) -> Result<CommitAndMatch, String> {
    let result = match_inner(
        c,
        id,
        expected_revision,
        None,
        None,
        feed,
        updated_ms,
        flag,
        checkpoint,
    )?;
    Ok(CommitAndMatch {
        source_revision: result.source_revision,
        matched: result.matched,
        unmatched: result.unmatched,
        preserved_mappings: result.preserved_mappings,
    })
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn replace_guide_match_projected(
    c: &mut Connection,
    request: &super::retention::Request,
    expected_catalog: Option<&str>,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
) -> Result<CommitIfMatched, String> {
    super::retention::publication_window(request, updated_ms)?;
    let expected = expected_catalog
        .map(|v| {
            let parsed = v.parse::<i64>().map_err(|_| "catalog-revision-invalid")?;
            if parsed < 0 || parsed.to_string() != v {
                return Err("catalog-revision-invalid");
            }
            Ok(parsed)
        })
        .transpose()
        .map_err(str::to_owned)?;
    match_inner_with_request(
        c,
        &request.scope.source.id,
        request.scope.source.revision,
        expected,
        request.aliases.as_ref(),
        feed,
        updated_ms,
        flag,
        || Ok(()),
        Some(request),
    )
}
#[cfg(test)]
fn match_inner(
    c: &mut Connection,
    id: &str,
    expected_revision: i64,
    expected_catalog: Option<i64>,
    aliases: Option<&super::reviewed_aliases::ReviewedAliases>,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
    checkpoint: impl FnOnce() -> Result<(), String>,
) -> Result<CommitIfMatched, String> {
    match_inner_with_request(
        c,
        id,
        expected_revision,
        expected_catalog,
        aliases,
        feed,
        updated_ms,
        flag,
        checkpoint,
        None,
    )
}
#[allow(clippy::too_many_arguments)]
fn match_inner_with_request(
    c: &mut Connection,
    id: &str,
    expected_revision: i64,
    expected_catalog: Option<i64>,
    aliases: Option<&super::reviewed_aliases::ReviewedAliases>,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
    checkpoint: impl FnOnce() -> Result<(), String>,
    request: Option<&super::retention::Request>,
) -> Result<CommitIfMatched, String> {
    if expected_revision < 0 || expected_revision == i64::MAX {
        return Err("guide-invalid-source-revision".into());
    }
    valid_time(updated_ms)?;
    validate_feed(feed, flag)?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let storage_admission = crate::storage_budget::GuideAdmission::capture(&tx)?;
    cancel(flag)?;
    if let Some(expected) = expected_catalog {
        let actual: i64 = sql(tx.query_row(
            "SELECT catalog_revision FROM metadata WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        if actual != expected {
            return Err("catalog-revision-stale".into());
        }
        if let Some(r) = request.filter(|r| super::retention::is_proposed(&r.scope)) {
            super::retention::verify(&tx, &r.scope)?;
        } else if source_revision(&tx, id)? != expected_revision {
            return Err("guide-stale-revision".into());
        }
    }
    let projection = request
        .map(|r| super::retention::project(&tx, r, feed, flag))
        .transpose()?;
    let feed = projection.as_ref().map_or(feed, |p| &p.feed);
    // Exact guide IDs identify programs, not stream variants. Distinct catalog
    // channels may share that guide ID; preserve every stream and existing mapping.
    let mut statement = sql(tx.prepare("SELECT c.id,c.source_id,c.provider_id,EXISTS(SELECT 1 FROM guide_mapping m WHERE m.catalog_source_id=c.source_id AND m.app_channel_id=c.id) FROM channel c WHERE NOT EXISTS(SELECT 1 FROM removed r WHERE r.id=c.id) ORDER BY c.id"))?;
    let rows = sql(statement.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, bool>(3)?,
        ))
    }))?;
    let mut channels = Vec::new();
    for row in rows {
        cancel(flag)?;
        let row = sql(row)?;
        if channels.len() >= 100_000 {
            return Err("guide-catalog-channel-limit".into());
        }
        channels.push(row);
    }
    drop(statement);
    let guide_ids: HashSet<&str> = feed.channels.iter().map(|ch| ch.id.as_str()).collect();
    let alias_targets = if let Some(descriptor) = aliases {
        let (location, kind): (String, String) =
            if let Some(r) = request.filter(|r| super::retention::is_proposed(&r.scope)) {
                (r.scope.source.location.clone(), r.scope.source.kind.clone())
            } else {
                sql(tx.query_row(
                    "SELECT location,kind FROM guide_source WHERE id=?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                ))?
            };
        if kind != "url" {
            return Err("guide-alias-source-refused".into());
        }
        let targets: Vec<_> = channels
            .iter()
            .map(
                |(channel, source, provider, _)| super::reviewed_aliases::CatalogTarget {
                    source_id: source,
                    channel_id: channel,
                    provider_id: provider.as_deref(),
                    removed: false,
                },
            )
            .collect();
        super::reviewed_aliases::admit(descriptor, &location, &targets, &guide_ids, flag)
            .map_err(str::to_string)?
    } else {
        std::collections::BTreeMap::new()
    };
    let pack_location: Option<String> =
        if let Some(r) = request.filter(|r| super::retention::is_proposed(&r.scope)) {
            (r.scope.source.kind == "url").then(|| r.scope.source.location.clone())
        } else {
            sql(tx
                .query_row(
                    "SELECT location,kind FROM guide_source WHERE id=?1",
                    [id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .optional())?
            .and_then(|(location, kind)| (kind == "url").then_some(location))
        };
    let resolve = |channel: &str, source: &str, provider: Option<&str>| -> Option<String> {
        alias_targets
            .get(&(source.to_string(), channel.to_string()))
            .cloned()
            .or_else(|| {
                provider
                    .filter(|p| !p.is_empty() && guide_ids.contains(p))
                    .map(str::to_string)
            })
            .or_else(|| {
                // Exact published tuple or main-feed equivalent; ambiguous when
                // more than one distinct present header qualifies.
                let present: Vec<String> = super::crosswalk_pack::alternates(
                    pack_location.as_deref(),
                    provider.filter(|p| !p.is_empty())?,
                )
                .into_iter()
                .filter(|alternate| guide_ids.contains(alternate.as_str()))
                .collect();
                (present.len() == 1).then(|| present[0].clone())
            })
    };
    let mut retained_exact = 0;
    if expected_catalog.is_some() {
        let mut eligible = 0;
        for (channel, source, provider, mapped) in &channels {
            cancel(flag)?;
            if let Some(provider) = resolve(channel, source, provider.as_deref()) {
                if !mapped {
                    eligible += 1;
                } else {
                    let same:bool=sql(tx.query_row("SELECT EXISTS(SELECT 1 FROM guide_mapping WHERE catalog_source_id=?1 AND app_channel_id=?2 AND guide_source_id=?3 AND xmltv_channel_id=?4)",params![source,channel,id,provider],|r|r.get(0)))?;
                    if same {
                        eligible += 1;
                        retained_exact += 1;
                    }
                }
            }
        }
        if eligible == 0 && !projection.as_ref().is_some_and(|p| p.has_interest()) {
            checkpoint()?;
            cancel(flag)?;
            return Ok(CommitIfMatched {
                committed: false,
                source_revision: expected_revision,
                matched: 0,
                unmatched: channels.iter().filter(|c| !c.3).count(),
                preserved_mappings: channels.iter().filter(|c| c.3).count(),
            });
        }
    }
    if let Some(r) = request {
        super::retention::install_proposed(&tx, &r.scope)?;
    }
    replace_rows(
        &tx,
        id,
        expected_revision,
        feed,
        updated_ms,
        flag,
        &mut |_| Ok(()),
    )?;
    let mut result = CommitAndMatch {
        source_revision: expected_revision + 1,
        matched: 0,
        unmatched: 0,
        preserved_mappings: 0,
    };
    for (channel, source, provider, mapped) in channels {
        cancel(flag)?;
        if mapped {
            result.preserved_mappings += 1;
            continue;
        }
        if let Some(provider) = resolve(&channel, &source, provider.as_deref()) {
            sql(tx.execute(
                "INSERT INTO guide_mapping VALUES(?1,?2,?3,?4)",
                params![source, channel, id, provider],
            ))?;
            result.matched += 1;
        } else {
            result.unmatched += 1;
        }
    }
    checkpoint()?;
    cancel(flag)?;
    if let (Some(r), Some(p)) = (request, projection.as_ref()) {
        super::retention::record(&tx, r, p, expected_revision + 1)?;
    }
    storage_admission.finish(&tx)?;
    cancel(flag)?;
    sql(tx.commit())?;
    Ok(CommitIfMatched {
        committed: true,
        source_revision: result.source_revision,
        matched: result.matched + retained_exact,
        unmatched: result.unmatched,
        preserved_mappings: result.preserved_mappings,
    })
}

pub fn list_mappings(c: &Connection) -> Result<Vec<GuideMapping>, String> {
    let mut s=sql(c.prepare("SELECT catalog_source_id,app_channel_id,guide_source_id,xmltv_channel_id FROM guide_mapping ORDER BY catalog_source_id,app_channel_id"))?;
    let rows = sql(s.query_map([], |r| {
        Ok(GuideMapping {
            catalog_source_id: r.get(0)?,
            app_channel_id: r.get(1)?,
            guide_source_id: r.get(2)?,
            xmltv_channel_id: r.get(3)?,
        })
    }))?;
    sql(rows.collect())
}
pub fn save_mapping(c: &mut Connection, m: &GuideMapping) -> Result<(), String> {
    for id in [&m.catalog_source_id, &m.guide_source_id] {
        valid_text(id, 256, true)?;
    }
    for id in [&m.app_channel_id, &m.xmltv_channel_id] {
        valid_text(id, 16_384, true)?;
    }
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let admitted:bool=sql(tx.query_row("SELECT EXISTS(SELECT 1 FROM channel WHERE id=?1 AND source_id=?2) AND EXISTS(SELECT 1 FROM guide_channel WHERE guide_source_id=?3 AND id=?4)",params![m.app_channel_id,m.catalog_source_id,m.guide_source_id,m.xmltv_channel_id],|r|r.get(0)))?;
    if !admitted {
        return Err("guide-mapping-target-missing".into());
    }
    sql(tx.execute("INSERT INTO guide_mapping VALUES(?1,?2,?3,?4) ON CONFLICT(catalog_source_id,app_channel_id) DO UPDATE SET guide_source_id=excluded.guide_source_id,xmltv_channel_id=excluded.xmltv_channel_id",params![m.catalog_source_id,m.app_channel_id,m.guide_source_id,m.xmltv_channel_id]))?;
    advance(&tx)?;
    sql(tx.commit())
}
pub fn remove_mapping(
    c: &mut Connection,
    catalog_source_id: &str,
    app_channel_id: &str,
) -> Result<(), String> {
    valid_text(catalog_source_id, 256, true)?;
    valid_text(app_channel_id, 16_384, true)?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    sql(tx.execute(
        "DELETE FROM guide_mapping WHERE catalog_source_id=?1 AND app_channel_id=?2",
        params![catalog_source_id, app_channel_id],
    ))?;
    advance(&tx)?;
    sql(tx.commit())
}
fn column_text(r: &rusqlite::Row<'_>, index: usize, max: usize) -> rusqlite::Result<String> {
    let value = r.get_ref(index)?.as_str()?;
    if valid_text(value, max, true).is_err() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(value.to_owned())
}
fn mapped_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MappedProgram> {
    Ok(MappedProgram {
        catalog_source_id: column_text(r, 0, 256)?,
        app_channel_id: column_text(r, 1, 16_384)?,
        guide_source_id: column_text(r, 2, 256)?,
        xmltv_channel_id: column_text(r, 3, 16_384)?,
        start_ms: r.get(4)?,
        stop_ms: r.get(5)?,
        title: column_text(r, 6, 16_384)?,
        description: if matches!(r.get_ref(7)?, rusqlite::types::ValueRef::Null) {
            None
        } else {
            let text = r.get_ref(7)?.as_str()?;
            if valid_text(text, 65_536, false).is_err() {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Some(text.to_owned())
        },
        ordinal: r.get(8)?,
        categories: {
            let raw = r.get_ref(9)?.as_str()?;
            if raw.len() > 32768 {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let categories: Vec<super::category::GuideCategory> =
                serde_json::from_str(raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let categories = super::category::canonicalize(categories)
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
            let expected = r.get_ref(10)?.as_str()?;
            if expected.len() > 65536
                || super::category::semantic_key(&categories)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?
                    != expected
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            categories
        },
    })
}
pub fn query_programs(c: &Connection, q: &ProgramQuery) -> Result<ProgramPage, String> {
    valid_text(&q.guide_source_id, 256, false)?;
    valid_text(&q.search, 512, false)?;
    valid_time(q.window_start_ms)?;
    valid_time(q.window_end_ms)?;
    if q.window_end_ms <= q.window_start_ms
        || q.window_end_ms - q.window_start_ms > WEEK
        || q.page_size == 0
        || q.page_size > 100
        || q.app_channel_ids.len() > 100
    {
        return Err("guide-invalid-query-bounds".into());
    }
    if let Some(context) = q.context_at_ms {
        valid_time(context)?;
        if q.guide_source_id.is_empty()
            || q.app_channel_ids.len() != 1
            || !q.search.trim().is_empty()
            || context < q.window_start_ms
            || context >= q.window_end_ms
        {
            return Err("guide-invalid-context-scope".into());
        }
    }
    let mut unique = HashSet::new();
    for id in &q.app_channel_ids {
        valid_text(id, 16_384, true)?;
        if !unique.insert(id) {
            return Err("guide-duplicate-query-channel".into());
        }
    }
    let tx = sql(c.unchecked_transaction())?;
    let sr = if q.guide_source_id.is_empty() {
        0
    } else {
        source_revision(&tx, &q.guide_source_id)?
    };
    let dr = database_revision(&tx)?;
    let catalog_revision: i64 = sql(tx.query_row(
        "SELECT revision FROM metadata WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    let mut requested_ids = q.app_channel_ids.clone();
    requested_ids.sort();
    let search_tokens = tokens(&q.search);
    let query_key = key((
        &q.guide_source_id,
        &requested_ids,
        q.window_start_ms,
        q.window_end_ms,
        q.context_at_ms,
        &search_tokens,
        q.search.trim().is_empty(),
        catalog_revision,
    ))?;
    if let Some(cursor) = &q.cursor {
        valid_text(&cursor.app_channel_id, 16_384, true)?;
        valid_text(&cursor.guide_source_id, 256, true)?;
        valid_time(cursor.start_ms)?;
        if cursor.source_revision != sr
            || cursor.database_revision != dr
            || cursor.ordinal < 0
            || cursor.query_key != query_key
        {
            return Err("guide-stale-cursor".into());
        }
    }
    let mut values: Vec<rusqlite::types::Value> = vec![
        q.guide_source_id.clone().into(),
        q.window_start_ms.into(),
        q.window_end_ms.into(),
    ];
    // Only the latest started entry in this exact feed/channel can supply unknown-end
    // context. Future entries and search filters cannot change that historical boundary.
    let context_clause = if let Some(context) = q.context_at_ms {
        values.push(context.into());
        " OR (p.start_ms<=?4 AND p.start_ms=(SELECT max(ctx.start_ms) FROM guide_program ctx WHERE ctx.guide_source_id=p.guide_source_id AND ctx.channel_id=p.channel_id AND ctx.start_ms<=?4))".to_owned()
    } else {
        String::new()
    };
    let search_clause = if q.search.trim().is_empty() {
        String::new()
    } else if search_tokens.is_empty() {
        " AND 0".into()
    } else {
        search_tokens
            .iter()
            .map(|token| {
                values.push(token.clone().into());
                format!(" AND instr(p.search_text,?{})>0", values.len())
            })
            .collect::<String>()
    };
    let placeholders = q
        .app_channel_ids
        .iter()
        .map(|id| {
            values.push(id.clone().into());
            format!("?{}", values.len())
        })
        .collect::<Vec<_>>()
        .join(",");
    let channel_clause = if q.app_channel_ids.is_empty() {
        String::new()
    } else {
        format!(" AND m.app_channel_id IN({placeholders})")
    };
    let cursor_clause = if let Some(cursor) = &q.cursor {
        let index = values.len() + 1;
        values.extend([
            cursor.start_ms.into(),
            cursor.guide_source_id.clone().into(),
            cursor.ordinal.into(),
            cursor.app_channel_id.clone().into(),
        ]);
        format!(
            " AND (p.start_ms,p.guide_source_id,p.ordinal,m.app_channel_id)>(?{index},?{},?{},?{})",
            index + 1,
            index + 2,
            index + 3
        )
    } else {
        String::new()
    };
    let scope_clause = if q.guide_source_id.is_empty() {
        "(?1='')"
    } else {
        "p.guide_source_id=?1"
    };
    let statement=format!("SELECT m.catalog_source_id,m.app_channel_id,p.guide_source_id,p.channel_id,p.start_ms,p.stop_ms,p.title,p.description,p.ordinal,p.categories_json,p.categories_key FROM guide_program p JOIN guide_mapping m ON m.guide_source_id=p.guide_source_id AND m.xmltv_channel_id=p.channel_id JOIN channel c ON c.id=m.app_channel_id AND c.source_id=m.catalog_source_id WHERE {scope_clause} AND p.start_ms<?3 AND ((p.stop_ms IS NOT NULL AND p.stop_ms>?2) OR (p.stop_ms IS NULL AND (p.start_ms>=?2{context_clause}))){search_clause}{channel_clause} AND NOT EXISTS(SELECT 1 FROM removed r WHERE r.id=m.app_channel_id){cursor_clause} ORDER BY p.start_ms,p.guide_source_id,p.ordinal,m.app_channel_id LIMIT {}",q.page_size+1);
    let mut s = sql(tx.prepare(&statement))?;
    let mut programs: Vec<MappedProgram> =
        sql(sql(s.query_map(rusqlite::params_from_iter(values), mapped_row))?.collect())?;
    drop(s);
    let page_bytes: usize = programs
        .iter()
        .map(|p| {
            p.catalog_source_id.len()
                + p.app_channel_id.len()
                + p.guide_source_id.len()
                + p.xmltv_channel_id.len()
                + p.title.len()
                + p.description.as_ref().map_or(0, String::len)
                + p.categories
                    .iter()
                    .map(|v| v.text.len() + v.language.as_ref().map_or(0, String::len))
                    .sum::<usize>()
        })
        .sum();
    if page_bytes > 8 * 1024 * 1024 {
        return Err("guide-page-byte-limit-choose-smaller-page".into());
    }
    let has_more = programs.len() > q.page_size;
    programs.truncate(q.page_size);
    let next_cursor = if has_more {
        programs.last().map(|p| GuideCursor {
            guide_source_id: p.guide_source_id.clone(),
            query_key: query_key.clone(),
            source_revision: sr,
            database_revision: dr,
            start_ms: p.start_ms,
            ordinal: p.ordinal,
            app_channel_id: p.app_channel_id.clone(),
        })
    } else {
        None
    };
    sql(tx.commit())?;
    Ok(ProgramPage {
        programs,
        next_cursor,
        source_revision: sr,
        database_revision: dr,
    })
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideChannelPage {
    pub channels: Vec<super::parser::GuideChannel>,
    pub next_cursor: Option<GuideChannelCursor>,
    pub source_revision: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuideChannelCursor {
    pub source_revision: i64,
    pub query_key: String,
    pub last_id: String,
}
pub fn list_channels(
    c: &Connection,
    source_id: &str,
    search: &str,
    cursor: Option<&GuideChannelCursor>,
    page_size: usize,
) -> Result<GuideChannelPage, String> {
    valid_text(source_id, 256, true)?;
    valid_text(search, 512, false)?;
    if let Some(cursor) = cursor {
        valid_text(&cursor.last_id, 16_384, true)?;
    }
    if page_size == 0 || page_size > 100 {
        return Err("guide-invalid-page-size".into());
    }
    let tx = sql(c.unchecked_transaction())?;
    let revision = source_revision(&tx, source_id)?;
    let search_tokens = tokens(search);
    let query_key = key((source_id, &search_tokens, search.trim().is_empty()))?;
    if cursor.is_some_and(|v| v.source_revision != revision || v.query_key != query_key) {
        return Err("guide-stale-cursor".into());
    }
    let mut values: Vec<rusqlite::types::Value> = vec![
        source_id.to_owned().into(),
        cursor.map(|c| c.last_id.clone()).into(),
    ];
    let search_clause = if search.trim().is_empty() {
        String::new()
    } else if search_tokens.is_empty() {
        " AND 0".into()
    } else {
        search_tokens
            .iter()
            .map(|token| {
                values.push(token.clone().into());
                format!(" AND instr(search_names,?{})>0", values.len())
            })
            .collect::<String>()
    };
    let statement=format!("SELECT id,names_json FROM guide_channel WHERE guide_source_id=?1 AND (?2 IS NULL OR id>?2){search_clause} ORDER BY id LIMIT {}",page_size+1);
    let mut s = sql(tx.prepare(&statement))?;
    let raw: Vec<(String, String)> = sql(sql(s
        .query_map(rusqlite::params_from_iter(values), |r| {
            Ok((column_text(r, 0, 16_384)?, column_text(r, 1, 65_536)?))
        }))?
    .collect())?;
    drop(s);
    let more = raw.len() > page_size;
    let mut channels = Vec::new();
    for (id, names) in raw.into_iter().take(page_size) {
        let names: Vec<String> =
            serde_json::from_str(&names).map_err(|_| "guide-invalid-stored-channel")?;
        if names.is_empty() || names.len() > 32 {
            return Err("guide-invalid-stored-channel".into());
        }
        for name in &names {
            valid_text(name, 512, true)?;
        }
        channels.push(super::parser::GuideChannel { id, names });
    }
    let next_cursor = if more {
        channels.last().map(|c| GuideChannelCursor {
            source_revision: revision,
            query_key: query_key.clone(),
            last_id: c.id.clone(),
        })
    } else {
        None
    };
    sql(tx.commit())?;
    Ok(GuideChannelPage {
        channels,
        next_cursor,
        source_revision: revision,
    })
}
#[cfg(test)]
#[path = "database_tests.rs"]
mod tests;

#[path = "selected_summary.rs"]
mod selected_summary;
pub use selected_summary::{
    selected_summary, visible_summaries, SelectedSummary, SummaryIdentity, SummaryQuery,
    VisibleSummaries,
};
