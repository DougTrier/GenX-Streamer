use super::*;
use crate::scan_checkpoint::{self, Mutation};

#[path = "scan_checkpoint_advance_tests.rs"]
mod advance_tests;
#[path = "scan_checkpoint_packed_tests.rs"]
mod packed_tests;

fn fixture() -> (tempfile::TempDir, PairStore, Value, Value, Value) {
    let dir = tempfile::tempdir().unwrap();
    let store = PairStore::new(dir.path().to_owned()).unwrap();
    let source = json!({"id":"public","name":"Public","kind":"url","location":"https://iptv-org.github.io/iptv/index.m3u","allowHttp":false});
    let catalog = json!({"schemaVersion":1,"sources":[source.clone()],"channels":[]});
    let prefs = json!({"schemaVersion":1,"sources":[source.clone()],"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":300.0});
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    let channel = json!({"sourceId":"public","providerId":"Station","name":"Station","category":"News","urls":["https://example.com/media.m3u8?public=1"]});
    let now = scan_now();
    let fp = scan_checkpoint::source_fingerprint(&source).unwrap();
    let mut checkpoint = json!({"schemaVersion":1,"jobId":"job-a","createdAtMs":now,"catalogRevision":"1","policyFingerprint":"","sourceDefinitions":[{"source":source,"definitionFingerprint":fp}],"budgetMs":20000,"platform":"windows","observerProfile":"resource-v1","review":{"sessionRevision":"session-a","query":"","status":"completed","sources":[{"sourceId":"public","fingerprint":"scope-a","status":"completed","inspected":1,"matched":1,"warnings":0}],"candidates":[{"key":"key-a","sourceId":"public","sourceFingerprint":"scope-a","sessionRevision":"session-a","channel":channel}],"counts":{"inspected":1,"matched":1,"failedSources":0,"canceledSources":0}},"observations":[],"publishedKeys":[]});
    checkpoint["policyFingerprint"] =
        json!(scan_checkpoint::policy_fingerprint(&checkpoint, &prefs).unwrap());
    (dir, store, catalog, prefs, checkpoint)
}
fn save(v: &Value) -> Mutation {
    Mutation::Save {
        checkpoint: v.to_string(),
    }
}
fn publish(v: &mut Value, catalog: &mut Value) {
    let mut ch = v["review"]["candidates"][0]["channel"].clone();
    ch["id"] = json!("saved-id");
    catalog["channels"] = json!([ch]);
    v["observations"] = json!([{"channelId":"key-a","sourceId":"public","fingerprint":"scope-a","platform":"windows","observedAt":scan_now(),"verdict":"Reachable","evidence":{"kind":"recognized-media-response"}}]);
    v["publishedKeys"] = json!(["key-a"]);
}

#[test]
fn reference_checkpoint_v2_is_url_free_durable_and_validates_exact_published_hashes() {
    let (dir, store, mut catalog, prefs, mut value) = fixture();
    value["review"]["candidates"][0]["channel"]["urls"] = json!([
        "https://public.invalid/live/secret-user/secret-pass/one.ts",
        "https://public.invalid/backup.ts"
    ]);
    publish(&mut value, &mut catalog);
    let reference = scan_checkpoint::reference_fixture(&value);
    let text = reference.to_string();
    assert!(!text.contains("secret-user"));
    assert!(!text.contains("secret-pass"));
    let result = store
        .write_pair_with_scan(
            &RecordPair {
                catalog: Some(catalog.to_string()),
                preferences: Some(prefs.to_string()),
            },
            None,
            (Some("1"), None),
            Some((&save(&reference), "0")),
            || Ok(()),
        )
        .unwrap();
    assert_eq!(result.catalog_revision, "2");
    drop(store);
    let store = PairStore::new(dir.path().to_owned()).unwrap();
    let snap = store.read_scan_checkpoint().unwrap();
    assert_eq!(snap.checkpoint_status, "valid");
    let restored: Value = serde_json::from_str(snap.checkpoint.as_ref().unwrap()).unwrap();
    assert_eq!(restored["schemaVersion"], 2);
    assert_eq!(restored["publishedKeys"], json!(["key-a"]));
    assert!(restored["review"]["candidates"][0]["channel"]
        .get("urls")
        .is_none());
    let mut changed = catalog.clone();
    changed["channels"][0]["urls"] = json!([
        "https://public.invalid/backup.ts",
        "https://public.invalid/live/secret-user/secret-pass/one.ts"
    ]);
    assert!(store
        .write_pair_with_scan(
            &RecordPair {
                catalog: Some(changed.to_string()),
                preferences: None
            },
            None,
            (Some("2"), None),
            Some((&save(&restored), "1")),
            || Ok(())
        )
        .is_err());
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "1"
    );
}

#[test]
fn reference_checkpoint_malformed_hash_metadata_or_raw_url_refuses_atomic_write() {
    let (_dir, store, _catalog, _prefs, value) = fixture();
    let reference = scan_checkpoint::reference_fixture(&value);
    for kind in [
        "raw-url",
        "missing-reference",
        "invalid-hash",
        "duplicate-hash",
        "bad-geography",
        "digest",
    ] {
        let mut bad = reference.clone();
        let c = &mut bad["review"]["candidates"][0];
        match kind {
            "raw-url" => {
                c["channel"]["urls"] = json!(["https://secret.invalid/live/user/password/file"])
            }
            "missing-reference" => {
                c.as_object_mut().unwrap().remove("reference");
            }
            "invalid-hash" => c["reference"]["candidateDigest"] = json!("invalid"),
            "duplicate-hash" => {
                let h = c["reference"]["urlHashes"][0].clone();
                c["reference"]["urlHashes"] = json!([h, h]);
            }
            "bad-geography" => c["channel"]["geography"] = json!({"country":"US","state":"CA-ON"}),
            _ => bad["reviewDigest"] = json!("0".repeat(64)),
        }
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
        assert_eq!(
            store.read_scan_checkpoint().unwrap().checkpoint_revision,
            "0"
        );
    }
}
#[test]
fn checkpoint_restart_atomic_publication_and_tombstone_cas() {
    let (dir, store, mut catalog, prefs, mut value) = fixture();
    let receipt = store
        .write_pair_with_scan(
            &RecordPair::default(),
            None,
            (Some("1"), None),
            Some((&save(&value), "0")),
            || Ok(()),
        )
        .unwrap();
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("1"));
    assert_eq!(receipt.catalog_revision, "1");
    publish(&mut value, &mut catalog);
    let receipt = store
        .write_pair_with_scan(
            &RecordPair {
                catalog: Some(catalog.to_string()),
                preferences: Some(prefs.to_string()),
            },
            None,
            (Some("1"), None),
            Some((&save(&value), "1")),
            || Ok(()),
        )
        .unwrap();
    assert_eq!(receipt.catalog_revision, "2");
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("2"));
    drop(store);
    let store = PairStore::new(dir.path().to_owned()).unwrap();
    let snap = store.read_scan_checkpoint().unwrap();
    let stored: Value = serde_json::from_str(snap.checkpoint.as_ref().unwrap()).unwrap();
    assert_eq!(stored["catalogRevision"], "2");
    assert_eq!(stored["publishedKeys"], json!(["key-a"]));
    let mutation = Mutation::Discard {
        job_id: "job-a".into(),
    };
    let receipt = store
        .write_pair_with_scan(
            &RecordPair::default(),
            None,
            (Some("2"), None),
            Some((&mutation, "2")),
            || Ok(()),
        )
        .unwrap();
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("3"));
    assert!(store.read_scan_checkpoint().unwrap().checkpoint.is_none());
    assert_eq!(
        store
            .write_pair_with_scan(
                &RecordPair::default(),
                None,
                (Some("2"), None),
                Some((&save(&stored), "2")),
                || Ok(())
            )
            .unwrap_err(),
        "scan-checkpoint-revision-stale"
    );
}
#[test]
fn checkpoint_cancel_rolls_back_pair_and_late_cancel_keeps_durable_receipt() {
    let (_dir, store, mut catalog, prefs, mut v) = fixture();
    publish(&mut v, &mut catalog);
    let p = RecordPair {
        catalog: Some(catalog.to_string()),
        preferences: Some(prefs.to_string()),
    };
    let mut c = connect(&store.root.join(DB), false).unwrap();
    let mutation = save(&v);
    let err = PairStore::apply_with_scan(
        &mut c,
        &p,
        None,
        (Some(1), None),
        Some((&mutation, 0, scan_now())),
        |phase| {
            if phase == Phase::BeforeCommit {
                Err("canceled".into())
            } else {
                Ok(())
            }
        },
    )
    .unwrap_err();
    assert_eq!(err, "canceled");
    assert_eq!(store.read_snapshot().unwrap().catalog_revision, "1");
    assert!(store.read_scan_checkpoint().unwrap().checkpoint.is_none());
    let mut checks = 0;
    let receipt = store
        .write_pair_with_scan(&p, None, (Some("1"), None), Some((&mutation, "0")), || {
            checks += 1;
            Ok(())
        })
        .unwrap();
    assert!(checks > 0);
    assert!(receipt.committed);
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("1"));
    assert_eq!(store.read_snapshot().unwrap().catalog_revision, "2");
}
#[test]
fn checkpoint_refuses_unpublished_targets_policy_shift_secret_source_and_expiry() {
    let (_dir, store, catalog, prefs, mut v) = fixture();
    let before = store.read_pair().unwrap();
    v["observations"] = json!([{"channelId":"key-a","sourceId":"public","fingerprint":"scope-a","platform":"windows","observedAt":scan_now(),"verdict":"Reachable","evidence":{"kind":"recognized-media-response"}}]);
    v["publishedKeys"] = json!(["key-a"]);
    assert_eq!(
        scan_checkpoint::validate(&v.to_string(), &prefs, &catalog, 1, scan_now()).unwrap_err(),
        "scan-checkpoint-unpublished-channel"
    );
    v["publishedKeys"] = json!([]);
    let mut changed = prefs.clone();
    changed["reviewedChannelProviders"] = json!([]);
    assert_eq!(
        scan_checkpoint::validate(&v.to_string(), &changed, &catalog, 1, scan_now()).unwrap_err(),
        "scan-checkpoint-policy-stale"
    );
    assert_eq!(
        scan_checkpoint::validate(&v.to_string(), &prefs, &catalog, 1, scan_now() + 86_400_001)
            .unwrap_err(),
        "scan-checkpoint-expired"
    );
    v["sourceDefinitions"][0]["source"]["location"] =
        json!("https://example.com/get.php?username=private");
    assert_eq!(
        scan_checkpoint::validate(&v.to_string(), &prefs, &catalog, 1, scan_now()).unwrap_err(),
        "scan-checkpoint-source-not-resumable"
    );
    assert_eq!(before, store.read_pair().unwrap());
}
#[test]
fn pending_http_candidates_and_public_query_urls_do_not_grant_network_or_skip_checks() {
    let (_dir, _store, mut catalog, prefs, mut v) = fixture();
    v["review"]["candidates"][0]["channel"]["urls"] =
        json!(["http://example.com/channel.m3u8?public=1"]);
    scan_checkpoint::validate(&v.to_string(), &prefs, &catalog, 1, scan_now()).unwrap();
    assert_eq!(v["sourceDefinitions"][0]["source"]["allowHttp"], false);
    v["review"]["candidates"][0]["channel"]["urls"] =
        json!(["https://example.com/channel.m3u8?public=1"]);
    publish(&mut v, &mut catalog);
    catalog["channels"][0]["urls"] = json!([
        "https://example.com/retained.m3u8",
        "https://example.com/channel.m3u8?public=1"
    ]);
    scan_checkpoint::validate(&v.to_string(), &prefs, &catalog, 1, scan_now()).unwrap();
    v["observations"][0]["verdict"] = json!("PlayedHere");
    assert_eq!(
        scan_checkpoint::validate(&v.to_string(), &prefs, &catalog, 1, scan_now()).unwrap_err(),
        "scan-checkpoint-invalid"
    );
}
#[test]
fn published_geography_keeps_canonical_extras_but_checks_declared_fields_and_provenance() {
    let (_dir, _store, mut catalog, prefs, mut value) = fixture();
    value["review"]["candidates"][0]["channel"]["geography"] = json!({"country":"US"});
    value["review"]["candidates"][0]["channel"]["geographyProvenance"] = json!([{"field":"country","value":"US","sourceId":"public","kind":"m3u","scope":"channel-origin"}]);
    publish(&mut value, &mut catalog);
    catalog["channels"][0]["geography"]["state"] = json!("US-IL");
    scan_checkpoint::validate(&value.to_string(), &prefs, &catalog, 1, scan_now()).unwrap();
    catalog["channels"][0]["geography"]["country"] = json!("CA");
    assert!(
        scan_checkpoint::validate(&value.to_string(), &prefs, &catalog, 1, scan_now()).is_err()
    );
    catalog["channels"][0]["geography"]["country"] = json!("US");
    catalog["channels"][0]["geographyProvenance"][0]["kind"] = json!("user");
    catalog["channels"][0]["geographyProvenance"][0]["scope"] = json!("user-reviewed");
    assert_eq!(
        scan_checkpoint::validate(&value.to_string(), &prefs, &catalog, 1, scan_now()).unwrap_err(),
        "scan-checkpoint-unpublished-channel"
    );
    value["review"]["candidates"][0]["channel"]
        .as_object_mut()
        .unwrap()
        .remove("geographyProvenance");
    scan_checkpoint::validate(&value.to_string(), &prefs, &catalog, 1, scan_now()).unwrap();
}
#[test]
fn checkpoint_sqlite_full_and_corrupt_operational_state_preserve_canonical_data() {
    let (_dir, store, mut catalog, prefs, mut v) = fixture();
    let before = store.read_pair().unwrap();
    publish(&mut v, &mut catalog);
    let mut c = connect(&store.root.join(DB), false).unwrap();
    scan_checkpoint::ensure(&c).unwrap();
    c.execute_batch("CREATE TABLE full_checkpoint_probe(value BLOB)")
        .unwrap();
    let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    c.execute_batch(&format!("PRAGMA max_page_count={pages}"))
        .unwrap();
    loop {
        match c.execute(
            "INSERT INTO full_checkpoint_probe VALUES(zeroblob(1000))",
            [],
        ) {
            Ok(_) => {}
            Err(error) => {
                assert_eq!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DiskFull)
                );
                break;
            }
        }
    }
    catalog["channels"][0]["name"] = json!("n".repeat(12000));
    v["review"]["candidates"][0]["channel"]["name"] = catalog["channels"][0]["name"].clone();
    let p = RecordPair {
        catalog: Some(catalog.to_string()),
        preferences: Some(prefs.to_string()),
    };
    let err = PairStore::apply_with_scan(
        &mut c,
        &p,
        None,
        (Some(1), None),
        Some((&save(&v), 0, scan_now())),
        |_| Ok(()),
    )
    .unwrap_err();
    assert_eq!(err, "sqlite-storage-full");
    assert_eq!(before, store.read_pair().unwrap());
    assert!(store.read_scan_checkpoint().unwrap().checkpoint.is_none());
    c.execute(
        "UPDATE scan_checkpoint SET contents='not-json',job_id='job-a'",
        [],
    )
    .unwrap();
    let corrupt = store.read_scan_checkpoint().unwrap();
    assert_eq!(corrupt.checkpoint_status, "invalid");
    assert!(corrupt.checkpoint.is_none());
    assert_eq!(corrupt.job_id.as_deref(), Some("job-a"));
    let discard = Mutation::Discard {
        job_id: "job-a".into(),
    };
    store
        .write_pair_with_scan(
            &RecordPair::default(),
            None,
            (Some("1"), None),
            Some((&discard, "0")),
            || Ok(()),
        )
        .unwrap();
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "absent"
    );
    assert_eq!(before, store.read_pair().unwrap());
}

#[test]
fn checkpoint_hashes_match_shared_fixed_vectors() {
    let source = json!({"id":"source","name":"Fixture public index","kind":"url","location":"https://iptv-org.github.io/iptv/index.m3u","allowHttp":false});
    let fingerprint = scan_checkpoint::source_fingerprint(&source).unwrap();
    assert_eq!(
        fingerprint,
        "7180d692189df916a2c430928b7b7ac4442b2512151a5f7b106ba667cc738a0b"
    );
    // Published cross-language golden vector has fixed inputs, not the editable registry.
    let providers = json!({"reviewedChannelProviders":[
        {"id":"iptv-org-global","name":"IPTV.org global channels","location":"https://iptv-org.github.io/iptv/index.m3u","provenance":"https://github.com/iptv-org/iptv","allowHttp":false},
        {"id":"free-tv-public","name":"Free-TV public channels","location":"https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8","provenance":"https://github.com/Free-TV/IPTV","allowHttp":false}
    ]});
    let checkpoint = json!({"sourceDefinitions":[{"definitionFingerprint":fingerprint}],"budgetMs":20000,"platform":"browser","observerProfile":"fixture"});
    assert_eq!(
        scan_checkpoint::policy_fingerprint(&checkpoint, &providers).unwrap(),
        "b59abac492a7017a0044bc08bbf63a585ca5d9155d46384f8b179595b6afb842"
    );
}

#[test]
fn checkpoint_writers_and_out_of_band_catalog_change_cannot_rebase_or_forget_progress() {
    let (dir, store, mut catalog, prefs, mut v) = fixture();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    // The production Store owns one serialized writer lease across backup and
    // commit. Raw independent PairStores race the shared backup replacement
    // before they reach checkpoint CAS, which is not this fixture's contract.
    let owner = std::sync::Arc::new(
        crate::storage::Store::new(dir.path().to_owned(), "fixture".into()).unwrap(),
    );
    let mut children = Vec::new();
    for _ in 0..2 {
        let owner = owner.clone();
        let value = v.clone();
        let barrier = barrier.clone();
        children.push(std::thread::spawn(move || {
            barrier.wait();
            owner.write_pair_with_scan(
                &RecordPair::default(),
                None,
                (Some("1"), None),
                Some((&save(&value), "0")),
                || Ok(()),
            )
        }));
    }
    let results: Vec<_> = children.into_iter().map(|c| c.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert!(
        results.iter().any(|r| r
            .as_ref()
            .err()
            .is_some_and(|e| e == "scan-checkpoint-revision-stale")),
        "checkpoint writer outcomes: {:?}",
        results
            .iter()
            .map(|r| r
                .as_ref()
                .map(|_| "committed")
                .unwrap_or_else(|error| error.as_str()))
            .collect::<Vec<_>>()
    );
    let mut changed = v.clone();
    changed["jobId"] = json!("job-b");
    assert_eq!(
        store
            .write_pair_with_scan(
                &RecordPair::default(),
                None,
                (Some("1"), None),
                Some((&save(&changed), "1")),
                || Ok(())
            )
            .unwrap_err(),
        "scan-checkpoint-job-stale"
    );
    publish(&mut v, &mut catalog);
    store
        .write_pair_with_scan(
            &RecordPair {
                catalog: Some(catalog.to_string()),
                preferences: Some(prefs.to_string()),
            },
            None,
            (Some("1"), None),
            Some((&save(&v), "1")),
            || Ok(()),
        )
        .unwrap();
    v["catalogRevision"] = json!("2");
    let mut forgotten = v.clone();
    forgotten["publishedKeys"] = json!([]);
    assert_eq!(
        store
            .write_pair_with_scan(
                &RecordPair::default(),
                None,
                (Some("2"), None),
                Some((&save(&forgotten), "2")),
                || Ok(())
            )
            .unwrap_err(),
        "scan-checkpoint-progress-stale"
    );
    let mut unrelated = catalog["channels"][0].clone();
    unrelated["id"] = json!("other");
    unrelated["name"] = json!("Other");
    catalog["channels"].as_array_mut().unwrap().push(unrelated);
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    v["catalogRevision"] = json!("3");
    assert_eq!(
        store
            .write_pair_with_scan(
                &RecordPair::default(),
                None,
                (Some("3"), None),
                Some((&save(&v), "2")),
                || Ok(())
            )
            .unwrap_err(),
        "catalog-revision-stale"
    );
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "2"
    );
}

#[test]
fn checkpoint_real_process_kill_never_splits_publication_and_progress() {
    const CHILD: &str = "GENX_TEST_CHECKPOINT_CHILD_ROOT";
    if let Some(root) = std::env::var_os(CHILD) {
        let (_unused, _store, mut catalog, prefs, mut checkpoint) = fixture();
        publish(&mut checkpoint, &mut catalog);
        let root = PathBuf::from(root);
        let phase = std::env::var("GENX_TEST_CHECKPOINT_CHILD_PHASE").unwrap();
        let mut c = connect(&root.join(DB), false).unwrap();
        PairStore::apply_with_scan(
            &mut c,
            &RecordPair {
                catalog: Some(catalog.to_string()),
                preferences: Some(prefs.to_string()),
            },
            None,
            (Some(1), None),
            Some((&save(&checkpoint), 0, scan_now())),
            |at| {
                let wanted = match phase.as_str() {
                    "before" => Phase::BeforeCommit,
                    "after" => Phase::AfterCommit,
                    _ => panic!("fixture phase"),
                };
                if at == wanted {
                    let mut marker = File::create(root.join("child-checkpoint-ready")).unwrap();
                    use std::io::Write;
                    marker.write_all(b"ready").unwrap();
                    marker.sync_all().unwrap();
                    std::thread::sleep(Duration::from_secs(30));
                }
                Ok(())
            },
        )
        .unwrap();
        return;
    }
    for phase in ["before", "after"] {
        let (dir, store, _catalog, _prefs, _checkpoint) = fixture();
        let original = store.read_pair().unwrap();
        drop(store);
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args(["--exact","storage_transaction::scan_checkpoint_tests::checkpoint_real_process_kill_never_splits_publication_and_progress","--nocapture"])
            .env(CHILD,dir.path()).env("GENX_TEST_CHECKPOINT_CHILD_PHASE",phase)
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !dir.path().join("child-checkpoint-ready").exists()
            && std::time::Instant::now() < deadline
        {
            if child.try_wait().unwrap().is_some() {
                panic!("owned checkpoint child exited before barrier")
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let ready = dir.path().join("child-checkpoint-ready").exists();
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());
        assert!(ready, "checkpoint barrier deadline");
        let reopened = PairStore::new(dir.path().to_owned()).unwrap();
        let pair = reopened.read_pair().unwrap();
        let checkpoint = reopened.read_scan_checkpoint().unwrap();
        if phase == "before" {
            assert_eq!(pair, original);
            assert!(checkpoint.checkpoint.is_none());
            assert_eq!(checkpoint.catalog_revision, "1");
        } else {
            let catalog: Value = serde_json::from_str(pair.catalog.as_ref().unwrap()).unwrap();
            assert_eq!(catalog["channels"].as_array().unwrap().len(), 1);
            let saved: Value =
                serde_json::from_str(checkpoint.checkpoint.as_ref().unwrap()).unwrap();
            assert_eq!(saved["catalogRevision"], "2");
            assert_eq!(saved["publishedKeys"], json!(["key-a"]));
            assert_eq!(checkpoint.catalog_revision, "2");
        }
        let c = connect(&dir.path().join(DB), true).unwrap();
        integrity(&c).unwrap();
    }
}

#[test]
fn canonical_custom_and_file_checkpoint_admission_preserves_scope_guards() {
    for (kind, location) in [
        ("url", "https://custom.example/feed.m3u"),
        ("file", "owned.m3u"),
    ] {
        let (_dir, _store, mut catalog, prefs, mut value) = fixture();
        let mut source = catalog["sources"][0].clone();
        source["kind"] = json!(kind);
        source["location"] = json!(location);
        catalog["sources"][0] = source.clone();
        value["sourceDefinitions"][0]["source"] = source.clone();
        value["sourceDefinitions"][0]["definitionFingerprint"] =
            json!(scan_checkpoint::source_fingerprint(&source).unwrap());
        value["policyFingerprint"] =
            json!(scan_checkpoint::policy_fingerprint(&value, &prefs).unwrap());
        assert!(
            scan_checkpoint::validate(&value.to_string(), &prefs, &catalog, 1, scan_now()).is_ok()
        );
        let mut foreign = catalog.clone();
        foreign["sources"][0]["id"] = json!("foreign");
        assert_eq!(
            scan_checkpoint::validate(&value.to_string(), &prefs, &foreign, 1, scan_now())
                .unwrap_err(),
            if kind == "url" {
                "scan-checkpoint-policy-stale"
            } else {
                "scan-checkpoint-source-not-resumable"
            }
        );
        let mut changed = catalog.clone();
        changed["sources"][0]["allowHttp"] = json!(true);
        assert_eq!(
            scan_checkpoint::validate(&value.to_string(), &prefs, &changed, 1, scan_now())
                .unwrap_err(),
            "scan-checkpoint-policy-stale"
        );
        changed["sources"][0] = source;
        changed["sources"][0]["name"] = json!("Changed");
        assert_eq!(
            scan_checkpoint::validate(&value.to_string(), &prefs, &changed, 1, scan_now())
                .unwrap_err(),
            "scan-checkpoint-policy-stale"
        );
    }
}

#[test]
fn mixed_canonical_custom_and_unpublished_approved_provider_scope_is_not_truncated() {
    let (_dir, _store, mut catalog, mut prefs, mut value) = fixture();
    let mut approved = value["sourceDefinitions"][0]["source"].clone();
    approved["id"] = json!("approved-unpublished");
    prefs["reviewedChannelProviders"] = json!([{"id":"reviewed-discovered","name":"Discovered public source","location":approved["location"],"provenance":"https://publisher.example/catalog","allowHttp":false}]);
    let mut custom = catalog["sources"][0].clone();
    custom["location"] = json!("https://custom.example/catalog.m3u");
    catalog["sources"][0] = custom.clone();
    value["sourceDefinitions"] = json!([
        {"source":custom,"definitionFingerprint":scan_checkpoint::source_fingerprint(&custom).unwrap()},
        {"source":approved,"definitionFingerprint":scan_checkpoint::source_fingerprint(&approved).unwrap()}
    ]);
    value["review"]["sources"].as_array_mut().unwrap().push(json!({"sourceId":"approved-unpublished","fingerprint":"approved-scope","status":"failed","inspected":0,"matched":0,"warnings":0}));
    value["review"]["counts"]["failedSources"] = json!(1);
    value["policyFingerprint"] =
        json!(scan_checkpoint::policy_fingerprint(&value, &prefs).unwrap());
    let admitted =
        scan_checkpoint::validate(&value.to_string(), &prefs, &catalog, 1, scan_now()).unwrap();
    assert_eq!(admitted["sourceDefinitions"].as_array().unwrap().len(), 2);
    let mut changed = prefs.clone();
    changed["reviewedChannelProviders"] = json!([]);
    assert_eq!(
        scan_checkpoint::validate(&value.to_string(), &changed, &catalog, 1, scan_now())
            .unwrap_err(),
        "scan-checkpoint-policy-stale"
    );
}

#[test]
fn checkpoint_explicit_reviewed_registry_policy_is_deterministic_and_exact_scope_bound() {
    let providers = json!({"reviewedChannelProviders":[
        {"id":"public-a","name":"Explicit source A","location":"https://iptv-org.github.io/iptv/index.m3u","provenance":"https://github.com/iptv-org/iptv","allowHttp":false},
        {"id":"public-b","name":"Explicit source B","location":"https://publisher.example/catalog.m3u","provenance":"https://publisher.example/about","allowHttp":false}
    ]});
    let source = json!({"id":"source","name":"Fixture public index","kind":"url","location":"https://iptv-org.github.io/iptv/index.m3u","allowHttp":false});
    let fingerprint = scan_checkpoint::source_fingerprint(&source).unwrap();
    let checkpoint = json!({"sourceDefinitions":[{"definitionFingerprint":fingerprint}],"budgetMs":20000,"platform":"browser","observerProfile":"fixture"});
    let expected = scan_checkpoint::policy_fingerprint(&checkpoint, &providers).unwrap();
    assert_eq!(
        scan_checkpoint::policy_fingerprint(&checkpoint, &providers).unwrap(),
        expected
    );
    let mut changed = providers.clone();
    changed["reviewedChannelProviders"]
        .as_array_mut()
        .unwrap()
        .reverse();
    assert_ne!(
        scan_checkpoint::policy_fingerprint(&checkpoint, &changed).unwrap(),
        expected
    );
    changed = providers.clone();
    changed["reviewedChannelProviders"][0]["name"] = json!("Changed reviewed descriptor");
    assert_ne!(
        scan_checkpoint::policy_fingerprint(&checkpoint, &changed).unwrap(),
        expected
    );
    changed = providers;
    changed["channelCategoryOverrides"] = json!([{"channelId":"one","category":"News"}]);
    assert_eq!(
        scan_checkpoint::policy_fingerprint(&checkpoint, &changed).unwrap(),
        expected
    );
}

#[test]
fn unpublished_source_requires_explicit_persisted_descriptor_never_factory_fallback() {
    let (_dir, _store, mut catalog, prefs, mut value) = fixture();
    // A newly discovered public source has no canonical source yet. Its saved
    // descriptor is authority; neither a shipped registry nor a familiar URL is.
    catalog["sources"] = json!([]);
    value["sourceDefinitions"][0]["source"]["location"] =
        json!("https://discovered.example/catalog.m3u");
    let source = value["sourceDefinitions"][0]["source"].clone();
    value["sourceDefinitions"][0]["definitionFingerprint"] =
        json!(scan_checkpoint::source_fingerprint(&source).unwrap());
    for raw in [None, Some(Value::Null), Some(json!([]))] {
        let mut configured = prefs.clone();
        if let Some(raw) = raw {
            configured["reviewedChannelProviders"] = raw;
        }
        assert_eq!(
            scan_checkpoint::validate(&value.to_string(), &configured, &catalog, 1, scan_now())
                .unwrap_err(),
            "scan-checkpoint-policy-stale"
        );
    }
    let mut configured = prefs.clone();
    configured["reviewedChannelProviders"] = json!([{"id":"discovered","name":"Explicit discovery","location":source["location"],"provenance":"https://discovered.example/about","allowHttp":false}]);
    value["policyFingerprint"] =
        json!(scan_checkpoint::policy_fingerprint(&value, &configured).unwrap());
    assert!(
        scan_checkpoint::validate(&value.to_string(), &configured, &catalog, 1, scan_now()).is_ok()
    );
    for (field, changed) in [
        ("location", json!("https://other.example/catalog.m3u")),
        ("allowHttp", json!(true)),
    ] {
        let mut hostile = configured.clone();
        hostile["reviewedChannelProviders"][0][field] = changed;
        assert_eq!(
            scan_checkpoint::validate(&value.to_string(), &hostile, &catalog, 1, scan_now())
                .unwrap_err(),
            "scan-checkpoint-policy-stale"
        );
    }
    let mut credential = value.clone();
    credential["sourceDefinitions"][0]["source"]["location"] =
        json!("https://user:secret@discovered.example/catalog.m3u");
    assert_eq!(
        scan_checkpoint::validate(
            &credential.to_string(),
            &configured,
            &catalog,
            1,
            scan_now()
        )
        .unwrap_err(),
        "scan-checkpoint-source-not-resumable"
    );
}

#[test]
fn canonical_saved_source_remains_authoritative_when_user_registry_is_missing_or_empty() {
    let (_dir, _store, catalog, prefs, mut value) = fixture();
    for raw in [None, Some(json!([]))] {
        let mut configured = prefs.clone();
        if let Some(raw) = raw {
            configured["reviewedChannelProviders"] = raw;
        }
        value["policyFingerprint"] =
            json!(scan_checkpoint::policy_fingerprint(&value, &configured).unwrap());
        assert!(scan_checkpoint::validate(
            &value.to_string(),
            &configured,
            &catalog,
            1,
            scan_now()
        )
        .is_ok());
        let mut changed = catalog.clone();
        changed["sources"][0]["allowHttp"] = json!(true);
        assert_eq!(
            scan_checkpoint::validate(&value.to_string(), &configured, &changed, 1, scan_now())
                .unwrap_err(),
            "scan-checkpoint-policy-stale"
        );
    }
}

#[test]
fn reference_hashes_match_typescript_utf8_tuple_vector() {
    let value = json!({"review":{"sessionRevision":"runtime-capture","query":"","status":"completed","sources":[{"sourceId":"source","fingerprint":"captured-fingerprint","status":"completed","inspected":1,"matched":1,"warnings":0}],"counts":{"inspected":1,"matched":1,"failedSources":0,"canceledSources":0},"candidates":[{"key":"captured-key","sourceId":"source","sourceFingerprint":"captured-fingerprint","sessionRevision":"runtime-capture","channel":{"sourceId":"source","name":"Σήμα 📺","category":"General","urls":["https://stream.fixture.invalid/live/secret-user/secret-pass/first.ts","https://backup.fixture.invalid/second.ts"]}}]}});
    let reference = scan_checkpoint::reference_fixture(&value);
    assert_eq!(
        reference["review"]["candidates"][0]["reference"]["candidateDigest"],
        "002a3e171a51536b5ea5fb6d5c6d4ae45cdda25972aeb49265824608379c892b"
    );
    assert_eq!(
        reference["review"]["candidates"][0]["reference"]["urlHashes"],
        json!([
            "758da0a233e1396f0aa1e3428fc897189ea25679559b88ddfab6c993eed7f019",
            "ce826b1bc21e777cf5231d3e82a28306403dafa4685791c75d88bfbaff6c7827"
        ])
    );
    assert_eq!(
        reference["reviewDigest"],
        "da0bb844d3f9deaeb39343b4eb138c797d8e1a3e22fa0b14dfb4fd2c58bcc627"
    );
}
