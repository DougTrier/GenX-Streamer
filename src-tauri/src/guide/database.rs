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

#[cfg(test)]
#[path = "database_tests.rs"]
mod tests;

#[path = "selected_summary.rs"]
mod selected_summary;
pub use selected_summary::{
    selected_summary, visible_summaries, SelectedSummary, SummaryIdentity, SummaryQuery,
    VisibleSummaries,
};

// This module's parts, by area, are in database/.
mod suggestions;
pub use suggestions::*;
mod sources;
pub use sources::*;
mod replace;
pub(crate) use replace::*;
mod matching;
pub use matching::*;
mod programs;
pub use programs::*;
