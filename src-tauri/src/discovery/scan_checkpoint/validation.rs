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

//! Checking a scan checkpoint's header, scope, evidence and values before it
//! is saved or resumed.

use super::*;

pub(super) fn validate_guarded(
    raw: &str,
    prefs: &Value,
    catalog: &Value,
    current_revision: i64,
    now: u64,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    check()?;
    if raw.len() > LIMIT {
        return Err("scan-checkpoint-too-large".into());
    }
    let v: Value = serde_json::from_str(raw).map_err(|_| ERR)?;
    validate_value_guarded(v, prefs, catalog, current_revision, now, check)
}

pub(super) struct Header<'a> {
    pub(super) created: u64,
    pub(super) definitions: &'a Vec<Value>,
    pub(super) sources: HashMap<&'a str, &'a Value>,
    pub(super) fingerprints: HashMap<&'a str, &'a str>,
    pub(super) review: &'a Value,
}

pub(super) fn validate_header<'a>(
    v: &'a Value,
    prefs: &Value,
    catalog: &Value,
    current_revision: i64,
    now: u64,
    referenced: bool,
) -> Result<Header<'a>, String> {
    validate_header_scope(v, Some((prefs, catalog, current_revision)), now, referenced)
}

pub(super) fn validate_header_scope<'a>(
    v: &'a Value,
    authority: Option<(&Value, &Value, i64)>,
    now: u64,
    referenced: bool,
) -> Result<Header<'a>, String> {
    text(v, "jobId", 128, false)?;
    text(v, "platform", 256, false)?;
    text(v, "observerProfile", 256, false)?;
    let created = number(v, "createdAtMs", 8_640_000_000_000_000)?;
    if created > now || (authority.is_some() && now - created > DAY) {
        return Err("scan-checkpoint-expired".into());
    }
    if !matches!(v["budgetMs"].as_u64(), Some(20_000 | 45_000 | 60_000)) {
        return Err(ERR.into());
    }
    let stored_revision = revision(text(v, "catalogRevision", 19, false)?)?;
    if let Some((prefs, _, current_revision)) = authority {
        if stored_revision != current_revision {
            return Err("catalog-revision-stale".into());
        }
        if v.get("preferredRegion") != prefs.get("preferredRegion") {
            return Err("scan-checkpoint-policy-stale".into());
        }
    }
    digest_field(v, "policyFingerprint")?;
    let definitions = list(v, "sourceDefinitions", 100)?;
    if definitions.is_empty() {
        return Err(ERR.into());
    }
    let mut sources = HashMap::new();
    for d in definitions {
        object(d, &["source", "definitionFingerprint"])?;
        let s = &d["source"];
        object(
            s,
            &[
                "id",
                "name",
                "kind",
                "location",
                "allowHttp",
                "contentKind",
                "mediaMime",
            ],
        )?;
        if referenced && s["kind"] != "url" {
            return Err("scan-checkpoint-source-not-resumable".into());
        }
        let id = text(s, "id", 256, false)?;
        text(s, "name", 16384, false)?;
        let location = text(s, "location", 16384, false)?;
        if s.get("allowHttp").is_some_and(|v| !v.is_boolean()) {
            return Err(ERR.into());
        }
        let http = s["allowHttp"].as_bool().unwrap_or(false);
        if s["kind"] == "url" {
            safe_url(location, true, http)?;
        } else if s["kind"] != "file" {
            return Err(ERR.into());
        }
        if let Some((prefs, catalog, _)) = authority {
            let canonical = catalog["sources"]
                .as_array()
                .ok_or(ERR)?
                .iter()
                .find(|source| source["id"] == id);
            if let Some(saved) = canonical {
                if source_fingerprint(saved)? != source_fingerprint(s)? {
                    return Err("scan-checkpoint-policy-stale".into());
                }
            } else {
                if s["kind"] != "url" {
                    return Err("scan-checkpoint-source-not-resumable".into());
                }
                let admitted = prefs
                    .get("reviewedChannelProviders")
                    .and_then(Value::as_array)
                    .is_some_and(|configured| {
                        configured.iter().any(|p| {
                            p["location"] == location
                                && p["allowHttp"].as_bool().unwrap_or(false) == http
                        })
                    });
                if !admitted {
                    return Err("scan-checkpoint-policy-stale".into());
                }
            }
        }
        if d["definitionFingerprint"] != source_fingerprint(s)? || sources.insert(id, s).is_some() {
            return Err(ERR.into());
        }
    }
    if let Some((prefs, _, _)) = authority {
        if v["policyFingerprint"] != policy_fingerprint(v, prefs)? {
            return Err("scan-checkpoint-policy-stale".into());
        }
    }
    let review = &v["review"];
    object(
        review,
        &[
            "sessionRevision",
            "query",
            "status",
            "sources",
            "candidates",
            "counts",
        ],
    )?;
    if review["status"] != "completed" {
        return Err(ERR.into());
    }
    text(review, "sessionRevision", 256, false)?;
    text(review, "query", 256, true)?;
    let mut fingerprints = HashMap::new();
    for s in list(review, "sources", 100)? {
        object(
            s,
            &[
                "sourceId",
                "fingerprint",
                "status",
                "inspected",
                "matched",
                "warnings",
            ],
        )?;
        let id = text(s, "sourceId", 256, false)?;
        let fp = text(s, "fingerprint", 256, false)?;
        if !sources.contains_key(id) || fingerprints.insert(id, fp).is_some() {
            return Err(ERR.into());
        }
        if !matches!(
            s["status"].as_str(),
            Some("completed" | "failed" | "canceled")
        ) {
            return Err(ERR.into());
        }
        for k in ["inspected", "matched", "warnings"] {
            number(s, k, 100_000)?;
        }
    }
    if fingerprints.len() != sources.len() {
        return Err(ERR.into());
    }
    let counts = &review["counts"];
    object(
        counts,
        &["inspected", "matched", "failedSources", "canceledSources"],
    )?;
    for k in ["inspected", "matched"] {
        number(counts, k, 100_000)?;
    }
    for k in ["failedSources", "canceledSources"] {
        number(counts, k, 100)?;
    }
    Ok(Header {
        created,
        definitions,
        sources,
        fingerprints,
        review,
    })
}

pub(super) fn validate_evidence(
    observed_at: &Value,
    declared: &Value,
    e: &Value,
    created: u64,
    now: u64,
) -> Result<(), String> {
    let at = observed_at
        .as_u64()
        .filter(|n| *n <= 8_640_000_000_000_000)
        .ok_or(ERR)?;
    if at < created || at > now {
        return Err(ERR.into());
    }
    let kind = e["kind"].as_str().ok_or(ERR)?;
    let verdict = match kind {
        "recognized-media-response" => {
            object(e, &["kind"])?;
            "Reachable"
        }
        "http" => {
            object(e, &["kind", "status", "contentRecognized"])?;
            let status = number(e, "status", 599)?;
            if status < 100 {
                return Err(ERR.into());
            }
            if e.get("contentRecognized").is_some_and(|v| !v.is_boolean()) {
                return Err(ERR.into());
            }
            if (200..300).contains(&status) && e["contentRecognized"] == true {
                "Reachable"
            } else if [401, 403, 451].contains(&status) {
                "AccessDenied"
            } else if status >= 400 {
                "TemporaryUnavailable"
            } else {
                "NotChecked"
            }
        }
        "timeout" | "slow" => {
            object(e, &["kind"])?;
            "TimedOut"
        }
        "unsupported" => {
            object(e, &["kind"])?;
            "UnsupportedHere"
        }
        "network-failure" | "host-down" => {
            object(e, &["kind"])?;
            "TemporaryUnavailable"
        }
        "decoded" => {
            object(e, &["kind", "before", "after", "elapsedMilliseconds"])?;
            let mut samples = Vec::new();
            for k in ["before", "after"] {
                let d = &e[k];
                object(d, &["mediaTime", "decodedFrames", "width", "height"])?;
                let t = d["mediaTime"]
                    .as_f64()
                    .filter(|n| n.is_finite() && *n >= 0.0)
                    .ok_or(ERR)?;
                let frames = number(d, "decodedFrames", 9_007_199_254_740_991)?;
                if number(d, "width", 16384)? == 0 || number(d, "height", 16384)? == 0 {
                    return Err(ERR.into());
                }
                samples.push((t, frames));
            }
            if e["elapsedMilliseconds"]
                .as_f64()
                .is_none_or(|n| !n.is_finite() || n <= 0.0)
                || samples[1].0 <= samples[0].0
                || samples[1].1 <= samples[0].1
            {
                return Err(ERR.into());
            }
            "PlayedHere"
        }
        _ => return Err(ERR.into()),
    };
    if verdict == "NotChecked" || declared != verdict {
        return Err(ERR.into());
    }
    Ok(())
}

pub(super) fn validate_value_guarded(
    mut v: Value,
    prefs: &Value,
    catalog: &Value,
    current_revision: i64,
    now: u64,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    if v["schemaVersion"] == 3 {
        return packed::validate(v, prefs, catalog, current_revision, now, check);
    }
    object(
        &v,
        &[
            "schemaVersion",
            "jobId",
            "createdAtMs",
            "catalogRevision",
            "policyFingerprint",
            "sourceDefinitions",
            "budgetMs",
            "platform",
            "observerProfile",
            "preferredRegion",
            "review",
            "observations",
            "publishedKeys",
            "reviewDigest",
        ],
    )?;
    if v["schemaVersion"] != 1 && v["schemaVersion"] != 2 {
        return Err(ERR.into());
    }
    let referenced = v["schemaVersion"] == 2;
    if referenced {
        digest_field(&v, "reviewDigest")?;
    } else if v.get("reviewDigest").is_some() {
        return Err(ERR.into());
    }
    let Header {
        created,
        definitions,
        sources,
        fingerprints,
        review,
    } = validate_header(&v, prefs, catalog, current_revision, now, referenced)?;
    let mut candidates = HashMap::new();
    let mut synthetic = Vec::new();
    for (n, c) in list(review, "candidates", 100_000)?.iter().enumerate() {
        if n % 128 == 0 {
            check()?;
        }
        object(
            c,
            &[
                "key",
                "sourceId",
                "sourceFingerprint",
                "sessionRevision",
                "channel",
                "reference",
            ],
        )?;
        let key = text(c, "key", 256, false)?;
        let sid = text(c, "sourceId", 256, false)?;
        if c["sessionRevision"] != review["sessionRevision"]
            || fingerprints.get(sid).copied() != c["sourceFingerprint"].as_str()
            || c["channel"]["sourceId"] != sid
            || candidates.insert(key, c).is_some()
        {
            return Err(ERR.into());
        }
        let ch = &c["channel"];
        if referenced {
            if sources.get(sid).ok_or(ERR)?["kind"] != "url" {
                return Err("scan-checkpoint-source-not-resumable".into());
            }
            reference_metadata(c)?;
            continue;
        }
        if c.get("reference").is_some() {
            return Err(ERR.into());
        }
        object(
            ch,
            &[
                "sourceId",
                "providerId",
                "name",
                "category",
                "urls",
                "geography",
                "geographyProvenance",
            ],
        )?;
        sources.get(sid).ok_or(ERR)?;
        for u in list(ch, "urls", 16)? {
            safe_url(u.as_str().ok_or(ERR)?, false, true)?;
        }
        let mut copy = ch.clone();
        copy["id"] = json!(format!("checkpoint-{n}"));
        synthetic.push(copy);
    }
    if !referenced {
        let sources: Vec<_> = definitions
            .iter()
            .map(|d| {
                let mut source = d["source"].clone();
                source["allowHttp"] = json!(true);
                source
            })
            .collect();
        crate::storage_transaction::validate_checkpoint_catalog(
            &json!({ "schemaVersion": 1, "sources": sources, "channels": synthetic }),
        )?;
    }
    if referenced && reference_review_digest(review)? != v["reviewDigest"].as_str().ok_or(ERR)? {
        return Err(ERR.into());
    }
    let mut observed = HashMap::new();
    for (n, o) in list(&v, "observations", 100_000)?.iter().enumerate() {
        if n % 128 == 0 {
            check()?;
        }
        object(
            o,
            &[
                "channelId",
                "sourceId",
                "fingerprint",
                "platform",
                "observedAt",
                "verdict",
                "evidence",
            ],
        )?;
        let key = text(o, "channelId", 256, false)?;
        let c = candidates.get(key).ok_or(ERR)?;
        if observed.insert(key, o).is_some()
            || o["sourceId"] != c["sourceId"]
            || o["fingerprint"] != c["sourceFingerprint"]
            || o["platform"] != v["platform"]
        {
            return Err(ERR.into());
        }
        validate_evidence(
            &o["observedAt"],
            &o["verdict"],
            &o["evidence"],
            created,
            now,
        )?;
    }
    let mut published = HashSet::new();
    let targets = catalog["channels"].as_array().ok_or(ERR)?;
    let identity = |c: &Value| {
        serde_json::to_string(&json!([
            c["sourceId"],
            c.get("providerId").unwrap_or(&Value::Null),
            c["name"],
            c["category"]
        ]))
        .map_err(|_| ERR.to_string())
    };
    let mut target_index: HashMap<String, Vec<&Value>> = HashMap::new();
    for (n, target) in targets.iter().enumerate() {
        if n % 128 == 0 {
            check()?;
        }
        target_index
            .entry(identity(target)?)
            .or_default()
            .push(target);
    }
    let mut comparisons = 0usize;

    for (n, key) in list(&v, "publishedKeys", 100_000)?.iter().enumerate() {
        if n % 128 == 0 {
            check()?;
        }
        let key = key.as_str().ok_or(ERR)?;
        let o = observed.get(key).ok_or(ERR)?;
        if !published.insert(key)
            || !matches!(o["verdict"].as_str(), Some("Reachable" | "PlayedHere"))
        {
            return Err(ERR.into());
        }
        let c = candidates.get(key).ok_or(ERR)?;
        let mut matched = false;
        if let Some(targets) = target_index.get(&identity(&c["channel"])?) {
            for target in targets {
                comparisons += 1;
                if comparisons.is_multiple_of(128) {
                    check()?;
                }
                if comparisons > 1_000_000 {
                    return Err("scan-checkpoint-target-validation-limit".into());
                }
                if (referenced && reference_matches(c, target)?)
                    || (!referenced && published_matches(&c["channel"], target))
                {
                    matched = true;
                    break;
                }
            }
        }
        if !matched {
            return Err("scan-checkpoint-unpublished-channel".into());
        }
        let sid = c["sourceId"].as_str().ok_or(ERR)?;
        let canonical_source = catalog["sources"]
            .as_array()
            .ok_or(ERR)?
            .iter()
            .find(|s| s["id"] == sid)
            .ok_or(ERR)?;
        if source_fingerprint(canonical_source)?
            != source_fingerprint(sources.get(sid).ok_or(ERR)?)?
        {
            return Err("scan-checkpoint-policy-stale".into());
        }
    }
    v["catalogRevision"] = json!(current_revision.to_string());
    Ok(v)
}
