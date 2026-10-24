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

//! PairStore's guarded writes and scan commits: batches and windows of
//! checked channels.

use super::*;

impl PairStore {
    #[cfg(test)]
    pub fn write_guarded(
        &self,
        catalog: &str,
        preferences: &str,
        health: Option<&str>,
        expected: Option<&str>,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        // Compatibility helper only for pre-CAS storage fixtures. Production IPC
        // must supply both captured revisions and uses write_guarded_cas directly.
        let snapshot = self.read_snapshot()?;
        let expected_health = snapshot.health_revision;
        let expected_catalog = snapshot.catalog_revision;
        self.write_guarded_cas(
            catalog,
            preferences,
            health,
            (expected.or(Some(&expected_catalog)), Some(&expected_health)),
            check,
        )
    }

    #[cfg(test)]
    pub fn write_guarded_cas(
        &self,
        catalog: &str,
        preferences: &str,
        health: Option<&str>,
        expected: (Option<&str>, Option<&str>),
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        let p = RecordPair {
            catalog: Some(catalog.into()),
            preferences: Some(preferences.into()),
        };
        self.write_records_guarded(&p, health, expected.0, expected.1, None, check)
    }

    pub fn write_pair_with_scan(
        &self,
        pair: &RecordPair,
        health: Option<&str>,
        expected: (Option<&str>, Option<&str>),
        scan: Option<(&crate::scan_checkpoint::Mutation, &str)>,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.write_records_guarded(pair, health, expected.0, expected.1, scan, check)
    }

    pub(crate) fn mutate_catalog_group(
        &self,
        request: &crate::catalog_group_mutation::Request,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<CatalogGroupReceipt, String> {
        check()?;
        let mut connection = connect(&self.root.join(DB), false)?;
        self.backup_with_check(&connection, &mut check)?;
        check()?;
        let tx = sql(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let pending = crate::catalog_group_mutation::apply(&tx, request, &mut check)?;
        // Validate complete canonical catalog/preferences after all group edits.
        // Failure rolls back every member; no partial group acknowledgment.
        let _validated = Self::read_connection_validated(&tx)?;
        check()?;
        sql(tx.commit())?;
        // Never turn a crossed durable commit into a late cancellation error.
        Ok(CatalogGroupReceipt {
            schema_version: 1,
            committed: true,
            catalog_revision: pending.catalog_revision,
            view_revision: pending.view_revision,
            affected_count: pending.affected_count,
        })
    }

    pub(crate) fn read_scan_commit_revisions(
        &self,
    ) -> Result<crate::scan_batch::Revisions, String> {
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let (catalog_revision, health_revision): (i64, i64) = sql(tx.query_row(
            "SELECT catalog_revision,health_revision FROM metadata WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        sql(tx.commit())?;
        if catalog_revision < 0 || health_revision < 0 {
            return Err("storage-revision-invalid".into());
        }
        Ok(crate::scan_batch::Revisions {
            schema_version: 1,
            catalog_revision: catalog_revision.to_string(),
            health_revision: health_revision.to_string(),
        })
    }

    pub(crate) fn read_scan_checkpoint_summary(
        &self,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_checkpoint_summary::Summary, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let captured = crate::scan_checkpoint_summary::capture(&tx)?;
        sql(tx.commit())?;
        let summary = crate::scan_checkpoint_summary::finish(captured, &mut check)?;
        check()?;
        Ok(summary)
    }

    pub(crate) fn commit_scan_batch(
        &self,
        batch: &crate::scan_batch::Batch,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.commit_scan_batch_with_phase(batch, |_| check())
    }

    pub(super) fn commit_scan_batch_with_phase(
        &self,
        batch: &crate::scan_batch::Batch,
        mut phase: impl FnMut(Phase) -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.commit_scan_batch_observed(batch, &mut phase, None)
    }

    pub(super) fn commit_scan_batch_observed(
        &self,
        batch: &crate::scan_batch::Batch,
        phase: &mut impl FnMut(Phase) -> Result<(), String>,
        observer: Option<&mut dyn FnMut(PairCaptureStage)>,
    ) -> Result<CommitReceipt, String> {
        // Preserve the existing capture-only fixture seam. The value observer is
        // operation-local and can additionally prove which consumers reuse it.
        match observer {
            Some(observe) => self.commit_scan_batch_values_observed(
                batch,
                phase,
                Some(&mut |stage| {
                    if matches!(stage, PairCaptureStage::Before | PairCaptureStage::After) {
                        observe(stage);
                    }
                }),
            ),
            None => self.commit_scan_batch_values_observed(batch, phase, None),
        }
    }

    pub(super) fn commit_scan_batch_values_observed(
        &self,
        batch: &crate::scan_batch::Batch,
        phase: &mut impl FnMut(Phase) -> Result<(), String>,
        mut observer: Option<&mut dyn FnMut(PairCaptureStage)>,
    ) -> Result<CommitReceipt, String> {
        phase(Phase::BeforeWork)?;
        let expected = crate::scan_batch::validate_envelope(batch)?;
        let health =
            serde_json::to_string(&json!({"schemaVersion":1,"records":batch.incoming_health}))
                .map_err(|_| "health-encoding-failed")?;
        crate::health_storage::parse(&health)?;
        let scan = batch
            .scan_checkpoint
            .as_ref()
            .zip(batch.expected_checkpoint_revision.as_deref())
            .map(|(mutation, revision)| {
                crate::scan_checkpoint::revision(revision).map(|r| (mutation, r, scan_now()))
            })
            .transpose()?;
        let mut c = connect(&self.root.join(DB), false)?;
        phase(Phase::BeforeBackup)?;
        self.backup_with_check(&c, || phase(Phase::DuringBackup))?;
        phase(Phase::AfterBackup)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let actual: (i64, i64) = sql(tx.query_row(
            "SELECT catalog_revision,health_revision FROM metadata WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        if actual.0 != expected.0 {
            return Err("catalog-revision-stale".into());
        }
        if actual.1 != expected.1 {
            return Err("health-revision-stale".into());
        }
        let old = Self::read_connection_validated(&tx)?;
        if let Some(observe) = observer.as_mut() {
            observe(PairCaptureStage::Before);
        }
        let empty_catalog = json!({"schemaVersion":1,"sources":[],"channels":[]});
        let old_catalog = old.catalog.as_ref().unwrap_or(&empty_catalog);
        if let Some(observe) = observer.as_mut() {
            observe(PairCaptureStage::BeforeCatalogReuse);
        }
        let catalog = crate::scan_batch::expand(batch, old_catalog, || phase(Phase::BeforeCommit))?;
        let pair = RecordPair {
            catalog: Some(serde_json::to_string(&catalog).map_err(|_| "record-encoding-failed")?),
            preferences: Some(
                serde_json::to_string(&batch.next_preferences)
                    .map_err(|_| "record-encoding-failed")?,
            ),
        };
        let validated = validate(&pair)?;
        // expand + canonical validation admitted every patch identity; collect
        // the entire bounded patch, never filter/truncate changed rows.
        let projection_ids = batch
            .catalog_patch
            .channels
            .iter()
            .map(|channel| {
                channel["id"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "scan-batch-invalid".to_string())
            })
            .collect::<Result<Vec<_>, String>>()?;
        let receipt = Self::apply_scan_transaction(
            &tx,
            &pair,
            Some(&health),
            (Some(expected.0), Some(expected.1)),
            scan,
            PairReuse {
                validated,
                before: Some(old),
                projection_ids: Some(vec![projection_ids]),
                health_groups: None,
                observer,
            },
            phase,
        )?;
        sql(tx.commit())?;
        // Durable publication wins over a cancellation arriving after COMMIT.
        let _ = phase(Phase::AfterCommit);
        Ok(receipt)
    }

    pub(crate) fn commit_scan_window(
        &self,
        window: &crate::scan_window::Window,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.commit_scan_window_observed(window, &mut |_| check(), None)
    }

    pub(super) fn commit_scan_window_observed(
        &self,
        window: &crate::scan_window::Window,
        phase: &mut impl FnMut(Phase) -> Result<(), String>,
        observer: Option<&mut dyn FnMut(PairCaptureStage)>,
    ) -> Result<CommitReceipt, String> {
        self.commit_scan_window_with_page_limit(
            window,
            phase,
            observer,
            #[cfg(test)]
            None,
        )
    }

    pub(super) fn commit_scan_window_with_page_limit(
        &self,
        window: &crate::scan_window::Window,
        phase: &mut impl FnMut(Phase) -> Result<(), String>,
        mut observer: Option<&mut dyn FnMut(PairCaptureStage)>,
        #[cfg(test)] max_page_count: Option<i64>,
    ) -> Result<CommitReceipt, String> {
        phase(Phase::BeforeWork)?;
        let expected = crate::scan_window::validate(window)?;
        let health_groups = window
            .chunks
            .iter()
            .map(|chunk| {
                let raw = serde_json::to_string(
                    &json!({"schemaVersion":1,"records":chunk.incoming_health}),
                )
                .map_err(|_| "health-encoding-failed")?;
                crate::health_storage::parse(&raw)?;
                Ok(raw)
            })
            .collect::<Result<Vec<String>, String>>()?;
        let scan = window
            .scan_checkpoint
            .as_ref()
            .zip(window.expected_checkpoint_revision.as_deref())
            .map(|(mutation, revision)| {
                crate::scan_checkpoint::revision(revision).map(|r| (mutation, r, scan_now()))
            })
            .transpose()?;
        let mut c = connect(&self.root.join(DB), false)?;
        #[cfg(test)]
        if let Some(maximum) = max_page_count {
            sql(c.pragma_update(None, "max_page_count", maximum))?;
        }
        phase(Phase::BeforeBackup)?;
        self.backup_with_check(&c, || phase(Phase::DuringBackup))?;
        phase(Phase::AfterBackup)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let actual: (i64, i64) = sql(tx.query_row(
            "SELECT catalog_revision,health_revision FROM metadata WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        if actual.0 != expected.0 {
            return Err("catalog-revision-stale".into());
        }
        if actual.1 != expected.1 {
            return Err("health-revision-stale".into());
        }
        let old = Self::read_connection_validated(&tx)?;
        if let Some(observe) = observer.as_mut() {
            observe(PairCaptureStage::Before);
        }
        let empty_catalog = json!({"schemaVersion":1,"sources":[],"channels":[]});
        let old_catalog = old.catalog.as_ref().unwrap_or(&empty_catalog);
        if let Some(observe) = observer.as_mut() {
            observe(PairCaptureStage::BeforeCatalogReuse);
        }
        let catalog =
            crate::scan_window::expand(window, old_catalog, || phase(Phase::BeforeCommit))?;
        let pair = RecordPair {
            catalog: Some(serde_json::to_string(&catalog).map_err(|_| "record-encoding-failed")?),
            preferences: Some(
                serde_json::to_string(&window.next_preferences)
                    .map_err(|_| "record-encoding-failed")?,
            ),
        };
        let validated = validate(&pair)?;
        let projection_ids = crate::scan_window::ids(window)?;
        let receipt = Self::apply_scan_transaction(
            &tx,
            &pair,
            None,
            (Some(expected.0), Some(expected.1)),
            scan,
            PairReuse {
                validated,
                before: Some(old),
                projection_ids: Some(projection_ids),
                health_groups: Some(&health_groups),
                observer,
            },
            phase,
        )?;
        sql(tx.commit())?;
        // Durable publication wins over a cancellation arriving after COMMIT.
        let _ = phase(Phase::AfterCommit);
        Ok(receipt)
    }
}
