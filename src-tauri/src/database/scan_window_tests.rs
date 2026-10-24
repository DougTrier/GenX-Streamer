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

//! One atomic SQLite publication window; no intermediate ACK or device proof.
use super::*;
use crate::scan_batch::Patch;
use crate::scan_window::{Chunk, Window};

fn setup(
    parts: usize,
    size: usize,
    checkpoint: bool,
) -> (tempfile::TempDir, PairStore, Window, Value, String) {
    let (dir, store, old, prefs) = pair_reuse_tests::fixture();
    let at = scan_now();
    let source = &old["sources"][0];
    let mut final_catalog = old.clone();
    let mut chunks = Vec::new();
    let mut candidates = Vec::new();
    let mut observations = Vec::new();
    let mut keys = Vec::new();
    let mut health = Vec::new();
    for part in 0..parts {
        let mut channels = Vec::new();
        let mut incoming = Vec::new();
        for index in part * size..(part + 1) * size {
            let channel = json!({"id":format!("window-{index}"),"sourceId":"public","providerId":format!("provider-{index}"),"name":format!("Fixture {index}"),"category":"News","urls":[format!("https://fixture.invalid/{index}.m3u8")]});
            let record = json!({"schemaVersion":1,"channelId":channel["id"],"sourceId":"public","checkedUrlOrdinal":0,"targetFingerprint":crate::health_storage::fingerprint(source,&channel,0).unwrap(),"platform":"windows","observerProfile":"fixture","observedAt":at,"verdict":"Reachable","origin":"local","evidence":{"kind":"recognized-media-response"}});
            let mut metadata = channel.clone();
            metadata.as_object_mut().unwrap().remove("id");
            candidates.push(json!({"key":format!("key-{index}"),"sourceId":"public","sourceFingerprint":"scope","sessionRevision":"session","channel":metadata}));
            observations.push(json!({"channelId":format!("key-{index}"),"sourceId":"public","fingerprint":"scope","platform":"windows","observedAt":at,"verdict":"Reachable","evidence":{"kind":"recognized-media-response"}}));
            keys.push(json!(format!("key-{index}")));
            health.push(record.clone());
            incoming.push(record);
            channels.push(channel);
        }
        final_catalog["channels"]
            .as_array_mut()
            .unwrap()
            .extend(channels.clone());
        chunks.push(Chunk {
            catalog_patch: Patch {
                schema_version: 1,
                base_source_count: 1,
                base_channel_count: (1 + part * size) as u32,
                final_source_count: 1,
                final_channel_count: (1 + (part + 1) * size) as u32,
                sources: vec![],
                channels,
            },
            incoming_health: incoming,
        });
    }
    let mutation = if checkpoint {
        let count = parts * size;
        let mut cp = json!({"schemaVersion":1,"jobId":"window-job","createdAtMs":at,"catalogRevision":"1","policyFingerprint":"","sourceDefinitions":[{"source":source,"definitionFingerprint":crate::scan_checkpoint::source_fingerprint(source).unwrap()}],"budgetMs":20000,"platform":"windows","observerProfile":"fixture","preferredRegion":prefs["preferredRegion"],"review":{"sessionRevision":"session","query":"","status":"completed","sources":[{"sourceId":"public","fingerprint":"scope","status":"completed","inspected":count,"matched":count,"warnings":0}],"candidates":candidates,"counts":{"inspected":count,"matched":count,"failedSources":0,"canceledSources":0}},"observations":observations,"publishedKeys":keys});
        cp["policyFingerprint"] =
            json!(crate::scan_checkpoint::policy_fingerprint(&cp, &prefs).unwrap());
        Some(crate::scan_checkpoint::Mutation::Save {
            checkpoint: cp.to_string(),
        })
    } else {
        None
    };
    let window = Window {
        schema_version: 1,
        chunks,
        authorized_sources: vec![source.clone()],
        next_preferences: prefs,
        expected_catalog_revision: "1".into(),
        expected_health_revision: "0".into(),
        expected_checkpoint_revision: mutation.as_ref().map(|_| "0".into()),
        scan_checkpoint: mutation,
    };
    (
        dir,
        store,
        window,
        final_catalog,
        json!({"schemaVersion":1,"records":health}).to_string(),
    )
}
fn duplicate(window: &Window) -> Window {
    serde_json::from_value(serde_json::to_value(window).unwrap()).unwrap()
}

#[test]
fn rejected_guide_growth_leaves_reserved_space_for_actual_scan_window() {
    use crate::guide::{
        database as db,
        parser::{GuideChannel, GuideProgram, ParsedGuide},
    };
    let (dir, store, window, _, _) = setup(4, 64, true);
    let source = db::GuideSource {
        id: "capacity-guide".into(),
        name: "Fixture".into(),
        location: "https://fixture.invalid/guide.xml".into(),
        kind: "url".into(),
        allow_http: false,
        revision: 0,
        updated_ms: None,
    };
    let mut old = ParsedGuide {
        channels: vec![GuideChannel {
            id: "a".into(),
            names: vec!["A".into()],
        }],
        programs: vec![GuideProgram {
            channel_id: "a".into(),
            start_ms: 1000,
            stop_ms: Some(2000),
            title: "Last good".into(),
            description: None,
            categories: vec![],
        }],
    };
    store
        .with_guide_write(|c| {
            db::publish_source(
                c,
                &source,
                0,
                &old,
                3000,
                &std::sync::atomic::AtomicBool::new(false),
            )
        })
        .unwrap();
    let limit = store
        .with_guide_write(|c| crate::storage_budget::occupied_bytes(c))
        .unwrap();
    old.programs[0].description = Some("x".repeat(65_536));
    assert_eq!(
        crate::storage_budget::with_guide_limit(limit, || store.with_guide_write(|c| {
            db::replace_guide(
                c,
                "capacity-guide",
                1,
                &old,
                4000,
                &std::sync::atomic::AtomicBool::new(false),
            )
        }))
        .unwrap_err(),
        "guide-storage-budget-exceeded"
    );
    let receipt = store.commit_scan_window(&window, || Ok(())).unwrap();
    assert_eq!(receipt.catalog_revision, "2");
    assert_eq!(receipt.health_revision, "1");
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("1"));
    let c = connect(&dir.path().join(DB), true).unwrap();
    assert!(crate::storage_budget::occupied_bytes(&c).unwrap() > limit);
    assert_eq!(
        c.query_row(
            "SELECT title FROM guide_program WHERE guide_source_id='capacity-guide'",
            [],
            |r| { r.get::<_, String>(0) }
        )
        .unwrap(),
        "Last good"
    );
    assert_eq!(db::source_revision(&c, "capacity-guide").unwrap(), 1);
    drop(c);
    let reopened = PairStore::new(dir.path().into()).unwrap();
    assert_eq!(
        reopened.read_snapshot().unwrap(),
        store.read_snapshot().unwrap()
    );
}

#[test]
fn writable_connection_database_budget_uses_real_page_size_and_readonly_keeps_policy() {
    for size in [1024, 4096, 16_384, 65_536] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB);
        let c = Connection::open(&path).unwrap();
        c.pragma_update(None, "page_size", size).unwrap();
        c.execute_batch("CREATE TABLE marker(value TEXT)").unwrap();
        drop(c);
        let c = connect(&path, false).unwrap();
        assert_eq!(
            c.pragma_query_value(None, "page_size", |r| r.get::<_, i64>(0))
                .unwrap(),
            size
        );
        assert_eq!(
            c.pragma_query_value(None, "max_page_count", |r| r.get::<_, i64>(0))
                .unwrap(),
            crate::storage_budget::maximum_pages(size).unwrap()
        );
        c.pragma_update(None, "max_page_count", 7).unwrap();
        drop(c);
        let c = connect(&path, true).unwrap();
        // SQLite's limit is connection-local: readonly admission must never renegotiate it.
        assert_eq!(
            c.pragma_query_value(None, "page_size", |r| r.get::<_, i64>(0))
                .unwrap(),
            size
        );
        assert_eq!(
            c.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
                .unwrap(),
            "delete"
        );
    }
}

#[test]
fn exhausted_sqlite_window_reports_full_and_preserves_health_checkpoint_and_revisions() {
    let (dir, store, window, _, _) = setup(4, 64, true);
    let c = connect(&dir.path().join(DB), false).unwrap();
    crate::scan_checkpoint::ensure(&c).unwrap();
    c.execute_batch("CREATE TABLE full_window_probe(value BLOB)")
        .unwrap();
    let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    c.pragma_update(None, "max_page_count", pages).unwrap();
    loop {
        match c.execute("INSERT INTO full_window_probe VALUES(zeroblob(1000))", []) {
            Ok(_) => {}
            Err(error) => {
                assert_eq!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DiskFull)
                );
                assert_eq!(sql::<usize>(Err(error)).unwrap_err(), "sqlite-storage-full");
                break;
            }
        }
    }
    drop(c);
    let before = store.read_snapshot().unwrap();
    let checkpoint_before = serde_json::to_value(store.read_scan_checkpoint().unwrap()).unwrap();
    let mut phases = Vec::new();
    assert_eq!(
        store
            .commit_scan_window_with_page_limit(
                &window,
                &mut |phase| {
                    phases.push(phase);
                    Ok(())
                },
                None,
                Some(pages),
            )
            .unwrap_err(),
        "sqlite-storage-full"
    );
    assert!(phases.contains(&Phase::AfterBackup));
    assert!(!phases.contains(&Phase::AfterCommit));
    assert_eq!(store.read_snapshot().unwrap(), before);
    assert_eq!(
        serde_json::to_value(store.read_scan_checkpoint().unwrap()).unwrap(),
        checkpoint_before
    );
    let reopened = PairStore::new(dir.path().into()).unwrap();
    assert_eq!(reopened.read_snapshot().unwrap(), before);
    assert_eq!(
        serde_json::to_value(reopened.read_scan_checkpoint().unwrap()).unwrap(),
        checkpoint_before
    );
    let c = connect(&dir.path().join(DB), true).unwrap();
    assert_eq!(
        c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}

#[test]
fn non_full_sqlite_window_error_keeps_generic_code_and_rolls_back() {
    let (dir, store, window, _, _) = setup(1, 1, true);
    let before = store.read_snapshot().unwrap();
    let checkpoint_before = serde_json::to_value(store.read_scan_checkpoint().unwrap()).unwrap();
    let c = connect(&dir.path().join(DB), false).unwrap();
    c.execute_batch("CREATE TRIGGER refuse_window BEFORE INSERT ON channel BEGIN SELECT RAISE(ABORT,'fixture'); END")
        .unwrap();
    drop(c);
    assert_eq!(
        store.commit_scan_window(&window, || Ok(())).unwrap_err(),
        "sqlite-operation-failed"
    );
    assert_eq!(store.read_snapshot().unwrap(), before);
    assert_eq!(
        serde_json::to_value(store.read_scan_checkpoint().unwrap()).unwrap(),
        checkpoint_before
    );
}

#[test]
fn late_health_sqlite_full_rolls_back_catalog_health_checkpoint_and_reopens() {
    let (dir, store, window, _, _) = setup(1, 1, true);
    let c = connect(&dir.path().join(DB), false).unwrap();
    crate::scan_checkpoint::ensure(&c).unwrap();
    c.execute_batch("CREATE TABLE late_health_capacity_probe(value BLOB);CREATE TRIGGER exhaust_health_capacity BEFORE INSERT ON channel_health BEGIN INSERT INTO late_health_capacity_probe VALUES(zeroblob(1048576)); END")
        .unwrap();
    let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    drop(c);
    let before = store.read_snapshot().unwrap();
    let checkpoint_before = serde_json::to_value(store.read_scan_checkpoint().unwrap()).unwrap();
    let mut phases = Vec::new();
    assert_eq!(
        store
            .commit_scan_window_with_page_limit(
                &window,
                &mut |phase| {
                    phases.push(phase);
                    Ok(())
                },
                None,
                Some(pages + 32),
            )
            .unwrap_err(),
        "sqlite-storage-full"
    );
    // Catalog DML succeeded before the health INSERT's genuine page-budget failure.
    assert!(phases.contains(&Phase::AfterCatalog));
    assert!(!phases.contains(&Phase::AfterCommit));
    let reopened = PairStore::new(dir.path().into()).unwrap();
    assert_eq!(reopened.read_snapshot().unwrap(), before);
    assert_eq!(
        serde_json::to_value(reopened.read_scan_checkpoint().unwrap()).unwrap(),
        checkpoint_before
    );
    let c = connect(&dir.path().join(DB), true).unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM late_health_capacity_probe", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}

#[test]
fn late_health_non_full_error_retains_health_code_and_rolls_back() {
    let (dir, store, window, _, _) = setup(1, 1, true);
    let before = store.read_snapshot().unwrap();
    let checkpoint_before = serde_json::to_value(store.read_scan_checkpoint().unwrap()).unwrap();
    let c = connect(&dir.path().join(DB), false).unwrap();
    c.execute_batch("CREATE TRIGGER refuse_health BEFORE INSERT ON channel_health BEGIN SELECT RAISE(ABORT,'fixture'); END")
        .unwrap();
    drop(c);
    let mut after_catalog = false;
    assert_eq!(
        store
            .commit_scan_window_observed(
                &window,
                &mut |phase| {
                    after_catalog |= phase == Phase::AfterCatalog;
                    Ok(())
                },
                None
            )
            .unwrap_err(),
        "health-sqlite-failed"
    );
    assert!(after_catalog);
    assert_eq!(store.read_snapshot().unwrap(), before);
    assert_eq!(
        serde_json::to_value(store.read_scan_checkpoint().unwrap()).unwrap(),
        checkpoint_before
    );
}

#[test]
fn four_64_chunks_have_one_backup_sql_snapshot_health_checkpoint_and_ack() {
    let (_dir, store, window, _, _) = setup(4, 64, true);
    let mut phases = Vec::new();
    let mut values = Vec::new();
    let receipt = store
        .commit_scan_window_observed(
            &window,
            &mut |phase| {
                phases.push(phase);
                Ok(())
            },
            Some(&mut |stage| values.push(stage)),
        )
        .unwrap();
    assert_eq!(
        phases.iter().filter(|p| **p == Phase::BeforeBackup).count(),
        1
    );
    assert_eq!(
        phases.iter().filter(|p| **p == Phase::AfterBackup).count(),
        1
    );
    assert_eq!(
        phases.iter().filter(|p| **p == Phase::AfterCommit).count(),
        1
    );
    for stage in [
        PairCaptureStage::Before,
        PairCaptureStage::After,
        PairCaptureStage::BeforeCatalogReuse,
        PairCaptureStage::BeforeDeltaReuse,
        PairCaptureStage::AfterHealthReuse,
        PairCaptureStage::AfterCheckpointReuse,
    ] {
        assert_eq!(values.iter().filter(|s| **s == stage).count(), 1);
    }
    assert_eq!(
        (
            receipt.catalog_revision.as_str(),
            receipt.health_revision.as_str(),
            receipt.checkpoint_revision.as_deref()
        ),
        ("2", "1", Some("1"))
    );
    let snapshot = store.read_snapshot().unwrap();
    assert_eq!(
        parse(snapshot.pair.catalog.as_ref().unwrap()).unwrap()["channels"]
            .as_array()
            .unwrap()
            .len(),
        257
    );
    assert_eq!(
        crate::health_storage::parse(snapshot.health.as_ref().unwrap())
            .unwrap()
            .len(),
        256
    );
    let cp = store.read_scan_checkpoint().unwrap();
    assert_eq!(cp.checkpoint_status, "valid");
    assert_eq!(
        serde_json::from_str::<Value>(cp.checkpoint.as_ref().unwrap()).unwrap()["publishedKeys"]
            .as_array()
            .unwrap()
            .len(),
        256
    );
}

#[test]
fn window_and_one_equivalent_full_commit_are_exact_after_reopen() {
    let (left, window_store, window, catalog, health) = setup(4, 64, true);
    let (right, full_store, _, _, _) = setup(4, 64, false);
    let actual = window_store.commit_scan_window(&window, || Ok(())).unwrap();
    let expected = full_store
        .write_pair_with_scan(
            &RecordPair {
                catalog: Some(catalog.to_string()),
                preferences: Some(window.next_preferences.to_string()),
            },
            Some(&health),
            (Some("1"), Some("0")),
            Some((window.scan_checkpoint.as_ref().unwrap(), "0")),
            || Ok(()),
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
    assert_eq!(
        window_store.read_snapshot().unwrap(),
        full_store.read_snapshot().unwrap()
    );
    assert_eq!(
        serde_json::to_value(window_store.read_scan_checkpoint().unwrap()).unwrap(),
        serde_json::to_value(full_store.read_scan_checkpoint().unwrap()).unwrap()
    );
    assert_eq!(
        PairStore::new(left.path().into())
            .unwrap()
            .read_snapshot()
            .unwrap(),
        PairStore::new(right.path().into())
            .unwrap()
            .read_snapshot()
            .unwrap()
    );
}

#[test]
fn window_caps_chain_and_aggregate_refuse_whole_while_legacy_cap_remains_64() {
    let (_dir, store, window, _, _) = setup(4, 64, false);
    let before = store.read_snapshot().unwrap();
    for mode in [
        "zero",
        "five",
        "65channels",
        "65health",
        "chain",
        "bytes",
        "source-grant",
    ] {
        let mut bad = duplicate(&window);
        match mode {
            "zero" => bad.chunks.clear(),
            "five" => {
                let extra =
                    serde_json::from_value(serde_json::to_value(&bad.chunks[0]).unwrap()).unwrap();
                bad.chunks.push(extra);
            }
            "65channels" => {
                let extra = bad.chunks[0].catalog_patch.channels[0].clone();
                bad.chunks[0].catalog_patch.channels.push(extra);
            }
            "65health" => {
                let extra = bad.chunks[0].incoming_health[0].clone();
                bad.chunks[0].incoming_health.push(extra);
            }
            "chain" => bad.chunks[3].catalog_patch.base_channel_count += 1,
            "bytes" => bad.next_preferences["oversize"] = json!("x".repeat(20 * 1024 * 1024)),
            _ => bad.next_preferences["sources"][0]["allowHttp"] = json!(true),
        }
        assert!(store.commit_scan_window(&bad, || Ok(())).is_err());
        assert_eq!(store.read_snapshot().unwrap(), before);
    }
    let (_, _, too_big, _, _) = setup(1, 65, false);
    let batch = crate::scan_batch::Batch {
        schema_version: 1,
        catalog_patch: serde_json::from_value(
            serde_json::to_value(&too_big.chunks[0].catalog_patch).unwrap(),
        )
        .unwrap(),
        authorized_sources: too_big.authorized_sources,
        next_preferences: too_big.next_preferences,
        incoming_health: too_big.chunks.into_iter().next().unwrap().incoming_health,
        expected_catalog_revision: "1".into(),
        expected_health_revision: "0".into(),
        scan_checkpoint: None,
        expected_checkpoint_revision: None,
    };
    assert_eq!(
        crate::scan_batch::validate_envelope(&batch).unwrap_err(),
        "scan-batch-invalid"
    );
}

#[test]
fn fourth_chunk_bad_source_health_or_checkpoint_cas_rolls_back_all_publication() {
    let (_dir, store, window, _, _) = setup(4, 64, true);
    let before = store.read_snapshot().unwrap();
    for mode in [
        "source",
        "health",
        "checkpoint",
        "catalog-cas",
        "health-cas",
    ] {
        let mut bad = duplicate(&window);
        let expected = match mode {
            "source" => {
                bad.chunks[3].catalog_patch.channels[0]["sourceId"] = json!("foreign");
                "scan-batch-source-refused"
            }
            "health" => {
                bad.chunks[3].incoming_health[0]["channelId"] = json!("missing");
                "health-target-mismatch"
            }
            "checkpoint" => {
                bad.expected_checkpoint_revision = Some("1".into());
                "scan-checkpoint-revision-stale"
            }
            "catalog-cas" => {
                bad.expected_catalog_revision = "0".into();
                "catalog-revision-stale"
            }
            _ => {
                bad.expected_health_revision = "1".into();
                "health-revision-stale"
            }
        };
        assert_eq!(
            store.commit_scan_window(&bad, || Ok(())).unwrap_err(),
            expected
        );
        assert_eq!(store.read_snapshot().unwrap(), before);
        assert_eq!(
            store.read_scan_checkpoint().unwrap().checkpoint_status,
            "absent"
        );
    }
}

#[test]
fn window_cancel_backup_or_after_sql_rolls_back_but_late_abort_returns_whole_ack() {
    let (dir, store, window, _, _) = setup(4, 64, true);
    let before = store.read_snapshot().unwrap();
    assert_eq!(
        store
            .commit_scan_window_observed(
                &window,
                &mut |phase| if phase == Phase::DuringBackup {
                    Err("canceled".into())
                } else {
                    Ok(())
                },
                None
            )
            .unwrap_err(),
        "canceled"
    );
    assert_eq!(store.read_snapshot().unwrap(), before);
    let mut written = false;
    assert_eq!(
        store
            .commit_scan_window_observed(
                &window,
                &mut |phase| {
                    if phase == Phase::AfterCatalog {
                        written = true;
                    }
                    if written && phase == Phase::BeforeCommit {
                        Err("canceled".into())
                    } else {
                        Ok(())
                    }
                },
                None
            )
            .unwrap_err(),
        "canceled"
    );
    assert!(written);
    assert_eq!(store.read_snapshot().unwrap(), before);
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "absent"
    );
    let mut committed = false;
    let receipt = store
        .commit_scan_window_observed(
            &window,
            &mut |phase| {
                if phase == Phase::AfterCommit {
                    committed = true;
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
            None,
        )
        .unwrap();
    assert!(committed && receipt.committed);
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("1"));
    let reopened = PairStore::new(dir.path().into()).unwrap();
    assert_eq!(
        reopened.read_snapshot().unwrap(),
        store.read_snapshot().unwrap()
    );
    assert_eq!(
        reopened.read_scan_checkpoint().unwrap().checkpoint_revision,
        "1"
    );
}

#[test]
fn later_chunk_source_is_authorized_by_final_preferences_without_early_mirror_refusal() {
    let (_dir, store, mut window, _, _) = setup(2, 64, false);
    let mut later = window.authorized_sources[0].clone();
    later["id"] = json!("later");
    later["name"] = json!("Later source");
    window.authorized_sources.push(later.clone());
    window.next_preferences["sources"]
        .as_array_mut()
        .unwrap()
        .push(later.clone());
    window.chunks[1].catalog_patch.sources.push(later.clone());
    window.chunks[1].catalog_patch.final_source_count = 2;
    let later_chunk = &mut window.chunks[1];
    for (channel, record) in later_chunk
        .catalog_patch
        .channels
        .iter_mut()
        .zip(later_chunk.incoming_health.iter_mut())
    {
        channel["sourceId"] = json!("later");
        record["sourceId"] = json!("later");
        record["targetFingerprint"] =
            json!(crate::health_storage::fingerprint(&later, channel, 0).unwrap());
    }
    let receipt = store.commit_scan_window(&window, || Ok(())).unwrap();
    assert_eq!(receipt.catalog_revision, "2");
    let snapshot = store.read_snapshot().unwrap();
    assert_eq!(
        parse(snapshot.pair.catalog.as_ref().unwrap()).unwrap()["sources"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        crate::health_storage::parse(snapshot.health.as_ref().unwrap())
            .unwrap()
            .len(),
        128
    );
}

#[test]
fn checkpoint_keeps_more_than_256_settled_observations_without_publishing_failed_keys() {
    let (_dir, store, mut window, _, _) = setup(4, 64, true);
    let crate::scan_checkpoint::Mutation::Save { checkpoint } =
        window.scan_checkpoint.as_mut().unwrap()
    else {
        panic!("fixture save")
    };
    let mut cp: Value = serde_json::from_str(checkpoint).unwrap();
    let at = cp["createdAtMs"].clone();
    for index in 256..320 {
        let candidate = json!({"key":format!("key-{index}"),"sourceId":"public","sourceFingerprint":"scope","sessionRevision":"session","channel":{"sourceId":"public","providerId":format!("provider-{index}"),"name":format!("Fixture {index}"),"category":"News","urls":[format!("https://fixture.invalid/{index}.m3u8")]}});
        cp["review"]["candidates"]
            .as_array_mut()
            .unwrap()
            .push(candidate);
        cp["observations"].as_array_mut().unwrap().push(json!({"channelId":format!("key-{index}"),"sourceId":"public","fingerprint":"scope","platform":"windows","observedAt":at,"verdict":"TimedOut","evidence":{"kind":"timeout"}}));
    }
    cp["review"]["sources"][0]["inspected"] = json!(320);
    cp["review"]["sources"][0]["matched"] = json!(320);
    cp["review"]["counts"]["inspected"] = json!(320);
    cp["review"]["counts"]["matched"] = json!(320);
    *checkpoint = cp.to_string();
    store.commit_scan_window(&window, || Ok(())).unwrap();
    let saved: Value = serde_json::from_str(
        store
            .read_scan_checkpoint()
            .unwrap()
            .checkpoint
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(saved["observations"].as_array().unwrap().len(), 320);
    assert_eq!(saved["publishedKeys"].as_array().unwrap().len(), 256);
}

#[test]
fn cross_chunk_health_preserves_local_evidence_and_rejects_within_chunk_duplicates() {
    let (_dir, store, mut window, catalog, _) = setup(2, 0, false);
    let channel = &catalog["channels"][0];
    let source = &catalog["sources"][0];
    let first = json!({"schemaVersion":1,"channelId":"old","sourceId":"public","checkedUrlOrdinal":0,"targetFingerprint":crate::health_storage::fingerprint(source,channel,0).unwrap(),"platform":"windows","observerProfile":"fixture","observedAt":100,"verdict":"Reachable","origin":"local","evidence":{"kind":"recognized-media-response"}});
    let mut second = first.clone();
    second["observedAt"] = json!(200);
    second["origin"] = json!("imported");
    window.chunks[0].incoming_health = vec![first.clone()];
    window.chunks[1].incoming_health = vec![second];
    let receipt = store.commit_scan_window(&window, || Ok(())).unwrap();
    assert_eq!(receipt.catalog_revision, "1");
    assert_eq!(receipt.health_revision, "1");
    let snapshot = store.read_snapshot().unwrap();
    let records: Value = serde_json::from_str(snapshot.health.as_ref().unwrap()).unwrap();
    assert_eq!(records["records"][0]["origin"], "local");
    assert_eq!(records["records"][0]["observedAt"], 100);
    let mut bad = duplicate(&window);
    bad.expected_health_revision = "1".into();
    bad.chunks[0].incoming_health = vec![first.clone(), first];
    assert_eq!(
        store.commit_scan_window(&bad, || Ok(())).unwrap_err(),
        "health-duplicate-record"
    );
    assert_eq!(store.read_snapshot().unwrap(), snapshot);
}

#[test]
fn window_wire_unknown_fields_are_not_accepted_as_native_authority() {
    let (_dir, _store, window, _, _) = setup(1, 1, false);
    let mut raw = serde_json::to_value(&window).unwrap();
    raw["preparationId"] = json!("not-native-authority");
    assert!(serde_json::from_value::<Window>(raw).is_err());
    let mut raw = serde_json::to_value(&window).unwrap();
    raw["chunks"][0]["nextPreferences"] = json!({});
    assert!(serde_json::from_value::<Window>(raw).is_err());
}
