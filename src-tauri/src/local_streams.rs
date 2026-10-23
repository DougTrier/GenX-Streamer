//! Area code scan: local TV station websites and radio streams near an area code.
//! Places and TV stations come from Wikidata (CC0); radio from Radio Browser.
//! Only the area code and its cities' coordinates are sent. Every field is
//! bounded text for display; nothing here is fetched or played automatically.
use serde::Serialize;
use serde_json::Value;

const WIKIDATA: &str = "https://query.wikidata.org/sparql?format=json&query=";
const RADIO_SERVERS: [&str; 3] = [
    "https://de1.api.radio-browser.info",
    "https://fi1.api.radio-browser.info",
    "https://at1.api.radio-browser.info",
];
/// The largest places of an area code that are searched around.
const PLACES: usize = 4;
const TV_RADIUS_KM: u32 = 70;
const RADIO_RADIUS_M: u32 = 70_000;
const MAX_TV: usize = 60;
const MAX_RADIO: usize = 120;
const MAX_BODY: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Place {
    pub name: String,
    pub state: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub population: Option<u64>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TvStation {
    pub name: String,
    pub call_sign: Option<String>,
    pub website: String,
    pub place: String,
    pub distance_km: u32,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RadioStation {
    pub id: String,
    pub name: String,
    pub stream: String,
    pub codec: String,
    pub bitrate: u32,
    pub homepage: Option<String>,
    pub area: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalStreams {
    pub schema_version: u8,
    pub area_code: String,
    pub places: Vec<Place>,
    pub tv: Vec<TvStation>,
    pub radio: Vec<RadioStation>,
    /// One half of the lookup failed; the other half's results still return.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub tv_unavailable: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub radio_unavailable: bool,
}

/// A North American area code: three digits, not starting with 0 or 1.
pub(crate) fn valid_area_code(code: &str) -> bool {
    code.len() == 3
        && code.bytes().all(|b| b.is_ascii_digit())
        && !matches!(code.as_bytes()[0], b'0' | b'1')
}
/// A US ZIP code: five digits.
pub(crate) fn valid_zip(code: &str) -> bool {
    code.len() == 5 && code.bytes().all(|b| b.is_ascii_digit())
}
/// Display text: trimmed, control characters removed, bounded.
fn text(value: &str, max: usize) -> Option<String> {
    let cleaned: String = value
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(max)
        .collect();
    (!cleaned.is_empty()).then_some(cleaned)
}
/// An absolute http(s) address without credentials, bounded.
fn web_address(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value.trim()).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && value.len() <= 2048)
        .then(|| url.to_string())
}
fn binding<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key)?.get("value")?.as_str()
}
/// "Point(lon lat)" from Wikidata.
fn point(value: &str) -> Option<(f64, f64)> {
    let inner = value.strip_prefix("Point(")?.strip_suffix(')')?;
    let mut parts = inner.split_whitespace();
    let lon: f64 = parts.next()?.parse().ok()?;
    let lat: f64 = parts.next()?.parse().ok()?;
    ((-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)).then_some((lat, lon))
}
fn distance_km(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (la1, lo1, la2, lo2) = (
        a.0.to_radians(),
        a.1.to_radians(),
        b.0.to_radians(),
        b.1.to_radians(),
    );
    let h = ((la2 - la1) / 2.0).sin().powi(2)
        + la1.cos() * la2.cos() * ((lo2 - lo1) / 2.0).sin().powi(2);
    12_742.0 * h.sqrt().asin()
}

pub(crate) fn places_query(code: &str) -> String {
    format!(
        "SELECT ?city ?cityLabel ?pop ?coord ?stateLabel WHERE {{ ?city wdt:P473 \"{code}\" ; wdt:P17 wd:Q30 ; wdt:P625 ?coord . OPTIONAL {{ ?city wdt:P1082 ?pop }} OPTIONAL {{ ?city wdt:P131 ?county . ?county wdt:P131 ?state . ?state wdt:P31 wd:Q35657 }} SERVICE wikibase:label {{ bd:serviceParam wikibase:language \"en\". }} }} ORDER BY DESC(?pop) LIMIT 40"
    )
}
/// The city of a ZIP code first (largest population), then landmarks in it.
pub(crate) fn zip_query(zip: &str) -> String {
    format!(
        "SELECT ?city ?cityLabel ?pop ?coord ?stateLabel WHERE {{ ?city wdt:P281 \"{zip}\" ; wdt:P17 wd:Q30 ; wdt:P625 ?coord . OPTIONAL {{ ?city wdt:P1082 ?pop }} OPTIONAL {{ ?city wdt:P131 ?county . ?county wdt:P131 ?state . ?state wdt:P31 wd:Q35657 }} SERVICE wikibase:label {{ bd:serviceParam wikibase:language \"en\". }} }} ORDER BY DESC(?pop) LIMIT 5"
    )
}
pub(crate) fn tv_query(lat: f64, lon: f64, km: u32) -> String {
    format!(
        "SELECT ?s ?sLabel ?call ?site ?dist WHERE {{ SERVICE wikibase:around {{ ?s wdt:P625 ?coord . bd:serviceParam wikibase:center \"Point({lon:.5} {lat:.5})\"^^geo:wktLiteral ; wikibase:radius \"{km}\" ; wikibase:distance ?dist . }} ?s wdt:P31/wdt:P279* wd:Q1616075 . OPTIONAL {{ ?s wdt:P2317 ?call }} ?s wdt:P856 ?site . SERVICE wikibase:label {{ bd:serviceParam wikibase:language \"en\". }} }} ORDER BY ?dist LIMIT 80"
    )
}

/// The largest distinct places of an area code (Wikidata rows ordered by population).
pub(crate) fn parse_places(json: &Value) -> Vec<Place> {
    let mut places: Vec<Place> = Vec::new();
    for row in json["results"]["bindings"].as_array().into_iter().flatten() {
        let (Some(name), Some((lat, lon))) = (
            binding(row, "cityLabel").and_then(|v| text(v, 120)),
            binding(row, "coord").and_then(point),
        ) else {
            continue;
        };
        // Wikidata labels unlabeled items with their Q-number; skip those.
        if name.starts_with('Q') && name[1..].bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        if places
            .iter()
            .any(|p| p.name == name || distance_km((p.lat, p.lon), (lat, lon)) < 15.0)
        {
            continue;
        }
        places.push(Place {
            name,
            state: binding(row, "stateLabel").and_then(|v| text(v, 60)),
            lat,
            lon,
            population: binding(row, "pop")
                .and_then(|v| v.parse::<f64>().ok())
                .map(|v| v as u64),
        });
        if places.len() == PLACES {
            break;
        }
    }
    places
}
/// TV stations with a website near one place, nearest first.
pub(crate) fn parse_tv(json: &Value, place: &str) -> Vec<TvStation> {
    let mut out: Vec<TvStation> = Vec::new();
    for row in json["results"]["bindings"].as_array().into_iter().flatten() {
        let (Some(name), Some(website)) = (
            binding(row, "sLabel").and_then(|v| text(v, 120)),
            // Station sites open in the in-app page view, which loads https only.
            binding(row, "site")
                .and_then(web_address)
                .map(|site| site.replacen("http://", "https://", 1)),
        ) else {
            continue;
        };
        let distance = binding(row, "dist")
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|d| d.is_finite() && *d >= 0.0)
            .unwrap_or(0.0);
        out.push(TvStation {
            name,
            call_sign: binding(row, "call").and_then(|v| text(v, 16)),
            website,
            place: place.to_owned(),
            distance_km: distance.round() as u32,
        });
    }
    out
}
/// Working radio streams from a Radio Browser station list.
/// A parsed station with its coordinates and lowercased search text.
pub(crate) type RadioRow = (RadioStation, Option<(f64, f64)>, String);
pub(crate) fn parse_radio(json: &Value) -> Vec<RadioRow> {
    let mut out = Vec::new();
    for s in json.as_array().into_iter().flatten() {
        if s["lastcheckok"].as_i64() != Some(1) {
            continue;
        }
        let (Some(id), Some(name), Some(stream)) = (
            s["stationuuid"].as_str().and_then(|v| text(v, 64)),
            s["name"].as_str().and_then(|v| text(v, 120)),
            s["url_resolved"].as_str().and_then(web_address),
        ) else {
            continue;
        };
        let geo = match (s["geo_lat"].as_f64(), s["geo_long"].as_f64()) {
            (Some(lat), Some(lon))
                if (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon) =>
            {
                Some((lat, lon))
            }
            _ => None,
        };
        let haystack = format!(
            "{} {} {} {}",
            s["name"].as_str().unwrap_or(""),
            s["state"].as_str().unwrap_or(""),
            s["tags"].as_str().unwrap_or(""),
            s["homepage"].as_str().unwrap_or("")
        )
        .to_lowercase();
        out.push((
            RadioStation {
                id,
                name,
                stream,
                codec: s["codec"]
                    .as_str()
                    .and_then(|v| text(v, 16))
                    .unwrap_or_default(),
                bitrate: s["bitrate"].as_u64().unwrap_or(0).min(10_000) as u32,
                homepage: s["homepage"].as_str().and_then(web_address),
                area: s["state"]
                    .as_str()
                    .and_then(|v| text(v, 80))
                    .unwrap_or_default(),
            },
            geo,
            haystack,
        ));
    }
    out
}
/// Near one of the places, or naming one of them.
pub(crate) fn radio_is_local(geo: Option<(f64, f64)>, haystack: &str, places: &[Place]) -> bool {
    places.iter().any(|p| {
        geo.is_some_and(|g| distance_km(g, (p.lat, p.lon)) <= f64::from(RADIO_RADIUS_M) / 1000.0)
            || haystack.contains(&p.name.to_lowercase())
    })
}

/// Local, distinct radio stations (by id, stream address or name), sorted by name.
pub(crate) fn merge_radio(rows: Vec<RadioRow>, places: &[Place]) -> Vec<RadioStation> {
    let mut radio: Vec<RadioStation> = Vec::new();
    for (station, geo, haystack) in rows {
        let duplicate = radio.iter().any(|r| {
            r.id == station.id
                || r.stream == station.stream
                || r.name.to_lowercase() == station.name.to_lowercase()
        });
        if radio_is_local(geo, &haystack, places) && !duplicate {
            radio.push(station);
        }
    }
    radio.sort_by_cached_key(|s| s.name.to_lowercase());
    radio.truncate(MAX_RADIO);
    radio
}
/// Wikidata can think for several seconds before its first byte, longer than
/// the playlist read timeout; these lookups get the 45 s tier and a small cap.
async fn json(url: &str) -> Result<Value, String> {
    let mut response = crate::network::response_with_budget(url, false, None, 45_000).await?;
    if !response.status().is_success() {
        return Err(format!("http-{}", response.status().as_u16()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| String::from("local-streams-unavailable"))?
    {
        if body.len() + chunk.len() > MAX_BODY {
            return Err("local-streams-too-large".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "local-streams-invalid".into())
}
async fn radio(path: &str) -> Result<Value, String> {
    let mut last = String::from("local-streams-radio-unavailable");
    for server in RADIO_SERVERS {
        match json(&format!("{server}{path}")).await {
            Ok(value) => return Ok(value),
            Err(error) => last = error,
        }
    }
    Err(last)
}

pub(crate) async fn scan(code: &str) -> Result<LocalStreams, String> {
    let zip = valid_zip(code);
    if !zip && !valid_area_code(code) {
        return Err("local-streams-invalid-area-code".into());
    }
    let encode = |q: String| WIKIDATA.to_owned() + &urlencoding(&q);
    let mut places = parse_places(
        &json(&encode(if zip {
            zip_query(code)
        } else {
            places_query(code)
        }))
        .await?,
    );
    // A ZIP code is one place: its city (landmarks in it are close by anyway).
    if zip {
        places.truncate(1);
    }
    if places.is_empty() {
        return Err("local-streams-area-code-unknown".into());
    }
    let mut tv: Vec<TvStation> = Vec::new();
    let mut tv_failures = 0;
    for place in &places {
        let Ok(rows) = json(&encode(tv_query(place.lat, place.lon, TV_RADIUS_KM))).await else {
            tv_failures += 1;
            continue;
        };
        for station in parse_tv(&rows, &place.name) {
            let host = |s: &TvStation| {
                reqwest::Url::parse(&s.website).ok().and_then(|u| {
                    u.host_str()
                        .map(|h| h.trim_start_matches("www.").to_owned())
                })
            };
            match tv.iter_mut().find(|t| host(t) == host(&station)) {
                Some(known) if known.distance_km > station.distance_km => *known = station,
                Some(_) => {}
                None => tv.push(station),
            }
        }
    }
    tv.sort_by_key(|s| s.distance_km);
    tv.truncate(MAX_TV);
    let tv = reachable(tv).await;

    let mut paths: Vec<String> = places
        .iter()
        .map(|place| {
            format!(
                "/json/stations/search?geo_lat={:.4}&geo_long={:.4}&geo_distance={RADIO_RADIUS_M}&hidebroken=true&limit=200",
                place.lat, place.lon
            )
        })
        .collect();
    let states: Vec<String> = places.iter().filter_map(|p| p.state.clone()).collect();
    paths.extend(states.iter().take(2).map(|state| {
        format!(
            "/json/stations/search?countrycode=US&state={}&hidebroken=true&limit=1000",
            urlencoding(state)
        )
    }));
    let mut radio_rows = Vec::new();
    let mut radio_failures = 0;
    for path in &paths {
        match radio(path).await {
            Ok(rows) => radio_rows.extend(parse_radio(&rows)),
            Err(_) => radio_failures += 1,
        }
    }
    let tv_unavailable = tv_failures == places.len();
    let radio_unavailable = radio_failures == paths.len();
    if tv_unavailable && radio_unavailable {
        return Err("local-streams-unavailable".into());
    }
    let radio = merge_radio(radio_rows, &places);
    Ok(LocalStreams {
        schema_version: 1,
        area_code: code.to_owned(),
        places,
        tv,
        radio,
        tv_unavailable,
        radio_unavailable,
    })
}
/// Drops station sites that no longer exist (Wikidata keeps some retired
/// domains). A refusal still counts as a live site; a site that cannot be
/// reached at all, or whose homepage is "not found" or "gone", is dropped.
/// Slow sites stay.
async fn reachable(tv: Vec<TvStation>) -> Vec<TvStation> {
    let checks: Vec<_> = tv
        .iter()
        .map(|station| {
            let url = station.website.clone();
            tauri::async_runtime::spawn(async move {
                match tokio::time::timeout(
                    std::time::Duration::from_secs(8),
                    crate::network::response(&url, false, None),
                )
                .await
                {
                    Ok(Err(_)) => false,
                    // A homepage that is "not found" or "gone" is a retired site.
                    Ok(Ok(response)) => !matches!(response.status().as_u16(), 404 | 410),
                    Err(_) => true,
                }
            })
        })
        .collect();
    let mut kept = Vec::with_capacity(tv.len());
    for (station, check) in tv.into_iter().zip(checks) {
        if check.await.unwrap_or(true) {
            kept.push(station);
        }
    }
    kept
}
fn urlencoding(value: &str) -> String {
    reqwest::Url::parse_with_params("https://x.invalid/", &[("q", value)])
        .map(|u| {
            u.query()
                .unwrap_or("q=")
                .trim_start_matches("q=")
                .to_owned()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub(crate) async fn local_streams_scan(area_code: String) -> Result<LocalStreams, String> {
    scan(area_code.trim()).await
}

#[cfg(test)]
#[path = "local_streams_tests.rs"]
mod tests;
