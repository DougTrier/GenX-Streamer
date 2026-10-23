//! Real storage/projection regression: source-list labels are not media policy.
use super::*;
use std::sync::{atomic::AtomicBool, Arc};

fn query(text: &str) -> crate::catalog_query::Query {
    serde_json::from_value(json!({"schemaVersion":1,"requestId":"endpoint-fixture","expectedCatalogRevision":null,"expectedViewRevision":null,"query":text,"filter":"all","geography":{},"sort":"source","favoritesFirst":false,"after":null,"startIndex":null,"anchorId":null,"pageSize":50})).unwrap()
}
fn page(store: &PairStore, text: &str) -> crate::catalog_query::Page {
    store
        .query_catalog_page(&query(text), &Arc::new(AtomicBool::new(false)))
        .unwrap()
}
fn fixture() -> (tempfile::TempDir, PairStore) {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let catalog = json!({"schemaVersion":1,"sources":[
        {"id":"legacy","name":"Legacy list","kind":"url","location":"https://example.invalid/old.m3u"},
        {"id":"inspected","name":"Inspected list","kind":"url","location":"https://example.invalid/new.m3u","contentKind":"catalog","mediaMime":"audio/x-mpegurl"}
    ],"channels":[
        {"id":"a","sourceId":"legacy","providerId":"Golazo.us@SD","name":"Golazo Network (720p)","category":"Sports","urls":["https://example.invalid/live"]},
        {"id":"b","sourceId":"inspected","providerId":"Golazo.us@SD","name":"Golazo alternate label","category":"Sports","urls":["https://example.invalid/live"]}
    ]});
    let preferences = json!({"schemaVersion":1,"sources":catalog["sources"],"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":300});
    store
        .write_pair(&catalog.to_string(), &preferences.to_string())
        .unwrap();
    (root, store)
}
fn visible_groups(c: &Connection) -> i64 {
    c.query_row(
        &format!(
            "{} SELECT count(*) FROM endpoint_members WHERE position=1",
            crate::catalog_endpoint_projection::MEMBERS_CTE
        ),
        [],
        |r| r.get(0),
    )
    .unwrap()
}
fn legacy_projection(c: &mut Connection) {
    // Reconstruct the actual v1 key policy, including the non-playback labels.
    fn field(h: &mut Sha256, v: Option<&str>) {
        h.update([u8::from(v.is_some())]);
        if let Some(v) = v {
            h.update((v.len() as u64).to_be_bytes());
            h.update(v.as_bytes());
        }
    }
    let tx = c.transaction().unwrap();
    let mut read = tx.prepare("SELECT c.id,s.allow_http,s.content_kind,s.media_mime,u.url FROM channel c JOIN source s ON s.id=c.source_id JOIN channel_url u ON u.channel_id=c.id ORDER BY c.id,u.ordinal").unwrap();
    let rows: Vec<(String, i64, Option<String>, Option<String>, String)> = read
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    drop(read);
    for (id, http, kind, mime, url) in rows {
        let mut h = Sha256::new();
        field(&mut h, Some("exact-ordered-endpoints-policy-v1"));
        h.update([http as u8]);
        field(&mut h, kind.as_deref());
        field(&mut h, mime.as_deref());
        field(&mut h, Some(&url));
        tx.execute(
            "UPDATE catalog_endpoint_projection_v1 SET endpoint_key=?1 WHERE channel_id=?2",
            params![h.finalize().to_vec(), id],
        )
        .unwrap();
    }
    tx.execute(
        "UPDATE catalog_projection_meta SET query_version='legacy-v1-policy'",
        [],
    )
    .unwrap();
    tx.commit().unwrap();
}

#[test]
fn legacy_catalog_labels_upgrade_once_with_verified_backup_and_preserve_all_canonical_records() {
    let (root, store) = fixture();
    let before = store.read_pair().unwrap();
    let mut c = connect(&root.path().join(DB), false).unwrap();
    c.execute_batch("INSERT INTO guide_mapping VALUES('legacy','a','guide','golazo'),('inspected','b','guide','golazo');").unwrap();
    let initial = page(&store, "Golazo");
    legacy_projection(&mut c);
    assert_eq!(visible_groups(&c), 2);
    let mut phases = Vec::new();
    store.recover_observed(|p| phases.push(p)).unwrap();
    assert!(phases.contains(&RecoveryPhase::Migration));
    assert!(phases.contains(&RecoveryPhase::FinalIntegrity));
    assert!(!phases.contains(&RecoveryPhase::ProofReused));
    assert_eq!(store.read_pair().unwrap(), before);
    assert_eq!(
        c.query_row("SELECT count(*) FROM channel", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM guide_mapping", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(visible_groups(&c), 1);
    let current = page(&store, "alternate");
    assert_eq!(current.total_count, 1);
    assert_eq!(current.rows[0].id, "a");
    assert_eq!(page(&store, "720p").total_count, 1);
    assert_eq!(initial.catalog_revision, current.catalog_revision);
    assert!(
        current.view_revision.parse::<u64>().unwrap()
            > initial.view_revision.parse::<u64>().unwrap()
    );
    let mut stale = query("Golazo");
    stale.expected_view_revision = Some(initial.view_revision);
    assert_eq!(
        store
            .query_catalog_page(&stale, &Arc::new(AtomicBool::new(false)))
            .unwrap_err(),
        "catalog-view-revision-stale"
    );
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    integrity(&backup).unwrap();
    assert_eq!(PairStore::read_connection(&backup).unwrap(), before);
    assert_eq!(visible_groups(&backup), 2);
    assert!(!crate::catalog_query::projection_is_current(&backup).unwrap());
    drop(backup);
    drop(c);
    let bytes = std::fs::read(root.path().join(DB)).unwrap();
    let mut phases = Vec::new();
    store.recover_observed(|p| phases.push(p)).unwrap();
    assert!(phases.contains(&RecoveryPhase::ProofReused));
    assert!(!phases.contains(&RecoveryPhase::Migration));
    assert_eq!(std::fs::read(root.path().join(DB)).unwrap(), bytes);
}

#[test]
fn direct_media_grants_and_ordered_fallbacks_remain_distinct_without_name_merging() {
    let (root, store) = fixture();
    let mut catalog: Value =
        serde_json::from_str(&store.read("catalog").unwrap().unwrap()).unwrap();
    for (id, kind, mime, http, urls) in [
        (
            "hls",
            Some("hls"),
            Some("application/vnd.apple.mpegurl"),
            false,
            vec!["https://example.invalid/live"],
        ),
        (
            "media",
            Some("media"),
            Some("video/mp4"),
            false,
            vec!["https://example.invalid/live"],
        ),
        (
            "unknown",
            None,
            Some("video/mp4"),
            false,
            vec!["https://example.invalid/live"],
        ),
        (
            "grant",
            None,
            None,
            true,
            vec!["https://example.invalid/live"],
        ),
        (
            "ordered",
            None,
            None,
            false,
            vec![
                "https://example.invalid/live",
                "https://example.invalid/fallback",
            ],
        ),
        (
            "reverse",
            None,
            None,
            false,
            vec![
                "https://example.invalid/fallback",
                "https://example.invalid/live",
            ],
        ),
        (
            "edition",
            None,
            None,
            false,
            vec!["https://example.invalid/different-edition"],
        ),
    ] {
        let mut source = json!({"id":id,"name":"Fixture","kind":"url","location":"https://example.invalid/list","allowHttp":http});
        if let Some(kind) = kind {
            source["contentKind"] = json!(kind);
        }
        if let Some(mime) = mime {
            source["mediaMime"] = json!(mime);
        }
        catalog["sources"].as_array_mut().unwrap().push(source);
        catalog["channels"].as_array_mut().unwrap().push(json!({"id":id,"sourceId":id,"providerId":"Golazo.us@SD","name":"Golazo Network (720p)","category":"Sports","urls":urls}));
    }
    let mut preferences: Value =
        serde_json::from_str(&store.read("preferences").unwrap().unwrap()).unwrap();
    preferences["sources"] = catalog["sources"].clone();
    store
        .write_pair(&catalog.to_string(), &preferences.to_string())
        .unwrap();
    let c = connect(&root.path().join(DB), true).unwrap();
    assert_eq!(visible_groups(&c), 8); // Only legacy/catalog aliases collapse.
    assert_eq!(page(&store, "Golazo").total_count, 8);
}

#[test]
fn favorite_category_removal_and_guide_mapping_partitions_remain_live() {
    let (root, _store) = fixture();
    let c = connect(&root.path().join(DB), false).unwrap();
    assert_eq!(visible_groups(&c), 1);
    c.execute_batch("INSERT INTO favorite VALUES('a',0)")
        .unwrap();
    assert_eq!(visible_groups(&c), 2);
    c.execute_batch("INSERT INTO removed VALUES('b',0)")
        .unwrap();
    assert_eq!(visible_groups(&c), 1);
    c.execute_batch("DELETE FROM favorite;DELETE FROM removed;INSERT INTO channel_category_override VALUES('a','News',0)").unwrap();
    assert_eq!(visible_groups(&c), 2);
    c.execute_batch("INSERT INTO channel_category_override VALUES('b','News',1)")
        .unwrap();
    assert_eq!(visible_groups(&c), 1);
    c.execute_batch("DELETE FROM channel_category_override;INSERT INTO guide_mapping VALUES('legacy','a','guide','one')").unwrap();
    assert_eq!(visible_groups(&c), 2);
    c.execute_batch("INSERT INTO guide_mapping VALUES('inspected','b','guide','one')")
        .unwrap();
    assert_eq!(visible_groups(&c), 1);
    c.execute_batch("UPDATE guide_mapping SET xmltv_channel_id='two' WHERE app_channel_id='b'")
        .unwrap();
    assert_eq!(visible_groups(&c), 2);
}

#[test]
fn explicit_group_actions_preserve_alias_preferences_and_reject_stale_edits() {
    let (root, store) = fixture();
    let first = page(&store, "Golazo");
    let request = crate::catalog_group_mutation::Request {
        schema_version: 1,
        request_id: "favorite-group".into(),
        channel_id: "a".into(),
        expected_catalog_revision: first.catalog_revision,
        expected_view_revision: first.view_revision,
        action: crate::catalog_group_mutation::Action::Favorite { value: true },
        more_channel_ids: vec![],
    };
    store.mutate_catalog_group(&request, || Ok(())).unwrap();
    let c = connect(&root.path().join(DB), true).unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM favorite", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        store.mutate_catalog_group(&request, || Ok(())).unwrap_err(),
        "catalog-group-revision-stale"
    );
    let next = page(&store, "Golazo");
    let request = crate::catalog_group_mutation::Request {
        schema_version: 1,
        request_id: "remove-group".into(),
        channel_id: "a".into(),
        expected_catalog_revision: next.catalog_revision,
        expected_view_revision: next.view_revision,
        action: crate::catalog_group_mutation::Action::Remove,
        more_channel_ids: vec![],
    };
    store.mutate_catalog_group(&request, || Ok(())).unwrap();
    assert_eq!(page(&store, "Golazo").total_count, 0);
    assert_eq!(
        c.query_row("SELECT count(*) FROM removed", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM channel", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn upgrade_refuses_authority_changes_after_backup_admission_without_mutation() {
    for change in [
        "UPDATE metadata SET revision=revision+1",
        "UPDATE metadata SET catalog_revision=catalog_revision+1",
        "UPDATE catalog_projection_meta SET view_revision=view_revision+1",
        "UPDATE catalog_projection_meta SET query_version='other-writer'",
        "PRAGMA user_version=99",
    ] {
        let (root, _store) = fixture();
        let path = root.path().join(DB);
        let mut c = connect(&path, false).unwrap();
        legacy_projection(&mut c);
        let expected = crate::catalog_query::projection_upgrade_fence(&c)
            .unwrap()
            .unwrap();
        c.execute_batch(change).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(
            crate::catalog_query::upgrade_projection_policy(&mut c, Some(expected)).unwrap_err(),
            "catalog-query-projection-stale"
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn verified_legacy_backup_restoration_also_upgrades_derived_keys() {
    let (root, store) = fixture();
    let before = store.read_pair().unwrap();
    let path = root.path().join(DB);
    let mut c = connect(&path, false).unwrap();
    legacy_projection(&mut c);
    store.backup(&c).unwrap();
    drop(c);
    let backup_before = std::fs::read(root.path().join(BACKUP)).unwrap();
    std::fs::write(&path, b"controlled broken SQLite header").unwrap();
    let restored = PairStore::new(root.path().into()).unwrap();
    assert_eq!(restored.read_pair().unwrap(), before);
    assert_eq!(page(&restored, "Golazo").total_count, 1);
    assert_eq!(
        std::fs::read(root.path().join(BACKUP)).unwrap(),
        backup_before
    );
}

/// Batch removal (owner design, October 21, 2026): confirmed-dead channels
/// leave in one transaction, each with its group; a channel already gone is
/// skipped, and only removal may batch.
#[test]
fn batch_removal_takes_every_group_in_one_write() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let catalog = json!({"schemaVersion":1,"sources":[
        {"id":"s","name":"List","kind":"url","location":"https://example.invalid/list.m3u"}
    ],"channels":[
        {"id":"one","sourceId":"s","name":"One","category":"News","urls":["https://example.invalid/one"]},
        {"id":"one-copy","sourceId":"s","name":"One copy","category":"News","urls":["https://example.invalid/one"]},
        {"id":"two","sourceId":"s","name":"Two","category":"News","urls":["https://example.invalid/two"]},
        {"id":"kept","sourceId":"s","name":"Kept","category":"News","urls":["https://example.invalid/kept"]}
    ]});
    let preferences = json!({"schemaVersion":1,"sources":catalog["sources"],"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":300});
    store
        .write_pair(&catalog.to_string(), &preferences.to_string())
        .unwrap();
    let first = page(&store, "");
    assert_eq!(first.total_count, 3);
    let mut request = crate::catalog_group_mutation::Request {
        schema_version: 1,
        request_id: "batch".into(),
        channel_id: "one".into(),
        expected_catalog_revision: first.catalog_revision,
        expected_view_revision: first.view_revision,
        action: crate::catalog_group_mutation::Action::Favorite { value: true },
        more_channel_ids: vec!["two".into()],
    };
    assert_eq!(
        store.mutate_catalog_group(&request, || Ok(())).unwrap_err(),
        "catalog-group-invalid"
    );
    request.action = crate::catalog_group_mutation::Action::Remove;
    request.more_channel_ids = vec!["two".into(), "gone".into(), "one".into()];
    let receipt = store.mutate_catalog_group(&request, || Ok(())).unwrap();
    assert_eq!(receipt.affected_count, 3);
    let after = page(&store, "");
    assert_eq!(after.total_count, 1);
    let c = connect(&root.path().join(DB), true).unwrap();
    let removed: Vec<String> = c
        .prepare("SELECT id FROM removed ORDER BY ordinal")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(removed, vec!["one", "one-copy", "two"]);
    request.more_channel_ids = (0..=crate::catalog_group_mutation::BATCH_LIMIT)
        .map(|i| format!("x{i}"))
        .collect();
    assert_eq!(
        store.mutate_catalog_group(&request, || Ok(())).unwrap_err(),
        "catalog-group-invalid"
    );
}
