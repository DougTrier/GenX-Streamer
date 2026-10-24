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

//! Context-bound health evidence; no channel foreign key can erase it during catalog replacement.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const LIMIT: usize = 20 * 1024 * 1024;
const SAFE: f64 = 9_007_199_254_740_991.0;
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    #[serde(deserialize_with = "small_integer")]
    schema_version: u8,
    channel_id: String,
    source_id: String,
    #[serde(deserialize_with = "small_integer")]
    checked_url_ordinal: u8,
    target_fingerprint: String,
    platform: String,
    observer_profile: String,
    #[serde(deserialize_with = "safe_integer")]
    observed_at: u64,
    verdict: String,
    evidence: Value,
    origin: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Payload {
    #[serde(deserialize_with = "small_integer")]
    schema_version: u8,
    records: Vec<Record>,
}
fn integer(v: &Value) -> Option<u64> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= SAFE && n.fract() == 0.0)
        .map(|n| n as u64)
}
fn safe_integer<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    integer(&Value::deserialize(d)?)
        .ok_or_else(|| serde::de::Error::custom("health-invalid-integer"))
}
fn small_integer<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u8, D::Error> {
    u8::try_from(safe_integer(d)?).map_err(|_| serde::de::Error::custom("health-invalid-integer"))
}
fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|error| crate::storage_transaction::sql_error_code(&error, "health-sqlite-failed"))
}
fn text(s: &str, max: usize) -> bool {
    !s.chars().all(|c| {
        matches!(
            c,
            ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    }) && s.len() <= max
        && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}
fn fields(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.keys().all(|k| keys.contains(&k.as_str())))
}
fn sample(v: &Value) -> Result<(f64, u64), String> {
    let t = v["mediaTime"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= SAFE);
    let f = integer(&v["decodedFrames"]);
    if !fields(v, &["mediaTime", "decodedFrames", "width", "height"])
        || t.is_none()
        || f.is_none()
        || ["width", "height"]
            .iter()
            .any(|k| integer(&v[k]).is_none_or(|n| !(1..=32768).contains(&n)))
    {
        return Err("health-invalid-sample".into());
    }
    Ok((t.unwrap(), f.unwrap()))
}
fn verdict(e: &Value) -> Result<&'static str, String> {
    let kind = e["kind"].as_str().ok_or("health-invalid-evidence")?;
    let result = match kind {
        "http" => {
            if !fields(e, &["kind", "status", "contentRecognized"])
                || e.get("contentRecognized").is_some_and(|v| !v.is_boolean())
            {
                return Err("health-invalid-evidence".into());
            }
            let status = integer(&e["status"])
                .filter(|n| (100..=599).contains(n))
                .ok_or("health-invalid-status")?;
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
        "decoded" => {
            if !fields(e, &["kind", "before", "after", "elapsedMilliseconds"])
                || e["elapsedMilliseconds"]
                    .as_f64()
                    .is_none_or(|n| !n.is_finite() || n <= 0.0 || n > 120000.0)
            {
                return Err("health-invalid-interval".into());
            }
            let a = sample(&e["before"])?;
            let b = sample(&e["after"])?;
            if b.0 > a.0 && b.1 > a.1 {
                "PlayedHere"
            } else {
                "NotChecked"
            }
        }
        "recognized-media-response" => "Reachable",
        "timeout" | "slow" => "TimedOut",
        "unsupported" => "UnsupportedHere",
        "canceled" => "Canceled",
        "network-failure" | "host-down" => "TemporaryUnavailable",
        "not-checked" | "local-network-unavailable" => "NotChecked",
        _ => return Err("health-invalid-evidence".into()),
    };
    if !matches!(kind, "http" | "decoded") && !fields(e, &["kind"]) {
        return Err("health-invalid-evidence".into());
    }
    Ok(result)
}
fn validate(records: &[Record]) -> Result<(), String> {
    if records.len() > 100000 {
        return Err("health-too-large".into());
    }
    let mut seen = HashSet::new();
    let mut bytes = 2;
    for r in records {
        if r.schema_version != 1
            || !text(&r.channel_id, 16384)
            || !text(&r.source_id, 256)
            || !text(&r.platform, 256)
            || !text(&r.observer_profile, 256)
            || r.checked_url_ordinal > 15
            || r.target_fingerprint.len() != 64
            || !r
                .target_fingerprint
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || r.observed_at > SAFE as u64
            || !matches!(r.origin.as_str(), "local" | "imported")
            || r.verdict != verdict(&r.evidence)?
        {
            return Err("health-invalid-record".into());
        }
        if !seen.insert(slot(r)) {
            return Err("health-duplicate-record".into());
        }
        bytes += serde_json::to_vec(r)
            .map_err(|_| "health-encoding-failed")?
            .len()
            + 1;
        if bytes > LIMIT {
            return Err("health-too-large".into());
        }
    }
    Ok(())
}
fn slot(r: &Record) -> String {
    json!([
        r.channel_id,
        r.checked_url_ordinal,
        r.platform,
        r.observer_profile
    ])
    .to_string()
}
pub fn parse(s: &str) -> Result<Vec<Record>, String> {
    if s.len() > LIMIT {
        return Err("health-too-large".into());
    }
    let p: Payload = serde_json::from_str(s).map_err(|_| "health-invalid-json")?;
    if p.schema_version != 1 {
        return Err("health-unsupported-schema".into());
    }
    validate(&p.records)?;
    Ok(p.records)
}
pub fn encode(records: &[Record]) -> Result<String, String> {
    validate(records)?;
    let s = serde_json::to_string(&json!({"schemaVersion":1,"records":records}))
        .map_err(|_| "health-encoding-failed")?;
    if s.len() > LIMIT {
        return Err("health-too-large".into());
    }
    Ok(s)
}
pub fn migrate(c: &mut Connection) -> Result<(), String> {
    let version: i64 = sql(c.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
    if version == 5 {
        return Ok(());
    }
    if version != 4 {
        return Err("sqlite-unsupported-schema".into());
    }
    let tx = sql(c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
    sql(tx.execute_batch("ALTER TABLE metadata ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 0;UPDATE metadata SET catalog_revision=revision;ALTER TABLE metadata ADD COLUMN health_revision INTEGER NOT NULL DEFAULT 0;ALTER TABLE metadata ADD COLUMN health_present INTEGER NOT NULL DEFAULT 0;CREATE TABLE channel_health(channel_id TEXT NOT NULL,url_ordinal INTEGER NOT NULL,platform TEXT NOT NULL,observer_profile TEXT NOT NULL,source_id TEXT NOT NULL,target_fingerprint TEXT NOT NULL,observed_at INTEGER NOT NULL,verdict TEXT NOT NULL,origin TEXT NOT NULL,evidence_json TEXT NOT NULL,PRIMARY KEY(channel_id,url_ordinal,platform,observer_profile));CREATE INDEX health_channel ON channel_health(channel_id,url_ordinal);PRAGMA user_version=5;"))?;
    sql(tx.commit())
}
pub(crate) struct CapturedHealth(Option<(Vec<Record>, Vec<String>)>);
pub fn read(c: &Connection) -> Result<Option<String>, String> {
    finish(capture(c)?)
}
pub(crate) fn capture(c: &Connection) -> Result<CapturedHealth, String> {
    let present: bool = sql(c.query_row(
        "SELECT health_present FROM metadata WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    if !present {
        return Ok(CapturedHealth(None));
    }
    let mut stmt=sql(c.prepare("SELECT channel_id,url_ordinal,platform,observer_profile,source_id,target_fingerprint,observed_at,verdict,origin,evidence_json FROM channel_health"))?;
    let mut rows = sql(stmt.query([]))?;
    let mut records = Vec::new();
    let mut bytes = 0;
    let mut evidence = Vec::new();
    while let Some(row) = sql(rows.next())? {
        for (column, limit) in [
            (0, 16384),
            (2, 256),
            (3, 256),
            (4, 256),
            (5, 64),
            (7, 64),
            (8, 16),
            (9, 4096),
        ] {
            let value = sql(row.get_ref(column))?;
            let b = sql(value.as_bytes().map_err(Into::into))?;
            if b.len() > limit {
                return Err("health-invalid-stored-record".into());
            }
            bytes += b.len();
        }
        if bytes > LIMIT || records.len() >= 100000 {
            return Err("health-too-large".into());
        }
        let e: String = sql(row.get(9))?;
        records.push(Record {
            schema_version: 1,
            channel_id: sql(row.get(0))?,
            checked_url_ordinal: sql(row.get(1))?,
            platform: sql(row.get(2))?,
            observer_profile: sql(row.get(3))?,
            source_id: sql(row.get(4))?,
            target_fingerprint: sql(row.get(5))?,
            observed_at: u64::try_from(sql(row.get::<_, i64>(6))?)
                .map_err(|_| "health-invalid-stored-record")?,
            verdict: sql(row.get(7))?,
            origin: sql(row.get(8))?,
            evidence: Value::Null,
        });
        evidence.push(e);
    }
    Ok(CapturedHealth(Some((records, evidence))))
}
pub(crate) fn finish(captured: CapturedHealth) -> Result<Option<String>, String> {
    let Some((mut records, evidence)) = captured.0 else {
        return Ok(None);
    };
    for (record, raw) in records.iter_mut().zip(evidence) {
        record.evidence = serde_json::from_str(&raw).map_err(|_| "health-invalid-stored-record")?;
    }
    records.sort_by_cached_key(|r| slot(r).encode_utf16().collect::<Vec<_>>());
    encode(&records).map(Some)
}
pub fn fingerprint(source: &Value, channel: &Value, ordinal: usize) -> Result<String, String> {
    let sid = source["id"]
        .as_str()
        .filter(|s| text(s, 256))
        .ok_or("health-target-invalid")?;
    let location = source["location"]
        .as_str()
        .filter(|s| text(s, 16384))
        .ok_or("health-target-invalid")?;
    if channel["id"].as_str().is_none_or(|s| !text(s, 16384))
        || channel["sourceId"] != sid
        || !matches!(source["kind"].as_str(), Some("file" | "url"))
        || source.get("allowHttp").is_some_and(|v| !v.is_boolean())
        || ordinal > 15
        || channel["urls"]
            .as_array()
            .is_none_or(|v| v.len() > 16 || ordinal >= v.len())
    {
        return Err("health-target-invalid".into());
    }
    let admitted_url = |raw: &str| -> Result<(), String> {
        if !text(raw, 16384) {
            return Err("health-target-invalid".into());
        }
        let url = reqwest::Url::parse(raw).map_err(|_| "health-target-invalid")?;
        if !matches!(url.scheme(), "https" | "http")
            || !url.username().is_empty()
            || url.password().is_some()
            || (url.scheme() == "http" && source["allowHttp"] != true)
        {
            return Err("health-target-invalid".into());
        }
        Ok(())
    };
    admitted_url(
        channel["urls"][ordinal]
            .as_str()
            .ok_or("health-target-invalid")?,
    )?;
    if source["kind"] == "url" {
        admitted_url(location)?;
    }
    let tuple = json!([
        "health-target-v1",
        source["id"],
        source["kind"],
        source["location"],
        source["allowHttp"] == true,
        channel["id"],
        ordinal,
        channel["urls"][ordinal]
    ]);
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&tuple).map_err(|_| "health-encoding-failed")?)
    ))
}
pub fn reconcile(
    previous: Option<&str>,
    incoming: Option<&str>,
    catalog: Option<&Value>,
) -> Result<Option<String>, String> {
    reconcile_groups(previous, &incoming.into_iter().collect::<Vec<_>>(), catalog)
}
/// Each group preserves ordinary payload validation; retained targets and final
/// encoding are processed once for one atomic publication window.
pub(crate) fn reconcile_groups(
    previous: Option<&str>,
    incoming: &[&str],
    catalog: Option<&Value>,
) -> Result<Option<String>, String> {
    let old = previous.map(parse).transpose()?.unwrap_or_default();
    let mut updates = Vec::new();
    for group in incoming {
        updates.extend(parse(group)?);
    }
    let mut sources = HashMap::new();
    let mut channels = HashMap::new();
    if let Some(c) = catalog {
        for s in c["sources"].as_array().ok_or("health-invalid-catalog")? {
            sources.insert(s["id"].as_str().ok_or("health-invalid-catalog")?, s);
        }
        for ch in c["channels"].as_array().ok_or("health-invalid-catalog")? {
            channels.insert(ch["id"].as_str().ok_or("health-invalid-catalog")?, ch);
        }
    }
    let matches = |r: &Record| -> Result<bool, String> {
        let Some(ch) = channels.get(r.channel_id.as_str()) else {
            return Ok(false);
        };
        let Some(s) = sources.get(r.source_id.as_str()) else {
            return Ok(false);
        };
        let ordinal = r.checked_url_ordinal as usize;
        if ch["sourceId"] != r.source_id || ch["urls"].as_array().is_none_or(|v| ordinal >= v.len())
        {
            return Ok(false);
        }
        Ok(fingerprint(s, ch, ordinal)? == r.target_fingerprint)
    };
    let mut records = HashMap::new();
    for r in old {
        if matches(&r).or_else(|error| {
            if error == "health-target-invalid" {
                Ok(false)
            } else {
                Err(error)
            }
        })? {
            records.insert(slot(&r), r);
        }
    }
    for r in updates {
        if !matches(&r)? {
            return Err("health-target-mismatch".into());
        }
        if matches!(r.verdict.as_str(), "NotChecked" | "Canceled")
            || r.evidence["kind"] == "local-network-unavailable"
        {
            continue;
        }
        let key = slot(&r);
        if records.get(&key).is_some_and(|last| {
            r.observed_at <= last.observed_at || (r.origin == "imported" && last.origin == "local")
        }) {
            continue;
        }
        records.insert(key, r);
    }
    if previous.is_none() && incoming.is_empty() {
        return Ok(None);
    }
    let mut records: Vec<_> = records.into_values().collect();
    records.sort_by_cached_key(|r| slot(r).encode_utf16().collect::<Vec<_>>());
    encode(&records).map(Some)
}
pub fn replace(c: &Connection, payload: Option<&str>) -> Result<(), String> {
    let records = payload.map(parse).transpose()?.unwrap_or_default();
    // The caller owns the transaction. Read only existing identities here: replacement
    // must still be able to remove old invalid evidence, including hidden rows.
    let desired: HashSet<_> = records
        .iter()
        .map(|r| {
            (
                r.channel_id.as_str(),
                i64::from(r.checked_url_ordinal),
                r.platform.as_str(),
                r.observer_profile.as_str(),
            )
        })
        .collect();
    let mut existing = sql(c.prepare(
        "SELECT rowid,channel_id,url_ordinal,platform,observer_profile FROM channel_health",
    ))?;
    let mut rows = sql(existing.query([]))?;
    let mut obsolete = Vec::new();
    while let Some(row) = sql(rows.next())? {
        let keep = match (
            row.get::<_, String>(1),
            row.get::<_, i64>(2),
            row.get::<_, String>(3),
            row.get::<_, String>(4),
        ) {
            (Ok(channel), Ok(ordinal), Ok(platform), Ok(profile)) => desired.contains(&(
                channel.as_str(),
                ordinal,
                platform.as_str(),
                profile.as_str(),
            )),
            // Old replacement could clear invalid stored identities too. Do not
            // make resetting hidden/corrupt health depend on parsing those rows.
            _ => false,
        };
        if !keep {
            obsolete.push(sql(row.get::<_, i64>(0))?);
        }
    }
    drop(rows);
    drop(existing);
    drop(desired);
    let mut delete = sql(c.prepare("DELETE FROM channel_health WHERE rowid=?1"))?;
    for rowid in obsolete {
        sql(delete.execute([rowid]))?;
    }
    drop(delete);
    // A guarded UPSERT avoids both DELETE/INSERT churn and UPDATE triggers for
    // canonical rows whose values have not changed.
    let mut stmt = sql(c.prepare(
        "INSERT INTO channel_health(channel_id,url_ordinal,platform,observer_profile,source_id,target_fingerprint,observed_at,verdict,origin,evidence_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(channel_id,url_ordinal,platform,observer_profile) DO UPDATE SET
         source_id=excluded.source_id,target_fingerprint=excluded.target_fingerprint,
         observed_at=excluded.observed_at,verdict=excluded.verdict,
         origin=excluded.origin,evidence_json=excluded.evidence_json
         WHERE channel_health.source_id IS NOT excluded.source_id
         OR channel_health.target_fingerprint IS NOT excluded.target_fingerprint
         OR channel_health.observed_at IS NOT excluded.observed_at
         OR channel_health.verdict IS NOT excluded.verdict
         OR channel_health.origin IS NOT excluded.origin
         OR channel_health.evidence_json IS NOT excluded.evidence_json",
    ))?;
    for r in records {
        sql(stmt.execute(params![
            r.channel_id,
            r.checked_url_ordinal,
            r.platform,
            r.observer_profile,
            r.source_id,
            r.target_fingerprint,
            r.observed_at as i64,
            r.verdict,
            r.origin,
            r.evidence.to_string()
        ]))?;
    }
    sql(c.execute(
        "UPDATE metadata SET health_present=?1 WHERE singleton=1 AND health_present IS NOT ?1",
        params![payload.is_some()],
    ))?;
    Ok(())
}

#[cfg(test)]
#[path = "health_storage_delta_tests.rs"]
mod delta_tests;
