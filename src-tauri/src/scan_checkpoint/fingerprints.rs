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

//! Revisions and fingerprints of scan checkpoints: sources, policy, published
//! channels and referenced reviews.

use super::*;

pub fn revision(value: &str) -> Result<i64, String> {
    if value.is_empty()
        || !value.bytes().all(|b| b.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err("scan-checkpoint-revision-invalid".into());
    }
    value
        .parse()
        .map_err(|_| "scan-checkpoint-revision-invalid".into())
}

pub(super) fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|error| {
        crate::storage_transaction::sql_error_code(&error, "scan-checkpoint-storage-failed")
    })
}

pub(super) fn object(v: &Value, allowed: &[&str]) -> Result<(), String> {
    let o = v.as_object().ok_or(ERR)?;
    if o.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(ERR.into());
    }
    Ok(())
}

pub(super) fn text<'a>(v: &'a Value, k: &str, max: usize, empty: bool) -> Result<&'a str, String> {
    let s = v[k].as_str().ok_or(ERR)?;
    if s.len() > max || (!empty && s.trim().is_empty()) || s.chars().any(|c| c.is_control()) {
        return Err(ERR.into());
    }
    Ok(s)
}

pub(super) fn list<'a>(v: &'a Value, k: &str, max: usize) -> Result<&'a Vec<Value>, String> {
    let a = v[k].as_array().ok_or(ERR)?;
    if a.len() > max {
        return Err(ERR.into());
    }
    Ok(a)
}

pub(super) fn hash(v: &Value) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(v).map_err(|_| ERR)?)
    ))
}

pub(super) fn safe_url(raw: &str, source: bool, http: bool) -> Result<(), String> {
    let u = reqwest::Url::parse(raw).map_err(|_| ERR)?;
    if !(u.scheme() == "https" || (http && u.scheme() == "http"))
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || (source && u.query().is_some())
    {
        return Err("scan-checkpoint-source-not-resumable".into());
    }
    // Decode percent escapes before checking account credential path grammar.
    let mut decoded = String::new();
    let bytes = u.path().as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|_| ERR)?;
            decoded.push(u8::from_str_radix(hex, 16).map_err(|_| ERR)? as char);
            i += 3
        } else {
            decoded.push(bytes[i] as char);
            i += 1
        }
    }
    let parts: Vec<_> = decoded.split('/').filter(|p| !p.is_empty()).collect();
    if parts.last().is_some_and(|p| {
        matches!(
            p.to_ascii_lowercase().as_str(),
            "get.php" | "player_api.php"
        )
    }) || (parts.len() >= 3
        && matches!(
            parts[0].to_ascii_lowercase().as_str(),
            "live" | "movie" | "series"
        ))
    {
        return Err("scan-checkpoint-source-not-resumable".into());
    }
    Ok(())
}

pub fn source_fingerprint(s: &Value) -> Result<String, String> {
    hash(&json!([
        s["id"],
        s["name"],
        s["kind"],
        s["location"],
        s["allowHttp"].as_bool().unwrap_or(false),
        s.get("contentKind").unwrap_or(&Value::Null),
        s.get("mediaMime").unwrap_or(&Value::Null)
    ]))
}

pub(crate) fn policy_fingerprint(v: &Value, p: &Value) -> Result<String, String> {
    let providers = match p.get("reviewedChannelProviders") {
        None => Value::Null,
        Some(a) => Value::Array(
            a.as_array()
                .ok_or(ERR)?
                .iter()
                .map(|s| {
                    json!([
                        s["id"],
                        s["name"],
                        s["location"],
                        s["provenance"],
                        s["allowHttp"].as_bool().unwrap_or(false)
                    ])
                })
                .collect(),
        ),
    };
    let region = match p.get("preferredRegion") {
        None => Value::Null,
        Some(r) => json!([
            r["country"],
            r.get("state").unwrap_or(&Value::Null),
            r.get("postal").unwrap_or(&Value::Null),
            r["origin"]
        ]),
    };
    let definitions: Vec<_> = list(v, "sourceDefinitions", 100)?
        .iter()
        .map(|d| d["definitionFingerprint"].clone())
        .collect();
    hash(&json!([
        providers,
        region,
        v["budgetMs"],
        v["platform"],
        v["observerProfile"],
        definitions
    ]))
}

pub(super) fn number(v: &Value, k: &str, max: u64) -> Result<u64, String> {
    v[k].as_u64()
        .filter(|n| *n <= max)
        .ok_or_else(|| ERR.into())
}

pub(super) fn published_matches(candidate: &Value, canonical: &Value) -> bool {
    if ["sourceId", "providerId", "name", "category"]
        .iter()
        .any(|k| candidate.get(k) != canonical.get(k))
    {
        return false;
    }
    if candidate.get("geography").is_some_and(|geography| {
        geography.as_object().is_none_or(|fields| {
            fields.iter().any(|(field, value)| {
                canonical.get("geography").and_then(|g| g.get(field)) != Some(value)
            })
        })
    }) || candidate
        .get("geographyProvenance")
        .is_some_and(|value| canonical.get("geographyProvenance") != Some(value))
    {
        return false;
    }
    let Some(urls) = canonical["urls"].as_array() else {
        return false;
    };
    let Some(wanted) = candidate["urls"].as_array() else {
        return false;
    };
    let mut cursor = 0;
    for url in wanted {
        let Some(offset) = urls[cursor..].iter().position(|v| v == url) else {
            return false;
        };
        cursor += offset + 1;
    }
    true
}

pub(super) fn channel_tuple(c: &Value, urls: Value) -> Value {
    let geo = c
        .get("geography")
        .map(|g| {
            json!([
                g.get("country").unwrap_or(&Value::Null),
                g.get("region").unwrap_or(&Value::Null),
                g.get("state").unwrap_or(&Value::Null)
            ])
        })
        .unwrap_or(Value::Null);
    let provenance = c
        .get("geographyProvenance")
        .and_then(Value::as_array)
        .map(|items| {
            Value::Array(
                items
                    .iter()
                    .map(|p| {
                        json!([
                            p["field"],
                            p["value"],
                            p["sourceId"],
                            p.get("providerId").unwrap_or(&Value::Null),
                            p["kind"],
                            p["scope"]
                        ])
                    })
                    .collect(),
            )
        })
        .unwrap_or(Value::Null);
    json!([
        c["sourceId"],
        c.get("providerId").unwrap_or(&Value::Null),
        c["name"],
        c["category"],
        urls,
        geo,
        provenance
    ])
}

pub(super) fn reference_review_digest(review: &Value) -> Result<String, String> {
    let sources: Vec<_> = list(review, "sources", 100)?
        .iter()
        .map(|s| {
            json!([
                s["sourceId"],
                s["fingerprint"],
                s["status"],
                s["inspected"],
                s["matched"],
                s["warnings"]
            ])
        })
        .collect();
    let candidates: Vec<_> = list(review, "candidates", 100_000)?
        .iter()
        .map(|c| {
            json!([
                c["key"],
                c["sourceId"],
                c["sourceFingerprint"],
                c["sessionRevision"],
                channel_tuple(&c["channel"], json!([])),
                c["reference"]["candidateDigest"],
                c["reference"]["urlHashes"]
            ])
        })
        .collect();
    let n = &review["counts"];
    hash(&json!([
        review["sessionRevision"],
        review["query"],
        review["status"],
        sources,
        [
            n["inspected"],
            n["matched"],
            n["failedSources"],
            n["canceledSources"]
        ],
        candidates
    ]))
}

pub(super) fn digest_field(v: &Value, k: &str) -> Result<(), String> {
    let s = text(v, k, 64, false)?;
    if s.len() != 64
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ERR.into());
    }
    Ok(())
}

pub(super) fn reference_metadata(c: &Value) -> Result<(), String> {
    let ch = &c["channel"];
    object(
        ch,
        &[
            "sourceId",
            "providerId",
            "name",
            "category",
            "geography",
            "geographyProvenance",
        ],
    )?;
    text(ch, "sourceId", 256, false)?;
    text(ch, "name", 16_384, false)?;
    text(ch, "category", 16_384, true)?;
    if ch.get("providerId").is_some() {
        text(ch, "providerId", 16_384, false)?;
    }
    if let Some(g) = ch.get("geography") {
        object(g, &["country", "region", "state"])?;
        for (k, max) in [("country", 2), ("region", 32), ("state", 11)] {
            if g.get(k).is_none() {
                continue;
            }
            let value = text(g, k, max, false)?;
            let valid = match k {
                "country" => value.len() == 2 && value.bytes().all(|b| b.is_ascii_uppercase()),
                "region" => value.bytes().all(|b| {
                    b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_' || b == b'-'
                }),
                _ => {
                    value.len() >= 4
                        && g["country"]
                            .as_str()
                            .is_some_and(|country| value.starts_with(&format!("{country}-")))
                        && value[3..]
                            .bytes()
                            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
                }
            };
            if !valid {
                return Err(ERR.into());
            }
        }
    }
    if ch.get("geographyProvenance").is_some() {
        let mut seen = HashSet::new();
        for p in list(ch, "geographyProvenance", 3)? {
            object(
                p,
                &["field", "value", "sourceId", "providerId", "kind", "scope"],
            )?;
            let field = text(p, "field", 32, false)?;
            if !matches!(field, "country" | "region" | "state")
                || !seen.insert(field)
                || p["value"] != ch["geography"][field]
                || p["sourceId"] != ch["sourceId"]
                || !matches!(
                    p["kind"].as_str(),
                    Some("provider" | "m3u" | "registry" | "user")
                )
                || !matches!(
                    p["scope"].as_str(),
                    Some(
                        "channel-origin" | "provider-declared" | "country-group" | "user-reviewed"
                    )
                )
            {
                return Err(ERR.into());
            }
            text(p, "value", 32, false)?;
            text(p, "sourceId", 256, false)?;
            if p.get("providerId").is_some() {
                text(p, "providerId", 16_384, false)?;
            }
        }
    }
    let reference = &c["reference"];
    object(reference, &["candidateDigest", "urlHashes"])?;
    digest_field(reference, "candidateDigest")?;
    let hashes = list(reference, "urlHashes", 16)?;
    if hashes.is_empty() {
        return Err(ERR.into());
    }
    let mut seen = HashSet::new();
    for h in hashes {
        let s = h.as_str().ok_or(ERR)?;
        if s.len() != 64
            || !s
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !seen.insert(s)
        {
            return Err(ERR.into());
        }
    }
    Ok(())
}

pub(super) fn reference_matches(candidate: &Value, target: &Value) -> Result<bool, String> {
    let mut wanted = Vec::new();
    let mut index = 0;
    let urls = target["urls"].as_array().ok_or(ERR)?;
    for expected in list(&candidate["reference"], "urlHashes", 16)? {
        let mut found = false;
        while index < urls.len() {
            let url = &urls[index];
            index += 1;
            if hash(url)? == expected.as_str().ok_or(ERR)? {
                wanted.push(url.clone());
                found = true;
                break;
            }
        }
        if !found {
            return Ok(false);
        }
    }
    let mut resolved = candidate["channel"].clone();
    resolved["urls"] = Value::Array(wanted);
    Ok(published_matches(&resolved, target)
        && hash(&channel_tuple(&resolved, resolved["urls"].clone()))?
            == candidate["reference"]["candidateDigest"]
                .as_str()
                .ok_or(ERR)?)
}

#[cfg(test)]
pub(crate) fn reference_fixture(value: &Value) -> Value {
    let mut output = value.clone();
    output["schemaVersion"] = json!(2);
    for candidate in output["review"]["candidates"].as_array_mut().unwrap() {
        let urls = candidate["channel"]["urls"].clone();
        let candidate_digest = hash(&channel_tuple(&candidate["channel"], urls.clone())).unwrap();
        let hashes: Vec<_> = urls
            .as_array()
            .unwrap()
            .iter()
            .map(|u| hash(u).unwrap())
            .collect();
        candidate["channel"].as_object_mut().unwrap().remove("urls");
        candidate["reference"] = json!({"candidateDigest":candidate_digest,"urlHashes":hashes});
    }
    output["reviewDigest"] = json!(reference_review_digest(&output["review"]).unwrap());
    output
}

#[cfg(test)]
pub(crate) fn packed_fixture(value: &Value) -> Value {
    packed::fixture(&reference_fixture(value))
}

#[cfg(test)]
pub(crate) fn packed_redigest(value: &mut Value) {
    packed::redigest(value);
}
