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

//! Atomic exact-identity attachment to explicitly admitted published caches. No acquisition.
use super::{
    crosswalk_pack,
    database::sql,
    reviewed_aliases::{self, ReviewedAliases},
    reviewed_crosswalk::{self, Outcome, VerifiedCrosswalk},
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::AtomicBool;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CachedSource {
    pub id: String,
    pub location: String,
    pub expected_source_revision: i64,
    pub expected_published_revision: i64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedConnection {
    pub catalog_revision: String,
    pub matched: usize,
    pub unmatched: usize,
    pub ambiguous: usize,
    pub preserved_mappings: usize,
    pub checked_sources: usize,
    /// Current nonremoved mapped channels only; never classifies mapping origin.
    pub mapping_conflict_assessment: &'static str,
    pub preserved_mapping_conflicts: Option<usize>,
    /// Optional runtime identity metadata; failure never disables exact/legacy matches.
    pub reviewed_crosswalk: Outcome,
}
fn text(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}
fn check(canceled: &dyn Fn() -> bool) -> Result<(), String> {
    if canceled() {
        Err("guide-cancelled".into())
    } else {
        Ok(())
    }
}
pub fn connect(
    connection: &mut Connection,
    expected_catalog_revision: &str,
    sources: &[CachedSource],
    aliases: &[ReviewedAliases],
    canceled: &dyn Fn() -> bool,
) -> Result<CachedConnection, String> {
    connect_inner(
        connection,
        expected_catalog_revision,
        sources,
        aliases,
        canceled,
        &mut || Ok(()),
    )
}
fn connect_inner(
    connection: &mut Connection,
    expected_catalog_revision: &str,
    sources: &[CachedSource],
    aliases: &[ReviewedAliases],
    canceled: &dyn Fn() -> bool,
    checkpoint: &mut dyn FnMut() -> Result<(), String>,
) -> Result<CachedConnection, String> {
    connect_inner_with_crosswalk(
        connection,
        ConnectionRequest {
            expected_catalog_revision,
            sources,
            aliases,
            authority: None,
            outcome: Outcome::not_requested(),
            automatic: false,
        },
        canceled,
        checkpoint,
    )
}
pub(crate) fn connect_with_crosswalk(
    connection: &mut Connection,
    expected_catalog_revision: &str,
    sources: &[CachedSource],
    aliases: &[ReviewedAliases],
    authority: Option<&VerifiedCrosswalk>,
    outcome: Outcome,
    canceled: &dyn Fn() -> bool,
) -> Result<CachedConnection, String> {
    connect_inner_with_crosswalk(
        connection,
        ConnectionRequest {
            expected_catalog_revision,
            sources,
            aliases,
            authority,
            outcome,
            automatic: false,
        },
        canceled,
        &mut || Ok(()),
    )
}
pub(crate) fn connect_automatic_cached(
    connection: &mut Connection,
    expected_catalog_revision: &str,
    sources: &[CachedSource],
    aliases: &[ReviewedAliases],
    authority: Option<&VerifiedCrosswalk>,
    outcome: Outcome,
    canceled: &dyn Fn() -> bool,
) -> Result<CachedConnection, String> {
    connect_inner_with_crosswalk(
        connection,
        ConnectionRequest {
            expected_catalog_revision,
            sources,
            aliases,
            authority,
            outcome,
            automatic: true,
        },
        canceled,
        &mut || Ok(()),
    )
}
fn validate_inputs(
    expected_catalog_revision: &str,
    sources: &[CachedSource],
) -> Result<i64, String> {
    if expected_catalog_revision.is_empty()
        || expected_catalog_revision.len() > 19
        || !expected_catalog_revision
            .bytes()
            .all(|b| b.is_ascii_digit())
        || (expected_catalog_revision.len() > 1 && expected_catalog_revision.starts_with('0'))
    {
        return Err("catalog-revision-invalid".into());
    }
    let expected: i64 = expected_catalog_revision
        .parse()
        .map_err(|_| "catalog-revision-invalid")?;
    if sources.len() > 1000 {
        return Err("guide-cache-match-limit".into());
    }
    let mut source_ids = HashSet::new();
    let mut locations = HashSet::new();
    for source in sources {
        if !text(&source.id, 256)
            || !text(&source.location, 16384)
            || source.expected_source_revision < 1
            || source.expected_published_revision < 1
            || !source_ids.insert(source.id.as_str())
            || !locations.insert(source.location.as_str())
        {
            return Err("guide-cache-match-scope-invalid".into());
        }
    }
    Ok(expected)
}
fn validate_scope(
    c: &Connection,
    expected: i64,
    sources: &[CachedSource],
    canceled: &dyn Fn() -> bool,
) -> Result<i64, String> {
    check(canceled)?;
    let actual: i64 = sql(c.query_row(
        "SELECT catalog_revision FROM metadata WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    if actual != expected {
        return Err("catalog-revision-stale".into());
    }
    for source in sources {
        check(canceled)?;
        let saved: Option<(String, String, i64, Option<i64>, bool)> = sql(c.query_row(
            "SELECT location,kind,revision,published_revision,EXISTS(SELECT 1 FROM guide_channel WHERE guide_source_id=guide_source.id) FROM guide_source WHERE id=?1", [&source.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).optional())?;
        let Some((location, kind, revision, published, complete)) = saved else {
            return Err("guide-cache-unavailable".into());
        };
        if location != source.location || kind != "url" {
            return Err("guide-cache-match-scope-invalid".into());
        }
        if revision != source.expected_source_revision
            || published != Some(source.expected_published_revision)
            || published != Some(revision)
        {
            return Err("guide-stale-revision".into());
        }
        if !complete {
            return Err("guide-cache-unavailable".into());
        }
    }
    Ok(actual)
}
/// Read-only prepare proof before optional runtime metadata acquisition. Final
/// publication repeats this proof in its own IMMEDIATE transaction after await.
pub(crate) fn prepare_scope(
    c: &Connection,
    expected_catalog_revision: &str,
    sources: &[CachedSource],
    canceled: &dyn Fn() -> bool,
) -> Result<bool, String> {
    let expected = validate_inputs(expected_catalog_revision, sources)?;
    let tx = sql(c.unchecked_transaction())?;
    validate_scope(&tx, expected, sources, canceled)?;
    let eligible = sources
        .iter()
        .any(|source| source.location == reviewed_crosswalk::FEED);
    check(canceled)?;
    sql(tx.commit())?;
    Ok(eligible)
}
/// Empty selected caches cannot create a mapping. Return the same truthful
/// counts as matching, from one read snapshot, without entering the writer or
/// creating a recovery backup. This is a read receipt, not a durable mutation.
pub(crate) fn connect_empty_cached(
    connection: &Connection,
    expected_catalog_revision: &str,
    aliases: &[ReviewedAliases],
    automatic: bool,
    canceled: &dyn Fn() -> bool,
) -> Result<CachedConnection, String> {
    let expected = validate_inputs(expected_catalog_revision, &[])?;
    if aliases.len() > 100 || aliases.iter().map(|a| a.pairs.len()).sum::<usize>() > 1024 {
        return Err("guide-cache-match-limit".into());
    }
    check(canceled)?;
    let tx = sql(connection.unchecked_transaction())?;
    if automatic {
        super::refresh::require_automatic_updates(&tx)?;
    }
    let actual = validate_scope(&tx, expected, &[], canceled)?;
    // Existing matching refuses every alias without its explicitly selected
    // source. Do not silently ignore even an otherwise valid descriptor.
    if !aliases.is_empty() {
        return Err("guide-alias-source-refused".into());
    }
    let mut statement = sql(tx.prepare("SELECT EXISTS(SELECT 1 FROM guide_mapping m WHERE m.catalog_source_id=c.source_id AND m.app_channel_id=c.id) FROM channel c WHERE NOT EXISTS(SELECT 1 FROM removed r WHERE r.id=c.id) ORDER BY c.id LIMIT 100001"))?;
    let mut rows = sql(statement.query([]))?;
    let mut eligible = 0usize;
    let mut unmatched = 0usize;
    while let Some(row) = sql(rows.next())? {
        check(canceled)?;
        eligible += 1;
        if eligible > 100000 {
            return Err("guide-catalog-channel-limit".into());
        }
        if !sql(row.get::<_, bool>(0))? {
            unmatched += 1;
        }
    }
    drop(rows);
    drop(statement);
    // Preserve ALL saved mapping choices, including missing/removed identities,
    // exactly as the mutating connector's receipt does.
    let preserved: i64 = sql(tx.query_row(
        "SELECT count(*) FROM (SELECT 1 FROM guide_mapping LIMIT 100001)",
        [],
        |r| r.get(0),
    ))?;
    let preserved = usize::try_from(preserved).map_err(|_| "guide-cache-match-limit")?;
    if preserved > 100000 {
        return Err("guide-cache-match-limit".into());
    }
    let result = CachedConnection {
        catalog_revision: actual.to_string(),
        matched: 0,
        unmatched,
        ambiguous: 0,
        preserved_mappings: preserved,
        checked_sources: 0,
        mapping_conflict_assessment: "complete",
        preserved_mapping_conflicts: Some(0),
        reviewed_crosswalk: reviewed_crosswalk::Acquisition::not_requested().outcome,
    };
    check(canceled)?;
    // Deferred transaction has issued SELECTs only, including policy/removals.
    sql(tx.commit())?;
    Ok(result)
}
fn connect_inner_with_crosswalk(
    connection: &mut Connection,
    request: ConnectionRequest<'_>,
    canceled: &dyn Fn() -> bool,
    checkpoint: &mut dyn FnMut() -> Result<(), String>,
) -> Result<CachedConnection, String> {
    let ConnectionRequest {
        expected_catalog_revision,
        sources,
        aliases,
        authority,
        outcome,
        automatic,
    } = request;
    check(canceled)?;
    let tx = sql(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let plan = plan_connection(
        &tx,
        ConnectionRequest {
            expected_catalog_revision,
            sources,
            aliases,
            authority,
            outcome,
            automatic,
        },
        canceled,
    )?;
    for mapping in &plan.pending {
        check(canceled)?;
        sql(tx.execute(
            "INSERT INTO guide_mapping VALUES(?1,?2,?3,?4)",
            params![
                mapping.catalog_source_id,
                mapping.app_channel_id,
                mapping.guide_source_id,
                mapping.xmltv_channel_id
            ],
        ))?;
        checkpoint()?;
    }
    if !plan.pending.is_empty() {
        sql(tx.execute(
            "UPDATE guide_meta SET revision=revision+1 WHERE singleton=1",
            [],
        ))?;
        if crate::catalog_endpoint_projection::present(&tx)? {
            crate::catalog_query::advance_view_revision(&tx, true)?;
        }
    }
    check(canceled)?;
    sql(tx.commit())?;
    Ok(plan.result)
}
/// What a cached-guide connection is computed from: the catalog revision it
/// must match, the selected guide sources, reviewed aliases, the verified
/// crosswalk (if any), the outcome being recorded and whether the run is
/// automatic.
pub(crate) struct ConnectionRequest<'a> {
    pub expected_catalog_revision: &'a str,
    pub sources: &'a [CachedSource],
    pub aliases: &'a [ReviewedAliases],
    pub authority: Option<&'a VerifiedCrosswalk>,
    pub outcome: Outcome,
    pub automatic: bool,
}
struct ConnectionPlan {
    result: CachedConnection,
    pending: Vec<super::database::GuideMapping>,
}
/// Same bounded matching calculation as publication, but SELECTs only. Final
/// writes recapture the complete plan in their own IMMEDIATE transaction.
pub(crate) fn preflight_connection(
    connection: &Connection,
    request: ConnectionRequest<'_>,
    canceled: &dyn Fn() -> bool,
) -> Result<Option<CachedConnection>, String> {
    let ConnectionRequest {
        expected_catalog_revision,
        sources,
        aliases,
        authority,
        outcome,
        automatic,
    } = request;
    let tx = sql(connection.unchecked_transaction())?;
    let plan = plan_connection(
        &tx,
        ConnectionRequest {
            expected_catalog_revision,
            sources,
            aliases,
            authority,
            outcome,
            automatic,
        },
        canceled,
    )?;
    check(canceled)?;
    sql(tx.commit())?;
    Ok(if plan.pending.is_empty() {
        Some(plan.result)
    } else {
        None
    })
}
fn now_ms() -> Result<i64, String> {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "guide-clock-unavailable")?
            .as_millis(),
    )
    .map_err(|_| "guide-clock-unavailable".into())
}
/// Minimum lead before one exact source is preferred over another.
const COVERAGE_LEAD_MS: i64 = 60 * 60 * 1000;
/// Continuous schedule from now: programmes in start order while each begins
/// at or before the covered instant. An unknown end or a gap stops the walk.
fn continuous_horizon(
    connection: &Connection,
    guide: &str,
    target: &str,
    now: i64,
    canceled: &dyn Fn() -> bool,
) -> Result<i64, String> {
    let mut statement = sql(connection.prepare(
        "SELECT start_ms,stop_ms FROM guide_program WHERE guide_source_id=?1 AND channel_id=?2 AND (stop_ms IS NULL OR stop_ms>?3) ORDER BY start_ms,ordinal LIMIT 5000",
    ))?;
    let rows = sql(statement.query_map(params![guide, target, now], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?))
    }))?;
    let mut covered = now;
    for row in rows {
        check(canceled)?;
        let (start, stop) = sql(row)?;
        if start > covered {
            break;
        }
        match stop {
            Some(stop) => covered = covered.max(stop),
            None => break,
        }
    }
    Ok(covered - now)
}
/// Several exact identities for one channel, at most one per feed, are the
/// same canonical channel from different publishers. Prefer the feed with
/// clearly more measured continuous coverage; otherwise remain ambiguous.
/// Two targets inside one feed are an identity conflict and are never ranked.
fn best_covered_choice(
    connection: &Connection,
    choices: &HashSet<(String, String)>,
    now: i64,
    canceled: &dyn Fn() -> bool,
) -> Result<Option<(String, String)>, String> {
    let feeds: HashSet<&str> = choices.iter().map(|(guide, _)| guide.as_str()).collect();
    if feeds.len() != choices.len() || choices.len() > 16 {
        return Ok(None);
    }
    let mut ranked = Vec::new();
    for (guide, target) in choices {
        ranked.push((
            continuous_horizon(connection, guide, target, now, canceled)?,
            guide.clone(),
            target.clone(),
        ));
    }
    ranked.sort_by_key(|item| std::cmp::Reverse(item.0));
    let (best, runner) = (ranked[0].0, ranked[1].0);
    Ok((best > 0 && best - runner >= COVERAGE_LEAD_MS)
        .then(|| (ranked[0].1.clone(), ranked[0].2.clone())))
}
fn plan_connection(
    connection: &Connection,
    request: ConnectionRequest<'_>,
    canceled: &dyn Fn() -> bool,
) -> Result<ConnectionPlan, String> {
    let ConnectionRequest {
        expected_catalog_revision,
        sources,
        aliases,
        authority,
        outcome,
        automatic,
    } = request;
    let expected = validate_inputs(expected_catalog_revision, sources)?;
    if aliases.len() > 100 || aliases.iter().map(|a| a.pairs.len()).sum::<usize>() > 1024 {
        return Err("guide-cache-match-limit".into());
    }
    check(canceled)?;
    if automatic {
        super::refresh::require_automatic_updates(connection)?;
    }
    let actual = validate_scope(connection, expected, sources, canceled)?;
    let mut statement = sql(connection.prepare("SELECT c.id,c.source_id,c.provider_id,EXISTS(SELECT 1 FROM guide_mapping m WHERE m.catalog_source_id=c.source_id AND m.app_channel_id=c.id) FROM channel c WHERE NOT EXISTS(SELECT 1 FROM removed r WHERE r.id=c.id) ORDER BY c.id"))?;
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
        check(canceled)?;
        if channels.len() >= 100000 {
            return Err("guide-catalog-channel-limit".into());
        }
        channels.push(sql(row)?);
    }
    drop(statement);
    let mut alias_matches = BTreeMap::new();
    let mut alias_sources = HashSet::new();
    for descriptor in aliases {
        check(canceled)?;
        let source = sources
            .iter()
            .find(|s| s.location == descriptor.guide_location)
            .ok_or("guide-alias-source-refused")?;
        if !alias_sources.insert(source.id.as_str()) {
            return Err("guide-alias-source-refused".into());
        }
        let requested: HashSet<_> = descriptor
            .pairs
            .iter()
            .map(|pair| {
                (
                    pair.catalog_source_id.as_str(),
                    pair.app_channel_id.as_str(),
                )
            })
            .collect();
        let targets: Vec<_> = channels
            .iter()
            .filter(|(id, source, _, _)| requested.contains(&(source.as_str(), id.as_str())))
            .map(
                |(id, source, provider, _)| reviewed_aliases::CatalogTarget {
                    source_id: source,
                    channel_id: id,
                    provider_id: provider.as_deref(),
                    removed: false,
                },
            )
            .collect();
        let mut feed_ids = HashSet::new();
        for pair in &descriptor.pairs {
            for identity in [&pair.xmltv_channel_id, &pair.provider_id] {
                check(canceled)?;
                let found: bool = sql(connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM guide_channel WHERE guide_source_id=?1 AND id=?2)",
                    params![source.id, identity],
                    |r| r.get(0),
                ))?;
                if found {
                    feed_ids.insert(identity.as_str());
                }
            }
        }
        let flag = AtomicBool::new(false);
        let admitted =
            reviewed_aliases::admit(descriptor, &source.location, &targets, &feed_ids, &flag)
                .map_err(str::to_string)?;
        check(canceled)?;
        for (identity, target) in admitted {
            alias_matches.insert((identity.0, identity.1, source.id.clone()), target);
        }
    }
    let preserved: i64 =
        sql(connection.query_row("SELECT count(*) FROM guide_mapping", [], |r| r.get(0)))?;
    let mut result = CachedConnection {
        catalog_revision: actual.to_string(),
        matched: 0,
        unmatched: 0,
        ambiguous: 0,
        preserved_mappings: usize::try_from(preserved).map_err(|_| "guide-cache-match-limit")?,
        checked_sources: sources.len(),
        mapping_conflict_assessment: "complete",
        preserved_mapping_conflicts: Some(0),
        reviewed_crosswalk: outcome,
    };
    let now_ms = now_ms()?;
    let mut pending = Vec::new();
    let mut lookup = sql(connection
        .prepare("SELECT EXISTS(SELECT 1 FROM guide_channel WHERE guide_source_id=?1 AND id=?2)"))?;
    let mut assessment_work = 0usize;
    const MAX_ASSESSMENT_WORK: usize = 1_000_000;
    for (id, source, provider, mapped) in &channels {
        check(canceled)?;
        if *mapped && result.mapping_conflict_assessment == "not-assessed" {
            continue;
        }
        let mut choices = HashSet::new();
        for cache in sources {
            check(canceled)?;
            if *mapped {
                assessment_work += 1;
                if assessment_work > MAX_ASSESSMENT_WORK {
                    result.mapping_conflict_assessment = "not-assessed";
                    result.preserved_mapping_conflicts = None;
                    break;
                }
            }
            if let Some(target) = alias_matches.get(&(source.clone(), id.clone(), cache.id.clone()))
            {
                choices.insert((cache.id.clone(), target.clone()));
            }
            if let Some(provider) = provider.as_deref().filter(|p| !p.is_empty()) {
                let found: bool = sql(lookup.query_row(params![cache.id, provider], |r| r.get(0)))?;
                if found {
                    choices.insert((cache.id.clone(), provider.to_string()));
                }
                if cache.location == reviewed_crosswalk::FEED {
                    if let Some(target) = authority.and_then(|a| a.target(provider)) {
                        // Publisher-derived candidates are not caller requests:
                        // absent IDs provide no match, never a fabricated alias.
                        let present: bool =
                            sql(lookup.query_row(params![cache.id, target], |r| r.get(0)))?;
                        if present {
                            choices.insert((cache.id.clone(), target.to_owned()));
                        }
                    }
                }
                // Embedded published tuples and main-feed equivalence; only an
                // actually present header becomes a choice, and two distinct
                // present choices remain ambiguous rather than ranked.
                // Admitted caches are URL sources (validated above).
                for alternate in crosswalk_pack::alternates(Some(&cache.location), provider) {
                    let present: bool =
                        sql(lookup.query_row(params![cache.id, alternate], |r| r.get(0)))?;
                    if present {
                        choices.insert((cache.id.clone(), alternate));
                    }
                }
            }
            if *mapped && choices.len() > 1 {
                // Two distinct exact choices already establish a conflict;
                // further candidates cannot change this nonmutating verdict.
                break;
            }
        }
        if *mapped {
            if choices.len() > 1 {
                result.preserved_mapping_conflicts =
                    result.preserved_mapping_conflicts.map(|count| count + 1);
            }
            // Assessment is deliberately nonmutating: user/automatic origin
            // is unknown and every existing mapping remains authoritative.
            continue;
        }
        let count = choices.len();
        let choice = match count {
            0 => None,
            1 => choices.into_iter().next(),
            _ => best_covered_choice(connection, &choices, now_ms, canceled)?,
        };
        let Some((guide, target)) = choice else {
            result.unmatched += 1;
            if count > 1 {
                result.ambiguous += 1;
            }
            continue;
        };
        pending.push(super::database::GuideMapping {
            catalog_source_id: source.clone(),
            app_channel_id: id.clone(),
            guide_source_id: guide,
            xmltv_channel_id: target,
        });
        result.matched += 1;
    }
    drop(lookup);
    check(canceled)?;
    Ok(ConnectionPlan { result, pending })
}
#[cfg(test)]
mod tests;

#[cfg(test)]
mod empty_cache_tests {
    use super::*;
    use rusqlite::OpenFlags;

    fn fixture() -> (tempfile::TempDir, Connection) {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("empty-cache.sqlite3");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch("PRAGMA journal_mode=DELETE;
                CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,catalog_revision INTEGER,automatic_guide_updates INTEGER);
                INSERT INTO metadata VALUES(1,7,1);
                CREATE TABLE channel(id TEXT PRIMARY KEY,source_id TEXT,provider_id TEXT);
                CREATE TABLE removed(id TEXT PRIMARY KEY);
                CREATE TABLE guide_mapping(catalog_source_id TEXT,app_channel_id TEXT,guide_source_id TEXT,xmltv_channel_id TEXT,PRIMARY KEY(catalog_source_id,app_channel_id));
                CREATE TABLE guide_meta(singleton INTEGER PRIMARY KEY,revision INTEGER);
                INSERT INTO guide_meta VALUES(1,23);
                INSERT INTO channel VALUES('mapped','catalog','same-provider'),('unmapped','other','same-provider'),('removed','catalog','same-provider');
                INSERT INTO removed VALUES('removed');
                INSERT INTO guide_mapping VALUES('catalog','mapped','guide','feed'),('catalog','removed','guide','feed'),('catalog','missing','guide','feed');").unwrap();
        }
        let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        c.execute_batch("PRAGMA query_only=ON;").unwrap();
        (root, c)
    }

    #[test]
    fn empty_cache_receipt_is_exact_readonly_and_preserves_database_bytes() {
        let (root, c) = fixture();
        let path = root.path().join("empty-cache.sqlite3");
        let before = std::fs::read(&path).unwrap();
        let result = connect_empty_cached(&c, "7", &[], true, &|| false).unwrap();
        assert_eq!(
            (result.matched, result.unmatched, result.ambiguous),
            (0, 1, 0)
        );
        assert_eq!((result.preserved_mappings, result.checked_sources), (3, 0));
        assert_eq!(result.catalog_revision, "7");
        assert_eq!(result.mapping_conflict_assessment, "complete");
        assert_eq!(result.preserved_mapping_conflicts, Some(0));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
        assert_eq!(
            c.query_row("SELECT revision FROM guide_meta", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            23
        );
    }

    #[test]
    fn empty_cache_refuses_stale_catalog_cancellation_and_unselected_aliases() {
        let (_root, c) = fixture();
        assert_eq!(
            connect_empty_cached(&c, "6", &[], true, &|| false).unwrap_err(),
            "catalog-revision-stale"
        );
        assert_eq!(
            connect_empty_cached(&c, "07", &[], true, &|| false).unwrap_err(),
            "catalog-revision-invalid"
        );
        assert_eq!(
            connect_empty_cached(&c, "7", &[], true, &|| true).unwrap_err(),
            "guide-cancelled"
        );
        let alias = ReviewedAliases {
            schema_version: 0,
            guide_location: "invalid".into(),
            provenance_location: String::new(),
            provenance_sha256: String::new(),
            pairs: vec![],
        };
        assert_eq!(
            connect_empty_cached(&c, "7", &[alias], true, &|| false).unwrap_err(),
            "guide-alias-source-refused"
        );
    }

    #[test]
    fn empty_cache_reads_current_off_and_removal_choices() {
        let (root, c) = fixture();
        let writer = Connection::open(root.path().join("empty-cache.sqlite3")).unwrap();
        writer
            .execute_batch("UPDATE metadata SET automatic_guide_updates=0;DELETE FROM removed;")
            .unwrap();
        assert_eq!(
            connect_empty_cached(&c, "7", &[], true, &|| false).unwrap_err(),
            "guide-refresh-disabled"
        );
        // Explicit/manual matching keeps its existing permission distinction.
        let result = connect_empty_cached(&c, "7", &[], false, &|| false).unwrap();
        assert_eq!((result.unmatched, result.preserved_mappings), (1, 3));
        writer
            .execute_batch("DELETE FROM guide_mapping WHERE app_channel_id='removed';")
            .unwrap();
        assert_eq!(
            connect_empty_cached(&c, "7", &[], false, &|| false)
                .unwrap()
                .unmatched,
            2
        );
    }

    #[test]
    fn empty_cache_cancellation_after_snapshot_does_not_mutate() {
        let (root, c) = fixture();
        let path = root.path().join("empty-cache.sqlite3");
        let before = std::fs::read(&path).unwrap();
        let calls = std::cell::Cell::new(0usize);
        let canceled = || {
            calls.set(calls.get() + 1);
            calls.get() >= 3
        };
        assert_eq!(
            connect_empty_cached(&c, "7", &[], true, &canceled).unwrap_err(),
            "guide-cancelled"
        );
        assert!(c.is_autocommit());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}
