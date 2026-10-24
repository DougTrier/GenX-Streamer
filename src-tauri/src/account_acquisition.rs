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

//! Native-only authenticated Live TV acquisition. No response/URL type in this
//! module implements Serialize or Debug, and no secret crosses the WebView bridge.
//! The parent retains its work owner and rechecks account/root revisions at final
//! publication. Successful acquisition is not native decoder or provider proof.
use crate::{
    account_vault::{Resolved, Secret},
    scan_manifest_work::Context,
};
use reqwest::{redirect::Policy, Url};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    net::SocketAddr,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::time::Instant;
use zeroize::Zeroizing;

pub(crate) const BODY_LIMIT: usize = 20 * 1024 * 1024;
const ENTRY_LIMIT: usize = 100_000;
const LINE_LIMIT: usize = 16_384;
pub(crate) const TEXT_LIMIT: usize = 1024;

pub(crate) struct PreparedEntry {
    pub stable_id: String,
    pub provider_id: Option<String>,
    pub name: String,
    pub category: String,
    pub epg_id: Option<String>,
    pub media_url: Zeroizing<String>,
    /// Further addresses for the same channel (the provider listed it again
    /// with identical name, ID and group). Bounded: 1 + 15 per channel.
    pub backup_urls: Vec<Zeroizing<String>>,
}
pub(crate) struct PreparedCatalog {
    pub account_id: String,
    pub account_revision: u64,
    pub entries: Vec<PreparedEntry>,
    /// Provider rows left out because they were unusable (counted, XC-014).
    pub skipped: usize,
    pub supplied_guide: Option<Zeroizing<String>>,
    pub max_connections: Option<u32>,
    pub active_connections: Option<u32>,
}
// Retains known credential/token markers while checking provider display fields.
// Refuse tainted fields; never silently publish a reversible redaction or URL.
pub(crate) struct DisplayPolicy {
    markers: Vec<Zeroizing<String>>,
}
impl DisplayPolicy {
    pub(crate) fn new(secret: &Secret) -> Self {
        let mut markers = Vec::new();
        let raw = match secret {
            Secret::Xtream {
                server_url,
                username,
                password,
            } => {
                markers.push(Zeroizing::new(username.clone()));
                markers.push(Zeroizing::new(password.clone()));
                server_url
            }
            Secret::Playlist { url } => url,
        };
        markers.push(Zeroizing::new(raw.clone()));
        if let Ok(url) = Url::parse(raw) {
            for (key, value) in url.query_pairs() {
                // Standard playlist protocol options (type=m3u_plus, output=ts)
                // are not secrets; treating "ts" as one refused every channel
                // name containing it ("Sports"). Every other value stays tainted.
                if value.is_empty()
                    || matches!(
                        key.to_ascii_lowercase().as_str(),
                        "type" | "output" | "format"
                    )
                {
                    continue;
                }
                markers.push(Zeroizing::new(value.into_owned()));
            }
            if let Secret::Playlist { .. } = secret {
                // A playlist token may live anywhere in the path. Treat each
                // nonempty supplied segment as tainted, including escaped form.
                if let Some(parts) = url.path_segments() {
                    for part in parts.filter(|v| !v.is_empty()) {
                        markers.push(Zeroizing::new(part.to_owned()));
                        let mut decoded = Zeroizing::new(Vec::new());
                        let bytes = part.as_bytes();
                        let mut i = 0;
                        while i < bytes.len() {
                            if bytes[i] == b'%' && i + 2 < bytes.len() {
                                let h = (bytes[i + 1] as char).to_digit(16);
                                let l = (bytes[i + 2] as char).to_digit(16);
                                if let (Some(h), Some(l)) = (h, l) {
                                    decoded.push((h * 16 + l) as u8);
                                    i += 3;
                                    continue;
                                }
                            }
                            decoded.push(bytes[i]);
                            i += 1;
                        }
                        if let Ok(value) = std::str::from_utf8(&decoded) {
                            if value != part {
                                markers.push(Zeroizing::new(value.to_owned()));
                            }
                        }
                    }
                }
            }
        }
        Self { markers }
    }
    /// True when the value contains any part of the sign-in (never shown).
    pub(crate) fn tainted(&self, value: &str) -> bool {
        self.markers
            .iter()
            .any(|m| !m.is_empty() && value.contains(m.as_str()))
    }
    pub(crate) fn text(&self, raw: &str, limit: usize, empty: bool) -> Result<String, String> {
        let value = raw.trim();
        if (!empty && value.is_empty())
            || value.len() > limit
            || value.chars().any(char::is_control)
            || value.contains("://")
            || self
                .markers
                .iter()
                .any(|m| !m.is_empty() && value.contains(m.as_str()))
        {
            return Err("account-display-metadata-invalid".into());
        }
        Ok(value.to_owned())
    }
}

pub(crate) fn address(raw: &str, origin: &str) -> Result<Url, String> {
    if raw.is_empty() || raw.len() > LINE_LIMIT || raw.chars().any(char::is_control) {
        return Err("account-address-invalid".into());
    }
    let url = Url::parse(raw).map_err(|_| "account-address-invalid")?;
    crate::relay::validate_url(&url).map_err(|_| "account-address-invalid")?;
    // The origin comparison pins the scheme: HTTP is reachable only for an
    // account whose stored origin is HTTP (an explicit per-account grant).
    if !matches!(url.scheme(), "https" | "http")
        || url.fragment().is_some()
        || url.origin().ascii_serialization() != origin
    {
        return Err("account-origin-refused".into());
    }
    if let Ok(ip) = url
        .host_str()
        .unwrap_or("")
        .trim_matches(['[', ']'])
        .parse()
    {
        if !crate::sharing_policy::public_upstream(ip) {
            return Err("account-destination-refused".into());
        }
    }
    Ok(url)
}
pub(crate) fn check(owner: &Context, deadline: Instant) -> Result<(), String> {
    owner.check()?;
    if Instant::now() >= deadline {
        return Err("account-timeout".into());
    }
    Ok(())
}
async fn checked<T>(
    future: impl Future<Output = Result<T, String>>,
    owner: &Context,
    deadline: Instant,
) -> Result<T, String> {
    tokio::pin!(future);
    loop {
        check(owner, deadline)?;
        tokio::select! {
            result = &mut future => { check(owner, deadline)?; return result; },
            _ = tokio::time::sleep(Duration::from_millis(50)) => {},
            _ = tokio::time::sleep_until(deadline) => return Err("account-timeout".into()),
        }
    }
}
fn transport(error: reqwest::Error) -> String {
    // Do not format reqwest errors: Display can contain the entire request URL.
    match crate::network::error_category(&error) {
        "timeout" => "account-timeout",
        "tls-failure" => "account-tls-failed",
        "dns-failure" => "account-dns-failed",
        _ => "account-network-failed",
    }
    .into()
}
pub(crate) async fn fetch(
    url: Url,
    origin: &str,
    remaining_bytes: &mut usize,
    limit: usize,
    owner: &Context,
    deadline: Instant,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let cap = limit.min(*remaining_bytes);
    let mut bytes = Zeroizing::new(Vec::new());
    let got = fetch_into(url, origin, cap, owner, deadline, &mut |chunk| {
        bytes.extend_from_slice(chunk);
        Ok(())
    })
    .await?;
    *remaining_bytes -= got;
    Ok(bytes)
}
/// `fetch`, handing the body to `sink` as it arrives (a large guide goes to a
/// file, never whole into memory). At most `cap` bytes; empty is refused.
pub(crate) async fn fetch_into(
    mut url: Url,
    origin: &str,
    cap: usize,
    owner: &Context,
    deadline: Instant,
    sink: &mut (dyn FnMut(&[u8]) -> Result<(), String> + Send),
) -> Result<usize, String> {
    // Same public-DNS pinning/no-proxy policy as relay::request_public, with
    // credential origin/scheme checks on each redirect before dispatch.
    for redirect in 0..=5 {
        check(owner, deadline)?;
        // The account's own server first; after a provider redirect, the server
        // the provider named (see redirect_target).
        let hop = if redirect == 0 {
            origin.to_string()
        } else {
            url.origin().ascii_serialization()
        };
        address(url.as_str(), &hop)?;
        let host = url.host_str().ok_or("account-address-invalid")?;
        let port = url
            .port_or_known_default()
            .ok_or("account-address-invalid")?;
        let addresses = checked(
            async {
                let mut result = Vec::<SocketAddr>::new();
                for value in tokio::net::lookup_host((host, port))
                    .await
                    .map_err(|_| "account-dns-failed")?
                {
                    if result.len() >= 128 || !crate::sharing_policy::public_upstream(value.ip()) {
                        return Err("account-destination-refused".into());
                    }
                    result.push(value);
                }
                if result.is_empty() {
                    return Err("account-dns-failed".into());
                }
                Ok(result)
            },
            owner,
            deadline,
        )
        .await?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .resolve_to_addrs(host, &addresses)
            .connect_timeout(Duration::from_secs(5).min(remaining))
            .read_timeout(Duration::from_secs(5).min(remaining))
            .timeout(remaining)
            .user_agent("TMG-TV/0.1")
            .build()
            .map_err(|_| "account-network-failed")?;
        let mut response = checked(
            async { client.get(url.clone()).send().await.map_err(transport) },
            owner,
            deadline,
        )
        .await?;
        if response.status().is_redirection() {
            if redirect == 5 {
                return Err("account-redirect-refused".into());
            }
            let next = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .filter(|v| v.len() <= LINE_LIMIT)
                .ok_or("account-redirect-refused")?;
            let next = url.join(next).map_err(|_| "account-redirect-refused")?;
            redirect_target(&next, origin)?;
            url = next;
            continue;
        }
        match response.status().as_u16() {
            401 | 403 => return Err("account-authentication-refused".into()),
            429 => return Err("account-rate-limited".into()),
            200 => {}
            _ => return Err("account-server-response-refused".into()),
        }
        if response.content_length().is_some_and(|v| v > cap as u64) {
            return Err("account-response-too-large".into());
        }
        let mut received = 0usize;
        loop {
            let chunk = checked(
                async { response.chunk().await.map_err(transport) },
                owner,
                deadline,
            )
            .await?;
            let Some(chunk) = chunk else { break };
            if chunk.len() > cap.saturating_sub(received) {
                return Err("account-response-too-large".into());
            }
            received += chunk.len();
            sink(&chunk)?;
        }
        if received == 0 {
            return Err("account-response-empty".into());
        }
        return Ok(received);
    }
    Err("account-redirect-refused".into())
}
/// A provider's redirect may move a request to another public server: Xtream
/// front doors hand the sign-in to their real server, and load balancers move
/// it again (playback follows the same rule, account_playback_proxy). GenX
/// adds nothing to the address it is given, an HTTPS account is never
/// downgraded to plain HTTP, and every hop's DNS answer must be public.
fn redirect_target(next: &Url, origin: &str) -> Result<(), String> {
    if !origin.starts_with("http://") && next.scheme() != "https" {
        return Err("account-redirect-refused".into());
    }
    address(next.as_str(), &next.origin().ascii_serialization())
        .map(|_| ())
        .map_err(|_| "account-redirect-refused".into())
}
pub(crate) fn endpoint(
    base: &str,
    file: &str,
    username: &str,
    password: &str,
    action: Option<&str>,
    origin: &str,
) -> Result<Url, String> {
    let mut url = address(base, origin)?;
    // Preserve an explicitly supplied port and base path; never guess either.
    if url.query().is_some() {
        return Err("account-server-base-invalid".into());
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    let mut url = url.join(file).map_err(|_| "account-server-base-invalid")?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("username", username)
            .append_pair("password", password);
        if let Some(action) = action {
            query.append_pair("action", action);
        }
    }
    address(url.as_str(), origin)
}
pub(crate) fn id(raw: &Value) -> Result<String, String> {
    let value = match raw {
        Value::String(v) => v.clone(),
        // Some panels send 12.0 for 12 (XC-011); only whole, in-range numbers.
        Value::Number(v) => v
            .as_u64()
            .or_else(|| {
                v.as_f64()
                    .filter(|f| f.fract() == 0.0 && *f >= 0.0 && *f < 9.0e15)
                    .map(|f| f as u64)
            })
            .ok_or("account-provider-id-invalid")?
            .to_string(),
        _ => return Err("account-provider-id-invalid".into()),
    };
    if value.is_empty()
        || value.len() > 19
        || !value.bytes().all(|b| b.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
        || value.parse::<u64>().is_err()
    {
        return Err("account-provider-id-invalid".into());
    }
    Ok(value)
}
pub(crate) fn number(raw: Option<&Value>, limit: u64) -> Result<Option<u64>, String> {
    match raw {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(v)) if v.is_empty() => Ok(None),
        Some(v) => {
            let parsed = id(v)?
                .parse::<u64>()
                .map_err(|_| "account-status-invalid")?;
            if parsed > limit {
                return Err("account-status-invalid".into());
            }
            Ok(Some(parsed))
        }
    }
}
struct Auth {
    format: Option<String>,
    /// The provider's other advertised live format, stored beside each channel
    /// so playback can try it once (account_playback_owner::choose).
    alternate: Option<String>,
    max: Option<u32>,
    active: Option<u32>,
}
fn login(bytes: &[u8], now_ms: u64) -> Result<Auth, String> {
    // The JSON value stays entirely inside native parsing and is never logged.
    let parsed: Value =
        serde_json::from_slice(bytes).map_err(|_| "account-auth-response-invalid")?;
    let user = parsed
        .get("user_info")
        .and_then(Value::as_object)
        .ok_or("account-auth-response-invalid")?;
    if number(user.get("auth"), 1)? != Some(1) {
        return Err("account-authentication-refused".into());
    }
    let status = user
        .get("status")
        .and_then(Value::as_str)
        .ok_or("account-status-invalid")?;
    if !status.eq_ignore_ascii_case("active") {
        return Err("account-inactive-or-expired".into());
    }
    if number(user.get("exp_date"), i64::MAX as u64)?
        .is_some_and(|seconds| seconds <= now_ms / 1000)
    {
        return Err("account-inactive-or-expired".into());
    }
    let (format, alternate) = match user.get("allowed_output_formats") {
        Some(Value::Array(values)) if values.len() <= 16 => {
            if values.iter().any(|v| v.as_str().is_none()) {
                return Err("account-output-formats-invalid".into());
            }
            let advertised: Vec<&str> = ["ts", "m3u8"]
                .into_iter()
                .filter(|f| values.iter().any(|v| v.as_str() == Some(*f)))
                .collect();
            // Both are advertised Live TV outputs. TS first: it is Xtream's
            // native live output, and some servers' "HLS" is one never-ending
            // TS item followed by ENDLIST (smartdns/onvpn, October 18, 2026),
            // which an HLS player treats as a 15-second clip. mpegts.js plays
            // TS; HLS remains for providers that only offer it.
            (
                advertised.first().map(|f| f.to_string()),
                advertised.get(1).map(|f| f.to_string()),
            )
        }
        None | Some(Value::Null) => (None, None),
        _ => return Err("account-output-formats-invalid".into()),
    };
    Ok(Auth {
        format,
        alternate,
        max: number(user.get("max_connections"), 1000)?.map(|v| v as u32),
        active: number(user.get("active_cons"), 1000)?.map(|v| v as u32),
    })
}
/// An Xtream live address: base path kept, each part one escaped segment.
fn live_address(
    base: &str,
    origin: &str,
    username: &str,
    password: &str,
    provider: &str,
    extension: &str,
) -> Result<Url, String> {
    let mut url = address(base, origin)?;
    url.set_query(None);
    let prefix = url.path().trim_end_matches('/').to_owned();
    url.set_path(&format!("{prefix}/live/"));
    url.path_segments_mut()
        .map_err(|_| "account-server-base-invalid")?
        .pop_if_empty()
        .push(username)
        .push(password)
        .push(&format!("{provider}.{extension}"));
    address(url.as_str(), origin)
}
fn stable(account: &str, domain: &str, parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in [account, domain].into_iter().chain(parts.iter().copied()) {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part.as_bytes());
    }
    format!("account-{account}-{:x}", hash.finalize())
}
fn categories(
    bytes: &[u8],
    policy: &DisplayPolicy,
    owner: &Context,
    deadline: Instant,
) -> Result<HashMap<String, String>, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "account-categories-invalid")?;
    let rows = value
        .as_array()
        .filter(|v| v.len() <= 10_000)
        .ok_or("account-categories-invalid")?;
    let mut result = HashMap::new();
    for row in rows {
        check(owner, deadline)?;
        let key = id(row.get("category_id").ok_or("account-categories-invalid")?)?;
        let label = policy.text(
            row.get("category_name")
                .and_then(Value::as_str)
                .ok_or("account-categories-invalid")?,
            TEXT_LIMIT,
            false,
        )?;
        if result.insert(key, label).is_some() {
            return Err("account-categories-invalid".into());
        }
    }
    Ok(result)
}
fn xtream_entries(
    bytes: &[u8],
    account: &str,
    origin: &str,
    base: &str,
    username: &str,
    password: &str,
    auth: &Auth,
    cats: &HashMap<String, String>,
    policy: &DisplayPolicy,
    owner: &Context,
    deadline: Instant,
) -> Result<(Vec<PreparedEntry>, usize), String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "account-catalog-invalid")?;
    let rows = value
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= ENTRY_LIMIT)
        .ok_or("account-catalog-invalid")?;
    let mut result = Vec::with_capacity(rows.len());
    let mut ids = HashSet::new();
    let mut skipped = 0;
    for row in rows {
        check(owner, deadline)?;
        // One bad row never costs the good channels (XC-014): it is counted
        // and left out. Only account-level problems stop the import.
        match live_row(
            row, account, origin, base, username, password, auth, cats, policy,
        )? {
            Some(entry) if ids.insert(entry.provider_id.clone().unwrap_or_default()) => {
                result.push(entry)
            }
            _ => skipped += 1,
        }
    }
    if result.is_empty() {
        return Err("account-catalog-invalid".into());
    }
    Ok((result, skipped))
}
/// One live row: `Ok(None)` when the row itself is unusable, `Err` only for
/// what concerns the whole account (no stream format, unusable sign-in path).
#[allow(clippy::too_many_arguments)]
fn live_row(
    row: &Value,
    account: &str,
    origin: &str,
    base: &str,
    username: &str,
    password: &str,
    auth: &Auth,
    cats: &HashMap<String, String>,
    policy: &DisplayPolicy,
) -> Result<Option<PreparedEntry>, String> {
    if row
        .get("stream_type")
        .and_then(Value::as_str)
        .is_some_and(|v| v != "live")
    {
        return Ok(None);
    }
    let Some(Ok(provider)) = row.get("stream_id").map(id) else {
        return Ok(None);
    };
    let Some(Ok(name)) = row
        .get("name")
        .and_then(Value::as_str)
        .map(|v| policy.text(v, TEXT_LIMIT, false))
    else {
        return Ok(None);
    };
    // A group the provider did not list keeps its channel (XC-015).
    let category = match row.get("category_id") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(v)) if v.is_empty() => String::new(),
        Some(v) => id(v)
            .ok()
            .and_then(|key| cats.get(&key).cloned())
            .unwrap_or_else(|| "Uncategorised".into()),
    };
    // An unusable guide id means no guide for this channel, not no channel.
    let epg_id = match row.get("epg_channel_id") {
        Some(Value::String(v)) if !v.trim().is_empty() => policy.text(v, TEXT_LIMIT, false).ok(),
        _ => None,
    };
    let mut backups = Vec::new();
    let media = match row.get("direct_source") {
        Some(Value::String(v)) if !v.is_empty() => match address(v, origin) {
            Ok(url) => url,
            Err(_) => return Ok(None),
        },
        None | Some(Value::Null) | Some(Value::String(_)) => {
            let extension = auth.format.as_ref().ok_or("account-live-format-required")?;
            // URL segment mutation normalizes standalone dot segments; do
            // not silently change the provider's literal credential value.
            if matches!(username, "." | "..") || matches!(password, "." | "..") {
                return Err("account-login-path-invalid".into());
            }
            let primary = live_address(base, origin, username, password, &provider, extension)?;
            if let Some(other) = auth.alternate.as_deref() {
                backups.push(Zeroizing::new(
                    live_address(base, origin, username, password, &provider, other)?.to_string(),
                ));
            }
            primary
        }
        _ => return Ok(None),
    };
    Ok(Some(PreparedEntry {
        stable_id: stable(account, "xtream", &[&provider]),
        provider_id: Some(provider),
        name,
        category,
        epg_id,
        media_url: Zeroizing::new(media.to_string()),
        backup_urls: backups,
    }))
}

// Strict extended-M3U metadata parser; attributes are inert native data. No
// source extension guessing, credential URL fallback, or unsupported truncation.
fn attributes(raw: &str) -> Result<HashMap<String, String>, String> {
    static ATTRIBUTES: OnceLock<Result<regex::Regex, regex::Error>> = OnceLock::new();
    let regex = ATTRIBUTES
        .get_or_init(|| regex::Regex::new(r#"^\s+([\w-]+)=(?:"([^"]*)"|([^\s"]+))"#))
        .as_ref()
        .map_err(|_| "account-playlist-invalid")?;
    let mut rest = raw;
    let mut result = HashMap::new();
    while !rest.trim().is_empty() {
        let m = regex.captures(rest).ok_or("account-playlist-invalid")?;
        let key = m
            .get(1)
            .ok_or("account-playlist-invalid")?
            .as_str()
            .to_ascii_lowercase();
        let value = m
            .get(2)
            .or_else(|| m.get(3))
            .ok_or("account-playlist-invalid")?
            .as_str()
            .to_owned();
        if result.insert(key, value).is_some() {
            return Err("account-playlist-invalid".into());
        }
        rest = &rest[m.get(0).ok_or("account-playlist-invalid")?.end()..];
    }
    Ok(result)
}
/// Admit one playlist entry. An identical repeat (same stable identity: name,
/// ID and group) is the same channel, so its address becomes a backup of the
/// first entry instead of a second, ambiguous channel. Returns true if merged.
fn admit_entry(
    entries: &mut Vec<PreparedEntry>,
    identities: &mut HashMap<String, usize>,
    entry: PreparedEntry,
) -> Result<bool, String> {
    let Some(&index) = identities.get(&entry.stable_id) else {
        identities.insert(entry.stable_id.clone(), entries.len());
        entries.push(entry);
        return Ok(false);
    };
    let first = &mut entries[index];
    let address = entry.media_url;
    if first.media_url.as_str() != address.as_str()
        && !first
            .backup_urls
            .iter()
            .any(|u| u.as_str() == address.as_str())
    {
        if first.backup_urls.len() >= 15 {
            return Err("account-playlist-identity-ambiguous".into());
        }
        first.backup_urls.push(address);
    }
    Ok(true)
}
/// The playlist header's guide address (`x-tvg-url` or `url-tvg`), on the
/// account's own server only.
fn header_guide(tail: &str, origin: &str) -> Result<Option<Zeroizing<String>>, String> {
    let header_attrs = attributes(tail)?;
    let mut guide = None;
    for key in ["x-tvg-url", "url-tvg"] {
        if let Some(raw) = header_attrs.get(key) {
            if guide.is_some() || raw.contains(',') {
                return Err("account-guide-reference-ambiguous".into());
            }
            guide = Some(Zeroizing::new(address(raw, origin)?.to_string()));
        }
    }
    Ok(guide)
}
/// Where this account's provider publishes its program guide: Xtream's
/// `xmltv.php`, or the playlist header's guide address. None means the
/// provider offers no guide for this account.
pub(crate) async fn guide_address(
    resolved: &Resolved,
    owner: &Context,
) -> Result<Option<Url>, String> {
    let origin = &resolved.metadata.server_origin;
    match &resolved.secret {
        Secret::Xtream {
            server_url,
            username,
            password,
        } => endpoint(server_url, "xmltv.php", username, password, None, origin).map(Some),
        Secret::Playlist { url } => {
            let deadline = Instant::now() + Duration::from_secs(20);
            let mut budget = BODY_LIMIT;
            let bytes = fetch(
                address(url, origin)?,
                origin,
                &mut budget,
                BODY_LIMIT,
                owner,
                deadline,
            )
            .await?;
            let head = &bytes[..bytes.len().min(LINE_LIMIT + 4)];
            let text = match std::str::from_utf8(head) {
                Ok(text) => text,
                Err(e) => std::str::from_utf8(&head[..e.valid_up_to()])
                    .map_err(|_| "account-playlist-encoding-invalid")?,
            }
            .trim_start_matches('\u{feff}');
            let header = text
                .lines()
                .next()
                .ok_or("account-playlist-invalid")?
                .trim();
            let tail = header
                .strip_prefix("#EXTM3U")
                .filter(|v| v.is_empty() || v.starts_with([' ', '\t']))
                .ok_or("account-playlist-invalid")?;
            match header_guide(tail, origin)? {
                Some(raw) => Ok(Some(address(&raw, origin)?)),
                None => Ok(None),
            }
        }
    }
}
fn playlist(
    bytes: &[u8],
    account: &str,
    origin: &str,
    policy: &DisplayPolicy,
    owner: &Context,
    deadline: Instant,
) -> Result<(Vec<PreparedEntry>, Option<Zeroizing<String>>, usize), String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "account-playlist-encoding-invalid")?
        .trim_start_matches('\u{feff}');
    let mut lines = text.lines();
    let header = lines.next().ok_or("account-playlist-invalid")?.trim();
    let tail = header
        .strip_prefix("#EXTM3U")
        .filter(|v| v.is_empty() || v.starts_with([' ', '\t']))
        .ok_or("account-playlist-invalid")?;
    if header.len() > LINE_LIMIT {
        return Err("account-playlist-line-too-large".into());
    }
    let guide = header_guide(tail, origin)?;
    let mut entries = Vec::new();
    let mut pending = None;
    let duration =
        regex::Regex::new(r"^-?\d+(?:\.\d+)?").map_err(|_| "account-playlist-invalid")?;
    let mut identities = HashMap::<String, usize>::new();
    let mut provider_counts = HashMap::<String, usize>::new();
    // One malformed entry never costs the good channels (XC-014, XC-017): it
    // is counted and left out. `Some(None)` is a header whose address is skipped.
    let mut skipped = 0;
    for line in lines {
        check(owner, deadline)?;
        let line = line.trim();
        if line.len() > LINE_LIMIT || line.chars().any(|c| c.is_control() && c != '\t') {
            return Err("account-playlist-line-too-large".into());
        }
        if line.is_empty() {
            continue;
        }
        if let Some(raw) = line.strip_prefix("#EXTINF:") {
            if pending.take().is_some() {
                // The previous entry never got its address.
                skipped += 1;
            }
            let mut quoted = false;
            let comma = raw.char_indices().find_map(|(i, c)| {
                if c == '"' {
                    quoted = !quoted;
                }
                if c == ',' && !quoted {
                    Some(i)
                } else {
                    None
                }
            });
            let header = comma.and_then(|comma| {
                let info = raw[..comma].trim();
                let d = duration.find(info)?;
                let attrs = attributes(&info[d.end()..]).ok()?;
                let name = policy.text(&raw[comma + 1..], TEXT_LIMIT, false).ok()?;
                Some((attrs, name))
            });
            pending = Some(header);
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let Some(header) = pending.take() else {
            // An address with no entry header before it.
            skipped += 1;
            continue;
        };
        let Some((attrs, name)) = header else {
            skipped += 1;
            continue;
        };
        if entries.len() >= ENTRY_LIMIT {
            return Err("account-catalog-too-large".into());
        }
        let Ok(media) = address(line, origin) else {
            // Another server, or an unusable address: this entry only.
            skipped += 1;
            continue;
        };
        // A tvg-id that cannot be shown is dropped; the channel stays.
        let provider_id = attrs
            .get("tvg-id")
            .filter(|v| !v.trim().is_empty())
            .and_then(|v| policy.text(v, TEXT_LIMIT, false).ok());
        if let Some(id) = &provider_id {
            *provider_counts.entry(id.clone()).or_default() += 1;
        }
        let category = policy
            .text(
                attrs.get("group-title").map(String::as_str).unwrap_or(""),
                TEXT_LIMIT,
                true,
            )
            .unwrap_or_else(|_| "Uncategorised".into());
        // Stable through token/URL rotation. Ambiguous identity is refused rather
        // than merged by array position or a credential-bearing URL hash.
        let identity = match &provider_id {
            Some(id) => stable(account, "playlist-provider", &[id, &name, &category]),
            None => stable(account, "playlist-metadata", &[&name, &category]),
        };
        let Ok(merged) = admit_entry(
            &mut entries,
            &mut identities,
            PreparedEntry {
                stable_id: identity,
                epg_id: provider_id.clone(),
                provider_id: provider_id.clone(),
                name,
                category,
                media_url: Zeroizing::new(media.to_string()),
                backup_urls: Vec::new(),
            },
        ) else {
            skipped += 1;
            continue;
        };
        if merged {
            if let Some(count) = provider_id.and_then(|id| provider_counts.get_mut(&id)) {
                *count -= 1;
            }
        }
    }
    if pending.is_some() {
        skipped += 1;
    }
    if entries.is_empty() {
        return Err("account-playlist-entry-invalid".into());
    }
    for entry in &mut entries {
        check(owner, deadline)?;
        if let Some(id) = &entry.provider_id {
            if provider_counts.get(id) == Some(&1) {
                entry.stable_id = stable(account, "playlist-provider", &[id]);
            }
        }
    }
    Ok((entries, guide, skipped))
}

/// One total 20-second episode, sequential bounded requests, no automatic retry
/// or probing. CPU parsing is joined off the viewing thread, including on cancel.
pub(crate) async fn acquire(
    resolved: &Resolved,
    owner: Arc<Context>,
    now_ms: u64,
) -> Result<PreparedCatalog, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    check(&owner, deadline)?;
    let mut budget = BODY_LIMIT;
    let origin = &resolved.metadata.server_origin;
    let policy = DisplayPolicy::new(&resolved.secret);
    let account = resolved.metadata.id.clone();
    let revision = resolved.metadata.revision;
    let result = match &resolved.secret {
        Secret::Playlist { url } => {
            let bytes = fetch(
                address(url, origin)?,
                origin,
                &mut budget,
                BODY_LIMIT,
                &owner,
                deadline,
            )
            .await?;
            let parse_owner = owner.clone();
            let parse_account = account.clone();
            let parse_origin = origin.clone();
            let (entries, guide, skipped) = tauri::async_runtime::spawn_blocking(move || {
                playlist(
                    &bytes,
                    &parse_account,
                    &parse_origin,
                    &policy,
                    &parse_owner,
                    deadline,
                )
            })
            .await
            .map_err(|_| "account-parser-failed")??;
            PreparedCatalog {
                account_id: account,
                account_revision: revision,
                entries,
                skipped,
                supplied_guide: guide,
                max_connections: None,
                active_connections: None,
            }
        }
        Secret::Xtream {
            server_url,
            username,
            password,
        } => {
            let auth_bytes = fetch(
                endpoint(
                    server_url,
                    "player_api.php",
                    username,
                    password,
                    None,
                    origin,
                )?,
                origin,
                &mut budget,
                256 * 1024,
                &owner,
                deadline,
            )
            .await?;
            let auth = tauri::async_runtime::spawn_blocking(move || login(&auth_bytes, now_ms))
                .await
                .map_err(|_| "account-parser-failed")??;
            check(&owner, deadline)?;
            let category_bytes = fetch(
                endpoint(
                    server_url,
                    "player_api.php",
                    username,
                    password,
                    Some("get_live_categories"),
                    origin,
                )?,
                origin,
                &mut budget,
                2 * 1024 * 1024,
                &owner,
                deadline,
            )
            .await?;
            let bytes = fetch(
                endpoint(
                    server_url,
                    "player_api.php",
                    username,
                    password,
                    Some("get_live_streams"),
                    origin,
                )?,
                origin,
                &mut budget,
                BODY_LIMIT,
                &owner,
                deadline,
            )
            .await?;
            let guide = endpoint(server_url, "xmltv.php", username, password, None, origin)?;
            let parse_owner = owner.clone();
            let parse_account = account.clone();
            let parse_origin = origin.clone();
            let base = Zeroizing::new(server_url.clone());
            let user = Zeroizing::new(username.clone());
            let pass = Zeroizing::new(password.clone());
            let max = auth.max;
            let active = auth.active;
            let (entries, skipped) = tauri::async_runtime::spawn_blocking(move || {
                let cats = categories(&category_bytes, &policy, &parse_owner, deadline)?;
                xtream_entries(
                    &bytes,
                    &parse_account,
                    &parse_origin,
                    &base,
                    &user,
                    &pass,
                    &auth,
                    &cats,
                    &policy,
                    &parse_owner,
                    deadline,
                )
            })
            .await
            .map_err(|_| "account-parser-failed")??;
            PreparedCatalog {
                account_id: account,
                account_revision: revision,
                entries,
                skipped,
                supplied_guide: Some(Zeroizing::new(guide.to_string())),
                max_connections: max,
                active_connections: active,
            }
        }
    };
    check(&owner, deadline)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_redirects_may_change_server_but_never_downgrade() {
        let url = |raw: &str| Url::parse(raw).unwrap();
        // An HTTP account (explicit grant) whose front door hands the sign-in
        // to the provider's real server, as smartdns -> cf.onvpn did.
        let http = "http://front.fixture.example";
        assert!(redirect_target(
            &url("http://real.fixture.example/player_api.php?username=u&password=p"),
            http
        )
        .is_ok());
        assert!(redirect_target(&url("https://real.fixture.example:8443/get.php"), http).is_ok());
        // An HTTPS account: another HTTPS server is followed, plain HTTP is not.
        let https = "https://front.fixture.example";
        assert!(redirect_target(&url("https://lb1.fixture.example/player_api.php"), https).is_ok());
        assert!(redirect_target(&url("http://lb1.fixture.example/player_api.php"), https).is_err());
        // Never a private or loopback address, embedded user info or another scheme.
        assert!(redirect_target(&url("http://192.168.1.10/player_api.php"), http).is_err());
        assert!(redirect_target(&url("http://127.0.0.1:8080/player_api.php"), http).is_err());
        assert!(redirect_target(&url("http://u:p@real.fixture.example/x"), http).is_err());
        assert!(redirect_target(&url("ftp://real.fixture.example/x"), http).is_err());
    }
    #[test]
    fn request_preserves_base_port_and_escaped_credentials() {
        let url = endpoint(
            "https://fixture.invalid:8443/provider/base",
            "player_api.php",
            "fixture user&name",
            "fixture/pass?#",
            Some("get_live_streams"),
            "https://fixture.invalid:8443",
        )
        .unwrap();
        assert_eq!(url.port(), Some(8443));
        assert_eq!(url.path(), "/provider/base/player_api.php");
        let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs.get("username").unwrap(), "fixture user&name");
        assert_eq!(pairs.get("password").unwrap(), "fixture/pass?#");
        // An HTTPS account is never downgraded, including by a redirect.
        assert!(address("http://fixture.invalid/token", "https://fixture.invalid").is_err());
        // An HTTP account (explicit grant, stored HTTP origin) keeps its exact port.
        let plain = endpoint(
            "http://fixture.invalid:8080",
            "player_api.php",
            "u",
            "p",
            None,
            "http://fixture.invalid:8080",
        )
        .unwrap();
        assert_eq!((plain.scheme(), plain.port()), ("http", Some(8080)));
        assert!(address(
            "http://fixture.invalid:8080/live/x.ts",
            "http://fixture.invalid:8080"
        )
        .is_ok());
        assert!(address(
            "http://fixture.invalid/live/x.ts",
            "http://fixture.invalid:8080"
        )
        .is_err());
        assert!(address(
            "https://fixture.invalid:8080/x",
            "http://fixture.invalid:8080"
        )
        .is_err());
        assert!(address("https://other.invalid/token", "https://fixture.invalid").is_err());
        assert!(address("https://127.0.0.1/token", "https://127.0.0.1").is_err());
    }
    #[test]
    fn authentication_status_and_expiry_are_not_network_success() {
        let active = br#"{"user_info":{"auth":1,"status":"Active","exp_date":"2000","allowed_output_formats":["ts","m3u8"],"max_connections":"1","active_cons":"0"}}"#;
        let auth = login(active, 1_000_000).unwrap();
        assert_eq!(auth.format.as_deref(), Some("ts"));
        let hls_only =
            br#"{"user_info":{"auth":1,"status":"Active","allowed_output_formats":["m3u8"]}}"#;
        assert_eq!(login(hls_only, 0).unwrap().format.as_deref(), Some("m3u8"));
        // The provider's other advertised format is kept for a fallback only.
        assert_eq!(auth.alternate.as_deref(), Some("m3u8"));
        assert_eq!(login(hls_only, 0).unwrap().alternate, None);
        let base = "http://tv.fixture.example:8080/prefix";
        let origin = "http://tv.fixture.example:8080";
        let ts = live_address(base, origin, "u", "p&w", "7", "ts").unwrap();
        let hls = live_address(base, origin, "u", "p&w", "7", "m3u8").unwrap();
        assert_eq!(ts.path(), "/prefix/live/u/p&w/7.ts");
        assert_eq!(hls.path(), "/prefix/live/u/p&w/7.m3u8");
        assert_eq!(auth.max, Some(1));
        assert!(login(active, 2_000_000).is_err());
        assert!(login(br#"{"user_info":{"auth":0,"status":"Active"}}"#, 0).is_err());
        assert!(login(br#"{"user_info":{"auth":1,"status":"Expired"}}"#, 0).is_err());
        assert!(login(
            br#"{"user_info":{"auth":1,"status":"Active","allowed_output_formats":[1]}}"#,
            0
        )
        .is_err());
    }
    #[test]
    fn stable_ids_are_account_scoped_and_metadata_refuses_secret_markers() {
        assert_eq!(
            stable("a", "xtream", &["15"]),
            stable("a", "xtream", &["15"])
        );
        assert_ne!(
            stable("a", "xtream", &["15"]),
            stable("b", "xtream", &["15"])
        );
        let secret = Secret::Playlist {
            url: "https://fixture.invalid/secret-path?token=secret-query".into(),
        };
        let policy = DisplayPolicy::new(&secret);
        assert!(policy
            .text("Visible secret-query", TEXT_LIMIT, false)
            .is_err());
        assert!(policy
            .text("Visible secret-path", TEXT_LIMIT, false)
            .is_err());
        assert_eq!(
            policy.text("Fixture Channel", TEXT_LIMIT, false).unwrap(),
            "Fixture Channel"
        );
    }
}

#[cfg(test)]
mod playlist_marker_tests {
    use super::*;
    #[test]
    fn protocol_options_are_not_secrets_but_credentials_still_are() {
        // Same shape as a provider's get.php link; placeholder credentials.
        let secret = Secret::Playlist {
            url: "http://tv.fixture.invalid:8099/get.php?username=fixtureuser&password=fixturepass&type=m3u_plus&output=ts".into(),
        };
        let policy = DisplayPolicy::new(&secret);
        for name in ["US: ESPN Sports", "Nickelodeon Hits", "M3U Plus News"] {
            assert!(policy.text(name, TEXT_LIMIT, false).is_ok(), "{name}");
        }
        for leak in ["fixtureuser live", "pw fixturepass"] {
            assert!(policy.text(leak, TEXT_LIMIT, false).is_err(), "{leak}");
        }
    }
}

#[cfg(test)]
mod duplicate_entry_tests {
    use super::*;
    fn entry(id: &str, url: &str) -> PreparedEntry {
        PreparedEntry {
            stable_id: id.into(),
            provider_id: None,
            name: "Channel".into(),
            category: "Group".into(),
            epg_id: None,
            media_url: Zeroizing::new(url.into()),
            backup_urls: Vec::new(),
        }
    }
    #[test]
    fn identical_repeats_become_backups_never_extra_channels() {
        let (mut entries, mut ids) = (Vec::new(), HashMap::new());
        assert!(!admit_entry(&mut entries, &mut ids, entry("a", "http://x.invalid/1")).unwrap());
        assert!(admit_entry(&mut entries, &mut ids, entry("a", "http://x.invalid/2")).unwrap());
        // An exact repeat of an address adds nothing.
        assert!(admit_entry(&mut entries, &mut ids, entry("a", "http://x.invalid/2")).unwrap());
        assert!(!admit_entry(&mut entries, &mut ids, entry("b", "http://x.invalid/3")).unwrap());
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].backup_urls.len(), 1);
        assert_eq!(entries[0].backup_urls[0].as_str(), "http://x.invalid/2");
        // Bounded: 1 + 15 addresses per channel, then refused rather than truncated.
        for i in 0..14 {
            admit_entry(
                &mut entries,
                &mut ids,
                entry("a", &format!("http://x.invalid/a{i}")),
            )
            .unwrap();
        }
        assert!(admit_entry(&mut entries, &mut ids, entry("a", "http://x.invalid/over")).is_err());
    }
}

#[cfg(test)]
mod tolerance_tests {
    use super::*;
    fn auth() -> Auth {
        Auth {
            format: Some("ts".into()),
            alternate: None,
            max: None,
            active: None,
        }
    }
    fn parse(rows: &str) -> Result<(Vec<PreparedEntry>, usize), String> {
        let secret = Secret::Xtream {
            server_url: "http://tv.fixture.example".into(),
            username: "fixtureuser".into(),
            password: "fixturepass".into(),
        };
        let policy = DisplayPolicy::new(&secret);
        let (_root, context, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        let cats: HashMap<String, String> = [("1".to_string(), "US| NFL PPV".to_string())].into();
        xtream_entries(
            rows.as_bytes(),
            "account",
            "http://tv.fixture.example",
            "http://tv.fixture.example",
            "fixtureuser",
            "fixturepass",
            &auth(),
            &cats,
            &policy,
            &context,
            Instant::now() + Duration::from_secs(20),
        )
    }
    #[test]
    fn one_bad_row_never_costs_the_good_channels() {
        let rows = r#"[
            {"stream_id": 1, "name": "Good One", "category_id": "1", "stream_type": "live"},
            {"stream_id": "2", "name": "Good Two", "category_id": 1},
            {"stream_id": 3.0, "name": "Decimal id", "category_id": "1"},
            {"stream_id": 4, "name": "Unknown group", "category_id": "999"},
            {"stream_id": 5, "name": "Odd guide id", "epg_channel_id": 7},
            {"stream_id": 6, "name": "A radio", "stream_type": "radio_streams"},
            {"stream_id": 1, "name": "Repeated id"},
            {"name": "No id"},
            {"stream_id": "x9", "name": "Bad id"},
            {"stream_id": 8},
            {"stream_id": 9, "name": "fixturepass leak"},
            {"stream_id": 10, "name": "Foreign direct", "direct_source": "http://other.fixture.example/x.ts"}
        ]"#;
        let (entries, skipped) = parse(rows).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Good One",
                "Good Two",
                "Decimal id",
                "Unknown group",
                "Odd guide id"
            ]
        );
        assert_eq!(skipped, 7);
        assert_eq!(entries[2].provider_id.as_deref(), Some("3"));
        assert!(entries[2].media_url.ends_with("/3.ts"));
        assert_eq!(entries[3].category, "Uncategorised");
        assert_eq!(entries[4].epg_id, None);
        // Nothing skipped shows its sign-in text anywhere.
        assert!(!entries.iter().any(|e| e.name.contains("fixturepass")));
    }
    #[test]
    fn whole_document_problems_still_refuse_the_import() {
        assert!(parse("not json").is_err());
        assert!(parse("{}").is_err());
        // Empty stays refused: more likely a provider error than an empty
        // account, and it must not replace a saved library (XC-019).
        assert!(parse("[]").is_err());
        // Nothing usable at all is a failed import, not an empty success.
        assert!(parse(
            r#"[{"name": "No id"}, {"stream_id": 6, "stream_type": "radio_streams", "name": "r"}]"#
        )
        .is_err());
    }
}

#[cfg(test)]
mod playlist_tolerance_tests {
    use super::*;
    fn parse(text: &str) -> Result<(Vec<PreparedEntry>, Option<Zeroizing<String>>, usize), String> {
        let secret = Secret::Playlist {
            url: "http://tv.fixture.example/get.php?username=fixtureuser&password=fixturepass&type=m3u_plus".into(),
        };
        let policy = DisplayPolicy::new(&secret);
        let (_root, context, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        playlist(
            text.as_bytes(),
            "account",
            "http://tv.fixture.example",
            &policy,
            &context,
            Instant::now() + Duration::from_secs(20),
        )
    }
    #[test]
    fn one_malformed_entry_never_costs_the_good_channels() {
        let text = "\u{feff}#EXTM3U\r\n\
            #EXTINF:-1 tvg-id=\"one\" group-title=\"News\",One, with a comma\r\n\
            http://tv.fixture.example/live/1.ts\r\n\
            #EXTINF:no-duration,Broken header\r\n\
            http://tv.fixture.example/live/2.ts\r\n\
            http://tv.fixture.example/live/orphan.ts\r\n\
            #EXTINF:-1 group-title=\"Sports\",Two\r\n\
            http://tv.fixture.example/live/3.ts\r\n\
            #EXTINF:-1,fixturepass leak\r\n\
            http://tv.fixture.example/live/4.ts\r\n\
            #EXTINF:-1 tvg-id=\"fixturepass\",Three keeps its channel\r\n\
            http://tv.fixture.example/live/5.ts\r\n\
            #EXTINF:-1,Elsewhere\r\n\
            http://other.fixture.example/live/6.ts\r\n\
            #EXTINF:-1,Lost its address\r\n\
            #EXTINF:-1,Four\r\n\
            http://tv.fixture.example/live/7.ts\r\n\
            #EXTINF:-1,Trailing without address";
        let (entries, _, skipped) = parse(text).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "One, with a comma",
                "Two",
                "Three keeps its channel",
                "Four"
            ]
        );
        // Broken header (+its address), orphan address, leaked name, other
        // server, lost address, trailing entry.
        assert_eq!(skipped, 6);
        assert_eq!(entries[0].category, "News");
        assert_eq!(
            entries[2].provider_id, None,
            "a tainted tvg-id is dropped, not shown"
        );
    }
    #[test]
    fn whole_file_problems_still_refuse_the_import() {
        assert!(parse("<html>login</html>").is_err());
        assert!(parse("#EXTM3U\n").is_err());
        assert!(parse("#EXTM3U\n#EXTINF:-1,Only broken\n").is_err());
    }
}
