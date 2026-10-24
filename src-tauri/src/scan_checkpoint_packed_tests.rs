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

//! Real SQLite packed-v3 admission and atomic progress fixtures. No public-network work.
use super::*;

fn stored(store: &PairStore) -> Value {
    let snapshot = store.read_scan_checkpoint().unwrap();
    assert_eq!(snapshot.checkpoint_status, "valid");
    serde_json::from_str(snapshot.checkpoint.as_ref().unwrap()).unwrap()
}
fn seed(store: &PairStore, value: &Value) -> Value {
    let packed = scan_checkpoint::packed_fixture(value);
    store
        .write_pair_with_scan(
            &RecordPair::default(),
            None,
            (Some("1"), None),
            Some((&save(&packed), "0")),
            || Ok(()),
        )
        .unwrap();
    packed
}
fn advance(packed: &Value, observations: Vec<Value>, keys: Vec<&str>) -> Mutation {
    Mutation::Advance {
        job_id: packed["jobId"].as_str().unwrap().into(),
        review_digest: packed["reviewDigest"].as_str().unwrap().into(),
        observations,
        published_keys: keys.into_iter().map(str::to_owned).collect(),
    }
}
fn progress(store: &PairStore, mutation: &Mutation, cp: &str) -> Result<CommitReceipt, String> {
    store.write_pair_with_scan(
        &RecordPair::default(),
        None,
        (Some("1"), None),
        Some((mutation, cp)),
        || Ok(()),
    )
}
fn denied() -> Value {
    json!({"channelId":"key-a","sourceId":"public","fingerprint":"scope-a","platform":"windows","observedAt":scan_now(),"verdict":"AccessDenied","evidence":{"kind":"http","status":403}})
}

#[test]
fn packed_exact_ts_digest_vector_matches_without_expanded_review_serialization() {
    let mut v = json!({"categoryTable":["General"],"review":{"sessionRevision":"runtime-capture","query":"","status":"completed",
        "sources":[{"sourceId":"source","fingerprint":"captured-fingerprint","status":"completed","inspected":1,"matched":1,"warnings":0}],
        "counts":{"inspected":1,"matched":1,"failedSources":0,"canceledSources":0},
        "candidates":[["captured-key",0,[],"Live",0,[],[],"askvdn5LeQlLZPKYyL8DVAXLJ8hn6GH_osbrqNXMFlA",["RDpwfxEObcvLRQAPGkYdxlPLzdyF7FPmlH7DLedY5yc"]]]}});
    scan_checkpoint::packed_redigest(&mut v);
    assert_eq!(
        v["reviewDigest"],
        "30d78a2c2000257f0655e83c6c6a803699c475f5aee17d04a667ec65e15626ee"
    );
}
#[test]
fn packed_save_exact_metadata_alternates_and_reopen_preserve_wire_three() {
    let (dir, store, mut catalog, prefs, mut value) = fixture();
    let c = &mut value["review"]["candidates"][0]["channel"];
    c["name"] = json!("Actual fixture · 国際");
    c["urls"] = json!([
        "https://example.com/media.m3u8?public=1",
        "https://example.com/alternate.ts"
    ]);
    c["geography"] = json!({"country":"US","state":"US-IL"});
    c["geographyProvenance"] = json!([{"field":"country","value":"US","sourceId":"public","kind":"m3u","scope":"channel-origin"}]);
    publish(&mut value, &mut catalog);
    let packed = scan_checkpoint::packed_fixture(&value);
    let text = packed.to_string();
    assert!(!text.contains("media.m3u8"));
    assert!(!text.contains("publishedKeys"));
    let receipt = store
        .write_pair_with_scan(
            &RecordPair {
                catalog: Some(catalog.to_string()),
                preferences: Some(prefs.to_string()),
            },
            None,
            (Some("1"), None),
            Some((&save(&packed), "0")),
            || Ok(()),
        )
        .unwrap();
    assert!(receipt.committed);
    drop(store);
    let reopened = PairStore::new(dir.path().to_owned()).unwrap();
    let restored = stored(&reopened);
    assert_eq!(restored["schemaVersion"], 3);
    assert_eq!(restored["review"], packed["review"]);
    assert_eq!(restored["categoryTable"], packed["categoryTable"]);
    assert_eq!(restored["reviewDigest"], packed["reviewDigest"]);
    assert_eq!(restored["catalogRevision"], "2");
    assert_eq!(restored["publishedIndices"], json!([0]));
    let mut wrong = catalog.clone();
    wrong["channels"][0]["urls"] = json!(["https://example.com/wrong.ts"]);
    assert_eq!(
        scan_checkpoint::validate(&packed.to_string(), &prefs, &wrong, 1, scan_now()).unwrap_err(),
        "scan-checkpoint-unpublished-channel"
    );
}
#[test]
fn packed_advance_atomic_publication_health_and_reopen_retains_immutable_review() {
    let (dir, store, mut catalog, _prefs, mut value) = fixture();
    let packed = seed(&store, &value);
    publish(&mut value, &mut catalog);
    let delta = advance(
        &packed,
        value["observations"].as_array().unwrap().clone(),
        vec!["key-a"],
    );
    let fingerprint =
        crate::health_storage::fingerprint(&catalog["sources"][0], &catalog["channels"][0], 0)
            .unwrap();
    let health=json!({"schemaVersion":1,"records":[{"schemaVersion":1,"channelId":"saved-id","sourceId":"public","checkedUrlOrdinal":0,
        "targetFingerprint":fingerprint,"platform":"windows","observerProfile":"resource-v1","observedAt":scan_now(),"verdict":"Reachable",
        "evidence":{"kind":"recognized-media-response"},"origin":"local"}]}).to_string();
    let before = store.read_snapshot().unwrap();
    let receipt = store
        .write_pair_with_scan(
            &RecordPair {
                catalog: Some(catalog.to_string()),
                preferences: None,
            },
            Some(&health),
            (Some("1"), Some(&before.health_revision)),
            Some((&delta, "1")),
            || Ok(()),
        )
        .unwrap();
    assert_eq!(receipt.catalog_revision, "2");
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("2"));
    drop(store);
    let reopened = PairStore::new(dir.path().to_owned()).unwrap();
    let result = stored(&reopened);
    assert_eq!(result["schemaVersion"], 3);
    assert_eq!(result["review"], packed["review"]);
    assert_eq!(result["reviewDigest"], packed["reviewDigest"]);
    assert_eq!(result["observations"][0][0], 0);
    assert_eq!(result["publishedIndices"], json!([0]));
    let health: Value =
        serde_json::from_str(reopened.read_snapshot().unwrap().health.as_ref().unwrap()).unwrap();
    assert_eq!(health["records"][0]["channelId"], "saved-id");
}
#[test]
fn packed_standalone_denial_retry_conflict_duplicates_and_cas_are_atomic() {
    let (_dir, store, _catalog, _prefs, value) = fixture();
    let packed = seed(&store, &value);
    let observation = denied();
    let delta = advance(&packed, vec![observation.clone()], vec![]);
    progress(&store, &delta, "1").unwrap();
    let first = stored(&store);
    progress(&store, &delta, "2").unwrap();
    assert_eq!(first, stored(&store));
    assert_eq!(
        progress(&store, &delta, "2").unwrap_err(),
        "scan-checkpoint-revision-stale"
    );
    let before = store.read_snapshot().unwrap();
    let cp = stored(&store);
    let mut changed = observation.clone();
    changed["evidence"]["status"] = json!(451);
    for bad in [
        advance(&packed, vec![changed], vec![]),
        advance(
            &packed,
            vec![observation.clone(), observation.clone()],
            vec![],
        ),
        advance(&packed, vec![], vec!["key-a"]),
        advance(&packed, vec![], vec!["unknown"]),
    ] {
        assert!(progress(&store, &bad, "3").is_err());
        assert_eq!(stored(&store), cp);
        assert_eq!(
            store.read_snapshot().unwrap().catalog_revision,
            before.catalog_revision
        );
    }
    let mut foreign = observation;
    foreign["sourceId"] = json!("foreign");
    assert!(progress(&store, &advance(&packed, vec![foreign], vec![]), "3").is_err());
    assert_eq!(stored(&store), cp);
}
#[test]
fn packed_tuple_canonicality_and_unknown_fields_refuse_without_pair_writes() {
    let (_dir, store, catalog, prefs, value) = fixture();
    let packed = scan_checkpoint::packed_fixture(&value);
    let before = store.read_pair().unwrap();
    for kind in [
        "short",
        "long",
        "source-index",
        "category-index",
        "slot-null",
        "slot-two",
        "hash-tail",
        "hash-padding",
        "unused-category",
        "duplicate-key",
        "geography-slot",
        "provenance-kind",
        "unknown-field",
        "bad-digest",
        "duplicate-observation",
    ] {
        let mut bad = packed.clone();
        match kind {
            "short" => {
                bad["review"]["candidates"][0].as_array_mut().unwrap().pop();
            }
            "long" => bad["review"]["candidates"][0]
                .as_array_mut()
                .unwrap()
                .push(json!(0)),
            "source-index" => bad["review"]["candidates"][0][1] = json!(1),
            "category-index" => bad["review"]["candidates"][0][4] = json!(1),
            "slot-null" => bad["review"]["candidates"][0][2] = json!([null]),
            "slot-two" => bad["review"]["candidates"][0][2] = json!(["x", "y"]),
            "hash-tail" => {
                let h = bad["review"]["candidates"][0][7]
                    .as_str()
                    .unwrap()
                    .to_string();
                let mut bytes = h.into_bytes();
                bytes[42] = b'B';
                bad["review"]["candidates"][0][7] = json!(String::from_utf8(bytes).unwrap());
            }
            "hash-padding" => {
                let h = bad["review"]["candidates"][0][7]
                    .as_str()
                    .unwrap()
                    .to_string();
                bad["review"]["candidates"][0][7] = json!(h + "=");
            }
            "unused-category" => bad["categoryTable"]
                .as_array_mut()
                .unwrap()
                .push(json!("unused")),
            "duplicate-key" => {
                let c = bad["review"]["candidates"][0].clone();
                bad["review"]["candidates"].as_array_mut().unwrap().push(c);
            }
            "geography-slot" => bad["review"]["candidates"][0][5] = json!([[[]]]),
            "provenance-kind" => bad["review"]["candidates"][0][6] = json!([[[0, "US", [], 4, 0]]]),
            "unknown-field" => bad["extra"] = json!(true),
            "bad-digest" => bad["reviewDigest"] = json!("0".repeat(64)),
            "duplicate-observation" => {
                bad["observations"] = json!([[0,scan_now(),"AccessDenied",{"kind":"http","status":403}],[0,scan_now(),"AccessDenied",{"kind":"http","status":403}]])
            }
            _ => unreachable!(),
        }
        if kind != "bad-digest" {
            scan_checkpoint::packed_redigest(&mut bad);
        }
        assert!(
            scan_checkpoint::validate(&bad.to_string(), &prefs, &catalog, 1, scan_now()).is_err(),
            "{kind}"
        );
        assert!(
            store
                .write_pair_with_scan(
                    &RecordPair::default(),
                    None,
                    (Some("1"), None),
                    Some((&save(&bad), "0")),
                    || Ok(())
                )
                .is_err(),
            "{kind}"
        );
        assert_eq!(before, store.read_pair().unwrap());
        assert_eq!(
            store.read_scan_checkpoint().unwrap().checkpoint_revision,
            "0"
        );
    }
}
#[test]
fn packed_policy_ttl_and_cancellation_preserve_existing_checkpoint() {
    let (_dir, store, catalog, prefs, value) = fixture();
    let packed = seed(&store, &value);
    let before = store.read_pair().unwrap();
    let cp = stored(&store);
    assert_eq!(
        scan_checkpoint::validate(
            &packed.to_string(),
            &prefs,
            &catalog,
            1,
            scan_now() + 86_400_001
        )
        .unwrap_err(),
        "scan-checkpoint-expired"
    );
    let mut region = prefs.clone();
    region["preferredRegion"] = json!({"country":"US","origin":"manual"});
    assert_eq!(
        scan_checkpoint::validate(&packed.to_string(), &region, &catalog, 1, scan_now())
            .unwrap_err(),
        "scan-checkpoint-policy-stale"
    );
    let mut no_sources = catalog.clone();
    no_sources["sources"] = json!([]);
    assert_eq!(
        scan_checkpoint::validate(&packed.to_string(), &prefs, &no_sources, 1, scan_now())
            .unwrap_err(),
        "scan-checkpoint-policy-stale"
    );
    let delta = advance(&packed, vec![denied()], vec![]);
    let mut calls = 0;
    assert!(store
        .write_pair_with_scan(
            &RecordPair::default(),
            None,
            (Some("1"), None),
            Some((&delta, "1")),
            || {
                calls += 1;
                if calls >= 5 {
                    Err("fixture-cancelled".into())
                } else {
                    Ok(())
                }
            }
        )
        .is_err());
    assert_eq!(stored(&store), cp);
    assert_eq!(store.read_pair().unwrap(), before);
}
#[test]
fn packed_cross_format_same_job_save_refuses_while_legacy_continue_remains_valid() {
    for initial_three in [false, true] {
        let (_dir, store, _catalog, _prefs, value) = fixture();
        let reference = scan_checkpoint::reference_fixture(&value);
        let packed = scan_checkpoint::packed_fixture(&value);
        let initial = if initial_three { &packed } else { &reference };
        let changed = if initial_three { &reference } else { &packed };
        store
            .write_pair_with_scan(
                &RecordPair::default(),
                None,
                (Some("1"), None),
                Some((&save(initial), "0")),
                || Ok(()),
            )
            .unwrap();
        assert_eq!(
            progress(&store, &save(changed), "1").unwrap_err(),
            "scan-checkpoint-job-stale"
        );
        progress(&store, &save(initial), "1").unwrap();
        assert_eq!(
            stored(&store)["schemaVersion"],
            if initial_three { 3 } else { 2 }
        );
    }
}
#[test]
fn packed_late_checkpoint_sql_failure_rolls_back_catalog_health_and_progress() {
    let (_dir, store, mut catalog, _prefs, mut value) = fixture();
    let packed = seed(&store, &value);
    publish(&mut value, &mut catalog);
    let before = store.read_snapshot().unwrap();
    let cp = stored(&store);
    let mut connection = connect(&store.root.join(DB), false).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_packed_progress BEFORE UPDATE ON scan_checkpoint BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    let delta = advance(
        &packed,
        value["observations"].as_array().unwrap().clone(),
        vec!["key-a"],
    );
    let error = PairStore::apply_with_scan(
        &mut connection,
        &RecordPair {
            catalog: Some(catalog.to_string()),
            preferences: None,
        },
        Some("{\"schemaVersion\":1,\"records\":[]}"),
        (Some(1), Some(before.health_revision.parse().unwrap())),
        Some((&delta, 1, scan_now())),
        |_| Ok(()),
    )
    .unwrap_err();
    assert_eq!(error, "scan-checkpoint-storage-failed");
    let after = store.read_snapshot().unwrap();
    assert_eq!(before.pair, after.pair);
    assert_eq!(before.health, after.health);
    assert_eq!(before.catalog_revision, after.catalog_revision);
    assert_eq!(before.health_revision, after.health_revision);
    assert_eq!(cp, stored(&store));
}
#[test]
fn packed_sqlite_disk_full_preserves_canonical_pair_and_absent_checkpoint() {
    let (_dir, store, mut catalog, prefs, mut value) = fixture();
    let before = store.read_pair().unwrap();
    value["review"]["candidates"][0]["channel"]["name"] = json!("n".repeat(12000));
    publish(&mut value, &mut catalog);
    let packed = scan_checkpoint::packed_fixture(&value);
    let mut connection = connect(&store.root.join(DB), false).unwrap();
    scan_checkpoint::ensure(&connection).unwrap();
    connection
        .execute_batch("CREATE TABLE packed_full_probe(value BLOB)")
        .unwrap();
    let pages: i64 = connection
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap();
    connection
        .execute_batch(&format!("PRAGMA max_page_count={pages}"))
        .unwrap();
    loop {
        match connection.execute("INSERT INTO packed_full_probe VALUES(zeroblob(1000))", []) {
            Ok(_) => {}
            Err(e) => {
                assert_eq!(e.sqlite_error_code(), Some(rusqlite::ErrorCode::DiskFull));
                break;
            }
        }
    }
    let error = PairStore::apply_with_scan(
        &mut connection,
        &RecordPair {
            catalog: Some(catalog.to_string()),
            preferences: Some(prefs.to_string()),
        },
        None,
        (Some(1), None),
        Some((&save(&packed), 0, scan_now())),
        |_| Ok(()),
    )
    .unwrap_err();
    assert_eq!(error, "sqlite-storage-full");
    assert_eq!(before, store.read_pair().unwrap());
    assert!(store.read_scan_checkpoint().unwrap().checkpoint.is_none());
}
fn large(value: &Value, n: usize) -> Value {
    let mut packed = scan_checkpoint::packed_fixture(value);
    let template = packed["review"]["candidates"][0].clone();
    packed["review"]["candidates"] = Value::Array(
        (0..n)
            .map(|i| {
                let mut c = template.clone();
                c[0] = json!(format!("key-{i:06}"));
                c[3] = json!(format!("Fixture channel {i:06} {}", "x".repeat(88)));
                c
            })
            .collect(),
    );
    packed["review"]["sources"][0]["inspected"] = json!(n);
    packed["review"]["sources"][0]["matched"] = json!(n);
    packed["review"]["counts"]["inspected"] = json!(n);
    packed["review"]["counts"]["matched"] = json!(n);
    if n < 100_000 {
        scan_checkpoint::packed_redigest(&mut packed);
    }
    packed
}
#[test]
fn packed_13k_and_63k_sqlite_save_reopen_and_stop_delta_fit_without_expanded_v2_wire() {
    for n in [13_241, 63_193] {
        let (dir, store, _catalog, _prefs, value) = fixture();
        let packed = large(&value, n);
        let wire = packed.to_string();
        eprintln!("packed-v3 fixture candidates={n} bytes={}", wire.len());
        assert!(wire.len() < 20 * 1024 * 1024);
        assert!(!wire.contains("candidateDigest"));
        store
            .write_pair_with_scan(
                &RecordPair::default(),
                None,
                (Some("1"), None),
                Some((&save(&packed), "0")),
                || Ok(()),
            )
            .unwrap();
        drop(store);
        let reopened = PairStore::new(dir.path().to_owned()).unwrap();
        let checkpoint = stored(&reopened);
        assert_eq!(
            checkpoint["review"]["candidates"].as_array().unwrap().len(),
            n
        );
        let mut o = denied();
        o["channelId"] = json!("key-000000");
        progress(&reopened, &advance(&packed, vec![o], vec![]), "1").unwrap();
        let next = stored(&reopened);
        assert_eq!(next["review"], packed["review"]);
        assert_eq!(next["observations"][0][0], 0);
        assert_eq!(next["observations"].as_array().unwrap().len(), 1);
        assert_eq!(next["schemaVersion"], 3);
    }
}
#[test]
fn packed_actual_100k_oversize_refuses_whole_without_truncation_or_progress_write() {
    let (_dir, store, catalog, prefs, value) = fixture();
    let before = store.read_pair().unwrap();
    let packed = large(&value, 100_000);
    let wire = packed.to_string();
    assert!(wire.len() > 20 * 1024 * 1024);
    assert_eq!(
        scan_checkpoint::validate(&wire, &prefs, &catalog, 1, scan_now()).unwrap_err(),
        "scan-checkpoint-too-large"
    );
    assert!(store
        .write_pair_with_scan(
            &RecordPair::default(),
            None,
            (Some("1"), None),
            Some((&save(&packed), "0")),
            || Ok(())
        )
        .is_err());
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "0"
    );
    assert_eq!(store.read_pair().unwrap(), before);
}
