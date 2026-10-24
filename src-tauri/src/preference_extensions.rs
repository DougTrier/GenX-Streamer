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

//! Optional user-reviewed provider/region metadata. No engine defaults or acquisition.
use serde_json::{json, Value};
use std::collections::HashSet;
fn field(value: &Value, key: &str, max: usize) -> Result<String, String> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or("record-invalid-provider")?;
    if text.trim().is_empty()
        || text.len() > max
        || text.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}')
    {
        return Err("record-invalid-provider".into());
    }
    Ok(text.into())
}
fn location(text: &str, allow_http: bool) -> Result<String, String> {
    let lower = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    if !(lower.starts_with("https://") || lower.starts_with("http://"))
        || text.chars().any(char::is_whitespace)
        || text.contains(['\\', '#'])
        || bytes.iter().enumerate().any(|(i, b)| {
            *b == b'%'
                && (i + 2 >= bytes.len()
                    || !bytes[i + 1].is_ascii_hexdigit()
                    || !bytes[i + 2].is_ascii_hexdigit())
        })
    {
        return Err("record-invalid-provider-url".into());
    }
    let parsed = reqwest::Url::parse(text).map_err(|_| "record-invalid-provider-url")?;
    if parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !(parsed.scheme() == "https" || (parsed.scheme() == "http" && allow_http))
    {
        return Err("record-invalid-provider-url".into());
    }
    Ok(parsed.into())
}
fn providers(input: &Value, guide: bool) -> Result<Value, String> {
    let array = input.as_array().ok_or("record-invalid-provider-array")?;
    if array.len() > if guide { 1000 } else { 100 } {
        return Err("record-provider-limit".into());
    }
    let mut ids = HashSet::new();
    let mut urls = HashSet::new();
    let mut result = Vec::new();
    for entry in array {
        let object = entry.as_object().ok_or("record-invalid-provider")?;
        if object.keys().any(|key| {
            !(matches!(key.as_str(), "id" | "name" | "location" | "provenance")
                || (guide && key == "limitations")
                || (!guide && key == "allowHttp"))
        }) {
            return Err("record-invalid-provider-field".into());
        }
        let id = field(entry, "id", 256)?;
        let name = field(entry, "name", 512)?;
        let http = entry
            .get("allowHttp")
            .map(|v| v.as_bool().ok_or("record-invalid-provider-http"))
            .transpose()?
            .unwrap_or(false);
        let url = location(&field(entry, "location", 16384)?, http)?;
        let provenance = location(&field(entry, "provenance", 2048)?, false)?;
        if url.len() > 16384 || provenance.len() > 2048 {
            return Err("record-invalid-provider-url".into());
        }
        if !ids.insert(id.clone()) || !urls.insert(url.clone()) {
            return Err("record-duplicate-provider".into());
        }
        let mut normalized = json!({"id":id,"name":name,"location":url,"provenance":provenance});
        if guide {
            normalized["limitations"] = json!(field(entry, "limitations", 2048)?);
        } else {
            normalized["allowHttp"] = json!(http);
        }
        result.push(normalized);
    }
    Ok(Value::Array(result))
}
pub(super) fn normalize(preferences: &mut Value) -> Result<(), String> {
    if preferences
        .get("contentLibrary")
        .is_some_and(|value| !matches!(value.as_str(), Some("live" | "genxtra")))
    {
        return Err("record-invalid-content-library".into());
    }
    if preferences
        .get("automaticGuideUpdates")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err("record-invalid-automatic-guide-updates".into());
    }
    if let Some(overrides) = preferences.get("channelCategoryOverrides") {
        super::channel_categories::validate(Some(overrides))?;
    }
    if preferences
        .get("voiceSearchConsent")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err("record-invalid-voice-consent".into());
    }
    for (key, guide) in [
        ("reviewedChannelProviders", false),
        ("reviewedGuideProviders", true),
    ] {
        if let Some(input) = preferences.get(key) {
            preferences[key] = providers(input, guide)?;
        }
    }
    if let Some(region) = preferences.get("preferredRegion") {
        let object = region
            .as_object()
            .ok_or("record-invalid-preferred-region")?;
        if object
            .keys()
            .any(|k| !matches!(k.as_str(), "country" | "state" | "postal" | "origin"))
        {
            return Err("record-invalid-preferred-region".into());
        }
        let country = region
            .get("country")
            .and_then(Value::as_str)
            .ok_or("record-invalid-preferred-region")?;
        if country.len() != 2
            || !country.bytes().all(|b| b.is_ascii_uppercase())
            || !matches!(
                region.get("origin").and_then(Value::as_str),
                Some("manual" | "ip")
            )
        {
            return Err("record-invalid-preferred-region".into());
        }
        if region.get("postal").is_some() {
            field(region, "postal", 32).map_err(|_| "record-invalid-preferred-region")?;
        }
        if let Some(state) = region.get("state") {
            let state = state.as_str().ok_or("record-invalid-preferred-region")?;
            let suffix = state
                .strip_prefix(country)
                .and_then(|v| v.strip_prefix('-'))
                .ok_or("record-invalid-preferred-region")?;
            if suffix.is_empty()
                || suffix.len() > 8
                || !suffix
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            {
                return Err("record-invalid-preferred-region".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_library_validation_preserves_legacy_and_explicit_choices() {
        let mut legacy = json!({});
        normalize(&mut legacy).unwrap();
        assert!(legacy.get("contentLibrary").is_none());
        for choice in ["live", "genxtra"] {
            let mut value = json!({"contentLibrary": choice});
            normalize(&mut value).unwrap();
            assert_eq!(value["contentLibrary"], choice);
        }
        for bad in [
            json!(null),
            json!("archive"),
            json!(""),
            json!(false),
            json!(1),
            json!({}),
            json!([]),
        ] {
            let mut value = json!({"contentLibrary": bad});
            assert_eq!(
                normalize(&mut value).unwrap_err(),
                "record-invalid-content-library"
            );
        }
    }
}
