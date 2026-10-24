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

//! Revision-scoped, URL-free catalog browsing. Caller retains the actual read-work lease.
use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Transaction,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
};
use unicode_normalization::UnicodeNormalization;

const COUNTRIES: &str = include_str!("../../src/location/countries.json");
const SUBDIVISIONS: &str = include_str!("../../src/search/subdivisions.json");
const RESPONSE_LIMIT: usize = 1024 * 1024;
const CURSOR_LIMIT: usize = 256 * 1024;
pub const QUERY_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub schema_version: u32,
    pub request_id: String,
    pub expected_catalog_revision: Option<String>,
    pub expected_view_revision: Option<String>,
    pub query: String,
    pub filter: Filter,
    #[serde(default)]
    pub geography: Map<String, Value>,
    pub sort: Sort,
    #[serde(default)]
    pub favorites_first: bool,
    /// Leave out adult channels (category "xxx" or "adult").
    #[serde(default)]
    pub hide_adult: bool,
    pub after: Option<Cursor>,
    pub start_index: Option<usize>,
    pub anchor_id: Option<String>,
    pub page_size: usize,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Filter {
    All,
    Favorites,
    News,
    Sports,
    Movies,
    /// Saved channels that failed quiet checks on two different days (`channel_check`).
    Unresponsive,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Sort {
    Source,
    Name,
    Geography,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cursor {
    pub schema_version: u32,
    pub query_key: String,
    pub catalog_revision: String,
    pub view_revision: String,
    pub sort_key: String,
    pub id: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    pub source_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    pub name: String,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geography: Option<Map<String, Value>>,
    pub favorite: bool,
}
/// The ordered result of the last catalog query at one database state. Later
/// pages of the same query are slices of it instead of re-running the whole
/// grouping query, which costs seconds per page on a TV. Owned by the store of
/// one database; the key includes both revisions and the database file stamp
/// read inside the query's read transaction.
#[derive(Default)]
pub(crate) struct PageCache(std::sync::Mutex<Option<(String, Ordered)>>);
/// Channel IDs with their sort keys, in result order.
type Ordered = Arc<Vec<(String, Vec<u8>)>>;
struct RawRow {
    id: String,
    source_id: String,
    provider_id: Option<String>,
    name: String,
    category: String,
    geography: [Option<String>; 3],
    favorite: bool,
    sort_key: Vec<u8>,
}
fn raw_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawRow> {
    Ok(RawRow {
        id: row.get(0)?,
        source_id: row.get(1)?,
        provider_id: row.get(2)?,
        name: row.get(3)?,
        category: row.get(4)?,
        geography: [row.get(5)?, row.get(6)?, row.get(7)?],
        favorite: row.get(8)?,
        sort_key: Vec::new(),
    })
}
/// Changes on every committed write (DELETE journal mode rewrites the file).
fn database_stamp(path: &std::path::Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|_| "catalog-query-stamp")?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    Ok(format!("{}:{modified}", meta.len()))
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub schema_version: u32,
    pub request_id: String,
    pub catalog_revision: String,
    pub view_revision: String,
    pub query_version: String,
    pub total_count: i64,
    pub start_index: usize,
    pub anchor_index: Option<usize>,
    pub rows: Vec<Row>,
    pub after: Option<Cursor>,
}
fn effective_category_expression(c: &Connection) -> Result<&'static str, String> {
    let exists: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='channel_category_override')",
        [],
        |r| r.get(0),
    ))?;
    let version: i64 = sql(c.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
    if !exists && version >= 10 {
        return Err("catalog-query-database-failed".into());
    }
    Ok(if exists {
        "COALESCE((SELECT o.category FROM channel_category_override o WHERE o.channel_id=c.id),c.category)"
    } else {
        "c.category"
    })
}
fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|error| {
        crate::storage_transaction::sql_error_code(&error, "catalog-query-database-failed")
    })
}
fn check(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        Err("catalog-query-cancelled".into())
    } else {
        Ok(())
    }
}
fn ecma_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000b}' | '\u{000c}' | '\r' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
fn fold(value: &str) -> String {
    value.nfkc().collect::<String>().to_lowercase()
}
fn alias_fold(value: &str) -> String {
    let lowered = fold(value);
    lowered
        .trim_matches(ecma_space)
        .split(ecma_space)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}
fn aliases(category: &str) -> String {
    let key = alias_fold(category);
    for group in [
        &["kids", "children", "children's", "childrens"][..],
        &["animation", "cartoon", "cartoons"][..],
    ] {
        if group.contains(&key.as_str()) {
            return group
                .iter()
                .filter(|s| **s != key)
                .copied()
                .collect::<Vec<_>>()
                .join("\n");
        }
    }
    String::new()
}
fn network(provider: Option<&str>) -> &'static str {
    let Some(provider) = provider else {
        return "";
    };
    let (id, suffix) = provider
        .split_once('@')
        .map_or((provider, None), |(a, b)| (a, Some(b)));
    if suffix.is_some_and(|s| {
        s.is_empty()
            || s.len() > 256
            || !s.as_bytes()[0].is_ascii_alphanumeric()
            || !s
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    }) {
        return "";
    }
    match id {
        "Fox.us" => "fox",
        "NBC.us" => "nbc",
        "CBS.us" => "cbs",
        "ABC.us" => "abc",
        _ => "",
    }
}
struct Labels {
    countries: HashMap<String, String>,
    states: HashMap<String, String>,
    version: String,
}
fn labels() -> &'static Labels {
    static LABELS: OnceLock<Labels> = OnceLock::new();
    LABELS.get_or_init(|| {
        let countries: Vec<Value> =
            serde_json::from_str(COUNTRIES).expect("checked-in country labels");
        let states: Value =
            serde_json::from_str(SUBDIVISIONS).expect("checked-in subdivision labels");
        Labels {
            countries: countries
                .iter()
                .map(|v| {
                    (
                        v["code"].as_str().unwrap().into(),
                        v["name"].as_str().unwrap().into(),
                    )
                })
                .collect(),
            states: states["labels"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().into()))
                .collect(),
            version: format!(
                "v{QUERY_VERSION}-{:x}",
                Sha256::digest(format!(
                    "{COUNTRIES}\0{SUBDIVISIONS}\0{}",
                    crate::catalog_endpoint_projection::POLICY
                ))
            ),
        }
    })
}
fn label<'a>(field: &str, code: &'a str) -> &'a str {
    let known = match field {
        "country" => labels().countries.get(code),
        "state" => labels().states.get(code),
        _ => None,
    };
    known.map_or(code, String::as_str)
}
fn location(country: Option<&str>, region: Option<&str>, state: Option<&str>) -> String {
    let mut parts = Vec::new();
    for (field, value) in [("country", country), ("state", state), ("region", region)] {
        if let Some(code) = value {
            parts.push(code);
            parts.push(label(field, code));
        }
    }
    fold(&parts.join(" "))
}
/// The same literal/alias/provider matching used by the indexed catalog.
/// Region affects ordering elsewhere; it must not exclude distant results.
pub(crate) fn matches_scan_channel(
    channel: &Value,
    query: &str,
    _preferred_region: Option<&Value>,
) -> Result<bool, String> {
    if query.len() > 256 || query.chars().any(char::is_control) {
        return Err("catalog-query-invalid".into());
    }
    let name = channel["name"].as_str().ok_or("catalog-query-invalid")?;
    let category = channel["category"]
        .as_str()
        .ok_or("catalog-query-invalid")?;
    let provider = channel.get("providerId").and_then(Value::as_str);
    let geo = channel.get("geography");
    let text = format!(
        "{} {} {} {}",
        fold(name),
        fold(category),
        network(provider),
        location(
            geo.and_then(|g| g["country"].as_str()),
            geo.and_then(|g| g["region"].as_str()),
            geo.and_then(|g| g["state"].as_str())
        )
    );
    let q = fold(query.trim_matches(ecma_space));
    let aq = alias_fold(&q);
    Ok(q.is_empty()
        || text.contains(&q)
        || fold(provider.unwrap_or("")) == q
        || (!aq.is_empty() && aliases(category).contains(&aq)))
}
// UTF-16 big-endian order reproduces JavaScript '<', including supplementary characters.
// Each code unit has a nonzero prefix, with 0 terminating each tuple field.
fn append_key(key: &mut Vec<u8>, value: &str) {
    for unit in value.encode_utf16() {
        key.push(1);
        key.extend_from_slice(&unit.to_be_bytes());
    }
    key.push(0);
}
fn sort_key(
    sort: Sort,
    name: &str,
    source: &str,
    id: &str,
    ordinal: i64,
    geo: [Option<&str>; 3],
) -> Vec<u8> {
    let mut key = Vec::new();
    if sort == Sort::Source {
        key.extend_from_slice(&(ordinal as u64).to_be_bytes());
        return key;
    }
    if sort == Sort::Geography {
        for (field, value) in ["country", "region", "state"].into_iter().zip(geo) {
            key.push(if value.is_some() { 0 } else { 1 });
            if let Some(value) = value {
                append_key(
                    &mut key,
                    &label(field, value).nfc().collect::<String>().to_lowercase(),
                );
                append_key(&mut key, value);
            }
        }
    }
    append_key(&mut key, &name.nfc().collect::<String>().to_lowercase());
    for value in [name, source, id] {
        append_key(&mut key, value);
    }
    key
}
fn grams(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut terms = BTreeSet::new();
    for c in &chars {
        terms.insert(format!("u{:06x}", *c as u32));
    }
    for pair in chars.windows(2) {
        terms.insert(format!("b{:06x}{:06x}", pair[0] as u32, pair[1] as u32));
    }
    terms.into_iter().collect::<Vec<_>>().join(" ")
}
pub fn install_projection(tx: &Transaction<'_>) -> Result<(), String> {
    sql(tx.execute_batch("CREATE TABLE catalog_projection_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),view_revision INTEGER NOT NULL CHECK(view_revision>=0),query_version TEXT NOT NULL);INSERT INTO catalog_projection_meta VALUES(1,0,'');
CREATE TABLE catalog_projection(rowid INTEGER PRIMARY KEY,channel_id TEXT UNIQUE NOT NULL,search_text TEXT NOT NULL,alias_text TEXT NOT NULL,provider_key TEXT NOT NULL,category_key TEXT NOT NULL,source_key BLOB NOT NULL,name_key BLOB NOT NULL,geography_key BLOB NOT NULL,stamp BLOB NOT NULL);
CREATE INDEX catalog_projection_provider ON catalog_projection(provider_key);CREATE INDEX catalog_projection_source ON catalog_projection(source_key);CREATE INDEX catalog_projection_name ON catalog_projection(name_key);CREATE INDEX catalog_projection_geography ON catalog_projection(geography_key);
CREATE INDEX catalog_projection_news ON catalog_projection(source_key) WHERE instr(category_key,'news')>0;CREATE INDEX catalog_projection_sports ON catalog_projection(source_key) WHERE instr(category_key,'sports')>0;
CREATE INDEX catalog_channel_state ON channel(state);CREATE INDEX catalog_channel_region ON channel(region);
CREATE VIRTUAL TABLE catalog_trigram USING fts5(text,tokenize='trigram case_sensitive 1',content='',contentless_delete=1,detail=none);
CREATE VIRTUAL TABLE catalog_shortgram USING fts5(text,tokenize='ascii',content='',contentless_delete=1,detail=none);"))?;
    rebuild_projection(tx)
}
struct ProjectionRow {
    id: String,
    source: String,
    provider: Option<String>,
    name: String,
    category: String,
    ordinal: i64,
    country: Option<String>,
    region: Option<String>,
    state: Option<String>,
    prior_rowid: Option<i64>,
    prior_stamp: Option<Vec<u8>>,
}
fn projection_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectionRow> {
    Ok(ProjectionRow {
        id: row.get(0)?,
        source: row.get(1)?,
        provider: row.get(2)?,
        name: row.get(3)?,
        category: row.get(4)?,
        ordinal: row.get(5)?,
        country: row.get(6)?,
        region: row.get(7)?,
        state: row.get(8)?,
        prior_rowid: row.get(9)?,
        prior_stamp: row.get(10)?,
    })
}
struct ProjectionWriter<'a> {
    connection: &'a Connection,
    insert: rusqlite::Statement<'a>,
    trigram: rusqlite::Statement<'a>,
    shortgram: rusqlite::Statement<'a>,
}
impl<'a> ProjectionWriter<'a> {
    fn new(connection: &'a Connection) -> Result<Self, String> {
        Ok(Self { connection,
            insert: sql(connection.prepare("INSERT INTO catalog_projection(rowid,channel_id,search_text,alias_text,provider_key,category_key,source_key,name_key,geography_key,stamp) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(channel_id) DO UPDATE SET search_text=excluded.search_text,alias_text=excluded.alias_text,provider_key=excluded.provider_key,category_key=excluded.category_key,source_key=excluded.source_key,name_key=excluded.name_key,geography_key=excluded.geography_key,stamp=excluded.stamp RETURNING rowid"))?,
            trigram: sql(connection.prepare("INSERT INTO catalog_trigram(rowid,text) VALUES(?1,?2)"))?,
            shortgram: sql(connection.prepare("INSERT INTO catalog_shortgram(rowid,text) VALUES(?1,?2)"))?,
        })
    }
    fn remove(&self, rowid: i64) -> Result<(), String> {
        sql(self
            .connection
            .execute("DELETE FROM catalog_trigram WHERE rowid=?1", [rowid]))?;
        sql(self
            .connection
            .execute("DELETE FROM catalog_shortgram WHERE rowid=?1", [rowid]))?;
        sql(self
            .connection
            .execute("DELETE FROM catalog_projection WHERE rowid=?1", [rowid]))?;
        Ok(())
    }
    fn apply(&mut self, row: ProjectionRow) -> Result<(), String> {
        let ProjectionRow {
            id,
            source,
            provider,
            name,
            category,
            ordinal,
            country,
            region,
            state,
            prior_rowid,
            prior_stamp,
        } = row;
        let stamp = Sha256::digest(
            serde_json::to_vec(&(
                &labels().version,
                &id,
                &source,
                &provider,
                &name,
                &category,
                ordinal,
                &country,
                &region,
                &state,
            ))
            .map_err(|_| "catalog-query-encoding-failed")?,
        )
        .to_vec();
        if prior_stamp.as_ref() == Some(&stamp) {
            return Ok(());
        }
        let geo = [country.as_deref(), region.as_deref(), state.as_deref()];
        let text = format!(
            "{} {} {} {}",
            fold(&name),
            fold(&category),
            network(provider.as_deref()),
            location(geo[0], geo[1], geo[2])
        );
        let alias = aliases(&category);
        let index_text = format!("{text}\n{alias}");
        if ordinal < 0 {
            return Err("catalog-query-invalid-ordinal".into());
        }
        if let Some(rowid) = prior_rowid {
            sql(self
                .connection
                .execute("DELETE FROM catalog_trigram WHERE rowid=?1", [rowid]))?;
            sql(self
                .connection
                .execute("DELETE FROM catalog_shortgram WHERE rowid=?1", [rowid]))?;
        }
        let rowid: i64 = sql(self.insert.query_row(
            params![
                prior_rowid,
                id,
                text,
                alias,
                fold(provider.as_deref().unwrap_or("")),
                fold(&category),
                sort_key(Sort::Source, &name, &source, &id, ordinal, geo),
                sort_key(Sort::Name, &name, &source, &id, ordinal, geo),
                sort_key(Sort::Geography, &name, &source, &id, ordinal, geo),
                stamp
            ],
            |r| r.get(0),
        ))?;
        sql(self.trigram.execute(params![rowid, index_text]))?;
        sql(self.shortgram.execute(params![rowid, grams(&index_text)]))?;
        Ok(())
    }
}
/// Persisted derived-policy stamp. Canonical schema/data stay unchanged.
pub(crate) fn projection_is_current(c: &Connection) -> Result<bool, String> {
    sql(c.query_row(
        "SELECT query_version=?1 FROM catalog_projection_meta WHERE singleton=1",
        [&labels().version],
        |r| r.get(0),
    ))
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProjectionUpgradeFence {
    revision: i64,
    catalog_revision: i64,
    view_revision: i64,
    schema_version: i64,
    query_version: String,
}
/// One SQLite statement captures every authority before the verified backup.
pub(crate) fn projection_upgrade_fence(
    c: &Connection,
) -> Result<Option<ProjectionUpgradeFence>, String> {
    let fence = sql(c.query_row("SELECT m.revision,m.catalog_revision,p.view_revision,(SELECT user_version FROM pragma_user_version),p.query_version FROM metadata m CROSS JOIN catalog_projection_meta p WHERE m.singleton=1 AND p.singleton=1", [], |r| Ok(ProjectionUpgradeFence { revision:r.get(0)?,catalog_revision:r.get(1)?,view_revision:r.get(2)?,schema_version:r.get(3)?,query_version:r.get(4)? })))?;
    if fence.revision < 0 || fence.catalog_revision < 0 || fence.view_revision < 0 {
        return Err("storage-revision-invalid".into());
    }
    Ok((fence.query_version != labels().version).then_some(fence))
}
/// Caller owns startup admission, verified pre-upgrade backup and final integrity.
/// The IMMEDIATE transaction refuses any change since that backup's admission.
pub(crate) fn upgrade_projection_policy(
    c: &mut Connection,
    expected: Option<ProjectionUpgradeFence>,
) -> Result<(), String> {
    let expected = match expected {
        Some(fence) => Some(fence),
        None => projection_upgrade_fence(c)?,
    };
    let Some(expected) = expected else {
        return Ok(());
    };
    let tx = sql(c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
    if projection_upgrade_fence(&tx)?.as_ref() != Some(&expected) {
        return Err("catalog-query-projection-stale".into());
    }
    rebuild_projection(&tx)?;
    let view: i64 = sql(tx.query_row(
        "SELECT view_revision FROM catalog_projection_meta WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    if view == expected.view_revision {
        advance_view_revision(&tx, true)?;
    }
    sql(tx.commit())
}
fn record_query_version(tx: &Transaction<'_>) -> Result<(), String> {
    sql(tx.execute(
        "UPDATE catalog_projection_meta SET query_version=?1 WHERE singleton=1 AND query_version IS NOT ?1",
        [&labels().version],
    ))?;
    Ok(())
}
pub fn rebuild_projection(tx: &Transaction<'_>) -> Result<(), String> {
    // Generic replacements/migrations still reconcile the entire canonical set.
    let mut writer = ProjectionWriter::new(tx)?;
    let mut stale =
        sql(tx.prepare("SELECT p.rowid FROM catalog_projection p WHERE NOT EXISTS(SELECT 1 FROM channel c WHERE c.id=p.channel_id)"))?;
    let stale_rows = sql(stale.query_map([], |row| row.get::<_, i64>(0)))?;
    let stale_ids = sql(stale_rows.collect::<rusqlite::Result<Vec<_>>>())?;
    for rowid in stale_ids {
        writer.remove(rowid)?;
    }
    let category = effective_category_expression(tx)?;
    let mut read=sql(tx.prepare(&format!("SELECT c.id,c.source_id,c.provider_id,c.name,{category},c.ordinal,c.country,c.region,c.state,p.rowid,p.stamp FROM channel c LEFT JOIN catalog_projection p ON p.channel_id=c.id ORDER BY c.ordinal")))?;
    let mut rows = sql(read.query([]))?;
    while let Some(row) = sql(rows.next())? {
        writer.apply(sql(projection_row(row))?)?;
    }
    if crate::catalog_endpoint_projection::present(tx)? {
        let changed = crate::catalog_endpoint_projection::rebuild(tx)?;
        advance_view_revision(tx, changed)?;
    }
    record_query_version(tx)
}
/// Only admitted compact-patch identities are supplied. All writes remain in
/// the caller's canonical transaction; no revisions, backup or ownership here.
pub(crate) fn reconcile_projection(
    tx: &Transaction<'_>,
    channel_ids: &[String],
) -> Result<(), String> {
    // Source display metadata is absent from these stamps/keys. Favorites and
    // removal membership are live query predicates; the caller still advances
    // view revisions for their changes without rewriting channel postings.
    reconcile_projection_observed(tx, channel_ids, &mut || {})
}
fn reconcile_projection_observed(
    tx: &Transaction<'_>,
    channel_ids: &[String],
    visit: &mut impl FnMut(),
) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    if channel_ids.len() > 64
        || channel_ids
            .iter()
            .any(|id| id.is_empty() || id.len() > 16_384 || !seen.insert(id))
    {
        return Err("catalog-projection-invalid-scope".into());
    }
    let version: String = sql(tx.query_row(
        "SELECT query_version FROM catalog_projection_meta WHERE singleton=1",
        [],
        |row| row.get(0),
    ))?;
    if version != labels().version {
        return rebuild_projection(tx);
    }
    let category = effective_category_expression(tx)?;
    let mut read=sql(tx.prepare(&format!("SELECT c.id,c.source_id,c.provider_id,c.name,{category},c.ordinal,c.country,c.region,c.state,p.rowid,p.stamp FROM channel c LEFT JOIN catalog_projection p ON p.channel_id=c.id WHERE c.id=?1")))?;
    let mut missing = sql(tx.prepare("SELECT rowid FROM catalog_projection WHERE channel_id=?1"))?;
    let mut rows = Vec::new();
    let mut deletes = Vec::new();
    for id in channel_ids {
        visit();
        if let Some(row) = sql(read.query_row([id], projection_row).optional())? {
            rows.push(row);
        } else if let Some(rowid) = sql(missing
            .query_row([id], |row| row.get::<_, i64>(0))
            .optional())?
        {
            deletes.push(rowid);
        }
    }
    let mut writer = ProjectionWriter::new(tx)?;
    // Match full reconciliation's deletion-first/new-ordinal insertion order.
    for rowid in deletes {
        writer.remove(rowid)?;
    }
    rows.sort_by_key(|row| row.ordinal);
    for row in rows {
        writer.apply(row)?;
    }
    if crate::catalog_endpoint_projection::present(tx)? {
        let changed = crate::catalog_endpoint_projection::reconcile(tx, channel_ids)?;
        advance_view_revision(tx, changed)?;
    }
    record_query_version(tx)
}
pub fn advance_view_revision(tx: &Transaction<'_>, changed: bool) -> Result<(), String> {
    if changed
        && sql(tx.execute(
            "UPDATE catalog_projection_meta SET view_revision=view_revision+1 WHERE singleton=1 AND view_revision<9223372036854775807",
            [],
        ))? != 1
    {
        return Err("catalog-view-revision-exhausted".into());
    }
    Ok(())
}
fn revision(value: &str) -> Result<i64, String> {
    if value.is_empty()
        || value.len() > 19
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("catalog-query-invalid-revision".into());
    }
    value
        .parse()
        .map_err(|_| "catalog-query-invalid-revision".into())
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(value: &str) -> Result<Vec<u8>, String> {
    if value.len() > CURSOR_LIMIT
        || !value.len().is_multiple_of(2)
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("catalog-query-invalid-cursor".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&value[i..i + 2], 16)
                .map_err(|_| "catalog-query-invalid-cursor".into())
        })
        .collect()
}
struct Progress<'a> {
    connection: &'a Connection,
    active: bool,
}
impl Progress<'_> {
    fn clear(&mut self) -> Result<(), String> {
        self.connection
            .progress_handler(0, None::<fn() -> bool>)
            .map_err(|_| "catalog-query-cleanup-failed")?;
        self.active = false;
        Ok(())
    }
}
impl Drop for Progress<'_> {
    fn drop(&mut self) {
        if self.active {
            let _ = self.connection.progress_handler(0, None::<fn() -> bool>);
        }
    }
}
/// Uncached reference query; the store uses [`query_page_cached`].
#[cfg_attr(not(test), allow(dead_code))]
pub fn query_page(c: &Connection, query: &Query, cancel: &Arc<AtomicBool>) -> Result<Page, String> {
    query_page_inner(
        c,
        query,
        cancel,
        None,
        #[cfg(test)]
        None,
    )
}
/// The same result as [`query_page`], reusing the ordered result of an
/// identical query at an unchanged database (`database` is its file).
pub(crate) fn query_page_cached(
    c: &Connection,
    query: &Query,
    cancel: &Arc<AtomicBool>,
    cache: &PageCache,
    database: &std::path::Path,
) -> Result<Page, String> {
    query_page_inner(
        c,
        query,
        cancel,
        Some((cache, database)),
        #[cfg(test)]
        None,
    )
}
fn query_page_inner(
    c: &Connection,
    query: &Query,
    cancel: &Arc<AtomicBool>,
    cache: Option<(&PageCache, &std::path::Path)>,
    #[cfg(test)] hook: Option<Arc<dyn Fn() + Send + Sync>>,
) -> Result<Page, String> {
    crate::native_catalog::observe_stage(&query.request_id, "sql-enter");
    check(cancel)?;
    if query.schema_version != 1
        || query.request_id.is_empty()
        || query.request_id.len() > 256
        || query.request_id.chars().any(char::is_control)
        || !(1..=50).contains(&query.page_size)
        || query.query.len() > 16384
        || query.start_index.is_some_and(|i| i > 100000)
        || (query.after.is_some() && (query.start_index.is_some() || query.anchor_id.is_some()))
        || (query.start_index.is_some() && query.anchor_id.is_some())
        || query
            .anchor_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 16384 || id.chars().any(char::is_control))
    {
        return Err("catalog-query-invalid".into());
    }
    let q = fold(query.query.trim_matches(ecma_space));
    let aq = alias_fold(&q);
    let code = |s: &str| {
        !s.is_empty()
            && s.len() <= 32
            && s.bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b"_-".contains(&b))
    };
    if let Some(list) = query.geography.get("countries") {
        // Any of 2 to 64 distinct countries, alone (no country, region or state).
        let codes: Option<Vec<&str>> = list
            .as_array()
            .and_then(|a| a.iter().map(Value::as_str).collect());
        if !codes.is_some_and(|c| {
            (2..=64).contains(&c.len())
                && c.iter().all(|s| code(s))
                && c.iter().collect::<std::collections::HashSet<_>>().len() == c.len()
        }) || query.geography.len() != 1
        {
            return Err("catalog-query-invalid-geography".into());
        }
    }
    for (field, value) in query
        .geography
        .iter()
        .filter(|(f, _)| f.as_str() != "countries")
    {
        if !["country", "region", "state"].contains(&field.as_str())
            || !(value.is_null()
                || value.as_str().is_some_and(|s| {
                    !s.is_empty()
                        && s.len() <= 32
                        && s.bytes().all(|b| {
                            b.is_ascii_uppercase() || b.is_ascii_digit() || b"_-".contains(&b)
                        })
                }))
        {
            return Err("catalog-query-invalid-geography".into());
        }
    }
    let flag = Arc::clone(cancel);
    sql(c.progress_handler(
        1000,
        Some(move || {
            crate::native_catalog::observe_progress();
            #[cfg(test)]
            if let Some(hook) = &hook {
                hook();
            }
            flag.load(Ordering::SeqCst)
        }),
    ))?;
    let mut progress = Progress {
        connection: c,
        active: true,
    };
    let outcome = (|| {
        let tx = sql(c.unchecked_transaction())?;
        let endpoint_projection = crate::catalog_endpoint_projection::present(&tx)?;
        let database_version: i64 = sql(tx.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
        if database_version >= 12 && !endpoint_projection {
            return Err("catalog-query-projection-stale".into());
        }
        if endpoint_projection {
            let complete: bool = sql(tx.query_row(
                "SELECT (SELECT count(*) FROM channel)=(SELECT count(*) FROM catalog_endpoint_projection_v1)",
                [],
                |r| r.get(0),
            ))?;
            if !complete {
                return Err("catalog-query-projection-stale".into());
            }
        }
        let (cr,vr,version):(i64,i64,String)=sql(tx.query_row("SELECT m.catalog_revision,p.view_revision,p.query_version FROM metadata m CROSS JOIN catalog_projection_meta p WHERE m.singleton=1 AND p.singleton=1",[],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))))?;
        if cr < 0 || vr < 0 || version != labels().version {
            return Err("catalog-query-projection-stale".into());
        }
        if query
            .expected_catalog_revision
            .as_deref()
            .map(revision)
            .transpose()?
            .is_some_and(|r| r != cr)
        {
            return Err("catalog-revision-stale".into());
        }
        if query
            .expected_view_revision
            .as_deref()
            .map(revision)
            .transpose()?
            .is_some_and(|r| r != vr)
        {
            return Err("catalog-view-revision-stale".into());
        }
        // Slow channels sort after fast ones (owner design, October 21, 2026).
        // The key changes only while some channel carries the badge, so the
        // list's order and cursors are exactly as before when none does.
        let slow_any: bool = sql(tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_speed_v1')",
            [],
            |r| r.get(0),
        ))? && sql(tx.query_row("SELECT EXISTS(SELECT 1 FROM channel_speed_v1 WHERE slow=1)", [], |r| r.get(0)))?;
        let query_key = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    QUERY_VERSION,
                    endpoint_projection.then_some(crate::catalog_endpoint_projection::POLICY),
                    &version,
                    &q,
                    &aq,
                    query.filter,
                    &query.geography,
                    query.sort,
                    query.favorites_first,
                    slow_any,
                    vr // Favorite/removal/Slow membership revisions bind ordering and cursor scope.
                ))
                .map_err(|_| "catalog-query-invalid")?
            )
        );
        let base_sort = match query.sort {
            Sort::Source => "p.source_key",
            Sort::Name => "p.name_key",
            Sort::Geography => "p.geography_key",
        };
        // Prefix the stable binary key; every rank/anchor/cursor/window uses this exact order.
        let favorite = "(CASE WHEN EXISTS(SELECT 1 FROM favorite f WHERE f.id=p.channel_id) THEN x'00' ELSE x'01' END)";
        let speed =
            "(CASE WHEN EXISTS(SELECT 1 FROM channel_speed_v1 s WHERE s.channel_id=p.channel_id AND s.slow=1) THEN x'01' ELSE x'00' END)";
        let sort = match (query.favorites_first, slow_any) {
            (false, false) => base_sort.to_owned(),
            (true, false) => format!("CAST({favorite} || {base_sort} AS BLOB)"),
            (false, true) => format!("CAST({speed} || {base_sort} AS BLOB)"),
            (true, true) => format!("CAST({favorite} || {speed} || {base_sort} AS BLOB)"),
        };
        let mut values: Vec<SqlValue> = Vec::new();
        let mut predicates =
            vec!["NOT EXISTS(SELECT 1 FROM removed r WHERE r.id=p.channel_id)".to_string()];
        if !q.is_empty() {
            let chars: Vec<char> = q.chars().collect();
            let (table, token) = match chars.as_slice() {
                [a] => ("catalog_shortgram", format!("u{:06x}", *a as u32)),
                [a, b] => (
                    "catalog_shortgram",
                    format!("b{:06x}{:06x}", *a as u32, *b as u32),
                ),
                _ => (
                    "catalog_trigram",
                    format!(
                        "\"{}\"",
                        chars[..3].iter().collect::<String>().replace('"', "\"\"")
                    ),
                ),
            };
            // Aliases normalize internal whitespace separately from literal main search.
            let achars: Vec<char> = aq.chars().collect();
            let alias_token = match achars.as_slice() {
                [a] => format!("u{:06x}", *a as u32),
                [a, b] => format!("b{:06x}{:06x}", *a as u32, *b as u32),
                _ => format!(
                    "\"{}\"",
                    achars
                        .iter()
                        .take(3)
                        .collect::<String>()
                        .replace('"', "\"\"")
                ),
            };
            let alias_table = if achars.len() < 3 {
                "catalog_shortgram"
            } else {
                "catalog_trigram"
            };
            let mut candidates = format!("SELECT rowid FROM {table} WHERE {table} MATCH ?");
            values.push(token.clone().into());
            if !aq.is_empty() && (table != alias_table || token != alias_token) {
                candidates.push_str(&format!(
                    " UNION ALL SELECT rowid FROM {alias_table} WHERE {alias_table} MATCH ?"
                ));
                values.push(alias_token.into());
            }
            // IN itself has set semantics; a second UNION distinct sort is redundant.
            candidates
                .push_str(" UNION ALL SELECT rowid FROM catalog_projection WHERE provider_key=?");
            predicates.push(format!(
                "p.rowid IN({candidates}) AND (instr(p.search_text,?)>0 OR p.provider_key=? OR (?<>'' AND instr(p.alias_text,?)>0))"
            ));
            for value in [q.clone(), q.clone(), q.clone(), aq.clone(), aq.clone()] {
                values.push(value.into());
            }
        }
        match query.filter {
            Filter::Favorites => predicates.push("p.channel_id IN(SELECT id FROM favorite)".into()),
            Filter::News => predicates.push("instr(p.category_key,'news')>0".into()),
            Filter::Sports => predicates.push("instr(p.category_key,'sports')>0".into()),
            Filter::Movies => predicates.push("instr(p.category_key,'movie')>0".into()),
            Filter::Unresponsive => predicates.push(
                if crate::storage_transaction::channel_check::table_present(c)? {
                    crate::storage_transaction::channel_check::not_responding_predicate(
                        "p.channel_id",
                    )
                } else {
                    "0".into()
                },
            ),
            Filter::All => {}
        }
        if query.hide_adult {
            predicates
                .push("instr(p.category_key,'xxx')=0 AND instr(p.category_key,'adult')=0".into());
        }
        for (field, value) in &query.geography {
            if let Some(list) = value.as_array() {
                predicates.push(format!(
                    "c.country IN ({})",
                    vec!["?"; list.len()].join(",")
                ));
                values.extend(list.iter().map(|v| v.as_str().unwrap().to_owned().into()));
            } else if value.is_null() {
                predicates.push(format!("c.{field} IS NULL"));
            } else {
                predicates.push(format!("c.{field}=?"));
                values.push(value.as_str().unwrap().to_owned().into());
            }
        }
        // Match retained source aliases before selecting a representative. A
        // group's representative need not itself carry the matching title,
        // category or geography. All operations share these exact predicates.
        let mut prefix = String::new();
        let base = if endpoint_projection {
            let members = crate::catalog_endpoint_projection::MEMBERS_CTE.trim_end();
            prefix = format!("{members}, matching_aliases AS MATERIALIZED(SELECT DISTINCT am.endpoint_key,am.preferred,am.custom_category,am.guide_source,am.guide_channel FROM endpoint_members am JOIN catalog_projection p ON p.channel_id=am.channel_id JOIN channel c ON c.id=p.channel_id WHERE {}) ", predicates.join(" AND "));
            predicates = vec!["em.position=1".into()];
            format!(
                "catalog_projection p JOIN endpoint_members em ON em.channel_id=p.channel_id JOIN matching_aliases ma ON {}",
                crate::catalog_endpoint_projection::SAME_GROUP.replace("am.", "ma.")
            )
        } else if query.geography.is_empty() {
            "catalog_projection p".to_owned()
        } else {
            "catalog_projection p JOIN channel c ON c.id=p.channel_id".to_owned()
        };
        // The stamp is read while this transaction holds its shared lock, so no
        // write can commit between it and the rows read here.
        let cached: Option<Ordered> = match cache {
            None => None,
            Some((store, database)) => {
                let key = format!(
                    "{}\n{cr}\n{vr}\n{}\n{query_key}",
                    database_stamp(database)?,
                    query.hide_adult
                );
                let hit = store
                    .0
                    .lock()
                    .map_err(|_| "catalog-query-cache-lock")?
                    .as_ref()
                    .filter(|(held, _)| *held == key)
                    .map(|(_, list)| list.clone());
                Some(match hit {
                    Some(list) => list,
                    None => {
                        let mut stmt = sql(tx.prepare(&format!(
                            "{prefix}SELECT p.channel_id,{sort} FROM {base} WHERE {} ORDER BY {sort}",
                            predicates.join(" AND ")
                        )))?;
                        let mut rows = sql(stmt.query(params_from_iter(values.iter())))?;
                        let mut list = Vec::new();
                        while let Some(row) = sql(rows.next())? {
                            if list.len() == 100000 {
                                return Err("catalog-query-count-limit".into());
                            }
                            list.push((
                                sql(row.get::<_, String>(0))?,
                                sql(row.get::<_, Vec<u8>>(1))?,
                            ));
                        }
                        let list = Arc::new(list);
                        *store.0.lock().map_err(|_| "catalog-query-cache-lock")? =
                            Some((key, list.clone()));
                        list
                    }
                })
            }
        };
        let total_count: i64 = match &cached {
            Some(list) => list.len() as i64,
            None => sql(tx.query_row(
                &format!(
                    "{prefix}SELECT count(*) FROM {base} WHERE {}",
                    predicates.join(" AND ")
                ),
                params_from_iter(values.iter()),
                |r| r.get(0),
            ))?,
        };
        if !(0..=100000).contains(&total_count) {
            return Err("catalog-query-count-limit".into());
        }
        let mut start_index = query.start_index.unwrap_or(0).min(total_count as usize);
        let mut anchor_index = None;
        if let Some(anchor) = &query.anchor_id {
            let mut anchor_values = values.clone();
            let anchor = if endpoint_projection {
                crate::catalog_endpoint_projection::representative(&tx, anchor)?
                    .unwrap_or_else(|| anchor.clone())
            } else {
                anchor.clone()
            };
            let key: Option<Vec<u8>> = match &cached {
                Some(list) => list
                    .iter()
                    .find(|(id, _)| *id == anchor)
                    .map(|(_, key)| key.clone()),
                None => {
                    anchor_values.push(anchor.into());
                    sql(tx
                        .query_row(
                            &format!(
                                "{prefix}SELECT {sort} FROM {base} WHERE {} AND p.channel_id=?",
                                predicates.join(" AND ")
                            ),
                            params_from_iter(anchor_values),
                            |r| r.get(0),
                        )
                        .optional())?
                }
            };
            if let Some(key) = key {
                let rank: i64 = match &cached {
                    Some(list) => list.partition_point(|(_, k)| *k < key) as i64,
                    None => {
                        let mut rank_values = values.clone();
                        rank_values.push(key.into());
                        sql(tx.query_row(
                            &format!(
                                "{prefix}SELECT count(*) FROM {base} WHERE {} AND {sort}<?",
                                predicates.join(" AND ")
                            ),
                            params_from_iter(rank_values),
                            |r| r.get(0),
                        ))?
                    }
                };
                anchor_index = Some(rank as usize);
                start_index = (rank as usize).saturating_sub(1);
            }
        }
        if let Some(cursor) = &query.after {
            if cursor.schema_version != 1
                || cursor.query_key != query_key
                || revision(&cursor.catalog_revision)? != cr
                || revision(&cursor.view_revision)? != vr
                || query.expected_catalog_revision.as_deref()
                    != Some(cursor.catalog_revision.as_str())
                || query.expected_view_revision.as_deref() != Some(cursor.view_revision.as_str())
                || cursor.id.len() > 16384
            {
                return Err("catalog-query-cursor-stale".into());
            }
            let key = unhex(&cursor.sort_key)?;
            // Cursor anchors must exist exactly in this projection, not fabricate skipped ranges.
            let cursor_prefix = if endpoint_projection {
                crate::catalog_endpoint_projection::MEMBERS_CTE
            } else {
                ""
            };
            let cursor_base = if endpoint_projection {
                "catalog_projection p JOIN endpoint_members em ON em.channel_id=p.channel_id AND em.position=1"
            } else {
                "catalog_projection p"
            };
            let listed = cached
                .as_ref()
                .is_some_and(|list| list.iter().any(|(id, k)| *id == cursor.id && *k == key));
            let exists: i64 = if listed {
                1
            } else {
                sql(tx.query_row(
                    &format!("{cursor_prefix}SELECT count(*) FROM {cursor_base} WHERE p.channel_id=? AND {sort}=?"),
                    params![cursor.id, key],
                    |r| r.get(0),
                ))?
            };
            if exists != 1 {
                return Err("catalog-query-invalid-cursor".into());
            }
            let rank: i64 = match &cached {
                Some(list) => list.partition_point(|(_, k)| *k <= key) as i64,
                None => {
                    let mut rank_values = values.clone();
                    rank_values.push(key.clone().into());
                    sql(tx.query_row(
                        &format!(
                            "{prefix}SELECT count(*) FROM {base} WHERE {} AND {sort}<=?",
                            predicates.join(" AND ")
                        ),
                        params_from_iter(rank_values),
                        |r| r.get(0),
                    ))?
                }
            };
            start_index = rank as usize;
            predicates.push(format!("{sort}>?"));
            values.push(key.into());
        }
        values.push(((query.page_size + 1) as i64).into());
        let offset = if query.after.is_none() {
            values.push((start_index as i64).into());
            " OFFSET ?"
        } else {
            ""
        };
        // Materialize only the requested IDs/keys, then hydrate bounded metadata.
        let category = effective_category_expression(&tx)?;
        let window_prefix = if prefix.is_empty() {
            "WITH ".to_owned()
        } else {
            format!("{}, ", prefix.trim_end())
        };
        let raw_rows: Vec<RawRow> = match &cached {
            Some(list) => {
                // Hydrate only the requested slice of the cached order.
                let mut stmt = sql(tx.prepare(&format!("SELECT c.id,c.source_id,c.provider_id,c.name,{category},c.country,c.region,c.state,EXISTS(SELECT 1 FROM favorite f WHERE f.id=c.id) FROM channel c WHERE c.id=?1")))?;
                let mut rows = Vec::new();
                for (id, key) in list.iter().skip(start_index).take(query.page_size + 1) {
                    check(cancel)?;
                    let mut raw = sql(stmt.query_row([id], raw_row))?;
                    raw.sort_key = key.clone();
                    rows.push(raw);
                }
                rows
            }
            None => {
                let statement=format!("{window_prefix}catalog_window AS MATERIALIZED(SELECT p.channel_id,{sort} AS sort_key FROM {base} WHERE {} ORDER BY {sort} LIMIT ?{offset}) SELECT c.id,c.source_id,c.provider_id,c.name,{category},c.country,c.region,c.state,EXISTS(SELECT 1 FROM favorite f WHERE f.id=c.id),w.sort_key FROM catalog_window w JOIN channel c ON c.id=w.channel_id ORDER BY w.sort_key",predicates.join(" AND "));
                let mut stmt = sql(tx.prepare(&statement))?;
                let mut rows = sql(stmt.query(params_from_iter(values)))?;
                let mut collected = Vec::new();
                while let Some(row) = sql(rows.next())? {
                    check(cancel)?;
                    let mut raw = sql(raw_row(row))?;
                    raw.sort_key = sql(row.get(9))?;
                    collected.push(raw);
                }
                collected
            }
        };
        let mut out = Vec::new();
        let mut last_key = Vec::new();
        let mut more = false;
        let mut row_bytes = 0;
        for raw in raw_rows {
            check(cancel)?;
            if out.len() == query.page_size {
                more = true;
                break;
            }
            let mut geography = Map::new();
            for (value, field) in raw
                .geography
                .into_iter()
                .zip(["country", "region", "state"])
            {
                if let Some(v) = value {
                    geography.insert(field.into(), Value::String(v));
                }
            }
            let item = Row {
                id: raw.id,
                source_id: raw.source_id,
                provider_id: raw.provider_id,
                name: raw.name,
                category: raw.category,
                geography: if geography.is_empty() {
                    None
                } else {
                    Some(geography)
                },
                favorite: raw.favorite,
            };
            let encoded = serde_json::to_vec(&item)
                .map_err(|_| "catalog-query-encoding-failed")?
                .len()
                + 1;
            // Reserve the bounded cursor and envelope; remaining rows stay reachable by cursor.
            if row_bytes + encoded > RESPONSE_LIMIT - CURSOR_LIMIT - 8192 {
                if out.is_empty() {
                    return Err("catalog-query-response-limit".into());
                }
                more = true;
                break;
            }
            row_bytes += encoded;
            out.push(item);
            last_key = raw.sort_key;
        }
        let after = if more {
            Some(Cursor {
                schema_version: 1,
                query_key,
                catalog_revision: cr.to_string(),
                view_revision: vr.to_string(),
                sort_key: hex(&last_key),
                id: out.last().unwrap().id.clone(),
            })
        } else {
            None
        };
        let page = Page {
            schema_version: 1,
            request_id: query.request_id.clone(),
            catalog_revision: cr.to_string(),
            view_revision: vr.to_string(),
            query_version: version,
            total_count,
            start_index,
            anchor_index,
            rows: out,
            after,
        };
        if serde_json::to_vec(&page)
            .map_err(|_| "catalog-query-encoding-failed")?
            .len()
            > RESPONSE_LIMIT
        {
            return Err("catalog-query-response-limit".into());
        }
        check(cancel)?;
        Ok(page)
    })();
    progress.clear()?;
    if cancel.load(Ordering::SeqCst) {
        Err("catalog-query-cancelled".into())
    } else {
        outcome
    }
}

#[cfg(test)]
#[path = "catalog_query_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "catalog_projection_delta_tests.rs"]
mod projection_delta_tests;
