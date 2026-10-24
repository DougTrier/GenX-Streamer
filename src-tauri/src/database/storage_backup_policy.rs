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

//! When the full verified database backup is taken.
//!
//! Each commit is already atomic and durable (DELETE journal, synchronous=FULL).
//! The verified backup exists to recover from a damaged database file, and
//! copying the whole database before every write made each save cost tens of
//! seconds on TV hardware. Ordinary writes therefore reuse a backup that is
//! younger than [`INTERVAL`]; a background owner refreshes it after writes, only
//! while nothing is being watched, the writer has been quiet for a while, and no
//! writer is waiting. Upgrade and recovery paths still back up unconditionally.
//! Trade-off (decision recorded October 17, 2026): restoring a damaged database
//! may lose at most about [`INTERVAL`] of changes.
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The oldest a verified backup may be before an ordinary write refreshes it.
pub(crate) const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// A background backup waits this long after the last write.
const QUIET_AFTER_WRITE: Duration = Duration::from_secs(2 * 60);

static VIEWING: AtomicBool = AtomicBool::new(false);
static WRITERS_WAITING: AtomicUsize = AtomicUsize::new(0);
/// Unknown at startup, so a stale backup is refreshed once the app is idle.
static CHANGED_SINCE_BACKUP: AtomicBool = AtomicBool::new(true);
static LAST_WRITE_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Playback reports whether something is being watched (`set_viewing_active`).
pub(crate) fn set_viewing(active: bool) {
    VIEWING.store(active, Ordering::SeqCst);
}
pub(crate) fn viewing() -> bool {
    VIEWING.load(Ordering::SeqCst)
}

/// Held while a writer waits for the writer lease; a background backup that
/// sees it steps aside so the save never waits behind it.
pub(crate) struct WaitingWriter(());
impl WaitingWriter {
    pub(crate) fn begin() -> Self {
        WRITERS_WAITING.fetch_add(1, Ordering::SeqCst);
        Self(())
    }
}
impl Drop for WaitingWriter {
    fn drop(&mut self) {
        WRITERS_WAITING.fetch_sub(1, Ordering::SeqCst);
    }
}
pub(crate) fn writer_waiting() -> bool {
    WRITERS_WAITING.load(Ordering::SeqCst) > 0
}

/// Record a write admitted after the backup decision.
pub(crate) fn note_write() {
    CHANGED_SINCE_BACKUP.store(true, Ordering::SeqCst);
    LAST_WRITE_MS.store(now_ms(), Ordering::SeqCst);
}
/// A verified backup was just promoted.
pub(crate) fn note_backed_up() {
    CHANGED_SINCE_BACKUP.store(false, Ordering::SeqCst);
}

/// Age of the promoted backup file; None when it is missing or empty.
pub(crate) fn backup_age(path: &Path) -> Option<Duration> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 {
        return None;
    }
    let modified = meta.modified().ok()?;
    // A modification time in the future counts as fresh only up to now.
    Some(
        SystemTime::now()
            .duration_since(modified)
            .unwrap_or(Duration::ZERO),
    )
}
/// Whether an ordinary write may reuse the existing backup.
pub(crate) fn fresh(path: &Path, interval: Duration) -> bool {
    !interval.is_zero() && backup_age(path).is_some_and(|age| age < interval)
}

/// Whether the background owner should refresh the backup now.
pub(crate) fn due(path: &Path) -> bool {
    due_at(
        path,
        INTERVAL,
        CHANGED_SINCE_BACKUP.load(Ordering::SeqCst),
        viewing(),
        writer_waiting(),
        Duration::from_millis(now_ms().saturating_sub(LAST_WRITE_MS.load(Ordering::SeqCst))),
    )
}
fn due_at(
    path: &Path,
    interval: Duration,
    changed: bool,
    viewing: bool,
    waiting: bool,
    since_write: Duration,
) -> bool {
    changed
        && !viewing
        && !waiting
        && since_write >= QUIET_AFTER_WRITE
        && backup_age(path).is_none_or(|age| age >= interval)
}

/// Leftover `tempfile` copies (".tmp" + 6 characters) in the storage root, from
/// a backup or write interrupted by a crash or forced stop. Only called at
/// startup, before any operation can own such a file.
pub(crate) fn abandoned_temporaries(root: &Path) -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.len() == 10
                && name.starts_with(".tmp")
                && name[4..].bytes().all(|b| b.is_ascii_alphanumeric())
                && entry.file_type().is_ok_and(|kind| kind.is_file())
        })
        .map(|entry| entry.path())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn backup_aged(dir: &Path, age: Duration) -> std::path::PathBuf {
        let path = dir.join("genx.sqlite3.backup");
        fs::write(&path, b"SQLite format 3\0").unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() - age).unwrap();
        path
    }

    #[test]
    fn a_recent_backup_is_reused_and_an_old_or_missing_one_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let path = backup_aged(dir.path(), Duration::from_secs(60));
        assert!(fresh(&path, INTERVAL));
        assert!(
            !fresh(&path, Duration::ZERO),
            "a zero interval always backs up"
        );
        let old = backup_aged(dir.path(), INTERVAL + Duration::from_secs(1));
        assert!(!fresh(&old, INTERVAL));
        assert!(!fresh(&dir.path().join("missing"), INTERVAL));
        fs::write(dir.path().join("empty"), b"").unwrap();
        assert!(!fresh(&dir.path().join("empty"), INTERVAL));
    }
    #[test]
    fn background_backup_waits_for_changes_quiet_and_no_viewing() {
        let dir = tempfile::tempdir().unwrap();
        let old = backup_aged(dir.path(), INTERVAL + Duration::from_secs(1));
        let quiet = QUIET_AFTER_WRITE;
        assert!(due_at(&old, INTERVAL, true, false, false, quiet));
        assert!(
            !due_at(&old, INTERVAL, false, false, false, quiet),
            "nothing changed"
        );
        assert!(
            !due_at(&old, INTERVAL, true, true, false, quiet),
            "while watching"
        );
        assert!(
            !due_at(&old, INTERVAL, true, false, true, quiet),
            "a save is waiting"
        );
        assert!(
            !due_at(&old, INTERVAL, true, false, false, Duration::from_secs(5)),
            "just wrote"
        );
        let recent = backup_aged(dir.path(), Duration::from_secs(60));
        assert!(
            !due_at(&recent, INTERVAL, true, false, false, quiet),
            "still fresh"
        );
        assert!(due_at(
            &dir.path().join("missing"),
            INTERVAL,
            true,
            false,
            false,
            quiet
        ));
    }
    #[test]
    fn a_waiting_writer_is_visible_until_admitted() {
        assert!(!writer_waiting());
        let waiting = WaitingWriter::begin();
        assert!(writer_waiting());
        drop(waiting);
        assert!(!writer_waiting());
    }
    #[test]
    fn only_abandoned_tempfile_copies_are_selected() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            ".tmpAbC123",
            ".tmpv0cJYq",
            "genx.sqlite3",
            "genx.sqlite3.backup",
            ".tmpshort",
            ".tmpTooLong1",
            "tmpAbC1234",
        ] {
            fs::write(dir.path().join(name), b"x").unwrap();
        }
        fs::create_dir(dir.path().join(".tmpDir123")).unwrap();
        let mut found: Vec<_> = abandoned_temporaries(dir.path())
            .into_iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        found.sort();
        assert_eq!(found, vec![".tmpAbC123", ".tmpv0cJYq"]);
    }
}
