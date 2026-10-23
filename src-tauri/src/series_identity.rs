//! Explicit, read-only TV series identity lookup (TVmaze public API, CC BY-SA).
//! Used only to suggest exact show titles for a GenXtra search. Results are
//! provider claims: they never admit Archive items, merge works or prove rights.
use reqwest::{redirect::Policy, Url};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    net::ToSocketAddrs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

const HOST: &str = "api.tvmaze.com";
const BODY_LIMIT: usize = 1024 * 1024;
const SHOW_LIMIT: usize = 5;
const CREDIT_LIMIT: usize = 12;
const SHOW_SCORE: f64 = 0.5;
const PERSON_SCORE: f64 = 0.85;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesShow {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub premiered_year: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_year: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesPerson {
    pub name: String,
    pub shows: Vec<SeriesShow>,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesIdentity {
    pub shows: Vec<SeriesShow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub person: Option<SeriesPerson>,
    pub attribution: &'static str,
}

fn plain(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}
pub fn validate_query(query: &str) -> Result<String, String> {
    let trimmed = query.trim();
    if trimmed.chars().count() < 2
        || !plain(trimmed, 128)
        || trimmed.contains("://")
        || trimmed.chars().any(|c| c.is_control())
    {
        return Err("series-query-invalid".into());
    }
    Ok(trimmed.to_owned())
}
fn key(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn year(value: Option<&Value>) -> Option<i32> {
    let text = value?.as_str()?;
    let digits = text.get(..4)?;
    if !digits.bytes().all(|b| b.is_ascii_digit()) || (text.len() > 4 && text.as_bytes()[4] != b'-')
    {
        return None;
    }
    digits
        .parse::<i32>()
        .ok()
        .filter(|y| (1900..=2100).contains(y))
}
fn show(value: &Value) -> Option<SeriesShow> {
    let name = value.get("name")?.as_str()?;
    if !plain(name, 256) {
        return None;
    }
    let network = value
        .get("network")
        .and_then(|n| n.get("name"))
        .or_else(|| value.get("webChannel").and_then(|n| n.get("name")))
        .and_then(Value::as_str)
        .filter(|n| plain(n, 128))
        .map(str::to_owned);
    Some(SeriesShow {
        name: name.trim().to_owned(),
        premiered_year: year(value.get("premiered")),
        ended_year: year(value.get("ended")),
        network,
    })
}
/// `/search/shows` rows: `{score, show}`. Low scores are not suggested.
pub fn parse_show_search(value: &Value) -> Result<Vec<SeriesShow>, String> {
    let rows = value.as_array().ok_or("series-response-invalid")?;
    if rows.len() > 50 {
        return Err("series-response-invalid".into());
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        let score = row.get("score").and_then(Value::as_f64).unwrap_or(0.0);
        if score < SHOW_SCORE {
            continue;
        }
        if let Some(item) = row.get("show").and_then(show) {
            if seen.insert((key(&item.name), item.premiered_year)) && out.len() < SHOW_LIMIT {
                out.push(item);
            }
        }
    }
    Ok(out)
}
/// `/search/people`: only an exact (punctuation-insensitive) name match with a
/// high score is treated as the person the user typed.
pub fn parse_people_search(value: &Value, query: &str) -> Result<Option<(u64, String)>, String> {
    let rows = value.as_array().ok_or("series-response-invalid")?;
    if rows.len() > 50 {
        return Err("series-response-invalid".into());
    }
    let wanted = key(query);
    for row in rows {
        let score = row.get("score").and_then(Value::as_f64).unwrap_or(0.0);
        let person = row.get("person");
        let id = person.and_then(|p| p.get("id")).and_then(Value::as_u64);
        let name = person.and_then(|p| p.get("name")).and_then(Value::as_str);
        if let (Some(id), Some(name)) = (id, name) {
            if score >= PERSON_SCORE && plain(name, 256) && key(name) == wanted && id > 0 {
                return Ok(Some((id, name.trim().to_owned())));
            }
        }
    }
    Ok(None)
}
/// `/people/{id}/castcredits?embed=show`: distinct shows, oldest first.
pub fn parse_cast_credits(value: &Value) -> Result<Vec<SeriesShow>, String> {
    let rows = value.as_array().ok_or("series-response-invalid")?;
    if rows.len() > 2000 {
        return Err("series-response-invalid".into());
    }
    let mut shows = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        if let Some(item) = row
            .get("_embedded")
            .and_then(|e| e.get("show"))
            .and_then(show)
        {
            if seen.insert(key(&item.name)) {
                shows.push(item);
            }
        }
    }
    shows.sort_by(|a, b| {
        a.premiered_year
            .unwrap_or(i32::MAX)
            .cmp(&b.premiered_year.unwrap_or(i32::MAX))
            .then_with(|| a.name.cmp(&b.name))
    });
    shows.truncate(CREDIT_LIMIT);
    Ok(shows)
}

static RETRY_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);
fn canceled(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::SeqCst) {
        Err("series-canceled".into())
    } else {
        Ok(())
    }
}
async fn client() -> Result<reqwest::Client, String> {
    let addresses = tokio::task::spawn_blocking(|| {
        let mut values = Vec::new();
        for address in (HOST, 443)
            .to_socket_addrs()
            .map_err(|_| "series-network-unavailable")?
        {
            if values.len() >= 64 || !crate::sharing_policy::public_upstream(address.ip()) {
                return Err("series-destination-refused");
            }
            values.push(address);
        }
        if values.is_empty() {
            return Err("series-network-unavailable");
        }
        Ok(values)
    })
    .await
    .map_err(|_| "series-network-unavailable")??;
    reqwest::Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .resolve_to_addrs(HOST, &addresses)
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .user_agent("GenXStreamer/0.1 (user initiated series lookup)")
        .build()
        .map_err(|_| "series-network-unavailable".into())
}
async fn get(client: &reqwest::Client, url: Url, flag: &AtomicBool) -> Result<Value, String> {
    if RETRY_UNTIL
        .lock()
        .ok()
        .and_then(|v| *v)
        .is_some_and(|at| Instant::now() < at)
    {
        return Err("series-rate-limited".into());
    }
    canceled(flag)?;
    let mut response = client
        .get(url.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| "series-network-unavailable")?;
    canceled(flag)?;
    if response.status().as_u16() == 429 {
        let seconds = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(10)
            .min(120);
        if let Ok(mut retry) = RETRY_UNTIL.lock() {
            *retry = Some(Instant::now() + Duration::from_secs(seconds));
        }
        return Err("series-rate-limited".into());
    }
    if response.status().as_u16() == 404 {
        return Ok(Value::Array(Vec::new()));
    }
    if response.status().as_u16() != 200 || response.url() != &url {
        return Err("series-response-refused".into());
    }
    if response
        .content_length()
        .is_some_and(|n| n > BODY_LIMIT as u64)
    {
        return Err("series-response-limit".into());
    }
    let mut bytes = Vec::new();
    while let Some(part) = response
        .chunk()
        .await
        .map_err(|_| "series-network-unavailable")?
    {
        canceled(flag)?;
        if bytes.len() + part.len() > BODY_LIMIT {
            return Err("series-response-limit".into());
        }
        bytes.extend_from_slice(&part);
    }
    serde_json::from_slice(&bytes).map_err(|_| "series-response-invalid".into())
}
fn endpoint(path: &str, query: Option<&str>) -> Result<Url, String> {
    let mut url = Url::parse(&format!("https://{HOST}{path}")).map_err(|_| "series-url-invalid")?;
    if let Some(q) = query {
        url.query_pairs_mut().append_pair("q", q);
    }
    Ok(url)
}
/// Two or three bounded GETs; a missing person or show is an empty result.
pub async fn lookup(query: &str, flag: &AtomicBool) -> Result<SeriesIdentity, String> {
    let query = validate_query(query)?;
    let client = client().await?;
    canceled(flag)?;
    let shows =
        parse_show_search(&get(&client, endpoint("/search/shows", Some(&query))?, flag).await?)?;
    let person = match parse_people_search(
        &get(&client, endpoint("/search/people", Some(&query))?, flag).await?,
        &query,
    )? {
        Some((id, name)) => {
            let credits = get(
                &client,
                endpoint(&format!("/people/{id}/castcredits"), None).map(|mut u| {
                    u.query_pairs_mut().append_pair("embed", "show");
                    u
                })?,
                flag,
            )
            .await?;
            let shows = parse_cast_credits(&credits)?;
            (!shows.is_empty()).then_some(SeriesPerson { name, shows })
        }
        None => None,
    };
    canceled(flag)?;
    Ok(SeriesIdentity {
        shows,
        person,
        attribution: "Show information from TVmaze (CC BY-SA 4.0)",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn show_search_keeps_confident_distinct_bounded_titles() {
        let value = json!([
            {"score":0.89,"show":{"name":"The Andy Griffith Show","premiered":"1960-10-03","ended":"1968-04-01","network":{"name":"CBS"}}},
            {"score":0.74,"show":{"name":"The New Andy Griffith Show","premiered":"1971-01-08","ended":null,"network":{"name":"CBS"}}},
            {"score":0.74,"show":{"name":"The New Andy Griffith Show","premiered":"1971-01-08"}},
            {"score":0.2,"show":{"name":"Unrelated"}},
            {"score":0.9,"show":{"name":"bad\nname"}},
            {"score":0.9,"show":{"name":"Streaming","premiered":"20x1","webChannel":{"name":"Web"}}}
        ]);
        let shows = parse_show_search(&value).unwrap();
        assert_eq!(shows.len(), 3);
        assert_eq!(
            shows[0],
            SeriesShow {
                name: "The Andy Griffith Show".into(),
                premiered_year: Some(1960),
                ended_year: Some(1968),
                network: Some("CBS".into())
            }
        );
        assert_eq!(shows[2].premiered_year, None);
        assert_eq!(shows[2].network.as_deref(), Some("Web"));
        assert!(parse_show_search(&json!({})).is_err());
        assert!(parse_show_search(&json!(vec![json!({}); 51])).is_err());
    }

    #[test]
    fn person_requires_exact_name_and_high_score() {
        let rows = json!([
            {"score":0.95,"person":{"id":7,"name":"Don Knotts Jr"}},
            {"score":1.0,"person":{"id":86055,"name":"Don Knotts"}}
        ]);
        assert_eq!(
            parse_people_search(&rows, "don knotts").unwrap(),
            Some((86055, "Don Knotts".into()))
        );
        assert_eq!(parse_people_search(&rows, "knotts").unwrap(), None);
        let low = json!([{"score":0.5,"person":{"id":1,"name":"Don Knotts"}}]);
        assert_eq!(parse_people_search(&low, "Don Knotts").unwrap(), None);
    }

    #[test]
    fn cast_credits_are_distinct_oldest_first_and_bounded() {
        let mut rows = vec![
            json!({"_embedded":{"show":{"name":"Three's Company","premiered":"1977-03-15"}}}),
            json!({"_embedded":{"show":{"name":"The Andy Griffith Show","premiered":"1960-10-03"}}}),
            json!({"_embedded":{"show":{"name":"The Andy Griffith Show","premiered":"1960-10-03"}}}),
            json!({"_embedded":{"show":{"name":"Undated"}}}),
        ];
        let shows = parse_cast_credits(&json!(rows.clone())).unwrap();
        assert_eq!(
            shows.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["The Andy Griffith Show", "Three's Company", "Undated"]
        );
        for i in 0..40 {
            rows.push(
                json!({"_embedded":{"show":{"name":format!("Show {i}"),"premiered":"1990-01-01"}}}),
            );
        }
        assert_eq!(
            parse_cast_credits(&json!(rows)).unwrap().len(),
            CREDIT_LIMIT
        );
    }

    #[test]
    fn queries_are_bounded_plain_text() {
        assert_eq!(
            validate_query("  Gilligan's Island ").unwrap(),
            "Gilligan's Island"
        );
        for bad in ["", "a", "https://x", "tab\there", &"x".repeat(129)] {
            assert!(validate_query(bad).is_err(), "{bad}");
        }
        let url = endpoint("/search/shows", Some("a&b=c")).unwrap();
        assert_eq!(
            url.as_str(),
            "https://api.tvmaze.com/search/shows?q=a%26b%3Dc"
        );
    }

    #[test]
    fn serialized_identity_has_only_display_fields_and_attribution() {
        let identity = SeriesIdentity {
            shows: vec![],
            person: None,
            attribution: "Show information from TVmaze (CC BY-SA 4.0)",
        };
        let value = serde_json::to_value(identity).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 2);
    }
}
