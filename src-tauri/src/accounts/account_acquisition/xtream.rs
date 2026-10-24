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

//! Reading an Xtream Codes account: login, categories, live entries and the
//! guide address.

use super::*;

pub(super) fn login(bytes: &[u8], now_ms: u64) -> Result<Auth, String> {
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
    // Only validated: a malformed connection count marks a broken login reply.
    number(user.get("active_cons"), 1000)?;
    Ok(Auth {
        format,
        alternate,
        max: number(user.get("max_connections"), 1000)?.map(|v| v as u32),
    })
}

/// An Xtream live address: base path kept, each part one escaped segment.
pub(super) fn live_address(
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

pub(super) fn stable(account: &str, domain: &str, parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in [account, domain].into_iter().chain(parts.iter().copied()) {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part.as_bytes());
    }
    format!("account-{account}-{:x}", hash.finalize())
}

pub(super) fn categories(
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

/// What every live-channel row of one account is read against: the account,
/// where its playlist came from, the provider sign-in, the category names and
/// how names are displayed.
#[derive(Clone, Copy)]
pub(super) struct LiveContext<'a> {
    pub(super) account: &'a str,
    pub(super) origin: &'a str,
    pub(super) base: &'a str,
    pub(super) username: &'a str,
    pub(super) password: &'a str,
    pub(super) auth: &'a Auth,
    pub(super) cats: &'a HashMap<String, String>,
    pub(super) policy: &'a DisplayPolicy,
}

pub(super) fn xtream_entries(
    bytes: &[u8],
    live: LiveContext<'_>,
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
        match live_row(row, live)? {
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
pub(super) fn live_row(
    row: &Value,
    live: LiveContext<'_>,
) -> Result<Option<PreparedEntry>, String> {
    let LiveContext {
        account,
        origin,
        base,
        username,
        password,
        auth,
        cats,
        policy,
    } = live;
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
pub(super) fn attributes(raw: &str) -> Result<HashMap<String, String>, String> {
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
pub(super) fn admit_entry(
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
pub(super) fn header_guide(tail: &str, origin: &str) -> Result<Option<Zeroizing<String>>, String> {
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
