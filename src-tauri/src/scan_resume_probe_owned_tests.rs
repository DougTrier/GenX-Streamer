//! Actual probe ownership / SQLite authority, with only transport replaced.
//! This proves probe reuse, not public availability or decoder playback.
use super::*;
use crate::{
    scan_checkpoint::{
        self,
        resume_plan::{Fence, Plan, Row},
    },
    scan_resume_owner::{Scheduler, Work},
    scan_resume_runtime::HeldCandidate,
    storage_transaction::RecordPair,
};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Fixture {
    _root: tempfile::TempDir,
    context: Arc<Context>,
    _requests: crate::requests::Requests,
    registry: Arc<Registry<Episode>>,
    raw: Value,
    candidates: Vec<Value>,
}
async fn fixture(alternative_http: bool) -> Fixture {
    let (root, context, _, _, requests) = crate::scan_manifest_work::bookmark_context_fixture();
    let sources = json!([
        {"id":"a","name":"Source A","kind":"url","location":"https://fixture.invalid/a.m3u","allowHttp":false},
        {"id":"b","name":"Source B","kind":"url","location":"https://fixture.invalid/b.m3u","allowHttp":false}
    ]);
    let catalog = json!({"schemaVersion":1,"sources":sources,"channels":[]});
    let preferences = json!({"schemaVersion":1,"sources":sources,"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":360.0,"automaticGuideUpdates":false});
    let write_catalog = catalog.to_string();
    let write_preferences = preferences.to_string();
    context
        .storage(None, move |store, check| {
            store.write_guarded(
                &write_catalog,
                &write_preferences,
                None,
                (None, None),
                check,
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let candidates: Vec<_> = (0..3).map(|i| {
        let id = if i == 0 { "a" } else { "b" };
        let mut urls = vec![json!("https://fixture.invalid/same.m3u8?token=EXACT")];
        if alternative_http && i != 0 { urls.push(json!("http://fixture.invalid/alternative.m3u8")); }
        json!({"key":format!("key-{i}"),"sourceId":id,"sourceFingerprint":format!("capture-{id}"),"sessionRevision":"session","channel":{"sourceId":id,"providerId":format!("provider-{i}"),"name":format!("Distinct Station {i}"),"category":"News","urls":urls}})
    }).collect();
    let now = now().unwrap();
    let definitions: Vec<_> = sources.as_array().unwrap().iter().map(|source| json!({"source":source,"definitionFingerprint":scan_checkpoint::source_fingerprint(source).unwrap()})).collect();
    let mut raw = json!({"schemaVersion":1,"jobId":"probe-reuse-fixture","createdAtMs":now,"catalogRevision":"1","sourceDefinitions":definitions,"budgetMs":20000,"platform":"android","observerProfile":"fixture","review":{"sessionRevision":"session","query":"","status":"completed","sources":[{"sourceId":"a","fingerprint":"capture-a","status":"completed","inspected":1,"matched":1,"warnings":0},{"sourceId":"b","fingerprint":"capture-b","status":"completed","inspected":2,"matched":2,"warnings":0}],"candidates":candidates,"counts":{"inspected":3,"matched":3,"failedSources":0,"canceledSources":0}},"observations":[],"publishedKeys":[]});
    raw["policyFingerprint"] =
        json!(scan_checkpoint::policy_fingerprint(&raw, &preferences).unwrap());
    let raw = scan_checkpoint::packed_fixture(&raw);
    let write_raw = raw.to_string();
    context
        .storage(None, move |store, check| {
            store.write_pair_with_scan(
                &RecordPair::default(),
                None,
                (Some("1"), Some("0")),
                Some((
                    &scan_checkpoint::Mutation::Save {
                        checkpoint: write_raw,
                    },
                    "0",
                )),
                check,
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let plan = Plan::admit(
        &raw.to_string(),
        scan_checkpoint::resume_plan::Context {
            catalog: &catalog,
            preferences: &preferences,
            fence: Fence {
                root_generation: 1,
                catalog: 1,
                health: 0,
                checkpoint: 1,
            },
            now,
            platform: "android",
            observer_profile: "fixture",
        },
        &mut || Ok(()),
    )
    .unwrap();
    let origin =
        origin_directory::origin_token("https://fixture.invalid/same.m3u8?token=EXACT").unwrap();
    let episode = Episode {
        plan,
        scheduler: Scheduler::new((0..3).map(|i| (i, origin, Work::Probe))).unwrap(),
        origins: Default::default(),
        cache: Default::default(),
        cache_bytes: 0,
        taking: false,
        latest_projection: None,
        quarantined: false,
        transport_memo: Default::default(),
        origin_failures: Default::default(),
    };
    let registry = Arc::new(Registry::default());
    registry
        .begin("probe-fixture")
        .unwrap()
        .install("plan-fixture", episode)
        .unwrap();
    Fixture {
        _root: root,
        context,
        _requests: requests,
        registry,
        raw,
        candidates,
    }
}
impl Fixture {
    fn reserve(&self, expected: usize) {
        self.registry
            .acquire("plan-fixture")
            .unwrap()
            .with(|episode| {
                let reservation = episode
                    .scheduler
                    .reserve(1, &[], now()?, || Ok(format!("{:064x}", expected + 1)))?
                    .pop()
                    .ok_or("fixture-not-eligible")?;
                assert_eq!(reservation.ordinal, expected);
                episode.cache.insert(
                    expected,
                    HeldCandidate {
                        reservation,
                        row: Row {
                            candidate_index: expected,
                            candidate: self.candidates[expected].clone(),
                            work: "probe",
                            observation: None,
                        },
                        metadata: scan_checkpoint::resume_candidate(&self.raw, expected)?,
                        observation: None,
                        bytes: 100,
                    },
                );
                episode.cache_bytes += 100;
                Ok(())
            })
            .unwrap();
    }
    async fn check(&self, index: usize, count: Arc<AtomicUsize>) -> Result<Value, String> {
        probe_with_inspector(
            Probe {
                schema_version: 1,
                plan_id: "plan-fixture".into(),
                candidate_key: format!("key-{index}"),
            },
            self.registry.clone(),
            self.context.clone(),
            move |_, _, request_id, _| async move {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(network_media_probe::Inspection {
                    status: "resources-responded",
                    reason_code: "media-resources-responded",
                    checked_resources: 3,
                    request_id,
                    header_retry_count: 1,
                    header_retry_reason: Some("network-failure"),
                    http_status: None,
                    retry_after: None,
                })
            },
        )
        .await
    }
}
#[tokio::test]
async fn owned_reuse_keeps_two_recipient_identities_and_current_origin_pacing() {
    let fixture = fixture(false).await;
    let count = Arc::new(AtomicUsize::new(0));
    fixture.reserve(0);
    let first = fixture.check(0, count.clone()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(355)).await;
    fixture.reserve(1);
    let second = fixture.check(1, count.clone()).await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(first["observedAt"], second["observedAt"]);
    assert_eq!(first["channelId"], "key-0");
    assert_eq!(second["channelId"], "key-1");
    assert_eq!(first["sourceId"], "a");
    assert_eq!(second["sourceId"], "b");
    assert_eq!(first["fingerprint"], "capture-a");
    assert_eq!(second["fingerprint"], "capture-b");
    assert!(!second.to_string().contains("requestId"));
    assert!(!second.to_string().contains("checkedResources"));
    fixture
        .registry
        .acquire("plan-fixture")
        .unwrap()
        .with(|episode| {
            assert!(episode.cache[&0].observation.is_some());
            assert!(episode.cache[&1].observation.is_some());
            assert!(episode
                .scheduler
                .reserve(1, &[], now()?, || Ok("f".repeat(64)))?
                .is_empty());
            assert!(
                episode.scheduler.next_eligible_at(now()?).unwrap()
                    > first["observedAt"].as_u64().unwrap() + 350
            );
            Ok(())
        })
        .unwrap();
    fixture.registry.close("plan-fixture").await.unwrap();
    assert!(fixture.registry.acquire("plan-fixture").is_err());
}
#[tokio::test]
async fn populated_memo_cannot_authorize_an_http_alternative() {
    let fixture = fixture(true).await;
    let count = Arc::new(AtomicUsize::new(0));
    fixture.reserve(0);
    fixture.check(0, count.clone()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(355)).await;
    fixture.reserve(1);
    // Settled as not playable here, without a request and never as Reachable,
    // so Continue does not retry it forever.
    let observation = fixture.check(1, count.clone()).await.unwrap();
    assert_eq!(observation["verdict"], "UnsupportedHere");
    assert_eq!(observation["evidence"], json!({"kind":"unsupported"}));
    assert_eq!(count.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn populated_memo_refuses_changed_sql_authority_and_quarantine() {
    let fixture = fixture(false).await;
    let count = Arc::new(AtomicUsize::new(0));
    fixture.reserve(0);
    fixture.check(0, count.clone()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(355)).await;
    fixture.reserve(1);
    fixture
        .context
        .storage(None, |store, check| {
            let pair = store.read_pair()?;
            let mut catalog: Value =
                serde_json::from_str(pair.catalog.as_deref().unwrap()).unwrap();
            let mut preferences: Value =
                serde_json::from_str(pair.preferences.as_deref().unwrap()).unwrap();
            // A real presentation edit through the checked Store path. Source
            // IDs, URLs and grants remain unchanged; identical writes need not
            // advance a revision.
            catalog["sources"][0]["name"] = json!("Source A renamed");
            preferences["sources"][0]["name"] = json!("Source A renamed");
            store.write_guarded(
                &catalog.to_string(),
                &preferences.to_string(),
                None,
                (Some("1"), Some("0")),
                check,
            )?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        fixture.check(1, count.clone()).await.unwrap_err(),
        "scan-resume-plan-stale"
    );
    assert_eq!(count.load(Ordering::SeqCst), 1);
    fixture
        .registry
        .acquire("plan-fixture")
        .unwrap()
        .with(|episode| {
            episode.quarantine();
            assert!(episode.transport_memo.is_empty());
            Ok(())
        })
        .unwrap();
    assert_eq!(
        fixture.check(1, count).await.unwrap_err(),
        "scan-resume-owner-quarantined"
    );
}
#[tokio::test]
async fn failed_inspection_is_not_reused_by_another_admitted_recipient() {
    let fixture = fixture(false).await;
    let count = Arc::new(AtomicUsize::new(0));
    fixture.reserve(0);
    let first_count = count.clone();
    let first = probe_with_inspector(
        Probe {
            schema_version: 1,
            plan_id: "plan-fixture".into(),
            candidate_key: "key-0".into(),
        },
        fixture.registry.clone(),
        fixture.context.clone(),
        move |_, _, _, _| async move {
            first_count.fetch_add(1, Ordering::SeqCst);
            Err("timeout".into())
        },
    )
    .await
    .unwrap();
    assert_eq!(first["verdict"], "TimedOut");
    tokio::time::sleep(Duration::from_millis(355)).await;
    fixture.reserve(1);
    let second = fixture.check(1, count.clone()).await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 2);
    assert_eq!(second["verdict"], "Reachable");
}
#[tokio::test]
async fn expired_memo_requires_an_actual_new_inspection() {
    let fixture = fixture(false).await;
    let count = Arc::new(AtomicUsize::new(0));
    fixture.reserve(0);
    fixture.check(0, count.clone()).await.unwrap();
    fixture
        .registry
        .acquire("plan-fixture")
        .unwrap()
        .with(|episode| {
            episode.transport_memo.insert(
                Key::new(
                    "https://fixture.invalid/same.m3u8?token=EXACT",
                    false,
                    "android",
                    "fixture",
                    20_000,
                ),
                Recognized {
                    observed_at: now()? - 20_000,
                },
            );
            Ok(())
        })
        .unwrap();
    tokio::time::sleep(Duration::from_millis(355)).await;
    fixture.reserve(1);
    fixture.check(1, count.clone()).await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 2);
}
/// Host-aware judging (owner design, October 21, 2026): two connection-level
/// failures in a row on one site settle its remaining streams in this scan
/// as no-answer without a request.
#[tokio::test]
async fn two_connection_failures_settle_the_site_without_more_requests() {
    let fixture = fixture(false).await;
    let count = Arc::new(AtomicUsize::new(0));
    let refused = |index: usize, count: Arc<AtomicUsize>| {
        probe_with_inspector(
            Probe {
                schema_version: 1,
                plan_id: "plan-fixture".into(),
                candidate_key: format!("key-{index}"),
            },
            fixture.registry.clone(),
            fixture.context.clone(),
            move |_, _, request_id, _| async move {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(network_media_probe::Inspection {
                    status: "unavailable",
                    reason_code: "connectivity-failure",
                    checked_resources: 1,
                    request_id,
                    header_retry_count: 0,
                    header_retry_reason: None,
                    http_status: None,
                    retry_after: None,
                })
            },
        )
    };
    for index in 0..2 {
        if index > 0 {
            tokio::time::sleep(Duration::from_millis(355)).await;
        }
        fixture.reserve(index);
        let observation = refused(index, count.clone()).await.unwrap();
        assert_eq!(observation["verdict"], "TemporaryUnavailable");
        assert_eq!(observation["evidence"], json!({"kind":"network-failure"}));
    }
    tokio::time::sleep(Duration::from_millis(355)).await;
    fixture.reserve(2);
    let third = refused(2, count.clone()).await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 2, "no request for the third");
    assert_eq!(third["verdict"], "TemporaryUnavailable");
    assert_eq!(third["evidence"], json!({"kind":"host-down"}));
}
/// Any answer from the site (here, a 404) resets the count.
#[tokio::test]
async fn an_answer_between_failures_keeps_the_site_checked() {
    let fixture = fixture(false).await;
    let count = Arc::new(AtomicUsize::new(0));
    let failing = |index: usize, count: Arc<AtomicUsize>, http: Option<u16>| {
        probe_with_inspector(
            Probe {
                schema_version: 1,
                plan_id: "plan-fixture".into(),
                candidate_key: format!("key-{index}"),
            },
            fixture.registry.clone(),
            fixture.context.clone(),
            move |_, _, request_id, _| async move {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(network_media_probe::Inspection {
                    status: "unavailable",
                    reason_code: if http.is_some() {
                        "http-status"
                    } else {
                        "dns-failure"
                    },
                    checked_resources: 1,
                    request_id,
                    header_retry_count: 0,
                    header_retry_reason: None,
                    http_status: http,
                    retry_after: None,
                })
            },
        )
    };
    fixture.reserve(0);
    failing(0, count.clone(), None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(355)).await;
    fixture.reserve(1);
    assert_eq!(
        failing(1, count.clone(), Some(404)).await.unwrap()["evidence"],
        json!({"kind":"http","status":404})
    );
    tokio::time::sleep(Duration::from_millis(355)).await;
    fixture.reserve(2);
    let third = failing(2, count.clone(), None).await.unwrap();
    assert_eq!(third["evidence"], json!({"kind":"network-failure"}));
    assert_eq!(count.load(Ordering::SeqCst), 3);
}
