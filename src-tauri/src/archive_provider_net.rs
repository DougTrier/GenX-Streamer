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

//! Closed provider destinations; metadata never grants arbitrary network access.
use crate::{archive_provider_contract::Provider, scan_manifest_work::Context};
use reqwest::{redirect::Policy, Url};
use serde_json::Value;
use std::{net::ToSocketAddrs, sync::Arc, time::Duration};
use tokio::time::Instant;

fn url(raw: &str) -> Result<Url, String> {
    let u = Url::parse(raw).map_err(|_| "public-archive-url-refused")?;
    if raw.len() > 4096
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || u.port_or_known_default() != Some(443)
        || u.scheme() != "https"
    {
        return Err("public-archive-url-refused".into());
    }
    Ok(u)
}
pub(crate) fn source_url(p: Provider, id: &str, raw: &str) -> Result<(), String> {
    let u = url(raw)?;
    let host = u.host_str().unwrap_or("");
    let valid = match p {
        Provider::Loc => {
            host == "www.loc.gov" && u.path() == format!("/item/{id}/") && u.query().is_none()
        }
        Provider::Nasa => {
            host == "images-assets.nasa.gov"
                && u.path()
                    == format!(
                        "/video/{}/collection.json",
                        crate::archive_provider_contract::nasa_item_segment(id)?
                    )
                && u.query().is_none()
        }
        Provider::Commons => {
            host == "commons.wikimedia.org"
                && ((u.path().starts_with("/wiki/File:") && u.query().is_none())
                    || (u.path() == "/w/index.php"
                        && u.query() == Some(format!("curid={id}").as_str())))
        }
    };
    if valid {
        Ok(())
    } else {
        Err("public-archive-source-refused".into())
    }
}
pub(crate) fn media_url(p: Provider, id: &str, raw: &str) -> Result<Url, String> {
    let raw = if p == Provider::Nasa && raw.starts_with("http://images-assets.nasa.gov/") {
        format!("https://{}", &raw[7..])
    } else {
        raw.to_owned()
    };
    let u = url(&raw)?;
    let host = u.host_str().unwrap_or("");
    let valid = match p {
        Provider::Loc => {
            host == "tile.loc.gov"
                && (u.path().starts_with("/storage-services/")
                    || u.path().starts_with("/streaming-services/"))
                && u.query().is_none()
        }
        Provider::Nasa => {
            host == "images-assets.nasa.gov"
                && u.path().starts_with(&format!(
                    "/video/{}/",
                    crate::archive_provider_contract::nasa_item_segment(id)?
                ))
                && u.query().is_none()
        }
        Provider::Commons => {
            host == "upload.wikimedia.org"
                && (u.path().starts_with("/wikipedia/commons/")
                    || u.path().starts_with("/wikipedia/commons/transcoded/"))
                && u.query_pairs().all(|(k, v)| {
                    matches!(k.as_ref(), "utm_source" | "utm_campaign" | "utm_content")
                        && v.len() <= 128
                })
        }
    };
    if !valid || u.path().split('/').any(|s| s == ".." || s == ".") {
        Err("public-archive-media-url-refused".into())
    } else {
        Ok(u)
    }
}
pub(crate) fn metadata_url(p: Provider, raw: &str) -> Result<Url, String> {
    let u = url(raw)?;
    let h = u.host_str().unwrap_or("");
    let ok = match p {
        Provider::Loc => {
            h == "www.loc.gov"
                && (u.path() == "/film-and-videos/" || u.path().starts_with("/item/"))
        }
        Provider::Nasa => {
            h == "images-api.nasa.gov" && (u.path() == "/search" || u.path().starts_with("/asset/"))
        }
        Provider::Commons => h == "commons.wikimedia.org" && u.path() == "/w/api.php",
    };
    if ok {
        Ok(u)
    } else {
        Err("public-archive-metadata-url-refused".into())
    }
}
/// Display-only license reference; this never grants media/request authority.
pub(crate) fn license_reference(raw: &str) -> Option<String> {
    let mut u = Url::parse(raw).ok()?;
    if u.scheme() == "http"
        && u.host_str() == Some("creativecommons.org")
        && (u.path().starts_with("/licenses/") || u.path().starts_with("/publicdomain/"))
    {
        u.set_scheme("https").ok()?;
    }
    let checked = url(u.as_str()).ok()?;
    let host = checked.host_str()?;
    static PATH_CONTROLS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let controls = PATH_CONTROLS.get_or_init(|| {
        regex::Regex::new(r"(?i)%(?:0[0-9a-f]|1[0-9a-f]|7f)")
            .expect("constant escaped-control regex")
    });
    if !host.contains('.')
        || host.parse::<std::net::IpAddr>().is_ok()
        || host.chars().any(|c| matches!(c, '[' | ']' | ':'))
        || matches!(
            host.rsplit('.')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str(),
            "localhost" | "local" | "internal" | "test" | "invalid"
        )
        || controls.is_match(checked.path())
    {
        return None;
    }
    Some(checked.into())
}
pub(crate) fn commons_agent() -> Result<String, String> {
    let contact = option_env!("GENX_PUBLIC_CONTACT").ok_or("public-archive-contact-required")?;
    let parsed = url(contact).map_err(|_| "public-archive-contact-required")?;
    let host = parsed.host_str().ok_or("public-archive-contact-required")?;
    if host.parse::<std::net::IpAddr>().is_ok()
        || !host.contains('.')
        || parsed.query().is_some()
        || contact.len() > 256
    {
        return Err("public-archive-contact-required".into());
    }
    Ok(format!("GenXStreamer/0.1 ({contact})"))
}
static RETRY_UNTIL: std::sync::Mutex<[i64; 3]> = std::sync::Mutex::new([0; 3]);
fn provider_index(p: Provider) -> usize {
    match p {
        Provider::Loc => 0,
        Provider::Nasa => 1,
        Provider::Commons => 2,
    }
}
pub(crate) fn retry_until(p: Provider) -> Option<i64> {
    let now = crate::archive_catalog::now_ms().ok()?;
    RETRY_UNTIL
        .lock()
        .ok()
        .and_then(|v| (v[provider_index(p)] > now).then_some(v[provider_index(p)]))
}
fn retry_date(raw: Option<&str>, now: i64) -> i64 {
    let parsed = raw.filter(|s| s.len() <= 128).and_then(|s| {
        s.parse::<i64>()
            .ok()
            .filter(|n| *n >= 0)
            .and_then(|seconds| seconds.checked_mul(1000).and_then(|d| now.checked_add(d)))
            .or_else(|| {
                chrono::DateTime::parse_from_rfc2822(s)
                    .ok()
                    .map(|d| d.timestamp_millis())
            })
    });
    parsed
        .filter(|v| *v >= now && *v <= 9_007_199_254_740_991)
        .unwrap_or(now + 60000)
}
pub(crate) fn retain_retry(p: Provider, raw: Option<&str>) {
    if let Ok(now) = crate::archive_catalog::now_ms() {
        if let Ok(mut v) = RETRY_UNTIL.lock() {
            let i = provider_index(p);
            v[i] = v[i].max(retry_date(raw, now));
        }
    }
}
pub(crate) fn check(owner: &Context, deadline: Instant) -> Result<(), String> {
    owner.check()?;
    if Instant::now() >= deadline {
        Err("public-archive-timeout".into())
    } else {
        Ok(())
    }
}
pub(crate) async fn client(
    owner: &Arc<Context>,
    deadline: Instant,
    host: &str,
    p: Provider,
) -> Result<reqwest::Client, String> {
    check(owner, deadline)?;
    let name = host.to_owned();
    let mut task = tokio::task::spawn_blocking(move || {
        let mut values = Vec::new();
        for address in (name.as_str(), 443)
            .to_socket_addrs()
            .map_err(|_| "public-archive-dns-unavailable")?
        {
            if values.len() >= 128 || !crate::sharing_policy::public_upstream(address.ip()) {
                return Err("public-archive-destination-refused");
            }
            values.push(address);
        }
        if values.is_empty() {
            return Err("public-archive-dns-unavailable");
        }
        Ok(values)
    });
    let addresses = loop {
        if let Err(error) = check(owner, deadline) {
            let _ = task.await;
            return Err(error);
        }
        tokio::select! {r=&mut task=>break r.map_err(|_|"public-archive-dns-unavailable")?.map_err(str::to_owned)?,_=tokio::time::sleep(Duration::from_millis(25))=>{}}
    };
    check(owner, deadline)?;
    reqwest::Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(5))
        .user_agent(if p == Provider::Commons {
            commons_agent()?
        } else {
            "GenXStreamer/0.1 (user initiated public archive search)".into()
        })
        .build()
        .map_err(|_| "public-archive-network-unavailable".into())
}
static LOC_NEXT: tokio::sync::Mutex<Option<Instant>> = tokio::sync::Mutex::const_new(None);
pub(crate) async fn json(
    p: Provider,
    raw: &str,
    owner: &Arc<Context>,
    deadline: Instant,
    budget: &mut usize,
) -> Result<Value, String> {
    if retry_until(p).is_some() {
        return Err("public-archive-rate-limited".into());
    }
    let target = metadata_url(p, raw)?;
    if p == Provider::Loc {
        let pending = LOC_NEXT.lock();
        tokio::pin!(pending);
        let mut next = loop {
            check(owner, deadline)?;
            tokio::select! {guard=&mut pending=>break guard,_=tokio::time::sleep(Duration::from_millis(25))=>{}}
        };
        if let Some(at) = *next {
            while Instant::now() < at {
                check(owner, deadline)?;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        check(owner, deadline)?;
        *next = Some(Instant::now() + Duration::from_secs(6));
    }
    let c = client(
        owner,
        deadline,
        target.host_str().ok_or("public-archive-url-refused")?,
        p,
    )
    .await?;
    let work = async {
        let mut response = c
            .get(target.clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(|_| "public-archive-network-unavailable")?;
        if matches!(response.status().as_u16(), 429 | 503) {
            retain_retry(
                p,
                response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|h| h.to_str().ok()),
            );
            return Err("public-archive-rate-limited".into());
        }
        if response.status().as_u16() == 503 {
            return Err("public-archive-server-unavailable".into());
        }
        if response.status().as_u16() != 200
            || response.url() != &target
            || response
                .headers()
                .get(reqwest::header::CONTENT_ENCODING)
                .is_some_and(|v| v.as_bytes() != b"identity")
        {
            return Err("public-archive-response-refused".into());
        }
        if response
            .content_length()
            .is_some_and(|n| n > 2 * 1024 * 1024)
        {
            return Err("public-archive-response-limit".into());
        }
        let mut bytes = Vec::new();
        while let Some(part) = response
            .chunk()
            .await
            .map_err(|_| "public-archive-network-unavailable")?
        {
            check(owner, deadline)?;
            *budget = budget
                .checked_add(part.len())
                .ok_or("public-archive-response-limit")?;
            if bytes.len() + part.len() > 2 * 1024 * 1024 || *budget > 6 * 1024 * 1024 {
                return Err("public-archive-response-limit".into());
            }
            bytes.extend_from_slice(&part);
        }
        check(owner, deadline)?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "public-archive-metadata-invalid".to_owned())?;
        if value
            .get("error")
            .and_then(|e| e.get("code"))
            .and_then(Value::as_str)
            .is_some_and(|s| matches!(s, "maxlag" | "ratelimited"))
        {
            retain_retry(p, None);
            return Err("public-archive-rate-limited".into());
        }
        Ok(value)
    };
    tokio::time::timeout_at(deadline, work)
        .await
        .map_err(|_| "public-archive-timeout".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn displayed_license_references_fit_the_shared_closed_url_contract() {
        assert_eq!(
            license_reference("http://creativecommons.org/licenses/by/4.0/").as_deref(),
            Some("https://creativecommons.org/licenses/by/4.0/")
        );
        for raw in [
            "https://rights.invalid/license",
            "https://x.local/license",
            "https://x.internal/license",
            "https://x.test/license",
            "https://127.0.0.1/license",
            "https://creativecommons.org/licenses/by/4.0/%0a",
            "https://creativecommons.org/licenses/by/4.0/%7F",
            "https://u:p@creativecommons.org/license",
            "https://creativecommons.org:444/license",
        ] {
            assert!(license_reference(raw).is_none(), "{raw}");
        }
    }
    #[test]
    fn retry_after_seconds_and_http_dates_are_honored() {
        assert_eq!(retry_date(Some("120"), 1000), 121000);
        assert_eq!(
            retry_date(Some("Thu, 15 Oct 2026 08:00:00 GMT"), 0),
            1792051200000
        );
        assert_eq!(retry_date(Some("garbage"), 1000), 61000);
    }
    #[test]
    fn destinations_stay_provider_and_exact_scope() {
        assert!(media_url(
            Provider::Nasa,
            "abc",
            "http://images-assets.nasa.gov/video/abc/a.mp4"
        )
        .unwrap()
        .as_str()
        .starts_with("https://"));
        for raw in [
            "https://images-assets.nasa.gov/video/other/a.mp4",
            "http://127.0.0.1/a.mp4",
            "https://images-assets.nasa.gov.evil.invalid/video/abc/a.mp4",
            "https://u:p@images-assets.nasa.gov/video/abc/a.mp4",
        ] {
            assert!(media_url(Provider::Nasa, "abc", raw).is_err());
        }
        assert!(media_url(
            Provider::Loc,
            "item",
            "https://tile.loc.gov/storage-services/service/a.mp4"
        )
        .is_ok());
        assert!(media_url(
            Provider::Commons,
            "12",
            "https://upload.wikimedia.org/wikipedia/commons/a/a0/file.webm?token=abc"
        )
        .is_err());
    }
}
