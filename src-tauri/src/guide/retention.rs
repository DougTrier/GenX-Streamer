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

//! Full input validation precedes this bounded, source-scoped schedule projection.
//! Headers remain complete for manual mapping; a projection is not a full feed cache.
use super::{
    crosswalk_pack, database as db, parser::ParsedGuide, reviewed_aliases, reviewed_crosswalk,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

pub(crate) const POLICY: i64 = 1;
pub(crate) const DAY: i64 = 86_400_000;
pub(crate) const GRACE: i64 = 7_200_000;
pub(crate) const SCHEMA: &str = "CREATE TABLE guide_projection_v1(source_id TEXT PRIMARY KEY REFERENCES guide_source(id) ON DELETE CASCADE,policy_version INTEGER NOT NULL,published_revision INTEGER NOT NULL,anchor_ms INTEGER NOT NULL,window_start_ms INTEGER NOT NULL,window_end_ms INTEGER NOT NULL,interest_hash TEXT NOT NULL,authority_stamp TEXT NOT NULL,source_fingerprint TEXT NOT NULL,input_channels INTEGER NOT NULL,input_programs INTEGER NOT NULL,retained_programs INTEGER NOT NULL,identity_complete INTEGER NOT NULL CHECK(identity_complete IN(0,1)));";
type CatalogRows = Vec<(String, String, Option<String>)>;
type MappingRows = Vec<(String, String, String, String)>;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Scope {
    pub source: db::GuideSource,
    proposed: bool,
    proposed_permissions: Option<String>,
    pub catalog_revision: String,
    guide_revision: i64,
    published_revision: Option<i64>,
    projection_fingerprint: Option<String>,
    automatic: Option<i64>,
    channels: Arc<CatalogRows>,
    mappings: Arc<MappingRows>,
    pub anchor_ms: i64,
}
pub(crate) struct Request {
    pub scope: Scope,
    pub authority: Option<Arc<reviewed_crosswalk::VerifiedCrosswalk>>,
    pub aliases: Option<reviewed_aliases::ReviewedAliases>,
    pub automatic: bool,
    pub allow_empty: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub policy_version: i64,
    pub window_start_ms: i64,
    pub window_end_ms: i64,
    pub input_channels: i64,
    pub input_programs: i64,
    pub retained_programs: i64,
    pub identity_complete: bool,
}
pub(crate) struct Projection {
    pub feed: ParsedGuide,
    ids: BTreeSet<String>,
    authority: String,
    complete: bool,
    input_programs: usize,
}
impl Projection {
    pub(super) fn has_interest(&self) -> bool {
        !self.ids.is_empty()
    }
}
fn check(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::Acquire) {
        Err("guide-cancelled".into())
    } else {
        Ok(())
    }
}
pub(crate) fn install(c: &Connection) -> Result<(), String> {
    db::sql(c.execute_batch(SCHEMA))
}
pub(crate) fn validate(c: &Connection) -> Result<(), String> {
    let schema: Option<String> = db::sql(
        c.query_row(
            "SELECT sql FROM sqlite_schema WHERE name='guide_projection_v1' AND type='table'",
            [],
            |r| r.get(0),
        )
        .optional(),
    )?;
    if schema.as_deref().map(|s| s.trim_end_matches(';')) != Some(SCHEMA.trim_end_matches(';')) {
        return Err("guide-projection-schema-invalid".into());
    }
    let count: i64 =
        db::sql(c.query_row("SELECT count(*) FROM guide_projection_v1", [], |r| r.get(0)))?;
    if count > 1000 {
        return Err("guide-projection-limit".into());
    }
    let future: bool = db::sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM guide_projection_v1 WHERE policy_version<>1)",
        [],
        |r| r.get(0),
    ))?;
    if future {
        return Err("guide-projection-policy-unsupported".into());
    }
    let invalid:bool=db::sql(c.query_row("SELECT EXISTS(SELECT 1 FROM guide_projection_v1 p LEFT JOIN guide_source s ON s.id=p.source_id WHERE s.id IS NULL OR p.published_revision<1 OR p.published_revision>s.revision OR p.window_start_ms<>p.anchor_ms-7200000 OR p.window_end_ms<>p.anchor_ms+691200000 OR p.anchor_ms%86400000<>0 OR length(p.interest_hash)<>64 OR length(p.source_fingerprint)<>64 OR length(p.authority_stamp)>128 OR p.input_channels<0 OR p.input_channels>100000 OR p.input_programs<0 OR p.input_programs>500000 OR p.retained_programs<0 OR p.retained_programs>p.input_programs)",[],|r|r.get(0)))?;
    if invalid {
        return Err("guide-projection-state-invalid".into());
    }
    Ok(())
}
pub(crate) fn capture(c: &Connection, id: &str, now: i64) -> Result<Scope, String> {
    let source = db::list_sources(c)?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("guide-source-missing")?;
    capture_inner(c, source, now, false)
}
pub(crate) fn capture_proposed(
    c: &Connection,
    source: db::GuideSource,
    now: i64,
) -> Result<Scope, String> {
    super::provisional::validate_absent(c, &source)?;
    capture_inner(c, source, now, true)
}
fn capture_inner(
    c: &Connection,
    source: db::GuideSource,
    now: i64,
    proposed: bool,
) -> Result<Scope, String> {
    let id = source.id.as_str();
    let proposed_permissions = if proposed {
        let saved: Option<String> = db::sql(c.query_row(
            "SELECT (SELECT reviewed_guide_providers FROM preference WHERE singleton=1)",
            [],
            |r| r.get(0),
        ))?;
        if saved.as_ref().is_some_and(|v| v.len() > 20 * 1024 * 1024) {
            return Err("guide-proposed-permission-limit".into());
        }
        Some(db::key(saved)?)
    } else {
        None
    };
    db::valid_time(now)?;
    validate(c)?;
    let projection_fingerprint = db::sql(
        c.query_row(
            "SELECT * FROM guide_projection_v1 WHERE source_id=?1",
            [id],
            |r| {
                let mut hash = Sha256::new();
                for i in 0..13 {
                    match r.get_ref(i)? {
                        rusqlite::types::ValueRef::Integer(v) => {
                            hash.update([1]);
                            hash.update(v.to_be_bytes());
                        }
                        rusqlite::types::ValueRef::Text(v) if v.len() <= 1024 => {
                            hash.update([2]);
                            hash.update((v.len() as u64).to_be_bytes());
                            hash.update(v);
                        }
                        _ => return Err(rusqlite::Error::InvalidQuery),
                    }
                }
                Ok(format!("{:x}", hash.finalize()))
            },
        )
        .optional(),
    )?;
    let (catalog,guide,automatic):(i64,i64,Option<i64>)=db::sql(c.query_row("SELECT m.catalog_revision,g.revision,m.automatic_guide_updates FROM metadata m,guide_meta g WHERE m.singleton=1 AND g.singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))))?;
    let published = if proposed {
        None
    } else {
        db::sql(c.query_row(
            "SELECT published_revision FROM guide_source WHERE id=?1",
            [id],
            |r| r.get(0),
        ))?
    };
    let mut channels = Vec::new();
    let mut bytes = 0usize;
    let mut q=db::sql(c.prepare("SELECT source_id,id,provider_id FROM channel WHERE NOT EXISTS(SELECT 1 FROM removed r WHERE r.id=channel.id) ORDER BY source_id,id"))?;
    let rows = db::sql(q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    }))?;
    for r in rows {
        let r = db::sql(r)?;
        bytes = bytes.saturating_add(r.0.len() + r.1.len() + r.2.as_ref().map_or(0, String::len));
        if channels.len() >= 100000 || bytes > 32 * 1024 * 1024 {
            return Err("guide-retention-catalog-limit".into());
        }
        channels.push(r);
    }
    let mut mappings = Vec::new();
    let mut q=db::sql(c.prepare("SELECT catalog_source_id,app_channel_id,guide_source_id,xmltv_channel_id FROM guide_mapping ORDER BY catalog_source_id,app_channel_id"))?;
    let rows = db::sql(q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    }))?;
    for r in rows {
        let r = db::sql(r)?;
        bytes = bytes.saturating_add(r.0.len() + r.1.len() + r.2.len() + r.3.len());
        if mappings.len() >= 100000 || bytes > 32 * 1024 * 1024 {
            return Err("guide-retention-catalog-limit".into());
        }
        mappings.push(r);
    }
    Ok(Scope {
        source,
        proposed,
        proposed_permissions,
        catalog_revision: catalog.to_string(),
        guide_revision: guide,
        published_revision: published,
        projection_fingerprint,
        automatic,
        channels: Arc::new(channels),
        mappings: Arc::new(mappings),
        anchor_ms: now,
    })
}
pub(crate) fn capture_snapshot(c: &Connection, id: &str, now: i64) -> Result<Scope, String> {
    let tx = db::sql(c.unchecked_transaction())?;
    let scope = capture(&tx, id, now)?;
    db::sql(tx.commit())?;
    Ok(scope)
}
pub(crate) fn verify(c: &Connection, scope: &Scope) -> Result<(), String> {
    let current = if scope.proposed {
        capture_proposed(c, scope.source.clone(), scope.anchor_ms)?
    } else {
        capture(c, &scope.source.id, scope.anchor_ms)?
    };
    if current != *scope {
        return Err("guide-retention-scope-stale".into());
    }
    Ok(())
}
pub(crate) fn install_proposed(c: &Connection, scope: &Scope) -> Result<(), String> {
    if scope.proposed {
        super::provisional::insert(c, &scope.source)?;
    }
    Ok(())
}
pub(crate) fn is_proposed(scope: &Scope) -> bool {
    scope.proposed
}
fn window(now: i64) -> Result<(i64, i64, i64), String> {
    let anchor = now
        .div_euclid(DAY)
        .checked_mul(DAY)
        .ok_or("guide-invalid-instant")?;
    let lower = anchor.checked_sub(GRACE).ok_or("guide-invalid-instant")?;
    let upper = anchor.checked_add(8 * DAY).ok_or("guide-invalid-instant")?;
    db::valid_time(lower)?;
    db::valid_time(upper)?;
    Ok((anchor, lower, upper))
}
pub(crate) fn publication_window(request: &Request, now: i64) -> Result<(), String> {
    db::valid_time(now)?;
    let (_, lower, upper) = window(request.scope.anchor_ms)?;
    if lower > now - GRACE || upper < now + 7 * DAY {
        return Err("guide-retention-window-stale".into());
    }
    Ok(())
}
fn source_fingerprint(scope: &Scope) -> Result<String, String> {
    db::key((
        &scope.source.id,
        &scope.source.location,
        &scope.source.kind,
        scope.source.allow_http,
    ))
}
const CLEANUP_PLAN_BYTES: usize = 16 * 1024 * 1024;
struct PlanBudget {
    used: usize,
    limit: usize,
}
impl PlanBudget {
    fn charge(&mut self, bytes: usize) -> Result<(), String> {
        let next = self
            .used
            .checked_add(bytes)
            .ok_or("guide-retention-cleanup-plan-limit")?;
        if next > self.limit {
            return Err("guide-retention-cleanup-plan-limit".into());
        }
        self.used = next;
        Ok(())
    }
}
fn insert_interest(
    ids: &mut BTreeSet<String>,
    value: &str,
    budget: &mut Option<&mut PlanBudget>,
) -> Result<(), String> {
    if !ids.contains(value) {
        // Conservative per-key node allowance includes String's stack record;
        // a separate root allowance below covers tiny/underfilled trees.
        if let Some(b) = budget.as_deref_mut() {
            b.charge(value.len() + std::mem::size_of::<String>() + 128)?;
        }
        ids.insert(value.to_owned());
    }
    Ok(())
}
fn identity(
    scope: &Scope,
    headers: &HashSet<&str>,
    authority: Option<&reviewed_crosswalk::VerifiedCrosswalk>,
    aliases: Option<&reviewed_aliases::ReviewedAliases>,
    flag: &AtomicBool,
    mut budget: Option<&mut PlanBudget>,
) -> Result<(BTreeSet<String>, String, bool), String> {
    let saved: HashSet<(&str, &str)> = scope
        .channels
        .iter()
        .map(|c| (c.0.as_str(), c.1.as_str()))
        .collect();
    let mut ids = BTreeSet::new();
    for m in scope
        .mappings
        .iter()
        .filter(|m| m.2 == scope.source.id && saved.contains(&(m.0.as_str(), m.1.as_str())))
    {
        insert_interest(&mut ids, &m.3, &mut budget)?;
    }
    let eligible = scope.source.kind == "url" && scope.source.location == reviewed_crosswalk::FEED;
    let location = (scope.source.kind == "url").then_some(scope.source.location.as_str());
    for (_, _, provider) in scope.channels.iter() {
        check(flag)?;
        if let Some(p) = provider {
            if headers.contains(p.as_str()) {
                insert_interest(&mut ids, p, &mut budget)?;
            }
            // Published exact tuples and main-feed equivalence; present headers only.
            for alternate in crosswalk_pack::alternates(location, p) {
                if headers.contains(alternate.as_str()) {
                    insert_interest(&mut ids, &alternate, &mut budget)?;
                }
            }
            if eligible {
                if let Some(target) = authority.and_then(|a| a.target(p)) {
                    if headers.contains(target) {
                        insert_interest(&mut ids, target, &mut budget)?;
                    }
                }
            }
        }
    }
    if let Some(descriptor) = aliases {
        let targets: Vec<_> = scope
            .channels
            .iter()
            .map(|(s, c, p)| reviewed_aliases::CatalogTarget {
                source_id: s,
                channel_id: c,
                provider_id: p.as_deref(),
                removed: false,
            })
            .collect();
        let admitted =
            reviewed_aliases::admit(descriptor, &scope.source.location, &targets, headers, flag)
                .map_err(str::to_owned)?;
        for value in admitted.into_values() {
            insert_interest(&mut ids, &value, &mut budget)?;
        }
    }
    let complete = !eligible || authority.is_some();
    let stamp = if eligible && authority.is_some() {
        reviewed_crosswalk::authority_stamp().to_owned()
    } else if eligible {
        "unavailable".to_owned()
    } else {
        "not-required".to_owned()
    };
    let stamp = format!("{stamp}+pack:{}", crosswalk_pack::stamp());
    Ok((ids, stamp, complete))
}
pub(crate) fn project(
    c: &Connection,
    request: &Request,
    feed: &ParsedGuide,
    flag: &AtomicBool,
) -> Result<Projection, String> {
    verify(c, &request.scope)?;
    if request.scope.proposed && feed.programs.is_empty() && !request.allow_empty {
        return Err("guide-empty-confirmation-required".into());
    }
    if request.automatic {
        super::refresh::require_automatic_updates(c)?;
    }
    let (_, lower, upper) = window(request.scope.anchor_ms)?;
    let headers: HashSet<&str> = feed.channels.iter().map(|h| h.id.as_str()).collect();
    let (ids, authority, complete) = identity(
        &request.scope,
        &headers,
        request.authority.as_deref(),
        request.aliases.as_ref(),
        flag,
        None,
    )?;
    if !complete {
        return Err("guide-retention-identity-unavailable".into());
    }
    let mut previous: HashMap<&str, i64> = HashMap::new();
    for p in &feed.programs {
        check(flag)?;
        if ids.contains(&p.channel_id) && p.stop_ms.is_none() && p.start_ms < lower {
            previous
                .entry(&p.channel_id)
                .and_modify(|v| *v = (*v).max(p.start_ms))
                .or_insert(p.start_ms);
        }
    }
    let mut programs = Vec::new();
    for p in &feed.programs {
        check(flag)?;
        if !ids.contains(&p.channel_id) || p.start_ms >= upper {
            continue;
        }
        let keep = match p.stop_ms {
            Some(stop) => stop > lower,
            None => p.start_ms >= lower || previous.get(p.channel_id.as_str()) == Some(&p.start_ms),
        };
        if keep {
            programs.push(p.clone());
        }
    }
    if !request.allow_empty {
        // A partial upstream response cannot silently erase a still-useful
        // interested schedule. Refuse the entire replacement, retaining its age.
        let incoming: HashSet<&str> = programs
            .iter()
            .filter(|p| p.stop_ms.is_some_and(|stop| stop > request.scope.anchor_ms))
            .map(|p| p.channel_id.as_str())
            .collect();
        let mut protected: HashSet<&str> = request
            .scope
            .channels
            .iter()
            .filter_map(|c| c.2.as_deref())
            .collect();
        if request.scope.source.kind == "url"
            && request.scope.source.location == reviewed_crosswalk::FEED
        {
            if let Some(a) = request.authority.as_deref() {
                for provider in request.scope.channels.iter().filter_map(|c| c.2.as_deref()) {
                    if let Some(target) = a.target(provider) {
                        protected.insert(target);
                    }
                }
            }
        }
        let location =
            (request.scope.source.kind == "url").then_some(request.scope.source.location.as_str());
        let pack_targets: Vec<String> = request
            .scope
            .channels
            .iter()
            .filter_map(|c| c.2.as_deref())
            .flat_map(|provider| crosswalk_pack::alternates(location, provider))
            .collect();
        protected.extend(pack_targets.iter().map(String::as_str));
        let mut q = db::sql(c.prepare(
            "SELECT DISTINCT channel_id FROM guide_program WHERE guide_source_id=?1 AND stop_ms>?2",
        ))?;
        for id in db::sql(q.query_map(
            params![request.scope.source.id, request.scope.anchor_ms],
            |r| r.get::<_, String>(0),
        ))? {
            let id = db::sql(id)?;
            if (ids.contains(&id) || protected.contains(id.as_str()))
                && !incoming.contains(id.as_str())
            {
                return Err("guide-retention-would-drop-useful-schedule".into());
            }
        }
        if request.automatic && !ids.is_empty() && incoming.is_empty() {
            return Err("guide-retention-no-useful-schedule".into());
        }
    }
    Ok(Projection {
        feed: ParsedGuide {
            channels: feed.channels.clone(),
            programs,
        },
        ids,
        authority,
        complete,
        input_programs: feed.programs.len(),
    })
}
pub(crate) fn record(
    c: &Connection,
    request: &Request,
    projection: &Projection,
    revision: i64,
) -> Result<(), String> {
    let (anchor, lower, upper) = window(request.scope.anchor_ms)?;
    // replace_rows collapses exact duplicate programmes. Persist the count of
    // the actual publication, not the pre-dedup projection vector length.
    let retained: i64 = db::sql(c.query_row(
        "SELECT count(*) FROM guide_program WHERE guide_source_id=?1",
        [&request.scope.source.id],
        |r| r.get(0),
    ))?;
    db::sql(c.execute("INSERT INTO guide_projection_v1 VALUES(?1,1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(source_id) DO UPDATE SET policy_version=1,published_revision=excluded.published_revision,anchor_ms=excluded.anchor_ms,window_start_ms=excluded.window_start_ms,window_end_ms=excluded.window_end_ms,interest_hash=excluded.interest_hash,authority_stamp=excluded.authority_stamp,source_fingerprint=excluded.source_fingerprint,input_channels=excluded.input_channels,input_programs=excluded.input_programs,retained_programs=excluded.retained_programs,identity_complete=excluded.identity_complete",params![request.scope.source.id,revision,anchor,lower,upper,db::key(&projection.ids)?,projection.authority,source_fingerprint(&request.scope)?,projection.feed.channels.len() as i64,projection.input_programs as i64,retained,projection.complete]))?;
    Ok(())
}
pub fn status(c: &Connection, id: &str) -> Result<Option<Status>, String> {
    let exists: bool = db::sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='guide_projection_v1')",
        [],
        |r| r.get(0),
    ))?;
    if !exists {
        return Ok(None);
    }
    db::sql(c.query_row("SELECT policy_version,window_start_ms,window_end_ms,input_channels,input_programs,retained_programs,identity_complete FROM guide_projection_v1 WHERE source_id=?1",[id],|r|Ok(Status{policy_version:r.get(0)?,window_start_ms:r.get(1)?,window_end_ms:r.get(2)?,input_channels:r.get(3)?,input_programs:r.get(4)?,retained_programs:r.get(5)?,identity_complete:r.get(6)?})).optional())
}
pub(crate) fn compatibility(
    c: &Connection,
    scope: &Scope,
    authority: Option<&reviewed_crosswalk::VerifiedCrosswalk>,
) -> Result<(bool, Option<usize>), String> {
    let Some(status) = status(c, &scope.source.id)? else {
        return Ok((false, None));
    };
    if status.policy_version != POLICY {
        return Err("guide-projection-policy-unsupported".into());
    }
    let mut headers = Vec::new();
    let mut q = db::sql(c.prepare("SELECT id FROM guide_channel WHERE guide_source_id=?1"))?;
    for id in db::sql(q.query_map([&scope.source.id], |r| r.get::<_, String>(0)))? {
        headers.push(db::sql(id)?);
        if headers.len() > 100000 {
            return Err("guide-record-limit".into());
        }
    }
    let headers: HashSet<&str> = headers.iter().map(String::as_str).collect();
    let (ids, stamp, complete) = identity(
        scope,
        &headers,
        authority,
        None,
        &AtomicBool::new(false),
        None,
    )?;
    if !complete || headers.is_empty() {
        return Ok((false, None));
    }
    let (revision,hash,old_stamp,fingerprint):(i64,String,String,String)=db::sql(c.query_row("SELECT published_revision,interest_hash,authority_stamp,source_fingerprint FROM guide_projection_v1 WHERE source_id=?1",[&scope.source.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))))?;
    let actual_programs: i64 = db::sql(c.query_row(
        "SELECT count(*) FROM guide_program WHERE guide_source_id=?1",
        [&scope.source.id],
        |r| r.get(0),
    ))?;
    if status.retained_programs != actual_programs {
        return Ok((false, None));
    }
    let compatible = revision == scope.source.revision
        && scope.published_revision == Some(revision)
        && hash == db::key(&ids)?
        && old_stamp == stamp
        && fingerprint == source_fingerprint(scope)?
        && status.window_start_ms <= scope.anchor_ms - GRACE
        && status.window_end_ms >= scope.anchor_ms + 7 * DAY;
    Ok((compatible, compatible.then_some(ids.len())))
}

pub(crate) fn permits_304(
    c: &Connection,
    scope: &Scope,
    authority: Option<&reviewed_crosswalk::VerifiedCrosswalk>,
) -> Result<bool, String> {
    Ok(compatibility(c, scope, authority)?.0)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupReceipt {
    pub sources_changed: usize,
    pub programs_before: usize,
    pub programs_after: usize,
    pub programs_removed: usize,
    pub headers_retained: usize,
}
struct CleanupSource {
    scope: Scope,
    drop_ordinals: Vec<i64>,
    ids: BTreeSet<String>,
    authority: String,
    complete: bool,
    headers: usize,
    before: usize,
    legacy: bool,
}
pub(crate) struct CleanupPlan {
    sources: Vec<CleanupSource>,
    pub receipt: CleanupReceipt,
    #[cfg(test)]
    estimated_bytes: usize,
}
fn stored_text(row: &rusqlite::Row<'_>, i: usize, max: usize) -> Result<String, String> {
    let value = db::sql(row.get_ref(i))?;
    let text = value.as_str().map_err(|_| "guide-invalid-stored-program")?;
    db::valid_text(text, max, false)?;
    Ok(text.to_owned())
}
/// Reads and validates every stored row, but holds only bounded headers and
/// deletion ordinals, rather than cloning the entire schedule payload in RAM.
pub(crate) fn prepare_cleanup(
    c: &Connection,
    now: i64,
    authority: Option<&reviewed_crosswalk::VerifiedCrosswalk>,
    flag: &AtomicBool,
) -> Result<CleanupPlan, String> {
    prepare_cleanup_limited(c, now, authority, flag, CLEANUP_PLAN_BYTES)
}
fn prepare_cleanup_limited(
    c: &Connection,
    now: i64,
    authority: Option<&reviewed_crosswalk::VerifiedCrosswalk>,
    flag: &AtomicBool,
    limit: usize,
) -> Result<CleanupPlan, String> {
    validate(c)?;
    let tx = db::sql(c.unchecked_transaction())?;
    let source_list = db::list_sources(&tx)?;
    let mut budget = PlanBudget {
        used: std::mem::size_of::<CleanupPlan>(),
        limit,
    };
    budget.charge(
        source_list
            .len()
            .checked_mul(std::mem::size_of::<CleanupSource>())
            .ok_or("guide-retention-cleanup-plan-limit")?,
    )?;
    let mut sources = Vec::new();
    sources
        .try_reserve_exact(source_list.len())
        .map_err(|_| "guide-retention-cleanup-plan-limit")?;
    if sources.capacity() > source_list.len() {
        budget.charge(
            (sources.capacity() - source_list.len()) * std::mem::size_of::<CleanupSource>(),
        )?;
    }
    let mut receipt = CleanupReceipt {
        sources_changed: 0,
        programs_before: 0,
        programs_after: 0,
        programs_removed: 0,
        headers_retained: 0,
    };
    let (_, lower, upper) = window(now)?;
    let mut shared_rows: Option<(Arc<CatalogRows>, Arc<MappingRows>)> = None;
    for source in source_list {
        check(flag)?;
        let mut scope = capture(&tx, &source.id, now)?;
        budget.charge(
            scope.source.id.capacity()
                + scope.source.name.capacity()
                + scope.source.location.capacity()
                + scope.source.kind.capacity()
                + scope.catalog_revision.capacity()
                + scope
                    .projection_fingerprint
                    .as_ref()
                    .map_or(0, String::capacity)
                + 512,
        )?;
        // Every scope comes from this same read transaction. Retain one shared
        // immutable catalog/mapping value, not sources times catalog-sized RAM.
        if let Some((channels, mappings)) = &shared_rows {
            if scope.channels.as_ref() != channels.as_ref()
                || scope.mappings.as_ref() != mappings.as_ref()
            {
                return Err("guide-retention-scope-stale".into());
            }
            scope.channels = channels.clone();
            scope.mappings = mappings.clone();
        } else {
            shared_rows = Some((scope.channels.clone(), scope.mappings.clone()));
        }
        let mut headers = Vec::new();
        let mut q = db::sql(tx.prepare(
            "SELECT id,names_json FROM guide_channel WHERE guide_source_id=?1 ORDER BY id",
        ))?;
        for row in db::sql(q.query_map([&source.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        }))? {
            let (id, names) = db::sql(row)?;
            if id.len() > 16384 || names.len() > 65536 || headers.len() >= 100000 {
                return Err("guide-record-limit".into());
            }
            headers.push(super::parser::GuideChannel {
                id,
                names: serde_json::from_str(&names).map_err(|_| "guide-invalid-stored-channel")?,
            });
        }
        db::validate_feed(
            &ParsedGuide {
                channels: headers.clone(),
                programs: vec![],
            },
            flag,
        )?;
        let header_map: HashMap<&str, &super::parser::GuideChannel> =
            headers.iter().map(|h| (h.id.as_str(), h)).collect();
        let header_ids = header_map.keys().copied().collect();
        let (ids, stamp, complete) = identity(
            &scope,
            &header_ids,
            authority,
            None,
            flag,
            Some(&mut budget),
        )?;
        if !complete {
            return Err("guide-retention-identity-unavailable".into());
        }
        budget.charge(stamp.capacity())?;
        let mut context: HashMap<String, i64> = HashMap::new();
        let mut q=db::sql(tx.prepare("SELECT channel_id,max(start_ms) FROM guide_program WHERE guide_source_id=?1 AND stop_ms IS NULL AND start_ms<?2 GROUP BY channel_id"))?;
        for r in db::sql(q.query_map(params![source.id, lower], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        }))? {
            let (id, start) = db::sql(r)?;
            context.insert(id, start);
            if context.len() > 100000 {
                return Err("guide-record-limit".into());
            }
        }
        let mut q=db::sql(tx.prepare("SELECT ordinal,channel_id,start_ms,stop_ms,title,description,categories_json FROM guide_program WHERE guide_source_id=?1 ORDER BY ordinal"))?;
        let mut rows = db::sql(q.query([&source.id]))?;
        let mut drop_ordinals = Vec::new();
        let mut before = 0usize;
        let mut bytes = headers
            .iter()
            .map(|h| h.id.len() + h.names.iter().map(String::len).sum::<usize>())
            .sum::<usize>();
        while let Some(row) = db::sql(rows.next())? {
            check(flag)?;
            before += 1;
            if before > 500000 {
                return Err("guide-record-limit".into());
            }
            let ordinal: i64 = db::sql(row.get(0))?;
            let channel_id = stored_text(row, 1, 16384)?;
            let header = header_map
                .get(channel_id.as_str())
                .ok_or("guide-unknown-channel")?;
            let categories = stored_text(row, 6, 32768)?;
            let p = super::parser::GuideProgram {
                channel_id,
                start_ms: db::sql(row.get(2))?,
                stop_ms: db::sql(row.get(3))?,
                title: stored_text(row, 4, 16384)?,
                description: if matches!(db::sql(row.get_ref(5))?, rusqlite::types::ValueRef::Null)
                {
                    None
                } else {
                    Some(stored_text(row, 5, 65536)?)
                },
                categories: serde_json::from_str(&categories)
                    .map_err(|_| "guide-invalid-category")?,
            };
            db::validate_feed(
                &ParsedGuide {
                    channels: vec![(*header).clone()],
                    programs: vec![p.clone()],
                },
                flag,
            )?;
            bytes = bytes.saturating_add(
                p.title.len()
                    + p.channel_id.len()
                    + p.description.as_ref().map_or(0, String::len)
                    + categories.len()
                    + super::category::semantic_key(&p.categories)?.len()
                    + p.categories
                        .iter()
                        .map(|v| v.text.len() + v.language.as_ref().map_or(0, String::len))
                        .sum::<usize>()
                    + 32,
            );
            if bytes > 64 * 1024 * 1024 {
                return Err("guide-record-byte-limit".into());
            }
            let retained = ids.contains(&p.channel_id)
                && p.start_ms < upper
                && match p.stop_ms {
                    Some(stop) => stop > lower,
                    None => p.start_ms >= lower || context.get(&p.channel_id) == Some(&p.start_ms),
                };
            if !retained {
                if drop_ordinals.len() == drop_ordinals.capacity() {
                    let old = drop_ordinals.capacity();
                    let target = if old == 0 {
                        128
                    } else {
                        old.saturating_mul(2).min(500000)
                    };
                    let added = target - old;
                    budget.charge(added * std::mem::size_of::<i64>())?;
                    drop_ordinals
                        .try_reserve_exact(added)
                        .map_err(|_| "guide-retention-cleanup-plan-limit")?;
                    if drop_ordinals.capacity() > target {
                        budget.charge(
                            (drop_ordinals.capacity() - target) * std::mem::size_of::<i64>(),
                        )?;
                    }
                }
                drop_ordinals.push(ordinal);
            }
        }
        let legacy = status(&tx, &source.id)?.is_none();
        let changed = (!headers.is_empty() && legacy) || !drop_ordinals.is_empty();
        receipt.programs_before += before;
        receipt.programs_removed += drop_ordinals.len();
        receipt.programs_after += before - drop_ordinals.len();
        receipt.headers_retained += headers.len();
        if changed {
            receipt.sources_changed += 1;
            if source.revision == i64::MAX {
                return Err("guide-invalid-source-revision".into());
            }
        }
        sources.push(CleanupSource {
            scope,
            drop_ordinals,
            ids,
            authority: stamp,
            complete,
            headers: headers.len(),
            before,
            legacy,
        });
    }
    db::sql(tx.commit())?;
    Ok(CleanupPlan {
        sources,
        receipt,
        #[cfg(test)]
        estimated_bytes: budget.used,
    })
}
pub(crate) fn cleanup_receipt_if_unchanged(
    c: &Connection,
    plan: &CleanupPlan,
) -> Result<Option<CleanupReceipt>, String> {
    let tx = db::sql(c.unchecked_transaction())?;
    for s in &plan.sources {
        verify(&tx, &s.scope)?;
    }
    db::sql(tx.commit())?;
    Ok((plan.receipt.sources_changed == 0).then(|| plan.receipt.clone()))
}
pub(crate) fn commit_cleanup(
    c: &mut Connection,
    plan: &CleanupPlan,
    flag: &AtomicBool,
    guard: &mut dyn FnMut() -> Result<(), String>,
) -> Result<CleanupReceipt, String> {
    check(flag)?;
    guard()?;
    let tx = db::sql(c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
    // Verify the whole captured batch BEFORE mutating any source/meta revision.
    for s in &plan.sources {
        check(flag)?;
        verify(&tx, &s.scope)?;
    }
    for s in &plan.sources {
        if !(s.legacy && s.headers > 0) && s.drop_ordinals.is_empty() {
            continue;
        }
        check(flag)?;
        let mut delete = db::sql(
            tx.prepare("DELETE FROM guide_program WHERE guide_source_id=?1 AND ordinal=?2"),
        )?;
        for ordinal in &s.drop_ordinals {
            check(flag)?;
            db::sql(delete.execute(params![s.scope.source.id, ordinal]))?;
        }
        drop(delete);
        let revision = s.scope.source.revision + 1;
        db::sql(tx.execute(
            "UPDATE guide_source SET revision=?2,published_revision=?2 WHERE id=?1",
            params![s.scope.source.id, revision],
        ))?;
        // Transport validators belonged to the prior publication. Cleanup does
        // not observe a fresh body and must not relabel old schedules fresh.
        let cache: bool = db::sql(tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='guide_http_cache')",
            [],
            |r| r.get(0),
        ))?;
        if cache {
            db::sql(tx.execute(
                "DELETE FROM guide_http_cache WHERE source_id=?1",
                [&s.scope.source.id],
            ))?;
        }
        if s.legacy {
            let request = Request {
                scope: s.scope.clone(),
                authority: None,
                aliases: None,
                automatic: false,
                allow_empty: true,
            };
            let p = Projection {
                feed: ParsedGuide {
                    channels: vec![],
                    programs: vec![],
                },
                ids: s.ids.clone(),
                authority: s.authority.clone(),
                complete: s.complete,
                input_programs: s.before,
            };
            record(&tx, &request, &p, revision)?;
            db::sql(tx.execute("UPDATE guide_projection_v1 SET input_channels=?2,retained_programs=?3 WHERE source_id=?1",params![s.scope.source.id,s.headers as i64,(s.before-s.drop_ordinals.len()) as i64]))?;
        } else {
            db::sql(tx.execute("UPDATE guide_projection_v1 SET published_revision=?2,retained_programs=?3,identity_complete=0 WHERE source_id=?1",params![s.scope.source.id,revision,(s.before-s.drop_ordinals.len()) as i64]))?;
        }
    }
    if plan.receipt.sources_changed > 0 {
        db::advance(&tx)?;
    }
    validate(&tx)?;
    check(flag)?;
    guard()?;
    db::sql(tx.commit())?;
    Ok(plan.receipt.clone())
}

#[cfg(test)]
#[path = "retention_tests.rs"]
mod tests;
