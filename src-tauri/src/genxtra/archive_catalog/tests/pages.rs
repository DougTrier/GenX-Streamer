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

//! Archive catalog tests: file labels, partial and pending pages, curation
//! and explicit search.

use super::*;

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
