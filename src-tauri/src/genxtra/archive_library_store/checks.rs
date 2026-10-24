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

//! Checking the archive library: integrity snapshots, the check worker and
//! finalizing a check.

use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Snapshot {
    pub(super) binding: Binding,
    pub(super) sequence: i64,
    pub(super) epoch: i64,
    pub(super) digest: String,
    pub(super) catalog_revision: i64,
    pub(super) bookmark_revision: i64,
}

pub(super) fn control(c: &Connection) -> Result<Snapshot, String> {
    let (raw, sequence, epoch, digest): (String, i64, i64, String) = sql(c.query_row(
        "SELECT binding,sequence,epoch,digest FROM archive_namespace_meta_v1 WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ))?;
    if raw.len() > 2048
        || sequence < 0
        || epoch < 0
        || !hex(&digest)
        || sql(
            c.query_row("SELECT count(*) FROM archive_namespace_meta_v1", [], |r| {
                r.get::<_, i64>(0)
            }),
        )? != 1
    {
        return Err(INVALID.into());
    }
    let binding: Binding = serde_json::from_str(&raw).map_err(|_| INVALID)?;
    binding.validate()?;
    let (cat, book) = revisions(c)?;
    if cat < binding.source_revision || book < binding.source_bookmark_revision {
        return Err(INVALID.into());
    }
    Ok(Snapshot {
        binding,
        sequence,
        epoch,
        digest,
        catalog_revision: cat,
        bookmark_revision: book,
    })
}

pub(super) fn complete_digest(s: &Snapshot, domain: &str) -> Result<String, String> {
    let value = serde_json::to_vec(&(
        1u8,
        &s.binding,
        s.sequence,
        s.epoch,
        s.catalog_revision,
        s.bookmark_revision,
        domain,
    ))
    .map_err(|_| ERR)?;
    Ok(format!("{:x}", Sha256::digest(value)))
}

pub(super) struct CheckWorker {
    pub(super) progress: Option<std::sync::mpsc::Receiver<()>>,
    pub(super) replies: Option<std::sync::mpsc::SyncSender<bool>>,
    pub(super) worker: Option<std::thread::JoinHandle<Result<(), String>>>,
}

impl CheckWorker {
    pub(super) fn join(&mut self) -> Result<(), String> {
        self.progress.take();
        self.replies.take();
        self.worker
            .take()
            .ok_or(ERR)?
            .join()
            .map_err(|_| ERR.to_string())?
    }
}

impl Drop for CheckWorker {
    fn drop(&mut self) {
        if self.worker.is_some() {
            let _ = self.join();
        }
    }
}

/// The progress handshake keeps the actual SQL worker retained and joined,
/// including cancellation or panic in the caller's authority guard.
// Batch only the cooperative authority handshake, never the SQL verification.
// Admission and precommit guards still run, and the original worker always joins.
// An opcode stride is not a wall-clock cancellation or disposal guarantee.
pub(super) const QUICK_CHECK_OPS: i32 = 10000;

pub(super) fn quick_check_owned(
    path: &Path,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), String> {
    quick_check_owned_at_stride(path, check, QUICK_CHECK_OPS)
}

pub(super) fn quick_check_owned_at_stride(
    path: &Path,
    check: &mut dyn FnMut() -> Result<(), String>,
    stride: i32,
) -> Result<(), String> {
    if !matches!(stride, 1000 | 10000) {
        return Err(ERR.into());
    }
    let _timing =
        crate::storage_timings::archive_measure(crate::storage_timings::ArchivePhase::QuickCheck);
    use std::sync::mpsc;
    check()?;
    let (progress_tx, progress_rx) = mpsc::sync_channel(1);
    let (reply_tx, reply_rx) = mpsc::sync_channel(0);
    let path = path.to_owned();
    let worker = std::thread::Builder::new()
        .name("genx-archive-verifier".into())
        .spawn(move || {
            let c = connect(&path, false, true)?;
            sql(c.progress_handler(
                stride,
                Some(move || progress_tx.send(()).is_err() || !matches!(reply_rx.recv(), Ok(true))),
            ))?;
            let result = sql(c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)))
                .and_then(|value| {
                    if value == "ok" {
                        Ok(())
                    } else {
                        Err(INVALID.into())
                    }
                });
            let cleared = sql(c.progress_handler(0, None::<fn() -> bool>));
            result.and(cleared)
        })
        .map_err(|_| ERR)?;
    let mut owned = CheckWorker {
        progress: Some(progress_rx),
        replies: Some(reply_tx),
        worker: Some(worker),
    };
    let mut refused = None;
    while owned.progress.as_ref().ok_or(ERR)?.recv().is_ok() {
        let allowed = if refused.is_some() {
            false
        } else {
            match check() {
                Ok(()) => true,
                Err(error) => {
                    refused = Some(error);
                    false
                }
            }
        };
        if owned.replies.as_ref().ok_or(ERR)?.send(allowed).is_err() {
            break;
        }
    }
    let result = owned.join();
    match refused {
        Some(error) => Err(error),
        None => result,
    }
}

pub(super) fn validate(
    c: &Connection,
    full: bool,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Snapshot, String> {
    validate_at_stride(c, full, check, QUICK_CHECK_OPS)
}

pub(super) fn validate_at_stride(
    c: &Connection,
    full: bool,
    check: &mut dyn FnMut() -> Result<(), String>,
    stride: i32,
) -> Result<Snapshot, String> {
    check()?;
    if sql(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? != 1 {
        return Err(SCHEMA.into());
    }
    if sql(c.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0)))? != "delete" {
        return Err(SCHEMA.into());
    }
    validate_schema(c, true)?;
    let pages: i64 = sql(c.query_row("PRAGMA page_count", [], |r| r.get(0)))?;
    let size: i64 = sql(c.query_row("PRAGMA page_size", [], |r| r.get(0)))?;
    if size != 4096 || pages < 0 || pages.checked_mul(size).is_none_or(|n| n as u64 > MAX_DB) {
        return Err(LIMIT.into());
    }
    if full {
        if let Some(path) = c.path().filter(|path| !path.is_empty()) {
            if stride == QUICK_CHECK_OPS {
                quick_check_owned(Path::new(path), check)?;
            } else {
                quick_check_owned_at_stride(Path::new(path), check, stride)?;
            }
        } else if sql(c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)))? != "ok" {
            return Err(INVALID.into());
        }
    }
    if sql(
        c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get::<_, i64>(0)
        }),
    )? != 0
    {
        return Err(INVALID.into());
    }
    let s = control(c)?;
    let domain = walk_domain(c, check, |_, _| Ok(()))?;
    if s.sequence == 0 && domain != s.binding.imported_digest {
        return Err(INVALID.into());
    }
    if complete_digest(&s, &domain)? != s.digest {
        return Err(INVALID.into());
    }
    domain_bounds(c)?;
    check()?;
    Ok(s)
}

pub(super) fn snapshot(
    c: &Connection,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Snapshot, String> {
    let tx = sql(c.unchecked_transaction())?;
    let s = validate(&tx, true, check)?;
    sql(tx.commit())?;
    Ok(s)
}

/// Mutations invoke this INSIDE their own transaction immediately before COMMIT.
/// Legacy canonical fixtures have no control row and preserve their old behavior.
pub(crate) fn finalize(
    c: &Connection,
    clear_epoch: bool,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let installed: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='archive_namespace_meta_v1' AND type='table')",
        [],
        |r| r.get(0),
    ))?;
    if !installed {
        return Ok(());
    }
    if c.is_autocommit() {
        return Err("archive-library-transaction-required".into());
    }
    check()?;
    validate_schema(c, true)?;
    domain_bounds(c)?;
    let mut s = control(c)?;
    let domain = walk_domain(c, check, |_, _| Ok(()))?;
    if !clear_epoch && complete_digest(&s, &domain)? == s.digest {
        return Ok(());
    }
    s.sequence = s
        .sequence
        .checked_add(1)
        .ok_or("archive-library-sequence-exhausted")?;
    if clear_epoch {
        s.epoch = s
            .epoch
            .checked_add(1)
            .ok_or("archive-library-epoch-exhausted")?;
    }
    s.digest = complete_digest(&s, &domain)?;
    sql(c.execute(
        "UPDATE archive_namespace_meta_v1 SET sequence=?1,epoch=?2,digest=?3 WHERE singleton=1",
        params![s.sequence, s.epoch, s.digest],
    ))?;
    check()?;
    Ok(())
}
