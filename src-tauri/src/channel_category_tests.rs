use super::*;
fn fixture() -> (tempfile::TempDir, PairStore, Value, Value) {
    let dir = tempfile::tempdir().unwrap();
    let store = PairStore::new(dir.path().into()).unwrap();
    let catalog = json!({"schemaVersion":1,"sources":[{"id":"s","name":"Fixture","kind":"file","location":"fixture.m3u"}],"channels":[{"id":"one","sourceId":"s","providerId":"one","name":"Same name","category":"Sports","urls":["https://example.invalid/one"]},{"id":"two","sourceId":"s","providerId":"two","name":"Same name","category":"Sports","urls":["https://example.invalid/two"]}]});
    let prefs = json!({"schemaVersion":1,"sources":catalog["sources"],"favorites":["two","orphan-favorite"],"removedChannels":["orphan-removed"],"volume":0.5,"muted":false,"panelWidth":300});
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    (dir, store, catalog, prefs)
}
fn page(
    store: &PairStore,
    text: &str,
    filter: crate::catalog_query::Filter,
) -> crate::catalog_query::Page {
    let mut q = tests::catalog_query();
    q.query = text.into();
    q.filter = filter;
    store
        .query_catalog_page(
            &q,
            &std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .unwrap()
}
#[test]
fn category_override_roundtrip_query_reset_and_refresh_keep_provider_identity() {
    let (dir, store, mut catalog, mut prefs) = fixture();
    let before = store.read_snapshot().unwrap();
    let old_page = page(&store, "", crate::catalog_query::Filter::All);
    prefs["channelCategoryOverrides"] =
        json!([{"channelId":"one","category":"News"},{"channelId":"missing","category":"Music"}]);
    store.write("preferences", &prefs.to_string()).unwrap();
    let after = store.read_snapshot().unwrap();
    assert_eq!(after.catalog_revision, before.catalog_revision);
    assert_eq!(after.health_revision, before.health_revision);
    let new_page = page(&store, "", crate::catalog_query::Filter::All);
    assert_ne!(new_page.view_revision, old_page.view_revision);
    assert_eq!(new_page.rows[0].category, "News");
    assert_eq!(new_page.rows[1].category, "Sports");
    assert_eq!(
        page(&store, "", crate::catalog_query::Filter::News).rows[0].id,
        "one"
    );
    assert_eq!(
        page(&store, "Sports", crate::catalog_query::Filter::All).rows[0].id,
        "two"
    );
    assert_eq!(
        page(&store, "Music", crate::catalog_query::Filter::All).total_count,
        0
    );
    let saved: Value = serde_json::from_str(after.pair.preferences.as_ref().unwrap()).unwrap();
    assert_eq!(
        saved["channelCategoryOverrides"],
        prefs["channelCategoryOverrides"]
    );
    assert_eq!(
        serde_json::from_str::<Value>(after.pair.catalog.as_ref().unwrap()).unwrap(),
        catalog
    );
    catalog["channels"][0]["category"] = json!("Documentary");
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    let reopened = PairStore::new(dir.path().into()).unwrap();
    assert_eq!(
        page(&reopened, "News", crate::catalog_query::Filter::All).rows[0].id,
        "one"
    );
    let canonical: Value =
        serde_json::from_str(reopened.read_pair().unwrap().catalog.as_ref().unwrap()).unwrap();
    assert_eq!(canonical["channels"][0]["category"], "Documentary");
    prefs["channelCategoryOverrides"] = json!([]);
    reopened.write("preferences", &prefs.to_string()).unwrap();
    assert_eq!(
        page(&reopened, "Documentary", crate::catalog_query::Filter::All).rows[0].id,
        "one"
    );
}
#[test]
fn category_override_migration_9_to_10_preserves_canonical_health_guides_and_backup() {
    let (dir, store, catalog, _) = fixture();
    let fingerprint =
        crate::health_storage::fingerprint(&catalog["sources"][0], &catalog["channels"][0], 0)
            .unwrap();
    let health=json!({"schemaVersion":1,"records":[{"schemaVersion":1,"channelId":"one","sourceId":"s","checkedUrlOrdinal":0,"targetFingerprint":fingerprint,"platform":"windows","observerProfile":"native-mse-v1","observedAt":100,"verdict":"Reachable","evidence":{"kind":"http","status":200,"contentRecognized":true},"origin":"local"}]}).to_string();
    let snapshot = store.read_snapshot().unwrap();
    store
        .write_health_guarded(
            &health,
            &snapshot.catalog_revision,
            &snapshot.health_revision,
            || Ok(()),
        )
        .unwrap();
    let c = connect(&dir.path().join(DB), false).unwrap();
    c.execute_batch("DROP TABLE public_archive_variant_v1;DROP TABLE public_archive_item_v1;DROP TABLE public_archive_preference_v1;DROP TABLE public_archive_removal_v1;DROP TABLE public_archive_checkpoint_v1;DROP TABLE archive_bookmark_v1;DROP TABLE archive_bookmark_meta_v1;DROP TABLE archive_file_v1;DROP TABLE archive_item_progress_v1;DROP TABLE archive_progress_v1;DROP TABLE archive_preferences_v1;DROP TABLE archive_removal_v1;DROP TABLE archive_title_v1;DROP TABLE archive_catalog_meta_v1;DROP TABLE catalog_endpoint_projection_v1;INSERT INTO guide_source(id,name,location,kind,allow_http,revision,updated_ms,published_revision) VALUES('guide','Fixture guide','guide.xml','file',0,1,100,1);INSERT INTO guide_channel VALUES('guide','xmltv','[\"Fixture\"]','fixture');INSERT INTO guide_program(guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,description,search_text) VALUES('guide',0,'xmltv',0,1000,'Fixture program',NULL,'fixture program');INSERT INTO guide_mapping VALUES('s','one','guide','xmltv');DROP TABLE channel_category_override;ALTER TABLE metadata DROP COLUMN automatic_guide_updates;PRAGMA user_version=9;").unwrap();
    drop(c);
    let before = store.read_snapshot().unwrap();
    drop(store);
    let reopened = PairStore::new(dir.path().into()).unwrap();
    assert_eq!(reopened.read_snapshot().unwrap(), before);
    let c = connect(&dir.path().join(DB), true).unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        16
    );
    assert_eq!(
        c.query_row("SELECT title FROM guide_program", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "Fixture program"
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM guide_mapping", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let backup = connect(&dir.path().join(BACKUP), true).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        9
    );
    integrity(&backup).unwrap();
}
#[test]
fn category_override_cas_fault_and_invalid_data_cannot_publish_or_invalidate_cursor() {
    let (dir, store, catalog, mut prefs) = fixture();
    let before = store.read_snapshot().unwrap();
    let mut q = tests::catalog_query();
    q.page_size = 1;
    let old = store
        .query_catalog_page(
            &q,
            &std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .unwrap();
    let cursor = old.after.unwrap();
    prefs["channelCategoryOverrides"] = json!([{"channelId":"one","category":"News"}]);
    assert_eq!(
        store
            .write_guarded_cas(
                &catalog.to_string(),
                &prefs.to_string(),
                None,
                (Some("0"), Some(&before.health_revision)),
                || Ok(())
            )
            .unwrap_err(),
        "catalog-revision-stale"
    );
    let pair = RecordPair {
        catalog: None,
        preferences: Some(prefs.to_string()),
    };
    assert!(store
        .commit(&pair, |phase| if phase == Phase::BeforeCommit {
            Err("fixture-fault".into())
        } else {
            Ok(())
        })
        .is_err());
    assert_eq!(store.read_snapshot().unwrap(), before);
    assert_eq!(
        page(&store, "News", crate::catalog_query::Filter::All).total_count,
        0
    );
    store.write("preferences", &prefs.to_string()).unwrap();
    q.expected_catalog_revision = Some(cursor.catalog_revision.clone());
    q.expected_view_revision = Some(cursor.view_revision.clone());
    q.after = Some(cursor);
    assert_eq!(
        store
            .query_catalog_page(
                &q,
                &std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false))
            )
            .unwrap_err(),
        "catalog-view-revision-stale"
    );
    let valid = store.read_snapshot().unwrap();
    for overrides in [
        json!([{"channelId":"one","category":"bad\nvalue"}]),
        json!([{"channelId":"one","category":"News"},{"channelId":"one","category":"Sports"}]),
        json!([{"channelId":"one","category":"News","extra":"discard?"}]),
    ] {
        prefs["channelCategoryOverrides"] = overrides;
        assert!(store.write("preferences", &prefs.to_string()).is_err());
        assert_eq!(store.read_snapshot().unwrap(), valid);
    }
    assert_eq!(
        PairStore::new(dir.path().into())
            .unwrap()
            .read_snapshot()
            .unwrap(),
        valid
    );
}
#[test]
fn category_override_byte_bounds_and_unchanged_sql_rows_are_explicit() {
    let (dir, store, _, mut prefs) = fixture();
    prefs["channelCategoryOverrides"] = json!([{"channelId":"one","category":"界".repeat(170)}]);
    store.write("preferences", &prefs.to_string()).unwrap();
    let c = connect(&dir.path().join(DB), false).unwrap();
    c.execute_batch("CREATE TABLE override_audit(count INTEGER);INSERT INTO override_audit VALUES(0);CREATE TRIGGER override_changed AFTER UPDATE ON channel_category_override BEGIN UPDATE override_audit SET count=count+1;END;").unwrap();
    drop(c);
    store.write("preferences", &prefs.to_string()).unwrap();
    assert_eq!(
        connect(&dir.path().join(DB), true)
            .unwrap()
            .query_row("SELECT count FROM override_audit", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let before = store.read_snapshot().unwrap();
    prefs["channelCategoryOverrides"][0]["category"] = json!("界".repeat(171));
    assert!(store.write("preferences", &prefs.to_string()).is_err());
    assert_eq!(store.read_snapshot().unwrap(), before);
}
