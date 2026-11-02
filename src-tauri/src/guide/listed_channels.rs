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

//! Complete, paged membership of saved channels with drawable listings. No mutation/network.
use super::database::{sql, valid_text, valid_time};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use unicode_normalization::UnicodeNormalization;

/// Large pages also bound IPC overhead. A per-store inventory cache now avoids
/// repeating global endpoint grouping for each page; oversized inventories use
/// the original bounded SQL pages. MAX_BYTES still bounds each serialized page.
pub(crate) const PAGE: usize = 1024;
const MAX_TOTAL: usize = 100_000;
const MAX_BYTES: usize = 512 * 1024;
const SEARCH_BYTES: usize = 256;
const SEARCH_TOKENS: usize = 8;
/// Punctuation that also starts a word, besides spaces.
const WORD_BREAKS: [&str; 8] = ["(", "[", "-", "/", ":", "\"", "#", "."];
#[path = "listed_channels_cache.rs"]
mod cache;
pub(crate) use cache::{database_stamp, InventoryCache};

pub(crate) type Cancel = Arc<dyn Fn() -> bool + Send + Sync>;
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Query {
    pub start_ms: i64,
    pub end_ms: i64,
    pub cursor: Option<String>,
    /// Keep channels whose name, or a program title, description or category
    /// within the window, contains every word.
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub geography: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub ppv: bool,
    #[serde(default)]
    pub sports: Option<crate::catalog::sports::Scope>,
    #[serde(default)]
    pub history_ids: Option<Vec<String>>,
    #[serde(default)]
    pub hide_adult: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Cursor {
    version: u8,
    start_ms: i64,
    end_ms: i64,
    pub root_generation: u64,
    catalog_revision: String,
    mutation_revision: i64,
    database_revision: i64,
    view_revision: i64,
    grouping_policy: String,
    catalog_source_id: String,
    app_channel_id: String,
    seen: usize,
    #[serde(default)]
    search: String,
    #[serde(default)]
    geography: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    ppv: bool,
    #[serde(default)]
    sports: Option<crate::catalog::sports::Scope>,
    #[serde(default)]
    literal_search: String,
    #[serde(default)]
    history_key: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Channel {
    pub catalog_source_id: String,
    pub app_channel_id: String,
    pub guide_source_id: String,
    pub xmltv_channel_id: String,
    pub source_revision: i64,
    pub filter_mask: u8,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    pub start_ms: i64,
    pub end_ms: i64,
    pub root_generation: u64,
    pub catalog_revision: String,
    pub database_revision: i64,
    pub view_revision: String,
    pub grouping_policy: String,
    pub channels: Vec<Channel>,
    pub next_cursor: Option<String>,
}
/// Words folded like stored search text (NFKC, lowercase, whitespace split).
pub(crate) fn search_tokens(q: &Query) -> Result<Vec<String>, String> {
    let Some(raw) = q.search.as_deref() else {
        return Ok(Vec::new());
    };
    if raw.len() > SEARCH_BYTES || raw.chars().any(char::is_control) {
        return Err("guide-listed-invalid-search".into());
    }
    let folded = raw.nfkc().collect::<String>().to_lowercase();
    let tokens: Vec<String> = folded
        .split(|c: char| c.is_whitespace() || c == '\u{feff}')
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect();
    if tokens.len() > SEARCH_TOKENS {
        return Err("guide-listed-invalid-search".into());
    }
    Ok(tokens)
}
fn literal_search(q: &Query) -> String {
    q.search
        .as_deref()
        .unwrap_or_default()
        .nfkc()
        .collect::<String>()
        .to_lowercase()
        .trim()
        .into()
}
pub(crate) fn validate_history(
    ids: Option<&[String]>,
    hide_adult: Option<bool>,
    ppv: bool,
) -> Result<(), String> {
    if !crate::catalog_query::valid_history_ids(ids, ids.is_some())
        || (ids.is_none() && hide_adult.is_some())
        || (ids.is_some() && ppv)
    {
        return Err("guide-invalid-history-scope".into());
    }
    Ok(())
}
fn history_key(q: &Query) -> Result<String, String> {
    if q.history_ids.is_some() {
        super::database::key((&q.history_ids, q.hide_adult.unwrap_or(true)))
    } else {
        Ok(String::new())
    }
}
pub(crate) fn cursor(q: &Query) -> Result<Option<Cursor>, String> {
    validate_history(q.history_ids.as_deref(), q.hide_adult, q.ppv)?;
    super::location_filter::validate(&q.geography)?;
    valid_time(q.start_ms)?;
    valid_time(q.end_ms)?;
    if q.end_ms <= q.start_ms || q.end_ms - q.start_ms > 7 * 86_400_000 {
        return Err("guide-listed-invalid-window".into());
    }
    q.cursor
        .as_ref()
        .map(|raw| {
            if raw.len() > 128 * 1024 {
                return Err("guide-listed-invalid-cursor".into());
            }
            let v: Cursor = serde_json::from_str(raw).map_err(|_| "guide-listed-invalid-cursor")?;
            valid_text(&v.catalog_source_id, 16_384, true)?;
            valid_text(&v.app_channel_id, 16_384, true)?;
            if v.version != 3
                || v.ppv != q.ppv
                || v.sports != q.sports
                || v.literal_search != literal_search(q)
                || v.history_key != history_key(q)?
                || v.search != search_tokens(q)?.join(" ")
                || v.geography != q.geography
                || v.start_ms != q.start_ms
                || v.end_ms != q.end_ms
                || v.seen == 0
                || v.seen >= MAX_TOTAL
                || v.database_revision < 0
                || v.mutation_revision < 0
                || v.view_revision < 0
                || v.grouping_policy != crate::catalog_endpoint_projection::POLICY
                || v.catalog_revision.parse::<u64>().is_err()
            {
                return Err("guide-listed-invalid-cursor".into());
            }
            Ok(v)
        })
        .transpose()
}
struct Progress<'a>(&'a Connection);
impl Drop for Progress<'_> {
    fn drop(&mut self) {
        let _ = self.0.progress_handler(0, None::<fn() -> bool>);
    }
}
pub(crate) fn query(
    c: &Connection,
    q: &Query,
    generation: u64,
    cancel: Cancel,
) -> Result<Page, String> {
    query_inner(c, q, generation, cancel, None)
}
/// Stamp captured before SQLite open, rechecked inside its read snapshot and
/// before publishing: a replaced path must never seed a new file's cache.
pub(crate) fn query_cached(
    c: &Connection,
    q: &Query,
    generation: u64,
    cancel: Cancel,
    cache: &InventoryCache,
    path: &std::path::Path,
    opened_stamp: &str,
) -> Result<Page, String> {
    let unchanged = || {
        if database_stamp(path)? != opened_stamp {
            return Err("guide-listed-storage-changed".to_string());
        }
        Ok(())
    };
    unchanged()?;
    let result = query_inner(
        c,
        q,
        generation,
        cancel.clone(),
        Some((cache, opened_stamp, &unchanged)),
    );
    unchanged()?;
    if result
        .as_ref()
        .is_err_and(|e| e == "guide-listed-cache-budget")
    {
        let page = query(c, q, generation, cancel)?;
        unchanged()?;
        return Ok(page);
    }
    result
}
type CacheRead<'a> = (
    &'a InventoryCache,
    &'a str,
    &'a dyn Fn() -> Result<(), String>,
);
fn query_inner(
    c: &Connection,
    q: &Query,
    generation: u64,
    cancel: Cancel,
    cached: Option<CacheRead<'_>>,
) -> Result<Page, String> {
    crate::catalog::ppv::register(c)?;
    crate::catalog::sports::register_evidence(c)?;
    let sports = q
        .sports
        .as_ref()
        .map(|scope| {
            crate::catalog::sports::Plan::new(scope, q.search.as_deref().unwrap_or_default())
        })
        .transpose()?;
    if let Some(plan) = &sports {
        crate::catalog::sports::register(c, plan)?;
    }
    let after = cursor(q)?;
    let captured_history_key = history_key(q)?;
    crate::catalog_query::register_watch_history(c, q.history_ids.as_deref().unwrap_or_default())?;
    let tokens = search_tokens(q)?;
    let check = || {
        if cancel() {
            Err("guide-cancelled".to_string())
        } else {
            Ok(())
        }
    };
    check()?;
    let during = cancel.clone();
    sql(c.progress_handler(1000, Some(move || during())))?;
    let _progress = Progress(c);
    let result = (|| {
        let tx = sql(c.unchecked_transaction())?;
        let (catalog, mutation, database): (i64, i64, i64) = sql(tx.query_row(
            "SELECT m.catalog_revision,m.revision,g.revision FROM metadata m,guide_meta g WHERE m.singleton=1 AND g.singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ))?;
        if catalog < 0 || mutation < 0 || database < 0 {
            return Err("guide-invalid-stored-revision".into());
        }
        // Use the same derived authority and exact group partition as Live TV.
        // Never silently fall back to raw aliases if either projection is stale.
        if !crate::catalog_endpoint_projection::present(&tx)?
            || !crate::catalog_query::projection_is_current(&tx)?
        {
            return Err("guide-listed-projection-stale".into());
        }
        let (view,complete): (i64,bool) = sql(tx.query_row("SELECT view_revision,(SELECT count(*) FROM channel)=(SELECT count(*) FROM catalog_endpoint_projection_v1) AND (SELECT count(*) FROM channel)=(SELECT count(*) FROM catalog_projection) FROM catalog_projection_meta WHERE singleton=1", [], |r| Ok((r.get(0)?,r.get(1)?))))?;
        if view < 0 || !complete {
            return Err("guide-listed-projection-stale".into());
        }
        let catalog_revision = catalog.to_string();
        if after.as_ref().is_some_and(|v| {
            v.root_generation != generation
                || v.catalog_revision != catalog_revision
                || v.database_revision != database
                || v.view_revision != view
        }) {
            return Err("guide-listed-stale-cursor".into());
        }
        let cache_key = cached
            .map(|(_, stamp, _)| {
                super::database::key((
                    stamp,
                    generation,
                    catalog,
                    database,
                    view,
                    crate::catalog_endpoint_projection::POLICY,
                    q.start_ms,
                    q.end_ms,
                    &tokens,
                    &q.search,
                    crate::catalog::sports::VOCABULARY,
                    &q.geography,
                    q.ppv,
                    &q.sports,
                    &captured_history_key,
                ))
            })
            .transpose()?;
        if let Some((_, _, unchanged)) = cached {
            unchanged()?;
        }
        let hit = if let (Some((cache, _, _)), Some(key)) = (cached, cache_key.as_ref()) {
            cache.get(key)?
        } else {
            None
        };
        let mut inventory_to_publish = None;
        let mut channels = if let Some(inventory) = hit {
            inventory_page(&inventory, after.as_ref())?
        } else {
            // Fixed filter facts cover every member of the same Live group. In
            // particular, a source's Sports alias must not disappear merely because
            // its chosen representative has a different source-supplied category.
            // Match geography on aliases before choosing that same representative,
            // just as Live does. Category facts are confined to those matching aliases.
            let sql_tokens = if sports.is_some() {
                &[][..]
            } else {
                tokens.as_slice()
            };
            let (geography_clause, geography_values) = super::location_filter::clause(
                &q.geography,
                if q.history_ids.is_some() {
                    "c"
                } else {
                    "location"
                },
                6 + sql_tokens.len(),
            )?;
            let channel_ppv = "ppg.ppv";
            let marker = format!("({channel_ppv} OR genx_ppv_program(p.title,p.categories_json))");
            let category = "COALESCE((SELECT category FROM channel_category_override WHERE channel_id=c.id),c.category)";
            let semantic = format!("genx_sports_program(c.name,c.category,{category},p.title,p.description,p.categories_json,(SELECT search_text||char(10)||provider_key FROM catalog_projection WHERE channel_id=c.id))");
            let ppv_scope = if q.ppv {
                marker
            } else if sports.as_ref().is_some_and(|p| p.include_ppv()) {
                format!(
                    "(NOT {marker} OR {})",
                    semantic.replace("genx_sports_program", "genx_sports_ppv_program")
                )
            } else {
                format!("NOT {marker}")
            };
            let semantic_clause = if sports.is_some() {
                format!(" AND {semantic}")
            } else {
                String::new()
            };
            let ppv_mask = if q.ppv {
                "8".to_owned()
            } else if sports.as_ref().is_some_and(|p| p.include_ppv()) {
                format!("CASE WHEN ppg.ppv OR (NOT genx_sports_list_channel(c.name,c.category,{category},(SELECT search_text||char(10)||provider_key FROM catalog_projection WHERE channel_id=c.id)) AND NOT EXISTS(SELECT 1 FROM guide_program p INDEXED BY guide_program_channel_time WHERE p.guide_source_id=m.guide_source_id AND p.channel_id=m.xmltv_channel_id AND p.start_ms<?2 AND ((p.stop_ms IS NOT NULL AND p.stop_ms>?1) OR(p.stop_ms IS NULL AND p.start_ms>=?1)) AND NOT genx_ppv_program(p.title,p.categories_json){semantic_clause})) THEN 8 ELSE 0 END")
            } else {
                "0".into()
            };
            let statement = format!("{}, filter_facts AS MATERIALIZED(SELECT em.endpoint_key,em.preferred,em.custom_category,em.guide_source,em.guide_channel,MAX(instr(p.category_key,'news')>0) AS news,MAX(instr(p.category_key,'sports')>0 OR genx_sports_evidence(location.name,location.category,p.category_key)) AS sports FROM endpoint_members em JOIN catalog_projection p ON p.channel_id=em.channel_id JOIN channel location ON location.id=em.channel_id WHERE 1=1{geography_clause} GROUP BY em.endpoint_key,em.preferred,em.custom_category,em.guide_source,em.guide_channel) SELECT m.catalog_source_id,m.app_channel_id,m.guide_source_id,m.xmltv_channel_id,s.revision,em.preferred+2*am.news+4*am.sports+({ppv_mask}) FROM guide_mapping m JOIN channel c ON c.source_id=m.catalog_source_id AND c.id=m.app_channel_id JOIN endpoint_members em ON em.channel_id=c.id AND em.position=1 JOIN filter_facts am ON {} JOIN ppv_groups ppg ON {} JOIN source cs ON cs.id=c.source_id JOIN guide_source s ON s.id=m.guide_source_id JOIN guide_channel h ON h.guide_source_id=m.guide_source_id AND h.id=m.xmltv_channel_id WHERE s.published_revision IS NOT NULL AND s.published_revision<=s.revision AND (?3=0 OR (m.catalog_source_id,m.app_channel_id)>(?4,?5)) AND EXISTS(SELECT 1 FROM guide_program p INDEXED BY guide_program_channel_time WHERE p.guide_source_id=m.guide_source_id AND p.channel_id=m.xmltv_channel_id AND {ppv_scope}{semantic_clause} AND p.start_ms<?2 AND ((p.stop_ms IS NOT NULL AND p.stop_ms>?1) OR (p.stop_ms IS NULL AND p.start_ms>=?1))){} ORDER BY m.catalog_source_id,m.app_channel_id LIMIT {}",crate::catalog::ppv::groups_cte().trim_end(),crate::catalog_endpoint_projection::SAME_GROUP,crate::catalog::ppv::same_group("ppg", "em"),if sports.is_some() { String::new() } else { search_clause(tokens.len(), channel_ppv, q.ppv) },if cached.is_some() { cache::MAX_RETAINED_ROWS + 1 } else { PAGE + 1 });
            let statement = if q.history_ids.is_some() {
                let marked = crate::catalog::ppv::indexed_channel_group("c");
                let history_search = if sports.is_some() {
                    String::new()
                } else {
                    search_clause(tokens.len(), "1", true)
                };
                let adult = if q.hide_adult.unwrap_or(true) {
                    format!(" AND NOT genx_watch_adult(c.category) AND NOT genx_watch_adult({category})")
                } else {
                    String::new()
                };
                let badge=format!("CASE WHEN {marked} OR NOT EXISTS(SELECT 1 FROM guide_program p INDEXED BY guide_program_channel_time WHERE p.guide_source_id=m.guide_source_id AND p.channel_id=m.xmltv_channel_id AND p.start_ms<?2 AND ((p.stop_ms IS NOT NULL AND p.stop_ms>?1) OR(p.stop_ms IS NULL AND p.start_ms>=?1)) AND NOT genx_ppv_program(p.title,p.categories_json){semantic_clause}) THEN 8 ELSE 0 END");
                format!("SELECT m.catalog_source_id,m.app_channel_id,m.guide_source_id,m.xmltv_channel_id,s.revision,EXISTS(SELECT 1 FROM favorite f WHERE f.id=c.id)+2*(instr(cp.category_key,'news')>0)+4*(instr(cp.category_key,'sports')>0 OR genx_sports_evidence(c.name,c.category,{category}))+({badge}) FROM guide_mapping m JOIN channel c ON c.source_id=m.catalog_source_id AND c.id=m.app_channel_id JOIN catalog_projection cp ON cp.channel_id=c.id JOIN catalog_endpoint_projection_v1 ep ON ep.channel_id=c.id JOIN source cs ON cs.id=c.source_id JOIN guide_source s ON s.id=m.guide_source_id JOIN guide_channel h ON h.guide_source_id=m.guide_source_id AND h.id=m.xmltv_channel_id WHERE c.id IN(SELECT value FROM json_each(genx_watch_ids())) AND NOT EXISTS(SELECT 1 FROM removed r WHERE r.id=c.id) {adult}{geography_clause} AND s.published_revision IS NOT NULL AND s.published_revision<=s.revision AND (?3=0 OR (m.catalog_source_id,m.app_channel_id)>(?4,?5)) AND EXISTS(SELECT 1 FROM guide_program p INDEXED BY guide_program_channel_time WHERE p.guide_source_id=m.guide_source_id AND p.channel_id=m.xmltv_channel_id{semantic_clause} AND p.start_ms<?2 AND ((p.stop_ms IS NOT NULL AND p.stop_ms>?1) OR (p.stop_ms IS NULL AND p.start_ms>=?1))){history_search} ORDER BY m.catalog_source_id,m.app_channel_id LIMIT {}",if cached.is_some(){cache::MAX_RETAINED_ROWS+1}else{PAGE+1})
            } else {
                statement
            };
            let mut values: Vec<rusqlite::types::Value> = vec![
                sports
                    .as_ref()
                    .map_or(q.start_ms, |p| p.scope.window_start_ms)
                    .into(),
                sports
                    .as_ref()
                    .map_or(q.end_ms, |p| p.scope.window_end_ms)
                    .into(),
                (cached.is_none() && after.is_some()).into(),
                after
                    .as_ref()
                    .map_or("", |v| v.catalog_source_id.as_str())
                    .to_owned()
                    .into(),
                after
                    .as_ref()
                    .map_or("", |v| v.app_channel_id.as_str())
                    .to_owned()
                    .into(),
            ];
            values.extend(sql_tokens.iter().map(|t| t.clone().into()));
            values.extend(geography_values);
            let mut stmt = sql(tx.prepare(&statement))?;
            let mut rows = sql(stmt.query(rusqlite::params_from_iter(values)))?;
            let mut channels = Vec::new();
            let mut retained = 1024usize;
            while let Some(row) = sql(rows.next())? {
                check()?;
                let item = Channel {
                    catalog_source_id: sql(row.get(0))?,
                    app_channel_id: sql(row.get(1))?,
                    guide_source_id: sql(row.get(2))?,
                    xmltv_channel_id: sql(row.get(3))?,
                    source_revision: sql(row.get(4))?,
                    filter_mask: sql(row.get(5))?,
                };
                for (s, limit) in [
                    (&item.catalog_source_id, 16_384),
                    (&item.app_channel_id, 16_384),
                    (&item.guide_source_id, 256),
                    (&item.xmltv_channel_id, 16_384),
                ] {
                    valid_text(s, limit, true)?;
                }
                if item.source_revision < 1 || item.filter_mask > 15 {
                    return Err("guide-invalid-stored-revision".into());
                }
                if let Some((cache, _, _)) = cached {
                    retained = retained
                        .checked_add(cache::retained_bytes(&item))
                        .ok_or("guide-listed-cache-budget")?;
                    // Reserve exact chunks so retained Vec capacity is bounded too.
                    if channels.len() >= cache::MAX_RETAINED_ROWS || retained > cache.byte_limit() {
                        return Err("guide-listed-cache-budget".into());
                    }
                    if channels.len() == channels.capacity() {
                        let extra = 128.min(cache::MAX_RETAINED_ROWS - channels.len());
                        if retained.saturating_add(extra * std::mem::size_of::<Channel>())
                            > cache.byte_limit()
                        {
                            return Err("guide-listed-cache-budget".into());
                        }
                        channels.reserve_exact(extra);
                    }
                    let unused = channels.capacity().saturating_sub(channels.len() + 1);
                    if retained.saturating_add(unused * std::mem::size_of::<Channel>())
                        > cache.byte_limit()
                    {
                        return Err("guide-listed-cache-budget".into());
                    }
                }
                channels.push(item);
            }
            drop(rows);
            drop(stmt);
            if cached.is_some() {
                let inventory = Arc::new(channels);
                let page = inventory_page(&inventory, after.as_ref())?;
                inventory_to_publish = Some(inventory);
                page
            } else {
                channels
            }
        };
        let mut more = channels.len() > PAGE;
        channels.truncate(PAGE);
        let seen = after.as_ref().map_or(0, |v| v.seen);
        let mut page = Page {
            start_ms: q.start_ms,
            end_ms: q.end_ms,
            root_generation: generation,
            catalog_revision,
            database_revision: database,
            view_revision: view.to_string(),
            grouping_policy: crate::catalog_endpoint_projection::POLICY.into(),
            channels,
            next_cursor: None,
        };
        loop {
            if seen + page.channels.len() > MAX_TOTAL
                || (seen + page.channels.len() == MAX_TOTAL && more)
            {
                return Err("guide-listed-capacity".into());
            }
            page.next_cursor = if more {
                page.channels
                    .last()
                    .map(|v| {
                        serde_json::to_string(&Cursor {
                            version: 3,
                            start_ms: q.start_ms,
                            end_ms: q.end_ms,
                            root_generation: generation,
                            catalog_revision: page.catalog_revision.clone(),
                            mutation_revision: mutation,
                            database_revision: database,
                            view_revision: view,
                            grouping_policy: crate::catalog_endpoint_projection::POLICY.into(),
                            catalog_source_id: v.catalog_source_id.clone(),
                            app_channel_id: v.app_channel_id.clone(),
                            seen: seen + page.channels.len(),
                            search: tokens.join(" "),
                            geography: q.geography.clone(),
                            ppv: q.ppv,
                            sports: q.sports.clone(),
                            literal_search: literal_search(q),
                            history_key: captured_history_key.clone(),
                        })
                    })
                    .transpose()
                    .map_err(|_| "guide-listed-invalid-cursor")?
            } else {
                None
            };
            if serde_json::to_vec(&page)
                .map_err(|_| "guide-listed-capacity")?
                .len()
                <= MAX_BYTES
            {
                break;
            }
            page.channels.pop();
            more = true;
            if page.channels.is_empty() {
                return Err("guide-listed-capacity".into());
            }
        }
        check()?;
        sql(tx.commit())?;
        check()?;
        if let (Some((cache, _, unchanged)), Some(key), Some(inventory)) =
            (cached, cache_key, inventory_to_publish)
        {
            unchanged()?;
            check()?;
            cache.put(key, inventory)?;
        }
        Ok(page)
    })();
    check()?;
    result
}

fn inventory_page(inventory: &[Channel], after: Option<&Cursor>) -> Result<Vec<Channel>, String> {
    let start = after.map_or(0, |cursor| {
        inventory.partition_point(|row| {
            (&row.catalog_source_id, &row.app_channel_id)
                <= (&cursor.catalog_source_id, &cursor.app_channel_id)
        })
    });
    if after.is_some_and(|cursor| cursor.seen != start) {
        return Err("guide-listed-invalid-cursor".into());
    }
    Ok(inventory
        .iter()
        .skip(start)
        .take(PAGE + 1)
        .cloned()
        .collect())
}

/// Every word in the channel's own search text, or in one listed program within the window.
fn search_clause(tokens: usize, channel_ppv: &str, ppv: bool) -> String {
    if tokens == 0 {
        return String::new();
    }
    // Each word must start a word in the text ("nfl" finds "NFL Live", not
    // "conflict"). The plain instr() check first keeps most rows cheap.
    let all = |column: &str| {
        let words = WORD_BREAKS.iter().fold(column.to_owned(), |text, c| {
            format!("replace({text},'{c}',' ')")
        });
        (6..6 + tokens)
            .map(|i| format!("(instr({column},?{i})>0 AND instr(' '||{words},' '||?{i})>0)"))
            .collect::<Vec<_>>()
            .join(" AND ")
    };
    let marker = format!("({channel_ppv} OR genx_ppv_program(sq.title,sq.categories_json))");
    let scope = if ppv { marker } else { format!("NOT {marker}") };
    format!(
        " AND ((SELECT {} FROM catalog_projection sp WHERE sp.channel_id=c.id) OR EXISTS(SELECT 1 FROM guide_program sq INDEXED BY guide_program_channel_time WHERE sq.guide_source_id=m.guide_source_id AND sq.channel_id=m.xmltv_channel_id AND sq.start_ms<?2 AND ((sq.stop_ms IS NOT NULL AND sq.stop_ms>?1) OR (sq.stop_ms IS NULL AND sq.start_ms>=?1)) AND {scope} AND {}))",
        all("sp.search_text"),
        all("sq.search_text")
    )
}

#[cfg(test)]
#[path = "listed_channels_tests.rs"]
mod tests;
