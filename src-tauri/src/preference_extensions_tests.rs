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

use super::*;
#[test]
fn guide_capacity_1000_roundtrips_and_channel_capacity_100_remains_atomic() {
    for count in [101, 1000] {
        let root = tempfile::tempdir().unwrap();
        let store = PairStore::new(root.path().into()).unwrap();
        let mut pref = preferences();
        let entries: Vec<Value> = (0..count)
            .map(|i| {
                let mut value = guide();
                value["id"] = json!(format!("guide-{i}"));
                value["location"] = json!(format!("https://example.invalid/{i}.xml"));
                value
            })
            .collect();
        pref["reviewedGuideProviders"] = json!(entries);
        store.write_pair(&catalog(), &pref.to_string()).unwrap();
        let before = store.read_pair().unwrap();
        let reopened = PairStore::new(root.path().into())
            .unwrap()
            .read_pair()
            .unwrap();
        assert_eq!(before, reopened);
        let saved: Value = serde_json::from_str(before.preferences.as_ref().unwrap()).unwrap();
        assert_eq!(
            saved["reviewedGuideProviders"].as_array().unwrap().len(),
            count
        );
        let mut bad = pref.clone();
        bad["reviewedChannelProviders"] = json!((0..101)
            .map(|i| {
                let mut value = channel();
                value["id"] = json!(format!("channel-{i}"));
                value["location"] = json!(format!("https://example.invalid/catalog-{i}"));
                value
            })
            .collect::<Vec<_>>());
        assert_eq!(
            store.write_pair(&catalog(), &bad.to_string()).unwrap_err(),
            "record-provider-limit"
        );
        assert_eq!(store.read_pair().unwrap(), before);
        if count == 1000 {
            pref["reviewedGuideProviders"]
                .as_array_mut()
                .unwrap()
                .push(guide());
            assert_eq!(
                store.write_pair(&catalog(), &pref.to_string()).unwrap_err(),
                "record-provider-limit"
            );
            assert_eq!(store.read_pair().unwrap(), before);
        }
    }
}
fn preferences() -> Value {
    json!({"schemaVersion":1,"favorites":[],"removedChannels":[],"volume":0.8,"muted":false,"panelWidth":320,"sources":[]})
}
fn channel() -> Value {
    json!({"id":"channel-provider","name":"Reviewed fixture","location":"HTTPS://Example.invalid:443/playlist?b=2&a=1","provenance":"https://example.invalid/project"})
}
fn guide() -> Value {
    json!({"id":"guide-provider","name":"Guide fixture","location":"https://example.invalid/guide.xml","provenance":"https://example.invalid/project","limitations":"Regional schedule coverage"})
}
fn catalog() -> String {
    json!({"schemaVersion":1,"sources":[],"channels":[]}).to_string()
}
#[test]
fn automatic_guide_control_validates_strict_booleans_and_preserves_legacy_absence() {
    let mut legacy = preferences();
    preference_extensions::normalize(&mut legacy).unwrap();
    assert!(legacy.get("automaticGuideUpdates").is_none());
    for enabled in [true, false] {
        let mut pref = preferences();
        pref["automaticGuideUpdates"] = json!(enabled);
        preference_extensions::normalize(&mut pref).unwrap();
        assert_eq!(pref["automaticGuideUpdates"], enabled);
    }
    for invalid in [json!(null), json!(0), json!("false"), json!([]), json!({})] {
        let mut pref = preferences();
        pref["automaticGuideUpdates"] = invalid;
        assert_eq!(
            preference_extensions::normalize(&mut pref).unwrap_err(),
            "record-invalid-automatic-guide-updates"
        );
    }
}
#[test]
fn automatic_guide_control_off_roundtrips_sqlite_with_region_and_providers() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let mut pref = preferences();
    pref["automaticGuideUpdates"] = json!(false);
    pref["reviewedChannelProviders"] = json!([channel()]);
    pref["reviewedGuideProviders"] = json!([guide()]);
    pref["preferredRegion"] = json!({"country":"US","state":"US-IL","origin":"manual"});
    store.write_pair(&catalog(), &pref.to_string()).unwrap();
    let saved = store.read_pair().unwrap();
    let decoded: Value = serde_json::from_str(saved.preferences.as_ref().unwrap()).unwrap();
    assert_eq!(decoded["automaticGuideUpdates"], false);
    assert_eq!(decoded["preferredRegion"], pref["preferredRegion"]);
    assert_eq!(
        decoded["reviewedGuideProviders"],
        pref["reviewedGuideProviders"]
    );
    assert_eq!(decoded["reviewedChannelProviders"][0]["allowHttp"], false);
    assert_eq!(
        PairStore::new(root.path().into())
            .unwrap()
            .read_pair()
            .unwrap(),
        saved
    );
}
#[test]
fn reviewed_provider_and_region_roundtrip_reopen_cas_and_explicit_removal() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let mut pref = preferences();
    pref["voiceSearchConsent"] = json!(true);
    pref["reviewedChannelProviders"] = json!([channel()]);
    pref["reviewedGuideProviders"] = json!([guide()]);
    pref["preferredRegion"] =
        json!({"country":"US","state":"US-IL","postal":"00501","origin":"manual"});
    store.write_pair(&catalog(), &pref.to_string()).unwrap();
    let first = store.read_snapshot().unwrap();
    let decoded: Value = serde_json::from_str(first.pair.preferences.as_ref().unwrap()).unwrap();
    assert_eq!(
        decoded["reviewedChannelProviders"][0]["location"],
        "https://example.invalid/playlist?b=2&a=1"
    );
    assert_eq!(decoded["reviewedChannelProviders"][0]["allowHttp"], false);
    assert_eq!(decoded["voiceSearchConsent"], true);
    let reopened = PairStore::new(root.path().into()).unwrap();
    assert_eq!(reopened.read_pair().unwrap(), first.pair);
    assert_eq!(
        reopened
            .write_record_guarded(
                "preferences",
                &preferences().to_string(),
                Some("999"),
                || Ok(())
            )
            .unwrap_err(),
        "catalog-revision-stale"
    );
    assert_eq!(reopened.read_pair().unwrap(), first.pair);
    assert_eq!(
        reopened
            .write_record_guarded(
                "preferences",
                &preferences().to_string(),
                Some(&first.catalog_revision),
                || Err("request-canceled".into())
            )
            .unwrap_err(),
        "request-canceled"
    );
    assert_eq!(reopened.read_pair().unwrap(), first.pair);
    pref = decoded;
    pref["reviewedChannelProviders"] = json!([]);
    pref["reviewedGuideProviders"] = json!([]);
    pref.as_object_mut().unwrap().remove("preferredRegion");
    reopened.write("preferences", &pref.to_string()).unwrap();
    let final_snapshot = reopened.read_snapshot().unwrap();
    let final_pref: Value =
        serde_json::from_str(final_snapshot.pair.preferences.as_ref().unwrap()).unwrap();
    assert_eq!(final_pref["reviewedChannelProviders"], json!([]));
    assert_eq!(final_pref["reviewedGuideProviders"], json!([]));
    assert!(final_pref.get("preferredRegion").is_none());
    assert_eq!(first.catalog_revision, final_snapshot.catalog_revision);
    assert_eq!(first.health_revision, final_snapshot.health_revision);
    assert_eq!(first.pair.catalog, final_snapshot.pair.catalog);
}
#[test]
fn v6_migration_preserves_absence_and_verified_backup_then_imports_descriptors() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    store
        .write_pair(&catalog(), &preferences().to_string())
        .unwrap();
    let before = store.read_pair().unwrap();
    let c = connect(&root.path().join(DB), false).unwrap();
    c.execute_batch("DROP TABLE public_archive_variant_v1;DROP TABLE public_archive_item_v1;DROP TABLE public_archive_preference_v1;DROP TABLE public_archive_removal_v1;DROP TABLE public_archive_checkpoint_v1;DROP TABLE archive_bookmark_v1;DROP TABLE archive_bookmark_meta_v1;DROP TABLE archive_file_v1;DROP TABLE archive_item_progress_v1;DROP TABLE archive_progress_v1;DROP TABLE archive_preferences_v1;DROP TABLE archive_removal_v1;DROP TABLE archive_title_v1;DROP TABLE archive_catalog_meta_v1;DROP TABLE catalog_endpoint_projection_v1;DROP TABLE catalog_trigram;DROP TABLE catalog_shortgram;DROP TABLE catalog_projection;DROP TABLE catalog_projection_meta;DROP INDEX catalog_channel_state;DROP INDEX catalog_channel_region;ALTER TABLE preference DROP COLUMN source_refresh_cadence;ALTER TABLE guide_program DROP COLUMN categories_json;ALTER TABLE guide_program DROP COLUMN categories_key;ALTER TABLE preference DROP COLUMN reviewed_channel_providers;ALTER TABLE preference DROP COLUMN reviewed_guide_providers;ALTER TABLE preference DROP COLUMN preferred_region;ALTER TABLE preference DROP COLUMN voice_search_consent;ALTER TABLE metadata DROP COLUMN automatic_guide_updates;PRAGMA user_version=6;").unwrap();
    drop(c);
    let reopened = PairStore::new(root.path().into()).unwrap();
    assert_eq!(reopened.read_pair().unwrap(), before);
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        6
    );
    integrity(&backup).unwrap();
    drop(backup);
    let mut imported = preferences();
    imported["reviewedChannelProviders"] = json!([channel()]);
    imported["reviewedGuideProviders"] = json!([guide()]);
    reopened
        .write_pair(&catalog(), &imported.to_string())
        .unwrap();
    let exported = reopened.read_pair().unwrap();
    let second = tempfile::tempdir().unwrap();
    let restored = PairStore::new(second.path().into()).unwrap();
    restored
        .write_pair(
            exported.catalog.as_ref().unwrap(),
            exported.preferences.as_ref().unwrap(),
        )
        .unwrap();
    assert_eq!(restored.read_pair().unwrap(), exported);
}
#[test]
fn invalid_provider_and_region_edits_refuse_whole_atomic_publication() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    store
        .write_pair(&catalog(), &preferences().to_string())
        .unwrap();
    let before = store.read_pair().unwrap();
    let mut bad = Vec::new();
    for invalid in [json!(null), json!("false"), json!(0), json!([])] {
        let mut p = preferences();
        p["automaticGuideUpdates"] = invalid;
        bad.push(p);
    }
    for invalid in [json!(null), json!("yes"), json!(1)] {
        let mut p = preferences();
        p["voiceSearchConsent"] = invalid;
        bad.push(p);
    }
    for invalid in [json!(null), json!({}), json!(vec![channel(); 101])] {
        let mut p = preferences();
        p["reviewedChannelProviders"] = invalid;
        bad.push(p);
    }
    for location in [
        "http://example.invalid/x",
        "https://user:secret@example.invalid/x",
        "https://example.invalid/x#",
        "https://example.invalid/%ZZ",
        "https://example.invalid/a b",
        "https://example.invalid/\\x",
    ] {
        let mut item = channel();
        item["location"] = json!(location);
        let mut p = preferences();
        p["reviewedChannelProviders"] = json!([item]);
        bad.push(p);
    }
    for key in ["id", "name", "provenance"] {
        let mut item = channel();
        item[key] = json!("\n");
        let mut p = preferences();
        p["reviewedChannelProviders"] = json!([item]);
        bad.push(p);
    }
    let mut encoded = channel();
    encoded["location"] = json!(format!("https://example.invalid/{}", "é".repeat(7000)));
    let mut p = preferences();
    p["reviewedChannelProviders"] = json!([encoded]);
    bad.push(p);
    let mut postal = preferences();
    postal["preferredRegion"] = json!({"country":"US","postal":"\n","origin":"manual"});
    bad.push(postal);
    let mut duplicate = channel();
    duplicate["id"] = json!("different");
    let mut p = preferences();
    p["reviewedChannelProviders"] = json!([channel(), duplicate]);
    bad.push(p);
    let mut g = guide();
    g["allowHttp"] = json!(false);
    let mut p = preferences();
    p["reviewedGuideProviders"] = json!([g]);
    bad.push(p);
    for region in [
        json!({"country":"us","origin":"ip"}),
        json!({"country":"US","state":"CA-ON","origin":"manual"}),
        json!({"country":"US","origin":"ip","postalCode":"60000"}),
        json!(null),
    ] {
        let mut p = preferences();
        p["preferredRegion"] = region;
        bad.push(p);
    }
    for pref in bad {
        assert!(store.write("preferences", &pref.to_string()).is_err());
        assert_eq!(store.read_pair().unwrap(), before);
    }
    let mut granted = channel();
    granted["location"] = json!("http://example.invalid/x");
    granted["allowHttp"] = json!(true);
    let mut p = preferences();
    p["reviewedChannelProviders"] = json!([granted]);
    store.write("preferences", &p.to_string()).unwrap();
}

#[test]
fn schema7_to8_retains_last_good_schedule_legacy_cadence_and_verified_backup() {
    use crate::guide::{database as db, parser};
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let mut pref = preferences();
    pref["automaticSourceRefresh"] = json!(true);
    pref["voiceSearchConsent"] = json!(true);
    pref["preferredRegion"] = json!({"country":"US","postal":"00501","origin":"manual"});
    store.write_pair(&catalog(), &pref.to_string()).unwrap();
    let parsed=parser::parse_guide(b"<tv><channel id='c'><display-name>Fixture</display-name></channel><programme channel='c' start='20261011000000 +0000' stop='20261011010000 +0000'><title>Last good</title><desc>Retained description</desc></programme></tv>").unwrap();
    store
        .with_guide_write(|c| {
            let source = db::GuideSource {
                id: "guide".into(),
                name: "Fixture".into(),
                location: "https://example.invalid/guide".into(),
                kind: "url".into(),
                allow_http: false,
                revision: 0,
                updated_ms: None,
            };
            db::publish_source(
                c,
                &source,
                0,
                &parsed,
                1000,
                &std::sync::atomic::AtomicBool::new(false),
            )
            .map(|_| ())
        })
        .unwrap();
    let before = store.read_snapshot().unwrap();
    let c = connect(&root.path().join(DB), false).unwrap();
    c.execute_batch("DROP TABLE public_archive_variant_v1;DROP TABLE public_archive_item_v1;DROP TABLE public_archive_preference_v1;DROP TABLE public_archive_removal_v1;DROP TABLE public_archive_checkpoint_v1;DROP TABLE archive_bookmark_v1;DROP TABLE archive_bookmark_meta_v1;DROP TABLE archive_file_v1;DROP TABLE archive_item_progress_v1;DROP TABLE archive_progress_v1;DROP TABLE archive_preferences_v1;DROP TABLE archive_removal_v1;DROP TABLE archive_title_v1;DROP TABLE archive_catalog_meta_v1;DROP TABLE catalog_endpoint_projection_v1;DROP TABLE catalog_trigram;DROP TABLE catalog_shortgram;DROP TABLE catalog_projection;DROP TABLE catalog_projection_meta;DROP INDEX catalog_channel_state;DROP INDEX catalog_channel_region;ALTER TABLE preference DROP COLUMN source_refresh_cadence;ALTER TABLE guide_program DROP COLUMN categories_json;ALTER TABLE guide_program DROP COLUMN categories_key;ALTER TABLE metadata DROP COLUMN automatic_guide_updates;PRAGMA user_version=7;").unwrap();
    drop(c);
    let reopened = PairStore::new(root.path().into()).unwrap();
    let after = reopened.read_snapshot().unwrap();
    assert_eq!(after, before);
    reopened
        .with_guide_read(|c| {
            let row: (String, String, String) = sql(c.query_row(
                "SELECT title,categories_json,categories_key FROM guide_program",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            ))?;
            assert_eq!(row, ("Last good".into(), "[]".into(), "[]".into()));
            Ok(())
        })
        .unwrap();
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        7
    );
    assert_eq!(
        backup
            .query_row("SELECT title FROM guide_program", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "Last good"
    );
    integrity(&backup).unwrap();
}
#[test]
fn all_cadence_choices_persist_with_authoritative_boolean_mirror_and_invalid_rollback() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let mut pref = preferences();
    for cadence in [
        "off",
        "hourly",
        "every6hours",
        "daily",
        "weekly",
        "every2weeks",
        "monthly",
    ] {
        pref["sourceRefreshCadence"] = json!(cadence);
        pref["automaticSourceRefresh"] = json!(cadence == "off");
        store.write_pair(&catalog(), &pref.to_string()).unwrap();
        let pair = store.read_pair().unwrap();
        let read: Value = serde_json::from_str(pair.preferences.as_ref().unwrap()).unwrap();
        assert_eq!(read["sourceRefreshCadence"], cadence);
        assert_eq!(read["automaticSourceRefresh"], cadence != "off");
    }
    let before = store.read_snapshot().unwrap();
    for invalid in [json!("yearly"), json!(null), json!(1)] {
        pref["sourceRefreshCadence"] = invalid;
        assert_eq!(
            store.write_pair(&catalog(), &pref.to_string()).unwrap_err(),
            "record-invalid-source-refresh"
        );
        assert_eq!(store.read_snapshot().unwrap(), before);
    }
    pref.as_object_mut().unwrap().remove("sourceRefreshCadence");
    pref["automaticSourceRefresh"] = json!(true);
    store.write_pair(&catalog(), &pref.to_string()).unwrap();
    let read: Value =
        serde_json::from_str(store.read_pair().unwrap().preferences.as_ref().unwrap()).unwrap();
    assert_eq!(read["sourceRefreshCadence"], "daily");
}
