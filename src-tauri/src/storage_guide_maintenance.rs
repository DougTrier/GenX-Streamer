//! One preimage and one retained SQLite owner for Guide pruning + physical compaction.
//! The caller retains StoreOwner's root read lease and Store's checked writer lease.
//! No file replacement, Archive repair, root-generation change, or implicit retry.
use super::*;
use rusqlite::types::ValueRef;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Instant;

const VACUUM_BUDGET: Duration = Duration::from_secs(120);
const MAX_SCHEMA_OBJECTS: usize = 1024;
const MAX_SCHEMA_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageState {
    pub(crate) page_size: u64,
    pub(crate) pages: u64,
    pub(crate) free_pages: u64,
    pub(crate) file_bytes: u64,
}
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum Compaction {
    Skipped {
        pages: PageState,
    },
    Deferred {
        reason: String,
        pages: Option<PageState>,
    },
    Compacted {
        before: PageState,
        after: PageState,
    },
    Failed {
        reason: String,
        before: Option<PageState>,
        after: Option<PageState>,
    },
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Maintenance<T> {
    /// The callback's actual committed retention receipt survives later failures.
    pub(crate) value: T,
    pub(crate) compaction: Compaction,
    /// Caller must quarantine this exact root generation AFTER releasing its read lease.
    /// Never restore the pre-prune backup automatically, or erase a durable receipt.
    pub(crate) fatal_verification: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Exclusive,
    BackupComplete,
    RetentionCommitted,
    BeforeVacuum,
    VacuumReturned,
    BeforeVerify,
}

#[derive(Debug, PartialEq, Eq)]
struct Modes {
    version: i64,
    application_id: i64,
    page_size: i64,
    maximum_pages: i64,
    auto_vacuum: i64,
    encoding: String,
    journal: String,
    synchronous: i64,
    foreign_keys: i64,
    trusted_schema: i64,
    locking: String,
}
fn number(c: &Connection, name: &str) -> Result<i64, String> {
    sql(c.pragma_query_value(None, name, |r| r.get(0)))
}
fn modes(c: &Connection) -> Result<Modes, String> {
    let value = Modes {
        version: number(c, "user_version")?,
        application_id: number(c, "application_id")?,
        page_size: number(c, "page_size")?,
        maximum_pages: number(c, "max_page_count")?,
        auto_vacuum: number(c, "auto_vacuum")?,
        encoding: sql(c.pragma_query_value(None, "encoding", |r| r.get(0)))?,
        journal: sql(c.pragma_query_value(None, "journal_mode", |r| r.get(0)))?,
        synchronous: number(c, "synchronous")?,
        foreign_keys: number(c, "foreign_keys")?,
        trusted_schema: number(c, "trusted_schema")?,
        locking: sql(c.pragma_query_value(None, "locking_mode", |r| r.get(0)))?,
    };
    if value.journal != "delete"
        || value.synchronous != 2
        || value.foreign_keys != 1
        || value.trusted_schema != 0
        || value.locking != "exclusive"
        || value.maximum_pages != crate::storage_budget::maximum_pages(value.page_size)?
    {
        return Err("sqlite-maintenance-mode-invalid".into());
    }
    Ok(value)
}
fn pages(c: &Connection, path: &Path) -> Result<PageState, String> {
    let size = number(c, "page_size")?;
    crate::storage_budget::maximum_pages(size)?;
    let count = number(c, "page_count")?;
    let free = number(c, "freelist_count")?;
    if count < 0 || free < 0 || free > count {
        return Err("sqlite-storage-stat-invalid".into());
    }
    Ok(PageState {
        page_size: size as u64,
        pages: count as u64,
        free_pages: free as u64,
        file_bytes: std::fs::metadata(path)
            .map_err(|_| "sqlite-maintenance-stat-failed")?
            .len(),
    })
}
fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
fn cell(hash: &mut Sha256, value: ValueRef<'_>) {
    match value {
        ValueRef::Null => hash.update([0]),
        ValueRef::Integer(n) => {
            hash.update([1]);
            hash.update(n.to_le_bytes());
        }
        ValueRef::Real(n) => {
            hash.update([2]);
            hash.update(n.to_bits().to_le_bytes());
        }
        ValueRef::Text(v) | ValueRef::Blob(v) => {
            hash.update([if matches!(value, ValueRef::Text(_)) {
                3
            } else {
                4
            }]);
            hash.update((v.len() as u64).to_le_bytes());
            hash.update(v);
        }
    }
}
/// Order-independent bounded fallback for a table without a primary key. Two
/// domain-separated 256-bit modular sums retain duplicate multiplicities without
/// sorting arbitrary feed payloads in RAM or trusting unstable implicit rowids.
fn add(sum: &mut [u8; 32], value: &[u8]) {
    let mut carry = 0u16;
    for (a, b) in sum.iter_mut().zip(value) {
        let n = *a as u16 + *b as u16 + carry;
        *a = n as u8;
        carry = n >> 8;
    }
}
fn logical(
    c: &Connection,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<[u8; 32], String> {
    let mut schema =
        sql(c.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name"))?;
    let mut rows = sql(schema.query([]))?;
    let mut hash = Sha256::new();
    hash.update(b"genx-main-maintenance-logical-v1");
    let mut tables = Vec::new();
    let mut count = 0;
    let mut bytes = 0usize;
    while let Some(row) = sql(rows.next())? {
        check()?;
        count += 1;
        if count > MAX_SCHEMA_OBJECTS {
            return Err("sqlite-maintenance-schema-limit".into());
        }
        for index in 0..4 {
            let value = sql(row.get_ref(index))?;
            if let ValueRef::Text(text) = value {
                bytes = bytes.saturating_add(text.len());
            }
            if bytes > MAX_SCHEMA_BYTES {
                return Err("sqlite-maintenance-schema-limit".into());
            }
            cell(&mut hash, value);
        }
        let kind: String = sql(row.get(0))?;
        if kind == "table" {
            let name: String = sql(row.get(1))?;
            let definition: String = sql(row.get(3))?;
            let lower = definition.to_ascii_lowercase();
            let virtual_table = lower.starts_with("create virtual table");
            if virtual_table && !lower.contains("using fts5") {
                return Err("sqlite-maintenance-virtual-table-unsupported".into());
            }
            tables.push((name, virtual_table));
        }
    }
    drop(rows);
    drop(schema);
    for (name, fts) in tables {
        check()?;
        cell(&mut hash, ValueRef::Text(name.as_bytes()));
        let mut info = sql(c.prepare(&format!("PRAGMA table_info({})", quote(&name))))?;
        let keys = sql(info.query_map([], |r| {
            Ok((
                r.get::<_, i64>(5)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(3)?,
                r.get::<_, String>(2)?,
            ))
        }))?;
        let mut keys = keys
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| sql_error_code(&e, "sqlite-operation-failed"))?;
        keys.retain(|key| key.0 > 0);
        keys.sort_by_key(|v| v.0);
        drop(info);
        // SQLite permits NULL in ordinary non-integer primary keys. Such keys
        // are not a unique ordering; use the bounded multiset fallback instead.
        let ordered = fts
            || (!keys.is_empty()
                && (keys.iter().all(|v| v.2)
                    || (keys.len() == 1 && keys[0].3.eq_ignore_ascii_case("INTEGER"))));
        let suffix = if fts {
            " ORDER BY rowid".into()
        } else if ordered {
            format!(
                " ORDER BY {}",
                keys.iter()
                    .map(|v| quote(&v.1))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        } else {
            String::new()
        };
        let mut statement = sql(c.prepare(&format!(
            "SELECT {}* FROM {}{}",
            if fts { "rowid," } else { "" },
            quote(&name),
            suffix
        )))?;
        let columns = statement.column_count();
        let mut rows = sql(statement.query([]))?;
        let mut total = 0u64;
        let mut first = [0u8; 32];
        let mut second = [0u8; 32];
        while let Some(row) = sql(rows.next())? {
            if total % 64 == 0 {
                check()?;
            }
            total = total.checked_add(1).ok_or("sqlite-maintenance-row-limit")?;
            let mut item = Sha256::new();
            item.update((columns as u64).to_le_bytes());
            for index in 0..columns {
                cell(&mut item, sql(row.get_ref(index))?);
            }
            let digest = item.finalize();
            if ordered {
                hash.update(digest);
            } else {
                add(&mut first, &digest);
                let mut extra = Sha256::new();
                extra.update(b"multiset-v1");
                extra.update(digest);
                add(&mut second, &extra.finalize());
            }
        }
        hash.update(total.to_le_bytes());
        if !ordered {
            hash.update(first);
            hash.update(second);
        }
    }
    Ok(hash.finalize().into())
}

struct Progress<'a>(&'a Connection);
impl Drop for Progress<'_> {
    fn drop(&mut self) {
        let _ = self.0.progress_handler(0, None::<fn() -> bool>);
    }
}
fn install_progress(
    c: &Connection,
    cancel: Arc<AtomicBool>,
    expired: Arc<AtomicBool>,
) -> Result<Progress<'_>, String> {
    let started = Instant::now();
    #[cfg(test)]
    let cancel_after = TEST_CANCEL_AFTER.with(|v| v.get());
    #[cfg(test)]
    let mut steps = 0u64;
    sql(c.progress_handler(
        1000,
        Some(move || {
            #[cfg(test)]
            {
                steps += 1;
                if cancel_after.is_some_and(|n| steps >= n) {
                    cancel.store(true, Ordering::Release);
                }
            }
            if started.elapsed() >= VACUUM_BUDGET {
                expired.store(true, Ordering::Release);
                return true;
            }
            cancel.load(Ordering::Acquire)
        }),
    ))?;
    Ok(Progress(c))
}
fn vacuum_error(error: &rusqlite::Error, cancel: &AtomicBool, expired: &AtomicBool) -> String {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            "sqlite-maintenance-busy".into()
        }
        Some(rusqlite::ErrorCode::DiskFull) => "sqlite-storage-full".into(),
        Some(rusqlite::ErrorCode::OperationInterrupted) if cancel.load(Ordering::Acquire) => {
            "sqlite-maintenance-cancelled".into()
        }
        Some(rusqlite::ErrorCode::OperationInterrupted) if expired.load(Ordering::Acquire) => {
            "sqlite-maintenance-deadline".into()
        }
        _ => "sqlite-maintenance-failed".into(),
    }
}
impl PairStore {
    /// `preflight` is read-only and may be repeated under the exclusive SQL lease.
    /// `write` owns its transaction, final authority check, COMMIT and truthful receipt.
    /// `cancel` must be the retained owner's live cancellation signal, not a snapshot.
    pub(crate) fn with_guide_maintenance_preflight_checked<T>(
        &self,
        mut preflight: impl FnMut(&Connection) -> Result<Option<T>, String>,
        write: impl FnOnce(&mut Connection, &mut dyn FnMut() -> Result<(), String>) -> Result<T, String>,
        cancel: Arc<AtomicBool>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Maintenance<T>, String> {
        self.guide_maintenance_observed(&mut preflight, write, cancel, &mut check, &mut |_, _| {
            Ok(())
        })
    }
    fn guide_maintenance_observed<T>(
        &self,
        preflight: &mut impl FnMut(&Connection) -> Result<Option<T>, String>,
        write: impl FnOnce(&mut Connection, &mut dyn FnMut() -> Result<(), String>) -> Result<T, String>,
        cancel: Arc<AtomicBool>,
        check: &mut dyn FnMut() -> Result<(), String>,
        observer: &mut dyn FnMut(Stage, &Connection) -> Result<(), String>,
    ) -> Result<Maintenance<T>, String> {
        let owned_cancel = cancel.clone();
        let mut admitted = || {
            check()?;
            if owned_cancel.load(Ordering::Acquire) {
                Err("sqlite-maintenance-cancelled".into())
            } else {
                Ok(())
            }
        };
        admitted()?;
        let path = self.root.join(DB);
        let c = connect(&path, true)?;
        let unchanged = preflight(&c)?;
        let initial = pages(&c, &path)?;
        admitted()?;
        if let Some(value) = unchanged {
            if initial.free_pages == 0 {
                return Ok(Maintenance {
                    value,
                    compaction: Compaction::Skipped { pages: initial },
                    fatal_verification: None,
                });
            }
        }
        drop(c);
        let mut c = connect(&path, false)?;
        // Setting locking_mode alone does not take a lock. COMMIT in exclusive
        // mode retains this actual exclusive file lock until c closes, including
        // across backup, callback COMMIT, VACUUM and verification.
        sql(c.execute_batch("PRAGMA locking_mode=EXCLUSIVE;"))?;
        c.execute_batch("BEGIN EXCLUSIVE;COMMIT;")
            .map_err(|e| vacuum_error(&e, &cancel, &AtomicBool::new(false)))?;
        observer(Stage::Exclusive, &c)?;
        admitted()?;
        let unchanged = preflight(&c)?;
        let now = pages(&c, &path)?;
        if let Some(value) = unchanged {
            if now.free_pages == 0 {
                return Ok(Maintenance {
                    value,
                    compaction: Compaction::Skipped { pages: now },
                    fatal_verification: None,
                });
            }
            self.backup_with_check(&c, &mut admitted)?;
            observer(Stage::BackupComplete, &c)?;
            return Ok(self.compact_after_receipt(
                &mut c,
                value,
                &path,
                cancel,
                &mut admitted,
                observer,
            ));
        }
        self.backup_with_check(&c, &mut admitted)?;
        observer(Stage::BackupComplete, &c)?;
        admitted()?;
        let value = write(&mut c, &mut admitted)?;
        // From here every error is carried WITH the callback's committed receipt.
        Ok(self.compact_after_receipt(&mut c, value, &path, cancel, &mut admitted, observer))
    }
    fn compact_after_receipt<T>(
        &self,
        c: &mut Connection,
        value: T,
        path: &Path,
        cancel: Arc<AtomicBool>,
        check: &mut dyn FnMut() -> Result<(), String>,
        observer: &mut dyn FnMut(Stage, &Connection) -> Result<(), String>,
    ) -> Maintenance<T> {
        let mut receipt = Maintenance {
            value,
            compaction: Compaction::Deferred {
                reason: "sqlite-maintenance-not-started".into(),
                pages: None,
            },
            fatal_verification: None,
        };
        if !c.is_autocommit() {
            receipt.fatal_verification = Some("sqlite-maintenance-open-transaction".into());
            return receipt;
        }
        let before = match pages(c, path) {
            Ok(value) => value,
            Err(error) => {
                receipt.fatal_verification = Some(error);
                return receipt;
            }
        };
        let proceed = observer(Stage::RetentionCommitted, c).and_then(|_| check());
        if let Err(reason) = proceed {
            receipt.compaction = Compaction::Deferred {
                reason,
                pages: Some(before),
            };
            return receipt;
        }
        if before.free_pages == 0 {
            receipt.compaction = Compaction::Skipped { pages: before };
            return receipt;
        }
        let before_modes = match modes(c) {
            Ok(value) => value,
            Err(error) => {
                receipt.fatal_verification = Some(error);
                return receipt;
            }
        };
        let expired = Arc::new(AtomicBool::new(false));
        let progress = match install_progress(c, cancel.clone(), expired.clone()) {
            Ok(value) => value,
            Err(reason) => {
                receipt.compaction = Compaction::Deferred {
                    reason,
                    pages: Some(before),
                };
                return receipt;
            }
        };
        let expected = logical(c, check);
        // Read-only fingerprint cancellation has no compaction effects.
        let expected = match expected {
            Ok(value) => value,
            Err(reason) => {
                drop(progress);
                receipt.compaction = Compaction::Deferred {
                    reason: if cancel.load(Ordering::Acquire) {
                        "sqlite-maintenance-cancelled".into()
                    } else if expired.load(Ordering::Acquire) {
                        "sqlite-maintenance-deadline".into()
                    } else {
                        reason
                    },
                    pages: Some(before),
                };
                return receipt;
            }
        };
        drop(progress);
        let permitted = observer(Stage::BeforeVacuum, c).and_then(|_| check());
        if let Err(reason) = permitted {
            receipt.compaction = Compaction::Deferred {
                reason,
                pages: Some(before),
            };
            return receipt;
        }
        let progress = match install_progress(c, cancel.clone(), expired.clone()) {
            Ok(value) => value,
            Err(reason) => {
                receipt.compaction = Compaction::Deferred {
                    reason,
                    pages: Some(before),
                };
                return receipt;
            }
        };
        let result = c.execute_batch("VACUUM main;");
        // SQL executes synchronously on this retained worker. Clearing this hook
        // joins the entire operation; verification must ignore later cancellation.
        drop(progress);
        let after_sql = observer(Stage::VacuumReturned, c);
        let verification = after_sql
            .and_then(|_| observer(Stage::BeforeVerify, c))
            .and_then(|_| {
                if !c.is_autocommit() {
                    return Err("sqlite-maintenance-open-transaction".into());
                }
                integrity(c)?;
                if modes(c)? != before_modes || logical(c, &mut || Ok(()))? != expected {
                    return Err("sqlite-maintenance-verification-failed".into());
                }
                let after = pages(c, path)?;
                if after.page_size != before.page_size
                    || after.file_bytes != after.pages * after.page_size
                {
                    return Err("sqlite-maintenance-verification-failed".into());
                }
                if result.is_ok() && after.free_pages != 0 {
                    return Err("sqlite-maintenance-verification-failed".into());
                }
                Ok(after)
            });
        match verification {
            Err(error) => {
                receipt.fatal_verification = Some(error.clone());
                receipt.compaction = Compaction::Failed {
                    reason: error,
                    before: Some(before),
                    after: pages(c, path).ok(),
                };
            }
            Ok(after) => {
                receipt.compaction = match result {
                    Ok(()) => Compaction::Compacted { before, after },
                    Err(error) => Compaction::Failed {
                        reason: vacuum_error(&error, &cancel, &expired),
                        before: Some(before),
                        after: Some(after),
                    },
                };
            }
        }
        receipt
    }
}

#[cfg(test)]
thread_local! { static TEST_CANCEL_AFTER: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) }; }
#[cfg(test)]
#[path = "storage_guide_maintenance_tests.rs"]
mod tests;
