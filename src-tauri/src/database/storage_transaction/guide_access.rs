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

//! PairStore's guide reads and writes, and reading snapshots after a capture.

use super::*;

impl PairStore {
    pub fn with_guide_read<T>(
        &self,
        read: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let c = connect(&self.root.join(DB), true)?;
        read(&c)
    }

    pub fn query_catalog_page(
        &self,
        query: &crate::catalog_query::Query,
        cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<crate::catalog_query::Page, String> {
        let path = self.root.join(DB);
        let c = connect(&path, true)?;
        crate::catalog_query::query_page_cached(&c, query, cancel, &self.page_cache, &path)
    }

    pub fn with_guide_write<T>(
        &self,
        write: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut c = connect(&self.root.join(DB), false)?;
        self.backup(&c)?;
        write(&mut c)
    }

    pub(crate) fn with_guide_write_checked<T>(
        &self,
        write: impl FnOnce(&mut Connection) -> Result<T, String>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<T, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), false)?;
        self.backup_with_check(&c, &mut check)?;
        check()?;
        // The callback owns its transaction and final admission. Never run a
        // post-callback cancellation check over an actual durable receipt.
        write(&mut c)
    }

    /// Preflight must only read; it may prove a no-op without a speculative write.
    /// The caller retains its Store writer lease across preflight and commit.
    pub(crate) fn with_guide_write_preflight_checked<T>(
        &self,
        preflight: impl FnOnce(&Connection) -> Result<Option<T>, String>,
        write: impl FnOnce(&mut Connection, &mut dyn FnMut() -> Result<(), String>) -> Result<T, String>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<T, String> {
        check()?;
        let c = connect(&self.root.join(DB), true)?;
        let unchanged = preflight(&c)?;
        check()?;
        if let Some(receipt) = unchanged {
            return Ok(receipt);
        }
        drop(c);
        let mut c = connect(&self.root.join(DB), false)?;
        self.backup_with_check(&c, &mut check)?;
        check()?;
        // COMMIT is owned by the callback. Never erase its durable receipt with
        // a post-callback cancellation check.
        write(&mut c, &mut check)
    }

    #[cfg(test)]
    pub(crate) fn write_archive_bookmark_checked(
        &self,
        proof: &crate::archive_bookmarks::Proof,
        revision: &str,
        position: &crate::archive_bookmarks::Position,
        mut check: impl Fn() -> Result<(), String>,
    ) -> Result<crate::archive_bookmarks::Receipt, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), false)?;
        if let Some(receipt) =
            crate::archive_bookmarks::preflight_save(&c, proof, revision, position, &check)?
        {
            return Ok(receipt);
        }
        self.backup_with_check(&c, &mut check)?;
        // save owns fresh transaction admission and final cancellation check.
        // No check after its COMMIT may hide a durable receipt.
        crate::archive_bookmarks::save(&mut c, proof, revision, position, check)
    }

    pub fn read_snapshot(&self) -> Result<RecordSnapshot, String> {
        self.read_snapshot_after_capture(|| Ok(()))
    }

    pub fn read_guide_capture(&self) -> Result<GuideCaptureSnapshot, String> {
        self.read_guide_capture_after_capture(|| Ok(()))
    }

    pub(crate) fn read_guide_capture_after_capture(
        &self,
        after: impl FnOnce() -> Result<(), String>,
    ) -> Result<GuideCaptureSnapshot, String> {
        let _time = crate::storage_timings::measure(crate::storage_timings::Stage::Snapshot);
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let captured = Self::capture_pair(&tx)?;
        let revision: i64 = sql(tx.query_row(
            "SELECT catalog_revision FROM metadata WHERE singleton=1",
            [],
            |row| row.get(0),
        ))?;
        sql(tx.commit())?;
        after()?;
        if revision < 0 {
            return Err("storage-revision-invalid".into());
        }
        Ok(GuideCaptureSnapshot {
            pair: Self::finish_pair(captured)?,
            catalog_revision: revision.to_string(),
        })
    }

    pub(crate) fn read_snapshot_after_capture(
        &self,
        after: impl FnOnce() -> Result<(), String>,
    ) -> Result<RecordSnapshot, String> {
        let _time = crate::storage_timings::measure(crate::storage_timings::Stage::Snapshot);
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let captured_pair = Self::capture_pair(&tx)?;
        let captured_health = crate::health_storage::capture(&tx)?;
        let (cr, hr): (i64, i64) = sql(tx.query_row(
            "SELECT catalog_revision,health_revision FROM metadata WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        sql(tx.commit())?;
        // Only immutable captured data survives this point. Pure validation
        // keeps its root/work lease, but never holds a DELETE-mode read lock.
        after()?;
        let (pair, catalog) = Self::finish_pair_validated(captured_pair)?;
        let health = crate::health_storage::finish(captured_health)?;
        if crate::health_storage::reconcile(health.as_deref(), None, catalog.as_ref())? != health {
            return Err("health-stored-target-mismatch".into());
        }
        if cr < 0 || hr < 0 {
            return Err("storage-revision-invalid".into());
        }
        Ok(RecordSnapshot {
            pair,
            health,
            catalog_revision: cr.to_string(),
            health_revision: hr.to_string(),
        })
    }
}
