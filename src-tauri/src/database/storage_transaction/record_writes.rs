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

//! PairStore's health and record writes, and the preferences preflight.

use super::*;

impl PairStore {
    pub fn write_health_guarded(
        &self,
        health: &str,
        expected: &str,
        expected_health: &str,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.write_records_guarded(
            &RecordPair {
                catalog: None,
                preferences: None,
            },
            Some(health),
            Some(expected),
            Some(expected_health),
            None,
            check,
        )
    }

    pub fn write_record_guarded(
        &self,
        name: &str,
        contents: &str,
        expected: Option<&str>,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
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
        self.write_records_guarded(&p, None, expected, None, None, check)
    }

    pub(super) fn write_records_guarded(
        &self,
        p: &RecordPair,
        health: Option<&str>,
        expected: Option<&str>,
        expected_health: Option<&str>,
        scan: Option<(&crate::scan_checkpoint::Mutation, &str)>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.write_records_with_phase(p, health, (expected, expected_health), scan, |_| check())
    }

    pub(crate) fn write_records_with_phase(
        &self,
        p: &RecordPair,
        health: Option<&str>,
        expected: (Option<&str>, Option<&str>),
        scan: Option<(&crate::scan_checkpoint::Mutation, &str)>,
        mut phase: impl FnMut(Phase) -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        let (expected, expected_health) = expected;
        phase(Phase::BeforeWork)?;
        let (_, validated_preferences) = validate(p)?;
        if health.is_some() && expected.is_none() {
            return Err("catalog-revision-required".into());
        }
        let expected = expected
            .map(|value| {
                if value.is_empty()
                    || !value.bytes().all(|b| b.is_ascii_digit())
                    || (value.len() > 1 && value.starts_with('0'))
                {
                    return Err("catalog-revision-invalid".to_string());
                }
                value
                    .parse::<i64>()
                    .map_err(|_| "catalog-revision-invalid".to_string())
            })
            .transpose()?;
        if health.is_some() && expected_health.is_none() {
            return Err("health-revision-required".into());
        }
        let expected_health = expected_health
            .map(|value| {
                if value.is_empty()
                    || !value.bytes().all(|b| b.is_ascii_digit())
                    || (value.len() > 1 && value.starts_with('0'))
                {
                    return Err("health-revision-invalid".to_string());
                }
                value
                    .parse::<i64>()
                    .map_err(|_| "health-revision-invalid".to_string())
            })
            .transpose()?;
        if let Some(h) = health {
            crate::health_storage::parse(h)?;
        }
        if scan.is_some() && expected.is_none() {
            return Err("catalog-revision-required".into());
        }
        let scan = scan
            .map(|(m, r)| crate::scan_checkpoint::revision(r).map(|r| (m, r, scan_now())))
            .transpose()?;
        let mut c = connect(&self.root.join(DB), false)?;
        phase(Phase::BeforeBackup)?;
        if p.catalog.is_none() && health.is_none() && scan.is_none() {
            if let Some(preferences) = validated_preferences.as_ref() {
                if let Some(receipt) = Self::preferences_noop_preflight(
                    &mut c,
                    preferences,
                    (expected, expected_health),
                    &mut phase,
                )? {
                    return Ok(receipt);
                }
            }
        }
        self.backup_with_check(&c, || phase(Phase::DuringBackup))?;
        phase(Phase::AfterBackup)?;
        Self::apply_with_scan(
            &mut c,
            p,
            health,
            (expected, expected_health),
            scan,
            |stage| {
                if stage == Phase::AfterCommit {
                    Ok(())
                } else {
                    phase(stage)
                }
            },
        )
    }

    /// The Store's checked canonical writer remains held throughout this read
    /// preflight and any later backup/write. No speculative UPDATE or revision
    /// change is needed to recognize the exact canonical persisted preferences.
    pub(super) fn preferences_noop_preflight(
        c: &mut Connection,
        preferences: &Value,
        expected: (Option<i64>, Option<i64>),
        phase: &mut impl FnMut(Phase) -> Result<(), String>,
    ) -> Result<Option<CommitReceipt>, String> {
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let version: i64 = sql(tx.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
        if version < 19 {
            return Ok(None);
        }
        let (overall, catalog, health): (i64, i64, i64) = sql(tx.query_row(
            "SELECT revision,catalog_revision,health_revision FROM metadata WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ))?;
        if [overall, catalog, health]
            .iter()
            .any(|r| *r < 0 || *r == i64::MAX)
        {
            return Err("storage-revision-exhausted".into());
        }
        if expected.0.is_some_and(|revision| revision != catalog) {
            return Err("catalog-revision-stale".into());
        }
        if expected.1.is_some_and(|revision| revision != health) {
            return Err("health-revision-stale".into());
        }
        let current = Self::read_connection_validated(&tx)?;
        // Match only documented SQL read/write normalization. Unknown fields
        // remain in the candidate and therefore cannot receive a no-op ACK.
        // Complete source arrays, ordering, extensions and explicit/absent
        // contentLibrary remain part of equality.
        let mut candidate = preferences.clone();
        for key in ["volume", "panelWidth"] {
            candidate[key] = json!(preferences[key]
                .as_f64()
                .ok_or("record-invalid-preferences")?);
        }
        let cadence = crate::refresh_cadence::from_preferences(preferences)?;
        candidate["sourceRefreshCadence"] = json!(cadence.as_str());
        candidate["automaticSourceRefresh"] =
            json!(cadence != crate::refresh_cadence::Cadence::Off);
        candidate["sourceRefreshAttemptAt"] = json!(preferences["sourceRefreshAttemptAt"]
            .as_f64()
            .unwrap_or(0.0) as i64);
        if candidate.get("removedChannels").is_none() {
            candidate["removedChannels"] = json!([]);
        }
        if candidate
            .get("channelCategoryOverrides")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        {
            candidate
                .as_object_mut()
                .ok_or("record-invalid-preferences")?
                .remove("channelCategoryOverrides");
        }
        for source in candidate["sources"]
            .as_array_mut()
            .ok_or("record-invalid-preferences")?
        {
            if source.get("allowHttp").and_then(Value::as_bool) == Some(false) {
                source
                    .as_object_mut()
                    .ok_or("record-invalid-preferences")?
                    .remove("allowHttp");
            }
        }
        if current.preferences.as_ref() != Some(&candidate) {
            return Ok(None);
        }
        phase(Phase::BeforeCommit)?;
        sql(tx.commit())?;
        Ok(Some(CommitReceipt {
            committed: true,
            catalog_revision: catalog.to_string(),
            health_revision: health.to_string(),
            checkpoint_revision: None,
        }))
    }
}
