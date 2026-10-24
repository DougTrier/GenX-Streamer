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

//! Archive catalog tests: removing titles and files, and schema migrations.

use super::*;

#[test]
fn archive_user_title_removal_is_scoped_durable_and_refresh_cannot_restore_it() {
    let mut c = database();
    let mut chosen = title("chosen", Some(1964), 1);
    chosen.partial = Some(page(64, None));
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![chosen, title("other", Some(1965), 2)]),
        &mut || Ok(()),
    )
    .unwrap();
    let title_ref = opaque(&["archive-item-v1", "chosen"]);
    set_favorite(
        &mut c,
        &FavoriteRequest {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: title_ref.clone(),
            expected_revision: "1".into(),
            value: true,
        },
        &mut || Ok(()),
    )
    .unwrap();
    let selected = opaque(&["archive-file-v1", "chosen", "one.mp4"]);
    let captured = resolve(&c, &selected, "2").unwrap();
    let receipt = remove(
        &mut c,
        &RemovalScope::TitleRef(title_ref.clone()),
        None,
        "2",
        &mut || Ok(()),
    )
    .unwrap();
    assert!(receipt.committed);
    assert_eq!(receipt.revision, "3");
    assert_eq!(
        (
            receipt.removed_titles,
            receipt.removed_files,
            receipt.removed_favorites,
            receipt.cleared_progress
        ),
        (1, 2, 1, 1)
    );
    assert!(verify_live(&c, &selected, &captured).is_err());
    assert!(removed(&c, "title", &title_ref).unwrap());
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM archive_title_v1 WHERE item_id='other'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM unrelated_station", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let noop = remove(
        &mut c,
        &RemovalScope::TitleRef(title_ref),
        None,
        "3",
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(noop.revision, "3");
    assert_eq!(noop.removed_files, 0);
    let receipt = commit(
        &mut c,
        "3",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        step(vec![title("chosen", Some(1964), 99)]),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(receipt.admitted, 0);
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM archive_title_v1 WHERE item_id='chosen'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn archive_user_file_removal_preserves_siblings_preferences_and_scope() {
    let mut c = database();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![title("chosen", Some(1964), 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    let title_ref = opaque(&["archive-item-v1", "chosen"]);
    let file = opaque(&["archive-file-v1", "chosen", "one.mp4"]);
    set_favorite(
        &mut c,
        &FavoriteRequest {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: title_ref.clone(),
            expected_revision: "1".into(),
            value: true,
        },
        &mut || Ok(()),
    )
    .unwrap();
    assert!(
        matches!(remove(&mut c,&RemovalScope::FileRef(file.clone()),Some(&"b".repeat(64)),"2",&mut ||Ok(())),Err(e) if e=="archive-removal-scope-invalid")
    );
    assert_eq!(current(&c).unwrap(), 2);
    let receipt = remove(
        &mut c,
        &RemovalScope::FileRef(file.clone()),
        Some(&title_ref),
        "2",
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(
        (
            receipt.removed_files,
            receipt.removed_titles,
            receipt.removed_favorites
        ),
        (1, 0, 0)
    );
    assert!(c
        .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
            .get::<_, bool>(0))
        .unwrap());
    commit(
        &mut c,
        "3",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        step(vec![title("chosen", Some(1964), 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    assert!(resolve(&c, &file, "4").is_err());
    assert!(resolve(&c, &opaque(&["archive-file-v1", "chosen", "two.mp4"]), "4").is_ok());
    let noop = remove(
        &mut c,
        &RemovalScope::FileRef(file),
        Some(&title_ref),
        "4",
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(noop.revision, "4");
    assert_eq!(noop.removed_files, 0);
}

#[test]
fn archive_discovery_does_not_report_admission_when_all_files_were_user_removed() {
    let mut c = database();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![title("chosen", Some(1964), 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    let title_ref = opaque(&["archive-item-v1", "chosen"]);
    remove(
        &mut c,
        &RemovalScope::FileRef(opaque(&["archive-file-v1", "chosen", "one.mp4"])),
        Some(&title_ref),
        "1",
        &mut || Ok(()),
    )
    .unwrap();
    remove(
        &mut c,
        &RemovalScope::FileRef(opaque(&["archive-file-v1", "chosen", "two.mp4"])),
        Some(&title_ref),
        "2",
        &mut || Ok(()),
    )
    .unwrap();
    let receipt = commit(
        &mut c,
        "3",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        step(vec![title("chosen", Some(1964), 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(receipt.admitted, 0);
    assert_eq!(receipt.title_count, 0);
    let mut partial = title("chosen", Some(1964), 1);
    partial.partial = Some(page(64, None));
    partial.files[0].provider_index = Some(0);
    partial.files[1].provider_index = Some(1);
    let receipt = commit(
        &mut c,
        "4",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        step(vec![partial]),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(receipt.pending_file_pages[0].available_file_count, 0);
    assert_eq!(
        receipt.admitted, 0,
        "pending metadata with only removed files is not playable admission"
    );
}

#[test]
fn archive_user_removal_cancel_and_stale_revision_leave_all_choices_unchanged() {
    let mut c = database();
    let mut chosen = title("chosen", Some(1964), 1);
    chosen.partial = Some(page(64, None));
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![chosen]),
        &mut || Ok(()),
    )
    .unwrap();
    let reference = opaque(&["archive-item-v1", "chosen"]);
    let scope = RemovalScope::TitleRef(reference);
    assert!(
        matches!(remove(&mut c,&scope,None,"0",&mut ||Ok(())),Err(e) if e=="archive-revision-stale")
    );
    let mut checks = 0;
    assert!(remove(&mut c, &scope, None, "1", &mut || {
        checks += 1;
        if checks == 2 {
            Err("canceled".into())
        } else {
            Ok(())
        }
    })
    .is_err());
    assert_eq!(current(&c).unwrap(), 1);
    assert_eq!(file_progress(&c, "chosen").unwrap().available_file_count, 2);
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_removal_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let mut checks = 0;
    assert!(remove(&mut c, &RemovalScope::All, None, "1", &mut || {
        checks += 1;
        if checks == 4 {
            Err("canceled".into())
        } else {
            Ok(())
        }
    })
    .is_err());
    assert_eq!(current(&c).unwrap(), 1);
    assert_eq!(file_progress(&c, "chosen").unwrap().next_offset, 64);
    let receipt = remove(&mut c, &RemovalScope::All, None, "1", &mut || Ok(())).unwrap();
    assert_eq!(receipt.revision, "2");
    assert_eq!(
        (
            receipt.removed_titles,
            receipt.removed_files,
            receipt.cleared_progress
        ),
        (1, 2, 2)
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM unrelated_station", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        remove(&mut c, &RemovalScope::All, None, "2", &mut || Ok(()))
            .unwrap()
            .revision,
        "3"
    );
    assert!(
        matches!(commit(&mut c, "2", SearchPage { year: None, page: 1, query_hash: "query", restart: true }, step(vec![title("stale",Some(1964),1)]), &mut ||Ok(())),Err(e) if e=="archive-revision-stale")
    );
}

#[test]
fn archive_schema14_backed_migration_preserves_actual_schema13_library_and_live_data() {
    let root = tempfile::tempdir().unwrap();
    let store = crate::storage_transaction::PairStore::new(root.path().to_path_buf()).unwrap();
    let sources = serde_json::json!([{"id":"source","name":"Fixture","location":"fixture.m3u","kind":"file"}]);
    let catalog=serde_json::json!({"schemaVersion":1,"sources":sources,"channels":[{"id":"live","sourceId":"source","name":"Live fixture","category":"News","urls":["https://example.invalid/live"]}]}).to_string();
    let preferences=serde_json::json!({"schemaVersion":1,"sources":sources,"favorites":["live"],"removedChannels":["missing-live"],"volume":0.5,"muted":false,"panelWidth":300.0}).to_string();
    store.write_pair(&catalog, &preferences).unwrap();
    let live = store.read_snapshot().unwrap();
    // A version-13 database: guide data present, later archive tables not yet created.
    let version_13 = "INSERT INTO guide_source(id,name,location,kind,allow_http,revision,updated_ms,published_revision) VALUES('guide','Fixture','https://example.invalid/guide','url',0,1,1000,1);INSERT INTO guide_channel VALUES('guide','xmlid','[\"Fixture\"]','fixture');INSERT INTO guide_program(guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,search_text) VALUES('guide',0,'xmlid',1000,2000,'Fixture program','fixture program');DROP TABLE public_archive_variant_v1;DROP TABLE public_archive_item_v1;DROP TABLE public_archive_preference_v1;DROP TABLE public_archive_removal_v1;DROP TABLE public_archive_checkpoint_v1;DROP TABLE archive_bookmark_v1;DROP TABLE archive_bookmark_meta_v1;DROP TABLE archive_removal_v1;PRAGMA user_version=13;";
    store
        .with_guide_write(|c| {
            let mut chosen = title("chosen", Some(1964), 1);
            chosen.partial = Some(page(64, None));
            commit(
                c,
                "0",
                SearchPage {
                    year: None,
                    page: 1,
                    query_hash: "query",
                    restart: false,
                },
                step(vec![chosen]),
                &mut || Ok(()),
            )?;
            let favorite = FavoriteRequest {
                schema_version: 1,
                request_id: "fixture".into(),
                title_ref: opaque(&["archive-item-v1", "chosen"]),
                expected_revision: "1".into(),
                value: true,
            };
            set_favorite(c, &favorite, &mut || Ok(()))?;
            c.execute_batch(version_13)
                .map_err(|_| "fixture-failed".to_owned())?;
            Ok(())
        })
        .unwrap();
    drop(store);
    let reopened = crate::storage_transaction::PairStore::new(root.path().to_path_buf()).unwrap();
    let after = reopened.read_snapshot().unwrap();
    assert_eq!(after.pair.catalog, live.pair.catalog);
    assert_eq!(after.pair.preferences, live.pair.preferences);
    assert_eq!(after.catalog_revision, live.catalog_revision);
    reopened
        .with_guide_read(|c| {
            assert_eq!(
                c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                16
            );
            assert_eq!(current(c).unwrap(), 2);
            assert_eq!(file_progress(c, "chosen").unwrap().next_offset, 64);
            assert!(c
                .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
                    .get::<_, bool>(0))
                .unwrap());
            assert_eq!(
                c.query_row("SELECT count(*) FROM guide_program", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            Ok(())
        })
        .unwrap();
    let backup = Connection::open(root.path().join("genx.sqlite3.backup")).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        13
    );
    assert_eq!(current(&backup).unwrap(), 2);
    assert_eq!(
        backup
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name='archive_removal_v1'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    drop(backup);
    reopened
        .with_guide_write(|c| remove(c, &RemovalScope::All, None, "2", &mut || Ok(())))
        .unwrap();
    let cleared = reopened.read_snapshot().unwrap();
    assert_eq!(cleared.pair.catalog, live.pair.catalog);
    assert_eq!(cleared.pair.preferences, live.pair.preferences);
    reopened
        .with_guide_read(|c| {
            assert_eq!(
                c.query_row("SELECT count(*) FROM guide_program", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(current(c).unwrap(), 3);
            Ok(())
        })
        .unwrap();
}

#[test]
fn archive_schema13_and14_missing_namespace_fail_without_fallback() {
    for version in [13, 14] {
        let root = tempfile::tempdir().unwrap();
        let store = crate::storage_transaction::PairStore::new(root.path().to_path_buf()).unwrap();
        drop(store);
        let c = Connection::open(root.path().join(crate::storage_transaction::DB)).unwrap();
        if version == 13 {
            c.execute_batch("DROP TABLE archive_removal_v1;DROP TABLE archive_item_progress_v1;PRAGMA user_version=13;")
                    .unwrap();
        } else {
            c.execute_batch("DROP TABLE archive_removal_v1;").unwrap();
        }
        drop(c);
        assert!(
            matches!(crate::storage_transaction::PairStore::new(root.path().to_path_buf()),Err(e) if e=="sqlite-incomplete-archive-schema")
        );
    }
}
