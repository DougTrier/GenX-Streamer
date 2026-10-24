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
include!("archive_date_assessment_tests.rs");
fn database() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;CREATE TABLE unrelated_station(id TEXT PRIMARY KEY);INSERT INTO unrelated_station VALUES('station-retained');").unwrap();
    let tx = c.transaction().unwrap();
    install(&tx).unwrap();
    crate::archive_bookmarks::install(&tx).unwrap();
    tx.commit().unwrap();
    c
}
#[test]
fn archive_library_clear_resets_bookmarks_in_same_cas_transaction_and_cancel_rolls_all_back() {
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
    let reference = opaque(&["archive-file-v1", "chosen", "one.mp4"]);
    c.execute(
        "UPDATE archive_file_v1 SET sha1=?1",
        ["0123456789abcdef0123456789abcdef01234567"],
    )
    .unwrap();
    let file = resolve(&c, &reference, "1").unwrap();
    let proof = crate::archive_bookmarks::capture(&reference, &file).unwrap();
    let position = crate::archive_bookmarks::Position {
        position_ms: 12345,
        duration_ms: Some(60000),
        completed: false,
        observed_ms: 1000,
    };
    crate::archive_bookmarks::save(&mut c, &proof, "0", &position, || Ok(())).unwrap();
    let checks = std::cell::Cell::new(0);
    assert!(remove(&mut c, &RemovalScope::All, None, "1", &mut || {
        checks.set(checks.get() + 1);
        if checks.get() == 3 {
            Err("canceled".into())
        } else {
            Ok(())
        }
    })
    .is_err());
    assert_eq!(current(&c).unwrap(), 1);
    assert!(crate::archive_bookmarks::read(&c, &proof)
        .unwrap()
        .position
        .is_some());
    let receipt = remove(&mut c, &RemovalScope::All, None, "1", &mut || Ok(())).unwrap();
    assert!(receipt.committed);
    assert_eq!(receipt.revision, "2");
    assert!(!serde_json::to_string(&receipt)
        .unwrap()
        .contains("bookmark"));
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_bookmark_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT revision FROM archive_bookmark_meta_v1", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        2
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM unrelated_station", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    // Empty Clear also revokes an earlier captured bookmark revision.
    remove(&mut c, &RemovalScope::All, None, "2", &mut || Ok(())).unwrap();
    assert_eq!(
        c.query_row("SELECT revision FROM archive_bookmark_meta_v1", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        3
    );
}
fn title(id: &str, year: Option<i64>, downloads: i64) -> PreparedTitle {
    PreparedTitle {
        partial: None,
        item_id: id.into(),
        title: "Identical provider title".into(),
        search_aliases: "identical provider title".into(),
        kind: "tv",
        year,
        rights: None,
        downloads,
        servers: vec!["ia800000.us.archive.org".into()],
        all_file_names: vec!["one.mp4".into(), "two.mp4".into()],
        files: vec![
            PreparedFile {
                provider_index: None,
                original: Some("one.mpg".into()),
                file_title: None,
                name: "one.mp4".into(),
                size: "100".into(),
                duration: Some(60.0),
                sha1: None,
            },
            PreparedFile {
                provider_index: None,
                original: Some("two.mpg".into()),
                file_title: None,
                name: "two.mp4".into(),
                size: "200".into(),
                duration: None,
                sha1: None,
            },
        ],
    }
}
fn step(titles: Vec<PreparedTitle>) -> PreparedStep {
    PreparedStep {
        item_page: false,
        titles,
        deleted: Vec::new(),
        examined: 12,
        unknown_year: 0,
        transient_failures: 0,
        unavailable: 0,
        capacity_reached: false,
        next_page: None,
        observed_ms: 1_000_000,
    }
}
fn page(next: u32, expected: Option<u32>) -> PreparedPage {
    PreparedPage {
        provider_count: 2000,
        next_offset: next,
        fingerprint: "a".repeat(64),
        scanned_bytes: 1000,
        curation_year: None,
        expected_offset: expected,
        expected_fingerprint: expected.map(|_| "a".repeat(64)),
        capacity: false,
    }
}
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
#[test]
fn archive_untitled_file_labels_are_actual_distinct_utf8_bounded_names() {
    let mut c = database();
    let mut record = title("labels", Some(1964), 1);
    let first = format!("{}/First recording.mp4", "界".repeat(230));
    let second = format!("{}/Second recording.mp4", "界".repeat(230));
    record.files[0].name = first.clone();
    record.files[1].name = second.clone();
    record.all_file_names = vec![first.clone(), second.clone()];
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![record]),
        &mut || Ok(()),
    )
    .unwrap();
    let request = FilesQuery {
        schema_version: 1,
        request_id: "fixture".into(),
        title_ref: opaque(&["archive-item-v1", "labels"]),
        expected_revision: "1".into(),
        offset: 0,
        page_size: 50,
    };
    let reply = files(&c, &request, &mut || Ok(())).unwrap();
    assert_eq!(reply.files.len(), 2);
    assert_ne!(reply.files[0].title, reply.files[1].title);
    for file in &reply.files {
        assert!(file.title.len() <= 512);
        assert!(file.title.contains('…'));
        assert!(file.title.ends_with("recording.mp4"));
        assert!(std::str::from_utf8(file.title.as_bytes()).is_ok());
    }
    assert_eq!(reply.files[0].file_name, first);
    assert_eq!(reply.files[1].file_name, second);
    c.execute(
        "UPDATE archive_file_v1 SET file_title='Provider supplied title' WHERE file_name=?1",
        [&first],
    )
    .unwrap();
    assert_eq!(
        files(&c, &request, &mut || Ok(())).unwrap().files[0].title,
        "Provider supplied title"
    );
    assert_eq!(file_name_label("one.mp4"), "one.mp4");
}
#[test]
fn archive_partial_pages_append_preserve_and_fence_without_absence_deletion() {
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
        step(vec![title("large", Some(1964), 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    let mut first = title("large", Some(1964), 1);
    first.partial = Some(page(64, None));
    first.files.truncate(1);
    first.files[0].name = "page-one.mp4".into();
    first.files[0].provider_index = Some(0);
    first.all_file_names = vec!["page-one.mp4".into()];
    let receipt = commit(
        &mut c,
        "1",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        step(vec![first]),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(receipt.confirmed_dead, 0);
    assert_eq!(receipt.pending_file_pages[0].next_offset, 64);
    assert_eq!(receipt.pending_file_pages[0].available_file_count, 3);
    let request = FileStepRequest {
        schema_version: 1,
        request_id: "fixture".into(),
        title_ref: opaque(&["archive-item-v1", "large"]),
        expected_revision: "2".into(),
        expected_offset: 64,
        explicit_action: true,
        restart: false,
    };
    assert_eq!(item_prepare(&c, &request).unwrap().page.next_offset, 64);
    let mut second = title("large", Some(1964), 1);
    second.partial = Some(page(128, Some(64)));
    second.files.truncate(1);
    second.files[0].name = "page-two.mp4".into();
    second.files[0].provider_index = Some(64);
    second.all_file_names = vec!["page-two.mp4".into()];
    let mut prepared = step(vec![second]);
    prepared.item_page = true;
    let receipt = commit(
        &mut c,
        "2",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "unused",
            restart: false,
        },
        prepared,
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(receipt.file_page_progress.unwrap().next_offset, 128);
    assert_eq!(receipt.files_admitted, 1);
    assert_eq!(receipt.confirmed_dead, 0);
    assert_eq!(file_progress(&c, "large").unwrap().available_file_count, 4);
    let mut stale = title("large", Some(1964), 1);
    stale.partial = Some(page(192, Some(64)));
    let mut prepared = step(vec![stale]);
    prepared.item_page = true;
    assert!(
        matches!(commit(&mut c, "3", SearchPage { year: None, page: 1, query_hash: "unused", restart: false }, prepared, &mut ||Ok(())),Err(e) if e=="archive-item-progress-stale")
    );
    assert_eq!(current(&c).unwrap(), 3);
    assert_eq!(file_progress(&c, "large").unwrap().next_offset, 128);
    let mut final_page = title("large", Some(1964), 1);
    final_page.partial = Some(page(2000, Some(128)));
    final_page.files.clear();
    final_page.all_file_names.clear();
    let mut prepared = step(vec![final_page]);
    prepared.item_page = true;
    let receipt = commit(
        &mut c,
        "3",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "unused",
            restart: false,
        },
        prepared,
        &mut || Ok(()),
    )
    .unwrap();
    assert!(receipt.file_page_progress.unwrap().complete);
    assert_eq!(receipt.confirmed_dead, 0);
    assert_eq!(file_progress(&c, "large").unwrap().available_file_count, 4);
    let query = FileProgressQuery {
        schema_version: 1,
        request_id: "fixture".into(),
        expected_revision: Some("4".into()),
        offset: 0,
        page_size: 50,
        query: String::new(),
        decade: None,
        favorites_only: false,
        language_mode: LanguageMode::All,
        content_type: ContentType::All,
    };
    assert_eq!(
        item_progress(&c, &query, &mut || Ok(()))
            .unwrap()
            .total_count,
        0
    );
}
#[test]
fn archive_pending_zero_files_are_not_playable_and_cancel_rolls_back_progress() {
    let mut c = database();
    let mut pending = title("pending", Some(1964), 1);
    pending.partial = Some(page(64, None));
    pending.files.clear();
    pending.all_file_names.clear();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![pending]),
        &mut || Ok(()),
    )
    .unwrap();
    let q = Query {
        schema_version: 1,
        request_id: "fixture".into(),
        query: String::new(),
        expected_revision: Some("1".into()),
        offset: 0,
        page_size: 50,
        curated_only: false,
        decade: None,
        favorites_only: false,
        language_mode: LanguageMode::All,
        content_type: ContentType::All,
    };
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
    let p = FileProgressQuery {
        schema_version: 1,
        request_id: "fixture".into(),
        expected_revision: Some("1".into()),
        offset: 0,
        page_size: 50,
        query: String::new(),
        decade: Some(1960),
        favorites_only: false,
        language_mode: LanguageMode::All,
        content_type: ContentType::All,
    };
    let reply = item_progress(&c, &p, &mut || Ok(())).unwrap();
    assert_eq!(reply.items[0].available_file_count, 0);
    assert!(!reply.items[0].complete);
    let mut next = title("pending", Some(1964), 1);
    next.partial = Some(page(128, Some(64)));
    next.files[0].provider_index = Some(64);
    next.files[1].provider_index = Some(65);
    let mut prepared = step(vec![next]);
    prepared.item_page = true;
    let mut calls = 0;
    assert!(commit(
        &mut c,
        "1",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "unused",
            restart: false
        },
        prepared,
        &mut || {
            calls += 1;
            if calls == 3 {
                Err("canceled".into())
            } else {
                Ok(())
            }
        }
    )
    .is_err());
    assert_eq!(current(&c).unwrap(), 1);
    assert_eq!(file_progress(&c, "pending").unwrap().next_offset, 64);
    assert_eq!(
        file_progress(&c, "pending").unwrap().available_file_count,
        0
    );
}
#[test]
fn archive_curation_caps_distinct_provider_items_and_nests_episode_files() {
    let mut c = database();
    let titles = (0..12)
        .map(|i| title(&format!("item-{i:02}"), Some(1964), i))
        .collect();
    let receipt = commit(
        &mut c,
        "0",
        SearchPage {
            year: Some(1964),
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(titles),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(receipt.title_count, 10);
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_file_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        20
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM unrelated_station", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("SELECT min(downloads) FROM archive_title_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}
#[test]
fn archive_explicit_search_retains_pre_decade_and_unknown_year() {
    let mut c = database();
    let receipt = commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![
            title("older", Some(1928), 1),
            title("unknown", None, 2),
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(receipt.title_count, 2);
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM archive_title_v1 WHERE curated=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let q = Query {
        schema_version: 1,
        request_id: "fixture".into(),
        query: String::new(),
        expected_revision: Some("1".into()),
        offset: 0,
        page_size: 50,
        curated_only: true,
        decade: None,
        favorites_only: false,
        language_mode: LanguageMode::All,
        content_type: ContentType::All,
    };
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
}
#[test]
fn archive_structured_metadata_matches_fields_not_description_or_json_keys() {
    let mut c = database();
    let mut items = Vec::new();
    for (id, name, subject, description, language) in [
        ("title", "Classic Cartoon Collection", "", "", "eng"),
        ("subject", "Classic shorts", "animation", "", "English"),
        (
            "incidental",
            "News report",
            "",
            "A cartoon is mentioned here",
            "spa",
        ),
        ("substring", "Cartoonish commentary", "", "", ""),
        ("spanish", "Cartoons in Spanish", "cartoons", "", "spa"),
    ] {
        let mut t = title(id, Some(1964), 1);
        t.title = name.into();
        t.search_aliases = encode_search_metadata(&SearchMetadata {
            title: name.into(),
            subjects: subject.into(),
            description: description.into(),
            collections: "cartoons".into(),
            languages: if language.is_empty() {
                vec![]
            } else {
                vec![language.into()]
            },
            ..Default::default()
        })
        .unwrap();
        items.push(t);
    }
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "Cartoon",
            restart: false,
        },
        step(items),
        &mut || Ok(()),
    )
    .unwrap();
    let page = query(&c, &search_query("Cartoon", "1"), &mut || Ok(())).unwrap();
    assert_eq!(page.total_count, 3);
    assert_eq!(page.items[0].match_basis, "title");
    assert!(page
        .items
        .iter()
        .any(|t| t.match_basis == "subject" && t.provider_languages == ["English"]));
    assert!(page
        .items
        .iter()
        .any(|t| t.provider_languages == ["spa"] && t.language_provenance == "provider-item"));
    assert!(query(&c, &search_query("languages", "1"), &mut || Ok(()))
        .unwrap()
        .items
        .is_empty());
    assert_eq!(
        query(&c, &search_query("", "1"), &mut || Ok(()))
            .unwrap()
            .total_count,
        5
    );
}
#[test]
fn archive_metadata_envelope_is_bounded_and_legacy_stays_truthful() {
    assert_eq!(match_basis("", "cartoonish", "", "cartoon").unwrap(), None);
    assert_eq!(
        match_basis("", "gilligan island", "", "Gilligan").unwrap(),
        None
    );
    assert!(decode_search_metadata("@genx-search-v2:{broken}").is_err());
    let big = SearchMetadata {
        description: "x".repeat(16384),
        ..Default::default()
    };
    assert!(encode_search_metadata(&big).is_err());
    let data = SearchMetadata {
        series: "Gilligan Island".into(),
        description: "cartoons".into(),
        ..Default::default()
    };
    let encoded = encode_search_metadata(&data).unwrap();
    assert_eq!(
        match_basis("", &encoded, "", "Gilligan").unwrap(),
        Some("series")
    );
    assert_eq!(match_basis("", &encoded, "", "cartoons").unwrap(), None);
    assert_eq!(
        match_basis("", &encoded, "Gilligan_S01_E01.mp4", "Gilligan").unwrap(),
        Some("series")
    );
    assert_eq!(
        match_basis("", &encoded, "Pilot_Episode.mp4", "Pilot episode").unwrap(),
        Some("file")
    );
}
#[test]
fn archive_structured_pending_pages_decode_actual_title_without_matching_json() {
    let mut c = database();
    let mut t = title("partial", Some(1964), 1);
    t.partial = Some(page(64, None));
    t.search_aliases = encode_search_metadata(&SearchMetadata {
        title: "Gilligan Island".into(),
        description: "cartoons".into(),
        ..Default::default()
    })
    .unwrap();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "Gilligan",
            restart: false,
        },
        step(vec![t]),
        &mut || Ok(()),
    )
    .unwrap();
    let q = FileProgressQuery {
        schema_version: 1,
        request_id: "fixture".into(),
        expected_revision: Some("1".into()),
        offset: 0,
        page_size: 50,
        query: "Gilligan".into(),
        decade: None,
        favorites_only: false,
        language_mode: LanguageMode::All,
        content_type: ContentType::All,
    };
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
        1
    );
    let q = FileProgressQuery {
        query: "description".into(),
        ..q
    };
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
        0
    );
}
#[test]
fn archive_search_named_possessive_is_bounded_not_arbitrary_prefix() {
    assert_eq!(
        match_basis(
            "Gilligans Island 1.00",
            "",
            "GilligansIsland1.00.mp4",
            "Gilligan"
        )
        .unwrap(),
        Some("title")
    );
    assert_eq!(
        match_basis("Gilligan's Island", "", "", "Gilligan").unwrap(),
        Some("title")
    );
    assert_eq!(
        match_basis("Gilliganish parody", "", "", "Gilligan").unwrap(),
        None
    );
    assert_eq!(
        match_basis("Cartoonish commentary", "", "", "Cartoon").unwrap(),
        None
    );
    assert_ne!(
        search_scope_hash("Gilligan", None),
        opaque(&["archive-query-v3", "Gilligan", ""])
    );
}
#[test]
fn archive_cartoon_subject_rejects_observed_youtube_category_boilerplate() {
    let mut c = database();
    let mut items = Vec::new();
    for (id, name, subject) in [
        (
            "vlog",
            "How Men's Circles Can Bring You Into Your Feelings",
            "Youtube;video;Film & Animation;",
        ),
        (
            "security",
            "AT&T ThreatTraq",
            "Youtube,video,Film & Animation",
        ),
        ("war", "Ukrainian war", "Youtube\nvideo\nFilm & Animation"),
        ("trailer", "MAGADAN trailer", "Film and Animation"),
        (
            "real",
            "Classic shorts",
            "Youtube;Film & Animation;Cartoons;",
        ),
        ("animation", "Classic shorts two", "Animation"),
    ] {
        let mut t = title(id, Some(1970), 1);
        t.title = name.into();
        t.search_aliases = encode_search_metadata(&SearchMetadata {
            title: name.into(),
            subjects: subject.into(),
            ..Default::default()
        })
        .unwrap();
        items.push(t);
    }
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "Cartoon",
            restart: false,
        },
        step(items),
        &mut || Ok(()),
    )
    .unwrap();
    let result = query(&c, &search_query("Cartoon", "1"), &mut || Ok(())).unwrap();
    assert_eq!(result.total_count, 2);
    assert!(result.items.iter().all(|t| t.match_basis == "subject"));
    assert_eq!(
        query(&c, &search_query("", "1"), &mut || Ok(()))
            .unwrap()
            .total_count,
        6
    );
    assert_eq!(
        match_basis("Animated Classic", "", "", "Cartoon").unwrap(),
        Some("title")
    );
    assert!(subject_match("Film & Animation;Animated", "Cartoon"));
    assert!(!subject_match("Film & Animation;", "Cartoon"));
    assert_ne!(
        search_scope_hash("Cartoon", None),
        opaque(&["archive-query-fields-v4", "Cartoon", ""])
    );
}
#[test]
fn archive_local_query_matches_subject_and_episode_filename_without_merging_items() {
    let mut c = database();
    let mut first = title("first", Some(1964), 1);
    first.search_aliases = encode_search_metadata(&SearchMetadata {
        title: first.title.clone(),
        subjects: "monster movies".into(),
        ..Default::default()
    })
    .unwrap();
    first.files[0].name = "Pilot episode.mp4".into();
    first.all_file_names[0] = "Pilot episode.mp4".into();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![first, title("second", Some(1964), 2)]),
        &mut || Ok(()),
    )
    .unwrap();
    let mut q = Query {
        schema_version: 1,
        request_id: "fixture".into(),
        query: "monster".into(),
        expected_revision: Some("1".into()),
        offset: 0,
        page_size: 50,
        curated_only: false,
        decade: None,
        favorites_only: false,
        language_mode: LanguageMode::All,
        content_type: ContentType::All,
    };
    let page = query(&c, &q, &mut || Ok(())).unwrap();
    assert_eq!(page.total_count, 1);
    assert_eq!(
        page.items[0].title_ref,
        opaque(&["archive-item-v1", "first"])
    );
    q.query = "pilot episode".into();
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 1);
    q.query = "identical".into();
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 2);
    q.expected_revision = Some("0".into());
    assert!(matches!(query(&c,&q,&mut || Ok(())),Err(e) if e=="archive-revision-stale"));
}
fn search_title(
    id: &str,
    name: &str,
    year: Option<i64>,
    downloads: i64,
    alias: &str,
) -> PreparedTitle {
    let mut t = title(id, year, downloads);
    t.title = name.into();
    t.search_aliases = encode_search_metadata(&SearchMetadata {
        title: name.into(),
        subjects: alias.into(),
        ..Default::default()
    })
    .unwrap();
    t
}
fn search_query(value: &str, revision: &str) -> Query {
    Query {
        schema_version: 1,
        request_id: "fixture".into(),
        query: value.into(),
        expected_revision: Some(revision.into()),
        offset: 0,
        page_size: 50,
        curated_only: false,
        decade: None,
        favorites_only: false,
        language_mode: LanguageMode::All,
        content_type: ContentType::All,
    }
}
fn refs(page: &Page) -> Vec<String> {
    page.items.iter().map(|t| t.title_ref.clone()).collect()
}
fn language_title(id: &str, name: &str, languages: &[&str], downloads: i64) -> PreparedTitle {
    let mut item = search_title(id, name, Some(1964), downloads, "");
    item.search_aliases = encode_search_metadata(&SearchMetadata {
        title: name.into(),
        languages: languages.iter().map(|s| (*s).into()).collect(),
        ..Default::default()
    })
    .unwrap();
    item
}
#[test]
fn archive_language_dto_default_and_invalid_modes_are_explicit() {
    let value = serde_json::json!({"schemaVersion":1,"requestId":"fixture","query":"","expectedRevision":null,"offset":0,"pageSize":50});
    assert_eq!(
        serde_json::from_value::<Query>(value.clone())
            .unwrap()
            .language_mode,
        LanguageMode::All
    );
    assert_eq!(
        serde_json::from_value::<FileProgressQuery>(value.clone())
            .unwrap()
            .language_mode,
        LanguageMode::All
    );
    for (mode, expected) in [
        ("all", LanguageMode::All),
        ("english-first", LanguageMode::EnglishFirst),
        ("english", LanguageMode::English),
        ("unlisted", LanguageMode::Unlisted),
    ] {
        let mut request = value.clone();
        request["languageMode"] = mode.into();
        assert_eq!(
            serde_json::from_value::<Query>(request.clone())
                .unwrap()
                .language_mode,
            expected
        );
        assert_eq!(
            serde_json::from_value::<FileProgressQuery>(request)
                .unwrap()
                .language_mode,
            expected
        );
    }
    for invalid in [
        serde_json::json!("English"),
        serde_json::json!("en"),
        serde_json::json!(""),
        serde_json::Value::Null,
        serde_json::json!(4),
    ] {
        let mut request = value.clone();
        request["languageMode"] = invalid;
        assert!(serde_json::from_value::<Query>(request.clone()).is_err());
        assert!(serde_json::from_value::<FileProgressQuery>(request).is_err());
    }
}
#[test]
fn archive_language_claim_aliases_do_not_guess_audio_or_country() {
    for label in [
        "en",
        "eng",
        "English",
        " ENGLISH ",
        "en-US",
        "en-GB",
        "en-Latn-US",
        "EN-au",
        "en-001",
    ] {
        assert_eq!(provider_language_rank(&[label.into()]), 0, "{label}");
    }
    for label in [
        "und",
        "unknown",
        "US",
        "GB",
        "United States",
        "United Kingdom",
        "English subtitles",
        "French and English",
        "en_uk",
        "english-US",
        "en-",
        "en-!",
        "en-US-",
        "en-notenglish",
    ] {
        assert_eq!(provider_language_rank(&[label.into()]), 2, "{label}");
    }
    assert_eq!(provider_language_rank(&[]), 1);
    assert_eq!(provider_language_rank(&["spa".into(), "en-GB".into()]), 0);
}
#[test]
fn archive_language_filters_preserve_unknown_legacy_library_and_bookmarks() {
    let mut c = database();
    let mut legacy = title("legacy", Some(1964), 99);
    legacy.title = "English US England".into();
    legacy.search_aliases = "eng English US London".into();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![
            language_title("en-us", "US provider claim", &["en-US"], 1),
            language_title("en-gb", "UK provider claim", &["en-GB"], 2),
            language_title("mixed", "Multiple claims", &["spa", "eng"], 3),
            language_title("unknown", "English in title", &[], 4),
            language_title("und", "Unknown label", &["und"], 5),
            language_title("country", "English London", &["United Kingdom"], 6),
            legacy,
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    let reference = opaque(&["archive-file-v1", "en-us", "one.mp4"]);
    c.execute(
        "UPDATE archive_file_v1 SET sha1=?1 WHERE file_ref=?2",
        params!["0123456789abcdef0123456789abcdef01234567", reference],
    )
    .unwrap();
    let file = resolve(&c, &reference, "1").unwrap();
    let proof = crate::archive_bookmarks::capture(&reference, &file).unwrap();
    let position = crate::archive_bookmarks::Position {
        position_ms: 12345,
        duration_ms: Some(60000),
        completed: false,
        observed_ms: 1000,
    };
    crate::archive_bookmarks::save(&mut c, &proof, "0", &position, || Ok(())).unwrap();
    let mut q = search_query("", "1");
    let before = refs(&query(&c, &q, &mut || Ok(())).unwrap());
    q.language_mode = LanguageMode::English;
    let english = query(&c, &q, &mut || Ok(())).unwrap();
    assert_eq!(english.total_count, 3);
    assert!(english
        .items
        .iter()
        .all(|t| t.language_provenance == "provider-item"));
    q.language_mode = LanguageMode::Unlisted;
    let unlisted = query(&c, &q, &mut || Ok(())).unwrap();
    assert_eq!(unlisted.total_count, 2);
    assert!(unlisted
        .items
        .iter()
        .all(|t| t.provider_languages.is_empty() && t.language_provenance == "unknown"));
    q.language_mode = LanguageMode::All;
    assert_eq!(refs(&query(&c, &q, &mut || Ok(())).unwrap()), before);
    assert_eq!(current(&c).unwrap(), 1);
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_file_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        14
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM unrelated_station", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        crate::archive_bookmarks::read(&c, &proof)
            .unwrap()
            .position
            .unwrap()
            .position_ms,
        12345
    );
}
#[test]
fn archive_language_english_first_preserves_favorite_and_relevance_tiers() {
    let mut c = database();
    let mut subject = language_title("english-subject", "Other name", &["eng"], 100);
    subject.search_aliases = encode_search_metadata(&SearchMetadata {
        title: "Other name".into(),
        subjects: "Cartoon".into(),
        languages: vec!["eng".into()],
        ..Default::default()
    })
    .unwrap();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![
            language_title("favorite", "Cartoon extra", &["spa"], 1),
            language_title("exact", "Cartoon", &["spa"], 2),
            language_title("prefix-other", "Cartoon alpha", &["spa"], 3),
            language_title("prefix-unknown", "Cartoon beta", &[], 4),
            language_title("prefix-english", "Cartoon zeta", &["en"], 5),
            subject,
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    set_favorite(
        &mut c,
        &FavoriteRequest {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: opaque(&["archive-item-v1", "favorite"]),
            expected_revision: "1".into(),
            value: true,
        },
        &mut || Ok(()),
    )
    .unwrap();
    let mut q = search_query("Cartoon", "2");
    q.language_mode = LanguageMode::EnglishFirst;
    let expected = [
        "favorite",
        "exact",
        "prefix-english",
        "prefix-unknown",
        "prefix-other",
        "english-subject",
    ]
    .map(|id| opaque(&["archive-item-v1", id]));
    assert_eq!(refs(&query(&c, &q, &mut || Ok(())).unwrap()), expected);
    q.favorites_only = true;
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 1);
    q.language_mode = LanguageMode::English;
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
    assert!(c
        .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
            .get::<_, bool>(0))
        .unwrap());
}
#[test]
fn archive_language_blank_browse_stable_pagination_keeps_original_tiebreaks() {
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
        step(vec![
            language_title("english-a", "Z title", &["en"], 5),
            language_title("english-b", "A title", &["English"], 5),
            language_title("english-c", "B title", &["eng"], 1),
            language_title("unlisted", "No claim", &[], 99),
            language_title("other", "Spanish", &["spa"], 100),
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    let mut q = search_query("", "1");
    let old = refs(&query(&c, &q, &mut || Ok(())).unwrap());
    q.language_mode = LanguageMode::EnglishFirst;
    let expected = ["english-a", "english-b", "english-c", "unlisted", "other"]
        .map(|id| opaque(&["archive-item-v1", id]));
    assert_eq!(refs(&query(&c, &q, &mut || Ok(())).unwrap()), expected);
    q.page_size = 2;
    let mut paged = Vec::new();
    loop {
        let page = query(&c, &q, &mut || Ok(())).unwrap();
        assert_eq!(page.total_count, 5);
        paged.extend(refs(&page));
        if !page.more {
            break;
        }
        q.offset += page.items.len();
    }
    assert_eq!(paged, expected);
    q.offset = 0;
    q.page_size = 50;
    q.language_mode = LanguageMode::All;
    assert_eq!(refs(&query(&c, &q, &mut || Ok(())).unwrap()), old);
    q.decade = Some(1970);
    q.language_mode = LanguageMode::English;
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
}
#[test]
fn archive_language_pending_pages_share_filters_ranking_and_pagination() {
    let mut c = database();
    let mut titles = vec![
        language_title("english", "Cartoon zeta", &["en-GB"], 1),
        language_title("unknown", "Cartoon beta", &[], 2),
        language_title("spanish", "Cartoon alpha", &["spa"], 3),
        language_title("exact", "Cartoon", &["spa"], 4),
    ];
    for item in &mut titles {
        item.partial = Some(page(64, None));
    }
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(titles),
        &mut || Ok(()),
    )
    .unwrap();
    let mut q = FileProgressQuery {
        schema_version: 1,
        request_id: "fixture".into(),
        expected_revision: Some("1".into()),
        offset: 0,
        page_size: 50,
        query: "Cartoon".into(),
        decade: None,
        favorites_only: false,
        language_mode: LanguageMode::English,
        content_type: ContentType::All,
    };
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().items[0].title_ref,
        opaque(&["archive-item-v1", "english"])
    );
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
        1
    );
    q.language_mode = LanguageMode::Unlisted;
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().items[0].title_ref,
        opaque(&["archive-item-v1", "unknown"])
    );
    q.language_mode = LanguageMode::EnglishFirst;
    q.page_size = 1;
    let expected =
        ["exact", "english", "unknown", "spanish"].map(|id| opaque(&["archive-item-v1", id]));
    let mut actual = Vec::new();
    for offset in 0..4 {
        q.offset = offset;
        let reply = item_progress(&c, &q, &mut || Ok(())).unwrap();
        assert_eq!(reply.total_count, 4);
        assert_eq!(reply.more, offset < 3);
        actual.push(reply.items[0].title_ref.clone());
    }
    assert_eq!(actual, expected);
    q.offset = 0;
    q.decade = Some(1970);
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
        0
    );
    q.decade = None;
    q.language_mode = LanguageMode::All;
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
        4
    );
    assert_eq!(current(&c).unwrap(), 1);
}
#[test]
fn archive_search_ranks_favorites_then_literal_title_matches_before_aliases() {
    let mut c = database();
    let phrase = "night of living dead";
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: phrase,
            restart: false,
        },
        step(vec![
            search_title(
                "description",
                "High Street Cemetery",
                Some(1968),
                900,
                phrase,
            ),
            search_title(
                "tokens",
                "Night Living Dead: of Terror",
                Some(1968),
                800,
                "",
            ),
            search_title(
                "contains",
                "Restored Night of Living Dead Feature",
                Some(1968),
                700,
                "",
            ),
            search_title("prefix", "Night of Living Dead 4K", Some(1968), 600, ""),
            search_title("exact", "Night of Living Dead", Some(1968), 1, ""),
            search_title("favorite", "Monster Movie Night", Some(1968), 1000, phrase),
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    set_favorite(
        &mut c,
        &FavoriteRequest {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: opaque(&["archive-item-v1", "favorite"]),
            expected_revision: "1".into(),
            value: true,
        },
        &mut || Ok(()),
    )
    .unwrap();
    let q = search_query("  NIGHT  of Living DEAD  ", "2");
    let result = query(&c, &q, &mut || Ok(())).unwrap();
    let expected: Vec<_> = [
        "favorite",
        "exact",
        "prefix",
        "contains",
        "tokens",
        "description",
    ]
    .into_iter()
    .map(|id| opaque(&["archive-item-v1", id]))
    .collect();
    assert_eq!(refs(&result), expected);
    assert_eq!(result.total_count, 6);
    assert!(result.items[0].favorite);
    // Popularity rank remains source metadata, not the relevance position.
    assert_eq!(result.items[1].rank, 6);
    let mut paged = q;
    paged.page_size = 2;
    let mut actual = Vec::new();
    for offset in [0, 2, 4] {
        paged.offset = offset;
        let page = query(&c, &paged, &mut || Ok(())).unwrap();
        assert_eq!(page.total_count, 6);
        assert_eq!(page.more, offset < 4);
        actual.extend(refs(&page));
    }
    assert_eq!(actual, expected);
    paged.expected_revision = Some("1".into());
    assert!(matches!(query(&c, &paged, &mut || Ok(())), Err(e) if e == "archive-revision-stale"));
}
#[test]
fn archive_search_blank_keeps_popularity_order_with_favorites_first_and_decade_scope() {
    let mut c = database();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: Some(1968),
            page: 1,
            query_hash: "",
            restart: false,
        },
        step(vec![
            search_title("high", "Zulu", Some(1968), 300, ""),
            search_title("middle", "Alpha", Some(1968), 200, ""),
            search_title("favorite", "Low", Some(1968), 1, ""),
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    commit(
        &mut c,
        "1",
        SearchPage {
            year: Some(1970),
            page: 1,
            query_hash: "",
            restart: false,
        },
        step(vec![search_title(
            "later",
            "Earlier Alphabet",
            Some(1970),
            9999,
            "",
        )]),
        &mut || Ok(()),
    )
    .unwrap();
    set_favorite(
        &mut c,
        &FavoriteRequest {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: opaque(&["archive-item-v1", "favorite"]),
            expected_revision: "2".into(),
            value: true,
        },
        &mut || Ok(()),
    )
    .unwrap();
    let mut q = search_query("   ", "3");
    q.curated_only = true;
    let result = query(&c, &q, &mut || Ok(())).unwrap();
    let expected: Vec<_> = ["favorite", "high", "middle", "later"]
        .into_iter()
        .map(|id| opaque(&["archive-item-v1", id]))
        .collect();
    assert_eq!(refs(&result), expected);
    assert_eq!(
        result.items.iter().map(|t| t.rank).collect::<Vec<_>>(),
        [3, 1, 2, 1]
    );
    q.decade = Some(1970);
    let filtered = query(&c, &q, &mut || Ok(())).unwrap();
    assert_eq!(filtered.total_count, 1);
    assert_eq!(filtered.items[0].title_ref, expected[3]);
    q.favorites_only = true;
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
}
#[test]
fn archive_search_unicode_punctuation_and_identity_ties_are_literal_and_stable() {
    let mut c = database();
    let punctuation = "%'_; DROP TABLE archive_title_v1; --";
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![
            search_title("unicode-b", "ÉCOLE du cinéma", Some(1964), 1, ""),
            search_title("unicode-a", "École du cinéma", Some(1964), 900, ""),
            search_title(
                "unicode-description",
                "Anthology",
                Some(1964),
                9999,
                "école du cinéma",
            ),
            search_title("punctuation", punctuation, Some(1964), 2, ""),
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    let result = query(
        &c,
        &search_query("E\u{301}COLE du CINE\u{301}MA", "1"),
        &mut || Ok(()),
    )
    .unwrap();
    let mut expected = [
        opaque(&["archive-item-v1", "unicode-a"]),
        opaque(&["archive-item-v1", "unicode-b"]),
    ];
    expected.sort();
    assert_eq!(&refs(&result)[..2], &expected);
    assert_eq!(result.total_count, 3);
    assert_eq!(
        result.items[2].title_ref,
        opaque(&["archive-item-v1", "unicode-description"])
    );
    let literal = query(&c, &search_query(punctuation, "1"), &mut || Ok(())).unwrap();
    assert_eq!(literal.total_count, 1);
    assert_eq!(literal.items[0].title, punctuation);
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        4
    );
    let mut canceled = 0;
    assert!(query(&c, &search_query("école", "1"), &mut || {
        canceled += 1;
        Err("canceled".into())
    })
    .is_err());
    assert_eq!(canceled, 1);
}
#[test]
fn archive_decade_and_favorites_filter_before_exact_count_and_page() {
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
        step(vec![
            title("sixties", Some(1969), 1),
            title("seventies", Some(1970), 2),
            title("unknown", None, 3),
            title("other-seventies", Some(1979), 4),
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    let favorite = FavoriteRequest {
        schema_version: 1,
        request_id: "fixture".into(),
        title_ref: opaque(&["archive-item-v1", "seventies"]),
        expected_revision: "1".into(),
        value: true,
    };
    assert_eq!(
        set_favorite(&mut c, &favorite, &mut || Ok(()))
            .unwrap()
            .revision,
        "2"
    );
    let mut q = Query {
        schema_version: 1,
        request_id: "fixture".into(),
        query: String::new(),
        expected_revision: Some("2".into()),
        offset: 0,
        page_size: 1,
        curated_only: false,
        decade: Some(1970),
        favorites_only: false,
        language_mode: LanguageMode::All,
        content_type: ContentType::All,
    };
    let page = query(&c, &q, &mut || Ok(())).unwrap();
    assert_eq!(page.total_count, 2);
    assert!(page.more);
    q.offset = 1;
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().items.len(), 1);
    q.offset = 0;
    q.favorites_only = true;
    let page = query(&c, &q, &mut || Ok(())).unwrap();
    assert_eq!(page.total_count, 1);
    assert!(page.items[0].favorite);
    assert_eq!(page.items[0].title_ref, favorite.title_ref);
    q.decade = Some(1960);
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
    q.favorites_only = false;
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 1);
    q.decade = Some(1950);
    assert!(query(&c, &q, &mut || Ok(())).is_err());
}
#[test]
fn archive_favorite_cas_cancel_refresh_and_dead_tombstone_are_durable() {
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
    let mut r = FavoriteRequest {
        schema_version: 1,
        request_id: "fixture".into(),
        title_ref: opaque(&["archive-item-v1", "chosen"]),
        expected_revision: "1".into(),
        value: true,
    };
    assert_eq!(
        set_favorite(&mut c, &r, &mut || Ok(())).unwrap().revision,
        "2"
    );
    assert!(matches!(set_favorite(&mut c,&r,&mut ||Ok(())),Err(e) if e=="archive-revision-stale"));
    r.expected_revision = "2".into();
    assert_eq!(
        set_favorite(&mut c, &r, &mut || Ok(())).unwrap().revision,
        "2"
    );
    r.value = false;
    let mut calls = 0;
    assert!(set_favorite(&mut c, &r, &mut || {
        calls += 1;
        if calls == 2 {
            Err("canceled".into())
        } else {
            Ok(())
        }
    })
    .is_err());
    assert_eq!(current(&c).unwrap(), 2);
    assert!(c
        .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
            .get::<_, bool>(0))
        .unwrap());
    let mut retry = step(Vec::new());
    retry.transient_failures = 1;
    retry.next_page = Some(1);
    commit(
        &mut c,
        "2",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        retry,
        &mut || Ok(()),
    )
    .unwrap();
    assert!(c
        .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
            .get::<_, bool>(0))
        .unwrap());
    let mut refresh = step(vec![title("chosen", Some(1964), 99)]);
    refresh.observed_ms = 2_000_000;
    commit(
        &mut c,
        "3",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        refresh,
        &mut || Ok(()),
    )
    .unwrap();
    assert!(c
        .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
            .get::<_, bool>(0))
        .unwrap());
    let mut dead = step(Vec::new());
    dead.deleted.push("chosen".into());
    commit(
        &mut c,
        "4",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        dead,
        &mut || Ok(()),
    )
    .unwrap();
    assert!(c
        .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
            .get::<_, bool>(0))
        .unwrap());
    r.expected_revision = "5".into();
    assert_eq!(
        set_favorite(&mut c, &r, &mut || Ok(())).unwrap().revision,
        "6"
    );
    assert!(!c
        .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
            .get::<_, bool>(0))
        .unwrap());
}
#[test]
fn archive_favorite_retains_playable_item_when_year_ranking_changes() {
    let mut c = database();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: Some(1964),
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![title("chosen", Some(1964), 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    let r = FavoriteRequest {
        schema_version: 1,
        request_id: "fixture".into(),
        title_ref: opaque(&["archive-item-v1", "chosen"]),
        expected_revision: "1".into(),
        value: true,
    };
    set_favorite(&mut c, &r, &mut || Ok(())).unwrap();
    commit(
        &mut c,
        "2",
        SearchPage {
            year: Some(1964),
            page: 1,
            query_hash: "query",
            restart: true,
        },
        step(
            (0..10)
                .map(|i| title(&format!("new-{i}"), Some(1964), 100 + i))
                .collect(),
        ),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM archive_title_v1 WHERE curated=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        10
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM archive_file_v1 WHERE title_ref=?1",
            [&r.title_ref],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert!(!c
        .query_row(
            "SELECT curated FROM archive_title_v1 WHERE title_ref=?1",
            [&r.title_ref],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
}
#[test]
fn archive_cancellation_rolls_back_catalog_and_progress() {
    let mut c = database();
    let mut calls = 0;
    let result = commit(
        &mut c,
        "0",
        SearchPage {
            year: Some(1964),
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![title("held", Some(1964), 1)]),
        &mut || {
            calls += 1;
            if calls >= 3 {
                Err("canceled".into())
            } else {
                Ok(())
            }
        },
    );
    assert!(result.is_err());
    assert_eq!(current(&c).unwrap(), 0);
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_progress_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn archive_transient_failure_keeps_last_good_files_and_retry_page() {
    let mut c = database();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: Some(1964),
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![title("retained", Some(1964), 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    let mut failed = step(Vec::new());
    failed.transient_failures = 1;
    failed.next_page = Some(1);
    let receipt = commit(
        &mut c,
        "1",
        SearchPage {
            year: Some(1964),
            page: 1,
            query_hash: "query",
            restart: true,
        },
        failed,
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(receipt.title_count, 1);
    assert_eq!(receipt.confirmed_dead, 0);
    assert_eq!(receipt.next_page, Some(1));
    assert!(receipt.retry_after_ms.is_some());
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_file_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        prepare_at(&c, "2", 1964, 1, "query", false, 1_000_000),
        Err("archive-retry-not-due".into())
    );
}
#[test]
fn archive_live_fence_ignores_unrelated_revision_and_refuses_changed_binding() {
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
        step(vec![title("selected", Some(1928), 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    let reference = opaque(&["archive-file-v1", "selected", "one.mp4"]);
    let file = resolve(&c, &reference, "1").unwrap();
    commit(
        &mut c,
        "1",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "other-query",
            restart: false,
        },
        step(vec![title("unrelated", None, 2)]),
        &mut || Ok(()),
    )
    .unwrap();
    assert!(verify_live(&c, &reference, &file).is_ok());
    c.execute(
        "UPDATE archive_file_v1 SET size_bytes='301' WHERE file_ref=?1",
        [&reference],
    )
    .unwrap();
    assert_eq!(
        verify_live(&c, &reference, &file),
        Err("archive-file-changed".into())
    );
    c.execute(
        "UPDATE archive_file_v1 SET eligible=0 WHERE file_ref=?1",
        [&reference],
    )
    .unwrap();
    assert_eq!(
        verify_live(&c, &reference, &file),
        Err("archive-file-unavailable".into())
    );
}
#[test]
fn archive_complete_file_list_removes_only_confirmed_absent_copy() {
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
        step(vec![title("selected", None, 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    let mut fresh = title("selected", None, 1);
    fresh.all_file_names = vec!["one.mp4".into()];
    fresh.files.truncate(1);
    let result = commit(
        &mut c,
        "1",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        step(vec![fresh]),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(result.confirmed_dead, 1);
    assert_eq!(result.title_count, 1);
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_file_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
fn observed_search_metadata(raw: &str) -> SearchMetadata {
    let document: serde_json::Value = serde_json::from_str(raw).unwrap();
    let metadata = &document["metadata"];
    let field = |name: &str| match &metadata[name] {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Array(values) => values
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    SearchMetadata {
        title: field("title"),
        series: field("series"),
        subjects: field("subject"),
        collections: field("collection"),
        description: String::new(),
        languages: vec![],
        provider_type: String::new(),
        artwork: None,
    }
}
#[test]
fn archive_observed_concert_cartoon_tag_is_not_animation_but_named_browse_remain() {
    let metadata = observed_search_metadata(include_str!(
            "../../tests/fixtures/archive-search-metadata/kdhxmo-Opera_Bell_Band_50_000_000_Live_at_KDHX_7_20_21.json"
        ));
    assert!(metadata.subjects.lines().any(|label| label == "cartoon"));
    let aliases = encode_search_metadata(&metadata).unwrap();
    for query in ["Cartoon", "cartoons", "animation", "animated"] {
        assert_eq!(
            match_basis(
                &metadata.title,
                &aliases,
                "Opera_Bell_Band_50_000_000_Live_at_KDHX_7_20_21.mp4",
                query
            )
            .unwrap(),
            None
        );
    }
    assert_eq!(
        match_basis(&metadata.title, &aliases, "", "Opera Bell Band").unwrap(),
        Some("title")
    );
    assert_eq!(
        match_basis(&metadata.title, &aliases, "", "").unwrap(),
        Some("browse")
    );
    assert_eq!(
        match_basis("Cartoonish commentary", "", "", "Cartoon").unwrap(),
        None
    );
    let only_style = SearchMetadata {
        title: metadata.title.clone(),
        subjects: "cartoon".into(),
        ..Default::default()
    };
    let style_aliases = encode_search_metadata(&only_style).unwrap();
    assert_eq!(
        match_basis(&only_style.title, &style_aliases, "", "Cartoon").unwrap(),
        None
    );
    assert_eq!(
        match_basis("", &style_aliases, "", "Cartoon").unwrap(),
        None,
        "pending suggestions retain the actual live-performance title context"
    );
    let animated = SearchMetadata {
        title: "Animated concert".into(),
        subjects: "music video\nAnimation".into(),
        ..Default::default()
    };
    let aliases = encode_search_metadata(&animated).unwrap();
    assert_eq!(
        match_basis("", &aliases, "", "Cartoon").unwrap(),
        Some("title"),
        "pending metadata follows the same actual-title evidence"
    );
}
#[test]
fn archive_observed_title_keywords_cannot_override_incidental_context() {
    let concert = observed_search_metadata(include_str!(
            "../../tests/fixtures/archive-search-metadata/mmtvnh-Merrimack_Middle_School_Band_-_Cartoon_Symphony_2023.json"
        ));
    let alias = encode_search_metadata(&concert).unwrap();
    assert_eq!(
        match_basis(&concert.title, &alias, "Cartoon.mp4", "Cartoon").unwrap(),
        None
    );
    assert_eq!(
        match_basis("", &alias, "", "Cartoon").unwrap(),
        None,
        "pending predicate"
    );
    assert_eq!(
        match_basis(&concert.title, &alias, "", "Merrimack Middle School Band").unwrap(),
        Some("title")
    );
    assert_eq!(
        match_basis(&concert.title, &alias, "", "").unwrap(),
        Some("browse")
    );
    assert_eq!(
        match_basis(&concert.title, &alias, "", "concert").unwrap(),
        Some("subject"),
        "explicit context searches remain supported"
    );
    let animated = observed_search_metadata(include_str!(
        "../../tests/fixtures/archive-search-metadata/GrooviesMusicalEvolution.json"
    ));
    assert_eq!(
        match_basis(
            &animated.title,
            &encode_search_metadata(&animated).unwrap(),
            "",
            "Cartoon"
        )
        .unwrap(),
        Some("title"),
        "corroborated animation is not excluded merely for music"
    );
    for (raw, specific) in [
            (include_str!("../../tests/fixtures/archive-search-metadata/gtv16nm-El_Camino_-_A_Breaking_Bad_Movie_An_Interview_with_Vince_Gilligan_from_the_KiMo_Theatre.json"), "Vince Gilligan"),
            (include_str!("../../tests/fixtures/archive-search-metadata/Humane_Society_of_St._Lucie_County_Adopt-a-Pet_-_Gilligan.json"), "Adopt a Pet Gilligan"),
            (include_str!("../../tests/fixtures/archive-search-metadata/JamusUnpluggedLiveGilligansBarAndGrillJanuary112019.json"), "Jamus Unplugged"),
        ] {
            let m = observed_search_metadata(raw);
            let alias = encode_search_metadata(&m).unwrap();
            assert_eq!(match_basis(&m.title, &alias, "Gilligan.mp4", "Gilligan").unwrap(), None, "{}", m.title);
            assert_eq!(match_basis("", &alias, "", "Gilligan").unwrap(), None, "pending {}", m.title);
            assert_eq!(match_basis(&m.title, &alias, "", specific).unwrap(), Some("title"));
            assert_eq!(match_basis(&m.title, &alias, "", "").unwrap(), Some("browse"));
        }
}
#[test]
fn archive_observed_type_classifier_is_shared_not_a_collection_or_title_guess() {
    for (raw, expected) in [
            (
                include_str!("../../tests/fixtures/archive-search-metadata/GilligansIsland1.00.json"),
                ContentType::Tv,
            ),
            (
                include_str!("../../tests/fixtures/archive-search-metadata/thenewadventuresofgilligans1.json"),
                ContentType::Tv,
            ),
            (
                include_str!("../../tests/fixtures/archive-search-metadata/NightOfTheLivingDead-MPEG.json"),
                ContentType::Movie,
            ),
            (
                include_str!(
                    "../../tests/fixtures/archive-search-metadata/mmtvnh-Merrimack_Middle_School_Band_-_Cartoon_Symphony_2023.json"
                ),
                ContentType::Unknown,
            ),
        ] {
            assert_eq!(content_type(Some(&observed_search_metadata(raw))), expected);
        }
    for collections in [
        "opensource_movies\ncommunity",
        "television\ncommunity_media",
        "animationandcartoons",
        "my_feature_films",
    ] {
        assert_eq!(
            content_type(Some(&SearchMetadata {
                collections: collections.into(),
                ..Default::default()
            })),
            ContentType::Unknown
        );
    }
    assert_eq!(
        content_type(Some(&SearchMetadata {
            collections: "classic_tv\nfeature_films".into(),
            ..Default::default()
        })),
        ContentType::Unknown
    );
}
#[test]
fn archive_observed_animation_taxonomy_and_subjects_are_genre_not_playability_proof() {
    for (raw, expected) in [
        (
            include_str!("../../tests/fixtures/archive-search-metadata/Popeye_forPresident.json"),
            "subject",
        ),
        (
            include_str!("../../tests/fixtures/archive-search-metadata/BettyBoopCartoons.json"),
            "title",
        ),
        (
            include_str!(
                "../../tests/fixtures/archive-search-metadata/BugsBunnyCaseOfTheMissingHare.json"
            ),
            "genre",
        ),
    ] {
        let metadata = observed_search_metadata(raw);
        let aliases = encode_search_metadata(&metadata).unwrap();
        assert_eq!(
            match_basis(&metadata.title, &aliases, "", "Cartoon").unwrap(),
            Some(expected),
            "{}",
            metadata.title
        );
        assert_eq!(
            match_basis(&metadata.title, &aliases, "", "Gilligan").unwrap(),
            None
        );
    }
    let metadata = SearchMetadata {
        title: "Unrelated record".into(),
        collections: "cartoon\nmy_animationandcartoons".into(),
        description: "Cartoon animation".into(),
        ..Default::default()
    };
    assert_eq!(
        match_basis(
            &metadata.title,
            &encode_search_metadata(&metadata).unwrap(),
            "",
            "Cartoon"
        )
        .unwrap(),
        None
    );
}
fn discovery_view(language_mode: LanguageMode) -> DiscoveryView {
    DiscoveryView {
        schema_version: 1,
        language_mode,
        content_type: ContentType::All,
        favorites_only: false,
        curated_only: false,
    }
}
#[test]
fn archive_visible_yield_counts_new_full_snapshot_identities_not_admissions_or_first_page() {
    let mut c = database();
    let initial: Vec<_> = (0..60)
        .map(|index| {
            language_title(
                &format!("old{index:02}"),
                &format!("Gilligan {index:02}"),
                &["eng"],
                1,
            )
        })
        .collect();
    let legacy = commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(initial),
        &mut || Ok(()),
    )
    .unwrap();
    assert!(
        serde_json::to_value(legacy)
            .unwrap()
            .get("newVisibleMatches")
            .is_none(),
        "legacy receipt shape unchanged"
    );
    let english = discovery_view(LanguageMode::English);
    let receipt = commit_view(
        &mut c,
        "1",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        step(vec![language_title("old00", "Gilligan 00", &["eng"], 1)]),
        Some(("Gilligan", None, &english)),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(
        (receipt.admitted, receipt.new_visible_matches),
        (1, Some(0))
    );
    let receipt = commit_view(
        &mut c,
        "2",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        step(vec![language_title(
            "foreign",
            "Gilligan foreign",
            &["spa"],
            1,
        )]),
        Some(("Gilligan", None, &english)),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(
        (receipt.admitted, receipt.new_visible_matches),
        (1, Some(0))
    );
    let receipt = commit_view(
        &mut c,
        "3",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        step(vec![language_title(
            "new",
            "Gilligan ZZZ beyond first fifty",
            &["en-GB"],
            1,
        )]),
        Some(("Gilligan", None, &english)),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(receipt.new_visible_matches, Some(1));
    let mut q = search_query("Gilligan", "4");
    q.language_mode = LanguageMode::English;
    let first = query(&c, &q, &mut || Ok(())).unwrap();
    assert_eq!(first.total_count, 61);
    assert!(!first.items.iter().any(|item| item.title.contains("ZZZ")));
    let mut replacement = step(vec![language_title(
        "replacement",
        "Gilligan replacement",
        &["English"],
        1,
    )]);
    replacement.deleted.push("new".into());
    let receipt = commit_view(
        &mut c,
        "4",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        replacement,
        Some(("Gilligan", None, &english)),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(
        receipt.new_visible_matches,
        Some(1),
        "equal total count is not equal identity set"
    );
    assert_eq!(
        query(
            &c,
            &Query {
                expected_revision: Some("5".into()),
                ..q
            },
            &mut || Ok(())
        )
        .unwrap()
        .total_count,
        61
    );
}
#[test]
fn archive_visible_yield_uses_decade_favorites_curation_and_exact_language_filters() {
    for (language, decade, favorite_only, curated_only, expected) in [
        (LanguageMode::English, None, false, false, 0),
        (LanguageMode::Unlisted, None, false, false, 1),
        (LanguageMode::EnglishFirst, None, false, false, 1),
        (LanguageMode::All, Some(1970), false, false, 0),
        (LanguageMode::All, None, true, false, 0),
        (LanguageMode::All, None, false, true, 0),
    ] {
        let mut c = database();
        let view = DiscoveryView {
            favorites_only: favorite_only,
            curated_only,
            ..discovery_view(language)
        };
        let receipt = commit_view(
            &mut c,
            "0",
            SearchPage {
                year: None,
                page: 1,
                query_hash: "query",
                restart: false,
            },
            step(vec![language_title("new", "Gilligan", &[], 1)]),
            Some(("Gilligan", decade, &view)),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(receipt.new_visible_matches, Some(expected));
        assert_eq!(receipt.admitted, 1);
    }
}
#[test]
fn archive_visible_yield_cancel_stale_invalid_view_roll_back_catalog_and_cursor() {
    let mut c = database();
    let view = discovery_view(LanguageMode::All);
    assert!(commit_view(
        &mut c,
        "1",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false
        },
        step(vec![]),
        Some(("Gilligan", None, &view)),
        &mut || Ok(())
    )
    .is_err());
    let invalid = DiscoveryView {
        schema_version: 2,
        ..discovery_view(LanguageMode::All)
    };
    assert!(commit_view(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false
        },
        step(vec![]),
        Some(("Gilligan", None, &invalid)),
        &mut || Ok(())
    )
    .is_err());
    let mut checks = 0;
    assert!(commit_view(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false
        },
        step(vec![language_title("new", "Gilligan", &["eng"], 1)]),
        Some(("Gilligan", None, &view)),
        &mut || {
            checks += 1;
            if checks >= 5 {
                Err("canceled".into())
            } else {
                Ok(())
            }
        }
    )
    .is_err());
    assert_eq!(current(&c).unwrap(), 0);
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_progress_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn archive_content_types_are_grounded_claims_conflicts_and_legacy_stay_unknown() {
    for (claim, expected) in [
        ("Classic TV", ContentType::Tv),
        ("TV Series", ContentType::Tv),
        ("Feature film", ContentType::Movie),
        ("Short film", ContentType::Short),
        ("animated shorts", ContentType::Short),
        ("movie trailer", ContentType::Unknown),
        ("movies\nclassic tv", ContentType::Unknown),
        ("", ContentType::Unknown),
    ] {
        let m = SearchMetadata {
            subjects: claim.into(),
            ..Default::default()
        };
        assert_eq!(content_type(Some(&m)), expected, "{claim}");
    }
    assert_eq!(content_type(None), ContentType::Unknown);
    let mut c = database();
    let mut item = title("unknown", Some(2024), 1);
    item.kind = "movie";
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![item]),
        &mut || Ok(()),
    )
    .unwrap();
    let result = query(&c, &search_query("", "1"), &mut || Ok(())).unwrap();
    assert_eq!(result.items[0].content_type, ContentType::Unknown);
    assert_eq!(result.items[0].content_type_provenance, "unknown");
    assert!(result.items[0].artwork.is_none());
}
#[test]
fn archive_modern_browse_years_filter_before_paging_without_expanding_curation() {
    let mut c = database();
    let items = [1964, 2004, 2014, 2024, 2035, 2100]
        .into_iter()
        .map(|year| title(&format!("year{year}"), Some(year), 1))
        .collect();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(items),
        &mut || Ok(()),
    )
    .unwrap();
    for (decade, expected) in [(1960, 1), (2000, 1), (2010, 1), (2020, 3)] {
        let mut q = search_query("", "1");
        q.decade = Some(decade);
        q.page_size = 1;
        let first = query(&c, &q, &mut || Ok(())).unwrap();
        assert_eq!(first.total_count, expected);
        if decade == 2020 {
            q.offset = 2;
            assert_eq!(
                query(&c, &q, &mut || Ok(())).unwrap().items[0].release_year,
                Some(2100)
            );
        }
        q.curated_only = true;
        q.offset = 0;
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
    }
    let before = current(&c).unwrap();
    assert!(progress(
        &c,
        &ProgressQuery {
            schema_version: 1,
            request_id: "fixture".into(),
            query: "".into(),
            year: Some(2024),
            decade: Some(2020)
        }
    )
    .is_err());
    assert_eq!(current(&c).unwrap(), before);
}
#[test]
fn archive_type_filter_controls_titles_pending_and_atomic_new_visible_yield() {
    let mut c = database();
    let mut item = language_title("new", "Gilligan", &["eng"], 1);
    item.search_aliases = encode_search_metadata(&SearchMetadata {
        title: "Gilligan".into(),
        subjects: "Classic TV".into(),
        ..Default::default()
    })
    .unwrap();
    item.partial = Some(page(64, None));
    item.files[0].provider_index = Some(0);
    item.files[1].provider_index = Some(1);
    let view = DiscoveryView {
        content_type: ContentType::Movie,
        ..discovery_view(LanguageMode::All)
    };
    let receipt = commit_view(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![item]),
        Some(("Gilligan", None, &view)),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(receipt.new_visible_matches, Some(0));
    for (filter, expected) in [
        (ContentType::Tv, 1),
        (ContentType::Movie, 0),
        (ContentType::Unknown, 0),
        (ContentType::All, 1),
    ] {
        let mut q = search_query("Gilligan", "1");
        q.content_type = filter;
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, expected);
        let pending = FileProgressQuery {
            schema_version: 1,
            request_id: "fixture".into(),
            expected_revision: Some("1".into()),
            offset: 0,
            page_size: 50,
            query: "Gilligan".into(),
            decade: None,
            favorites_only: false,
            language_mode: LanguageMode::All,
            content_type: filter,
        };
        assert_eq!(
            item_progress(&c, &pending, &mut || Ok(()))
                .unwrap()
                .total_count,
            expected
        );
    }
}
#[test]
fn archive_artwork_source_legacy_null_and_versioned_actual_proof_preserve_authority() {
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
        step(vec![title("legacy", None, 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    let reference = opaque(&["archive-item-v1", "legacy"]);
    assert_eq!(artwork_source(&c, &reference, "1").unwrap().0, "legacy");
    assert!(artwork_source(&c, &reference, "1").unwrap().1.is_none());
    assert!(artwork_source(&c, &reference, "0").is_err());
    let image = Artwork {
        item_id: "legacy".into(),
        file_name: "__ia_thumb.jpg".into(),
        size_bytes: "1330".into(),
        mime_type: "image/jpeg".into(),
        provider_sha1: None,
    };
    let metadata = SearchMetadata {
        artwork: Some(image.clone()),
        ..Default::default()
    };
    let encoded = encode_search_metadata(&metadata).unwrap();
    assert!(encoded.starts_with("@genx-search-v3:"));
    c.execute(
        "UPDATE archive_title_v1 SET search_text=?1 WHERE item_id='legacy'",
        [encoded],
    )
    .unwrap();
    assert!(artwork_source(&c, &reference, "1").unwrap().1 == Some(image));
    let legacy="@genx-search-v2:{\"title\":\"Legacy\",\"series\":\"\",\"subjects\":\"\",\"collections\":\"\",\"description\":\"\",\"languages\":[]}";
    assert!(decode_search_metadata(legacy)
        .unwrap()
        .unwrap()
        .artwork
        .is_none());
    let bad = SearchMetadata {
        artwork: Some(Artwork {
            item_id: "legacy".into(),
            file_name: "../../secret".into(),
            size_bytes: "1".into(),
            mime_type: "image/jpeg".into(),
            provider_sha1: None,
        }),
        ..Default::default()
    };
    assert!(encode_search_metadata(&bad).is_err());
}
#[test]
fn archive_relevance_v9_legacy_pet_keeps_saved_records_but_not_incidental_name_results() {
    let observed: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/archive-search-metadata/Humane_Society_of_St._Lucie_County_Adopt-a-Pet_-_Gilligan.json"
        ))
        .unwrap();
    let mut legacy = title("legacy-pet", Some(2014), 99);
    legacy.title = observed["metadata"]["title"].as_str().unwrap().into();
    // Old mixed aliases cannot establish any typed subject/language claim.
    legacy.search_aliases = "Gilligan cartoon eng television".into();
    let mut c = database();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "Gilligan",
            restart: false,
        },
        step(vec![
            legacy,
            language_title("show", "Gilligan's Island", &["eng"], 1),
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    let reference = opaque(&["archive-item-v1", "legacy-pet"]);
    set_favorite(
        &mut c,
        &FavoriteRequest {
            schema_version: 1,
            request_id: "favorite".into(),
            title_ref: reference.clone(),
            expected_revision: "1".into(),
            value: true,
        },
        &mut || Ok(()),
    )
    .unwrap();
    let changes = c.total_changes();
    let p = query(&c, &search_query("Gilligan", "2"), &mut || Ok(())).unwrap();
    assert_eq!(refs(&p), vec![opaque(&["archive-item-v1", "show"])]);
    let blank = query(&c, &search_query("", "2"), &mut || Ok(())).unwrap();
    assert_eq!(blank.total_count, 2);
    let mut favorites = search_query("", "2");
    favorites.favorites_only = true;
    assert_eq!(
        refs(&query(&c, &favorites, &mut || Ok(())).unwrap()),
        vec![reference.clone()]
    );
    assert_eq!(
        refs(
            &query(&c, &search_query("Adopt a Pet Gilligan", "2"), &mut || Ok(
                ()
            ))
            .unwrap()
        ),
        vec![reference]
    );
    assert_eq!(changes, c.total_changes());
    assert_eq!(current(&c).unwrap(), 2);
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_file_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        4
    );
}
#[test]
fn archive_relevance_v9_equivalent_title_spellings_share_language_tier_before_paging() {
    let mut c = database();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "Gilligan Island",
            restart: false,
        },
        step(vec![
            language_title("spanish", "Gilligan Island", &["spa"], 1000),
            language_title("english-possessive", "Gilligan's Island", &["eng"], 1),
            language_title("english-plural", "Gilligans Island", &["English"], 2),
            language_title(
                "english-unicode",
                "Ｇｉｌｌｉｇａｎ’s　Ｉｓｌａｎｄ",
                &["en-US"],
                3,
            ),
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    let mut q = search_query("Gilligan Island", "1");
    q.language_mode = LanguageMode::EnglishFirst;
    q.page_size = 1;
    let mut items = Vec::new();
    for offset in 0..4 {
        q.offset = offset;
        let p = query(&c, &q, &mut || Ok(())).unwrap();
        assert_eq!(p.total_count, 4);
        items.push(p.items.into_iter().next().unwrap());
    }
    assert!(items[..3]
        .iter()
        .all(|t| provider_language_rank(&t.provider_languages) == 0));
    assert_eq!(items[3].title_ref, opaque(&["archive-item-v1", "spanish"]));
    q.offset = 0;
    q.page_size = 50;
    q.language_mode = LanguageMode::English;
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 3);
    q.language_mode = LanguageMode::All;
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 4);
}
#[test]
fn archive_relevance_v9_public_and_legacy_predicates_keep_exact_named_context_choices() {
    use crate::archive_provider_contract::{Provider, ProviderItem};
    for (title, query, expected) in [
        ("Adopt-a-Pet: Gilligan", "Gilligan", None),
        (
            "Adopt-a-Pet: Gilligan",
            "Adopt a Pet Gilligan",
            Some("title"),
        ),
        ("Interview with Vince Gilligan", "Gilligan", None),
        (
            "Interview with Vince Gilligan",
            "Vince Gilligan",
            Some("title"),
        ),
        ("Gilligan's Island", "Gilligan Island", Some("title")),
        ("Gilliganville Island", "Gilligan Island", None),
    ] {
        let i = ProviderItem {
            provider: Provider::Loc,
            item_id: "fixture".into(),
            title: title.into(),
            source_url: "https://www.loc.gov/item/fixture/".into(),
            metadata_url: "https://www.loc.gov/item/fixture/?fo=json".into(),
            description: None,
            subjects: vec![],
            creators: vec![],
            languages: vec![],
            release_year: None,
            date_claims: None,
            content_type: "unknown".into(),
            rights: None,
            license_url: None,
            attribution: None,
            access_restricted: None,
            download_allowed: None,
            revision: None,
            variants: vec![],
        };
        assert_eq!(
            match_basis(title, "untrusted mixed cartoon English", "", query).unwrap(),
            expected,
            "legacy {query}: {title}"
        );
        assert_eq!(
            crate::archive_provider_catalog::matches(&i, query).unwrap(),
            expected,
            "public {query}: {title}"
        );
    }
}
#[test]
fn archive_relevance_v9_search_scope_does_not_reuse_old_discovery_continuation() {
    assert_ne!(
        search_scope_hash("Gilligan", None),
        opaque(&["archive-query-fields-v8", "Gilligan", ""])
    );
}
#[test]
fn archive_relevance_v9_word_boundaries_and_bounded_aliases_never_become_substring_stemming() {
    for title in [
        "Gilligan's Island",
        "Gilligans Island",
        "Ｇｉｌｌｉｇａｎ’s　Ｉｓｌａｎｄ",
        "Gilligan — Island",
    ] {
        for query in ["Gilligan Island", "Gilligan's Island", "Gilligans Island"] {
            assert_eq!(match_basis(title, "", "", query).unwrap(), Some("title"));
            assert_eq!(title_match_rank(title, query), 0, "{title}: {query}");
        }
    }
    for (title, query) in [
        ("Gilliganville Island", "Gilligan Island"),
        ("New", "News"),
        ("Mar", "Mars"),
        ("Bas", "Bass"),
        ("Time", "Timer"),
    ] {
        assert_eq!(
            match_basis(title, "", "", query).unwrap(),
            None,
            "{title}: {query}"
        );
    }
    assert_eq!(
        title_match_rank("Gilligan Island Remastered", "Gilligan Island"),
        1
    );
    assert_eq!(
        title_match_rank("Restored Gilligan Island Feature", "Gilligan Island"),
        2
    );
    assert_eq!(title_match_rank("Island of Gilligan", "Gilligan Island"), 3);
}
#[test]
fn archive_relevance_v9_pending_legacy_titles_share_matching_and_preserve_read_cas_cancel() {
    let mut c = database();
    let mut pet = title("pet", None, 100);
    pet.title = "Adopt-a-Pet: Gilligan".into();
    pet.search_aliases = "old mixed Gilligan eng tv".into();
    pet.partial = Some(page(64, None));
    let mut show = title("show", None, 1);
    show.title = "Gilligan's Island".into();
    show.search_aliases = "untrusted flat descriptions".into();
    show.partial = Some(page(64, None));
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "Gilligan",
            restart: false,
        },
        step(vec![pet, show]),
        &mut || Ok(()),
    )
    .unwrap();
    let mut q = FileProgressQuery {
        schema_version: 1,
        request_id: "pending".into(),
        expected_revision: Some("1".into()),
        offset: 0,
        page_size: 50,
        query: "Gilligan Island".into(),
        decade: None,
        favorites_only: false,
        language_mode: LanguageMode::All,
        content_type: ContentType::All,
    };
    let changes = c.total_changes();
    let p = item_progress(&c, &q, &mut || Ok(())).unwrap();
    assert_eq!(p.total_count, 1);
    assert_eq!(p.items[0].title_ref, opaque(&["archive-item-v1", "show"]));
    q.query = "Gilligan".into();
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
        1
    );
    q.query = "Adopt a Pet Gilligan".into();
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
        1
    );
    q.expected_revision = Some("0".into());
    assert!(matches!(item_progress(&c,&q,&mut||Ok(())),Err(e) if e=="archive-revision-stale"));
    q.expected_revision = Some("1".into());
    assert!(
        matches!(item_progress(&c,&q,&mut||Err("fixture-cancel".into())),Err(e) if e=="fixture-cancel")
    );
    assert_eq!(changes, c.total_changes());
    assert_eq!(current(&c).unwrap(), 1);
}
