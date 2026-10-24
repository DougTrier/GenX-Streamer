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

//! Retained native commit owner. IPC carries only ordinal-bound observation echoes.
use crate::{
    scan_checkpoint::resume_plan::{Counts, Fence, Plan},
    scan_manifest_work::Context,
    scan_resume_registry::{Lease, Registry},
    scan_resume_runtime::Episode,
    storage_transaction::storage_resume_commit::{CheckedRow, Committed},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc};
const ERR: &str = "scan-resume-commit-invalid";
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Revisions {
    pub catalog_revision: String,
    pub health_revision: String,
    pub checkpoint_revision: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Observation {
    pub candidate_index: usize,
    pub observation: Value,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Commit {
    pub schema_version: u8,
    pub plan_id: String,
    pub expected_revisions: Revisions,
    pub observations: Vec<Observation>,
    pub publication_indices: Vec<usize>,
}
fn validate(request: &Commit) -> Result<(), String> {
    let max_rows = match request.schema_version {
        1 => 64,
        2 => 240,
        _ => return Err(ERR.into()),
    };
    if request.plan_id.len() != 64
        || !request
            .plan_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || request.observations.is_empty()
        || request.observations.len() > max_rows
        || request.publication_indices.len() > max_rows
    {
        return Err(ERR.into());
    }
    let mut seen = HashSet::new();
    for row in &request.observations {
        if row.candidate_index >= 100_000 || !seen.insert(row.candidate_index) {
            return Err(ERR.into());
        }
    }
    let mut publications = HashSet::new();
    for index in &request.publication_indices {
        if !seen.contains(index) || !publications.insert(*index) {
            return Err(ERR.into());
        }
    }
    for revision in [
        &request.expected_revisions.catalog_revision,
        &request.expected_revisions.health_revision,
        &request.expected_revisions.checkpoint_revision,
    ] {
        crate::scan_checkpoint::revision(revision)?;
    }
    // Bounded admission without building a second aggregate payload string.
    struct Limit(usize);
    impl std::io::Write for Limit {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > (1024 * 1024usize).saturating_sub(self.0) {
                return Err(std::io::ErrorKind::InvalidInput.into());
            }
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(&mut Limit(0), request).map_err(|_| ERR.to_string())
}
fn fence_matches(request: &Commit, fence: Fence) -> bool {
    request.expected_revisions.catalog_revision == fence.catalog.to_string()
        && request.expected_revisions.health_revision == fence.health.to_string()
        && request.expected_revisions.checkpoint_revision == fence.checkpoint.to_string()
}
fn prospective(plan: &Plan, request: &Commit) -> Result<Counts, String> {
    let mut counts = plan.counts();
    for row in &request.observations {
        let positive = matches!(
            row.observation["verdict"].as_str(),
            Some("Reachable" | "PlayedHere")
        );
        match plan.pending_work(row.candidate_index) {
            Some("probe") => {
                counts.checked = counts.checked.checked_add(1).ok_or(ERR)?;
                if positive {
                    counts.responded = counts.responded.checked_add(1).ok_or(ERR)?;
                }
            }
            Some("publish") if positive => (),
            _ => return Err("scan-resume-progress-conflict".into()),
        }
        if request.publication_indices.contains(&row.candidate_index) {
            if !positive {
                return Err(ERR.into());
            }
            counts.published = counts.published.checked_add(1).ok_or(ERR)?;
        }
    }
    if counts.published > counts.responded
        || counts.responded > counts.checked
        || counts.checked > counts.total
    {
        return Err(ERR.into());
    }
    Ok(counts)
}
/// Producer/request/WorkGuard ownership is retained by Context and the registry lease.
pub(crate) async fn commit(
    owner: Arc<Context>,
    registry: Arc<Registry<Episode>>,
    request: Commit,
) -> Result<Value, String> {
    validate(&request)?;
    owner.check()?;
    let lease = registry.acquire(&request.plan_id)?;
    let generation = lease.with(|episode| Ok(episode.plan.fence().root_generation))?;
    let (ack, _) = owner
        .storage_with_generation(Some(generation), move |store, generation, check| {
            execute(&lease, &request, |plan, rows| {
                if request.schema_version == 2 {
                    store.commit_scan_resume_window_selection(plan, generation, rows, || {
                        check()?;
                        lease.check()
                    })
                } else {
                    store.commit_scan_resume_selection(plan, generation, rows, || {
                        check()?;
                        lease.check()
                    })
                }
            })
        })
        .await?;
    Ok(ack)
}
/// Shared with controlled real-SQL tests; the supplied operation is the actual atomic core.
fn execute(
    lease: &Lease<Episode>,
    request: &Commit,
    mut write: impl FnMut(&Plan, &[CheckedRow<'_>]) -> Result<Committed, String>,
) -> Result<Value, String> {
    execute_observing_unlock(lease, request, &mut write, || {})
}
// The observer is private native test scheduling, never an IPC authority input.
// Production passes an empty closure; the exact unlocked boundary remains testable.
fn execute_observing_unlock(
    lease: &Lease<Episode>,
    request: &Commit,
    mut write: impl FnMut(&Plan, &[CheckedRow<'_>]) -> Result<Committed, String>,
    after_unlock: impl FnOnce(),
) -> Result<Value, String> {
    validate(request)?;
    let ack = lease.with(|episode| {
        if episode.quarantined {
            return Err("scan-resume-plan-quarantined".into());
        }
        if episode.taking {
            return Err("scan-resume-owner-busy".into());
        }
        if !fence_matches(request, episode.plan.fence()) {
            return Err("scan-resume-commit-stale".into());
        }
        if episode.cache.len() > 256
            || episode
                .cache
                .values()
                .try_fold(0usize, |n, v| n.checked_add(v.bytes))
                .ok_or(ERR)?
                != episode.cache_bytes
            || episode.cache_bytes > 20 * 1024 * 1024
        {
            return Err(ERR.into());
        }
        let counts = prospective(&episode.plan, request)?;
        let mut ids = Vec::with_capacity(request.observations.len());
        let mut urls = Vec::with_capacity(request.observations.len());
        for item in &request.observations {
            let held = episode.cache.get(&item.candidate_index).ok_or(ERR)?;
            if held.row.candidate_index != item.candidate_index
                || held.reservation.ordinal != item.candidate_index
                || held.observation.as_ref() != Some(&item.observation)
                || item.observation["channelId"] != held.metadata["key"]
                || item.observation["sourceId"] != held.metadata["sourceId"]
                || item.observation["fingerprint"] != held.metadata["sourceFingerprint"]
                || item.observation["platform"] != episode.plan.header()["platform"]
                || matches!(
                    item.observation["verdict"].as_str(),
                    None | Some("NotChecked" | "Canceled")
                )
            {
                return Err(ERR.into());
            }
            let reservation = episode.scheduler.reservation(&held.reservation.id)?;
            if reservation.ordinal != item.candidate_index {
                return Err(ERR.into());
            }
            ids.push(held.reservation.id.clone());
            urls.push(zeroize::Zeroizing::new(
                held.row.candidate["channel"]["urls"]
                    .as_array()
                    .ok_or(ERR)?
                    .iter()
                    .map(|v| v.as_str().map(str::to_owned).ok_or(ERR))
                    .collect::<Result<Vec<_>, _>>()?,
            ));
        }
        let rows: Vec<_> = request
            .observations
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let held = &episode.cache[&item.candidate_index];
                CheckedRow {
                    original_index: item.candidate_index,
                    metadata: &held.metadata,
                    urls: &urls[i],
                    observation: held.observation.as_ref().unwrap(),
                    publish: request.publication_indices.contains(&item.candidate_index),
                }
            })
            .collect();
        let republish: Vec<_> = request
            .observations
            .iter()
            .filter(|v| {
                matches!(
                    v.observation["verdict"].as_str(),
                    Some("Reachable" | "PlayedHere")
                ) && !request.publication_indices.contains(&v.candidate_index)
            })
            .map(|v| v.candidate_index)
            .collect();
        episode
            .scheduler
            .validate_acknowledgment(&ids, &republish)?;
        let committed = write(&episode.plan, &rows)?;
        // SQL and private-plan settlement share this actor mutex. A peer probe
        // must never observe committed SQL with the preceding private fence.
        // No cancellation/error propagation is allowed after durable COMMIT.
        let ack = json!({"committed":true,"planId":request.plan_id,"catalogRevision":committed.receipt.catalog_revision,
        "healthRevision":committed.receipt.health_revision,"checkpointRevision":committed.receipt.checkpoint_revision,
        "acknowledgedIndices":request.observations.iter().map(|v|v.candidate_index).collect::<Vec<_>>(),
        "publicationIndices":request.publication_indices,"counts":counts});
        let updated = episode
            .plan
            .accept_delta(&committed.receipt, &committed.delta);
        let acknowledged = episode
            .scheduler
            .acknowledge_and_requeue_publish(&ids, &republish);
        if updated.is_err() || acknowledged.is_err() || episode.plan.counts() != counts {
            episode.quarantine();
        }
        for item in &request.observations {
            if let Some(held) = episode.cache.remove(&item.candidate_index) {
                match episode.cache_bytes.checked_sub(held.bytes) {
                    Some(bytes) => episode.cache_bytes = bytes,
                    None => {
                        episode.cache_bytes = 0;
                        episode.quarantine();
                    }
                }
                // Row::drop wipes original stream URLs, including late closing settlement.
                drop(held);
            } else {
                episode.quarantine();
            }
        }
        episode.latest_projection = Some(committed.projection);
        Ok(ack)
    })?;
    after_unlock();
    Ok(ack)
}
#[cfg(test)]
pub(crate) fn commit_for_test(
    lease: &Lease<Episode>,
    request: &Commit,
    store: &crate::storage_transaction::PairStore,
) -> Result<Value, String> {
    execute(lease, request, |plan, rows| {
        if request.schema_version == 2 {
            store.commit_scan_resume_window_selection(
                plan,
                plan.fence().root_generation,
                rows,
                || lease.check(),
            )
        } else {
            store.commit_scan_resume_selection(plan, plan.fence().root_generation, rows, || {
                lease.check()
            })
        }
    })
}
#[cfg(test)]
#[path = "scan_resume_commit_owner_tests.rs"]
mod tests;
