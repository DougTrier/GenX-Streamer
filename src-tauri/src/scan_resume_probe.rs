//! Native-only response checks reuse the existing media-resource inspection policy.
//! The origin reservation is released only after actual transport settlement.
use crate::{
    network_media_probe,
    scan_candidate_manifest::origin_directory,
    scan_manifest_work::Context,
    scan_resume_registry::{Lease, Registry},
    scan_resume_runtime::{
        probe_memo::{Key, Recognized},
        Episode,
    },
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;
const ERR: &str = "scan-resume-probe-invalid";
/// Scan triage (owner design, October 21, 2026): the automatic scan's checks
/// (its 20 s budget) must get a first answer within 3 s, or the stream goes to
/// the Slow list. The Slow pass and manual reviews use 45 or 60 s and are
/// never triaged.
pub(crate) const TRIAGE_BUDGET_MS: u64 = 20_000;
pub(crate) const FIRST_RESPONSE_MS: u64 = 3_000;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Probe {
    pub schema_version: u8,
    pub plan_id: String,
    pub candidate_key: String,
}
fn now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .map_err(|_| "scan-resume-clock-invalid".into())
}
struct Probing<'a> {
    lease: &'a Lease<Episode>,
    reservation_id: String,
    settled: bool,
}
impl Drop for Probing<'_> {
    fn drop(&mut self) {
        if !self.settled {
            let result = self.lease.settle(|episode| {
                episode
                    .scheduler
                    .finish_probe(&self.reservation_id, now()?, 0)
            });
            if result.is_err() {
                let _ = self.lease.settle(|episode| {
                    episode.quarantine();
                    Ok(())
                });
            }
        }
    }
}
fn evidence(result: &Result<network_media_probe::Inspection, String>) -> (Value, &'static str) {
    match result {
        Ok(value)
            if value
                .http_status
                .is_some_and(|status| !(200..300).contains(&status)) =>
        {
            let status = value.http_status.unwrap();
            (
                json!({"kind":"http","status":status}),
                if [401, 403, 451].contains(&status) {
                    "AccessDenied"
                } else if status >= 400 {
                    "TemporaryUnavailable"
                } else {
                    "NotChecked"
                },
            )
        }
        Ok(value) if value.status == "resources-responded" => (
            json!({"kind":"http","status":200,"contentRecognized":true}),
            "Reachable",
        ),
        // Slower than the triage: not judged, kept for the Slow pass.
        Ok(value)
            if value.status == "unavailable" && value.reason_code == "slow-first-response" =>
        {
            (json!({"kind":"slow"}), "TimedOut")
        }
        Ok(value) if value.status == "unavailable" && value.reason_code == "timeout" => {
            (json!({"kind":"timeout"}), "TimedOut")
        }
        Ok(value) if value.status == "unavailable" && value.http_status.is_none() => {
            (json!({"kind":"network-failure"}), "TemporaryUnavailable")
        }
        Ok(_) => (json!({"kind":"unsupported"}), "UnsupportedHere"),
        Err(error) if error == "timeout" => (json!({"kind":"timeout"}), "TimedOut"),
        Err(error) if error == "canceled" => (json!({"kind":"canceled"}), "Canceled"),
        Err(_) => (json!({"kind":"network-failure"}), "TemporaryUnavailable"),
    }
}
fn retry_after(value: &network_media_probe::Inspection, observed_at: u64) -> u64 {
    if !matches!(value.http_status, Some(429 | 503)) {
        return 0;
    }
    let Some(raw) = value.retry_after.as_deref() else {
        return 0;
    };
    let raw = raw.trim();
    if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        return raw
            .parse::<u64>()
            .unwrap_or(u64::MAX)
            .saturating_mul(1000)
            .min(60_000);
    }
    chrono::DateTime::parse_from_rfc2822(raw)
        .ok()
        .and_then(|value| u64::try_from(value.timestamp_millis()).ok())
        .map(|value| value.saturating_sub(observed_at).min(60_000))
        .unwrap_or(0)
}
struct Receipt {
    evidence: Value,
    verdict: &'static str,
    observed_at: u64,
    settled_at: u64,
    cooldown: u64,
    recognized: Option<Recognized>,
    inspected: bool,
    /// The site could not be reached at all (name, connection or TLS).
    connection_failed: bool,
}
/// Host-aware judging (owner design, October 21, 2026): after this many
/// connection-level failures in a row on a site, the scan's remaining streams
/// there are settled as no-answer ("host-down") without a request.
pub(crate) const HOST_DOWN_AFTER: u8 = 2;
fn connection_failed(result: &Result<network_media_probe::Inspection, String>) -> bool {
    matches!(result, Ok(value) if value.http_status.is_none()
        && matches!(value.reason_code, "dns-failure" | "connectivity-failure" | "tls-failure"))
}
/// Both actual inspections and memo hits pass through the same receipt boundary.
/// The inspector is lazy: a hit never constructs a transport or producer receipt.
async fn inspect_or_reuse<F, Fut>(
    cached: Option<Recognized>,
    budget: u64,
    inspect: F,
    clock: impl Fn() -> Result<u64, String>,
) -> Result<Receipt, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<network_media_probe::Inspection, String>>,
{
    let current = clock()?;
    if let Some(value) = cached.filter(|value| value.fresh(current, budget)) {
        return Ok(Receipt {
            evidence: json!({"kind":"http","status":200,"contentRecognized":true}),
            verdict: "Reachable",
            observed_at: value.observed_at,
            settled_at: current,
            cooldown: 0,
            recognized: Some(value),
            inspected: false,
            connection_failed: false,
        });
    }
    let result = inspect().await;
    let settled_at = clock()?;
    let cooldown = result
        .as_ref()
        .map(|value| retry_after(value, settled_at))
        .unwrap_or(0);
    let (evidence, verdict) = evidence(&result);
    let recognized = (verdict == "Reachable").then_some(Recognized {
        observed_at: settled_at,
    });
    Ok(Receipt {
        evidence,
        verdict,
        observed_at: settled_at,
        settled_at,
        cooldown,
        recognized,
        inspected: true,
        connection_failed: connection_failed(&result),
    })
}
fn bind(identity: &Value, receipt: &Receipt) -> Value {
    json!({"channelId":identity["channelId"],"sourceId":identity["sourceId"],"fingerprint":identity["fingerprint"],"platform":identity["platform"],"observedAt":receipt.observed_at,"evidence":receipt.evidence,"verdict":receipt.verdict})
}
pub(crate) async fn probe(
    request: Probe,
    registry: Arc<Registry<Episode>>,
    context: Arc<Context>,
) -> Result<Value, String> {
    probe_with_inspector(
        request,
        registry,
        context,
        |url, allow_http, request_id, budget| async move {
            let first = (budget == TRIAGE_BUDGET_MS).then_some(FIRST_RESPONSE_MS);
            network_media_probe::inspect_triaged(&url, allow_http, request_id, budget, first).await
        },
    )
    .await
}
async fn probe_with_inspector<F, Fut>(
    request: Probe,
    registry: Arc<Registry<Episode>>,
    context: Arc<Context>,
    inspect: F,
) -> Result<Value, String>
where
    F: FnOnce(Zeroizing<String>, bool, String, u64) -> Fut,
    Fut: std::future::Future<Output = Result<network_media_probe::Inspection, String>>,
{
    if request.schema_version != 1
        || request.candidate_key.is_empty()
        || request.candidate_key.len() > 256
    {
        return Err(ERR.into());
    }
    context.check()?;
    let lease = registry.acquire(&request.plan_id)?;
    let (index, reservation_id, url, identity, fence, allow_http, budget, memo_key, http_denied, origin, host_down) = lease.with(|episode| {
        if episode.quarantined { episode.transport_memo.clear(); return Err("scan-resume-owner-quarantined".into()); }
        episode.plan.check_fence(episode.plan.fence(), now()?)?;
        let mut found = episode.cache.iter().filter(|(_, held)| held.row.candidate["key"] == request.candidate_key);
        let (&index, held) = found.next().ok_or(ERR)?;
        if found.next().is_some() || held.observation.is_some() || held.row.work != "probe" { return Err(ERR.into()); }
        let current = episode.scheduler.reservation(&held.reservation.id)?;
        if current.ordinal != index || current.origin != held.reservation.origin { return Err(ERR.into()); }
        let url = held.row.candidate["channel"]["urls"][0].as_str().ok_or(ERR)?;
        if origin_directory::origin_token(url)? != current.origin { return Err("scan-origin-authentication-failed".into()); }
        let definition = episode.plan.header()["sourceDefinitions"].as_array().ok_or(ERR)?.iter()
            .find(|definition| definition["source"]["id"] == held.metadata["sourceId"]).ok_or(ERR)?;
        let allow_http = definition["source"]["allowHttp"].as_bool().unwrap_or(false);
        // Every retained alternative must be publishable under the captured
        // grant. A reachable HTTPS primary cannot authorize an HTTP fallback.
        let denied_alternative = held.row.candidate["channel"]["urls"].as_array().ok_or(ERR)?
            .iter().try_fold(false, |denied, value| -> Result<bool,String> {
                let parsed=reqwest::Url::parse(value.as_str().ok_or(ERR)?).map_err(|_| ERR)?;
                Ok(denied || (parsed.scheme()=="http" && !allow_http))
            })?;
        // Such a channel is settled as not playable here rather than refused:
        // a refusal is retried on every Continue, so the scan could never finish.
        let budget = episode.plan.header()["budgetMs"].as_u64().ok_or(ERR)?;
        let memo_key = Key::new(url, allow_http,
            episode.plan.header()["platform"].as_str().ok_or(ERR)?,
            episode.plan.header()["observerProfile"].as_str().ok_or(ERR)?, budget);
        Ok((index, current.id.clone(), Zeroizing::new(url.to_owned()),
            json!({"channelId":held.metadata["key"],"sourceId":held.metadata["sourceId"],"fingerprint":held.metadata["sourceFingerprint"],"platform":episode.plan.header()["platform"]}),
            episode.plan.fence(), allow_http,
            budget, memo_key, denied_alternative, current.origin,
            episode.origin_failures.get(&current.origin).is_some_and(|n| *n >= HOST_DOWN_AFTER)))
    })?;
    validate_current_authority(&registry, &context, &request.plan_id, fence.root_generation)
        .await?;
    context.check()?;
    lease.with(|episode| episode.scheduler.start_probe(&reservation_id))?;
    let mut guard = Probing {
        lease: &lease,
        reservation_id: reservation_id.clone(),
        settled: false,
    };
    // Recipient hydration, all alternative grants and current SQL authority were
    // checked above; the memo does not confer admission or publication authority.
    let cached = if http_denied {
        None
    } else {
        lease.with(|episode| Ok(episode.transport_memo.get(&memo_key, now()?, budget)))?
    };
    let cancel = async {
        loop {
            if context.check().is_err() || lease.check().is_err() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    let receipt = if http_denied {
        // Plain HTTP under a source without the HTTP grant: no request is made,
        // and the verdict can never publish the channel.
        let at = now()?;
        Receipt {
            evidence: json!({"kind":"unsupported"}),
            verdict: "UnsupportedHere",
            observed_at: at,
            settled_at: at,
            cooldown: 0,
            recognized: None,
            inspected: false,
            connection_failed: false,
        }
    } else if host_down {
        // The site failed to connect twice in a row in this scan: no request.
        let at = now()?;
        Receipt {
            evidence: json!({"kind":"host-down"}),
            verdict: "TemporaryUnavailable",
            observed_at: at,
            settled_at: at,
            cooldown: 0,
            recognized: None,
            inspected: false,
            connection_failed: false,
        }
    } else {
        inspect_or_reuse(
            cached,
            budget,
            || async {
                tokio::select! {
                    value = inspect(url, allow_http, reservation_id.clone(), budget) => value,
                    _ = cancel => Err("canceled".into()),
                }
            },
            now,
        )
        .await?
    };
    // The inspected future has settled or been dropped before any origin release.
    lease.settle(|episode| {
        episode
            .scheduler
            .finish_probe(&reservation_id, receipt.settled_at, receipt.cooldown)
    })?;
    guard.settled = true;
    context.check()?;
    lease.check()?;
    validate_current_authority(&registry, &context, &request.plan_id, fence.root_generation)
        .await?;
    let memo_now = now()?;
    let observation = bind(&identity, &receipt);
    lease.with(|episode| {
        if episode.quarantined {
            episode.transport_memo.clear();
            return Err("scan-resume-owner-quarantined".into());
        }
        let held = episode.cache.get_mut(&index).ok_or(ERR)?;
        if held.reservation.id != reservation_id || held.observation.is_some() {
            return Err(ERR.into());
        }
        let added = serde_json::to_vec(&observation).map_err(|_| ERR)?.len();
        let bytes = episode.cache_bytes.checked_add(added).ok_or(ERR)?;
        if bytes > 20 * 1024 * 1024 {
            return Err("scan-resume-cache-capacity".into());
        }
        held.observation = Some(observation.clone());
        held.bytes = held.bytes.checked_add(added).ok_or(ERR)?;
        episode.cache_bytes = bytes;
        if receipt.inspected {
            if receipt.connection_failed {
                let count = episode.origin_failures.entry(origin).or_insert(0);
                *count = count.saturating_add(1);
            } else {
                episode.origin_failures.remove(&origin);
            }
        }
        if let Some(recognized) = receipt
            .recognized
            .filter(|value| receipt.inspected && value.fresh(memo_now, budget))
        {
            episode.transport_memo.insert(memo_key, recognized);
        }
        Ok(())
    })?;
    Ok(observation)
}
async fn validate_current_authority(
    registry: &Arc<Registry<Episode>>,
    context: &Arc<Context>,
    plan_id: &str,
    generation: u64,
) -> Result<(), String> {
    let lease = registry.acquire(plan_id)?;
    context
        .storage(Some(generation), move |store, check| {
            lease.with(|episode| {
                if episode.quarantined {
                    episode.transport_memo.clear();
                    return Err("scan-resume-owner-quarantined".into());
                }
                // Only this actor's private actual-COMMIT proofs can advance its fences.
                // Serialize the small authority read against peer publication, so a
                // completed peer batch cannot invalidate an otherwise valid probe.
                // External SQL/source changes still refuse; no networking holds this lock.
                store.validate_scan_resume_authority(
                    episode.plan.fence(),
                    episode.plan.header(),
                    || {
                        check()?;
                        lease.check()
                    },
                )
            })
        })
        .await?;
    Ok(())
}

#[cfg(test)]
#[path = "scan_resume_probe_owned_tests.rs"]
mod owned_tests;
#[cfg(test)]
mod tests {
    use super::*;
    fn inspection(
        status: &'static str,
        reason_code: &'static str,
        http_status: Option<u16>,
    ) -> network_media_probe::Inspection {
        network_media_probe::Inspection {
            status,
            reason_code,
            checked_resources: 1,
            request_id: "fixture".into(),
            header_retry_count: 0,
            header_retry_reason: None,
            http_status,
            retry_after: None,
        }
    }
    #[test]
    fn resource_receipts_never_become_decoder_claims_and_failures_stay_contextual() {
        for (value, expected) in [
            (
                inspection("resources-responded", "media-resources-responded", None),
                "Reachable",
            ),
            (
                inspection("unavailable", "http-failure", Some(403)),
                "AccessDenied",
            ),
            (
                inspection("unavailable", "http-failure", Some(503)),
                "TemporaryUnavailable",
            ),
            (inspection("unavailable", "timeout", None), "TimedOut"),
            (
                inspection("unverified", "manifest-invalid", Some(200)),
                "UnsupportedHere",
            ),
        ] {
            assert_eq!(evidence(&Ok(value)).1, expected);
        }
        assert_eq!(evidence(&Err("canceled".into())).1, "Canceled");
    }
    #[test]
    fn retry_after_is_status_scoped_and_bounded_for_numeric_and_http_date() {
        let mut value = inspection("unavailable", "http-failure", Some(429));
        value.retry_after = Some("120".into());
        assert_eq!(retry_after(&value, 0), 60_000);
        value.retry_after = Some("1".into());
        assert_eq!(retry_after(&value, 0), 1000);
        value.retry_after = Some("Thu, 01 Jan 1970 00:00:02 GMT".into());
        assert_eq!(retry_after(&value, 1000), 1000);
        value.http_status = Some(200);
        assert_eq!(retry_after(&value, 0), 0);
    }
    #[tokio::test]
    async fn only_recognized_transport_success_is_memoizable_never_decoder_or_failure() {
        for result in [
            Ok(inspection("unavailable", "http-failure", Some(403))),
            Ok(inspection("unavailable", "http-failure", Some(503))),
            Ok(inspection("unavailable", "timeout", None)),
            Ok(inspection("unverified", "manifest-invalid", Some(200))),
            Ok(inspection("PlayedHere", "decoder-reported", Some(200))),
            Err("canceled".into()),
            Err("timeout".into()),
            Err("uncertain-cleanup".into()),
        ] {
            let receipt = inspect_or_reuse(None, 20_000, || async { result }, || Ok(100))
                .await
                .unwrap();
            assert!(receipt.recognized.is_none());
            assert!(receipt.inspected);
        }
        let receipt = inspect_or_reuse(
            None,
            20_000,
            || async {
                Ok(inspection(
                    "resources-responded",
                    "media-resources-responded",
                    None,
                ))
            },
            || Ok(100),
        )
        .await
        .unwrap();
        assert!(receipt.recognized.is_some());
        assert_eq!(receipt.verdict, "Reachable");
    }
    #[tokio::test]
    async fn expiry_between_lookup_and_settlement_falls_back_to_real_inspection() {
        use std::cell::Cell;
        for current in [99, 20_100] {
            let calls = Cell::new(0);
            let receipt = inspect_or_reuse(
                Some(Recognized { observed_at: 100 }),
                20_000,
                || async {
                    calls.set(calls.get() + 1);
                    Ok(inspection(
                        "resources-responded",
                        "media-resources-responded",
                        None,
                    ))
                },
                || Ok(current),
            )
            .await
            .unwrap();
            assert_eq!(calls.get(), 1);
            assert!(receipt.inspected);
            assert_eq!(receipt.observed_at, current);
        }
    }
}

/// Accuracy fixture for the Slow list (owner design, October 21, 2026): real
/// local servers that answer at once, answer late but play, or refuse. The
/// triage keeps the prompt one, sends the late ones to the Slow list and fails
/// the dead one; the Slow pass then saves the late ones and marks them Slow.
#[cfg(test)]
mod slow_list_accuracy_tests {
    use super::*;
    use rusqlite::{params, Connection};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn ts() -> Vec<u8> {
        let mut b = vec![0; 564];
        for i in [0, 188, 376] {
            b[i] = 0x47;
        }
        b
    }
    /// A server that answers every request after `delay_ms` with `status`
    /// (0: hangs up without answering).
    async fn serve(delay_ms: u64, status: u16) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut request = [0; 4096];
                    if socket.read(&mut request).await.unwrap_or(0) == 0 {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    if status == 0 {
                        let _ = socket.shutdown().await;
                        return;
                    }
                    let body = if status == 200 { ts() } else { Vec::new() };
                    let head = format!(
                        "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        format!("http://{address}/live.ts")
    }
    async fn server(delay_ms: u64) -> String {
        serve(delay_ms, 200).await
    }
    async fn check(url: &str, triage: bool) -> (Value, &'static str) {
        evidence(
            &network_media_probe::inspect_triaged(
                url,
                true,
                "fixture".into(),
                20_000,
                triage.then_some(1_000),
            )
            .await,
        )
    }
    fn store(c: &Connection, id: &str, at: u64, verdict: &str, kind: Value, grant: &str) {
        let record = json!({"schemaVersion":1,"records":[{"verdict":verdict,"evidence":kind}]});
        c.execute(
            "UPDATE source_snapshot_entry SET check_ms=?2,check_verdict=?3,check_permission=?4,check_address=address_hash,checked_content_hash=content_hash,evidence=?5 WHERE entry_id=?1",
            params![id, at as i64, verdict, grant, record.to_string()],
        )
        .unwrap();
    }
    fn save(c: &Connection, id: &str, url: &str) {
        c.execute("INSERT INTO channel VALUES(?1)", [id]).unwrap();
        c.execute("INSERT INTO channel_url VALUES(?1,0,?2)", params![id, url])
            .unwrap();
    }

    #[tokio::test]
    async fn slow_but_alive_streams_end_up_saved_as_slow() {
        use crate::storage_transaction::{channel_check, source_snapshot_activation as a};
        let streams = [
            ("fast", server(0).await),
            ("late", server(1_600).await),
            ("later", server(2_200).await),
            ("dead", serve(0, 0).await),
            ("gone", serve(0, 404).await),
        ];
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE channel(id TEXT PRIMARY KEY);
             CREATE TABLE channel_url(channel_id TEXT,ordinal INTEGER,url TEXT);
             CREATE TABLE source_snapshot_entry(source_id TEXT,entry_id TEXT,ordinal INTEGER,content_hash TEXT,address_hash TEXT,available INTEGER,check_ms INTEGER,check_verdict TEXT,check_permission TEXT,check_address TEXT,checked_content_hash TEXT,evidence TEXT,channel TEXT);",
        )
        .unwrap();
        let now = 10 * a::POSITIVE_TTL;
        // The scan: every stream triaged at the first-response limit; the
        // scan saves what answered.
        for (ordinal, (id, url)) in streams.iter().enumerate() {
            c.execute(
                "INSERT INTO source_snapshot_entry(source_id,entry_id,ordinal,content_hash,address_hash,available,channel) VALUES('s',?1,?2,'c',?1,1,?3)",
                params![id, ordinal as i64, json!({"urls":[url]}).to_string()],
            )
            .unwrap();
            let (kind, verdict) = check(url, true).await;
            store(&c, id, now - 60_000, verdict, kind, "g20");
            if verdict == "Reachable" {
                save(&c, id, url);
            }
        }
        let verdicts: Vec<(String, String, Option<String>)> = c
            .prepare("SELECT entry_id,check_verdict,json_extract(evidence,'$.records[0].evidence.kind') FROM source_snapshot_entry ORDER BY ordinal")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let row = |id: &str, verdict: &str, kind: &str| {
            (id.to_string(), verdict.to_string(), Some(kind.to_string()))
        };
        assert_eq!(
            verdicts,
            vec![
                row("fast", "Reachable", "http"),
                row("late", "TimedOut", "slow"),
                row("later", "TimedOut", "slow"),
                row("dead", "TemporaryUnavailable", "network-failure"),
                row("gone", "TemporaryUnavailable", "http"),
            ]
        );
        // The Slow pass selects only the Slow list and checks it in full.
        let listed: Vec<(String, String)> = c
            .prepare(&format!(
                "SELECT entry_id,json_extract(channel,'$.urls[0]') FROM source_snapshot_entry WHERE source_id=?1 AND ordinal>?2 AND {} ORDER BY ordinal",
                a::SLOW_LISTED
            ))
            .unwrap()
            .query_map(
                params![
                    "s",
                    -1i64,
                    false,
                    now as i64,
                    "g20",
                    now.saturating_sub(a::POSITIVE_TTL) as i64,
                    now.saturating_sub(a::DEFINITE_FAILURE_TTL) as i64,
                    now.saturating_sub(a::NO_ANSWER_TTL) as i64,
                    "g20",
                    "g20"
                ],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            listed.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["late", "later"]
        );
        let slow_pass_started = now - 30_000;
        for (id, url) in &listed {
            let (kind, verdict) = check(url, false).await;
            assert_eq!(verdict, "Reachable", "{id} plays given the whole time");
            store(&c, id, slow_pass_started + 1_000, verdict, kind, "g45");
            save(&c, id, url);
        }
        let tx = c.transaction().unwrap();
        let recorded =
            channel_check::record_from_scan(&tx, slow_pass_started as i64, now as i64, true)
                .unwrap();
        tx.commit().unwrap();
        assert_eq!(recorded.marked, Some(2));
        let mut slow = channel_check::read(&c, now as i64).unwrap().slow_channels;
        slow.sort();
        assert_eq!(slow, vec!["late".to_string(), "later".to_string()]);
        // Saved: the prompt stream and both slow ones; the dead one never was.
        let saved: Vec<String> = c
            .prepare("SELECT id FROM channel ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(saved, vec!["fast", "late", "later"]);
    }
}
