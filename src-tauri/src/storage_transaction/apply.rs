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

//! PairStore's writes of the catalog pair: committing, applying guarded and
//! scan transactions, and inserting sources.

use super::*;

impl PairStore {
    pub fn read(&self, name: &str) -> Result<Option<String>, String> {
        let p = self.read_pair()?;
        match name {
            "catalog" => Ok(p.catalog),
            "preferences" => Ok(p.preferences),
            _ => Err("invalid-record-name".into()),
        }
    }

    #[cfg(test)]
    pub fn write(&self, name: &str, contents: &str) -> Result<(), String> {
        let p = match name {
            "catalog" => RecordPair {
                catalog: Some(contents.into()),
                preferences: None,
            },
            "preferences" => RecordPair {
                catalog: None,
                preferences: Some(contents.into()),
            },
            _ => return Err("invalid-record-name".into()),
        };
        self.commit(&p, |_| Ok(()))
    }

    #[cfg(test)]
    pub fn write_pair(&self, catalog: &str, preferences: &str) -> Result<(), String> {
        self.commit(
            &RecordPair {
                catalog: Some(catalog.into()),
                preferences: Some(preferences.into()),
            },
            |_| Ok(()),
        )
    }

    #[cfg(test)]
    pub(super) fn commit<F: FnMut(Phase) -> Result<(), String>>(
        &self,
        p: &RecordPair,
        checkpoint: F,
    ) -> Result<(), String> {
        validate(p)?;
        let mut c = connect(&self.root.join(DB), false)?;
        self.backup(&c)?;
        Self::apply(&mut c, p, checkpoint)
    }

    pub(super) fn apply<F: FnMut(Phase) -> Result<(), String>>(
        c: &mut Connection,
        p: &RecordPair,
        checkpoint: F,
    ) -> Result<(), String> {
        Self::apply_guarded(c, p, None, None, checkpoint).map(|_| ())
    }

    pub(super) fn apply_guarded<F: FnMut(Phase) -> Result<(), String>>(
        c: &mut Connection,
        p: &RecordPair,
        health: Option<&str>,
        expected: Option<i64>,
        checkpoint: F,
    ) -> Result<CommitReceipt, String> {
        Self::apply_guarded_cas(c, p, health, expected, None, checkpoint)
    }

    pub(super) fn apply_guarded_cas<F: FnMut(Phase) -> Result<(), String>>(
        c: &mut Connection,
        p: &RecordPair,
        health: Option<&str>,
        expected: Option<i64>,
        expected_health: Option<i64>,
        checkpoint: F,
    ) -> Result<CommitReceipt, String> {
        Self::apply_with_scan(c, p, health, (expected, expected_health), None, checkpoint)
    }

    pub(super) fn apply_with_scan<F: FnMut(Phase) -> Result<(), String>>(
        c: &mut Connection,
        p: &RecordPair,
        health: Option<&str>,
        expected: (Option<i64>, Option<i64>),
        scan: Option<(&crate::scan_checkpoint::Mutation, i64, u64)>,
        mut checkpoint: F,
    ) -> Result<CommitReceipt, String> {
        let validated = validate(p)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let receipt = Self::apply_scan_transaction(
            &tx,
            p,
            health,
            expected,
            scan,
            PairReuse {
                validated,
                before: None,
                projection_ids: None,
                health_groups: None,
                observer: None,
            },
            &mut checkpoint,
        )?;
        sql(tx.commit())?;
        checkpoint(Phase::AfterCommit)?;
        Ok(receipt)
    }

    pub(super) fn apply_scan_transaction<F: FnMut(Phase) -> Result<(), String>>(
        tx: &rusqlite::Transaction<'_>,
        p: &RecordPair,
        health: Option<&str>,
        expected: (Option<i64>, Option<i64>),
        scan: Option<(&crate::scan_checkpoint::Mutation, i64, u64)>,
        reuse: PairReuse<'_, '_>,
        checkpoint: &mut F,
    ) -> Result<CommitReceipt, String> {
        let PairReuse {
            validated,
            before,
            projection_ids,
            health_groups,
            mut observer,
        } = reuse;
        let (expected, expected_health) = expected;
        let (catalog, prefs) = validated;
        let modern_health =
            sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 5;
        let indexed = sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 9;
        let user_categories =
            sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 10;
        let old_categories = if user_categories {
            Some(channel_categories::semantic(tx)?)
        } else {
            None
        };
        let preference_identities = |c: &Connection| -> Result<Vec<Vec<String>>, String> {
            ["favorite", "removed"]
                .into_iter()
                .map(|table| {
                    let mut statement =
                        sql(c.prepare(&format!("SELECT id FROM {table} ORDER BY id")))?;
                    let ids = sql(statement.query_map([], |r| r.get::<_, String>(0)))?;
                    sql(ids.collect())
                })
                .collect()
        };
        let old_identities = if indexed {
            Some(preference_identities(tx)?)
        } else {
            None
        };
        let mut before = if modern_health {
            match before {
                Some(snapshot) => Some(snapshot),
                None => {
                    let snapshot = Self::read_connection_validated(tx)?;
                    if let Some(observe) = observer.as_mut() {
                        observe(PairCaptureStage::Before);
                    }
                    Some(snapshot)
                }
            }
        } else {
            None
        };
        let old_health = if modern_health {
            crate::health_storage::read(tx)?
        } else {
            None
        };
        let revision = if modern_health {
            sql(tx.query_row(
                "SELECT catalog_revision FROM metadata WHERE singleton=1",
                [],
                |r| r.get::<_, i64>(0),
            ))?
        } else {
            0
        };
        let (overall, hr): (i64, i64) = if modern_health {
            sql(tx.query_row(
                "SELECT revision,health_revision FROM metadata WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ))?
        } else {
            (0, 0)
        };
        if revision < 0 || hr < 0 || overall < 0 || [revision, hr, overall].contains(&i64::MAX) {
            return Err("storage-revision-exhausted".into());
        }
        if expected.is_some_and(|r| r != revision) {
            return Err("catalog-revision-stale".into());
        }
        if expected_health.is_some_and(|r| r != hr) {
            return Err("health-revision-stale".into());
        }
        if let Some(cat) = catalog {
            if modern_health {
                let previous = before
                    .as_ref()
                    .and_then(|snapshot| snapshot.catalog.as_ref());
                if let Some(observe) = observer.as_mut() {
                    observe(PairCaptureStage::BeforeDeltaReuse);
                }
                if let Some(groups) = projection_ids.as_deref() {
                    if groups.len() == 1 {
                        catalog_delta::apply_compact(tx, previous, &cat, &groups[0])?;
                    } else {
                        catalog_delta::apply_groups(tx, previous, &cat, groups)?;
                    }
                } else {
                    catalog_delta::apply(tx, previous, &cat)?;
                }
            } else {
                sql(tx.execute_batch(
                    "DELETE FROM channel_url;DELETE FROM channel;DELETE FROM source;",
                ))?;
                Self::insert_sources(tx, array(&cat, "sources", 100)?)?;
                let modern =
                    sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 3;
                let mut cs = sql(tx.prepare(if modern {
                    "INSERT INTO channel VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"
                } else {
                    "INSERT INTO channel VALUES(?1,?2,?3,?4,?5,?6)"
                }))?;
                let mut us = sql(tx.prepare("INSERT INTO channel_url VALUES(?1,?2,?3)"))?;
                for (i, ch) in array(&cat, "channels", 100000)?.iter().enumerate() {
                    let mut fields: Vec<rusqlite::types::Value> = vec![
                        ch["id"].as_str().unwrap().to_owned().into(),
                        ch["sourceId"].as_str().unwrap().to_owned().into(),
                        ch["providerId"]
                            .as_str()
                            .map(|v| v.to_owned().into())
                            .unwrap_or(rusqlite::types::Value::Null),
                        ch["name"].as_str().unwrap().to_owned().into(),
                        ch["category"].as_str().unwrap().to_owned().into(),
                        (i as i64).into(),
                    ];
                    if modern {
                        for key in ["country", "region", "state"] {
                            fields.push(
                                ch["geography"][key]
                                    .as_str()
                                    .map(|v| v.to_owned().into())
                                    .unwrap_or(rusqlite::types::Value::Null),
                            );
                        }
                        fields.push(
                            ch.get("geographyProvenance")
                                .map(|p| serde_json::to_string(p).map(rusqlite::types::Value::Text))
                                .transpose()
                                .map_err(|_| "record-encoding-failed")?
                                .unwrap_or(rusqlite::types::Value::Null),
                        );
                    }
                    sql(cs.execute(rusqlite::params_from_iter(fields)))?;
                    for (j, u) in ch["urls"]
                        .as_array()
                        .ok_or("record-invalid-url")?
                        .iter()
                        .enumerate()
                    {
                        sql(us.execute(params![ch["id"].as_str(), j as i64, u.as_str()]))?;
                    }
                }
            }
            sql(tx.execute(
                "UPDATE metadata SET catalog_present=1 WHERE singleton=1",
                [],
            ))?;
        }
        checkpoint(Phase::AfterCatalog)?;
        if let Some(pref) = prefs {
            let cp: bool = sql(tx.query_row(
                "SELECT catalog_present FROM metadata WHERE singleton=1",
                [],
                |r| r.get(0),
            ))?;
            if !cp {
                sql(tx.execute("DELETE FROM source", []))?;
                Self::insert_sources(tx, array(&pref, "sources", 100)?)?;
            }
            sql(tx.execute_batch(
                "DELETE FROM favorite;DELETE FROM removed;DELETE FROM preference;",
            ))?;
            for (table, key) in [("favorite", "favorites"), ("removed", "removedChannels")] {
                if let Some(a) = pref[key].as_array() {
                    let mut stmt = sql(tx.prepare(&format!("INSERT INTO {table} VALUES(?1,?2)")))?;
                    for (i, id) in a.iter().enumerate() {
                        sql(stmt.execute(params![id.as_str(), i as i64]))?;
                    }
                }
            }
            sql(tx.execute(
                "INSERT INTO preference(singleton,volume,muted,panel_width) VALUES(1,?1,?2,?3)",
                params![
                    pref["volume"].as_f64(),
                    pref["muted"].as_bool(),
                    pref["panelWidth"].as_f64()
                ],
            ))?;
            if sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 6 {
                sql(tx.execute(
                    "UPDATE preference SET auto_source_refresh=?1,source_refresh_attempt_at=?2 WHERE singleton=1",
                    params![
                        crate::refresh_cadence::from_preferences(&pref)? != crate::refresh_cadence::Cadence::Off,
                        pref["sourceRefreshAttemptAt"].as_f64().unwrap_or(0.0) as i64
                    ],
                ))?;
            }
            if sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 8 {
                sql(tx.execute(
                    "UPDATE preference SET source_refresh_cadence=?1 WHERE singleton=1",
                    params![crate::refresh_cadence::from_preferences(&pref)?.as_str()],
                ))?;
            }
            if sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 7 {
                let json_field = |key: &str| -> Result<Option<String>, String> {
                    pref.get(key)
                        .map(serde_json::to_string)
                        .transpose()
                        .map_err(|_| "record-encoding-failed".into())
                };
                sql(tx.execute(
                    "UPDATE preference SET reviewed_channel_providers=?1,reviewed_guide_providers=?2,preferred_region=?3 WHERE singleton=1",
                    params![
                        json_field("reviewedChannelProviders")?,
                        json_field("reviewedGuideProviders")?,
                        json_field("preferredRegion")?
                    ],
                ))?;
                sql(tx.execute(
                    "UPDATE preference SET voice_search_consent=?1 WHERE singleton=1",
                    params![pref.get("voiceSearchConsent").and_then(Value::as_bool)],
                ))?;
            }
            if sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 11 {
                sql(tx.execute(
                    "UPDATE metadata SET automatic_guide_updates=?1 WHERE singleton=1",
                    params![pref.get("automaticGuideUpdates").and_then(Value::as_bool)],
                ))?;
            } else if pref.get("automaticGuideUpdates").is_some() {
                return Err("sqlite-unsupported-automatic-guide-updates".into());
            }
            if sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 19 {
                sql(tx.execute(
                    "UPDATE preference SET content_library=?1 WHERE singleton=1",
                    params![pref.get("contentLibrary").and_then(Value::as_str)],
                ))?;
            } else if pref.get("contentLibrary").is_some() {
                return Err("sqlite-unsupported-content-library".into());
            }
            if user_categories {
                channel_categories::replace(tx, pref.get("channelCategoryOverrides"))?;
            } else if pref.get("channelCategoryOverrides").is_some() {
                return Err("sqlite-unsupported-category-overrides".into());
            }
            sql(tx.execute(
                "UPDATE metadata SET preferences_present=1 WHERE singleton=1",
                [],
            ))?;
        }
        // The delta has consumed the prior trees; only the canonical text is still
        // compared. Freeing them lowers the peak while the after snapshot is read.
        if let Some(snapshot) = before.as_mut() {
            snapshot.catalog = None;
            snapshot.preferences = None;
        }
        // Keep SQL's exact canonical strings as authority. Health and checkpoint
        // processing share this snapshot; neither changes canonical pair rows.
        let mut after = if modern_health || scan.is_some() {
            let snapshot = Self::read_connection_validated(tx)?;
            if let Some(observe) = observer.as_mut() {
                observe(PairCaptureStage::After);
            }
            Some(snapshot)
        } else {
            None
        };
        if modern_health {
            let new_catalog = after
                .as_ref()
                .and_then(|snapshot| snapshot.pair.catalog.as_ref());
            let parsed_catalog = after
                .as_ref()
                .and_then(|snapshot| snapshot.catalog.as_ref());
            if let Some(observe) = observer.as_mut() {
                observe(PairCaptureStage::AfterHealthReuse);
            }
            let retained = if let Some(groups) = health_groups {
                crate::health_storage::reconcile_groups(
                    old_health.as_deref(),
                    &groups.iter().map(String::as_str).collect::<Vec<_>>(),
                    parsed_catalog,
                )?
            } else {
                crate::health_storage::reconcile(old_health.as_deref(), health, parsed_catalog)?
            };
            let old_catalog = before
                .as_ref()
                .and_then(|snapshot| snapshot.pair.catalog.as_ref());
            let catalog_changed = old_catalog != new_catalog;
            drop(before);
            // The checkpoint below needs only the parsed trees.
            if let Some(snapshot) = after.as_mut() {
                snapshot.pair = RecordPair::default();
            }
            let health_changed = old_health != retained;
            if catalog_changed && revision == i64::MAX {
                return Err("catalog-revision-exhausted".into());
            }
            crate::health_storage::replace(tx, retained.as_deref())?;
            if indexed {
                // Incrementally reconcile projection rows within this canonical transaction.
                let categories_changed = if user_categories {
                    old_categories.as_ref() != Some(&channel_categories::semantic(tx)?)
                } else {
                    false
                };
                if p.catalog.is_some() || categories_changed {
                    if !categories_changed {
                        if let Some(groups) = projection_ids.as_deref() {
                            for ids in groups {
                                crate::catalog_query::reconcile_projection(tx, ids)?;
                            }
                        } else {
                            crate::catalog_query::rebuild_projection(tx)?;
                        }
                    } else {
                        crate::catalog_query::rebuild_projection(tx)?;
                    }
                }
                let identity_changed = old_identities.as_ref() != Some(&preference_identities(tx)?);
                crate::catalog_query::advance_view_revision(
                    tx,
                    catalog_changed || identity_changed || categories_changed,
                )?;
            }
            sql(tx.execute(
                "UPDATE metadata SET catalog_revision=catalog_revision+?1,health_revision=health_revision+?2 WHERE singleton=1",
                params![catalog_changed, health_changed],
            ))?;
        }
        if p.catalog.is_some() || p.preferences.is_some() {
            sql(tx.execute(
                "UPDATE metadata SET revision=revision+1 WHERE singleton=1",
                [],
            ))?;
        }
        let (cr, hr) = if modern_health {
            sql(tx.query_row(
                "SELECT catalog_revision,health_revision FROM metadata WHERE singleton=1",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            ))?
        } else {
            (0, 0)
        };
        let checkpoint_revision = if let Some((mutation, expected_scan, now)) = scan {
            let current_pair = after
                .as_ref()
                .ok_or("scan-checkpoint-preferences-required")?;
            let empty_catalog = json!({"schemaVersion":1,"sources":[],"channels":[]});
            let catalog_value = current_pair.catalog.as_ref().unwrap_or(&empty_catalog);
            let preferences_value = current_pair
                .preferences
                .as_ref()
                .ok_or("scan-checkpoint-preferences-required")?;
            if let Some(observe) = observer.as_mut() {
                observe(PairCaptureStage::AfterCheckpointReuse);
            }
            Some(crate::scan_checkpoint::apply(
                tx,
                mutation,
                expected_scan,
                preferences_value,
                catalog_value,
                (revision, cr, now),
                || checkpoint(Phase::BeforeCommit),
            )?)
        } else {
            None
        };
        checkpoint(Phase::BeforeCommit)?;
        Ok(CommitReceipt {
            committed: true,
            catalog_revision: cr.to_string(),
            health_revision: hr.to_string(),
            checkpoint_revision,
        })
    }

    pub(super) fn insert_sources(c: &Connection, sources: &[Value]) -> Result<(), String> {
        let mut s = sql(c.prepare("INSERT INTO source VALUES(?1,?2,?3,?4,?5,?6,?7,?8)"))?;
        for (i, v) in sources.iter().enumerate() {
            sql(s.execute(params![
                v["id"].as_str(),
                v["name"].as_str(),
                v["location"].as_str(),
                v["kind"].as_str(),
                v["allowHttp"].as_bool().unwrap_or(false),
                v["contentKind"].as_str(),
                v["mediaMime"].as_str(),
                i as i64
            ]))?;
        }
        Ok(())
    }
}
