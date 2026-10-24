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

//! Reading a page of a Paid TV account's channels, and its countries.

use super::*;

pub(crate) fn read_page(
    c: &Connection,
    request: &Query,
    owner: Arc<Context>,
) -> Result<Page, String> {
    validate(request)?;
    owner.check()?;
    let progress_owner = owner.clone();
    sql(c.progress_handler(1000, Some(move || progress_owner.check().is_err())))?;
    let mut progress = Progress { c, active: true };
    let result = (|| {
        register_functions(c)?;
        let tx = sql(c.unchecked_transaction())?;
        let captured = snapshot(&tx, request)?;
        let scoped = scope(&tx)?;
        let live = &scoped.live;
        let predicate = &format!(
            "{}{}",
            scoped.predicate,
            visibility(scoped.category, request.hide_adult)
        );
        let effective_category = scoped.category;
        let favorite = scoped.favorite;
        owner.check()?;
        let filter = match request.filter {
            Filter::All => "all",
            Filter::News => "news",
            Filter::Sports => "sports",
            Filter::Favorites => "favorites",
            Filter::Movies => "movies",
        };
        let order = match request.sort {
            // There is no persisted acquisition ordinal: Source is deterministic ID order.
            Sort::Source => "e.channel_id".to_owned(),
            Sort::Name => "e.name COLLATE NOCASE,e.channel_id".to_owned(),
            Sort::Category => {
                format!("{effective_category} COLLATE NOCASE,e.name COLLATE NOCASE,e.channel_id")
            }
            Sort::Country => country_order(effective_category),
        };
        let order = if request.favorites_first {
            format!("{favorite} DESC,{order}")
        } else {
            order
        };
        // The stamp is read while this transaction holds its shared lock (the
        // snapshot above read the database), so no write lands in between.
        let cache_key = database_stamp(&tx).map(|stamp| {
            serde_json::json!([
                stamp,
                request.account_id,
                captured.account_revision,
                captured.media_revision,
                captured.preferences_revision,
                request.query,
                request.category,
                filter,
                request.country,
                order,
                request.hide_adult,
            ])
            .to_string()
        });
        // None: not cached. Some(None): this query was seen once. Some(Some): listed.
        let seen: Option<Option<Listed>> = match &cache_key {
            None => None,
            Some(key) => {
                let mut held = LISTED.lock().map_err(|_| "account-media-cache-lock")?;
                match held.as_ref().filter(|(k, _)| k == key) {
                    Some((_, listed)) => Some(listed.clone()),
                    None => {
                        *held = Some((key.clone(), None));
                        None
                    }
                }
            }
        };
        let listed = match (seen, &cache_key) {
            (Some(Some(listed)), _) => Some(listed),
            (None, _) | (_, None) => None,
            (Some(None), Some(key)) => {
                let admitted: i64 = sql(tx.query_row(
                    &format!("SELECT COUNT(*){LIVE} WHERE e.account_id=?1"),
                    [&request.account_id],
                    |r| r.get(0),
                ))?;
                if !(0..=MAX).contains(&admitted) {
                    return Err("account-media-too-large".into());
                }
                let mut statement = sql(tx.prepare(&format!(
                    "SELECT e.channel_id{live}{predicate} ORDER BY {order}"
                )))?;
                let ids = sql(statement
                    .query_map(
                        rusqlite::params_from_iter(bound(
                            &[
                                &request.account_id,
                                &request.query,
                                &request.category,
                                &filter,
                            ],
                            &request.country,
                        )),
                        |r| r.get::<_, String>(0),
                    )
                    .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>()))?;
                drop(statement);
                let listed = (admitted, ids.len() as i64, Arc::new(ids));
                *LISTED.lock().map_err(|_| "account-media-cache-lock")? =
                    Some((key.clone(), Some(listed.clone())));
                Some(listed)
            }
        };
        let admitted_count: i64 = if let Some((admitted, _, _)) = &listed {
            *admitted
        } else {
            sql(tx.query_row(
                &format!("SELECT COUNT(*){LIVE} WHERE e.account_id=?1"),
                [&request.account_id],
                |r| r.get(0),
            ))?
        };
        if !(0..=MAX).contains(&admitted_count) {
            return Err("account-media-too-large".into());
        }
        let total: i64 = if let Some((_, total, _)) = &listed {
            *total
        } else {
            sql(tx.query_row(
                &format!("SELECT COUNT(*){live}{predicate}"),
                rusqlite::params_from_iter(bound(
                    &[
                        &request.account_id,
                        &request.query,
                        &request.category,
                        &filter,
                    ],
                    &request.country,
                )),
                |r| r.get(0),
            ))?
        };
        if total < 0 || total > admitted_count {
            return Err("account-media-invalid".into());
        }
        let mut start_index = request.start_index;
        let mut anchor_index = None;
        if let (Some(anchor), Some((_, _, ids))) = (&request.anchor_id, &listed) {
            // The cached order is exactly the requested order, so a listed
            // anchor's position is its rank.
            if let Some(rank) = ids.iter().position(|id| id == anchor) {
                anchor_index = Some(rank);
                start_index = rank.saturating_sub(1);
            }
        } else if let Some(anchor) = &request.anchor_id {
            owner.check()?;
            // The anchor must be live and match the same query/category/filter.
            // Metadata sort keys remain internal and never contain stream URLs.
            let key = sql(tx
                .query_row(
                    &format!("SELECT e.name,{effective_category},e.channel_id,{favorite}{live}{predicate} AND e.channel_id=?5"),
                    rusqlite::params_from_iter(bound(
                        &[&request.account_id, &request.query, &request.category, &filter, anchor],
                        &request.country,
                    )),
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, bool>(3)?,
                        ))
                    },
                )
                .optional())?;
            if key.is_some() && matches!(request.sort, Sort::Country) {
                // The country key is computed, so rank the anchor by its row
                // position under exactly the requested order.
                let rank: i64 = sql(tx.query_row(
                    &format!("SELECT pos FROM (SELECT e.channel_id AS id,ROW_NUMBER() OVER (ORDER BY {order})-1 AS pos{live}{predicate}) WHERE id=?5"),
                    rusqlite::params_from_iter(bound(
                        &[&request.account_id, &request.query, &request.category, &filter, anchor],
                        &request.country,
                    )),
                    |r| r.get(0),
                ))?;
                if rank < 0 || rank >= total {
                    return Err("account-media-invalid".into());
                }
                anchor_index = Some(rank as usize);
                start_index = (rank as usize).saturating_sub(1);
            } else if let Some((name, category, id, anchor_favorite)) = key {
                // Every comparison uses exactly the same NOCASE/BINARY ordering
                // and unique ID tie-break as the requested metadata page.
                let predecessor = match request.sort {
                    Sort::Source => "e.channel_id<?7".to_owned(),
                    Sort::Name => "(e.name COLLATE NOCASE<?5 COLLATE NOCASE OR (e.name COLLATE NOCASE=?5 COLLATE NOCASE AND e.channel_id<?7))".to_owned(),
                    Sort::Category => format!("({effective_category} COLLATE NOCASE<?6 COLLATE NOCASE OR ({effective_category} COLLATE NOCASE=?6 COLLATE NOCASE AND (e.name COLLATE NOCASE<?5 COLLATE NOCASE OR (e.name COLLATE NOCASE=?5 COLLATE NOCASE AND e.channel_id<?7))))"),
                    Sort::Country => unreachable!("country anchors are ranked above"),
                };
                let predecessor = format!("((?8=0 AND {predecessor}) OR (?8=1 AND ({favorite}>?9 OR ({favorite}=?9 AND {predecessor}))))");
                let rank: i64 = sql(tx.query_row(
                    &format!("SELECT COUNT(*){live}{predicate} AND {predecessor}"),
                    rusqlite::params_from_iter(bound(
                        &[
                            &request.account_id,
                            &request.query,
                            &request.category,
                            &filter,
                            &name,
                            &category,
                            &id,
                            &request.favorites_first,
                            &anchor_favorite,
                        ],
                        &request.country,
                    )),
                    |r| r.get(0),
                ))?;
                if rank < 0 || rank >= total {
                    return Err("account-media-invalid".into());
                }
                anchor_index = Some(rank as usize);
                // Match public CatalogWindow adjacency: one predecessor, then
                // the anchor and successors. Wrap-around uses a later offset read.
                start_index = (rank as usize).saturating_sub(1);
            }
        }
        let map_channel = |r: &rusqlite::Row<'_>| {
            Ok(Channel {
                id: r.get(0)?,
                name: r.get(1)?,
                category: r.get(2)?,
                provider_id: r.get(3)?,
                epg_id: r.get(4)?,
                stream_reference: r.get(5)?,
                favorite: r.get(6)?,
                original_category: r.get(7)?,
            })
        };
        let columns = format!(
            "SELECT e.channel_id,e.name,{effective_category},e.provider_id,e.epg_id,e.stream_ref,{favorite},e.category{live}{predicate}"
        );
        let rows: Vec<rusqlite::Result<Channel>> = if let Some((_, _, ids)) = &listed {
            // Read only the requested slice of the cached order, each row
            // still through the same live scope and predicate.
            let mut statement = sql(tx.prepare(&format!("{columns} AND e.channel_id=?5")))?;
            let mut rows = Vec::new();
            for id in ids.iter().skip(start_index).take(request.page_size) {
                owner.check()?;
                let channel = sql(statement
                    .query_row(
                        rusqlite::params_from_iter(bound(
                            &[
                                &request.account_id,
                                &request.query,
                                &request.category,
                                &filter,
                                id,
                            ],
                            &request.country,
                        )),
                        map_channel,
                    )
                    .optional())?
                .ok_or("account-media-invalid")?;
                rows.push(Ok(channel));
            }
            rows
        } else {
            let mut statement =
                sql(tx.prepare(&format!("{columns} ORDER BY {order} LIMIT ?5 OFFSET ?6")))?;
            let rows = sql(statement.query_map(
                rusqlite::params_from_iter(bound(
                    &[
                        &request.account_id,
                        &request.query,
                        &request.category,
                        &filter,
                        &(request.page_size as i64),
                        &(start_index as i64),
                    ],
                    &request.country,
                )),
                map_channel,
            ))?;
            rows.collect()
        };
        let mut items = Vec::with_capacity(request.page_size);
        let mut bytes = 512usize;
        let mut identities = std::collections::HashSet::new();
        let mut references = std::collections::HashSet::new();
        for row in rows {
            owner.check()?;
            let item = sql(row)?;
            if !channel_valid(&item, &request.account_id)
                || !identities.insert(item.id.clone())
                || !references.insert(item.stream_reference.clone())
            {
                return Err("account-media-invalid".into());
            }
            let size = serde_json::to_vec(&item)
                .map_err(|_| "account-media-invalid")?
                .len()
                + 1;
            if bytes + size > LIMIT {
                if items.is_empty() {
                    return Err("account-catalog-page-too-large".into());
                }
                break;
            }
            bytes += size;
            items.push(item);
        }
        if start_index < total as usize && items.is_empty() {
            return Err("account-media-invalid".into());
        }
        let page = Page {
            schema_version: 1,
            account_id: request.account_id.clone(),
            account_revision: captured.account_revision.to_string(),
            media_revision: captured.media_revision.to_string(),
            preferences_revision: captured.preferences_revision.to_string(),
            query_version: QUERY_VERSION,
            start_index,
            anchor_index,
            total: total as usize,
            items,
        };
        if serde_json::to_vec(&page)
            .map_err(|_| "account-media-invalid")?
            .len()
            > LIMIT
        {
            return Err("account-catalog-page-too-large".into());
        }
        owner.check()?;
        sql(tx.commit())?;
        Ok(page)
    })();
    let cleanup = progress.clear();
    // Preserve the cancellation reason over SQLite's generic interrupted code.
    owner.check()?;
    cleanup?;
    result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CountryRequest {
    pub schema_version: u8,
    pub account_id: String,
    pub expected_account_revision: String,
    #[serde(default)]
    pub hide_adult: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CountryCount {
    /// An app country code; None for channels whose country is unknown.
    pub code: Option<String>,
    pub count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Countries {
    pub schema_version: u8,
    pub account_id: String,
    pub account_revision: String,
    pub total: usize,
    pub countries: Vec<CountryCount>,
}

/// Channel counts per resolved country, under the same visibility rules as the
/// channel list (removed channels and, when chosen, adult groups excluded).
pub(crate) fn read_countries(
    c: &Connection,
    request: &CountryRequest,
) -> Result<Countries, String> {
    let query = Query {
        schema_version: request.schema_version,
        account_id: request.account_id.clone(),
        expected_account_revision: request.expected_account_revision.clone(),
        expected_media_revision: None,
        expected_preferences_revision: None,
        query: String::new(),
        category: None,
        filter: Filter::All,
        sort: Sort::Source,
        favorites_first: false,
        country: None,
        hide_adult: request.hide_adult,
        start_index: 0,
        anchor_id: None,
        page_size: 1,
    };
    validate(&query)?;
    register_functions(c)?;
    let tx = sql(c.unchecked_transaction())?;
    let captured = snapshot(&tx, &query)?;
    let scoped = scope(&tx)?;
    let category = scoped.category;
    let adult = if request.hide_adult {
        format!(" AND NOT {}", adult_predicate(category))
    } else {
        String::new()
    };
    let mut statement = sql(tx.prepare(&format!(
        "SELECT genx_group_country({category}) AS code,COUNT(*){} {adult} GROUP BY code ORDER BY code IS NULL,code",
        scoped.live
    )))?;
    let rows = sql(statement.query_map([&request.account_id], |r| {
        Ok(CountryCount {
            code: r.get(0)?,
            count: r.get::<_, i64>(1)? as usize,
        })
    }))?;
    let mut countries = Vec::new();
    for row in rows {
        countries.push(sql(row)?);
    }
    drop(statement);
    Ok(Countries {
        schema_version: 1,
        account_id: request.account_id.clone(),
        account_revision: captured.account_revision.to_string(),
        total: countries.iter().map(|c| c.count).sum(),
        countries,
    })
}

pub(crate) async fn countries(
    request: CountryRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Countries, String> {
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (result, _) = owner
            .storage(None, move |store, check| {
                check()?;
                store.with_guide_read(|c| read_countries(c, &request))
            })
            .await?;
        owner.check()?;
        Ok(result)
    })
    .await
}

pub(crate) async fn query(
    request: Query,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Page, String> {
    validate(&request)?;
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let query_owner = owner.clone();
        let (page, _) = owner
            .storage(None, move |store, check| {
                check()?;
                store.with_guide_read(|c| read_page(c, &request, query_owner))
            })
            .await?;
        owner.check()?;
        Ok(page)
    })
    .await
}
