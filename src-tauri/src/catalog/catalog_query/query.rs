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

//! Reading a page of the channel catalog: filters, search, sorting and
//! cursors.

use super::*;

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

pub(super) fn query_page_inner(
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
