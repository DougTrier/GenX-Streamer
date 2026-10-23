//! One joined acquisition owner; no SQLite lease crosses platform decryption.
use crate::{
    scan_candidate_manifest::{origin_directory, AuthenticatedPage},
    scan_checkpoint::resume_plan::{Fence, PageInput, Row},
    scan_manifest_work::Context,
    scan_resume_registry::{Lease, Registry},
    scan_resume_runtime::{Episode, HeldCandidate},
    storage_transaction::resume_page::CachedResumePage,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{future::Future, sync::Arc, time::Duration};
use zeroize::Zeroizing;
const ERR: &str = "scan-resume-take-invalid";
const CACHE_BYTES: usize = 20 * 1024 * 1024;
const RESPONSE_BYTES: usize = 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Take {
    pub schema_version: u8,
    pub plan_id: String,
    pub limit: usize,
    pub blocked_origins: Vec<String>,
    pub take_timing_version: Option<u8>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplyRow {
    #[serde(flatten)]
    pub row: Row,
    pub origin_token: String,
    pub reservation_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reply {
    pub schema_version: u8,
    pub plan_id: String,
    pub rows: Vec<ReplyRow>,
    pub exhausted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity_blocked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cooling_delay_ms: Option<u64>,
}
fn origin(text: &str) -> Result<[u8; 32], String> {
    if text.len() != 64
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ERR.into());
    }
    let mut result = [0; 32];
    for (i, pair) in text.as_bytes().chunks_exact(2).enumerate() {
        let d = |b| if b <= b'9' { b - b'0' } else { b - b'a' + 10 };
        result[i] = d(pair[0]) * 16 + d(pair[1]);
    }
    Ok(result)
}
fn token(value: &[u8; 32]) -> String {
    value.iter().map(|b| format!("{b:02x}")).collect()
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
struct Taking<'a> {
    lease: &'a Lease<Episode>,
    unreturned: Vec<String>,
}
impl Drop for Taking<'_> {
    fn drop(&mut self) {
        let _ = self.lease.settle(|episode| {
            // No probes were started by take. Cleanup remains legal after late close.
            let result = if self.unreturned.is_empty() {
                Ok(())
            } else {
                episode.scheduler.release(&self.unreturned)
            };
            if result.is_err() {
                episode.quarantine();
            }
            episode.taking = false;
            result
        });
    }
}
// The original Take retains this single page, not the episode/ACK state. A
// replacement drops/zeroizes the previous page before acquisition. Every cache
// hit invokes fresh authority/image verification; it never owns a SQLite lease.
async fn request_local_page<Acquire, Acquired, Verify, Verified>(
    cached: Option<CachedResumePage>,
    fence: Fence,
    job: &str,
    digest: &str,
    index: usize,
    acquire: Acquire,
    verify: Verify,
) -> Result<(CachedResumePage, AuthenticatedPage), String>
where
    Acquire: FnOnce() -> Acquired,
    Acquired: Future<Output = Result<CachedResumePage, String>>,
    Verify: FnOnce(CachedResumePage) -> Verified,
    Verified: Future<Output = Result<(CachedResumePage, AuthenticatedPage), String>>,
{
    let current = match cached {
        Some(page) if page.matches(fence, job, digest, index) => page,
        old => {
            drop(old);
            acquire().await?
        }
    };
    verify(current).await
}
pub(crate) async fn take(
    request: Take,
    registry: Arc<Registry<Episode>>,
    context: Arc<Context>,
    app: tauri::AppHandle,
) -> Result<Reply, String> {
    let lease = registry.acquire(&request.plan_id)?;
    let checking = context.clone();
    let cached = Arc::new(tokio::sync::Mutex::new(None::<CachedResumePage>));
    take_with(
        request,
        lease,
        move |fence, job, digest, index| {
            let context = context.clone();
            let app = app.clone();
            let cached = cached.clone();
            async move {
                context.check()?;
                let old = cached.lock().await.take();
                let acquiring = context.clone();
                let verifying = context.clone();
                let acquire_job = job.clone();
                let acquire_digest = digest.clone();
                let verify_job = job.clone();
                let verify_digest = digest.clone();
                let (page, selected) = request_local_page(
                    old,
                    fence,
                    &job,
                    &digest,
                    index,
                    move || async move {
                        let (proof, _) = acquiring
                            .storage(Some(fence.root_generation), move |store, check| {
                                store.prepare_scan_resume_page(
                                    fence,
                                    &acquire_job,
                                    &acquire_digest,
                                    index,
                                    check,
                                )
                            })
                            .await?;
                        let mut plaintext = Zeroizing::new(
                            crate::protect_scan_manifest_page(
                                app,
                                proof.encrypted_page.binding.clone(),
                                proof.encrypted_page.ciphertext.clone(),
                                true,
                            )
                            .await?,
                        );
                        acquiring.check()?;
                        let (page, _) = acquiring
                            .storage(Some(fence.root_generation), move |store, check| {
                                store.finish_cached_scan_resume_page(
                                    proof,
                                    std::mem::take(&mut *plaintext),
                                    check,
                                )
                            })
                            .await?;
                        acquiring.check()?;
                        Ok(page)
                    },
                    move |page| async move {
                        let ((page, selected), _) = verifying
                            .storage(Some(fence.root_generation), move |store, check| {
                                let selected = store.verify_cached_scan_resume_page(
                                    &page,
                                    fence,
                                    &verify_job,
                                    &verify_digest,
                                    index,
                                    check,
                                )?;
                                Ok((page, selected))
                            })
                            .await?;
                        verifying.check()?;
                        Ok((page, selected))
                    },
                )
                .await?;
                context.check()?;
                *cached.lock().await = Some(page);
                Ok(selected)
            }
        },
        move || checking.check(),
    )
    .await
}
async fn take_with<F, Fut, C>(
    request: Take,
    lease: Lease<Episode>,
    hydrate: F,
    check: C,
) -> Result<Reply, String>
where
    F: FnMut(Fence, String, String, usize) -> Fut,
    Fut: Future<Output = Result<AuthenticatedPage, String>>,
    C: Fn() -> Result<(), String>,
{
    take_with_timing(request, lease, hydrate, check, now, |delay| {
        tokio::time::sleep(Duration::from_millis(delay))
    })
    .await
}
// The original command/lease owns every timer and hydration until settlement.
// A cooling origin is neither exhausted work nor a capacity refusal. Waiting
// does not hold the actor mutex or any SQLite lease. The bounded timer slices
// only recheck cancellation; they do not issue repeated Take IPC/network work.
async fn take_with_timing<F, Fut, C, Clock, Wait, Waiting>(
    request: Take,
    lease: Lease<Episode>,
    mut hydrate: F,
    check: C,
    mut clock: Clock,
    mut wait: Wait,
) -> Result<Reply, String>
where
    F: FnMut(Fence, String, String, usize) -> Fut,
    Fut: Future<Output = Result<AuthenticatedPage, String>>,
    C: Fn() -> Result<(), String>,
    Clock: FnMut() -> u64,
    Wait: FnMut(u64) -> Waiting,
    Waiting: Future<Output = ()>,
{
    if request
        .take_timing_version
        .is_some_and(|v| v != 1 || request.schema_version != 2)
        || !matches!(request.schema_version, 1 | 2)
        || !(1..=crate::scan_resume_owner::MAX_ACTIVE_PROBES).contains(&request.limit)
        || request.blocked_origins.len() > crate::scan_resume_owner::MAX_ACTIVE_PROBES
    {
        return Err(ERR.into());
    }
    let blocked = request
        .blocked_origins
        .iter()
        .map(|o| origin(o))
        .collect::<Result<Vec<_>, _>>()?;
    check()?;
    let (fence, job, digest) = lease.with(|episode| {
        if episode.taking {
            return Err("scan-resume-take-busy".into());
        }
        if episode.quarantined {
            return Err("scan-resume-plan-quarantined".into());
        }
        // Legacy admission refuses the complete requested batch at this boundary.
        // Only the negotiated route may return a smaller capacity-fitting prefix.
        if request.schema_version == 1 && episode.cache.len() + request.limit > 256 {
            return Err("scan-resume-cache-full".into());
        }
        let captured = (
            episode.plan.fence(),
            episode.plan.header()["jobId"]
                .as_str()
                .ok_or(ERR)?
                .to_owned(),
            episode.plan.header()["reviewDigest"]
                .as_str()
                .ok_or(ERR)?
                .to_owned(),
        );
        episode.taking = true;
        Ok(captured)
    })?;
    let mut guard = Taking {
        lease: &lease,
        unreturned: Vec::new(),
    };
    let mut previous_time = None;
    let mut waited_ms = 0u64;
    let mut cooling_delay_ms = None;
    let mut capacity_pressure = false;
    let reservations = loop {
        check()?;
        lease.check()?;
        let current = clock();
        if previous_time.is_some_and(|previous| current < previous) {
            return Err("scan-resume-clock-invalid".into());
        }
        previous_time = Some(current);
        let (reservations, cooling, pressure) = lease.with(|episode| {
            if episode.quarantined {
                return Err("scan-resume-plan-quarantined".into());
            }
            episode.plan.check_fence(fence, current)?;
            let slots = request
                .limit
                .min(256usize.saturating_sub(episode.cache.len()));
            let reservations = if slots == 0 {
                Vec::new()
            } else {
                episode.scheduler.reserve(
                    slots,
                    &blocked,
                    current,
                    crate::scan_resume_runtime::plan_id,
                )?
            };
            let cooling = if reservations.is_empty()
                && slots > 0
                && (request.take_timing_version == Some(1) || episode.cache.is_empty())
            {
                episode.scheduler.cooling_delay(&blocked, current)?
            } else {
                None
            };
            Ok((reservations, cooling, slots == 0))
        })?;
        capacity_pressure |= pressure;
        let Some(delay) = cooling else {
            break reservations;
        };
        if request.take_timing_version == Some(1) {
            cooling_delay_ms = Some(delay);
            break reservations;
        }
        let slice = delay.min(20);
        waited_ms = waited_ms
            .checked_add(slice)
            .filter(|total| *total <= 60_000)
            .ok_or("scan-resume-clock-invalid")?;
        wait(slice).await;
    };
    guard.unreturned = reservations.iter().map(|r| r.id.clone()).collect();
    let had_reservations = !reservations.is_empty();
    let mut held = Vec::<HeldCandidate>::new();
    let mut reply = Reply {
        schema_version: 1,
        plan_id: request.plan_id,
        rows: Vec::new(),
        exhausted: false,
        capacity_blocked: None,
        cooling_delay_ms,
    };
    for reservation in reservations {
        check()?;
        lease.check()?;
        let page = hydrate(fence, job.clone(), digest.clone(), reservation.ordinal).await?;
        check()?;
        lease.check()?;
        let offset = reservation
            .ordinal
            .checked_sub(page.page.start_index)
            .ok_or(ERR)?;
        let metadata = page.metadata.get(offset).ok_or(ERR)?;
        let entry = page.page.entries.get(offset).ok_or(ERR)?;
        if entry.candidate_index != reservation.ordinal {
            return Err(ERR.into());
        }
        let row = lease.with(|episode| {
            let expected = episode.origins.get(&reservation.ordinal).ok_or(ERR)?;
            if expected.origin_token != reservation.origin
                || origin_directory::origin_token(entry.urls.first().ok_or(ERR)?)?
                    != reservation.origin
            {
                return Err("scan-origin-binding-mismatch".into());
            }
            episode
                .plan
                .verify_original(reservation.ordinal, metadata, &entry.urls)?;
            let mut rows = episode
                .plan
                .page(
                    PageInput {
                        fence,
                        now: now(),
                        start: reservation.ordinal,
                        metadata: std::slice::from_ref(metadata),
                        entries: std::slice::from_ref(entry),
                    },
                    &mut || check(),
                )?
                .rows;
            if rows.len() != 1 {
                return Err("scan-resume-candidate-stale".into());
            }
            Ok(rows.remove(0))
        })?;
        let bytes = serde_json::to_vec(
            &json!({"row":&row,"metadata":metadata,"observation":&row.observation}),
        )
        .map_err(|_| ERR)?
        .len();
        let extra = held.iter().map(|h| h.bytes).sum::<usize>();
        let room = lease.with(|episode| {
            Ok(episode
                .cache_bytes
                .checked_add(extra)
                .and_then(|b| b.checked_add(bytes))
                .is_some_and(|b| b <= CACHE_BYTES))
        })?;
        if !room {
            capacity_pressure = true;
            break;
        }
        let response_row = Row {
            candidate_index: row.candidate_index,
            candidate: row.candidate.clone(),
            work: row.work,
            observation: row.observation.clone(),
        };
        reply.rows.push(ReplyRow {
            row: response_row,
            origin_token: token(&reservation.origin),
            reservation_id: reservation.id.clone(),
        });
        if serde_json::to_vec(&reply).map_err(|_| ERR)?.len() > RESPONSE_BYTES {
            reply.rows.pop();
            capacity_pressure = true;
            break;
        }
        let observation = row.observation.clone();
        // Retain only selected metadata and URL rows, never the complete page.
        held.push(HeldCandidate {
            reservation,
            row,
            metadata: metadata.clone(),
            observation,
            bytes,
        });
    }
    check()?;
    lease.check()?;
    if reply.rows.is_empty() {
        let can_free_capacity = lease.with(|episode| Ok(!episode.cache.is_empty()))?;
        if request.schema_version == 2
            && can_free_capacity
            && (request.take_timing_version.is_none() || capacity_pressure)
        {
            reply.capacity_blocked = Some(true);
            reply.cooling_delay_ms = None;
        } else if had_reservations {
            return Err(if request.schema_version == 2 {
                "scan-resume-candidate-too-large"
            } else {
                "scan-resume-cache-full"
            }
            .into());
        }
    }
    lease.with(|episode| {
        episode.plan.check_fence(fence, now())?;
        if episode.quarantined {
            return Err("scan-resume-plan-quarantined".into());
        }
        for candidate in &held {
            if episode.cache.contains_key(&candidate.reservation.ordinal) {
                return Err("scan-resume-cache-conflict".into());
            }
        }
        for candidate in held {
            guard
                .unreturned
                .retain(|id| id != &candidate.reservation.id);
            episode.cache_bytes += candidate.bytes;
            episode
                .cache
                .insert(candidate.reservation.ordinal, candidate);
        }
        if !guard.unreturned.is_empty() {
            episode.scheduler.release(&guard.unreturned)?;
            guard.unreturned.clear();
        }
        reply.exhausted = reply.capacity_blocked.is_none()
            && reply.cooling_delay_ms.is_none()
            && episode.scheduler.exhausted();
        Ok(())
    })?;
    Ok(reply)
}
#[cfg(test)]
#[path = "scan_resume_take_tests.rs"]
mod tests;
