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
use serde_json::json;
fn metadata() -> Value {
    json!({"metadata":{"identifier":"fixture","title":"Provider program","mediatype":"movies","collection":["classic_tv"],"date":"1964-01-01"},"files_count":2,"files":[{"name":"one.mp4","format":"h.264","size":"100","original":"one.mpg"},{"name":"two.mp4","format":"h.264","size":"200","original":"two.mpg"}],"d1":"ia800000.us.archive.org"})
}
#[test]
fn archive_metadata_episodes_are_one_exact_item_title() {
    let Metadata::Title(t) = parse_metadata("fixture", 50, metadata(), Some(1964)).unwrap() else {
        panic!("fixture refused")
    };
    assert_eq!(t.item_id, "fixture");
    assert_eq!(t.files.len(), 2);
    assert_eq!(t.year, Some(1964));
}
#[test]
fn archive_partial_metadata_large_declared_count_is_positive_only() {
    let mut v = metadata();
    v["files_count"] = json!(5000);
    assert!(matches!(parse_metadata("fixture",1,v.clone(),None),Err(e) if e=="archive-file-limit"));
    let p = catalog::PreparedPage {
        provider_count: 5000,
        next_offset: 66,
        fingerprint: "a".repeat(64),
        scanned_bytes: 1000,
        curation_year: None,
        expected_offset: None,
        expected_fingerprint: None,
        capacity: false,
    };
    let Metadata::Title(t) = parse_metadata_page("fixture", 1, v, None, Some(p), 64).unwrap()
    else {
        panic!("partial refused");
    };
    assert_eq!(t.files[0].provider_index, Some(64));
    assert_eq!(t.files[1].provider_index, Some(65));
    assert_eq!(t.partial.unwrap().provider_count, 5000);
}
#[test]
fn archive_partial_header_refuses_identity_version_and_host_changes() {
    let mut values = vec![
        metadata()["metadata"].clone(),
        json!(5000),
        json!(1000.5),
        json!(["ia800000.us.archive.org"]),
    ];
    let first = parse_partial_header("fixture", &values).unwrap();
    assert_eq!(first.count, 5000);
    values[2] = json!(1001.5);
    assert_ne!(
        first.fingerprint,
        parse_partial_header("fixture", &values)
            .unwrap()
            .fingerprint
    );
    values[0]["identifier"] = json!("different");
    assert!(parse_partial_header("fixture", &values).is_err());
    values[0] = metadata()["metadata"].clone();
    values[3] = json!(["127.0.0.1"]);
    assert!(parse_partial_header("fixture", &values).is_err());
    values[3] = json!(["ia800000.us.archive.org"]);
    values[1] = json!(100001);
    assert!(parse_partial_header("fixture", &values).is_err());
    assert!(extended_deleted(&json!({"errcode":106,"result":metadata()})).is_err());
}
#[test]
fn playback_route_uses_only_fresh_listed_host_and_exact_item_directory() {
    let document = json!({"d1":"dn720001.ca.archive.org","d2":"dn720002.ca.archive.org","dir":"/12/items/fixture"});
    let route = media_route("fixture", "episodes/exact file#1.mp4", &document).unwrap();
    assert_eq!(
        route.url.as_str(),
        "https://dn720001.ca.archive.org/12/items/fixture/episodes/exact%20file%231.mp4"
    );
    assert_eq!(route.tail, "fixture/episodes/exact%20file%231.mp4");
    assert_eq!(
        route.hosts,
        vec![
            "dn720001.ca.archive.org",
            "dn720002.ca.archive.org",
            "archive.org"
        ]
    );
    assert!(route.url.query().is_none() && route.url.fragment().is_none());
    let fallback = media_route(
        "fixture",
        "one.mp4",
        &json!({"d1":"ia800000.us.archive.org"}),
    )
    .unwrap();
    assert_eq!(
        fallback.url.as_str(),
        "https://archive.org/download/fixture/one.mp4"
    );
    for dir in [
        "",
        "/items/other",
        "/12345/items/fixture",
        "/1/items/fixture/../other",
        "/items/fixture?private=secret",
        "https://archive.org/items/fixture",
        "/items/fixture//",
    ] {
        let error = media_route(
            "fixture",
            "one.mp4",
            &json!({"d1":"dn720001.ca.archive.org","dir":dir}),
        )
        .err()
        .unwrap();
        assert_eq!(error, "archive-file-route-unverified");
        assert!(!error.contains("secret"));
    }
    for host in [
        "dn720001.ca.archive.org.evil.invalid",
        "dninvalid.ca.archive.org",
        "127.0.0.1",
        "private:secret@dn720001.ca.archive.org",
    ] {
        assert!(media_route(
            "fixture",
            "one.mp4",
            &json!({"d1":host,"dir":"/items/fixture"})
        )
        .is_err());
    }
}
#[test]
fn partial_playback_header_binds_directory_in_before_after_fingerprint_without_changing_legacy_header(
) {
    let mut values = vec![
        metadata()["metadata"].clone(),
        json!(5000),
        json!(1000.5),
        json!(["dn720001.ca.archive.org"]),
        json!("/12/items/fixture"),
    ];
    let first = parse_partial_header("fixture", &values).unwrap();
    assert_eq!(first.document["dir"], json!("/12/items/fixture"));
    values[4] = json!("/13/items/fixture");
    assert_ne!(
        first.fingerprint,
        parse_partial_header("fixture", &values)
            .unwrap()
            .fingerprint
    );
    values[4] = json!("/13/items/other");
    assert!(parse_partial_header("fixture", &values).is_err());
    values[4] = Value::Null;
    assert_eq!(
        parse_partial_header("fixture", &values)
            .unwrap()
            .fingerprint,
        parse_partial_header("fixture", &values[..4])
            .unwrap()
            .fingerprint
    );
}
#[test]
fn archive_metadata_upload_date_never_establishes_release_year() {
    let mut v = metadata();
    v["metadata"].as_object_mut().unwrap().remove("date");
    v["metadata"]["publicdate"] = json!("1964-01-01");
    assert!(matches!(
        parse_metadata("fixture", 1, v.clone(), Some(1964)).unwrap(),
        Metadata::UnknownYear
    ));
    let Metadata::Title(t) = parse_metadata("fixture", 1, v, None).unwrap() else {
        panic!("explicit search refused")
    };
    assert_eq!(t.year, None);
}
#[test]
fn archive_metadata_alternative_encodes_do_not_establish_a_multi_episode_program() {
    let mut v = metadata();
    v["files"][1]["original"] = json!("one.mpg");
    assert!(matches!(
        parse_metadata("fixture", 1, v, Some(1964)).unwrap(),
        Metadata::Unavailable
    ));
}
#[test]
fn archive_metadata_absent_or_restricted_is_not_confirmed_dead() {
    assert!(matches!(
        parse_metadata("fixture", 1, json!([]), None).unwrap(),
        Metadata::Unavailable
    ));
    let mut v = metadata();
    v["metadata"]["access-restricted-item"] = json!(true);
    assert!(matches!(
        parse_metadata("fixture", 1, v, None).unwrap(),
        Metadata::Unavailable
    ));
    assert!(matches!(
        parse_metadata("fixture", 1, json!({"errcode":104}), None).unwrap(),
        Metadata::Deleted
    ));
}
#[test]
fn archive_metadata_extension_alone_is_not_h264_admission() {
    let mut v = metadata();
    v["files"][0]["format"] = json!("MPEG4");
    v["files"][1]["format"] = json!("MPEG4");
    let Metadata::Title(t) = parse_metadata("fixture", 1, v, None).unwrap() else {
        panic!("fixture refused")
    };
    assert!(t.files.is_empty());
}
#[test]
fn archive_metadata_extended_errors_cannot_prove_file_absence() {
    for code in [
        json!(101),
        json!(102),
        json!(103),
        json!(105),
        json!(106),
        json!(400),
        json!(999),
        json!("104"),
        json!(-1),
        json!(null),
    ] {
        let mut v = metadata();
        v["errcode"] = code;
        v["files"] = json!([]);
        v["files_count"] = json!(0);
        assert!(
            matches!(parse_metadata("fixture",1,v,None), Err(e) if e == "archive-metadata-unavailable")
        );
    }
    let mut v = metadata();
    v["error"] = json!("provider error must not be reflected");
    assert!(parse_metadata("fixture", 1, v, None).is_err());
    let mut v = metadata();
    v["errcode"] = json!(0);
    assert!(matches!(
        parse_metadata("fixture", 1, v, None).unwrap(),
        Metadata::Title(_)
    ));
}
#[test]
fn archive_duration_colon_values_are_bounded_without_inference() {
    for (value, seconds) in [("01:02:03.5", 3723.5), ("62:03", 3723.0), ("3.5", 3.5)] {
        assert_eq!(duration(&json!({"length":value})), Some(seconds));
    }
    for value in [
        "1:60:00",
        "1:02:60",
        "-1:00",
        "1:NaN",
        "1:2:3:4",
        "168:00:01",
        "+1:00",
        "1e2:00",
    ] {
        assert_eq!(duration(&json!({"length":value})), None);
    }
    assert_eq!(duration(&json!({"length":0})), None);
}
#[test]
fn archive_metadata_search_aliases_preserve_provider_fields_only() {
    let mut v = metadata();
    v["metadata"]["subject"] = json!(["Monster movies", "Cartoons"]);
    v["files"][0]["title"] = json!("Pilot episode");
    let Metadata::Title(t) = parse_metadata("fixture", 1, v, None).unwrap() else {
        panic!("fixture refused")
    };
    assert!(t.search_aliases.contains("Monster movies"));
    assert!(t.search_aliases.contains("classic_tv"));
    assert_eq!(t.files[0].file_title.as_deref(), Some("Pilot episode"));
    assert_eq!(t.item_id, "fixture");
    let mut aliases = String::new();
    assert!(append_search_aliases(&mut aliases, &json!(["x".repeat(2049)])).is_err());
}
#[test]
fn archive_provider_query_is_literal_and_broad_without_year_on_explicit_search() {
    let r = StepRequest {
        schema_version: 1,
        request_id: "fixture".into(),
        expected_revision: "0".into(),
        year: None,
        decade: None,
        page: 1,
        query: "monster OR title:\"x\"".into(),
        explicit_action: true,
        restart: false,
        view: None,
    };
    let q = provider_query(&r);
    assert!(q.contains("title:((\"monster\" OR \"monsters\" OR \"monster's\") AND \"OR\""));
    assert!(!q.contains("subject:("));
    assert!(q.contains("series:("));
    assert!(!q.contains("collection:("));
    assert!(!q.contains("description:("));
    assert!(q.contains("^8"));
    assert!(q.contains("\\\"x\\\""));
    assert!(!q.contains("date:["));
}
#[test]
fn archive_provider_cartoon_query_excludes_only_generic_animation_subject_branch() {
    let r = StepRequest {
        schema_version: 1,
        request_id: "fixture".into(),
        expected_revision: "0".into(),
        year: None,
        decade: None,
        page: 1,
        query: "Cartoon".into(),
        explicit_action: true,
        restart: false,
        view: None,
    };
    let q = provider_query(&r);
    assert!(q.contains("title:((cartoon OR cartoons OR animation OR animated))"));
    assert!(q.contains("subject:(cartoon OR cartoons OR animated)"));
    assert!(q.contains("(subject:animation AND NOT subject:\"Film & Animation\")"));
    assert!(!q.contains("description:"));
}
#[test]
fn archive_discovery_decade_has_one_range_and_authoritative_year_guard() {
    let mut r = StepRequest {
        schema_version: 1,
        request_id: "fixture".into(),
        expected_revision: "0".into(),
        year: None,
        decade: Some(1960),
        page: 1,
        query: "monster".into(),
        explicit_action: true,
        restart: false,
        view: None,
    };
    validate(&r).unwrap();
    assert!(provider_query(&r).contains("date:[1960-01-01T00:00:00Z TO 1969-12-31T23:59:59Z]"));
    assert!(matches!(
        filter_decade(
            parse_metadata("fixture", 1, metadata(), None).unwrap(),
            r.decade
        ),
        Metadata::Title(_)
    ));
    let mut outside = metadata();
    outside["metadata"]["date"] = json!("1970-01-01");
    assert!(matches!(
        filter_decade(
            parse_metadata("fixture", 1, outside, None).unwrap(),
            r.decade
        ),
        Metadata::UnknownYear
    ));
    let mut unknown = metadata();
    unknown["metadata"].as_object_mut().unwrap().remove("date");
    assert!(matches!(
        filter_decade(
            parse_metadata("fixture", 1, unknown, None).unwrap(),
            r.decade
        ),
        Metadata::UnknownYear
    ));
    assert_ne!(
        catalog::search_scope_hash("monster", Some(1960)),
        catalog::search_scope_hash("monster", Some(1970))
    );
    r.year = Some(1970);
    assert!(validate(&r).is_err());
    r.year = Some(1964);
    validate(&r).unwrap();
    r.year = None;
    r.query.clear();
    assert!(validate(&r).is_err());
}
#[test]
fn archive_observed_h264_ia_is_admitted_by_full_and_fresh_partial_metadata_parser() {
    let value: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/archive-search-metadata/thenewadventuresofgilligans1.json"
    ))
    .unwrap();
    let Metadata::Title(title) =
        parse_metadata("thenewadventuresofgilligans1", 1, value.clone(), None).unwrap()
    else {
        panic!("observed metadata refused")
    };
    assert_eq!(title.files.len(), 16);
    let selected = &title.files[0];
    assert!(selected.name.ends_with(".ia.mp4"));
    let index = value["files"]
        .as_array()
        .unwrap()
        .iter()
        .position(|file| file["name"] == selected.name)
        .unwrap();
    let mut fresh = value.clone();
    fresh["files"] = serde_json::json!([value["files"][index].clone()]);
    let page = catalog::PreparedPage {
        provider_count: value["files"].as_array().unwrap().len() as u32,
        next_offset: index as u32 + 1,
        fingerprint: "a".repeat(64),
        scanned_bytes: 1000,
        curation_year: None,
        expected_offset: None,
        expected_fingerprint: None,
        capacity: false,
    };
    let Metadata::Title(proof) = parse_metadata_page(
        "thenewadventuresofgilligans1",
        1,
        fresh.clone(),
        None,
        Some(page.clone()),
        index as u32,
    )
    .unwrap() else {
        panic!("fresh partial proof refused")
    };
    assert_eq!(proof.files[0].name, selected.name);
    assert_eq!(proof.files[0].size, selected.size);
    assert_eq!(proof.files[0].sha1, selected.sha1);
    fresh["files"][0]["format"] = serde_json::json!("MPEG4");
    let Metadata::Title(refused) = parse_metadata_page(
        "thenewadventuresofgilligans1",
        1,
        fresh,
        None,
        Some(page),
        index as u32,
    )
    .unwrap() else {
        panic!("metadata unavailable")
    };
    assert!(
        refused.files.is_empty(),
        "generic container cannot satisfy fresh selected codec proof"
    );
    for format in [
        "MPEG4",
        "h.264ish",
        "h.264 IA private",
        "512Kb MPEG4",
        "mp4",
    ] {
        assert!(!h264_format(format));
    }
}
#[test]
fn archive_observed_plain_h264_stays_available_and_legacy_containers_are_not_guessed() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/archive-search-metadata/The_Beverly_Hillbillies.json"
    ))
    .unwrap();
    let Metadata::Title(title) = parse_metadata("The_Beverly_Hillbillies", 1, data, None).unwrap()
    else {
        panic!("observed public metadata refused")
    };
    assert_eq!(title.files.len(), 3);
    let data: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/archive-search-metadata/Popeye_forPresident.json"
    ))
    .unwrap();
    let Metadata::Title(title) = parse_metadata("Popeye_forPresident", 1, data, None).unwrap()
    else {
        panic!("genre-positive metadata refused")
    };
    assert!(
        title.files.is_empty(),
        "genre evidence does not manufacture playable codecs"
    );
}
#[test]
fn archive_observed_curation_uses_same_tv_claim_as_local_type_and_retains_gilligan_season() {
    let single: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/archive-search-metadata/GilligansIsland1.00.json"
    ))
    .unwrap();
    let Metadata::Title(title) =
        parse_metadata("GilligansIsland1.00", 1, single.clone(), None).unwrap()
    else {
        panic!("explicit single episode refused")
    };
    assert_eq!(title.kind, "tv");
    assert_eq!(title.files.len(), 1);
    assert!(catalog::prepared_matches_query(&title, "Gilligan").unwrap());
    assert!(
        matches!(
            parse_metadata("GilligansIsland1.00", 1, single, Some(1963)).unwrap(),
            Metadata::Unavailable
        ),
        "one known TV episode cannot consume program slot"
    );
    let season: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/archive-search-metadata/thenewadventuresofgilligans1.json"
    ))
    .unwrap();
    let Metadata::Title(title) =
        parse_metadata("thenewadventuresofgilligans1", 1, season, Some(1974)).unwrap()
    else {
        panic!("genuine community season refused")
    };
    assert_eq!(title.kind, "tv");
    assert_eq!(title.files.len(), 16);
    assert!(catalog::prepared_matches_query(&title, "Gilligan").unwrap());
    assert!(catalog::prepared_matches_query(&title, "Cartoon").unwrap());
}
#[test]
fn archive_observed_discovery_reuses_query_contradictions_without_changing_codec_proof() {
    for (id, raw, query) in [
            ("mmtvnh-Merrimack_Middle_School_Band_-_Cartoon_Symphony_2023", include_str!("../../../tests/fixtures/archive-search-metadata/mmtvnh-Merrimack_Middle_School_Band_-_Cartoon_Symphony_2023.json"), "Cartoon"),
            ("gtv16nm-El_Camino_-_A_Breaking_Bad_Movie_An_Interview_with_Vince_Gilligan_from_the_KiMo_Theatre", include_str!("../../../tests/fixtures/archive-search-metadata/gtv16nm-El_Camino_-_A_Breaking_Bad_Movie_An_Interview_with_Vince_Gilligan_from_the_KiMo_Theatre.json"), "Gilligan"),
        ] {
            let Metadata::Title(title) = parse_metadata(id, 1, serde_json::from_str(raw).unwrap(), None).unwrap() else { panic!("actual metadata refused") };
            assert!(!catalog::prepared_matches_query(&title, query).unwrap());
            assert!(catalog::prepared_matches_query(&title, "").unwrap());
        }
    assert_ne!(
        catalog::search_scope_hash("Gilligan", None),
        catalog::opaque(&["archive-query-fields-v7", "Gilligan", ""])
    );
}
#[test]
fn archive_named_and_genre_queries_have_bounded_aliases_and_actual_stable_sort() {
    for query in ["Gilligan", "Cartoon", "Beverly Hillbillies"] {
        let request: StepRequest = serde_json::from_value(serde_json::json!({"schemaVersion":1,"requestId":"fixture","expectedRevision":"0","year":null,"page":1,"query":query,"explicitAction":true})).unwrap();
        validate(&request).unwrap();
        let url = search_url(&request).unwrap();
        let pairs: Vec<_> = url.query_pairs().collect();
        assert_eq!(
            pairs
                .iter()
                .filter(|(key, _)| key == "sort[]")
                .map(|(_, value)| value.as_ref())
                .collect::<Vec<_>>(),
            ["downloads desc", "identifier asc"]
        );
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "rows" && value == "20"));
        if query == "Gilligan" {
            assert!(provider_query(&request)
                .contains("(\"Gilligan\" OR \"Gilligans\" OR \"Gilligan's\")"));
        }
        if query == "Cartoon" {
            assert!(provider_query(&request).contains(
                "collection:(animationandcartoons OR classic_cartoons OR animation_unsorted)"
            ));
        }
    }
    assert_ne!(
        catalog::search_scope_hash("Gilligan", None),
        catalog::opaque(&["archive-query-fields-v5", "Gilligan", ""])
    );
}
#[test]
fn archive_discovery_view_is_optional_strict_and_versioned() {
    let old = serde_json::json!({"schemaVersion":1,"requestId":"fixture","expectedRevision":"0","year":null,"page":1,"query":"Gilligan","explicitAction":true});
    let legacy: StepRequest = serde_json::from_value(old.clone()).unwrap();
    assert!(legacy.view.is_none());
    for value in [
        serde_json::json!({"schemaVersion":2,"languageMode":"english","favoritesOnly":false,"curatedOnly":false}),
        serde_json::json!({"schemaVersion":1,"languageMode":"guess","favoritesOnly":false,"curatedOnly":false}),
    ] {
        let mut candidate = old.clone();
        candidate["view"] = value;
        if let Ok(request) = serde_json::from_value::<StepRequest>(candidate) {
            assert!(validate(&request).is_err());
        }
    }
}
#[test]
fn archive_observed_item_tile_is_listed_not_synthesized_or_a_video_frame() {
    let document: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/archive-search-metadata/thenewadventuresofgilligans1.json"
    ))
    .unwrap();
    let image = listed_artwork(
        "thenewadventuresofgilligans1",
        document["files"].as_array().unwrap(),
    )
    .unwrap();
    assert_eq!(image.file_name, "__ia_thumb.jpg");
    assert_eq!(image.size_bytes, "7326");
    let Metadata::Title(title) =
        parse_metadata("thenewadventuresofgilligans1", 1, document, None).unwrap()
    else {
        panic!("observed fixture")
    };
    assert!(title.search_aliases.contains("__ia_thumb.jpg"));
    for patch in [
        serde_json::json!({"name":"episode0001.jpg","format":"JPEG","size":"100"}),
        serde_json::json!({"name":"__ia_thumb.jpg","format":"Item Tile","size":"524289"}),
        serde_json::json!({"name":"__ia_thumb.jpg","format":"Item Tile","size":"100","private":"true"}),
    ] {
        assert!(listed_artwork("fixture", &[patch]).is_none());
    }
}
#[test]
fn archive_modern_provider_decade_uses_original_2020_plus_cap_not_upload_year() {
    let request:StepRequest=serde_json::from_value(serde_json::json!({"schemaVersion":1,"requestId":"fixture","expectedRevision":"0","year":null,"decade":2020,"page":1,"query":"Cartoon","explicitAction":true})).unwrap();
    validate(&request).unwrap();
    assert!(
        provider_query(&request).contains("date:[2020-01-01T00:00:00Z TO 2100-12-31T23:59:59Z]")
    );
    assert!(!provider_query(&request).contains("addeddate"));
    let mut document = metadata();
    document["metadata"]["date"] = serde_json::json!("2035-01-01");
    assert!(matches!(
        filter_decade(
            parse_metadata("fixture", 1, document, None).unwrap(),
            Some(2020)
        ),
        Metadata::Title(_)
    ));
}
#[test]
fn archive_relevance_v9_fresh_metadata_uses_the_same_possessive_word_predicate_without_new_admission(
) {
    let mut v = metadata();
    v["metadata"]["title"] = json!("Gilligan's Island");
    let Metadata::Title(title) = parse_metadata("fixture", 1, v, None).unwrap() else {
        panic!("fixture metadata refused")
    };
    assert_eq!(title.files.len(), 2);
    for query in ["Gilligan Island", "Gilligans Island", "Gilligan’s Island"] {
        assert!(catalog::prepared_matches_query(&title, query).unwrap());
    }
    assert!(!catalog::prepared_matches_query(&title, "Gilliganville Island").unwrap());
    let mut v = metadata();
    v["metadata"]["title"] = json!("Gilligan's Island");
    v["files"][0]["format"] = json!("MPEG4");
    let Metadata::Title(title) = parse_metadata("fixture", 1, v, None).unwrap() else {
        panic!("fixture metadata refused")
    };
    assert_eq!(
        title.files.len(),
        1,
        "generic MPEG4 remains outside this admission slice"
    );
}
