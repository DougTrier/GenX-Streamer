//! Remembered permanently unavailable *discovered* playlist links (HTTP 404/410,
//! nonexistent domain, placeholder host). Discovery skips them and prunes them
//! from its saved suggestions when a new scan starts. Bounded, expiring and
//! separate from catalog/preferences storage: losing this file only means a dead
//! link is tried once more. Locations are stored, never logged.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const BYTES: u64 = 512 * 1024;
const LIMIT: usize = 500;
/// Unavailable links are retried after this long, in case they come back.
pub const EXPIRY_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const REASONS: [&str; 4] = ["http-404", "http-410", "dns-failure", "placeholder-host"];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub location: String,
    pub reason: String,
    pub at_ms: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Disk {
    schema_version: u32,
    entries: Vec<Entry>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordInput {
    pub location: String,
    pub reason: String,
}

fn valid_location(location: &str) -> bool {
    location.len() <= 16_384
        && !location
            .chars()
            .any(|c| c.is_control() || c.is_whitespace())
        && reqwest::Url::parse(location).is_ok_and(|url| {
            matches!(url.scheme(), "https" | "http")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
        })
}
fn valid(entry: &Entry) -> bool {
    valid_location(&entry.location) && REASONS.contains(&entry.reason.as_str())
}
pub(crate) fn now_ms() -> Result<u64, String> {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "discovery-unavailable-clock")?
            .as_millis(),
    )
    .map_err(|_| "discovery-unavailable-clock".into())
}

pub struct Store {
    path: PathBuf,
    lock: Mutex<()>,
}
impl Store {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }
    fn load(&self) -> Result<Vec<Entry>, String> {
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err("discovery-unavailable-read-failed".into()),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > BYTES {
            return Err("discovery-unavailable-file-invalid".into());
        }
        let mut bytes = Vec::new();
        File::open(&self.path)
            .map_err(|_| "discovery-unavailable-read-failed")?
            .take(BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "discovery-unavailable-read-failed")?;
        let disk: Disk =
            serde_json::from_slice(&bytes).map_err(|_| "discovery-unavailable-file-invalid")?;
        if disk.schema_version != 1 || disk.entries.len() > LIMIT || !disk.entries.iter().all(valid)
        {
            return Err("discovery-unavailable-file-invalid".into());
        }
        Ok(disk.entries)
    }
    fn save(&self, entries: Vec<Entry>) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .ok_or("discovery-unavailable-path-invalid")?;
        fs::create_dir_all(parent).map_err(|_| "discovery-unavailable-write-failed")?;
        let bytes = serde_json::to_vec(&Disk {
            schema_version: 1,
            entries,
        })
        .map_err(|_| "discovery-unavailable-encode-failed")?;
        if bytes.len() as u64 > BYTES {
            return Err("discovery-unavailable-capacity".into());
        }
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "discovery-unavailable-write-failed")?;
        temporary
            .write_all(&bytes)
            .map_err(|_| "discovery-unavailable-write-failed")?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| "discovery-unavailable-write-failed")?;
        temporary
            .persist(&self.path)
            .map_err(|_| "discovery-unavailable-write-failed")?;
        Ok(())
    }
    /// Unexpired entries only.
    pub fn read(&self, now: u64) -> Result<Vec<Entry>, String> {
        let _lock = self.lock.lock().map_err(|_| "discovery-unavailable-lock")?;
        Ok(self
            .load()?
            .into_iter()
            .filter(|e| e.at_ms <= now && now - e.at_ms < EXPIRY_MS)
            .collect())
    }
    /// Upsert by location, drop expired entries, keep the newest 500.
    pub fn record(&self, input: Vec<RecordInput>, now: u64) -> Result<usize, String> {
        if input.len() > LIMIT {
            return Err("discovery-unavailable-limit".into());
        }
        let fresh: Vec<Entry> = input
            .into_iter()
            .map(|i| Entry {
                location: i.location,
                reason: i.reason,
                at_ms: now,
            })
            .collect();
        if !fresh.iter().all(valid) {
            return Err("discovery-unavailable-input-invalid".into());
        }
        let _lock = self.lock.lock().map_err(|_| "discovery-unavailable-lock")?;
        // A corrupt cache is replaced rather than blocking discovery forever.
        let mut entries: Vec<Entry> = self
            .load()
            .unwrap_or_default()
            .into_iter()
            .filter(|e| e.at_ms <= now && now - e.at_ms < EXPIRY_MS)
            .filter(|e| !fresh.iter().any(|f| f.location == e.location))
            .collect();
        entries.extend(fresh);
        entries.sort_by_key(|e| e.at_ms);
        if entries.len() > LIMIT {
            entries.drain(..entries.len() - LIMIT);
        }
        let count = entries.len();
        self.save(entries)?;
        Ok(count)
    }
}

#[tauri::command]
pub async fn read_discovery_unavailable(app: tauri::AppHandle) -> Result<Vec<Entry>, String> {
    let work = app.state::<crate::NativeState>().admit_work()?;
    let store = app.state::<Arc<Store>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        store.read(now_ms()?)
    })
    .await
    .map_err(|_| "discovery-unavailable-worker-failed".to_string())?
}
#[tauri::command]
pub async fn record_discovery_unavailable(
    entries: Vec<RecordInput>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let work = app.state::<crate::NativeState>().admit_work()?;
    let store = app.state::<Arc<Store>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        store.record(entries, now_ms()?)
    })
    .await
    .map_err(|_| "discovery-unavailable-worker-failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("discovery-unavailable-v1.json"));
        (dir, store)
    }
    fn input(location: &str, reason: &str) -> RecordInput {
        RecordInput {
            location: location.into(),
            reason: reason.into(),
        }
    }

    #[test]
    fn records_upserts_and_expires_entries() {
        let (_dir, store) = store();
        assert!(store.read(1_000).unwrap().is_empty());
        store
            .record(
                vec![
                    input("https://a.example.org/dead.m3u", "http-404"),
                    input("https://gone.invalid/x.m3u", "dns-failure"),
                ],
                1_000,
            )
            .unwrap();
        // A later failure of the same link refreshes its time, not a duplicate.
        store
            .record(
                vec![input("https://a.example.org/dead.m3u", "http-410")],
                2_000,
            )
            .unwrap();
        let entries = store.read(2_000).unwrap();
        assert_eq!(entries.len(), 2);
        let a = entries
            .iter()
            .find(|e| e.location.contains("dead.m3u"))
            .unwrap();
        assert_eq!((a.reason.as_str(), a.at_ms), ("http-410", 2_000));
        // Expired entries are hidden and then dropped on the next write.
        assert_eq!(store.read(1_000 + EXPIRY_MS).unwrap().len(), 1);
        store.record(Vec::new(), 1_000 + EXPIRY_MS).unwrap();
        assert_eq!(store.read(1_000 + EXPIRY_MS).unwrap().len(), 1);
    }

    #[test]
    fn refuses_invalid_input_and_bounds_the_file() {
        let (_dir, store) = store();
        for bad in [
            input("ftp://x.example.org/a", "http-404"),
            input("https://user:pw@x.example.org/a", "http-404"),
            input("https://x.example.org/a", "timeout"),
            input("not a url", "http-404"),
        ] {
            assert!(store.record(vec![bad], 5).is_err());
        }
        let many: Vec<RecordInput> = (0..LIMIT)
            .map(|i| input(&format!("https://x.example.org/{i}.m3u"), "http-404"))
            .collect();
        store.record(many, 10).unwrap();
        store
            .record(
                vec![input("https://newest.example.org/a.m3u", "http-404")],
                11,
            )
            .unwrap();
        let entries = store.read(11).unwrap();
        assert_eq!(entries.len(), LIMIT);
        assert!(entries.iter().any(|e| e.location.contains("newest")));
        assert!(store
            .record(
                (0..=LIMIT)
                    .map(|i| input(&format!("https://y.example.org/{i}"), "http-404"))
                    .collect(),
                12
            )
            .is_err());
    }

    #[test]
    fn corrupt_file_reads_as_error_but_a_new_record_replaces_it() {
        let (dir, store) = store();
        fs::write(dir.path().join("discovery-unavailable-v1.json"), b"{broken").unwrap();
        assert!(store.read(5).is_err());
        store
            .record(vec![input("https://a.example.org/dead.m3u", "http-404")], 5)
            .unwrap();
        assert_eq!(store.read(5).unwrap().len(), 1);
    }
}
