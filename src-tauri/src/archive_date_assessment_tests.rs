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

// Runs inside archive_catalog::tests to exercise the existing real query/Store paths.
fn expected_date_assessment(year: Option<i64>) -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "providerListedYear": year,
        "originalReleaseYear": null,
        "status": if year.is_some() { "unverified-item-date" } else { "unknown" },
        "provenance": "legacy-item-year",
        "field": "unknown"
    })
}

#[test]
fn archive_date_assessment_projects_only_existing_item_year_without_inference() {
    let mut c = database();
    let cases = [
        ("listed", Some(2020)),
        ("broadcast", Some(2019)),
        ("unknown", None),
    ];
    let entries = cases
        .iter()
        .map(|(id, year)| {
            let mut item = title(id, *year, 1);
            item.title = format!("{id} Broadcast 1978 Season 1");
            item.search_aliases = item.title.clone();
            item.files[0].file_title = Some("Episode 1967 restored 2024".into());
            item
        })
        .collect();
    commit(&mut c, "0", SearchPage { year: None, page: 1, query_hash: "query", restart: false }, step(entries), &mut || Ok(()))
    .unwrap();
    let changes = c.total_changes();
    let page = query(&c, &search_query("", "1"), &mut || Ok(())).unwrap();
    assert_eq!(page.items.len(), 3);
    for (id, year) in cases {
        let row = page
            .items
            .iter()
            .find(|t| t.title_ref == opaque(&["archive-item-v1", id]))
            .unwrap();
        let wire = serde_json::to_value(row).unwrap();
        assert_eq!(wire["dateAssessment"], expected_date_assessment(year));
        assert_eq!(wire["releaseYear"], serde_json::json!(year));
        assert_eq!(wire["titleProvenance"], "provider-item");
    }
    assert_eq!(c.total_changes(), changes);
    assert_eq!(current(&c).unwrap(), 1);
}

#[test]
fn archive_date_assessment_preserves_stale_revision_and_cancellation_refusal() {
    let mut c = database();
    commit(&mut c, "0", SearchPage { year: None, page: 1, query_hash: "query", restart: false }, step(vec![title("listed", Some(2020), 1)]), &mut || Ok(()))
    .unwrap();
    let changes = c.total_changes();
    assert!(matches!(query(&c, &search_query("", "0"), &mut || Ok(())),
        Err(e) if e == "archive-revision-stale"));
    assert!(
        matches!(query(&c, &search_query("", "1"), &mut || Err("date-fixture-cancel".into())),
        Err(e) if e == "date-fixture-cancel")
    );
    let page = query(&c, &search_query("", "1"), &mut || Ok(())).unwrap();
    assert_eq!(
        serde_json::to_value(&page.items[0]).unwrap()["dateAssessment"],
        expected_date_assessment(Some(2020))
    );
    assert_eq!(current(&c).unwrap(), 1);
    assert_eq!(c.total_changes(), changes);
}

#[test]
fn archive_date_assessment_real_store_reads_and_reopen_preserve_all_authority_bytes() {
    use crate::{archive_library_store as library, storage::Store, storage_transaction::PairStore};
    use std::{collections::BTreeMap, fs, path::Path};
    fn bytes(root: &Path) -> BTreeMap<&'static str, Vec<u8>> {
        [
            "genx.sqlite3",
            "genx.sqlite3.backup",
            "archive-library-v1/archive.sqlite3",
            "archive-library-v1/archive.sqlite3.backup",
            "archive-authority-v1",
        ]
        .into_iter()
        .map(|p| (p, fs::read(root.join(p)).unwrap()))
        .collect()
    }
    let root = tempfile::tempdir().unwrap();
    let pair = PairStore::new(root.path().into()).unwrap();
    let title_ref = opaque(&["archive-item-v1", "listed"]);
    let file_ref = opaque(&["archive-file-v1", "listed", "one.mp4"]);
    pair.with_guide_write(|c| {
        commit(c, "0", SearchPage { year: None, page: 1, query_hash: "query", restart: false }, step(vec![title("listed", Some(2020), 1), title("unknown", None, 2)]), &mut || Ok(()))?;
        sql(c.execute(
            "INSERT INTO archive_preferences_v1 VALUES(?1,'listed','Favorite retained',2020,1)",
            [&title_ref],
        ))?;
        sql(c.execute(
            "INSERT INTO archive_preferences_v1 VALUES(?1,'orphan','Orphan retained',NULL,1)",
            [opaque(&["archive-item-v1", "orphan"])],
        ))?;
        sql(c.execute(
            "INSERT INTO archive_bookmark_v1 VALUES(?1,'listed','one.mp4','100',?2,14013,60000,0,1234)",
            params![file_ref, "a".repeat(40)],
        ))?;
        sql(c.execute_batch("UPDATE archive_catalog_meta_v1 SET revision=7;UPDATE archive_bookmark_meta_v1 SET revision=2;"))?;
        Ok(())
    })
    .unwrap();
    let legacy_fingerprint = pair
        .with_guide_read(|c| library::source_fingerprint(c, &mut || Ok(())))
        .unwrap();
    drop(pair);
    // Handoff is allowed to write; the read-only baseline starts after the real Store has opened.
    let mut store = Some(Store::new(root.path().into(), "date-assessment-fixture".into()).unwrap());
    let before = bytes(root.path());
    for pass in 0..2 {
        let read = |store: &Store| {
            store.with_archive_read(|c| {
                let fingerprint = library::source_fingerprint(c, &mut || Ok(()))?;
                assert_eq!(fingerprint, legacy_fingerprint);
                assert_eq!(current(c)?, 7);
                assert_eq!(
                    sql(
                        c.query_row("SELECT revision FROM archive_bookmark_meta_v1", [], |r| r
                            .get::<_, i64>(
                            0
                        ))
                    )?,
                    2
                );
                let page = query(c, &search_query("", "7"), &mut || Ok(()))?;
                assert_eq!(page.items.len(), 2);
                assert_eq!(page.items[0].title_ref, title_ref);
                assert!(page.items[0].favorite);
                assert_eq!(
                    serde_json::to_value(&page.items[0]).unwrap()["dateAssessment"],
                    expected_date_assessment(Some(2020))
                );
                assert_eq!(
                    serde_json::to_value(&page.items[1]).unwrap()["dateAssessment"],
                    expected_date_assessment(None)
                );
                let files = files(
                    c,
                    &FilesQuery {
                        schema_version: 1,
                        request_id: "date-fixture".into(),
                        title_ref: title_ref.clone(),
                        expected_revision: "7".into(),
                        offset: 0,
                        page_size: 50,
                    },
                    &mut || Ok(()),
                )?;
                assert_eq!(
                    files
                        .files
                        .iter()
                        .map(|f| f.file_name.as_str())
                        .collect::<Vec<_>>(),
                    ["one.mp4", "two.mp4"]
                );
                assert_eq!(files.files[0].file_ref, file_ref);
                assert_eq!(
                    sql(c.query_row(
                        "SELECT position_ms FROM archive_bookmark_v1 WHERE file_ref=?1",
                        [&file_ref],
                        |r| { r.get::<_, i64>(0) }
                    ))?,
                    14013
                );
                Ok(())
            })
        };
        if pass == 0 {
            read(store.as_ref().unwrap()).unwrap();
            drop(store.take());
        } else {
            let reopened =
                Store::new(root.path().into(), "date-assessment-fixture".into()).unwrap();
            read(&reopened).unwrap();
            drop(reopened);
        }
        let after = bytes(root.path());
        for (path, data) in &before {
            assert!(after[path] == *data, "read-only bytes changed: {path}");
        }
    }
    drop(store);
    assert!(
        bytes(root.path()) == before,
        "closing Store changed authority bytes"
    );
}
