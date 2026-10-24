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

use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
const LIMIT: usize = 300;
const BYTES: u64 = 256 * 1024;
const MAX_ID: u64 = 9_007_199_254_740_991;
const MAX_TIMESTAMP: u64 = 8_640_000_000_000_000;
const CODES: &[&str] = &[
    "scan-started",
    "scan-paused",
    "scan-completed",
    "scan-catalog-changed",
    "scan-configuration-changed",
    "scan-cancel-unconfirmed",
    "scan-capacity",
    "scan-save-failed",
    "scan-failed",
    "playback-failed",
    "playback-audio-warning",
    "application-archive-loc-unavailable",
    "application-archive-nasa-unavailable",
    "application-archive-commons-unavailable",
    "application-archive-commons-identification-required",
    "guide-failed",
    "guide-identity-unavailable",
    "storage-failed",
];
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventInput {
    operation: String,
    level: String,
    code: String,
    /// Bounded internal error code (lowercase token), never free text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checked: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published: Option<u32>,
}
fn valid_reason(reason: &str) -> bool {
    (2..=64).contains(&reason.len())
        && reason.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && reason
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}
impl EventInput {
    fn validate(&self) -> Result<(), String> {
        if !["scan", "playback", "guide", "storage", "application"]
            .contains(&self.operation.as_str())
            || !["info", "warning", "error"].contains(&self.level.as_str())
            || !CODES.contains(&self.code.as_str())
            || self.code.split_once('-').map(|(operation, _)| operation)
                != Some(self.operation.as_str())
            || (self.operation != "scan"
                && [self.checked, self.total, self.published]
                    .iter()
                    .any(Option::is_some))
            || self.total.is_some_and(|total| {
                self.checked.is_some_and(|checked| checked > total)
                    || self.published.is_some_and(|published| published > total)
            })
            || [self.checked, self.total, self.published]
                .into_iter()
                .flatten()
                .any(|n| n > 100_000)
            || self.reason.as_deref().is_some_and(|r| !valid_reason(r))
        {
            return Err("diagnostics-input-invalid".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    id: String,
    timestamp_ms: u64,
    operation: String,
    level: String,
    code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checked: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published: Option<u32>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Disk {
    schema_version: u32,
    next_id: u64,
    events: Vec<Event>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    schema_version: u32,
    events: Vec<Event>,
}
#[derive(Serialize)]
pub struct ClearReceipt {
    cleared: bool,
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
    fn load(&self) -> Result<Disk, String> {
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Disk {
                    schema_version: 1,
                    next_id: 1,
                    events: vec![],
                })
            }
            Err(_) => return Err("diagnostics-read-failed".into()),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > BYTES {
            return Err("diagnostics-file-invalid".into());
        }
        let mut bytes = Vec::new();
        File::open(&self.path)
            .map_err(|_| "diagnostics-read-failed")?
            .take(BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "diagnostics-read-failed")?;
        if bytes.len() as u64 > BYTES {
            return Err("diagnostics-file-invalid".into());
        }
        let disk: Disk = serde_json::from_slice(&bytes).map_err(|_| "diagnostics-file-invalid")?;
        if disk.schema_version != 1
            || disk.next_id == 0
            || disk.next_id > MAX_ID
            || disk.events.len() > LIMIT
        {
            return Err("diagnostics-file-invalid".into());
        }
        let mut previous = 0;
        for event in &disk.events {
            let id = event
                .id
                .parse::<u64>()
                .map_err(|_| "diagnostics-file-invalid")?;
            if id <= previous
                || id >= disk.next_id
                || event.id != id.to_string()
                || event.timestamp_ms > MAX_TIMESTAMP
            {
                return Err("diagnostics-file-invalid".into());
            }
            EventInput {
                operation: event.operation.clone(),
                level: event.level.clone(),
                code: event.code.clone(),
                reason: event.reason.clone(),
                checked: event.checked,
                total: event.total,
                published: event.published,
            }
            .validate()
            .map_err(|_| "diagnostics-file-invalid")?;
            previous = id;
        }
        Ok(disk)
    }
    fn save(&self, disk: &Disk) -> Result<(), String> {
        let parent = self.path.parent().ok_or("diagnostics-path-invalid")?;
        fs::create_dir_all(parent).map_err(|_| "diagnostics-write-failed")?;
        let bytes = serde_json::to_vec(disk).map_err(|_| "diagnostics-encode-failed")?;
        if bytes.len() as u64 > BYTES {
            return Err("diagnostics-capacity".into());
        }
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|_| "diagnostics-write-failed")?;
        temporary
            .write_all(&bytes)
            .map_err(|_| "diagnostics-write-failed")?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| "diagnostics-write-failed")?;
        temporary
            .persist(&self.path)
            .map_err(|_| "diagnostics-write-failed")?;
        Ok(())
    }
    pub fn append(&self, input: EventInput) -> Result<Event, String> {
        input.validate()?;
        let _lock = self.lock.lock().map_err(|_| "diagnostics-lock-failed")?;
        let mut disk = self.load()?;
        let next = disk
            .next_id
            .checked_add(1)
            .filter(|id| *id <= MAX_ID)
            .ok_or("diagnostics-id-exhausted")?;
        let timestamp_ms = u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "diagnostics-clock-failed")?
                .as_millis(),
        )
        .map_err(|_| "diagnostics-clock-failed")?;
        if timestamp_ms > MAX_TIMESTAMP {
            return Err("diagnostics-clock-failed".into());
        }
        let event = Event {
            id: disk.next_id.to_string(),
            timestamp_ms,
            operation: input.operation,
            level: input.level,
            code: input.code,
            reason: input.reason,
            checked: input.checked,
            total: input.total,
            published: input.published,
        };
        disk.next_id = next;
        disk.events.push(event.clone());
        if disk.events.len() > LIMIT {
            disk.events.remove(0);
        }
        self.save(&disk)?;
        Ok(event)
    }
    pub fn read(&self) -> Result<History, String> {
        let _lock = self.lock.lock().map_err(|_| "diagnostics-lock-failed")?;
        Ok(History {
            schema_version: 1,
            events: self.load()?.events,
        })
    }
    pub fn clear(&self) -> Result<ClearReceipt, String> {
        let _lock = self.lock.lock().map_err(|_| "diagnostics-lock-failed")?;
        let mut disk = self.load()?;
        disk.events.clear();
        self.save(&disk)?;
        Ok(ClearReceipt { cleared: true })
    }
}
#[tauri::command]
pub async fn append_diagnostic_event(
    event: EventInput,
    app: tauri::AppHandle,
) -> Result<Event, String> {
    let work = app.state::<crate::NativeState>().admit_work()?;
    let store = app.state::<Arc<Store>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        store.append(event)
    })
    .await
    .map_err(|_| "diagnostics-worker-failed".to_string())?
}
#[tauri::command]
pub async fn read_diagnostic_events(app: tauri::AppHandle) -> Result<History, String> {
    let work = app.state::<crate::NativeState>().admit_work()?;
    let store = app.state::<Arc<Store>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        store.read()
    })
    .await
    .map_err(|_| "diagnostics-worker-failed".to_string())?
}
#[tauri::command]
pub async fn clear_diagnostic_events(app: tauri::AppHandle) -> Result<ClearReceipt, String> {
    let work = app.state::<crate::NativeState>().admit_work()?;
    let store = app.state::<Arc<Store>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        store.clear()
    })
    .await
    .map_err(|_| "diagnostics-worker-failed".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_and_audio_codes_are_static_and_keep_operation_boundaries() {
        for code in [
            "playback-audio-warning",
            "application-archive-loc-unavailable",
            "application-archive-nasa-unavailable",
            "application-archive-commons-unavailable",
            "application-archive-commons-identification-required",
        ] {
            let operation = code.split_once('-').unwrap().0;
            let mut value = EventInput {
                operation: operation.into(),
                level: "warning".into(),
                code: code.into(),
                reason: None,
                checked: None,
                total: None,
                published: None,
            };
            assert!(value.validate().is_ok());
            value.operation = "scan".into();
            assert!(value.validate().is_err());
        }
    }
    #[test]
    fn failure_reason_is_a_bounded_code_never_text() {
        let mut value = input();
        for good in ["catalog-revision-stale", "aborted", "http-404"] {
            value.reason = Some(good.into());
            assert!(value.validate().is_ok(), "{good}");
        }
        for bad in [
            "",
            "x",
            "https://secret.invalid/token",
            "Saved channels changed",
            "-leading",
            &"a".repeat(65),
        ] {
            value.reason = Some(bad.into());
            assert!(value.validate().is_err(), "{bad}");
        }
    }
    fn input() -> EventInput {
        serde_json::from_str(
            r#"{"operation":"scan","level":"error","code":"scan-failed","checked":5,"total":10}"#,
        )
        .unwrap()
    }
    #[test]
    fn strict_inputs_and_redacted_errors() {
        for raw in [
            r#"{"operation":"scan","level":"error","code":"scan-failed","url":"https://secret.invalid/token"}"#,
            r#"{"operation":"scan","level":"error","code":"scan-failed","checked":-1}"#,
        ] {
            assert!(serde_json::from_str::<EventInput>(raw).is_err());
        }
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("events.json"));
        for value in ["https://secret.invalid/token", "not-a-code"] {
            let mut bad = input();
            bad.code = value.into();
            assert_eq!(store.append(bad).unwrap_err(), "diagnostics-input-invalid");
        }
        for (operation, checked, total, published) in [
            ("playback", None, None, None),
            ("scan", Some(11), Some(10), None),
            ("scan", None, Some(10), Some(11)),
        ] {
            let mut bad = input();
            bad.operation = operation.into();
            bad.checked = checked;
            bad.total = total;
            bad.published = published;
            assert_eq!(store.append(bad).unwrap_err(), "diagnostics-input-invalid");
        }
        let mut bad = input();
        bad.operation = "playback".into();
        bad.code = "playback-failed".into();
        assert_eq!(store.append(bad).unwrap_err(), "diagnostics-input-invalid");
        let mut bad = input();
        bad.published = Some(100001);
        assert!(store.append(bad).is_err());
        assert!(store.read().unwrap().events.is_empty());
    }
    #[test]
    fn bounded_persistence_and_clear_keep_monotonic_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.json");
        let store = Store::new(path.clone());
        for _ in 0..305 {
            store.append(input()).unwrap();
        }
        let reopened = Store::new(path.clone());
        let history = reopened.read().unwrap();
        assert_eq!(history.events.len(), 300);
        assert_eq!(history.events[0].id, "6");
        assert_eq!(history.events[299].id, "305");
        assert!(history.events[0].timestamp_ms > 0);
        assert!(fs::metadata(path).unwrap().len() < BYTES);
        assert!(reopened.clear().unwrap().cleared);
        assert!(store.read().unwrap().events.is_empty());
        assert_eq!(store.append(input()).unwrap().id, "306");
    }
    #[test]
    fn corrupt_file_refuses_without_rewriting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.json");
        fs::write(&path, b"private-invalid").unwrap();
        let store = Store::new(path.clone());
        assert_eq!(store.read().err().unwrap(), "diagnostics-file-invalid");
        assert!(store.append(input()).is_err());
        assert_eq!(fs::read(path).unwrap(), b"private-invalid");
    }
}
