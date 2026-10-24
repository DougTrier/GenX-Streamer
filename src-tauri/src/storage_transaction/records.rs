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

//! Reading and checking stored records: SQL errors, text, arrays, sources,
//! URLs and identities, and validating a catalog before it is saved.

use super::*;

pub(crate) fn sql_error_code(error: &rusqlite::Error, fallback: &'static str) -> String {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DiskFull) => "sqlite-storage-full".into(),
        // Another connection held the database past the busy timeout.
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            "sqlite-busy".into()
        }
        _ => fallback.into(),
    }
}

pub(super) fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|error| sql_error_code(&error, "sqlite-operation-failed"))
}

pub(super) fn text<'a>(
    value: &'a Value,
    field: &str,
    max: usize,
    empty: bool,
) -> Result<&'a str, String> {
    let s = value
        .get(field)
        .and_then(Value::as_str)
        .ok_or("record-invalid-field")?;
    if s.len() > max || (!empty && s.is_empty()) {
        return Err("record-invalid-field".into());
    }
    Ok(s)
}

pub(super) fn array<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a Vec<Value>, String> {
    let a = v
        .get(key)
        .and_then(Value::as_array)
        .ok_or("record-invalid-array")?;
    if a.len() > max {
        return Err("record-array-too-large".into());
    }
    Ok(a)
}

pub(super) fn parse(s: &str) -> Result<Value, String> {
    if s.len() as u64 > LIMIT {
        return Err("record-too-large".into());
    }
    let v: Value = serde_json::from_str(s).map_err(|_| "record-invalid-json")?;
    if v.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("record-unsupported-schema".into());
    }
    Ok(v)
}

pub(super) fn source(v: &Value) -> Result<(), String> {
    text(v, "id", 256, false)?;
    text(v, "name", 512, false)?;
    let location = text(v, "location", 16384, false)?;
    let kind = text(v, "kind", 8, false)?;
    if !matches!(kind, "file" | "url") {
        return Err("record-invalid-source-kind".into());
    }
    if v.get("allowHttp").is_some_and(|x| !x.is_boolean()) {
        return Err("record-invalid-http-grant".into());
    }
    if kind == "url" {
        url(
            location,
            v.get("allowHttp").and_then(Value::as_bool).unwrap_or(false),
        )?;
    }
    if let Some(k) = v.get("contentKind") {
        if !matches!(k.as_str(), Some("catalog" | "hls" | "media")) {
            return Err("record-invalid-content-kind".into());
        }
    }
    if v.get("mediaMime").is_some_and(|m| {
        m.as_str().is_none_or(|s| {
            s.len() > 128
                || !s.split_once('/').is_some_and(|(a, b)| {
                    [a, b].iter().all(|part| {
                        !part.is_empty()
                            && part
                                .bytes()
                                .all(|ch| ch.is_ascii_alphanumeric() || b".+-".contains(&ch))
                    })
                })
        })
    }) {
        return Err("record-invalid-mime".into());
    }
    Ok(())
}

pub(super) fn url(s: &str, http: bool) -> Result<(), String> {
    let u = reqwest::Url::parse(s).map_err(|_| "record-invalid-url")?;
    if s.len() > 16384
        || !u.username().is_empty()
        || u.password().is_some()
        || u.host_str().is_none()
        || !(u.scheme() == "https" || (http && u.scheme() == "http"))
    {
        return Err("record-invalid-url".into());
    }
    Ok(())
}

pub(super) fn identities(v: &Value, key: &str) -> Result<(), String> {
    let empty = Vec::new();
    let a = if key == "removedChannels" && v.get(key).is_none() {
        &empty
    } else {
        array(v, key, 100000)?
    };
    let mut seen = HashSet::new();
    for x in a {
        let s = x.as_str().ok_or("record-invalid-identity")?;
        if s.is_empty() || s.len() > 16384 || !seen.insert(s) {
            return Err("record-invalid-identity".into());
        }
    }
    Ok(())
}

pub(crate) fn validate_checkpoint_catalog(catalog: &Value) -> Result<(), String> {
    validate(&RecordPair {
        catalog: Some(serde_json::to_string(catalog).map_err(|_| "scan-checkpoint-invalid")?),
        preferences: None,
    })
    .map(|_| ())
    .map_err(|_| "scan-checkpoint-invalid".into())
}

pub(super) fn validate(pair: &RecordPair) -> Result<(Option<Value>, Option<Value>), String> {
    let c = pair.catalog.as_deref().map(parse).transpose()?;
    let mut p = pair.preferences.as_deref().map(parse).transpose()?;
    if let Some(pref) = p.as_mut() {
        preference_extensions::normalize(pref)?;
    }
    let mut ids = HashSet::new();
    if let Some(c) = &c {
        let sources = array(c, "sources", 100)?;
        for s in sources {
            source(s)?;
            if !ids.insert(text(s, "id", 256, false)?) {
                return Err("record-duplicate-source".into());
            }
        }
        let mut channels = HashSet::new();
        for ch in array(c, "channels", 100000)? {
            let id = text(ch, "id", 16384, false)?;
            if !channels.insert(id) {
                return Err("record-duplicate-channel".into());
            }
            let sid = text(ch, "sourceId", 256, false)?;
            let source = sources
                .iter()
                .find(|s| s["id"].as_str() == Some(sid))
                .ok_or("record-missing-source")?;
            text(ch, "name", 16384, false)?;
            text(ch, "category", 16384, true)?;
            if ch.get("providerId").is_some() {
                text(ch, "providerId", 16384, false)?;
            }
            geography(ch)?;
            let urls = array(ch, "urls", 16)?;
            if urls.is_empty() {
                return Err("record-missing-url".into());
            }
            let mut unique = HashSet::new();
            for u in urls {
                let s = u.as_str().ok_or("record-invalid-url")?;
                url(s, source["allowHttp"].as_bool().unwrap_or(false))?;
                if !unique.insert(s) {
                    return Err("record-duplicate-url".into());
                }
            }
        }
    }
    if let Some(p) = &p {
        identities(p, "favorites")?;
        identities(p, "removedChannels")?;
        let volume = p
            .get("volume")
            .and_then(Value::as_f64)
            .ok_or("record-invalid-volume")?;
        let width = p
            .get("panelWidth")
            .and_then(Value::as_f64)
            .ok_or("record-invalid-panel")?;
        if !(0.0..=1.0).contains(&volume)
            || !(220.0..=600.0).contains(&width)
            || p.get("muted").and_then(Value::as_bool).is_none()
        {
            return Err("record-invalid-preferences".into());
        }
        if p.get("automaticSourceRefresh")
            .is_some_and(|v| v.as_bool().is_none())
            || p.get("sourceRefreshAttemptAt").is_some_and(|v| {
                v.as_f64().is_none_or(|n| {
                    !n.is_finite()
                        || !(0.0..=8_640_000_000_000_000.0).contains(&n)
                        || n.fract() != 0.0
                })
            })
        {
            return Err("record-invalid-source-refresh".into());
        }
        crate::refresh_cadence::from_preferences(p)?;
        let mut seen = HashSet::new();
        for s in array(p, "sources", 100)? {
            source(s)?;
            if !seen.insert(text(s, "id", 256, false)?) {
                return Err("record-duplicate-source".into());
            }
        }
        // Catalog sources are canonical; preferences mirror is reconstructed on reads.
    }
    if let (Some(catalog), Some(preferences)) = (&c, &p) {
        if catalog["sources"] != preferences["sources"] {
            return Err("record-source-mirror-mismatch".into());
        }
    }
    Ok((c, p))
}
