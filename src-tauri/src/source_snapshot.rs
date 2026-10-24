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

//! Independent, source-isolated parsed-entry snapshots. Staging is operational;
//! promotion never deletes canonical channels, favorites or contextual health.
//! Native owners provide the runtime profile and retain cancellation/Store leases.
use super::*;
use rusqlite::OptionalExtension;
use unicode_normalization::UnicodeNormalization;
const ERR: &str = "source-snapshot-invalid";
const BYTES: usize = 20 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Begin {
    pub schema_version: u8,
    pub source: Value,
    pub expected_source_revision: String,
    pub entry_count: usize,
    pub platform: String,
    pub observer_profile: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Entry {
    pub entry_id: String,
    pub channel: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Append {
    pub snapshot_id: String,
    pub expected_next_index: usize,
    pub entries: Vec<Entry>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Promote {
    pub snapshot_id: String,
    pub expected_source_revision: String,
    pub completed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    pub schema_version: u8,
    pub snapshot_id: String,
    pub source_id: String,
    pub source_revision: String,
    pub next_index: usize,
    pub entry_count: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    pub schema_version: u8,
    pub committed: bool,
    pub source_id: String,
    pub source_revision: String,
    pub added: usize,
    pub changed: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub duplicates: usize,
    pub total: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub schema_version: u8,
    pub source_id: String,
    pub source_revision: String,
    pub total: usize,
    pub missing: usize,
    pub staging: Option<Progress>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Next {
    pub source_id: String,
    pub expected_source_revision: String,
    pub after_ordinal: Option<usize>,
    pub limit: usize,
    pub now_ms: u64,
    pub positive_ttl_ms: u64,
    /// A failure without a definite answer (timeouts, network failures, busy
    /// servers): due again after this long. Set natively.
    pub retry_after_ms: u64,
    /// A definite failure (not found, access denied, unsupported): due again
    /// after this long. Set natively; callers never choose it.
    #[serde(default)]
    pub definite_failure_ttl_ms: u64,
    pub platform: String,
    pub observer_profile: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckRow {
    pub entry_id: String,
    pub ordinal: usize,
    pub content_hash: String,
    pub address_hash: String,
    pub permission_fingerprint: String,
    pub channel: Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckPage {
    pub schema_version: u8,
    pub source_revision: String,
    pub rows: Vec<CheckRow>,
    pub after_ordinal: Option<usize>,
    pub exhausted: bool,
}
fn digest(v: &Value) -> Result<String, String> {
    Ok(Sha256::digest(serde_json::to_vec(v).map_err(|_| ERR)?)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
fn normalized(value: &Value) -> Result<String, String> {
    let text = value.as_str().ok_or(ERR)?;
    Ok(text.nfkc().collect::<String>().trim_matches(|c:char|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')).to_lowercase())
}
fn identity_keys(source_id: &str, channel: &Value) -> Result<(String, String), String> {
    let provider = channel
        .get("providerId")
        .map(|v| v.as_str().ok_or(ERR))
        .transpose()?
        .unwrap_or("");
    let provider = if provider.is_empty() {
        String::new()
    } else {
        digest(&json!(["source-provider-v1", source_id, provider]))?
    };
    let metadata = digest(&json!([
        "source-metadata-v1",
        source_id,
        normalized(&channel["name"])?,
        channel.get("geography").unwrap_or(&Value::Null),
        channel.get("language").unwrap_or(&Value::Null)
    ]))?;
    Ok((provider, metadata))
}
fn small(v: &str, max: usize) -> Result<(), String> {
    if v.is_empty() || v.len() > max || v.chars().any(char::is_control) {
        Err(ERR.into())
    } else {
        Ok(())
    }
}
pub(super) fn ensure(c: &Connection) -> Result<(), String> {
    let exists: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='source_snapshot_namespace')",
        [],
        |r| r.get(0),
    ))?;
    if exists
        && !matches!(
            sql(c.query_row(
                "SELECT schema_version FROM source_snapshot_namespace WHERE singleton=1",
                [],
                |r| r.get::<_, i64>(0),
            ))?,
            1 | 2
        )
    {
        return Err("source-snapshot-version-unsupported".into());
    }
    sql(c.execute_batch("CREATE TABLE IF NOT EXISTS source_snapshot_namespace(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version IN(1,2)));INSERT OR IGNORE INTO source_snapshot_namespace VALUES(1,2);
CREATE TABLE IF NOT EXISTS source_snapshot_source(source_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,definition TEXT NOT NULL,permission TEXT NOT NULL,platform TEXT NOT NULL,profile TEXT NOT NULL,refreshed_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS source_snapshot_entry(source_id TEXT NOT NULL REFERENCES source_snapshot_source(source_id),entry_id TEXT NOT NULL,ordinal INTEGER NOT NULL,content_hash TEXT NOT NULL,address_hash TEXT NOT NULL,endpoint_hash TEXT NOT NULL,permission TEXT NOT NULL,provider_key TEXT NOT NULL,metadata_key TEXT NOT NULL,channel TEXT NOT NULL,available INTEGER NOT NULL CHECK(available IN(0,1)),check_ms INTEGER,check_verdict TEXT,check_permission TEXT,check_address TEXT,evidence TEXT,PRIMARY KEY(source_id,entry_id));CREATE INDEX IF NOT EXISTS source_snapshot_provider ON source_snapshot_entry(source_id,provider_key); CREATE INDEX IF NOT EXISTS source_snapshot_metadata ON source_snapshot_entry(source_id,metadata_key); CREATE INDEX IF NOT EXISTS source_snapshot_order ON source_snapshot_entry(source_id,available,ordinal);
CREATE TABLE IF NOT EXISTS source_snapshot_stage(id TEXT PRIMARY KEY,source_id TEXT NOT NULL UNIQUE,expected_revision INTEGER NOT NULL,definition TEXT NOT NULL,permission TEXT NOT NULL,platform TEXT NOT NULL,profile TEXT NOT NULL,total INTEGER NOT NULL,next_index INTEGER NOT NULL,bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS source_snapshot_stage_entry(snapshot_id TEXT NOT NULL REFERENCES source_snapshot_stage(id) ON DELETE CASCADE,entry_id TEXT NOT NULL,ordinal INTEGER NOT NULL,content_hash TEXT NOT NULL,address_hash TEXT NOT NULL,endpoint_hash TEXT NOT NULL,provider_key TEXT NOT NULL,metadata_key TEXT NOT NULL,channel TEXT NOT NULL,PRIMARY KEY(snapshot_id,entry_id),UNIQUE(snapshot_id,ordinal)); CREATE INDEX IF NOT EXISTS source_snapshot_stage_provider ON source_snapshot_stage_entry(snapshot_id,provider_key); CREATE INDEX IF NOT EXISTS source_snapshot_stage_metadata ON source_snapshot_stage_entry(snapshot_id,metadata_key);"))?;
    if !has_checked_content(c)? {
        // Never infer the metadata associated with legacy endpoint observations.
        sql(c.execute_batch(
            "ALTER TABLE source_snapshot_entry ADD COLUMN checked_content_hash TEXT;",
        ))?;
    }
    // The legacy namespace CHECK only permits 1, so replace that tiny operational
    // table within the caller's transaction, preserving all source/entry data.
    if sql(c.query_row(
        "SELECT schema_version FROM source_snapshot_namespace WHERE singleton=1",
        [],
        |r| r.get::<_, i64>(0),
    ))? == 1
    {
        sql(c.execute_batch("DROP TABLE source_snapshot_namespace; CREATE TABLE source_snapshot_namespace(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version IN(1,2))); INSERT INTO source_snapshot_namespace VALUES(1,2);"))?;
    }
    Ok(())
}
fn has_checked_content(c: &Connection) -> Result<bool, String> {
    sql(c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('source_snapshot_entry') WHERE name='checked_content_hash')", [], |r| r.get(0)))
}
fn present(c: &Connection) -> Result<bool, String> {
    let exists: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='source_snapshot_namespace')",
        [],
        |r| r.get(0),
    ))?;
    if exists
        && !matches!(
            sql(c.query_row(
                "SELECT schema_version FROM source_snapshot_namespace WHERE singleton=1",
                [],
                |r| r.get::<_, i64>(0),
            ))?,
            1 | 2
        )
    {
        return Err("source-snapshot-version-unsupported".into());
    }
    Ok(exists)
}
fn revision(c: &Connection, id: &str) -> Result<i64, String> {
    Ok(sql(c
        .query_row(
            "SELECT revision FROM source_snapshot_source WHERE source_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional())?
    .unwrap_or(0))
}
fn permission(
    c: &Connection,
    definition: &Value,
    platform: &str,
    profile: &str,
) -> Result<String, String> {
    source(definition)?;
    small(platform, 256)?;
    small(profile, 256)?;
    PairStore::manifest_context(c, |context| {
        let matches = |saved: &Value| {
            crate::scan_checkpoint::source_fingerprint(saved).ok()
                == crate::scan_checkpoint::source_fingerprint(definition).ok()
        };
        let canonical = context.catalog["sources"]
            .as_array()
            .is_some_and(|s| s.iter().any(matches));
        let provider = context.preferences["reviewedChannelProviders"]
            .as_array()
            .is_some_and(|providers| {
                providers.iter().any(|p| {
                    p["location"] == definition["location"]
                        && p["allowHttp"].as_bool().unwrap_or(false)
                            == definition["allowHttp"].as_bool().unwrap_or(false)
                })
            });
        if !canonical && !(definition["kind"] == "url" && provider) {
            return Err("source-snapshot-source-refused".into());
        }
        digest(&json!([
            "network-permission-v1",
            definition["id"],
            definition["kind"],
            definition["location"],
            definition["allowHttp"].as_bool().unwrap_or(false),
            platform,
            profile
        ]))
    })
}
struct Stage {
    id: String,
    source_id: String,
    expected: i64,
    definition: Value,
    permission: String,
    platform: String,
    profile: String,
    total: usize,
    next: usize,
    bytes: usize,
}
fn stage(c: &Connection, id: &str) -> Result<Stage, String> {
    small(id, 128)?;
    let row=sql(c.query_row("SELECT source_id,expected_revision,definition,permission,platform,profile,total,next_index,bytes FROM source_snapshot_stage WHERE id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,i64>(6)?,r.get::<_,i64>(7)?,r.get::<_,i64>(8)?))).optional())?.ok_or("source-snapshot-stage-absent")?;
    if row.1 < 0
        || row.6 < 0
        || row.6 > 100000
        || row.7 < 0
        || row.7 > row.6
        || row.8 < 0
        || row.8 > BYTES as i64
    {
        return Err(ERR.into());
    }
    Ok(Stage {
        id: id.into(),
        source_id: row.0,
        expected: row.1,
        definition: serde_json::from_str(&row.2).map_err(|_| ERR)?,
        permission: row.3,
        platform: row.4,
        profile: row.5,
        total: row.6 as usize,
        next: row.7 as usize,
        bytes: row.8 as usize,
    })
}
fn current(c: &Connection, s: &Stage) -> Result<(), String> {
    if revision(c, &s.source_id)? != s.expected {
        return Err("source-snapshot-revision-stale".into());
    }
    if permission(c, &s.definition, &s.platform, &s.profile)? != s.permission {
        return Err("source-snapshot-permission-stale".into());
    }
    Ok(())
}
fn progress(s: &Stage) -> Progress {
    Progress {
        schema_version: 1,
        snapshot_id: s.id.clone(),
        source_id: s.source_id.clone(),
        source_revision: s.expected.to_string(),
        next_index: s.next,
        entry_count: s.total,
    }
}
/// Only the authenticated native scan commit calls this helper. It shares that
/// commit's SQL transaction, including failed observations without canonical IDs.
pub(super) fn record_activation_evidence_in_transaction(
    c: &Connection,
    header: &Value,
    original_index: usize,
    metadata: &Value,
    urls: &[String],
    observation: &Value,
) -> Result<(), String> {
    let mapped: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='source_activation_row')",
        [],
        |r| r.get(0),
    ))?;
    if !mapped {
        return Ok(());
    }
    let mut statement = sql(c.prepare("SELECT m.id FROM scan_manifest m WHERE m.job_id=?1 AND m.review_digest=?2 AND m.state=1 LIMIT 2"))?;
    let manifests = sql(statement.query_map(
        params![
            header["jobId"].as_str().ok_or(ERR)?,
            header["reviewDigest"].as_str().ok_or(ERR)?
        ],
        |r| r.get::<_, String>(0),
    ))?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(|_| ERR)?;
    drop(statement);
    if manifests.len() > 1 {
        return Err("source-snapshot-evidence-stale".into());
    }
    let Some(manifest) = manifests.first() else {
        return Ok(());
    };
    let has_mapping: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_activation_row WHERE manifest_id=?1)",
        [manifest],
        |r| r.get(0),
    ))?;
    // Ordinary legacy native manifests have no independent snapshot activation.
    if !has_mapping {
        return Ok(());
    }
    let (id, entry_id, expected): (String, String, String) = sql(c.query_row("SELECT source_id,entry_id,source_revision FROM source_activation_row WHERE manifest_id=?1 AND ordinal=?2", params![manifest, original_index as i64], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))))?;
    ensure(c)?;
    let expected_revision = crate::scan_checkpoint::revision(&expected)?;
    let historical = revision(c, &id)? != expected_revision;
    let definitions = header["sourceDefinitions"].as_array().ok_or(ERR)?;
    let bound_definition = definitions
        .iter()
        .find(|d| d["source"]["id"] == id)
        .ok_or(ERR)?;
    let (definition, channel, address, endpoint): (Value, Value, String, String) = if historical {
        // Original plan verification and current native policy fencing precede
        // this call. Retain only counts, never a duplicate historical URL graph.
        if !super::source_snapshot_ambiguity::pinned_coverage(c, manifest, &id, expected_revision)?
        {
            return Err("source-snapshot-revision-stale".into());
        }
        let mut original = metadata["channel"].clone();
        original["urls"] = json!(urls);
        original["id"] = json!(entry_id);
        let address = digest(&original["urls"])?;
        let endpoint = digest(&original["urls"][0])?;
        (
            bound_definition["source"].clone(),
            original,
            address,
            endpoint,
        )
    } else {
        let (definition, channel, address, endpoint): (String,String,String,String) = sql(c.query_row("SELECT s.definition,e.channel,e.address_hash,e.endpoint_hash FROM source_snapshot_source s JOIN source_snapshot_entry e ON e.source_id=s.source_id WHERE s.source_id=?1 AND e.entry_id=?2 AND e.available=1",params![id,entry_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))))?;
        (
            serde_json::from_str(&definition).map_err(|_| ERR)?,
            serde_json::from_str(&channel).map_err(|_| ERR)?,
            address,
            endpoint,
        )
    };
    let definition_hash = crate::scan_checkpoint::source_fingerprint(&definition)?;
    let captured = digest(&json!([
        "source-index-revision-v1",
        definition_hash,
        expected
    ]))?;
    if metadata["sourceId"] != id
        || observation["sourceId"] != id
        || metadata["sourceFingerprint"] != captured
        || observation["fingerprint"] != captured
        || metadata["key"] != digest(&json!(["source-index-candidate-v1", id, entry_id]))?
        || observation["channelId"] != metadata["key"]
        || observation["platform"] != header["platform"]
        || crate::scan_checkpoint::source_fingerprint(&bound_definition["source"])?
            != definition_hash
        || channel["id"] != entry_id
        || channel["sourceId"] != id
        || channel["urls"] != json!(urls)
        || digest(&channel["urls"])? != address
        || digest(&channel["urls"][0])? != endpoint
        || [
            "name",
            "category",
            "providerId",
            "geography",
            "geographyProvenance",
        ]
        .iter()
        .any(|k| channel[*k] != metadata["channel"][*k])
    {
        return Err("source-snapshot-evidence-stale".into());
    }
    let platform = header["platform"].as_str().ok_or(ERR)?;
    let profile = header["observerProfile"].as_str().ok_or(ERR)?;
    let grant = permission(c, &definition, platform, profile)?;
    if historical {
        // Canonical publication/CP advancement still commits. Do not label the
        // newer independent source index with observations of the old capture.
        return Ok(());
    }
    let fingerprint = crate::health_storage::fingerprint(&definition, &channel, 0)?;
    let record: crate::health_storage::Record = serde_json::from_value(json!({
        "schemaVersion":1,"channelId":entry_id,"sourceId":id,"checkedUrlOrdinal":0,
        "targetFingerprint":fingerprint,"platform":platform,"observerProfile":profile,
        "observedAt":observation["observedAt"],"verdict":observation["verdict"],
        "evidence":observation["evidence"],"origin":"local"
    }))
    .map_err(|_| ERR)?;
    let validated = crate::health_storage::encode(std::slice::from_ref(&record))?;
    let updated = sql(c.execute("UPDATE source_snapshot_entry SET check_ms=?3,check_verdict=?4,check_permission=?5,check_address=address_hash,checked_content_hash=content_hash,evidence=?6 WHERE source_id=?1 AND entry_id=?2 AND available=1",params![id,entry_id,observation["observedAt"].as_u64().ok_or(ERR)? as i64,observation["verdict"].as_str().ok_or(ERR)?,grant,validated]))?;
    if updated != 1 {
        return Err("source-snapshot-evidence-stale".into());
    }
    Ok(())
}
fn finalize_identities(
    c: &Connection,
    s: &Stage,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<usize, String> {
    // Group once over the WHOLE completed capture. No per-page uniqueness,
    // name-only cross-source matching, or full source graph in JavaScript.
    sql(c.execute_batch("CREATE TEMP TABLE source_identity_new_provider(k TEXT PRIMARY KEY,n INTEGER);CREATE TEMP TABLE source_identity_new_metadata(k TEXT PRIMARY KEY,n INTEGER);CREATE TEMP TABLE source_identity_variant(m TEXT,a TEXT,n INTEGER,PRIMARY KEY(m,a));CREATE TEMP TABLE source_identity_old_provider(k TEXT PRIMARY KEY,n INTEGER,id TEXT);CREATE TEMP TABLE source_identity_old_metadata(k TEXT PRIMARY KEY,n INTEGER,id TEXT);"))?;
    sql(c.execute("INSERT INTO source_identity_new_provider SELECT provider_key,count(*) FROM source_snapshot_stage_entry WHERE snapshot_id=?1 AND provider_key<>'' GROUP BY provider_key",[&s.id]))?;
    sql(c.execute("INSERT INTO source_identity_new_metadata SELECT metadata_key,count(*) FROM source_snapshot_stage_entry WHERE snapshot_id=?1 GROUP BY metadata_key",[&s.id]))?;
    sql(c.execute("INSERT INTO source_identity_variant SELECT metadata_key,address_hash,count(*) FROM source_snapshot_stage_entry WHERE snapshot_id=?1 GROUP BY metadata_key,address_hash",[&s.id]))?;
    sql(c.execute("INSERT INTO source_identity_old_provider SELECT provider_key,count(*),min(entry_id) FROM source_snapshot_entry WHERE source_id=?1 AND provider_key<>'' GROUP BY provider_key",[&s.source_id]))?;
    sql(c.execute("INSERT INTO source_identity_old_metadata SELECT metadata_key,count(*),min(entry_id) FROM source_snapshot_entry WHERE source_id=?1 GROUP BY metadata_key",[&s.source_id]))?;
    let mut statement=sql(c.prepare("SELECT e.entry_id,e.provider_key,e.metadata_key,e.address_hash,e.content_hash,e.channel,coalesce(p.n,0),m.n,v.n,op.n,op.id,om.n,om.id FROM source_snapshot_stage_entry e LEFT JOIN source_identity_new_provider p ON p.k=e.provider_key JOIN source_identity_new_metadata m ON m.k=e.metadata_key JOIN source_identity_variant v ON v.m=e.metadata_key AND v.a=e.address_hash LEFT JOIN source_identity_old_provider op ON op.k=e.provider_key LEFT JOIN source_identity_old_metadata om ON om.k=e.metadata_key WHERE e.snapshot_id=?1 ORDER BY e.ordinal"))?;
    let rows = sql(statement.query_map([&s.id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, i64>(7)?,
            r.get::<_, i64>(8)?,
            r.get::<_, Option<i64>>(9)?,
            r.get::<_, Option<String>>(10)?,
            r.get::<_, Option<i64>>(11)?,
            r.get::<_, Option<String>>(12)?,
        ))
    }))?;
    let mut count = 0usize;
    for row in rows {
        check()?;
        let (
            old,
            provider,
            metadata,
            address,
            content,
            raw,
            provider_count,
            metadata_count,
            variant_count,
            old_provider_count,
            old_provider,
            old_metadata_count,
            old_metadata,
        ) = sql(row)?;
        let id = if !provider.is_empty() && provider_count == 1 {
            if old_provider_count == Some(1) {
                old_provider.ok_or(ERR)?
            } else {
                format!(
                    "source-entry-{}",
                    digest(&json!(["source-entry-provider-v1", s.source_id, provider]))?
                )
            }
        } else if metadata_count == 1 {
            if old_metadata_count == Some(1) {
                old_metadata.ok_or(ERR)?
            } else {
                format!(
                    "source-entry-{}",
                    digest(&json!(["source-entry-metadata-v1", s.source_id, metadata]))?
                )
            }
        } else {
            format!(
                "source-entry-{}",
                digest(&json!([
                    "source-entry-variant-v1",
                    s.source_id,
                    provider,
                    metadata,
                    address,
                    if variant_count > 1 {
                        Some(content)
                    } else {
                        None
                    }
                ]))?
            )
        };
        let mut channel: Value = serde_json::from_str(&raw).map_err(|_| ERR)?;
        if !channel.is_object() {
            return Err(ERR.into());
        }
        channel["id"] = json!(id);
        sql(c.execute("UPDATE source_snapshot_stage_entry SET entry_id=?3,channel=?4 WHERE snapshot_id=?1 AND entry_id=?2",params![s.id,old,id,channel.to_string()]))?;
        count += 1;
    }
    drop(statement);
    sql(c.execute_batch("DROP TABLE source_identity_new_provider;DROP TABLE source_identity_new_metadata;DROP TABLE source_identity_variant;DROP TABLE source_identity_old_provider;DROP TABLE source_identity_old_metadata;"))?;
    Ok(count)
}
impl PairStore {
    pub(crate) fn begin_source_snapshot(
        &self,
        request: &Begin,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Progress, String> {
        if request.schema_version != 1 || request.entry_count > 100000 {
            return Err(ERR.into());
        }
        source(&request.source)?;
        let source_id = text(&request.source, "id", 256, false)?.to_owned();
        let expected = crate::scan_checkpoint::revision(&request.expected_source_revision)?;
        check()?;
        let mut c = connect_background(&self.root.join(DB), false)?;
        self.backup_with_check(&c, &mut check)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        ensure(&tx)?;
        if revision(&tx, &source_id)? != expected {
            return Err("source-snapshot-revision-stale".into());
        }
        let permission = permission(
            &tx,
            &request.source,
            &request.platform,
            &request.observer_profile,
        )?;
        let count: i64 = sql(tx.query_row(
            "SELECT count(*) FROM (SELECT source_id FROM source_snapshot_source UNION SELECT source_id FROM source_snapshot_stage) WHERE source_id<>?1",
            [&source_id],
            |r| r.get(0),
        ))?;
        if count >= 100 {
            return Err("source-snapshot-source-limit".into());
        }
        sql(tx.execute(
            "DELETE FROM source_snapshot_stage WHERE source_id=?1",
            [&source_id],
        ))?;
        let id = crate::scan_resume_runtime::plan_id()?;
        sql(tx.execute(
            "INSERT INTO source_snapshot_stage VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,2)",
            params![
                id,
                source_id,
                expected,
                request.source.to_string(),
                permission,
                request.platform,
                request.observer_profile,
                request.entry_count as i64
            ],
        ))?;
        let result = progress(&stage(&tx, &id)?);
        check()?;
        sql(tx.commit())?;
        Ok(result)
    }
    pub(crate) fn append_source_snapshot(
        &self,
        request: &Append,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Progress, String> {
        if request.entries.is_empty() || request.entries.len() > 64 {
            return Err(ERR.into());
        }
        check()?;
        let mut c = connect_background(&self.root.join(DB), false)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        present(&tx)?;
        let mut s = stage(&tx, &request.snapshot_id)?;
        current(&tx, &s)?;
        if request.expected_next_index != s.next || s.next + request.entries.len() > s.total {
            return Err("source-snapshot-order-stale".into());
        }
        for entry in &request.entries {
            check()?;
            if entry.entry_id.len() > 16384 || entry.entry_id.chars().any(char::is_control) {
                return Err(ERR.into());
            }
            let mut channel = entry.channel.clone();
            if !channel.is_object() {
                return Err(ERR.into());
            }
            if channel
                .get("sourceId")
                .is_some_and(|id| id.as_str() != Some(s.source_id.as_str()))
            {
                return Err(ERR.into());
            }
            channel["sourceId"] = json!(s.source_id);
            channel.as_object_mut().ok_or(ERR)?.remove("id");
            let content = digest(&channel)?;
            let provisional = format!("source-stage-{content}");
            channel["id"] = json!(provisional);
            // Preserve syntactically valid HTTP candidates without conferring a
            // grant. Actual networking always uses the separately bound permission.
            let mut syntax_source = s.definition.clone();
            syntax_source["allowHttp"] = json!(true);
            validate_checkpoint_catalog(
                &json!({"schemaVersion":1,"sources":[syntax_source],"channels":[channel.clone()]}),
            )?;
            let encoded = channel.to_string();
            let address = digest(&channel["urls"])?;
            let endpoint = digest(&channel["urls"][0])?;
            let (provider, metadata) = identity_keys(&s.source_id, &channel)?;
            let inserted=sql(tx.execute(
                "INSERT INTO source_snapshot_stage_entry VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(snapshot_id,entry_id) DO NOTHING",
                params![
                    s.id,
                    provisional,
                    s.next as i64,
                    content,
                    address,
                    endpoint,
                    provider,
                    metadata,
                    encoded
                ],
            ))?;
            if inserted == 1 {
                s.bytes = s.bytes.checked_add(encoded.len() + 1).ok_or(ERR)?;
                if s.bytes > BYTES {
                    return Err("source-snapshot-too-large".into());
                }
            }
            s.next += 1;
        }
        sql(tx.execute(
            "UPDATE source_snapshot_stage SET next_index=?2,bytes=?3 WHERE id=?1",
            params![s.id, s.next as i64, s.bytes as i64],
        ))?;
        check()?;
        let reply = progress(&s);
        sql(tx.commit())?;
        Ok(reply)
    }
    pub(crate) fn promote_source_snapshot(
        &self,
        request: &Promote,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Receipt, String> {
        if !request.completed {
            return Err("source-snapshot-incomplete".into());
        }
        check()?;
        let mut c = connect_background(&self.root.join(DB), false)?;
        self.backup_with_check(&c, &mut check)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let s = stage(&tx, &request.snapshot_id)?;
        current(&tx, &s)?;
        if crate::scan_checkpoint::revision(&request.expected_source_revision)? != s.expected {
            return Err("source-snapshot-revision-stale".into());
        }
        if s.next != s.total {
            return Err("source-snapshot-incomplete".into());
        }
        let total = finalize_identities(&tx, &s, &mut check)?;
        let (added,changed,unchanged):(i64,i64,i64)=sql(tx.query_row("SELECT coalesce(sum(o.entry_id IS NULL),0),coalesce(sum(o.entry_id IS NOT NULL AND (o.content_hash<>n.content_hash OR o.permission<>?3 OR o.available=0)),0),coalesce(sum(o.entry_id IS NOT NULL AND o.content_hash=n.content_hash AND o.permission=?3 AND o.available=1),0) FROM source_snapshot_stage_entry n LEFT JOIN source_snapshot_entry o ON o.source_id=?2 AND o.entry_id=n.entry_id WHERE n.snapshot_id=?1",params![s.id,s.source_id,s.permission],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))))?;
        let removed:i64=sql(tx.query_row("SELECT count(*) FROM source_snapshot_entry o WHERE source_id=?1 AND available=1 AND NOT EXISTS(SELECT 1 FROM source_snapshot_stage_entry n WHERE n.snapshot_id=?2 AND n.entry_id=o.entry_id)",params![s.source_id,s.id],|r|r.get(0)))?;
        let (stored_count,retained_bytes):(i64,i64)=sql(tx.query_row("SELECT count(*),coalesce(sum(length(CAST(coalesce(n.channel,o.channel) AS BLOB))+1),0) FROM source_snapshot_entry o LEFT JOIN source_snapshot_stage_entry n ON n.snapshot_id=?2 AND n.entry_id=o.entry_id WHERE o.source_id=?1",params![s.source_id,s.id],|r|Ok((r.get(0)?,r.get(1)?))))?;
        let new_bytes:i64=sql(tx.query_row("SELECT coalesce(sum(length(CAST(n.channel AS BLOB))+1),0) FROM source_snapshot_stage_entry n WHERE snapshot_id=?1 AND NOT EXISTS(SELECT 1 FROM source_snapshot_entry o WHERE o.source_id=?2 AND o.entry_id=n.entry_id)",params![s.id,s.source_id],|r|r.get(0)))?;
        if stored_count + added > 100000 || retained_bytes + new_bytes > BYTES as i64 {
            return Err("source-snapshot-retention-limit".into());
        }
        // Materialize legacy current coverage while its original entries still
        // exist, so a live old checkpoint survives failed replacement sealing.
        if s.expected > 0 {
            super::source_snapshot_ambiguity::rebuild_counts_in_transaction(
                &tx,
                &s.source_id,
                s.expected,
                &mut check,
            )?;
        }
        let next = s.expected.checked_add(1).ok_or(ERR)?;
        sql(tx.execute("INSERT INTO source_snapshot_source VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,definition=excluded.definition,permission=excluded.permission,platform=excluded.platform,profile=excluded.profile,refreshed_ms=excluded.refreshed_ms",params![s.source_id,next,s.definition.to_string(),s.permission,s.platform,s.profile,scan_now() as i64]))?;
        sql(tx.execute("UPDATE source_snapshot_entry SET available=0 WHERE source_id=?1 AND available=1 AND NOT EXISTS(SELECT 1 FROM source_snapshot_stage_entry n WHERE n.snapshot_id=?2 AND n.entry_id=source_snapshot_entry.entry_id)",params![s.source_id,s.id]))?;
        sql(tx.execute("INSERT INTO source_snapshot_entry(source_id,entry_id,ordinal,content_hash,address_hash,endpoint_hash,permission,provider_key,metadata_key,channel,available) SELECT ?2,entry_id,ordinal,content_hash,address_hash,endpoint_hash,?3,provider_key,metadata_key,channel,1 FROM source_snapshot_stage_entry WHERE snapshot_id=?1 ON CONFLICT(source_id,entry_id) DO UPDATE SET ordinal=excluded.ordinal,content_hash=excluded.content_hash,address_hash=excluded.address_hash,endpoint_hash=excluded.endpoint_hash,permission=excluded.permission,provider_key=excluded.provider_key,metadata_key=excluded.metadata_key,channel=excluded.channel,available=1,check_ms=CASE WHEN source_snapshot_entry.address_hash=excluded.address_hash AND source_snapshot_entry.permission=excluded.permission THEN source_snapshot_entry.check_ms ELSE NULL END,check_verdict=CASE WHEN source_snapshot_entry.address_hash=excluded.address_hash AND source_snapshot_entry.permission=excluded.permission THEN source_snapshot_entry.check_verdict ELSE NULL END,check_permission=CASE WHEN source_snapshot_entry.address_hash=excluded.address_hash AND source_snapshot_entry.permission=excluded.permission THEN source_snapshot_entry.check_permission ELSE NULL END,check_address=CASE WHEN source_snapshot_entry.address_hash=excluded.address_hash AND source_snapshot_entry.permission=excluded.permission THEN source_snapshot_entry.check_address ELSE NULL END,evidence=CASE WHEN source_snapshot_entry.address_hash=excluded.address_hash AND source_snapshot_entry.permission=excluded.permission THEN source_snapshot_entry.evidence ELSE NULL END WHERE source_snapshot_entry.content_hash<>excluded.content_hash OR source_snapshot_entry.permission<>excluded.permission OR source_snapshot_entry.ordinal<>excluded.ordinal OR source_snapshot_entry.available<>1",params![s.id,s.source_id,s.permission]))?;
        // Count the completed available source once, with exact publication
        // equivalences, and commit its revision proof alongside the snapshot.
        super::source_snapshot_ambiguity::rebuild_counts_in_transaction(
            &tx,
            &s.source_id,
            next,
            &mut check,
        )?;
        sql(tx.execute("DELETE FROM source_snapshot_stage WHERE id=?1", [s.id]))?;
        check()?;
        sql(tx.commit())?;
        Ok(Receipt {
            schema_version: 1,
            committed: true,
            source_id: s.source_id,
            source_revision: next.to_string(),
            added: added as usize,
            changed: changed as usize,
            unchanged: unchanged as usize,
            removed: removed as usize,
            duplicates: s.total - total,
            total,
        })
    }
    pub(crate) fn source_snapshot_status(
        &self,
        id: &str,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Status, String> {
        small(id, 256)?;
        check()?;
        let mut c = connect_background(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        if !present(&tx)? {
            return Ok(Status {
                schema_version: 1,
                source_id: id.into(),
                source_revision: "0".into(),
                total: 0,
                missing: 0,
                staging: None,
            });
        }
        let rev = revision(&tx, id)?;
        let(total,missing):(i64,i64)=sql(tx.query_row("SELECT count(*),coalesce(sum(available=0),0) FROM source_snapshot_entry WHERE source_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?))))?;
        let pending: Option<String> = sql(tx
            .query_row(
                "SELECT id FROM source_snapshot_stage WHERE source_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional())?;
        let staging = pending
            .map(|id| stage(&tx, &id).map(|s| progress(&s)))
            .transpose()?;
        check()?;
        sql(tx.commit())?;
        Ok(Status {
            schema_version: 1,
            source_id: id.into(),
            source_revision: rev.to_string(),
            total: total as usize,
            missing: missing as usize,
            staging,
        })
    }
    pub(crate) fn next_source_snapshot_checks(
        &self,
        request: &Next,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<CheckPage, String> {
        if !(1..=64).contains(&request.limit)
            || request.now_ms > 9007199254740991
            || request.positive_ttl_ms > 7 * 86400000
            || request.retry_after_ms > 86400000
            || request.definite_failure_ttl_ms > 7 * 86400000
            || request.after_ordinal.is_some_and(|i| i >= 100000)
        {
            return Err(ERR.into());
        }
        check()?;
        let mut c = connect_background(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        present(&tx)?;
        let rev = revision(&tx, &request.source_id)?;
        if crate::scan_checkpoint::revision(&request.expected_source_revision)? != rev {
            return Err("source-snapshot-revision-stale".into());
        }
        let definition: String = sql(tx.query_row(
            "SELECT definition FROM source_snapshot_source WHERE source_id=?1",
            [&request.source_id],
            |r| r.get(0),
        ))?;
        let permission = permission(
            &tx,
            &serde_json::from_str(&definition).map_err(|_| ERR)?,
            &request.platform,
            &request.observer_profile,
        )?;
        let content_due = if has_checked_content(&tx)? {
            "checked_content_hash IS NULL OR checked_content_hash<>content_hash"
        } else {
            "1"
        };
        let mut stmt=sql(tx.prepare(&format!("SELECT entry_id,ordinal,content_hash,address_hash,channel FROM source_snapshot_entry WHERE source_id=?1 AND available=1 AND ordinal>?2 AND ({content_due} OR check_ms IS NULL OR check_permission IS NULL OR check_address IS NULL OR check_verdict IS NULL OR check_ms>?3 OR check_permission<>?4 OR check_address<>address_hash OR (check_verdict IN('Reachable','PlayedHere') AND check_ms<=?5) OR (check_verdict NOT IN('Reachable','PlayedHere') AND check_ms<=CASE WHEN {definite} THEN ?8 ELSE ?6 END)) ORDER BY ordinal LIMIT ?7", definite = crate::storage_transaction::source_snapshot_activation::DEFINITE_FAILURE)))?;
        let rows = sql(stmt.query_map(
            params![
                request.source_id,
                request.after_ordinal.map(|i| i as i64).unwrap_or(-1),
                request.now_ms as i64,
                permission,
                request.now_ms.saturating_sub(request.positive_ttl_ms) as i64,
                request.now_ms.saturating_sub(request.retry_after_ms) as i64,
                request.limit as i64 + 1,
                request
                    .now_ms
                    .saturating_sub(request.definite_failure_ttl_ms) as i64
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        ))?;
        let mut result = Vec::new();
        let mut exhausted = true;
        let mut bytes = 0;
        for row in rows {
            check()?;
            let (id, ordinal, content_hash, address_hash, raw) = sql(row)?;
            if ordinal < 0 || ordinal >= 100000 {
                return Err(ERR.into());
            }
            let channel: Value = serde_json::from_str(&raw).map_err(|_| ERR)?;
            let row = CheckRow {
                entry_id: id,
                ordinal: ordinal as usize,
                content_hash,
                address_hash,
                permission_fingerprint: permission.clone(),
                channel,
            };
            let cost = serde_json::to_vec(&row).map_err(|_| ERR)?.len() + 1;
            if result.len() == request.limit || bytes + cost > 1024 * 1024 - 1024 {
                exhausted = false;
                break;
            }
            bytes += cost;
            result.push(row);
        }
        drop(stmt);
        check()?;
        sql(tx.commit())?;
        let after_ordinal = result.last().map(|r| r.ordinal);
        Ok(CheckPage {
            schema_version: 1,
            source_revision: rev.to_string(),
            rows: result,
            after_ordinal,
            exhausted,
        })
    }
    /// Native receipt owner only: callers cannot submit an invented proof through
    /// a generic source-stage RPC. Existing health validation remains authoritative.
    pub(crate) fn record_source_snapshot_evidence(
        &self,
        id: &str,
        entry_id: &str,
        expected_revision: &str,
        record: &crate::health_storage::Record,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        let validated = crate::health_storage::encode(std::slice::from_ref(record))?;
        let value = serde_json::to_value(record).map_err(|_| ERR)?;
        check()?;
        let mut c = connect_background(&self.root.join(DB), false)?;
        self.backup_with_check(&c, &mut check)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        ensure(&tx)?;
        if revision(&tx, id)? != crate::scan_checkpoint::revision(expected_revision)? {
            return Err("source-snapshot-revision-stale".into());
        }
        let(definition,channel):(String,String)=sql(tx.query_row("SELECT s.definition,e.channel FROM source_snapshot_source s JOIN source_snapshot_entry e ON e.source_id=s.source_id WHERE s.source_id=?1 AND e.entry_id=?2 AND e.available=1",params![id,entry_id],|r|Ok((r.get(0)?,r.get(1)?))))?;
        let definition: Value = serde_json::from_str(&definition).map_err(|_| ERR)?;
        let channel: Value = serde_json::from_str(&channel).map_err(|_| ERR)?;
        let fingerprint = crate::health_storage::fingerprint(&definition, &channel, 0)?;
        if value["sourceId"] != id
            || value["channelId"] != entry_id
            || value["checkedUrlOrdinal"] != 0
            || value["targetFingerprint"] != fingerprint
            || value["origin"] != "local"
        {
            return Err("source-snapshot-evidence-stale".into());
        }
        let grant = permission(
            &tx,
            &definition,
            value["platform"].as_str().ok_or(ERR)?,
            value["observerProfile"].as_str().ok_or(ERR)?,
        )?;
        sql(tx.execute("UPDATE source_snapshot_entry SET check_ms=?3,check_verdict=?4,check_permission=?5,check_address=address_hash,checked_content_hash=content_hash,evidence=?6 WHERE source_id=?1 AND entry_id=?2",params![id,entry_id,value["observedAt"].as_u64().ok_or(ERR)? as i64,value["verdict"].as_str().ok_or(ERR)?,grant,validated]))?;
        check()?;
        sql(tx.commit())?;
        Ok(())
    }
}
