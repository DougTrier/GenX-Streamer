//! Private indexed activation. Only selected due metadata enters CP3; exact URLs
//! are reread in bounded pages and protected by the retained native owner.
use super::*;
use crate::scan_candidate_manifest::{Append, Begin, Header, PreparedPage, Seal};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
const ERR: &str = "source-activation-invalid";
/// A stream that answered is trusted for a week by scans (owner decision,
/// October 19, 2026); saved channels are rechecked daily by the quiet channel
/// check instead, so a dead saved channel still surfaces. Full recheck ignores this.
pub(crate) const POSITIVE_TTL: u64 = 7 * 86_400_000;
/// A stream that failed is not checked again by Refresh for a while (owner
/// decision, October 21, 2026: "a refresh should not have to touch every
/// channel"). A definite answer from its server (not found or gone, access
/// denied, unsupported content) is trusted for a week, like a working stream;
/// no answer (a timeout, a network failure, a busy server or a 5xx) only for a
/// day, since the device's own connection may have been the cause. Rescan
/// (full recheck) ignores both.
pub(crate) const DEFINITE_FAILURE_TTL: u64 = 7 * 86_400_000;
pub(crate) const NO_ANSWER_TTL: u64 = 86_400_000;
/// True for a stored failed check that is a definite answer from the server.
/// The evidence is the health record written by the check (health_storage).
pub(crate) const DEFINITE_FAILURE: &str = "(check_verdict IN('AccessDenied','UnsupportedHere') OR (check_verdict='TemporaryUnavailable' AND json_extract(evidence,'$.records[0].evidence.kind')='http' AND json_extract(evidence,'$.records[0].evidence.status') BETWEEN 400 AND 499 AND json_extract(evidence,'$.records[0].evidence.status') NOT IN(408,425,429)))";
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceRevision {
    pub source_id: String,
    pub source_revision: String,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Mode {
    Refresh,
    FullRecheck,
    /// The Slow list: only streams the 3-second triage of a recent scan left
    /// unanswered, checked again with a full time limit. Sources are not read.
    Slow,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub schema_version: u8,
    pub sources: Vec<SourceRevision>,
    pub query: String,
    pub preferred_region: Option<Value>,
    pub budget_ms: u64,
    pub mode: Mode,
    pub expected_catalog_revision: String,
    pub expected_checkpoint_revision: String,
    /// Published channel IDs (no feed suffix) whose alternate names match `query`.
    /// Admission/order hints only; never identity, merge or publication authority.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alias_provider_ids: Vec<String>,
    /// Closed, replaced, blocklisted or adult channel IDs: checked last, never removed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub demoted_provider_ids: Vec<String>,
}
pub(crate) const ALIAS_HINT_LIMIT: usize = 5_000;
pub(crate) const DEMOTED_HINT_LIMIT: usize = 50_000;
pub(crate) struct Prepared {
    pub header: Option<Header>,
    pub request: Request,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reply {
    pub schema_version: u8,
    pub job_id: Option<String>,
    pub review_digest: Option<String>,
    pub candidate_count: usize,
    pub catalog_revision: String,
    pub checkpoint_revision: String,
}
fn hash(v: &Value) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(v).map_err(|_| ERR)?)
    ))
}
fn packed_hash(v: &Value) -> Result<String, String> {
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(serde_json::to_vec(v).map_err(|_| ERR)?)))
}
fn slot(v: Option<&Value>) -> Value {
    Value::Array(v.into_iter().cloned().collect())
}
// Match the shared region ordering across the complete selected collection.
// Declared geography only; unknown and distant candidates remain admitted.
fn region_priority(channel: &Value, preferred: Option<&Value>) -> u8 {
    let Some(preferred) = preferred else {
        return 3;
    };
    let Some(country) = channel["geography"]["country"].as_str() else {
        return 3;
    };
    if preferred["state"]
        .as_str()
        .is_some_and(|state| channel["geography"]["state"].as_str() == Some(state))
    {
        0
    } else if preferred["country"].as_str() == Some(country) {
        1
    } else {
        2
    }
}
fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}
/// 0 exact name, 1 name prefix, 2 every query word starts a name word (or a
/// published alternate name matched), 3 any other admitted match.
pub(crate) fn relevance_tier(query: &str, name: &str, alias_hit: bool) -> u8 {
    let key = query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if key.is_empty() {
        return 3;
    }
    let name = name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if name == key {
        return 0;
    }
    if name.starts_with(&key) {
        return 1;
    }
    let tokens = words(&key);
    let name_words = words(&name);
    if alias_hit
        || (!tokens.is_empty()
            && tokens
                .iter()
                .all(|t| name_words.iter().any(|w| w.starts_with(t.as_str()))))
    {
        return 2;
    }
    3
}
/// Demoted channels sort after every other tier; within a tier, region order.
pub(crate) fn activation_priority(tier: u8, region: u8, demoted: bool) -> u8 {
    u8::from(demoted) * 64 + tier * 4 + region
}
/// Rebuild the category table in first-use order of the (re)ordered candidates
/// and rewrite each packed candidate's category index (tuple slot 4).
pub(crate) fn renumber_categories(
    candidates: &mut [Value],
    categories: &[Value],
) -> Result<Vec<Value>, String> {
    let mut remap = HashMap::<usize, usize>::new();
    let mut ordered = Vec::with_capacity(categories.len());
    for candidate in candidates.iter_mut() {
        let old = candidate[4]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n < categories.len())
            .ok_or(ERR)?;
        let new = *remap.entry(old).or_insert_with(|| {
            ordered.push(categories[old].clone());
            ordered.len() - 1
        });
        candidate[4] = json!(new);
    }
    if ordered.len() != categories.len() {
        return Err(ERR.into());
    }
    Ok(ordered)
}
/// Entries due for a check (?3 forces a full recheck; ?4..?8 are now, grant and
/// the cut-offs: working, definite failure, no answer). ?9 and ?10 are the
/// grants of longer check times: a check that waited longer is as current.
fn due() -> String {
    format!("(?3 OR checked_content_hash IS NULL OR checked_content_hash<>content_hash OR check_ms IS NULL OR check_permission IS NULL OR check_address IS NULL OR check_verdict IS NULL OR check_ms>?4 OR check_permission NOT IN(?5,?9,?10) OR check_address<>address_hash OR (check_verdict IN('Reachable','PlayedHere') AND check_ms<=?6) OR (check_verdict NOT IN('Reachable','PlayedHere') AND check_ms<=CASE WHEN {DEFINITE_FAILURE} THEN ?7 ELSE ?8 END))")
}
/// A stream on the Slow list: its newest check (with the triage grant ?5, at
/// most a no-answer window old) found no answer within 3 seconds.
pub(crate) const SLOW_LISTED: &str = "(NOT ?3 AND check_verdict='TimedOut' AND json_extract(evidence,'$.records[0].evidence.kind')='slow' AND check_permission=?5 AND check_address=address_hash AND checked_content_hash=content_hash AND check_ms<=?4 AND check_ms>?8 AND ?6 IS NOT NULL AND ?7 IS NOT NULL AND ?9 IS NOT NULL AND ?10 IS NOT NULL)";
/// The observer profile of a check time; part of every check's grant.
pub(crate) fn profile(budget_ms: u64) -> String {
    format!("reachability-v3/native-media-resources-v1/max-{budget_ms}/sequential")
}
/// Check times longer than `budget_ms`, repeated to fill both slots.
fn longer(budget_ms: u64) -> [u64; 2] {
    match budget_ms {
        20_000 => [45_000, 60_000],
        45_000 => [60_000, 60_000],
        b => [b, b],
    }
}
/// Address hashes of a source's entries whose check is still current.
pub(crate) fn checked_streams(
    c: &Connection,
    source_id: &str,
    grants: &[String; 3],
    now: u64,
) -> Result<Vec<String>, String> {
    let mut statement = sql(c.prepare(&format!(
        "SELECT address_hash FROM source_snapshot_entry WHERE source_id=?1 AND available=1 AND ordinal>?2 AND NOT {}",
        due()
    )))?;
    let rows = sql(statement.query_map(
        params![
            source_id,
            -1i64,
            false,
            now as i64,
            grants[0],
            now.saturating_sub(POSITIVE_TTL) as i64,
            now.saturating_sub(DEFINITE_FAILURE_TTL) as i64,
            now.saturating_sub(NO_ANSWER_TTL) as i64,
            grants[1],
            grants[2]
        ],
        |r| r.get::<_, String>(0),
    ))?;
    rows.map(sql).collect()
}
fn hint_id(value: &str) -> &str {
    value.split('@').next().unwrap_or(value)
}
fn tuple(c: &Value, urls: Value) -> Value {
    let geography = c
        .get("geography")
        .map(|g| {
            json!([
                g.get("country").unwrap_or(&Value::Null),
                g.get("region").unwrap_or(&Value::Null),
                g.get("state").unwrap_or(&Value::Null)
            ])
        })
        .unwrap_or(Value::Null);
    let provenance = c
        .get("geographyProvenance")
        .and_then(Value::as_array)
        .map(|a| {
            json!(a
                .iter()
                .map(|p| json!([
                    p["field"],
                    p["value"],
                    p["sourceId"],
                    p.get("providerId").unwrap_or(&Value::Null),
                    p["kind"],
                    p["scope"]
                ]))
                .collect::<Vec<_>>())
        })
        .unwrap_or(Value::Null);
    json!([
        c["sourceId"],
        c.get("providerId").unwrap_or(&Value::Null),
        c["name"],
        c["category"],
        urls,
        geography,
        provenance
    ])
}
fn candidate(c: &Value, key: &str, source: usize, category: usize) -> Result<Value, String> {
    let fields = ["country", "region", "state"];
    let geo = c
        .get("geography")
        .map(|g| json!(fields.map(|f| slot(g.get(f)))));
    let provenance = c
        .get("geographyProvenance")
        .map(|a| -> Result<Value, String> {
            Ok(json!(a
                .as_array()
                .ok_or(ERR)?
                .iter()
                .map(|p| -> Result<Value, String> {
                    Ok(json!([
                        fields.iter().position(|f| p["field"] == *f).ok_or(ERR)?,
                        p["value"],
                        slot(p.get("providerId")),
                        (["provider", "m3u", "registry", "user"]
                            .iter()
                            .position(|f| p["kind"] == *f)
                            .ok_or(ERR)?),
                        ([
                            "channel-origin",
                            "provider-declared",
                            "country-group",
                            "user-reviewed"
                        ]
                        .iter()
                        .position(|f| p["scope"] == *f)
                        .ok_or(ERR)?)
                    ]))
                })
                .collect::<Result<Vec<_>, _>>()?))
        })
        .transpose()?;
    let urls = c["urls"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 16)
        .ok_or(ERR)?;
    Ok(json!([
        key,
        source,
        slot(c.get("providerId")),
        c["name"],
        category,
        slot(geo.as_ref()),
        slot(provenance.as_ref()),
        packed_hash(&tuple(c, json!(urls)))?,
        urls.iter()
            .map(packed_hash)
            .collect::<Result<Vec<_>, _>>()?
    ]))
}
fn source_fences(c: &Connection, request: &Request) -> Result<Vec<Value>, String> {
    let mut seen = HashSet::new();
    request
        .sources
        .iter()
        .map(|s| {
            if s.source_id.is_empty() || s.source_id.len() > 256 || !seen.insert(&s.source_id) {
                return Err(ERR.into());
            }
            let (revision, definition): (i64, String) = sql(c.query_row(
                "SELECT revision,definition FROM source_snapshot_source WHERE source_id=?1",
                [&s.source_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ))?;
            if revision != crate::scan_checkpoint::revision(&s.source_revision)? {
                return Err("source-snapshot-revision-stale".into());
            }
            let definition: Value = serde_json::from_str(&definition).map_err(|_| ERR)?;
            source(&definition)?;
            if definition["id"] != s.source_id {
                return Err(ERR.into());
            }
            Ok(definition)
        })
        .collect()
}
fn validate_request(request: &Request) -> Result<(), String> {
    if request.schema_version != 1
        || request.sources.is_empty()
        || request.sources.len() > 100
        || request.query.len() > 256
        || request.query.chars().any(char::is_control)
        || !matches!(request.budget_ms, 20000 | 45000 | 60000)
        // The Slow pass is the full-time check of streams the triage skipped.
        || (matches!(request.mode, Mode::Slow) && request.budget_ms == 20000)
        || request.alias_provider_ids.len() > ALIAS_HINT_LIMIT
        || request.demoted_provider_ids.len() > DEMOTED_HINT_LIMIT
        || request
            .alias_provider_ids
            .iter()
            .chain(&request.demoted_provider_ids)
            .any(|id| {
                id.is_empty()
                    || id.len() > 256
                    || id.contains('@')
                    || id.chars().any(char::is_control)
            })
        || (request.query.trim().is_empty() && !request.alias_provider_ids.is_empty())
    {
        return Err(ERR.into());
    }
    Ok(())
}
impl PairStore {
    pub(crate) fn prepare_source_snapshot_activation(
        &self,
        request: Request,
        platform: &str,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Prepared, String> {
        validate_request(&request)?;
        check()?;
        let mut c = connect_background(&self.root.join(DB), false)?;
        self.backup_with_check(&c, &mut check)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        super::source_snapshot::ensure(&tx)?;
        let definitions = source_fences(&tx, &request)?;
        let job = crate::scan_resume_runtime::plan_id()?;
        let profile = profile(request.budget_ms);
        sql(tx.execute_batch("CREATE TABLE IF NOT EXISTS source_activation_row(manifest_id TEXT NOT NULL REFERENCES scan_manifest(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,source_id TEXT NOT NULL,entry_id TEXT NOT NULL,source_revision TEXT NOT NULL,PRIMARY KEY(manifest_id,ordinal));"))?;
        // Temporary native SQL rows hold references only, never another URL graph.
        sql(tx.execute_batch("CREATE TEMP TABLE source_activation_selected(ordinal INTEGER PRIMARY KEY,source_id TEXT NOT NULL,entry_id TEXT NOT NULL,source_revision TEXT NOT NULL,priority INTEGER NOT NULL);"))?;
        let header = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::check_cas(
                context,
                &request.expected_catalog_revision,
                &request.expected_checkpoint_revision,
            )?;
            if request.preferred_region.as_ref() != context.preferences.get("preferredRegion") {
                return Err("scan-checkpoint-policy-stale".into());
            }
            let prior = crate::scan_checkpoint::read(&tx, context.catalog_revision)?;
            let allow_unfinished = matches!(request.mode, Mode::FullRecheck);
            if allow_unfinished {
                crate::scan_checkpoint::full_recheck_replacement_identity(
                    &prior,
                    context.now,
                    &mut check,
                )?;
            } else {
                crate::scan_checkpoint::completed_replacement_identity(&prior)?;
            }
            let mut candidates = Vec::new();
            let mut categories = Vec::new();
            let mut category_index = HashMap::<String, usize>::new();
            let mut review_sources = Vec::new();
            let mut source_definitions = Vec::new();
            let mut total = 0usize;
            let mut packed_bytes = 0usize;
            // Published playlists often mirror each other. A stream (exact ordered
            // URL list, the stored address hash) is checked once per job: the first
            // due occurrence in configured source/entry order. A stream with a
            // current check in any requested source is not checked again.
            let mut streams = HashSet::<String>::new();
            let grant_with = |definition: &Value, profile: &str| {
                hash(&json!([
                    "network-permission-v1",
                    definition["id"],
                    definition["kind"],
                    definition["location"],
                    definition["allowHttp"].as_bool().unwrap_or(false),
                    platform,
                    profile
                ]))
            };
            // The current grant and those of longer check times. The Slow pass
            // selects by the grant of the triaged (20-second) scans instead.
            let grant_for = |definition: &Value| -> Result<[String; 3], String> {
                if matches!(request.mode, Mode::Slow) {
                    let triage = grant_with(definition, &self::profile(20_000))?;
                    return Ok([triage.clone(), triage.clone(), triage]);
                }
                let [a, b] = longer(request.budget_ms);
                Ok([
                    grant_with(definition, &profile)?,
                    grant_with(definition, &self::profile(a))?,
                    grant_with(definition, &self::profile(b))?,
                ])
            };
            if matches!(request.mode, Mode::Refresh) {
                for (s, definition) in request.sources.iter().zip(&definitions) {
                    check()?;
                    streams.extend(checked_streams(
                        &tx,
                        &s.source_id,
                        &grant_for(definition)?,
                        context.now,
                    )?);
                }
            }
            for (source_index, (s, definition)) in
                request.sources.iter().zip(&definitions).enumerate()
            {
                check()?;
                let definition_fingerprint =
                    crate::scan_checkpoint::source_fingerprint(definition)?;
                let saved = context.catalog["sources"]
                    .as_array()
                    .ok_or(ERR)?
                    .iter()
                    .find(|source| source["id"] == s.source_id);
                if let Some(saved) = saved {
                    if crate::scan_checkpoint::source_fingerprint(saved)? != definition_fingerprint
                    {
                        return Err("source-snapshot-source-refused".into());
                    }
                } else if definition["kind"] != "url"
                    || !context.preferences["reviewedChannelProviders"]
                        .as_array()
                        .is_some_and(|providers| {
                            providers.iter().any(|p| {
                                p["location"] == definition["location"]
                                    && p["allowHttp"].as_bool().unwrap_or(false)
                                        == definition["allowHttp"].as_bool().unwrap_or(false)
                            })
                        })
                {
                    return Err("source-snapshot-source-refused".into());
                }
                source_definitions.push(
                    json!({"source":definition,"definitionFingerprint":definition_fingerprint}),
                );
                let grants = grant_for(definition)?;
                let selection = if matches!(request.mode, Mode::Slow) {
                    SLOW_LISTED.to_owned()
                } else {
                    due()
                };
                let fingerprint = hash(&json!([
                    "source-index-revision-v1",
                    definition_fingerprint,
                    s.source_revision
                ]))?;
                let mut after = -1i64;
                let mut inspected = 0usize;
                let mut matched = 0usize;
                let alias_ids: std::collections::HashSet<&str> = request
                    .alias_provider_ids
                    .iter()
                    .map(String::as_str)
                    .collect();
                let demoted_ids: std::collections::HashSet<&str> = request
                    .demoted_provider_ids
                    .iter()
                    .map(String::as_str)
                    .collect();
                loop {
                    check()?;
                    let mut statement=sql(tx.prepare(&format!("SELECT entry_id,ordinal,channel,address_hash FROM source_snapshot_entry WHERE source_id=?1 AND available=1 AND ordinal>?2 AND {selection} ORDER BY ordinal LIMIT 64")))?;
                    let rows = sql(statement.query_map(
                        params![
                            s.source_id,
                            after,
                            matches!(request.mode, Mode::FullRecheck),
                            context.now as i64,
                            grants[0],
                            context.now.saturating_sub(POSITIVE_TTL) as i64,
                            context.now.saturating_sub(DEFINITE_FAILURE_TTL) as i64,
                            context.now.saturating_sub(NO_ANSWER_TTL) as i64,
                            grants[1],
                            grants[2]
                        ],
                        |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, i64>(1)?,
                                r.get::<_, String>(2)?,
                                r.get::<_, String>(3)?,
                            ))
                        },
                    ))?;
                    let mut count = 0;
                    for row in rows {
                        check()?;
                        let (entry, ordinal, raw, address) = sql(row)?;
                        if raw.len() > 1024 * 1024 || ordinal < 0 || ordinal >= 100000 {
                            return Err(ERR.into());
                        }
                        count += 1;
                        after = ordinal;
                        inspected += 1;
                        total += 1;
                        if total > 100000 {
                            return Err("scan-checkpoint-too-large".into());
                        }
                        let channel: Value = serde_json::from_str(&raw).map_err(|_| ERR)?;
                        let provider = channel
                            .get("providerId")
                            .and_then(Value::as_str)
                            .map(hint_id);
                        let alias_hit = provider.is_some_and(|p| alias_ids.contains(p));
                        if !alias_hit
                            && !crate::catalog_query::matches_scan_channel(
                                &channel,
                                &request.query,
                                context.preferences.get("preferredRegion"),
                            )?
                        {
                            continue;
                        }
                        if !streams.insert(address) {
                            continue;
                        }
                        let category = channel["category"].as_str().ok_or(ERR)?.to_owned();
                        let next = categories.len();
                        let ci = *category_index.entry(category.clone()).or_insert_with(|| {
                            categories.push(json!(category));
                            next
                        });
                        // Index identity is private and never becomes canonical identity.
                        let key = hash(&json!(["source-index-candidate-v1", s.source_id, entry]))?;
                        let packed = candidate(&channel, &key, source_index, ci)?;
                        packed_bytes = packed_bytes
                            .checked_add(
                                serde_json::to_vec(&packed).map_err(|_| ERR)?.len()
                                    + category.len()
                                    + 2,
                            )
                            .ok_or("scan-checkpoint-too-large")?;
                        if packed_bytes > 20 * 1024 * 1024 - 256 * 1024 {
                            return Err("scan-checkpoint-too-large".into());
                        }
                        let priority = activation_priority(
                            relevance_tier(
                                &request.query,
                                channel["name"].as_str().ok_or(ERR)?,
                                alias_hit,
                            ),
                            region_priority(&channel, context.preferences.get("preferredRegion")),
                            provider.is_some_and(|p| demoted_ids.contains(p)),
                        );
                        candidates.push((priority, packed));
                        sql(tx.execute(
                            "INSERT INTO source_activation_selected VALUES(?1,?2,?3,?4,?5)",
                            params![
                                candidates.len() as i64 - 1,
                                s.source_id,
                                entry,
                                s.source_revision,
                                priority
                            ],
                        ))?;
                        matched += 1;
                    }
                    if count < 64 {
                        break;
                    }
                }
                review_sources.push(json!({"sourceId":s.source_id,"fingerprint":fingerprint,"status":"completed","inspected":inspected,"matched":matched,"warnings":0}));
            }
            if candidates.is_empty() {
                if allow_unfinished
                    && crate::scan_checkpoint::completed_replacement_identity(&prior)
                        .is_err_and(|e| e == "scan-checkpoint-continue-required")
                {
                    return Err("scan-checkpoint-full-recheck-empty".into());
                }
                return Ok(None);
            }
            // Stable sort retains configured source/entry order within each rank.
            // SQL applies the identical order to the URL references, so packed
            // metadata and protected pages keep the same original indices.
            candidates.sort_by_key(|(priority, _)| *priority);
            let mut candidates: Vec<Value> =
                candidates.into_iter().map(|(_, value)| value).collect();
            // The packed checkpoint requires category indices in first-use order;
            // reordering candidates must renumber the table to match.
            categories = renumber_categories(&mut candidates, &categories)?;
            let mut seed = json!({"schemaVersion":3,"jobId":job,"createdAtMs":context.now,"catalogRevision":request.expected_catalog_revision,"sourceDefinitions":source_definitions,"budgetMs":request.budget_ms,"platform":platform,"observerProfile":profile,"review":{"sessionRevision":job,"query":request.query,"status":"completed","sources":review_sources,"counts":{"inspected":total,"matched":candidates.len(),"failedSources":0,"canceledSources":0},"candidates":candidates},"categoryTable":categories,"observations":[],"publishedIndices":[]});
            if let Some(region) = context.preferences.get("preferredRegion") {
                seed["preferredRegion"] = region.clone();
            }
            seed["policyFingerprint"] = json!(crate::scan_checkpoint::policy_fingerprint(
                &seed,
                context.preferences
            )?);
            let review = &seed["review"];
            let counts = &review["counts"];
            seed["reviewDigest"] = json!(hash(&json!([
                "genx-scan-reference-v3",
                seed["categoryTable"],
                review["sessionRevision"],
                review["query"],
                review["status"],
                review["sources"]
                    .as_array()
                    .ok_or(ERR)?
                    .iter()
                    .map(|s| json!([
                        s["sourceId"],
                        s["fingerprint"],
                        s["status"],
                        s["inspected"],
                        s["matched"],
                        s["warnings"]
                    ]))
                    .collect::<Vec<_>>(),
                [
                    &counts["inspected"],
                    &counts["matched"],
                    &counts["failedSources"],
                    &counts["canceledSources"]
                ],
                review["candidates"]
            ]))?);
            let checkpoint = serde_json::to_string(&seed).map_err(|_| ERR)?;
            if checkpoint.len() > 20 * 1024 * 1024 {
                return Err("scan-checkpoint-too-large".into());
            }
            crate::scan_checkpoint::ensure(&tx)?;
            // Explicit replacement admission retains prior checkpoint authority
            // and binds the new stage to its exact prior job/digest/revision.
            let begin = Begin {
                schema_version: 1,
                checkpoint,
                expected_catalog_revision: request.expected_catalog_revision.clone(),
                expected_checkpoint_revision: request.expected_checkpoint_revision.clone(),
            };
            let result = if allow_unfinished {
                crate::scan_candidate_manifest::begin_full_recheck_replacement(
                    &tx, &begin, context, &mut check,
                )
            } else {
                crate::scan_candidate_manifest::begin_replacement(&tx, &begin, context, &mut check)
            }?;
            sql(tx.execute("INSERT INTO source_activation_row SELECT ?1,ROW_NUMBER() OVER(ORDER BY priority,ordinal)-1,source_id,entry_id,source_revision FROM source_activation_selected",[&result.manifest_id]))?;
            Ok(Some(result))
        })?;
        if header.is_some() {
            // This optional access path is created only by the existing checked
            // activation writer, after both known namespaces have been admitted.
            crate::scan_candidate_manifest::activation_guard::install_index(&tx)?;
        }
        check()?;
        sql(tx.commit())?;
        Ok(Prepared { header, request })
    }
    pub(crate) fn prepare_source_snapshot_activation_page(
        &self,
        request: &Request,
        header: &Header,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<PreparedPage, String> {
        check()?;
        let mut c = connect_background(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        source_fences(&tx, request)?;
        let mut statement=sql(tx.prepare("SELECT a.ordinal,e.channel FROM source_activation_row a JOIN source_snapshot_entry e ON e.source_id=a.source_id AND e.entry_id=a.entry_id AND e.available=1 WHERE a.manifest_id=?1 AND a.ordinal>=?2 ORDER BY a.ordinal LIMIT 64"))?;
        let rows = sql(statement
            .query_map(params![header.manifest_id, header.next_index as i64], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            }))?;
        let mut entries = Vec::new();
        let mut bytes = 0usize;
        for row in rows {
            check()?;
            let (ordinal, raw) = sql(row)?;
            let channel: Value = serde_json::from_str(&raw).map_err(|_| ERR)?;
            let urls = channel["urls"]
                .as_array()
                .ok_or(ERR)?
                .iter()
                .map(|u| u.as_str().map(str::to_owned).ok_or(ERR.into()))
                .collect::<Result<Vec<_>, String>>()?;
            let entry = crate::scan_candidate_manifest::Entry {
                candidate_index: ordinal as usize,
                urls,
            };
            let size = serde_json::to_vec(&entry).map_err(|_| ERR)?.len();
            if bytes + size > crate::scan_candidate_manifest::PAGE_LIMIT - 4096 {
                if entries.is_empty() {
                    return Err("scan-manifest-page-too-large".into());
                }
                break;
            }
            bytes += size;
            entries.push(entry);
        }
        drop(statement);
        if entries.is_empty() {
            return Err("source-activation-page-missing".into());
        }
        let prepared = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::prepare_page(
                &tx,
                Append {
                    manifest_id: header.manifest_id.clone(),
                    expected_manifest_revision: header.manifest_revision.clone(),
                    expected_catalog_revision: request.expected_catalog_revision.clone(),
                    expected_checkpoint_revision: request.expected_checkpoint_revision.clone(),
                    entries,
                },
                context,
                &mut check,
            )
        })?;
        sql(tx.commit())?;
        check()?;
        Ok(prepared)
    }
    pub(crate) fn seal_source_snapshot_activation(
        &self,
        activation: &Request,
        request: &Seal,
        prepared: &crate::scan_candidate_manifest::origin_directory::PreparedCapsule,
        ciphertext: &[u8],
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        check()?;
        if request.expected_catalog_revision != activation.expected_catalog_revision
            || request.expected_checkpoint_revision != activation.expected_checkpoint_revision
        {
            return Err(ERR.into());
        }
        let mut c = connect_background(&self.root.join(DB), false)?;
        self.backup_with_check(&c, &mut check)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        source_fences(&tx, activation)?;
        let (seed, prior_job_id, prior_review_digest, allow_unfinished) =
            Self::manifest_context(&tx, |context| {
                let (job, digest, allow) = crate::scan_candidate_manifest::replacement_guard(
                    &tx,
                    &request.manifest_id,
                    context,
                )?
                .ok_or("source-activation-replacement-missing")?;
                if allow != matches!(activation.mode, Mode::FullRecheck) {
                    return Err(ERR.into());
                }
                let seed = crate::scan_candidate_manifest::seal_seed(&tx, request, context)?;
                crate::scan_candidate_manifest::origin_directory::finish_seal(
                    &tx, request, prepared, ciphertext, context, &mut check,
                )?;
                Ok((seed, job, digest, allow))
            })?;
        // Replacement is authorized only at this final CAS boundary. Rollback
        // restores the previous acknowledged job on cancellation/crypto failure.
        let pair = RecordPair::default();
        let mutation = crate::scan_checkpoint::Mutation::Replace {
            checkpoint: seed,
            prior_job_id: prior_job_id.clone(),
            prior_review_digest: prior_review_digest.clone(),
            allow_unfinished,
        };
        let receipt = Self::apply_scan_transaction(
            &tx,
            &pair,
            None,
            (
                Some(crate::scan_checkpoint::revision(
                    &activation.expected_catalog_revision,
                )?),
                None,
            ),
            Some((
                &mutation,
                crate::scan_checkpoint::revision(&activation.expected_checkpoint_revision)?,
                scan_now(),
            )),
            PairReuse {
                validated: validate(&pair)?,
                before: None,
                projection_ids: None,
                health_groups: None,
                observer: None,
            },
            &mut |_| check(),
        )?;
        crate::scan_candidate_manifest::seal(&tx, request)?;
        // Only the exact acknowledged job just replaced can be retired.
        // This remains in the same transaction: failed seal, cancellation or
        // COMMIT restores its checkpoint, encrypted pages and origin capsule.
        if let (Some(job), Some(digest)) = (&prior_job_id, &prior_review_digest) {
            sql(tx.execute(
                "DELETE FROM scan_manifest WHERE job_id=?1 AND review_digest=?2 AND state=1 AND id<>?3",
                params![job, digest, request.manifest_id],
            ))?;
        }
        super::source_snapshot_ambiguity::prune_unpinned_counts_in_transaction(&tx)?;
        check()?;
        sql(tx.commit())?;
        Ok(receipt)
    }
}

#[cfg(test)]
#[path = "source_snapshot_activation_tests.rs"]
mod tests;
