//! Packed reference checkpoint admission. No full expanded checkpoint is constructed.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::io::Write;

pub(super) const FIELDS: &[&str] = &[
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
    "publishedIndices",
    "reviewDigest",
    "categoryTable",
];
const GEO: [&str; 3] = ["country", "region", "state"];
const KINDS: [&str; 4] = ["provider", "m3u", "registry", "user"];
const SCOPES: [&str; 4] = [
    "channel-origin",
    "provider-declared",
    "country-group",
    "user-reviewed",
];

fn tuple(v: &Value, length: usize) -> Result<&Vec<Value>, String> {
    v.as_array()
        .filter(|a| a.len() == length)
        .ok_or_else(|| ERR.into())
}
fn slot(v: &Value) -> Result<Option<&Value>, String> {
    let a = v.as_array().filter(|a| a.len() <= 1).ok_or(ERR)?;
    Ok(a.first())
}
fn index(v: &Value, length: usize) -> Result<usize, String> {
    let n = v.as_u64().ok_or(ERR)?;
    usize::try_from(n)
        .ok()
        .filter(|n| *n < length)
        .ok_or_else(|| ERR.into())
}
fn string(v: &Value, max: usize, empty: bool) -> Result<&str, String> {
    let s = v.as_str().ok_or(ERR)?;
    if s.len() > max || (!empty && s.trim().is_empty()) || s.chars().any(char::is_control) {
        return Err(ERR.into());
    }
    Ok(s)
}
fn expanded_hash(v: &Value) -> Result<String, String> {
    let s = v.as_str().ok_or(ERR)?;
    if s.len() != 43 {
        return Err(ERR.into());
    }
    let bytes = URL_SAFE_NO_PAD.decode(s).map_err(|_| ERR)?;
    if bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&bytes) != s {
        return Err(ERR.into());
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// One candidate envelope only, for the existing metadata and exact target validators.
pub(super) fn candidate(v: &Value, raw: &Value) -> Result<Value, String> {
    let c = tuple(raw, 9)?;
    let sources = list(&v["review"], "sources", 100)?;
    let source = &sources[index(&c[1], sources.len())?];
    let categories = list(v, "categoryTable", 100_000)?;
    let category = &categories[index(&c[4], categories.len())?];
    candidate_parts(raw, category, source, &v["review"]["sessionRevision"])
}
pub(super) fn candidate_parts(
    raw: &Value,
    category: &Value,
    source: &Value,
    session: &Value,
) -> Result<Value, String> {
    let c = tuple(raw, 9)?;
    let mut channel = json!({"sourceId":source["sourceId"],"name":string(&c[3],16_384,false)?,"category":category});
    if let Some(provider) = slot(&c[2])? {
        channel["providerId"] = json!(string(provider, 16_384, false)?);
    }
    if let Some(raw_geography) = slot(&c[5])? {
        let g = tuple(raw_geography, 3)?;
        let mut geography = serde_json::Map::new();
        for (i, field) in GEO.iter().enumerate() {
            if let Some(value) = slot(&g[i])? {
                geography.insert((*field).into(), json!(string(value, 32, false)?));
            }
        }
        channel["geography"] = Value::Object(geography);
    }
    if let Some(rows) = slot(&c[6])? {
        let rows = rows.as_array().filter(|a| a.len() <= 3).ok_or(ERR)?;
        let mut provenance = Vec::with_capacity(rows.len());
        for row in rows {
            let p = tuple(row, 5)?;
            let mut item = json!({"field":GEO[index(&p[0],GEO.len())?],"value":string(&p[1],32,false)?,
                "sourceId":source["sourceId"],"kind":KINDS[index(&p[3],KINDS.len())?],"scope":SCOPES[index(&p[4],SCOPES.len())?]});
            if let Some(provider) = slot(&p[2])? {
                item["providerId"] = json!(string(provider, 16_384, false)?);
            }
            provenance.push(item);
        }
        channel["geographyProvenance"] = Value::Array(provenance);
    }
    let hashes = c[8]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 16)
        .ok_or(ERR)?;
    Ok(
        json!({"key":string(&c[0],256,false)?,"sourceId":source["sourceId"],"sourceFingerprint":source["fingerprint"],
        "sessionRevision":session,"channel":channel,
        "reference":{"candidateDigest":expanded_hash(&c[7])?,"urlHashes":hashes.iter().map(expanded_hash).collect::<Result<Vec<_>,_>>()?}}),
    )
}

struct DigestWriter<'a, F> {
    hash: Sha256,
    bytes: usize,
    next_check: usize,
    check: &'a mut F,
    refusal: Option<String>,
}
impl<F: FnMut() -> Result<(), String>> Write for DigestWriter<'_, F> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > LIMIT.saturating_sub(self.bytes) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "checkpoint digest limit",
            ));
        }
        if self.bytes.saturating_add(bytes.len()) >= self.next_check {
            if let Err(error) = (self.check)() {
                self.refusal = Some(error);
                return Err(std::io::Error::other("checkpoint canceled"));
            }
            self.next_check = self
                .bytes
                .saturating_add(bytes.len())
                .saturating_add(65_536);
        }
        self.hash.update(bytes);
        self.bytes += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn review_digest(
    v: &Value,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<String, String> {
    let r = &v["review"];
    let sources: Vec<_> = list(r, "sources", 100)?
        .iter()
        .map(|s| {
            [
                &s["sourceId"],
                &s["fingerprint"],
                &s["status"],
                &s["inspected"],
                &s["matched"],
                &s["warnings"],
            ]
        })
        .collect();
    let n = &r["counts"];
    let domain = (
        "genx-scan-reference-v3",
        &v["categoryTable"],
        &r["sessionRevision"],
        &r["query"],
        &r["status"],
        sources,
        [
            &n["inspected"],
            &n["matched"],
            &n["failedSources"],
            &n["canceledSources"],
        ],
        &r["candidates"],
    );
    let mut writer = DigestWriter {
        hash: Sha256::new(),
        bytes: 0,
        next_check: 0,
        check,
        refusal: None,
    };
    if serde_json::to_writer(&mut writer, &domain).is_err() {
        return Err(writer
            .refusal
            .unwrap_or_else(|| "scan-checkpoint-too-large".into()));
    }
    Ok(format!("{:x}", writer.hash.finalize()))
}
fn identity(channel: &Value) -> Result<String, String> {
    serde_json::to_string(&[
        &channel["sourceId"],
        channel.get("providerId").unwrap_or(&Value::Null),
        &channel["name"],
        &channel["category"],
    ])
    .map_err(|_| ERR.into())
}

pub(super) fn validate(
    v: Value,
    prefs: &Value,
    catalog: &Value,
    revision: i64,
    now: u64,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    validate_scope(v, Some((prefs, catalog, revision)), now, check)
}
/// Retained checkpoint integrity, without granting its expired or stale authority.
pub(super) fn validate_retained(
    v: Value,
    now: u64,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    validate_scope(v, None, now, check)
}
fn validate_scope(
    v: Value,
    authority: Option<(&Value, &Value, i64)>,
    now: u64,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    check()?;
    object(&v, FIELDS)?;
    digest_field(&v, "reviewDigest")?;
    let Header {
        created,
        sources,
        review,
        ..
    } = validate_header_scope(&v, authority, now, true)?;
    if review_digest(&v, check)? != v["reviewDigest"] {
        return Err(ERR.into());
    }
    let categories = list(&v, "categoryTable", 100_000)?;
    let mut unique_categories = HashSet::new();
    for (n, c) in categories.iter().enumerate() {
        if n.is_multiple_of(128) {
            check()?;
        }
        if !unique_categories.insert(string(c, 16_384, true)?) {
            return Err(ERR.into());
        }
    }
    let raw_candidates = list(review, "candidates", 100_000)?;
    let mut keys = HashSet::new();
    let mut used_categories = HashSet::new();
    for (n, raw) in raw_candidates.iter().enumerate() {
        if n.is_multiple_of(128) {
            check()?;
        }
        let c = tuple(raw, 9)?;
        let ci = index(&c[4], categories.len())?;
        if !used_categories.contains(&ci) {
            if ci != used_categories.len() {
                return Err(ERR.into());
            }
            used_categories.insert(ci);
        }
        if !keys.insert(string(&c[0], 256, false)?) {
            return Err(ERR.into());
        }
        reference_metadata(&candidate(&v, raw)?)?;
    }
    if used_categories.len() != categories.len() {
        return Err(ERR.into());
    }
    let mut observed = vec![None; raw_candidates.len()];
    for (n, row) in list(&v, "observations", 100_000)?.iter().enumerate() {
        if n.is_multiple_of(128) {
            check()?;
        }
        let row = tuple(row, 4)?;
        let ordinal = index(&row[0], raw_candidates.len())?;
        if observed[ordinal].replace(row).is_some() {
            return Err(ERR.into());
        }
        validate_evidence(&row[1], &row[2], &row[3], created, now)?;
    }
    let targets = match authority {
        Some((_, catalog, _)) => catalog["channels"].as_array().ok_or(ERR)?.as_slice(),
        None => &[],
    };
    let mut target_index: HashMap<String, Vec<&Value>> = HashMap::new();
    for (n, target) in targets.iter().enumerate() {
        if n.is_multiple_of(128) {
            check()?;
        }
        target_index
            .entry(identity(target)?)
            .or_default()
            .push(target);
    }
    let mut published = HashSet::new();
    let mut comparisons = 0usize;
    for (n, i) in list(&v, "publishedIndices", 100_000)?.iter().enumerate() {
        if n.is_multiple_of(128) {
            check()?;
        }
        let ordinal = index(i, raw_candidates.len())?;
        let o = observed[ordinal].ok_or(ERR)?;
        if !published.insert(ordinal) || !matches!(o[2].as_str(), Some("Reachable" | "PlayedHere"))
        {
            return Err(ERR.into());
        }
        let c = candidate(&v, &raw_candidates[ordinal])?;
        // Old publication indices must remain structurally consistent, but are
        // not evidence about today's catalog or network grants.
        let Some((_, catalog, _)) = authority else {
            continue;
        };
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
                if reference_matches(&c, target)? {
                    matched = true;
                    break;
                }
            }
        }
        if !matched {
            return Err("scan-checkpoint-unpublished-channel".into());
        }
        let sid = c["sourceId"].as_str().ok_or(ERR)?;
        let canonical = catalog["sources"]
            .as_array()
            .ok_or(ERR)?
            .iter()
            .find(|s| s["id"] == sid)
            .ok_or(ERR)?;
        if source_fingerprint(canonical)? != source_fingerprint(sources.get(sid).ok_or(ERR)?)? {
            return Err("scan-checkpoint-policy-stale".into());
        }
    }
    Ok(v)
}

pub(super) fn advance(
    mut v: Value,
    mutation: &Mutation,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    let Mutation::Advance {
        observations,
        published_keys,
        ..
    } = mutation
    else {
        return Err(ERR.into());
    };
    let candidates = list(&v["review"], "candidates", 100_000)?;
    let mut candidate_index = HashMap::new();
    for (n, c) in candidates.iter().enumerate() {
        if n.is_multiple_of(128) {
            check()?;
        }
        let c = tuple(c, 9)?;
        if candidate_index
            .insert(string(&c[0], 256, false)?.to_owned(), n)
            .is_some()
        {
            return Err(ERR.into());
        }
    }
    let mut observation_index = HashMap::new();
    for (n, row) in list(&v, "observations", 100_000)?.iter().enumerate() {
        if n.is_multiple_of(128) {
            check()?;
        }
        let row = tuple(row, 4)?;
        if observation_index
            .insert(index(&row[0], candidates.len())?, n)
            .is_some()
        {
            return Err(ERR.into());
        }
    }
    let mut delta_keys = HashSet::new();
    let mut incoming = Vec::new();
    for observation in observations {
        check()?;
        object(
            observation,
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
        let key = text(observation, "channelId", 256, false)?;
        if !delta_keys.insert(key) {
            return Err(ERR.into());
        }
        let ordinal = *candidate_index.get(key).ok_or(ERR)?;
        let c = tuple(&candidates[ordinal], 9)?;
        let sources = list(&v["review"], "sources", 100)?;
        let source = &sources[index(&c[1], sources.len())?];
        if observation["sourceId"] != source["sourceId"]
            || observation["fingerprint"] != source["fingerprint"]
            || observation["platform"] != v["platform"]
        {
            return Err(ERR.into());
        }
        let row = json!([
            ordinal,
            observation["observedAt"],
            observation["verdict"],
            observation["evidence"]
        ]);
        if let Some(existing) = observation_index.get(&ordinal) {
            if v["observations"][*existing] != row {
                return Err("scan-checkpoint-progress-conflict".into());
            }
        } else {
            incoming.push(row);
        }
    }
    let mut published = HashSet::new();
    for (n, i) in list(&v, "publishedIndices", 100_000)?.iter().enumerate() {
        if n.is_multiple_of(128) {
            check()?;
        }
        if !published.insert(index(i, candidates.len())?) {
            return Err(ERR.into());
        }
    }
    let mut incoming_published = Vec::new();
    let mut delta_published = HashSet::new();
    for key in published_keys {
        check()?;
        if !delta_published.insert(key) {
            return Err(ERR.into());
        }
        let ordinal = *candidate_index.get(key).ok_or(ERR)?;
        if published.insert(ordinal) {
            incoming_published.push(json!(ordinal));
        }
    }
    let stored = v["observations"].as_array_mut().ok_or(ERR)?;
    if incoming.len() > 100_000usize.saturating_sub(stored.len()) {
        return Err("scan-checkpoint-too-large".into());
    }
    stored.extend(incoming);
    let stored = v["publishedIndices"].as_array_mut().ok_or(ERR)?;
    if incoming_published.len() > 100_000usize.saturating_sub(stored.len()) {
        return Err("scan-checkpoint-too-large".into());
    }
    stored.extend(incoming_published);
    Ok(v)
}

pub(super) fn preserve_progress(
    old: &Value,
    new: &Value,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let new_published: HashSet<_> = list(new, "publishedIndices", 100_000)?.iter().collect();
    if list(old, "publishedIndices", 100_000)?
        .iter()
        .any(|i| !new_published.contains(i))
    {
        return Err("scan-checkpoint-progress-stale".into());
    }
    let mut new_observations = HashMap::new();
    for (n, row) in list(new, "observations", 100_000)?.iter().enumerate() {
        if n.is_multiple_of(128) {
            check()?;
        }
        let row = tuple(row, 4)?;
        if new_observations.insert(&row[0], row).is_some() {
            return Err(ERR.into());
        }
    }
    for (n, prior) in list(old, "observations", 100_000)?.iter().enumerate() {
        if n.is_multiple_of(128) {
            check()?;
        }
        let prior = tuple(prior, 4)?;
        let row = new_observations
            .get(&prior[0])
            .ok_or("scan-checkpoint-progress-stale")?;
        if row[1].as_u64() < prior[1].as_u64() {
            return Err("scan-checkpoint-progress-stale".into());
        }
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn fixture(reference: &Value) -> Value {
    let mut output = reference.clone();
    output["schemaVersion"] = json!(3);
    let mut categories = Vec::new();
    let mut candidates = Vec::new();
    let review_sources = reference["review"]["sources"].as_array().unwrap();
    let mut key_indices = HashMap::new();
    let encoded_hash = |h: &Value| {
        URL_SAFE_NO_PAD.encode(
            (0..64)
                .step_by(2)
                .map(|n| u8::from_str_radix(&h.as_str().unwrap()[n..n + 2], 16).unwrap())
                .collect::<Vec<_>>(),
        )
    };
    let optional = |v: Option<&Value>| Value::Array(v.into_iter().cloned().collect());
    for (i, c) in reference["review"]["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let channel = &c["channel"];
        let ci = categories
            .iter()
            .position(|v| v == &channel["category"])
            .unwrap_or_else(|| {
                categories.push(channel["category"].clone());
                categories.len() - 1
            });
        let source = review_sources
            .iter()
            .position(|s| s["sourceId"] == c["sourceId"])
            .unwrap();
        let geography = channel
            .get("geography")
            .map(|g| json!(GEO.map(|f| optional(g.get(f)))));
        let provenance = channel.get("geographyProvenance").map(|rows| {
            json!(rows
                .as_array()
                .unwrap()
                .iter()
                .map(|p| json!([
                    GEO.iter().position(|f| *f == p["field"]).unwrap(),
                    p["value"],
                    optional(p.get("providerId")),
                    KINDS.iter().position(|k| *k == p["kind"]).unwrap(),
                    SCOPES.iter().position(|s| *s == p["scope"]).unwrap()
                ]))
                .collect::<Vec<_>>())
        });
        candidates.push(json!([
            c["key"],
            source,
            optional(channel.get("providerId")),
            channel["name"],
            ci,
            optional(geography.as_ref()),
            optional(provenance.as_ref()),
            encoded_hash(&c["reference"]["candidateDigest"]),
            c["reference"]["urlHashes"]
                .as_array()
                .unwrap()
                .iter()
                .map(encoded_hash)
                .collect::<Vec<_>>()
        ]));
        key_indices.insert(c["key"].as_str().unwrap(), i);
    }
    output["categoryTable"] = json!(categories);
    output["review"]["candidates"] = json!(candidates);
    output["observations"] = json!(reference["observations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| json!([
            key_indices[o["channelId"].as_str().unwrap()],
            o["observedAt"],
            o["verdict"],
            o["evidence"]
        ]))
        .collect::<Vec<_>>());
    output.as_object_mut().unwrap().remove("publishedKeys");
    output["publishedIndices"] = json!(reference["publishedKeys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| key_indices[k.as_str().unwrap()])
        .collect::<Vec<_>>());
    output["reviewDigest"] = json!(review_digest(&output, &mut || Ok(())).unwrap());
    output
}

#[cfg(test)]
pub(super) fn redigest(value: &mut Value) {
    value["reviewDigest"] = json!(review_digest(value, &mut || Ok(())).unwrap());
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn digest_cancellation_is_not_a_retryable_io_interrupt_or_a_size_error() {
        let mut calls = 0;
        let mut check = || {
            calls += 1;
            Err("fixture-cancelled".into())
        };
        {
            let mut writer = DigestWriter {
                hash: Sha256::new(),
                bytes: 0,
                next_check: 0,
                check: &mut check,
                refusal: None,
            };
            let error = writer.write_all(b"bounded digest").unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::Other);
            assert_eq!(writer.bytes, 0);
            assert_eq!(writer.refusal.as_deref(), Some("fixture-cancelled"));
        }
        assert_eq!(calls, 1);
        let v = json!({"categoryTable":[],"review":{"sessionRevision":"s","query":"","status":"completed","sources":[],
            "counts":{"inspected":0,"matched":0,"failedSources":0,"canceledSources":0},"candidates":[]}});
        assert_eq!(
            review_digest(&v, &mut || Err("fixture-cancelled".into())).unwrap_err(),
            "fixture-cancelled"
        );
    }
}
