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

//! Replacing a guide and matching it to channels in one step, and the saved
//! channel mappings.

use super::*;

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
    aliases: Option<&super::super::reviewed_aliases::ReviewedAliases>,
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
pub(super) fn replace_and_match_inner(
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
    request: &super::super::retention::Request,
    expected_catalog: Option<&str>,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
) -> Result<CommitIfMatched, String> {
    super::super::retention::publication_window(request, updated_ms)?;
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

// Test entry with match_inner_with_request's inputs spelled out.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(super) fn match_inner(
    c: &mut Connection,
    id: &str,
    expected_revision: i64,
    expected_catalog: Option<i64>,
    aliases: Option<&super::super::reviewed_aliases::ReviewedAliases>,
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
pub(super) fn match_inner_with_request(
    c: &mut Connection,
    id: &str,
    expected_revision: i64,
    expected_catalog: Option<i64>,
    aliases: Option<&super::super::reviewed_aliases::ReviewedAliases>,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
    checkpoint: impl FnOnce() -> Result<(), String>,
    request: Option<&super::super::retention::Request>,
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
        if let Some(r) = request.filter(|r| super::super::retention::is_proposed(&r.scope)) {
            super::super::retention::verify(&tx, &r.scope)?;
        } else if source_revision(&tx, id)? != expected_revision {
            return Err("guide-stale-revision".into());
        }
    }
    let projection = request
        .map(|r| super::super::retention::project(&tx, r, feed, flag))
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
            if let Some(r) = request.filter(|r| super::super::retention::is_proposed(&r.scope)) {
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
                |(channel, source, provider, _)| super::super::reviewed_aliases::CatalogTarget {
                    source_id: source,
                    channel_id: channel,
                    provider_id: provider.as_deref(),
                    removed: false,
                },
            )
            .collect();
        super::super::reviewed_aliases::admit(descriptor, &location, &targets, &guide_ids, flag)
            .map_err(str::to_string)?
    } else {
        std::collections::BTreeMap::new()
    };
    let pack_location: Option<String> =
        if let Some(r) = request.filter(|r| super::super::retention::is_proposed(&r.scope)) {
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
                let present: Vec<String> = super::super::crosswalk_pack::alternates(
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
        super::super::retention::install_proposed(&tx, &r.scope)?;
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
        super::super::retention::record(&tx, r, p, expected_revision + 1)?;
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
