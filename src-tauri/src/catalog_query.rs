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

#[cfg(test)]
#[path = "catalog_query_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "catalog_projection_delta_tests.rs"]
mod projection_delta_tests;

// This module's parts, by area, are in catalog_query/.
mod query;
pub use query::*;
