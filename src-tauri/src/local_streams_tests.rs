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

//! Controlled fixtures shaped like real Wikidata and Radio Browser replies
//! (309 / Peoria, October 17, 2026). No network.
use super::*;
use serde_json::json;

fn row(fields: &[(&str, &str)]) -> Value {
    Value::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), json!({ "value": v })))
            .collect(),
    )
}

#[test]
fn area_codes_are_three_digits_not_starting_with_0_or_1() {
    for ok in ["309", "217", "212", "907"] {
        assert!(valid_area_code(ok), "{ok}");
    }
    for bad in ["", "30", "3090", "109", "009", "3a9", " 309", "３０９"] {
        assert!(!valid_area_code(bad), "{bad}");
    }
}

#[test]
fn places_keep_the_largest_distinct_named_cities() {
    let json = json!({"results": {"bindings": [
        row(&[("cityLabel", "Peoria"), ("pop", "113150"), ("coord", "Point(-89.59 40.6925)"), ("stateLabel", "Illinois")]),
        row(&[("cityLabel", "Bloomington"), ("pop", "78680"), ("coord", "Point(-88.993611111 40.484166666)"), ("stateLabel", "Illinois")]),
        // Within 15 km of Bloomington: the same market.
        row(&[("cityLabel", "Normal"), ("pop", "52736"), ("coord", "Point(-88.988611111 40.512222222)")]),
        row(&[("cityLabel", "Q123456"), ("pop", "50000"), ("coord", "Point(-90.0 41.0)")]),
        row(&[("cityLabel", "Moline"), ("pop", "42985"), ("coord", "Point(-90.499722222 41.485833333)")]),
        row(&[("cityLabel", "Moline"), ("pop", "42985"), ("coord", "Point(-90.499722222 41.485833333)")]),
        row(&[("cityLabel", "Bad\u{7} Point"), ("coord", "Point(-500 41)")]),
        row(&[("cityLabel", "DeKalb"), ("pop", "40290"), ("coord", "Point(-88.750277777 41.931388888)")]),
        row(&[("cityLabel", "Pekin"), ("pop", "31731"), ("coord", "Point(-89.626388888 40.568055555)")]),
    ]}});
    let places = parse_places(&json);
    assert_eq!(
        places.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
        ["Peoria", "Bloomington", "Moline", "DeKalb"]
    );
    assert_eq!(places[0].state.as_deref(), Some("Illinois"));
    assert_eq!(places[0].population, Some(113150));
    assert!((places[0].lat - 40.6925).abs() < 1e-9 && (places[0].lon + 89.59).abs() < 1e-9);
}

#[test]
fn tv_stations_need_a_safe_website_and_keep_their_distance() {
    let json = json!({"results": {"bindings": [
        row(&[("sLabel", "WMBD-TV"), ("site", "http://www.centralillinoisproud.com/"), ("dist", "7.6")]),
        row(&[("sLabel", "WEEK-TV"), ("call", "WEEK-TV"), ("site", "https://www.25newsnow.com/"), ("dist", "8.4")]),
        row(&[("sLabel", "No site"), ("dist", "3")]),
        row(&[("sLabel", "Script"), ("site", "javascript:alert(1)"), ("dist", "3")]),
        row(&[("sLabel", "Credentials"), ("site", "https://user:pass@example.invalid/"), ("dist", "3")]),
        row(&[("sLabel", "  "), ("site", "https://blank.invalid/"), ("dist", "3")]),
    ]}});
    let tv = parse_tv(&json, "Peoria");
    assert_eq!(tv.len(), 2);
    assert_eq!(tv[0].name, "WMBD-TV");
    assert_eq!(tv[0].website, "https://www.centralillinoisproud.com/");
    assert_eq!(tv[0].distance_km, 8);
    assert_eq!(tv[1].call_sign.as_deref(), Some("WEEK-TV"));
    assert_eq!(tv[1].place, "Peoria");
}

#[test]
fn radio_keeps_working_streams_near_or_naming_a_place() {
    let json = json!([
        {"stationuuid": "a", "name": "WMBD 1470 AM 100.3 FM Peoria News", "url_resolved": "https://stream.invalid/wmbd", "lastcheckok": 1, "codec": "AAC+", "bitrate": 64, "state": "Peoria, Illinois", "tags": "news", "homepage": "https://wmbd.invalid/"},
        {"stationuuid": "b", "name": "WGLT", "url_resolved": "https://stream.invalid/wglt", "lastcheckok": 1, "codec": "AAC+", "bitrate": 320, "state": "IL", "geo_lat": 40.51, "geo_long": -88.99},
        {"stationuuid": "c", "name": "Chicago Hits", "url_resolved": "https://stream.invalid/chi", "lastcheckok": 1, "state": "Illinois", "geo_lat": 41.88, "geo_long": -87.63},
        {"stationuuid": "d", "name": "Broken Peoria", "url_resolved": "https://stream.invalid/broken", "lastcheckok": 0, "state": "Peoria, Illinois"},
        {"stationuuid": "e", "name": "Bad address Peoria", "url_resolved": "ftp://stream.invalid/x", "lastcheckok": 1},
        {"stationuuid": "f", "name": "Plain HTTP Pekin", "url_resolved": "http://stream.invalid/pekin", "lastcheckok": 1, "state": "Pekin, Illinois", "bitrate": 99999}
    ]);
    let places = parse_places(&json!({"results": {"bindings": [
        row(&[("cityLabel", "Peoria"), ("pop", "113150"), ("coord", "Point(-89.59 40.6925)")]),
        row(&[("cityLabel", "Bloomington"), ("pop", "78680"), ("coord", "Point(-88.993611111 40.484166666)")]),
        row(&[("cityLabel", "Pekin"), ("pop", "31731"), ("coord", "Point(-89.626388888 40.42)")]),
    ]}}));
    let parsed = parse_radio(&json);
    assert_eq!(
        parsed
            .iter()
            .map(|(s, _, _)| s.id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b", "c", "f"]
    );
    let local: Vec<_> = parsed
        .iter()
        .filter(|(_, geo, hay)| radio_is_local(*geo, hay, &places))
        .map(|(s, _, _)| s.id.as_str())
        .collect();
    // Named for Peoria, within range of Bloomington, named for Pekin; not Chicago.
    assert_eq!(local, ["a", "b", "f"]);
    let pekin = &parsed.iter().find(|(s, _, _)| s.id == "f").unwrap().0;
    assert_eq!(pekin.stream, "http://stream.invalid/pekin");
    assert_eq!(pekin.bitrate, 10_000);
    assert_eq!(
        parsed[0].0.homepage.as_deref(),
        Some("https://wmbd.invalid/")
    );
}

#[test]
fn queries_encode_the_area_code_and_point() {
    assert!(places_query("309").contains("wdt:P473 \"309\""));
    assert!(tv_query(40.6925, -89.59, 70).contains("Point(-89.59000 40.69250)"));
    let encoded = urlencoding("SELECT ?a WHERE { ?a wdt:P473 \"309\" }");
    assert!(!encoded.contains(' ') && !encoded.contains('"') && !encoded.contains('{'));
    assert_eq!(urlencoding("Illinois"), "Illinois");
    assert_eq!(urlencoding("New York"), "New+York");
}

#[test]
fn radio_merge_drops_repeats_by_id_stream_or_name() {
    let places = parse_places(&json!({"results": {"bindings": [
        row(&[("cityLabel", "Peoria"), ("pop", "113150"), ("coord", "Point(-89.59 40.6925)")]),
    ]}}));
    let parsed = parse_radio(&json!([
        {"stationuuid": "a", "name": "Vintage Broadcast", "url_resolved": "https://stream.invalid/v", "lastcheckok": 1, "state": "Peoria, Illinois"},
        {"stationuuid": "b", "name": "vintage broadcast", "url_resolved": "https://stream.invalid/v2", "lastcheckok": 1, "state": "Peoria, Illinois"},
        {"stationuuid": "c", "name": "Other", "url_resolved": "https://stream.invalid/v", "lastcheckok": 1, "state": "Peoria, Illinois"},
        {"stationuuid": "a", "name": "Again", "url_resolved": "https://stream.invalid/a", "lastcheckok": 1, "state": "Peoria, Illinois"},
        {"stationuuid": "d", "name": "Alpha Peoria", "url_resolved": "https://stream.invalid/alpha", "lastcheckok": 1}
    ]));
    let merged = merge_radio(parsed, &places);
    assert_eq!(
        merged.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        ["d", "a"]
    );
}

#[test]
fn zip_codes_are_five_digits_and_query_the_postal_code() {
    for ok in ["61602", "90210", "00501"] {
        assert!(valid_zip(ok), "{ok}");
    }
    for bad in ["6160", "616022", "6160a", "309", ""] {
        assert!(!valid_zip(bad), "{bad}");
    }
    assert!(zip_query("61602").contains("wdt:P281 \"61602\""));
}
