use super::*;

fn fixture(flag: Option<bool>) -> (tempfile::TempDir, PairStore, Value, Value) {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let source = json!({"id":"source","name":"Fixture","kind":"url","location":"https://example.invalid/list.m3u","allowHttp":false,"contentKind":"catalog","mediaMime":"audio/x-mpegurl"});
    let catalog = json!({"schemaVersion":1,"sources":[source],"channels":[{"id":"one","sourceId":"source","providerId":"provider","name":"Fixture channel","category":"Sports","urls":["https://example.invalid/one.m3u8","https://example.invalid/alternate.m3u8"],"geography":{"country":"US","state":"US-IL"},"geographyProvenance":[{"field":"country","value":"US","sourceId":"source","providerId":"provider","kind":"m3u","scope":"provider-declared"}]}]});
    let mut prefs = json!({"schemaVersion":1,"sources":catalog["sources"],"favorites":["one","missing"],"removedChannels":["missing-removed"],"volume":0.5,"muted":true,"panelWidth":350,"automaticSourceRefresh":true,"sourceRefreshCadence":"off","sourceRefreshAttemptAt":0,"voiceSearchConsent":false,"reviewedChannelProviders":[],"reviewedGuideProviders":[],"preferredRegion":{"country":"US","state":"US-IL","postal":"00501","origin":"manual"},"channelCategoryOverrides":[{"channelId":"one","category":"Local"}]});
    if let Some(flag) = flag {
        prefs["automaticGuideUpdates"] = json!(flag);
    }
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    (root, store, catalog, prefs)
}

fn health(catalog: &Value) -> String {
    json!({"schemaVersion":1,"records":[{"schemaVersion":1,"channelId":"one","sourceId":"source","checkedUrlOrdinal":0,"targetFingerprint":crate::health_storage::fingerprint(&catalog["sources"][0],&catalog["channels"][0],0).unwrap(),"platform":"android","observerProfile":"fixture","observedAt":100,"verdict":"Reachable","origin":"local","evidence":{"kind":"recognized-media-response"}}]}).to_string()
}

#[test]
fn validated_catalog_matches_exact_canonical_pair_and_snapshot_bytes() {
    for flag in [None, Some(false), Some(true)] {
        let (root, store, catalog, _) = fixture(flag);
        store
            .write_health_guarded(&health(&catalog), "1", "0", || Ok(()))
            .unwrap();
        let c = connect(&root.path().join(DB), true).unwrap();
        let (pair, parsed) =
            PairStore::finish_pair_validated(PairStore::capture_pair(&c).unwrap()).unwrap();
        assert_eq!(
            pair,
            PairStore::finish_pair(PairStore::capture_pair(&c).unwrap()).unwrap()
        );
        assert_eq!(
            parsed,
            pair.catalog.as_deref().map(parse).transpose().unwrap()
        );
        assert_eq!(
            parsed.as_ref().unwrap()["sources"][0].get("allowHttp"),
            None
        );
        let preferences = parse(pair.preferences.as_ref().unwrap()).unwrap();
        assert_eq!(
            preferences
                .get("automaticGuideUpdates")
                .and_then(Value::as_bool),
            flag
        );
        assert_eq!(preferences["automaticSourceRefresh"], false);
        assert_eq!(preferences["preferredRegion"]["postal"], "00501");
        let snapshot = store.read_snapshot().unwrap();
        assert_eq!(snapshot.pair, pair);
        assert_eq!(snapshot.catalog_revision, "1");
        assert_eq!(snapshot.health_revision, "1");
        assert_eq!(snapshot.health, crate::health_storage::read(&c).unwrap());
    }
}

#[test]
fn writer_commits_after_capture_and_old_health_uses_old_validated_catalog() {
    let (_root, store, mut catalog, prefs) = fixture(Some(false));
    store
        .write_health_guarded(&health(&catalog), "1", "0", || Ok(()))
        .unwrap();
    let old = store.read_snapshot().unwrap();
    catalog["channels"][0]["urls"] = json!(["https://example.invalid/replacement.m3u8"]);
    let captured = store
        .read_snapshot_after_capture(|| store.write_pair(&catalog.to_string(), &prefs.to_string()))
        .unwrap();
    assert_eq!(captured, old);
    let new = store.read_snapshot().unwrap();
    assert_eq!(new.catalog_revision, "2");
    assert_eq!(new.health_revision, "2");
    assert_eq!(
        parse(new.pair.catalog.as_ref().unwrap()).unwrap()["channels"][0]["urls"],
        catalog["channels"][0]["urls"]
    );
    assert_eq!(
        serde_json::from_str::<Value>(new.health.as_ref().unwrap()).unwrap()["records"],
        json!([])
    );
}

#[test]
fn captured_corruption_and_oversize_keep_existing_exact_refusal_categories() {
    for (statement, expected) in [
        (
            "UPDATE channel SET geography_provenance='invalid'",
            "sqlite-invalid-geography",
        ),
        (
            "UPDATE preference SET preferred_region='invalid'",
            "record-invalid-json",
        ),
    ] {
        let (root, store, _, _) = fixture(None);
        let c = connect(&root.path().join(DB), false).unwrap();
        c.execute_batch(statement).unwrap();
        assert_eq!(
            PairStore::finish_pair(PairStore::capture_pair(&c).unwrap()).unwrap_err(),
            expected
        );
        assert_eq!(
            PairStore::finish_pair_validated(PairStore::capture_pair(&c).unwrap()).unwrap_err(),
            expected
        );
        assert_eq!(store.read_snapshot().unwrap_err(), expected);
    }
    let (_root, store, _, _) = fixture(None);
    let pair = store.read_pair().unwrap();
    let mut catalog = parse(pair.catalog.as_ref().unwrap()).unwrap();
    catalog["channels"][0]["name"] = json!("x".repeat(LIMIT as usize + 1));
    let captured = || CapturedPair {
        catalog: Some(catalog.clone()),
        preferences: pair.preferences.as_deref().map(parse).transpose().unwrap(),
        extensions: [None, None, None],
    };
    assert_eq!(
        PairStore::finish_pair(captured()).unwrap_err(),
        "record-too-large"
    );
    assert_eq!(
        PairStore::finish_pair_validated(captured()).unwrap_err(),
        "record-too-large"
    );
}

#[test]
fn inconsistent_stored_health_still_refuses_without_mutation() {
    let (root, store, catalog, _) = fixture(None);
    let c = connect(&root.path().join(DB), false).unwrap();
    let mut invalid: Value = serde_json::from_str(&health(&catalog)).unwrap();
    invalid["records"][0]["targetFingerprint"] = json!("0".repeat(64));
    crate::health_storage::replace(&c, Some(&invalid.to_string())).unwrap();
    let before = std::fs::read(root.path().join(DB)).unwrap();
    assert_eq!(
        store.read_snapshot().unwrap_err(),
        "health-stored-target-mismatch"
    );
    assert_eq!(std::fs::read(root.path().join(DB)).unwrap(), before);
}
