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

//! Actual SQLite transactions/rollback/receipts; authenticated metadata is deterministic fixture
//! input. These tests do not claim platform crypto, network or packaged-device acceptance.
use super::*;
use crate::scan_checkpoint;
struct Fixture {
    dir: tempfile::TempDir,
    store: PairStore,
    plan: Plan,
    metadata: Vec<Value>,
    urls: Vec<Vec<String>>,
    observations: Vec<Value>,
    now: u64,
}
fn install(catalog: Value, preferences: Value, candidates: Vec<Value>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let store = PairStore::new(dir.path().into()).unwrap();
    store
        .write_pair(&catalog.to_string(), &preferences.to_string())
        .unwrap();
    let pair = store.read_pair().unwrap();
    let catalog: Value = serde_json::from_str(pair.catalog.as_ref().unwrap()).unwrap();
    let preferences: Value = serde_json::from_str(pair.preferences.as_ref().unwrap()).unwrap();
    let now = scan_now();
    let definitions:Vec<_>=catalog["sources"].as_array().unwrap().iter().map(|s|json!({"source":s,"definitionFingerprint":scan_checkpoint::source_fingerprint(s).unwrap()})).collect();
    let sources:Vec<_>=definitions.iter().map(|d|{
        let subset:Vec<_>=candidates.iter().filter(|c|c["sourceId"]==d["source"]["id"]).collect();
        json!({"sourceId":d["source"]["id"],"fingerprint":subset[0]["sourceFingerprint"],"status":"completed","inspected":subset.len(),"matched":subset.len(),"warnings":0})
    }).collect();
    let mut runtime = json!({"schemaVersion":1,"jobId":"owned-storage-resume","createdAtMs":now,"catalogRevision":"1","sourceDefinitions":definitions,"budgetMs":20000,"platform":"android","observerProfile":"fixture-v1",
        "review":{"sessionRevision":"session","query":"","status":"completed","sources":sources,"candidates":candidates,"counts":{"inspected":candidates.len(),"matched":candidates.len(),"failedSources":0,"canceledSources":0}},"observations":[],"publishedKeys":[]});
    // Capture the actual persisted region, including omission semantics, before hashing.
    // The fingerprint alone does not replace the header's exact region authority check.
    if let Some(region) = preferences.get("preferredRegion") {
        runtime["preferredRegion"] = region.clone();
    }
    runtime["policyFingerprint"] =
        json!(scan_checkpoint::policy_fingerprint(&runtime, &preferences).unwrap());
    let packed = scan_checkpoint::packed_fixture(&runtime);
    let seed = scan_checkpoint::Mutation::Save {
        checkpoint: packed.to_string(),
    };
    store
        .write_pair_with_scan(
            &RecordPair::default(),
            None,
            (Some("1"), Some("0")),
            Some((&seed, "0")),
            || Ok(()),
        )
        .unwrap();
    let saved = store.read_snapshot().unwrap();
    let catalog: Value = serde_json::from_str(saved.pair.catalog.as_ref().unwrap()).unwrap();
    let preferences: Value =
        serde_json::from_str(saved.pair.preferences.as_ref().unwrap()).unwrap();
    let plan = Plan::admit(
        &packed.to_string(),
        crate::scan_checkpoint::resume_plan::Context {
            catalog: &catalog,
            preferences: &preferences,
            fence: Fence {
                root_generation: 7,
                catalog: 1,
                health: 0,
                checkpoint: 1,
            },
            now,
            platform: "android",
            observer_profile: "fixture-v1",
        },
        &mut || Ok(()),
    )
    .unwrap();
    let metadata = (0..candidates.len())
        .map(|i| scan_checkpoint::resume_candidate(&packed, i).unwrap())
        .collect();
    let urls = candidates
        .iter()
        .map(|c| {
            c["channel"]["urls"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap().to_owned())
                .collect()
        })
        .collect();
    let observations=candidates.iter().map(|c|json!({"channelId":c["key"],"sourceId":c["sourceId"],"fingerprint":c["sourceFingerprint"],"platform":"android","observedAt":now,"verdict":"Reachable","evidence":{"kind":"recognized-media-response"}})).collect();
    Fixture {
        dir,
        store,
        plan,
        metadata,
        urls,
        observations,
        now,
    }
}
fn fixture() -> Fixture {
    let source = json!({"id":"s","name":"Fixture","kind":"url","location":"https://fixture.invalid/list.m3u"});
    let old = json!({"id":"old","sourceId":"s","providerId":"station","name":"Station","category":"News","urls":["https://media.fixture.invalid/old.m3u8"],"geography":{"country":"US","state":"US-IL"}});
    let untouched = json!({"id":"untouched","sourceId":"s","providerId":"other","name":"Other","category":"News","urls":["https://media.fixture.invalid/other.m3u8"]});
    let catalog = json!({"schemaVersion":1,"sources":[source.clone()],"channels":[old,untouched]});
    let preferences = json!({"schemaVersion":1,"sources":[source],"favorites":["old"],"removedChannels":["untouched"],"volume":0.8,"muted":true,"panelWidth":360,"automaticGuideUpdates":false,"preferredRegion":{"country":"US","state":"US-IL","postal":"60601","origin":"manual"},"channelCategoryOverrides":[{"channelId":"old","category":"Sports"}]});
    let candidates=(0..3).map(|i|json!({"key":format!("key-{i}"),"sourceId":"s","sourceFingerprint":"capture-s","sessionRevision":"session","channel":{"sourceId":"s","providerId":if i==0 {"station".into()} else {format!("provider-{i}")},"name":if i==0 {"Station".into()}else{format!("Channel {i}")},"category":"News","urls":[format!("https://media.fixture.invalid/new-{i}.m3u8")]}})).collect();
    install(catalog, preferences, candidates)
}
fn rows<'a>(f: &'a Fixture, indices: &[usize], publish: bool) -> Vec<CheckedRow<'a>> {
    indices
        .iter()
        .map(|&i| CheckedRow {
            original_index: i,
            metadata: &f.metadata[i],
            urls: &f.urls[i],
            observation: &f.observations[i],
            publish,
        })
        .collect()
}
fn evidence(store: &PairStore) -> (RecordPair, Option<String>, String, String) {
    let pair = store.read_pair().unwrap();
    let health = store.read_snapshot().unwrap().health;
    let c = connect(&store.root.join(DB), true).unwrap();
    let (contents, revision): (String, i64) = c
        .query_row(
            "SELECT contents,revision FROM scan_checkpoint WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    (pair, health, contents, revision.to_string())
}
fn cold_plan(f: &Fixture) -> Plan {
    let saved = f.store.read_snapshot().unwrap();
    let cp = f.store.read_scan_checkpoint().unwrap();
    let catalog: Value = serde_json::from_str(saved.pair.catalog.as_ref().unwrap()).unwrap();
    let preferences: Value =
        serde_json::from_str(saved.pair.preferences.as_ref().unwrap()).unwrap();
    Plan::admit(
        cp.checkpoint.as_ref().unwrap(),
        crate::scan_checkpoint::resume_plan::Context {
            catalog: &catalog,
            preferences: &preferences,
            fence: Fence {
                root_generation: 7,
                catalog: scan_checkpoint::revision(&saved.catalog_revision).unwrap(),
                health: scan_checkpoint::revision(&saved.health_revision).unwrap(),
                checkpoint: scan_checkpoint::revision(&cp.checkpoint_revision).unwrap(),
            },
            now: scan_now(),
            platform: "android",
            observer_profile: "fixture-v1",
        },
        &mut || Ok(()),
    )
    .unwrap()
}
#[test]
fn atomic_positive_negative_original_indices_preserve_preferences_and_guide_ids() {
    let mut f = fixture();
    let c = connect(&f.store.root.join(DB), false).unwrap();
    c.execute(
        "INSERT INTO guide_mapping VALUES('s','old','guide-fixture','station-fixture')",
        [],
    )
    .unwrap();
    drop(c);
    let before = f.store.read_pair().unwrap();
    let before_prefs: Value = serde_json::from_str(before.preferences.as_ref().unwrap()).unwrap();
    f.observations[2]["verdict"] = json!("TimedOut");
    f.observations[2]["evidence"] = json!({"kind":"timeout"});
    let mut checked = rows(&f, &[0, 1, 2], true);
    checked[2].publish = false;
    let committed = f
        .store
        .commit_scan_resume_selection(&f.plan, 7, &checked, || Ok(()))
        .unwrap();
    assert_eq!(committed.receipt.catalog_revision, "2");
    assert_eq!(committed.receipt.health_revision, "1");
    assert_eq!(committed.receipt.checkpoint_revision.as_deref(), Some("2"));
    assert_eq!(committed.delta.base(), f.plan.fence());
    assert_eq!(
        committed.delta.after(),
        Fence {
            root_generation: 7,
            catalog: 2,
            health: 1,
            checkpoint: 2
        }
    );
    assert_eq!(committed.delta.published_indices(), &[0, 1]);
    assert_eq!(committed.delta.observation_tuples().len(), 3);
    let saved = f.store.read_snapshot().unwrap();
    let catalog: Value = serde_json::from_str(saved.pair.catalog.as_ref().unwrap()).unwrap();
    assert_eq!(catalog["channels"].as_array().unwrap().len(), 3);
    assert_eq!(committed.projection.after(), committed.delta.after());
    assert_eq!(committed.projection.channels().len(), 2);
    for channel in committed.projection.channels() {
        assert_eq!(
            catalog["channels"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["id"] == channel["id"]),
            Some(channel)
        );
        assert_ne!(channel["id"], "untouched");
    }
    assert!(committed.projection.sources().is_empty());
    let wire = serde_json::to_value(&committed.projection).unwrap();
    assert_eq!(wire["schemaVersion"], 1);
    assert_eq!(wire["catalogRevision"], committed.receipt.catalog_revision);
    assert_eq!(wire["healthRevision"], committed.receipt.health_revision);
    assert_eq!(wire["checkpointRevision"], "2");
    assert!(wire.get("preferences").is_none());
    assert!(wire.get("after").is_none());
    assert_eq!(catalog["channels"][0]["id"], "old");
    assert_eq!(catalog["channels"][1]["id"], "untouched");
    assert_eq!(
        catalog["channels"][0]["geography"],
        json!({"country":"US","state":"US-IL"})
    );
    let prefs: Value = serde_json::from_str(saved.pair.preferences.as_ref().unwrap()).unwrap();
    assert_eq!(prefs, before_prefs);
    let health = crate::health_storage::parse(saved.health.as_ref().unwrap()).unwrap();
    assert_eq!(health.len(), 2);
    let c = connect(&f.store.root.join(DB), true).unwrap();
    let mappings:i64=c.query_row("SELECT COUNT(*) FROM guide_mapping WHERE catalog_source_id='s' AND app_channel_id='old' AND xmltv_channel_id='station-fixture'",[],|r|r.get(0)).unwrap();
    assert_eq!(mappings, 1);
    let cp: Value = serde_json::from_str(
        f.store
            .read_scan_checkpoint()
            .unwrap()
            .checkpoint
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        cp["observations"],
        json!(committed.delta.observation_tuples())
    );
    assert_eq!(cp["publishedIndices"], json!([0, 1]));
    // Original plan is stale until the private post-ACK updater accepts its proof; no replay.
    assert!(f
        .store
        .commit_scan_resume_selection(&f.plan, 7, &checked, || Ok(()))
        .is_err());
    drop(checked);
    f.plan
        .accept_delta(&committed.receipt, &committed.delta)
        .unwrap();
    let cold = cold_plan(&f);
    assert_eq!(f.plan.counts(), cold.counts());
    assert_eq!(f.plan.fence(), cold.fence());
    let counts = f.plan.counts();
    assert!(f
        .plan
        .accept_delta(&committed.receipt, &committed.delta)
        .is_err());
    assert_eq!(f.plan.counts(), counts);
    drop(c);
    let reopened = PairStore::new(f.dir.path().into()).unwrap();
    assert_eq!(
        reopened.read_scan_checkpoint().unwrap().checkpoint_revision,
        "2"
    );
}
#[test]
fn negative_only_commits_progress_without_catalog_health_or_preference_replacement() {
    let mut f = fixture();
    f.observations[2]["verdict"] = json!("TemporaryUnavailable");
    f.observations[2]["evidence"] = json!({"kind":"network-failure"});
    let before = f.store.read_snapshot().unwrap();
    let committed = f
        .store
        .commit_scan_resume_selection(&f.plan, 7, &rows(&f, &[2], false), || Ok(()))
        .unwrap();
    let after = f.store.read_snapshot().unwrap();
    assert_eq!(after.pair, before.pair);
    assert_eq!(after.health, before.health);
    assert_eq!(committed.receipt.catalog_revision, "1");
    assert_eq!(committed.receipt.health_revision, "0");
    assert_eq!(committed.receipt.checkpoint_revision.as_deref(), Some("2"));
    assert!(committed.delta.published_indices().is_empty());
    assert!(committed.projection.channels().is_empty());
    assert!(committed.projection.sources().is_empty());
    assert_eq!(committed.projection.after(), committed.delta.after());
    assert_eq!(
        committed.delta.observation_tuples(),
        &[json!([2,f.now,"TemporaryUnavailable",{"kind":"network-failure"}])]
    );
    f.plan
        .accept_delta(&committed.receipt, &committed.delta)
        .unwrap();
    let cold = cold_plan(&f);
    assert_eq!(f.plan.counts(), cold.counts());
    assert_eq!(f.plan.fence(), cold.fence());
    // A settled negative is immutable within this job, not a permit to rewrite it positive.
    f.observations[2]["verdict"] = json!("Reachable");
    f.observations[2]["evidence"] = json!({"kind":"recognized-media-response"});
    let before = evidence(&f.store);
    assert!(f
        .store
        .commit_scan_resume_selection(&f.plan, 7, &rows(&f, &[2], true), || Ok(()))
        .is_err());
    assert_eq!(evidence(&f.store), before);
    assert_eq!(f.plan.counts(), cold.counts());
}
#[test]
fn invalid_checkpoint_observation_cannot_produce_committed_delta() {
    let mut f = fixture();
    f.observations[2]["verdict"] = json!("TemporaryUnavailable");
    f.observations[2]["evidence"] = json!({"kind":"network-failure"});
    f.observations[2]["observedAt"] = json!(f.now + 60_000);
    let before = evidence(&f.store);
    let mut backups = 0;
    let mut commits = 0;
    let result = f.store.commit_scan_resume_selection_with_phase(
        &f.plan,
        7,
        &rows(&f, &[2], false),
        &mut |phase| {
            if phase == Phase::BeforeBackup {
                backups += 1;
            }
            if phase == Phase::AfterCommit {
                commits += 1;
            }
            Ok(())
        },
        &mut uuid,
    );
    assert!(result.is_err());
    assert_eq!(backups, 1);
    assert_eq!(commits, 0);
    assert_eq!(evidence(&f.store), before);
}
#[test]
fn before_commit_fault_rolls_back_all_records_and_late_cancel_preserves_actual_receipt() {
    let f = fixture();
    let checked = rows(&f, &[0, 1], true);
    let before = evidence(&f.store);
    let result = f.store.commit_scan_resume_selection_with_phase(
        &f.plan,
        7,
        &checked,
        &mut |p| {
            if p == Phase::AfterCatalog {
                Err("fixture-write-failed".into())
            } else {
                Ok(())
            }
        },
        &mut uuid,
    );
    assert_eq!(result.err().unwrap(), "fixture-write-failed");
    assert_eq!(evidence(&f.store), before);
    let committed = f
        .store
        .commit_scan_resume_selection_with_phase(
            &f.plan,
            7,
            &checked,
            &mut |p| {
                if p == Phase::AfterCommit {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
            &mut uuid,
        )
        .unwrap();
    assert!(committed.receipt.committed);
    assert_eq!(committed.receipt.checkpoint_revision.as_deref(), Some("2"));
    assert_eq!(committed.delta.published_indices(), &[0, 1]);
    let c = connect(&f.store.root.join(DB), true).unwrap();
    let integrity: String = c
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
}
#[test]
fn stale_revisions_root_policy_and_forged_original_metadata_refuse_without_ack() {
    for reason in [
        "root",
        "catalog",
        "health",
        "checkpoint",
        "policy",
        "metadata",
        "url",
        "index",
        "binding",
        "nonsettled",
    ] {
        let mut f = fixture();
        let mut root = 7;
        match reason {
            "root" => root = 8,
            "catalog" | "health" => {
                let c = connect(&f.store.root.join(DB), false).unwrap();
                c.execute(&format!("UPDATE metadata SET {reason}_revision={reason}_revision+1 WHERE singleton=1"),[]).unwrap();
            }
            "checkpoint" => {
                let c = connect(&f.store.root.join(DB), false).unwrap();
                c.execute(
                    "UPDATE scan_checkpoint SET revision=revision+1 WHERE singleton=1",
                    [],
                )
                .unwrap();
            }
            "policy" => {
                let c = connect(&f.store.root.join(DB), false).unwrap();
                c.execute(
                    "UPDATE preference SET preferred_region=?1 WHERE singleton=1",
                    [json!({"country":"GB","origin":"manual"}).to_string()],
                )
                .unwrap();
            }
            "metadata" => f.metadata[0]["channel"]["name"] = json!("Forged"),
            "url" => f.urls[0][0] = "https://media.fixture.invalid/forged.m3u8".into(),
            "binding" => f.observations[0]["fingerprint"] = json!("foreign"),
            "nonsettled" => {
                f.observations[0]["verdict"] = json!("NotChecked");
                f.observations[0]["evidence"] = json!({"kind":"not-checked"});
            }
            _ => {}
        }
        let before = evidence(&f.store);
        let mut checked = rows(&f, &[0], true);
        if reason == "index" {
            checked[0].original_index = 1;
        }
        assert!(
            f.store
                .commit_scan_resume_selection(&f.plan, root, &checked, || Ok(()))
                .is_err(),
            "{reason}"
        );
        assert_eq!(evidence(&f.store), before, "{reason}");
    }
}
#[test]
fn actual_ts_oracle_publication_through_sql_core() {
    let oracle: Value =
        serde_json::from_str(include_str!("scan_resume_reconcile_oracle.json")).unwrap();
    let case = &oracle["cases"][0];
    let candidates = case["selected"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["candidate"].clone())
        .collect();
    let f = install(
        case["catalog"].clone(),
        case["preferences"].clone(),
        candidates,
    );
    let committed = f
        .store
        .commit_scan_resume_selection(&f.plan, 7, &rows(&f, &[0], true), || Ok(()))
        .unwrap();
    assert!(committed.receipt.committed);
    let pair = f.store.read_pair().unwrap();
    let actual: Value = serde_json::from_str(pair.catalog.as_ref().unwrap()).unwrap();
    let mut expected = case["expectedCatalog"].clone();
    // SQL canonically omits false optional HTTP grants, with permission unchanged.
    for s in expected["sources"].as_array_mut().unwrap() {
        if s["allowHttp"] == false {
            s.as_object_mut().unwrap().remove("allowHttp");
        }
    }
    assert_eq!(actual, expected);
    for channel in committed.projection.channels() {
        assert_eq!(
            actual["channels"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["id"] == channel["id"]),
            Some(channel)
        );
    }
    for source in committed.projection.sources() {
        assert_eq!(
            actual["sources"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["id"] == source["id"]),
            Some(source)
        );
    }
    let actual_prefs: Value = serde_json::from_str(pair.preferences.as_ref().unwrap()).unwrap();
    let mut expected_prefs = case["expected"]["nextPreferences"].clone();
    expected_prefs["sources"] = expected["sources"].clone();
    // SQL's typed preference DTO stores panelWidth as f64; JS has one Number type.
    // Compare that numeric value exactly, then canonicalize only its representation.
    assert_eq!(
        actual_prefs["panelWidth"].as_f64(),
        expected_prefs["panelWidth"].as_f64()
    );
    expected_prefs["panelWidth"] = json!(expected_prefs["panelWidth"].as_f64().unwrap());
    assert_eq!(actual_prefs, expected_prefs);
    let mut expected_health = case["expected"]["incomingHealth"].clone();
    expected_health[0]["observedAt"] = json!(f.now);
    let health: Value =
        serde_json::from_str(f.store.read_snapshot().unwrap().health.as_ref().unwrap()).unwrap();
    assert_eq!(health["records"], expected_health);
}

fn window_fixture(total: usize, padding: bool) -> Fixture {
    let source = json!({"id":"s","name":"Window fixture","kind":"url","location":"https://fixture.invalid/window"});
    let candidates = (0..total).map(|i| json!({"key":format!("window-{i}"),"sourceId":"s","sourceFingerprint":"captured-window","sessionRevision":"session","channel":{"sourceId":"s","providerId":format!("station-{i}"),"name":format!("Window {i}"),"category":"News","urls":[format!("https://media.fixture.invalid/window/{i}")]}})).collect();
    let f = install(
        json!({"schemaVersion":1,"sources":[source.clone()],"channels":[]}),
        json!({"schemaVersion":1,"sources":[source],"favorites":["recoverable-choice"],"removedChannels":["recoverable-removal"],"volume":0.7,"muted":false,"panelWidth":360,"automaticGuideUpdates":false}),
        candidates,
    );
    if padding {
        let c = connect(&f.store.root.join(DB), false).unwrap();
        c.execute_batch("CREATE TABLE fixture_padding(bytes BLOB NOT NULL); INSERT INTO fixture_padding VALUES(zeroblob(67108864));").unwrap();
    }
    f
}
#[test]
fn scan_resume_window_240_reduces_verified_backups_four_to_one_with_same_recovered_choices() {
    let mut legacy = window_fixture(240, true);
    let mut window = window_fixture(240, true);
    let mut results = Vec::new();
    for (f, limit) in [(&mut legacy, 64), (&mut window, 240)] {
        let started = std::time::Instant::now();
        let mut backups = 0;
        let mut commits = 0;
        let mut id = 0;
        for slice in (0..240).collect::<Vec<_>>().chunks(limit) {
            let result = f
                .store
                .commit_scan_resume_window_with_phase(
                    &f.plan,
                    7,
                    &rows(f, slice, true),
                    limit,
                    &mut |phase| {
                        if phase == Phase::BeforeBackup {
                            backups += 1;
                        }
                        if phase == Phase::AfterCommit {
                            commits += 1;
                        }
                        Ok(())
                    },
                    &mut || {
                        id += 1;
                        format!("fixture-station-{id}")
                    },
                )
                .unwrap();
            assert_eq!(result.delta.version(), if slice.len() > 64 { 2 } else { 1 });
            assert_eq!(
                result.projection.version(),
                if slice.len() > 64 { 2 } else { 1 }
            );
            f.plan.accept_delta(&result.receipt, &result.delta).unwrap();
        }
        let elapsed = started.elapsed();
        let c = connect(&f.store.root.join(DB), true).unwrap();
        assert_eq!(
            c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            c.query_row("SELECT length(bytes) FROM fixture_padding", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            67108864
        );
        let resumed = cold_plan(f);
        assert_eq!(resumed.counts().published, 240);
        results.push((backups, commits, elapsed.as_secs_f64() * 1000.0));
    }
    assert_eq!((results[0].0, results[0].1), (4, 4));
    assert_eq!((results[1].0, results[1].1), (1, 1));
    assert_eq!(
        legacy.store.read_pair().unwrap(),
        window.store.read_pair().unwrap()
    );
    println!("WINDOW_CONTROLLED_WINDOWS fixturePaddingBytes=67108864 legacy64 backups={} commits={} elapsedMs={:.3}; window240 backups={} commits={} elapsedMs={:.3}; fullIntegrity=ok; notHardwareAcceptance",results[0].0,results[0].1,results[0].2,results[1].0,results[1].1,results[1].2);
}
#[test]
fn scan_resume_window_precommit_cancel_rolls_back_and_late_cancel_returns_durable_240_ack() {
    let mut f = window_fixture(240, false);
    let all = (0..240).collect::<Vec<_>>();
    let before = evidence(&f.store);
    let canceled = f.store.commit_scan_resume_window_with_phase(
        &f.plan,
        7,
        &rows(&f, &all, true),
        240,
        &mut |phase| {
            if phase == Phase::AfterCatalog {
                Err("fixture-canceled".into())
            } else {
                Ok(())
            }
        },
        &mut uuid,
    );
    assert_eq!(canceled.err().unwrap(), "fixture-canceled");
    assert_eq!(evidence(&f.store), before);
    let committed = f
        .store
        .commit_scan_resume_window_with_phase(
            &f.plan,
            7,
            &rows(&f, &all, true),
            240,
            &mut |phase| {
                if phase == Phase::AfterCommit {
                    Err("fixture-late-cancel".into())
                } else {
                    Ok(())
                }
            },
            &mut uuid,
        )
        .unwrap();
    assert!(committed.receipt.committed);
    assert_eq!(committed.delta.published_indices().len(), 240);
    f.plan
        .accept_delta(&committed.receipt, &committed.delta)
        .unwrap();
    assert_eq!(cold_plan(&f).counts().published, 240);
}
#[test]
fn scan_resume_window_preserves_legacy_limit_and_rejects_241_before_backup() {
    let f = window_fixture(241, false);
    let mut backups = 0;
    for (count, limit) in [(65, 64), (241, 240)] {
        let all = (0..count).collect::<Vec<_>>();
        assert!(f
            .store
            .commit_scan_resume_window_with_phase(
                &f.plan,
                7,
                &rows(&f, &all, true),
                limit,
                &mut |p| {
                    if p == Phase::BeforeBackup {
                        backups += 1;
                    }
                    Ok(())
                },
                &mut uuid
            )
            .is_err());
    }
    assert_eq!(backups, 0);
    assert_eq!(cold_plan(&f).counts().published, 0);
}
