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

//! PairStore's reads of the catalog pair: capturing and finishing it.

use super::*;

impl PairStore {
    pub fn read_pair(&self) -> Result<RecordPair, String> {
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let captured = Self::capture_pair(&tx)?;
        sql(tx.commit())?;
        Self::finish_pair(captured)
    }

    pub(super) fn read_connection(c: &Connection) -> Result<RecordPair, String> {
        Self::read_connection_validated(c).map(|snapshot| snapshot.pair)
    }

    pub(super) fn read_connection_validated(c: &Connection) -> Result<ValidatedPair, String> {
        Self::finish_pair_canonical(Self::capture_pair(c)?)
    }

    /// One indexed walk replaces a separate SQLite URL query for every channel.
    /// The bounds are necessary subsets of the unchanged canonical validator:
    /// 100k channels, 16 URLs each, 16KiB fields and 20MiB whole catalog.
    pub(super) fn capture_channel_urls(
        c: &Connection,
    ) -> Result<HashMap<String, Vec<String>>, String> {
        const MAX_CHANNELS: usize = 100_000;
        const URLS_PER_CHANNEL: usize = 16;
        const MAX_ROWS: usize = MAX_CHANNELS * URLS_PER_CHANNEL;
        let mut statement = sql(c.prepare(
            "SELECT CASE WHEN length(CAST(channel_id AS BLOB)) BETWEEN 1 AND 16384 THEN channel_id ELSE NULL END,
                    CASE WHEN length(CAST(url AS BLOB))<=16384 THEN url ELSE NULL END
             FROM channel_url ORDER BY channel_id,ordinal LIMIT ?1",
        ))?;
        let rows = sql(statement.query_map([(MAX_ROWS + 1) as i64], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        }))?;
        let mut groups: HashMap<String, Vec<String>> = HashMap::new();
        let mut bytes = 0usize;
        for (index, row) in rows.enumerate() {
            if index == MAX_ROWS {
                return Err("record-array-too-large".into());
            }
            let (id, url) = sql(row)?;
            let id = id.ok_or("record-invalid-field")?;
            let url = url.ok_or("record-invalid-url")?;
            if !groups.contains_key(&id) {
                if groups.len() == MAX_CHANNELS {
                    return Err("record-array-too-large".into());
                }
                // Count IDs once, as canonical JSON does; counting them once
                // per URL would incorrectly reject legitimate long identities.
                bytes += id.len();
            }
            bytes += url.len();
            if bytes as u64 > LIMIT {
                return Err("record-too-large".into());
            }
            let urls = groups.entry(id).or_default();
            if urls.len() == URLS_PER_CHANNEL {
                return Err("record-array-too-large".into());
            }
            urls.push(url);
        }
        Ok(groups)
    }

    pub(super) fn capture_pair(c: &Connection) -> Result<CapturedPair, String> {
        let mut extensions = [None, None, None];
        let (cp, pp): (bool, bool) = sql(c.query_row(
            "SELECT catalog_present,preferences_present FROM metadata WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        let mut source_stmt =
            sql(c.prepare("SELECT id,name,location,kind,allow_http,content_kind,media_mime FROM source ORDER BY ordinal"))?;
        let sources = sql(source_stmt.query_map([], |r| {
            let id: String = r.get(0)?;
            let name: String = r.get(1)?;
            let location: String = r.get(2)?;
            let kind: String = r.get(3)?;
            let mut v = json!({ "id": id, "name": name, "location": location, "kind": kind });
            let http: bool = r.get(4)?;
            if http {
                v["allowHttp"] = json!(true);
            }
            if let Some(kind) = r.get::<_, Option<String>>(5)? {
                v["contentKind"] = json!(kind);
            }
            if let Some(mime) = r.get::<_, Option<String>>(6)? {
                v["mediaMime"] = json!(mime);
            }
            Ok(v)
        }))?
        .collect::<rusqlite::Result<Vec<_>>>();
        let sources = sql(sources)?;
        let catalog = if cp {
            let mut stmt = sql(c.prepare(
                "SELECT id,source_id,provider_id,name,category,country,region,state,geography_provenance FROM channel ORDER BY ordinal",
            ))?;
            let rows = sql(stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<String>>(8)?,
                ))
            }))?;
            let mut channels = Vec::new();
            let mut urls_by_channel = Self::capture_channel_urls(c)?;
            for row in rows {
                let (id, sid, pid, name, category, country, region, state, provenance) = sql(row)?;
                let urls = urls_by_channel.remove(&id).unwrap_or_default();
                let mut ch =
                    json!({"id":id,"sourceId":sid,"name":name,"category":category,"urls":urls});
                if let Some(pid) = pid {
                    ch["providerId"] = json!(pid);
                }
                let mut g = serde_json::Map::new();
                for (key, value) in [("country", country), ("region", region), ("state", state)] {
                    if let Some(value) = value {
                        g.insert(key.into(), json!(value));
                    }
                }
                if !g.is_empty() {
                    ch["geography"] = Value::Object(g);
                }
                if let Some(value) = provenance {
                    ch["geographyProvenance"] = json!(value);
                }
                channels.push(ch);
            }
            if !urls_by_channel.is_empty() {
                return Err("record-orphaned-channel-url".into());
            }
            Some(json!({"schemaVersion":1,"sources":sources,"channels":channels}))
        } else {
            None
        };
        let preferences = if pp {
            let ids = |table: &str| -> Result<Vec<String>, String> {
                let mut s = sql(c.prepare(&format!("SELECT id FROM {table} ORDER BY ordinal")))?;
                let a =
                    sql(s.query_map([], |r| r.get(0)))?.collect::<rusqlite::Result<Vec<String>>>();
                sql(a)
            };
            let (volume, muted, width): (f64, bool, f64) = sql(c.query_row(
                "SELECT volume,muted,panel_width FROM preference WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            ))?;
            let (automatic, attempt): (bool, i64) = if sql(c.query_row(
                "PRAGMA user_version",
                [],
                |r| r.get::<_, i64>(0),
            ))? >= 6
            {
                sql(c.query_row(
                    "SELECT auto_source_refresh,source_refresh_attempt_at FROM preference WHERE singleton=1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                ))?
            } else {
                (false, 0)
            };
            let mut pref = json!({"schemaVersion":1,"favorites":ids("favorite")?,"removedChannels":ids("removed")?,"volume":volume,"muted":muted,"panelWidth":width,"sources":sources,"automaticSourceRefresh":automatic,"sourceRefreshAttemptAt":attempt});
            if sql(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 8 {
                let cadence: String = sql(c.query_row(
                    "SELECT source_refresh_cadence FROM preference WHERE singleton=1",
                    [],
                    |r| r.get(0),
                ))?;
                // Store raw cadence; parse only after the read transaction ends.
                pref["sourceRefreshCadence"] = json!(cadence);
            }
            if sql(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 7 {
                let stored_extensions: (Option<String>, Option<String>, Option<String>) = sql(c.query_row(
                    "SELECT reviewed_channel_providers,reviewed_guide_providers,preferred_region FROM preference WHERE singleton=1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                ))?;
                extensions = [
                    stored_extensions.0,
                    stored_extensions.1,
                    stored_extensions.2,
                ];
                let consent: Option<bool> = sql(c.query_row(
                    "SELECT voice_search_consent FROM preference WHERE singleton=1",
                    [],
                    |r| r.get(0),
                ))?;
                if let Some(consent) = consent {
                    pref["voiceSearchConsent"] = json!(consent);
                }
            }
            if sql(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 10 {
                let overrides = channel_categories::capture(c)?;
                if !overrides.is_empty() {
                    pref["channelCategoryOverrides"] = json!(overrides);
                }
            }
            if sql(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 11 {
                let enabled: Option<bool> = sql(c.query_row(
                    "SELECT automatic_guide_updates FROM metadata WHERE singleton=1",
                    [],
                    |r| r.get(0),
                ))?;
                if let Some(enabled) = enabled {
                    pref["automaticGuideUpdates"] = json!(enabled);
                }
            }
            if sql(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 19 {
                let library: Option<String> = sql(c.query_row(
                    "SELECT content_library FROM preference WHERE singleton=1",
                    [],
                    |r| r.get(0),
                ))?;
                if let Some(library) = library {
                    pref["contentLibrary"] = json!(library);
                }
            }
            Some(pref)
        } else {
            None
        };
        Ok(CapturedPair {
            catalog,
            preferences,
            extensions,
        })
    }

    pub(super) fn finish_pair(captured: CapturedPair) -> Result<RecordPair, String> {
        Self::finish_pair_validated(captured).map(|(pair, _)| pair)
    }

    pub(super) fn finish_pair_validated(
        captured: CapturedPair,
    ) -> Result<(RecordPair, Option<Value>), String> {
        let snapshot = Self::finish_pair_canonical(captured)?;
        Ok((snapshot.pair, snapshot.catalog))
    }

    pub(super) fn finish_pair_canonical(
        mut captured: CapturedPair,
    ) -> Result<ValidatedPair, String> {
        if let Some(catalog) = captured.catalog.as_mut() {
            for channel in catalog["channels"]
                .as_array_mut()
                .ok_or("catalog-invalid-channels")?
            {
                if let Some(raw) = channel.get("geographyProvenance").and_then(Value::as_str) {
                    channel["geographyProvenance"] =
                        serde_json::from_str(raw).map_err(|_| "sqlite-invalid-geography")?;
                }
                geography(channel)?;
            }
        }
        if let Some(pref) = captured.preferences.as_mut() {
            for (key, raw) in [
                "reviewedChannelProviders",
                "reviewedGuideProviders",
                "preferredRegion",
            ]
            .into_iter()
            .zip(captured.extensions)
            {
                if let Some(raw) = raw {
                    if raw.len() as u64 > LIMIT {
                        return Err("record-too-large".into());
                    }
                    pref[key] = serde_json::from_str(&raw).map_err(|_| "record-invalid-json")?;
                }
            }
            if let Some(raw) = pref.get("sourceRefreshCadence").and_then(Value::as_str) {
                let parsed = crate::refresh_cadence::Cadence::parse(raw)?;
                pref["sourceRefreshCadence"] = json!(parsed.as_str());
                pref["automaticSourceRefresh"] =
                    json!(parsed != crate::refresh_cadence::Cadence::Off);
            }
            preference_extensions::normalize(pref)?;
        }
        let encode = |v: Option<Value>| {
            v.map(|v| serde_json::to_string(&v).map_err(|_| "record-encoding-failed".to_string()))
                .transpose()
        };
        let result = RecordPair {
            catalog: encode(captured.catalog)?,
            preferences: encode(captured.preferences)?,
        };
        // Validation already parses the exact encoded canonical catalog. Snapshot
        // reads reuse that value for health targets instead of parsing it again.
        let (catalog, preferences) = validate(&result)?;
        Ok(ValidatedPair {
            pair: result,
            catalog,
            preferences,
        })
    }
}
