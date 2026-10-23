//! Retained native state for one authenticated resume episode.
use crate::{
    scan_candidate_manifest::origin_directory::{AdmittedDirectory, OriginRow},
    scan_checkpoint::resume_plan::{Plan, Row},
    scan_resume_owner::{Reservation, Scheduler, Work},
};
use serde::Deserialize;
use std::collections::HashMap;
#[path = "scan_probe_memo.rs"]
pub(crate) mod probe_memo;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Open {
    pub schema_version: u8,
    pub expected_catalog_revision: String,
    pub expected_checkpoint_revision: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Close {
    pub schema_version: u8,
    pub plan_id: String,
}
pub(crate) struct Episode {
    pub plan: Plan,
    pub scheduler: Scheduler,
    pub origins: HashMap<usize, OriginRow>,
    pub cache: HashMap<usize, HeldCandidate>,
    pub cache_bytes: usize,
    pub taking: bool,
    pub latest_projection:
        Option<crate::storage_transaction::storage_resume_commit::PublicationProjection>,
    pub quarantined: bool,
    pub transport_memo: probe_memo::Memo,
    /// Consecutive connection-level failures per site in this episode.
    pub origin_failures: HashMap<crate::scan_resume_owner::Origin, u8>,
}
pub(crate) struct HeldCandidate {
    pub reservation: Reservation,
    pub row: Row,
    pub metadata: serde_json::Value,
    pub observation: Option<serde_json::Value>,
    pub bytes: usize,
}
impl Episode {
    pub(crate) fn quarantine(&mut self) {
        self.transport_memo.clear();
        self.quarantined = true;
    }
    pub(crate) fn admitted(plan: Plan, directory: AdmittedDirectory) -> Result<Self, String> {
        plan.validate_directory(&directory)?;
        let mut pending = Vec::new();
        let mut origins = HashMap::new();
        for row in directory.rows {
            if let Some(work) = plan.pending_work(row.ordinal) {
                pending.push((
                    row.ordinal,
                    row.origin_token,
                    match work {
                        "probe" => Work::Probe,
                        "publish" => Work::Publish,
                        _ => return Err("scan-resume-work-invalid".into()),
                    },
                ));
            }
            if origins.insert(row.ordinal, row).is_some() {
                return Err("scan-origin-order-invalid".into());
            }
        }
        let scheduler = Scheduler::new(pending)?;
        Ok(Self {
            plan,
            scheduler,
            origins,
            cache: HashMap::new(),
            cache_bytes: 0,
            taking: false,
            latest_projection: None,
            quarantined: false,
            transport_memo: probe_memo::Memo::default(),
            origin_failures: HashMap::new(),
        })
    }
}

pub(crate) fn plan_id() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "scan-resume-random-failed")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
