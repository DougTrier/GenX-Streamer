//! Joined, episode-only release/defer. Neither operation changes durable scan progress.
use crate::{scan_resume_registry::Registry, scan_resume_runtime::Episode};
use serde::Deserialize;
use std::{collections::HashSet, sync::Arc};
const ERR: &str = "scan-resume-release-invalid";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Release {
    pub schema_version: u8,
    pub plan_id: String,
    pub reservation_ids: Vec<String>,
}
pub(crate) fn release(
    registry: Arc<Registry<Episode>>,
    request: Release,
    defer: bool,
) -> Result<(), String> {
    if request.schema_version != 1
        || request.reservation_ids.is_empty()
        || request.reservation_ids.len() > 256
    {
        return Err(ERR.into());
    }
    let ids: HashSet<_> = request.reservation_ids.iter().collect();
    if ids.len() != request.reservation_ids.len()
        || ids.iter().any(|id| {
            id.len() != 64
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return Err(ERR.into());
    }
    let lease = registry.acquire(&request.plan_id)?;
    lease.with(|episode| {
        let removed: Vec<_> = episode
            .cache
            .iter()
            .filter(|(_, held)| ids.contains(&held.reservation.id))
            .map(|(index, held)| (*index, held.bytes))
            .collect();
        let bytes = removed
            .iter()
            .try_fold(0usize, |sum, (_, bytes)| sum.checked_add(*bytes).ok_or(ERR))?;
        let after = episode.cache_bytes.checked_sub(bytes).ok_or(ERR)?;
        // Scheduler validates the entire list, including actual transport settlement,
        // before mutation. Release accepts bounded actual-ACK tombstones idempotently.
        if defer {
            episode.scheduler.defer(&request.reservation_ids)?;
        } else {
            episode.scheduler.release(&request.reservation_ids)?;
        }
        for (index, _) in removed {
            episode.cache.remove(&index);
        }
        episode.cache_bytes = after;
        Ok(())
    })
}
