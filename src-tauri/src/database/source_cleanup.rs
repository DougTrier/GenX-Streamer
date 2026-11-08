// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
//! Restorable cleanup requires complete fresh membership and current native proof.
use super::*;
use rusqlite::OptionalExtension;

const ERR: &str = "source-cleanup-invalid";
const ROUND_TTL: u64 = 2 * 3_600_000;
const POSITIVE_TTL: u64 = 7 * 86_400_000;
const FAILURE_TTL: u64 = 86_400_000;
const CANDIDATE_LIMIT: usize = 256;
#[cfg(test)]
const PROFILE: &str = "reachability-v3/native-media-resources-v1/max-20000/sequential";
// General media checks may report a missing HLS child resource against the
// root fingerprint. Only this direct-response profile proves root HTTP status.
const CLEANUP_PROFILE: &str = "source-cleanup-v1/top-level-http/max-20000/sequential";
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Begin {
    pub schema_version: u8,
    pub expected_catalog_revision: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Finish {
    pub schema_version: u8,
    pub round_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BeginReply {
    pub schema_version: u8,
    pub round_id: String,
    pub source_count: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelReply {
    pub schema_version: u8,
    pub canceled: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reply {
    pub schema_version: u8,
    pub committed: bool,
    pub status: &'static str,
    pub archived_count: usize,
    pub expired_event_ids: Vec<String>,
    pub checked_targets: usize,
    pub deferred_count: usize,
    pub catalog_revision: String,
    pub health_revision: String,
    pub view_revision: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct SourceProof {
    definition: Value,
    revision: i64,
}
#[derive(Clone, Serialize, Deserialize)]
struct Round {
    runtime: String,
    platform: String,
    catalog_revision: i64,
    config_hash: String,
    started_ms: u64,
    sources: Vec<SourceProof>,
    unknown_coverage: bool,
}
#[derive(Clone)]
pub(crate) struct Target {
    pub key: String,
    pub url: String,
    pub allow_http: bool,
}
#[derive(Clone, Debug)]
pub(crate) struct Fact {
    pub key: String,
    pub status: Option<u16>,
    pub recognized: bool,
    pub observed_at: u64,
}
#[derive(Clone)]
struct CandidateTarget {
    key: String,
    ordinal: usize,
    fingerprint: String,
    cached: Option<Fact>,
}
#[derive(Clone)]
struct Candidate {
    id: String,
    source_id: String,
    targets: Vec<CandidateTarget>,
}
#[derive(Clone)]
pub(crate) struct Prepared {
    round_id: String,
    round: Round,
    promoted: Vec<Option<i64>>,
    candidates: Vec<Candidate>,
    expired_event_ids: Vec<String>,
    pub coverage_complete: bool,
    pub deferred_count: usize,
    pub targets: Vec<Target>,
}
fn hash(v: &Value) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(v).map_err(|_| ERR)?)
    ))
}
fn runtime(store: &PairStore) -> Result<&str, String> {
    if let Some(value) = store.cleanup_runtime.get() {
        return Ok(value);
    }
    let value = crate::scan_resume_runtime::plan_id()?;
    Ok(store.cleanup_runtime.get_or_init(|| value))
}
fn ensure(c: &Connection) -> Result<(), String> {
    sql(c.execute_batch("CREATE TABLE IF NOT EXISTS source_cleanup_round(singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL,state INTEGER NOT NULL CHECK(state IN(0,1)),proof TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS source_snapshot_transport(source_id TEXT NOT NULL,entry_id TEXT NOT NULL,url_ordinal INTEGER NOT NULL,url_hash TEXT NOT NULL,PRIMARY KEY(source_id,entry_id,url_ordinal));
CREATE INDEX IF NOT EXISTS source_snapshot_transport_url ON source_snapshot_transport(url_hash,source_id);
CREATE TABLE IF NOT EXISTS source_snapshot_transport_state(source_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);"))
}
/// Promotion rebuilds all URL positions, including backup transports, atomically.
pub(super) fn index_transports(
    c: &Connection,
    source_id: &str,
    revision: i64,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    ensure(c)?;
    sql(c.execute(
        "DELETE FROM source_snapshot_transport WHERE source_id=?1",
        [source_id],
    ))?;
    let mut statement = sql(c.prepare("SELECT entry_id,channel FROM source_snapshot_entry WHERE source_id=?1 AND available=1 ORDER BY ordinal"))?;
    let mut rows = sql(statement.query([source_id]))?;
    let mut insert = sql(c.prepare("INSERT INTO source_snapshot_transport VALUES(?1,?2,?3,?4)"))?;
    while let Some(row) = sql(rows.next())? {
        check()?;
        let id: String = sql(row.get(0))?;
        let channel: Value = serde_json::from_str(&sql::<String>(row.get(1))?).map_err(|_| ERR)?;
        for (ordinal, url) in channel["urls"].as_array().ok_or(ERR)?.iter().enumerate() {
            sql(insert.execute(params![source_id, id, ordinal as i64, hash(url)?]))?;
        }
    }
    sql(c.execute("INSERT INTO source_snapshot_transport_state VALUES(?1,?2) ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision",params![source_id,revision]))?;
    Ok(())
}
fn location(source: &Value) -> Result<String, String> {
    reqwest::Url::parse(source["location"].as_str().ok_or(ERR)?)
        .map(|url| url.to_string())
        .map_err(|_| ERR.into())
}
fn template(raw: &str) -> Result<bool, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| ERR)?;
    Ok(matches!(
        url.host_str(),
        Some("example.com" | "example.org" | "example.net")
    ) || matches!(
        url.path().rsplit('/').next(),
        Some("FILENAME.m3u" | "FILENAME.m3u8")
    ))
}
/// Keep this effective document policy aligned with providerScanSources.
fn configuration(c: &Connection) -> Result<(Vec<Value>, String, bool), String> {
    PairStore::manifest_context(c, |context| {
        let canonical = context.catalog["sources"].as_array().ok_or(ERR)?;
        let providers = context.preferences["reviewedChannelProviders"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let unknown = canonical.iter().any(|s| s["kind"] != "url");
        let mut sources: Vec<Value> = canonical
            .iter()
            .filter(|s| s["kind"] == "url")
            .cloned()
            .collect();
        let mut locations: HashSet<(String, bool)> = sources
            .iter()
            .map(|s| Ok((location(s)?, s["allowHttp"] == true)))
            .collect::<Result<_, String>>()?;
        for provider in &providers {
            let raw = provider["location"].as_str().ok_or(ERR)?;
            let document = (location(provider)?, provider["allowHttp"] == true);
            if template(raw)? || locations.contains(&document) {
                continue;
            }
            if sources.len() >= 100 {
                return Err("source-cleanup-source-limit".into());
            }
            let definition = json!({"id":provider["id"],"name":provider["name"],"kind":"url","location":raw,"allowHttp":provider["allowHttp"].as_bool().unwrap_or(false)});
            source(&definition)?;
            locations.insert(document);
            sources.push(definition);
        }
        let nexus = "https://dearbulut.github.io/iptv/playlists/";
        let full: HashSet<bool> = sources
            .iter()
            .filter(|s| location(s).ok().as_deref() == Some(&format!("{nexus}index.m3u")))
            .map(|s| s["allowHttp"] == true)
            .collect();
        let mut seen = HashSet::new();
        sources.retain(|s| {
            let raw = location(s).unwrap_or_default();
            let subset = [format!("{nexus}best.m3u"), format!("{nexus}online.m3u")].contains(&raw);
            let saved = canonical.iter().any(|source| source["id"] == s["id"]);
            !(subset && !saved && full.contains(&(s["allowHttp"] == true)))
                && seen.insert((raw, s["allowHttp"] == true))
        });
        let digest = hash(&json!(["source-cleanup-config-v1", canonical, providers]))?;
        Ok((sources, digest, unknown))
    })
}
fn revisions(c: &Connection) -> Result<(i64, i64, i64), String> {
    sql(c.query_row("SELECT m.catalog_revision,m.health_revision,p.view_revision FROM metadata m CROSS JOIN catalog_projection_meta p WHERE m.singleton=1 AND p.singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))))
}
fn source_revision(c: &Connection, id: &str) -> Result<i64, String> {
    Ok(sql(c
        .query_row(
            "SELECT revision FROM source_snapshot_source WHERE source_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional())?
    .unwrap_or(0))
}
fn read_round(
    store: &PairStore,
    c: &Connection,
    id: &str,
    platform: &str,
    now: u64,
    state: i64,
) -> Result<Round, String> {
    let raw: String = sql(c
        .query_row(
            "SELECT proof FROM source_cleanup_round WHERE singleton=1 AND id=?1 AND state=?2",
            params![id, state],
            |r| r.get(0),
        )
        .optional())?
    .ok_or("source-cleanup-round-stale")?;
    let round: Round = serde_json::from_str(&raw).map_err(|_| ERR)?;
    if round.runtime != runtime(store)?
        || round.platform != platform
        || now < round.started_ms
        || now - round.started_ms > ROUND_TTL
    {
        return Err("source-cleanup-round-stale".into());
    }
    let (_, config, _) = configuration(c)?;
    if revisions(c)?.0 != round.catalog_revision || config != round.config_hash {
        return Err("source-cleanup-authority-changed".into());
    }
    Ok(round)
}
fn coverage(c: &Connection, round: &Round) -> Result<Vec<Option<i64>>, String> {
    let mut promoted = Vec::new();
    for source in &round.sources {
        let id = source.definition["id"].as_str().ok_or(ERR)?;
        let row:Option<(i64,String,String,i64,i64,String,String)>=sql(c.query_row("SELECT s.revision,s.definition,s.platform,s.refreshed_ms,t.revision,s.profile,s.permission FROM source_snapshot_source s JOIN source_snapshot_transport_state t ON t.source_id=s.source_id WHERE s.source_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional())?;
        let Some((
            revision,
            definition,
            platform,
            refreshed,
            transport_revision,
            profile,
            permission,
        )) = row
        else {
            promoted.push(None);
            continue;
        };
        let definition: Value = serde_json::from_str(&definition).map_err(|_| ERR)?;
        let grant = hash(&json!([
            "network-permission-v1",
            definition["id"],
            definition["kind"],
            definition["location"],
            definition["allowHttp"] == true,
            platform,
            profile
        ]))?;
        if revision <= source.revision
            || revision != transport_revision
            || platform != round.platform
            || !admitted_profile(&profile)
            || grant != permission
            || refreshed < round.started_ms as i64
            || crate::scan_checkpoint::source_fingerprint(&definition)?
                != crate::scan_checkpoint::source_fingerprint(&source.definition)?
        {
            promoted.push(None);
            continue;
        }
        promoted.push(Some(revision));
    }
    Ok(promoted)
}
fn event_titles(
    c: &Connection,
    source_id: &str,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<(bool, HashSet<String>), String> {
    let mut statement = sql(c.prepare("SELECT json_extract(channel,'$.name') FROM source_snapshot_entry WHERE source_id=?1 AND available=1"))?;
    let titles = sql(statement.query_map([source_id], |row| row.get::<_, String>(0)))?;
    let mut nonempty = false;
    let mut game_titles = HashSet::new();
    for title in titles {
        check()?;
        nonempty = true;
        let title = crate::scan_resume_reconcile::normalized(&sql(title)?);
        if crate::catalog::sports::has_explicit_event_tag(&title) {
            game_titles.insert(title);
        }
    }
    Ok((nonempty, game_titles))
}
fn event_expiry_allowed(c: &Connection, catalog_revision: i64) -> Result<bool, String> {
    let prior = crate::scan_checkpoint::read(c, catalog_revision)?;
    Ok(crate::scan_checkpoint::completed_replacement_identity(&prior).is_ok())
}
fn admitted_profile(profile: &str) -> bool {
    [20_000, 45_000, 60_000]
        .iter()
        .any(|budget| profile == source_snapshot_activation::profile(*budget))
}
fn transport_key(raw: &str, allow_http: bool) -> Result<String, String> {
    hash(&json!(["source-cleanup-target-v1", raw, allow_http]))
}
fn listed(c: &Connection, raw: &str, round: &Round) -> Result<bool, String> {
    let mut statement=sql(c.prepare("SELECT DISTINCT t.source_id FROM source_snapshot_transport t JOIN source_snapshot_entry e ON e.source_id=t.source_id AND e.entry_id=t.entry_id WHERE t.url_hash=?1 AND e.available=1"))?;
    let ids = sql(statement.query_map([hash(&json!(raw))?], |r| r.get::<_, String>(0)))?;
    for id in ids {
        let id = sql(id)?;
        if round.sources.iter().any(|s| s.definition["id"] == id) {
            return Ok(true);
        }
    }
    Ok(false)
}
fn replacement(c: &Connection, channel: &Value, round: &Round) -> Result<bool, String> {
    let provider = channel["providerId"].as_str().filter(|s| !s.is_empty());
    for source in &round.sources {
        let id = source.definition["id"].as_str().ok_or(ERR)?;
        if let Some(provider) = provider {
            let key = hash(&json!(["source-provider-v1", id, provider]))?;
            if sql(c.query_row("SELECT EXISTS(SELECT 1 FROM source_snapshot_entry WHERE source_id=?1 AND provider_key=?2 AND available=1)",params![id,key],|r|r.get::<_,bool>(0)))? {return Ok(true);}
        }
        // Retain a possible rotated replacement while its new transport awaits
        // checks/publication. This never merges channels or grants playback.
        let (_, metadata) = source_snapshot::identity_keys(id, channel)?;
        if sql(c.query_row("SELECT EXISTS(SELECT 1 FROM source_snapshot_entry WHERE source_id=?1 AND metadata_key=?2 AND available=1)",params![id,metadata],|r|r.get::<_,bool>(0)))? {return Ok(true);}
    }
    Ok(false)
}
#[derive(Clone)]
enum Known {
    Alive,
    Dead(Fact),
    Uncertain,
    NeedsRootCheck(u64),
    Unknown,
}
fn known(
    c: &Connection,
    source: &Value,
    channel: &Value,
    ordinal: usize,
    platform: &str,
    now: u64,
    key: &str,
) -> Result<Known, String> {
    let fingerprint = crate::health_storage::fingerprint(source, channel, ordinal)?;
    let mut statement=sql(c.prepare("SELECT source_id,target_fingerprint,platform,observer_profile,observed_at,verdict,origin,evidence_json FROM channel_health WHERE channel_id=?1 AND url_ordinal=?2"))?;
    let rows = sql(statement.query_map(
        params![channel["id"].as_str().ok_or(ERR)?, ordinal as i64],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
            ))
        },
    ))?;
    let mut latest: Option<(u64, Known)> = None;
    for row in rows {
        let (sid, fp, p, profile, at, verdict, origin, evidence) = sql(row)?;
        if sid != source["id"].as_str().ok_or(ERR)?
            || fp != fingerprint
            || p != platform
            || origin != "local"
            || at < 0
            || at as u64 > now
        {
            continue;
        }
        let at = at as u64;
        let evidence: Value = serde_json::from_str(&evidence).map_err(|_| ERR)?;
        // Invalid stored claims cannot authorize removal.
        let record = json!({"schemaVersion":1,"channelId":channel["id"],"sourceId":sid,"checkedUrlOrdinal":ordinal,"targetFingerprint":fp,"platform":p,"observerProfile":profile,"observedAt":at,"verdict":verdict,"origin":origin,"evidence":evidence});
        crate::health_storage::parse(&json!({"schemaVersion":1,"records":[record]}).to_string())?;
        if matches!(verdict.as_str(), "Reachable" | "PlayedHere") && now - at < POSITIVE_TTL {
            return Ok(Known::Alive);
        }
        if (!admitted_profile(&profile) && profile != CLEANUP_PROFILE) || now - at >= FAILURE_TTL {
            continue;
        }
        let status = evidence["status"]
            .as_u64()
            .and_then(|n| u16::try_from(n).ok());
        let value = if evidence["kind"] == "http" && matches!(status, Some(404 | 410)) {
            if profile == CLEANUP_PROFILE {
                Known::Dead(Fact {
                    key: key.into(),
                    status,
                    recognized: false,
                    observed_at: at,
                })
            } else {
                Known::NeedsRootCheck(at)
            }
        } else {
            Known::Uncertain
        };
        if latest.as_ref().is_none_or(|(old, previous)| {
            at > *old
                || at == *old
                    && matches!(
                        (&value, previous),
                        (Known::Uncertain, _) | (Known::NeedsRootCheck(_), Known::Dead(_))
                    )
        }) {
            latest = Some((at, value));
        }
    }
    Ok(latest.map_or(Known::Unknown, |(_, value)| value))
}
fn protected(preferences: &Value, id: &str) -> bool {
    ["favorites", "removedChannels"].iter().any(|field| {
        preferences[*field]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(id)))
    })
}
fn public_channel(channel: &Value) -> bool {
    channel["id"].as_str().is_some_and(|id| {
        !["account-", "archive-", "genxtra-"]
            .iter()
            .any(|p| id.starts_with(p))
    })
}
fn reply(
    c: &Connection,
    status: &'static str,
    archived: usize,
    expired_event_ids: Vec<String>,
    checked: usize,
    deferred: usize,
) -> Result<Reply, String> {
    let (catalog, health, view) = revisions(c)?;
    Ok(Reply {
        schema_version: 1,
        committed: true,
        status,
        archived_count: archived,
        expired_event_ids,
        checked_targets: checked,
        deferred_count: deferred,
        catalog_revision: catalog.to_string(),
        health_revision: health.to_string(),
        view_revision: view.to_string(),
    })
}
fn validate_request(request: &Finish) -> Result<(), String> {
    if request.schema_version != 1
        || request.round_id.len() != 64
        || !request
            .round_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ERR.into());
    }
    Ok(())
}
impl PairStore {
    pub(crate) fn check_source_cleanup(
        &self,
        prepared: &Prepared,
        platform: &str,
        now: u64,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        check()?;
        let mut c = connect_background(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let round = read_round(self, &tx, &prepared.round_id, platform, now, 1)?;
        if coverage(&tx, &round)? != prepared.promoted {
            return Err("source-cleanup-membership-changed".into());
        }
        check()
    }
    pub(crate) fn begin_source_cleanup(
        &self,
        request: &Begin,
        platform: &str,
        now: u64,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<BeginReply, String> {
        if request.schema_version != 1 || platform.is_empty() {
            return Err(ERR.into());
        }
        let expected = crate::scan_checkpoint::revision(&request.expected_catalog_revision)?;
        check()?;
        let mut c = connect_background(&self.root.join(DB), false)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        source_snapshot::ensure(&tx)?;
        ensure(&tx)?;
        if revisions(&tx)?.0 != expected {
            return Err("catalog-revision-stale".into());
        }
        let (definitions, config_hash, unknown_coverage) = configuration(&tx)?;
        let sources = definitions
            .into_iter()
            .map(|definition| {
                Ok(SourceProof {
                    revision: source_revision(&tx, definition["id"].as_str().ok_or(ERR)?)?,
                    definition,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let round = Round {
            runtime: runtime(self)?.into(),
            platform: platform.into(),
            catalog_revision: expected,
            config_hash,
            started_ms: now,
            sources,
            unknown_coverage,
        };
        let round_id = crate::scan_resume_runtime::plan_id()?;
        sql(tx.execute("INSERT INTO source_cleanup_round VALUES(1,?1,0,?2) ON CONFLICT(singleton) DO UPDATE SET id=excluded.id,state=0,proof=excluded.proof",params![round_id,serde_json::to_string(&round).map_err(|_|ERR)?]))?;
        check()?;
        sql(tx.commit())?;
        Ok(BeginReply {
            schema_version: 1,
            round_id,
            source_count: round.sources.len(),
        })
    }
    pub(crate) fn cancel_source_cleanup(
        &self,
        request: &Finish,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<CancelReply, String> {
        validate_request(request)?;
        check()?;
        let c = connect_background(&self.root.join(DB), false)?;
        ensure(&c)?;
        sql(c.execute(
            "DELETE FROM source_cleanup_round WHERE id=?1",
            [&request.round_id],
        ))?;
        Ok(CancelReply {
            schema_version: 1,
            canceled: true,
        })
    }
    pub(crate) fn prepare_source_cleanup(
        &self,
        request: &Finish,
        platform: &str,
        now: u64,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Prepared, String> {
        validate_request(request)?;
        check()?;
        let mut c = connect_background(&self.root.join(DB), false)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        ensure(&tx)?;
        let round = read_round(self, &tx, &request.round_id, platform, now, 0)?;
        let promoted = coverage(&tx, &round)?;
        let covered_sources: HashSet<_> = round
            .sources
            .iter()
            .zip(&promoted)
            .filter_map(|(source, revision)| revision.and(source.definition["id"].as_str()))
            .collect();
        let coverage_complete =
            !round.unknown_coverage && !promoted.is_empty() && promoted.iter().all(Option::is_some);
        let mut prepared = Prepared {
            round_id: request.round_id.clone(),
            round: round.clone(),
            promoted,
            candidates: Vec::new(),
            expired_event_ids: Vec::new(),
            coverage_complete,
            deferred_count: 0,
            targets: Vec::new(),
        };
        if !covered_sources.is_empty() {
            let snapshot = Self::read_connection_validated(&tx)?;
            let empty_catalog = json!({"sources":[],"channels":[]});
            let catalog = snapshot.catalog.as_ref().unwrap_or(&empty_catalog);
            let preferences = snapshot.preferences.as_ref().ok_or(ERR)?;
            let sources: HashMap<&str, &Value> = catalog["sources"]
                .as_array()
                .ok_or(ERR)?
                .iter()
                .map(|s| Ok((s["id"].as_str().ok_or(ERR)?, s)))
                .collect::<Result<_, String>>()?;
            let mut keys = HashSet::new();
            let mut titles_by_source = HashMap::new();
            let can_expire_events = event_expiry_allowed(&tx, round.catalog_revision)?;
            for channel in catalog["channels"].as_array().ok_or(ERR)? {
                check()?;
                let id = channel["id"].as_str().ok_or(ERR)?;
                if !public_channel(channel) || protected(preferences, id) {
                    continue;
                }
                let source_id = channel["sourceId"].as_str().ok_or(ERR)?;
                let source = sources.get(source_id).ok_or(ERR)?;
                if source["kind"] != "url" {
                    continue;
                }
                let name = channel["name"].as_str().ok_or(ERR)?;
                if crate::scan_resume_reconcile::game_listing(channel)
                    && crate::catalog::sports::has_explicit_event_tag(name)
                {
                    if can_expire_events && covered_sources.contains(source_id) {
                        let (nonempty, titles) = match titles_by_source.entry(source_id) {
                            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                            std::collections::hash_map::Entry::Vacant(entry) => {
                                entry.insert(event_titles(&tx, source_id, &mut check)?)
                            }
                        };
                        // Empty lists cannot establish absence. Match the title so
                        // a shared guide ID or a recycled URL cannot retain an old game.
                        let title = crate::scan_resume_reconcile::normalized(name);
                        if *nonempty && !titles.contains(&title) {
                            if prepared.expired_event_ids.len() == CANDIDATE_LIMIT {
                                prepared.deferred_count += 1;
                            } else {
                                prepared.expired_event_ids.push(id.into());
                            }
                        }
                    }
                    continue;
                }
                if !prepared.coverage_complete {
                    continue;
                }
                let urls = channel["urls"].as_array().ok_or(ERR)?;
                let mut is_listed = urls.is_empty();
                for url in urls {
                    if listed(&tx, url.as_str().ok_or(ERR)?, &round)? {
                        is_listed = true;
                        break;
                    }
                }
                if is_listed || replacement(&tx, channel, &round)? {
                    continue;
                }
                let mut target_rows = Vec::new();
                let mut unknown = Vec::new();
                let mut retain = false;
                for (ordinal, url) in urls.iter().enumerate() {
                    let raw = url.as_str().ok_or(ERR)?;
                    let key = transport_key(raw, source["allowHttp"] == true)?;
                    let cached = match known(&tx, source, channel, ordinal, platform, now, &key)? {
                        Known::Alive | Known::Uncertain => {
                            retain = true;
                            break;
                        }
                        Known::Dead(fact) => Some(fact),
                        Known::NeedsRootCheck(_) | Known::Unknown => {
                            unknown.push(Target {
                                key: key.clone(),
                                url: raw.into(),
                                allow_http: source["allowHttp"] == true,
                            });
                            None
                        }
                    };
                    target_rows.push(CandidateTarget {
                        key,
                        ordinal,
                        fingerprint: crate::health_storage::fingerprint(source, channel, ordinal)?,
                        cached,
                    });
                }
                if retain {
                    continue;
                }
                if prepared.candidates.len() == CANDIDATE_LIMIT {
                    prepared.deferred_count += 1;
                    continue;
                }
                for target in unknown {
                    if keys.insert(target.key.clone()) {
                        prepared.targets.push(target);
                    }
                }
                prepared.candidates.push(Candidate {
                    id: id.into(),
                    source_id: source_id.into(),
                    targets: target_rows,
                });
            }
        }
        if sql(tx.execute(
            "UPDATE source_cleanup_round SET state=1 WHERE id=?1 AND state=0",
            [&request.round_id],
        ))? != 1
        {
            return Err("source-cleanup-round-stale".into());
        }
        check()?;
        sql(tx.commit())?;
        Ok(prepared)
    }
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn commit_source_cleanup(
        &self,
        prepared: &Prepared,
        facts: &[Fact],
        platform: &str,
        now: u64,
        checked_targets: usize,
        budget_exhausted: bool,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Reply, String> {
        check()?;
        if facts.len() > 256 || checked_targets > 256 {
            return Err(ERR.into());
        }
        let mut c = connect_background(&self.root.join(DB), false)?;
        self.backup_with_check(&c, &mut check)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let round = read_round(self, &tx, &prepared.round_id, platform, now, 1)?;
        if round.config_hash != prepared.round.config_hash {
            return Err("source-cleanup-authority-changed".into());
        }
        let coverage = coverage(&tx, &round)?;
        if coverage != prepared.promoted {
            return Err("source-cleanup-membership-changed".into());
        }
        if !prepared.coverage_complete && prepared.expired_event_ids.is_empty() {
            sql(tx.execute(
                "DELETE FROM source_cleanup_round WHERE id=?1",
                [&prepared.round_id],
            ))?;
            let result = reply(
                &tx,
                "coverage-incomplete",
                0,
                Vec::new(),
                checked_targets,
                prepared.deferred_count,
            )?;
            check()?;
            sql(tx.commit())?;
            return Ok(result);
        }
        let allowed: HashSet<&str> = prepared.targets.iter().map(|t| t.key.as_str()).collect();
        let mut observed = HashMap::new();
        for fact in facts {
            if !allowed.contains(fact.key.as_str())
                || fact.observed_at < round.started_ms
                || fact.observed_at > now
                || fact.status.is_some_and(|n| !(100..=599).contains(&n))
                || fact.recognized && fact.status.is_none_or(|n| !(200..300).contains(&n))
                || observed.insert(fact.key.as_str(), fact).is_some()
            {
                return Err(ERR.into());
            }
        }
        let snapshot = Self::read_connection_validated(&tx)?;
        let empty_catalog = json!({"sources":[],"channels":[]});
        let catalog = snapshot.catalog.as_ref().unwrap_or(&empty_catalog);
        let mut preferences = snapshot.preferences.clone().ok_or(ERR)?;
        let channels: HashMap<&str, &Value> = catalog["channels"]
            .as_array()
            .ok_or(ERR)?
            .iter()
            .map(|ch| Ok((ch["id"].as_str().ok_or(ERR)?, ch)))
            .collect::<Result<_, String>>()?;
        let sources: HashMap<&str, &Value> = catalog["sources"]
            .as_array()
            .ok_or(ERR)?
            .iter()
            .map(|s| Ok((s["id"].as_str().ok_or(ERR)?, s)))
            .collect::<Result<_, String>>()?;
        let mut archived = Vec::new();
        let mut expired_events = Vec::new();
        let mut deferred = prepared.deferred_count;
        if !prepared.expired_event_ids.is_empty() {
            if event_expiry_allowed(&tx, round.catalog_revision)? {
                for id in &prepared.expired_event_ids {
                    check()?;
                    if !protected(&preferences, id) {
                        expired_events.push(id.clone());
                    }
                }
            } else {
                deferred += prepared.expired_event_ids.len();
            }
        }
        let mut incoming = Vec::new();
        for candidate in &prepared.candidates {
            check()?;
            let channel = channels
                .get(candidate.id.as_str())
                .ok_or("source-cleanup-target-changed")?;
            let source = sources
                .get(candidate.source_id.as_str())
                .ok_or("source-cleanup-target-changed")?;
            let mut dead = !protected(&preferences, &candidate.id)
                && public_channel(channel)
                && !replacement(&tx, channel, &round)?;
            for target in &candidate.targets {
                let raw = channel["urls"][target.ordinal].as_str().ok_or(ERR)?;
                if transport_key(raw, source["allowHttp"] == true)? != target.key
                    || crate::health_storage::fingerprint(source, channel, target.ordinal)?
                        != target.fingerprint
                {
                    return Err("source-cleanup-target-changed".into());
                }
                let current = known(
                    &tx,
                    source,
                    channel,
                    target.ordinal,
                    platform,
                    now,
                    &target.key,
                )?;
                let fact = observed
                    .get(target.key.as_str())
                    .copied()
                    .or(target.cached.as_ref());
                // A prepared cache is not authority after its current record
                // disappears or a newer ambiguous resource failure replaces it.
                // A new root check must also be newer than that ambiguity.
                let cached_still_current = observed.contains_key(target.key.as_str())
                    || matches!(&current, Known::Dead(live) if target.cached.as_ref().is_some_and(|cached| live.observed_at >= cached.observed_at));
                let newer_ambiguous = matches!(&current, Known::NeedsRootCheck(at) if fact.is_none_or(|f| *at >= f.observed_at));
                if listed(&tx, raw, &round)?
                    || matches!(current, Known::Alive | Known::Uncertain)
                    || !cached_still_current
                    || newer_ambiguous
                {
                    dead = false;
                }
                if fact.is_none_or(|f| {
                    !matches!(f.status, Some(404 | 410))
                        || now.saturating_sub(f.observed_at) >= FAILURE_TTL
                }) {
                    dead = false;
                }
                if let Some(fact) = observed.get(target.key.as_str()).copied() {
                    let (verdict, evidence) = match fact.status {
                        Some(status) => (
                            if (200..300).contains(&status) && fact.recognized {
                                "Reachable"
                            } else if matches!(status, 401 | 403 | 451) {
                                "AccessDenied"
                            } else if status >= 400 {
                                "TemporaryUnavailable"
                            } else {
                                "NotChecked"
                            },
                            json!({"kind":"http","status":status,"contentRecognized":fact.recognized}),
                        ),
                        None => ("TemporaryUnavailable", json!({"kind":"network-failure"})),
                    };
                    incoming.push(json!({"schemaVersion":1,"channelId":candidate.id,"sourceId":candidate.source_id,"checkedUrlOrdinal":target.ordinal,"targetFingerprint":target.fingerprint,"platform":platform,"observerProfile":CLEANUP_PROFILE,"observedAt":fact.observed_at,"verdict":verdict,"origin":"local","evidence":evidence}));
                }
            }
            if dead {
                archived.push(candidate.id.clone());
            } else {
                deferred += 1;
            }
        }
        let removed = preferences
            .as_object_mut()
            .ok_or(ERR)?
            .entry("removedChannels")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or(ERR)?;
        if removed.len() + archived.len() > 100000 {
            return Err("source-cleanup-preference-limit".into());
        }
        removed.extend(archived.iter().map(|id| json!(id)));
        let updated_catalog = if expired_events.is_empty() {
            None
        } else {
            let expired: HashSet<&str> = expired_events.iter().map(String::as_str).collect();
            let mut updated = catalog.clone();
            updated["channels"]
                .as_array_mut()
                .ok_or(ERR)?
                .retain(|channel| {
                    channel["id"]
                        .as_str()
                        .is_none_or(|id| !expired.contains(id))
                });
            Some(updated.to_string())
        };
        let records = RecordPair {
            catalog: updated_catalog,
            preferences: if archived.is_empty() {
                None
            } else {
                Some(preferences.to_string())
            },
        };
        let health = if incoming.is_empty() {
            None
        } else {
            Some(json!({"schemaVersion":1,"records":incoming}).to_string())
        };
        if let Some(health) = health.as_ref() {
            crate::health_storage::parse(health)?;
        }
        let (cr, hr, _) = revisions(&tx)?;
        if records.catalog.is_some() || records.preferences.is_some() || health.is_some() {
            let validated = validate(&records)?;
            Self::apply_scan_transaction(
                &tx,
                &records,
                health.as_deref(),
                (Some(cr), Some(hr)),
                None,
                PairReuse {
                    validated,
                    before: Some(snapshot),
                    projection_ids: None,
                    health_groups: None,
                    observer: None,
                },
                &mut |phase| {
                    if phase == Phase::AfterCommit {
                        Ok(())
                    } else {
                        check()
                    }
                },
            )?;
        }
        sql(tx.execute(
            "DELETE FROM source_cleanup_round WHERE id=?1",
            [&prepared.round_id],
        ))?;
        let result = reply(
            &tx,
            if budget_exhausted {
                "budget-exhausted"
            } else {
                "completed"
            },
            archived.len(),
            expired_events,
            checked_targets,
            deferred,
        )?;
        check()?;
        sql(tx.commit())?;
        Ok(result)
    }
}

#[cfg(test)]
#[path = "source_cleanup_tests.rs"]
mod tests;
