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

//! Archive catalog tests: relevance version 9.

use super::*;

#[test]
fn archive_relevance_v9_legacy_pet_keeps_saved_records_but_not_incidental_name_results() {
    let observed: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/archive-search-metadata/Humane_Society_of_St._Lucie_County_Adopt-a-Pet_-_Gilligan.json"
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
