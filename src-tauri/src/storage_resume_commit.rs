//! Private SQL publication for authenticated original-index scan rows.
//! Registered as a storage_transaction child so the existing atomic write core is reused.
use super::*;
use crate::scan_checkpoint::resume_plan::{Fence, Plan};
use serde::Serialize;

const ERR: &str = "scan-resume-commit-invalid";
#[derive(Serialize)]
pub(crate) struct CheckedRow<'a> {
    pub original_index: usize,
    /// Original immutable reference metadata, NOT a client-created sanitized candidate.
    pub metadata: &'a Value,
    pub urls: &'a [String],
    pub observation: &'a Value,
    pub publish: bool,
}
/// This proof cannot be deserialized or constructed outside this SQL module.
pub(crate) struct CommittedDelta {
    version: u8,
    base: Fence,
    after: Fence,
    observation_tuples: Vec<Value>,
    published_indices: Vec<usize>,
}
impl CommittedDelta {
    pub(crate) fn version(&self) -> u8 {
        self.version
    }
    pub(crate) fn base(&self) -> Fence {
        self.base
    }
    pub(crate) fn after(&self) -> Fence {
        self.after
    }
    pub(crate) fn observation_tuples(&self) -> &[Value] {
        &self.observation_tuples
    }
    pub(crate) fn published_indices(&self) -> &[usize] {
        &self.published_indices
    }
}
pub(crate) struct Committed {
    pub receipt: CommitReceipt,
    pub delta: CommittedDelta,
    pub projection: PublicationProjection,
}
/// SQL-authoritative affected rows only. No client constructor or deserialization.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicationProjection {
    schema_version: u8,
    catalog_revision: String,
    health_revision: String,
    checkpoint_revision: String,
    channels: Vec<Value>,
    sources: Vec<Value>,
    #[serde(skip)]
    after: Fence,
}
impl PublicationProjection {
    pub(crate) fn version(&self) -> u8 {
        self.schema_version
    }
    pub(crate) fn after(&self) -> Fence {
        self.after
    }
    pub(crate) fn channels(&self) -> &[Value] {
        &self.channels
    }
    pub(crate) fn sources(&self) -> &[Value] {
        &self.sources
    }
}
struct Bound(usize);
impl std::io::Write for Bound {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if data.len() > 20usize.saturating_mul(1024 * 1024).saturating_sub(self.0) {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        self.0 += data.len();
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn uuid() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        return String::new();
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let raw = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        &raw[..8],
        &raw[8..12],
        &raw[12..16],
        &raw[16..20],
        &raw[20..]
    )
}
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key].as_str().ok_or_else(|| ERR.into())
}
impl PairStore {
    /// `root_generation` comes only from the retained Store lease owner, not an IPC argument.
    /// Rows must come from that owner's authenticated Plan/manifest. No client patch/grant exists.
    pub(crate) fn commit_scan_resume_selection(
        &self,
        plan: &Plan,
        root_generation: u64,
        rows: &[CheckedRow<'_>],
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Committed, String> {
        self.commit_scan_resume_selection_with_phase(
            plan,
            root_generation,
            rows,
            &mut |_| check(),
            &mut uuid,
        )
    }
    pub(crate) fn commit_scan_resume_window_selection(
        &self,
        plan: &Plan,
        root_generation: u64,
        rows: &[CheckedRow<'_>],
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Committed, String> {
        self.commit_scan_resume_window_with_phase(
            plan,
            root_generation,
            rows,
            240,
            &mut |_| check(),
            &mut uuid,
        )
    }
    fn commit_scan_resume_selection_with_phase(
        &self,
        plan: &Plan,
        root_generation: u64,
        rows: &[CheckedRow<'_>],
        phase: &mut impl FnMut(Phase) -> Result<(), String>,
        create_id: &mut impl FnMut() -> String,
    ) -> Result<Committed, String> {
        self.commit_scan_resume_window_with_phase(plan, root_generation, rows, 64, phase, create_id)
    }
    fn commit_scan_resume_window_with_phase(
        &self,
        plan: &Plan,
        root_generation: u64,
        rows: &[CheckedRow<'_>],
        max_rows: usize,
        phase: &mut impl FnMut(Phase) -> Result<(), String>,
        create_id: &mut impl FnMut() -> String,
    ) -> Result<Committed, String> {
        phase(Phase::BeforeWork)?;
        if rows.is_empty() || rows.len() > max_rows || ![64, 240].contains(&max_rows) {
            return Err(ERR.into());
        }
        serde_json::to_writer(&mut Bound(0), rows).map_err(|_| "scan-resume-commit-too-large")?;
        let mut c = connect_background(&self.root.join(DB), false)?;
        phase(Phase::BeforeBackup)?;
        self.backup_with_check(&c, || phase(Phase::DuringBackup))?;
        phase(Phase::AfterBackup)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let (cr, hr): (i64, i64) = sql(tx.query_row(
            "SELECT catalog_revision,health_revision FROM metadata WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        let cp: i64 = sql(tx.query_row(
            "SELECT revision FROM scan_checkpoint WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        let base = Fence {
            root_generation,
            catalog: cr,
            health: hr,
            checkpoint: cp,
        };
        let now = scan_now();
        plan.check_fence(base, now)?;
        let old = Self::read_connection_validated(&tx)?;
        let empty = json!({"schemaVersion":1,"sources":[],"channels":[]});
        let catalog = old.catalog.as_ref().unwrap_or(&empty);
        let preferences = old
            .preferences
            .as_ref()
            .ok_or("scan-checkpoint-preferences-required")?;
        // Policy/source/region grants may change without changing catalog/health revisions.
        crate::scan_checkpoint::manifest_authority(plan.header(), preferences, catalog, cr, now)?;
        let header = plan.header();
        let definitions = header["sourceDefinitions"].as_array().ok_or(ERR)?;
        let captures = header["review"]["sources"].as_array().ok_or(ERR)?;
        let source_policies:Vec<_>=definitions.iter().map(|d|{
            let capture=captures.iter().find(|s|s["sourceId"]==d["source"]["id"]).ok_or(ERR)?;
            Ok(json!({"source":d["source"],"definitionFingerprint":d["definitionFingerprint"],"capturedFingerprint":capture["fingerprint"]}))
        }).collect::<Result<_,&str>>()?;
        let mut indices = HashSet::new();
        let mut keys = HashSet::new();
        let mut candidates = Vec::with_capacity(rows.len());
        let mut observations = Vec::with_capacity(rows.len());
        let mut tuples = Vec::with_capacity(rows.len());
        let mut published_indices = Vec::new();
        let mut published_keys = Vec::new();
        for row in rows {
            phase(Phase::BeforeCommit)?;
            if !indices.insert(row.original_index) {
                return Err(ERR.into());
            }
            plan.verify_original(row.original_index, row.metadata, row.urls)?;
            let key = field(row.metadata, "key")?;
            let o = row.observation;
            if !keys.insert(key)
                || o["channelId"] != key
                || o["sourceId"] != row.metadata["sourceId"]
                || o["fingerprint"] != row.metadata["sourceFingerprint"]
                || o["platform"] != header["platform"]
                || matches!(
                    o["verdict"].as_str(),
                    None | Some("NotChecked" | "Canceled")
                )
            {
                return Err(ERR.into());
            }
            if row.publish && !matches!(o["verdict"].as_str(), Some("Reachable" | "PlayedHere")) {
                return Err(ERR.into());
            }
            let mut candidate = row.metadata.clone();
            candidate.as_object_mut().ok_or(ERR)?.remove("reference");
            candidate["channel"]["urls"] = json!(row.urls);
            candidates.push(candidate);
            observations.push(o.clone());
            tuples.push(json!([
                row.original_index,
                o["observedAt"],
                o["verdict"],
                o["evidence"]
            ]));
            if row.publish {
                published_indices.push(row.original_index);
                published_keys.push(key.to_owned());
            }
        }
        let selected: Vec<_> = rows
            .iter()
            .enumerate()
            .filter(|(_, r)| r.publish)
            .map(|(i, r)| crate::scan_resume_reconcile::Selected {
                original_index: r.original_index,
                candidate: &candidates[i],
                observation: r.observation,
            })
            .collect();
        let (pair, validated, health, projection_ids, projected_channels, projected_sources) =
            if selected.is_empty() {
                // Unpublished negative observations have no guessed canonical channel identity.
                (
                    RecordPair::default(),
                    (None, None),
                    None,
                    vec![Vec::new()],
                    Vec::new(),
                    Vec::new(),
                )
            } else {
                let mut next = catalog.clone();
                let mut next_preferences = preferences.clone();
                let mut chunks = Vec::new();
                let mut incoming_health = Vec::new();
                let mut ids_groups = Vec::new();
                let mut source_ids = HashSet::new();
                for selected_chunk in selected.chunks(64) {
                    let snapshot_ambiguity = super::source_snapshot_ambiguity::prepare(
                        &tx,
                        header,
                        selected_chunk,
                        &mut || phase(Phase::BeforeCommit),
                    )?;
                    let prepared = crate::scan_resume_reconcile::prepare(
                        crate::scan_resume_reconcile::Context {
                            catalog: &next,
                            preferences: &next_preferences,
                            source_policies: &source_policies,
                            session_revision: field(&header["review"], "sessionRevision")?,
                            platform: field(header, "platform")?,
                            observer_profile: field(header, "observerProfile")?,
                        },
                        selected_chunk,
                        &|channel| {
                            let original = plan.reconciliation_ambiguous(channel)?;
                            let indexed = snapshot_ambiguity.ambiguous(channel)?;
                            Ok((original.0 || indexed.0, original.1 || indexed.1))
                        },
                        create_id,
                        &mut || phase(Phase::BeforeCommit),
                    )?;
                    ids_groups.push(
                        prepared
                            .catalog_patch
                            .channels
                            .iter()
                            .map(|v| field(v, "id").map(str::to_owned))
                            .collect::<Result<Vec<_>, _>>()?,
                    );
                    source_ids.extend(
                        prepared
                            .catalog_patch
                            .sources
                            .iter()
                            .map(|v| field(v, "id").map(str::to_owned))
                            .collect::<Result<HashSet<_>, _>>()?,
                    );
                    let batch = crate::scan_batch::Batch {
                        schema_version: 1,
                        catalog_patch: prepared.catalog_patch,
                        authorized_sources: prepared.next_preferences["sources"]
                            .as_array()
                            .ok_or(ERR)?
                            .clone(),
                        next_preferences: prepared.next_preferences,
                        incoming_health: prepared.incoming_health,
                        expected_catalog_revision: cr.to_string(),
                        expected_health_revision: hr.to_string(),
                        scan_checkpoint: None,
                        expected_checkpoint_revision: None,
                    };
                    crate::scan_batch::validate_envelope(&batch)?;
                    next = crate::scan_batch::expand(&batch, &next, || phase(Phase::BeforeCommit))?;
                    next_preferences = batch.next_preferences;
                    incoming_health.extend(batch.incoming_health.iter().cloned());
                    chunks.push(crate::scan_window::Chunk {
                        catalog_patch: batch.catalog_patch,
                        incoming_health: batch.incoming_health,
                    });
                }
                if selected.len() > 64 {
                    let window = crate::scan_window::Window {
                        schema_version: 1,
                        chunks,
                        authorized_sources: next_preferences["sources"]
                            .as_array()
                            .ok_or(ERR)?
                            .clone(),
                        next_preferences: next_preferences.clone(),
                        expected_catalog_revision: cr.to_string(),
                        expected_health_revision: hr.to_string(),
                        scan_checkpoint: None,
                        expected_checkpoint_revision: None,
                    };
                    crate::scan_window::validate(&window)?;
                    // The per-chunk catalog is superseded; free it before the window copy.
                    drop(std::mem::take(&mut next));
                    next = crate::scan_window::expand(&window, catalog, || {
                        phase(Phase::BeforeCommit)
                    })?;
                }
                let ids = ids_groups.iter().flatten().cloned().collect::<HashSet<_>>();
                let pair = RecordPair {
                    catalog: Some(serde_json::to_string(&next).map_err(|_| ERR)?),
                    preferences: Some(serde_json::to_string(&next_preferences).map_err(|_| ERR)?),
                };
                // Only the encoded pair is authority from here; free its source trees
                // before validation builds the final ones (lower peak memory on TVs).
                drop(next);
                drop(next_preferences);
                let validated = validate(&pair)?;
                // Select from the fully validated final record, never raw candidate metadata.
                let final_catalog = validated.0.as_ref().ok_or(ERR)?;
                let target_ids: HashSet<_> = ids.iter().map(String::as_str).collect();
                let projected_channels: Vec<_> = final_catalog["channels"]
                    .as_array()
                    .ok_or(ERR)?
                    .iter()
                    .filter(|v| v["id"].as_str().is_some_and(|id| target_ids.contains(id)))
                    .cloned()
                    .collect();
                let projected_sources: Vec<_> = final_catalog["sources"]
                    .as_array()
                    .ok_or(ERR)?
                    .iter()
                    .filter(|v| v["id"].as_str().is_some_and(|id| source_ids.contains(id)))
                    .map(|v| {
                        let mut source = v.clone();
                        if source["allowHttp"] == false {
                            source.as_object_mut().unwrap().remove("allowHttp");
                        }
                        source
                    })
                    .collect();
                if projected_channels.len() != ids.len()
                    || projected_channels.len() > max_rows
                    || projected_sources.len() != source_ids.len()
                    || projected_sources.len() > 100
                {
                    return Err(ERR.into());
                }
                let health =
                    serde_json::to_string(&json!({"schemaVersion":1,"records":incoming_health}))
                        .map_err(|_| ERR)?;
                crate::health_storage::parse(&health)?;
                (
                    pair,
                    validated,
                    Some(health),
                    ids_groups,
                    projected_channels,
                    projected_sources,
                )
            };
        let mutation = crate::scan_checkpoint::Mutation::Advance {
            job_id: field(header, "jobId")?.into(),
            review_digest: field(header, "reviewDigest")?.into(),
            observations,
            published_keys,
        };
        let receipt = Self::apply_scan_transaction(
            &tx,
            &pair,
            health.as_deref(),
            (Some(cr), Some(hr)),
            Some((&mutation, cp, now)),
            PairReuse {
                validated,
                before: Some(old),
                projection_ids: Some(projection_ids),
                health_groups: None,
                observer: None,
            },
            phase,
        )?;
        // Advance, canonical publication and private snapshot evidence are one
        // durable operation. Any stale mapping/proof rolls all three back.
        for row in rows {
            phase(Phase::BeforeCommit)?;
            super::source_snapshot::record_activation_evidence_in_transaction(
                &tx,
                header,
                row.original_index,
                row.metadata,
                row.urls,
                row.observation,
            )?;
        }
        let after = Fence {
            root_generation,
            catalog: crate::scan_checkpoint::revision(&receipt.catalog_revision)?,
            health: crate::scan_checkpoint::revision(&receipt.health_revision)?,
            checkpoint: crate::scan_checkpoint::revision(
                receipt.checkpoint_revision.as_deref().ok_or(ERR)?,
            )?,
        };
        let projection = PublicationProjection {
            schema_version: if rows.len() > 64 { 2 } else { 1 },
            catalog_revision: receipt.catalog_revision.clone(),
            health_revision: receipt.health_revision.clone(),
            checkpoint_revision: receipt.checkpoint_revision.clone().ok_or(ERR)?,
            channels: projected_channels,
            sources: projected_sources,
            after,
        };
        serde_json::to_writer(&mut Bound(0), &projection)
            .map_err(|_| "scan-resume-commit-too-large")?;
        // Every tuple is now admitted by actual CP Advance against exact original metadata.
        // Normalize order privately; the proof is constructed only AFTER durable COMMIT.
        tuples.sort_by_key(|v| v[0].as_u64().unwrap_or(u64::MAX));
        published_indices.sort_unstable();
        sql(tx.commit())?;
        let _ = phase(Phase::AfterCommit);
        Ok(Committed {
            receipt,
            projection,
            delta: CommittedDelta {
                version: if rows.len() > 64 { 2 } else { 1 },
                base,
                after,
                observation_tuples: tuples,
                published_indices,
            },
        })
    }
}
#[cfg(test)]
#[path = "storage_resume_commit_tests.rs"]
mod tests;
