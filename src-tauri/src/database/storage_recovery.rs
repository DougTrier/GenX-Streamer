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

use crate::storage::{refuse_link, Store};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

const PATH_LIMIT: usize = 16_384;
const BOOKMARK_LIMIT: u64 = 20_000;

pub fn validate_path(path: &Path) -> Result<(), String> {
    let text = path.to_str().ok_or("storage-choice-invalid-location")?;
    if text.is_empty()
        || text.len() > PATH_LIMIT
        || text.chars().any(char::is_control)
        || !path.is_absolute()
        || path.components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err("storage-choice-invalid-location".into());
    }
    refuse_link(path)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bookmark {
    schema_version: u8,
    executable_key: String,
    directory: String,
}

pub struct Bookmarks {
    root: PathBuf,
    key: String,
}
impl Bookmarks {
    pub fn new(config: PathBuf, executable: &Path) -> Result<Self, String> {
        let name = executable.to_str().ok_or("storage-bookmark-unavailable")?;
        #[cfg(windows)]
        let name = name.replace('/', "\\").to_lowercase();
        let key = format!("{:x}", Sha256::digest(name.as_bytes()));
        Ok(Self {
            root: config.join("storage-choices"),
            key,
        })
    }
    fn file(&self) -> PathBuf {
        self.root.join(format!("{}.json", self.key))
    }
    pub fn read(&self) -> Result<Option<PathBuf>, String> {
        refuse_link(&self.root)?;
        let file = self.file();
        refuse_link(&file)?;
        let metadata = match fs::metadata(&file) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("storage-bookmark-unavailable".into()),
        };
        if !metadata.is_file() || metadata.len() > BOOKMARK_LIMIT {
            return Err("storage-bookmark-invalid".into());
        }
        let mut bytes = Vec::new();
        fs::File::open(&file)
            .map_err(|_| "storage-bookmark-unavailable")?
            .take(BOOKMARK_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "storage-bookmark-unavailable")?;
        if bytes.len() as u64 > BOOKMARK_LIMIT {
            return Err("storage-bookmark-invalid".into());
        }
        let saved: Bookmark =
            serde_json::from_slice(&bytes).map_err(|_| "storage-bookmark-invalid")?;
        if saved.schema_version != 1 || saved.executable_key != self.key {
            return Err("storage-bookmark-invalid".into());
        }
        let path = PathBuf::from(saved.directory);
        validate_path(&path)?;
        // Never recreate a remembered directory that disappeared or silently fall back.
        if !path.is_dir() {
            return Err("storage-choice-directory-unavailable".into());
        }
        Ok(Some(path))
    }
    pub fn save(&self, path: &Path) -> Result<(), String> {
        validate_path(path)?;
        refuse_link(&self.root)?;
        fs::create_dir_all(&self.root).map_err(|_| "storage-bookmark-unavailable")?;
        refuse_link(&self.root)?;
        let file = self.file();
        refuse_link(&file)?;
        let bytes = serde_json::to_vec(&Bookmark {
            schema_version: 1,
            executable_key: self.key.clone(),
            directory: path
                .to_str()
                .ok_or("storage-choice-invalid-location")?
                .into(),
        })
        .map_err(|_| "storage-bookmark-invalid")?;
        if bytes.len() as u64 > BOOKMARK_LIMIT {
            return Err("storage-bookmark-invalid".into());
        }
        let mut temp = tempfile::NamedTempFile::new_in(&self.root)
            .map_err(|_| "storage-bookmark-unavailable")?;
        temp.write_all(&bytes)
            .map_err(|_| "storage-bookmark-unavailable")?;
        temp.as_file()
            .sync_all()
            .map_err(|_| "storage-bookmark-unavailable")?;
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            let from: Vec<u16> = temp
                .path()
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            let to: Vec<u16> = file.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe {
                MoveFileExW(
                    from.as_ptr(),
                    to.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err("storage-bookmark-unavailable".into());
            }
        }
        #[cfg(not(windows))]
        temp.persist(&file)
            .map_err(|_| "storage-bookmark-unavailable")?;
        Ok(())
    }
}

#[derive(Default)]
pub struct RecoveryOwner {
    active: AtomicBool,
    epoch: AtomicU64,
    commit: Mutex<()>,
}
pub struct Choice {
    owner: Arc<RecoveryOwner>,
    epoch: u64,
}
impl RecoveryOwner {
    pub fn active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
    pub fn cancel(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }
    pub fn begin(self: &Arc<Self>) -> Result<Choice, String> {
        let epoch = self.epoch.load(Ordering::SeqCst);
        self.active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "storage-choice-busy")?;
        Ok(Choice {
            owner: self.clone(),
            epoch,
        })
    }
}
impl Choice {
    pub fn commit_retained(
        &self,
        bookmarks: &Bookmarks,
        path: &Path,
        candidate: Store,
        targets: (
            &mut Result<Store, String>,
            &mut Result<crate::storage::StorageTarget, String>,
        ),
        closing: &AtomicBool,
        read_succeeded: &AtomicBool,
    ) -> Result<(), String> {
        self.commit(
            bookmarks,
            path,
            candidate,
            targets.0,
            closing,
            read_succeeded,
        )?;
        *targets.1 = Ok(crate::storage::StorageTarget {
            path: path.to_owned(),
            mode: "explicit-directory".into(),
            require_existing: true,
            require_database: true,
        });
        Ok(())
    }
    pub fn ensure_current(&self, closing: &AtomicBool) -> Result<(), String> {
        if self.owner.epoch.load(Ordering::SeqCst) != self.epoch || closing.load(Ordering::SeqCst) {
            return Err("storage-choice-canceled".into());
        }
        Ok(())
    }
    pub fn commit(
        &self,
        bookmarks: &Bookmarks,
        path: &Path,
        candidate: Store,
        current: &mut Result<Store, String>,
        closing: &AtomicBool,
        read_succeeded: &AtomicBool,
    ) -> Result<(), String> {
        let _commit = self.owner.commit.lock().map_err(|_| "storage-lock")?;
        self.ensure_current(closing)?;
        if read_succeeded.load(Ordering::SeqCst) || current.is_ok() {
            return Err("storage-healthy-switch-refused".into());
        }
        // This is the commit linearization point. Shutdown waits for this owned choice.
        // A close after this point may wait for the bookmark + publication, never half-activate.
        bookmarks.save(path)?;
        *current = Ok(candidate);
        Ok(())
    }
}
impl Drop for Choice {
    fn drop(&mut self) {
        self.owner.active.store(false, Ordering::SeqCst);
    }
}

pub fn error_category(error: &str) -> &'static str {
    if error == "sqlite-storage-busy" {
        "busy"
    } else if error.contains("read-only") {
        "read-only"
    } else if error.contains("link") || error.contains("location") || error.contains("local-volume")
    {
        "invalid-location"
    } else if error.contains("invalid")
        || error.contains("corrupt")
        || error.contains("integrity")
        || error.contains("schema")
    {
        "invalid-data"
    } else if error.contains("unavailable")
        || error.contains("directory")
        || error.contains("bookmark")
    {
        "unavailable"
    } else {
        "internal"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn busy_category_requires_exact_static_native_error() {
        assert_eq!(error_category("sqlite-storage-busy"), "busy");
        assert_eq!(
            error_category("sqlite-storage-busy private detail"),
            "internal"
        );
        assert_eq!(error_category("unknown provider payload"), "internal");
        assert_eq!(
            error_category("sqlite-recovery-inspection-failed"),
            "internal"
        );
    }
    fn candidate(root: &Path) -> Store {
        Store::new(root.to_owned(), "explicit-directory".into()).unwrap()
    }
    #[test]
    fn bookmark_is_location_bound_atomic_and_survives_in_place_updates() {
        let dir = tempfile::tempdir().unwrap();
        let chosen = dir.path().join("chosen");
        let _store = candidate(&chosen);
        let exe = dir.path().join("app.exe");
        fs::write(&exe, b"old binary").unwrap();
        let bookmarks = Bookmarks::new(dir.path().join("config"), &exe).unwrap();
        assert!(bookmarks.read().unwrap().is_none());
        bookmarks.save(&chosen).unwrap();
        fs::write(&exe, b"updated binary").unwrap();
        let reopened = Bookmarks::new(dir.path().join("config"), &exe).unwrap();
        assert_eq!(reopened.read().unwrap(), Some(chosen.clone()));
        let other =
            Bookmarks::new(dir.path().join("config"), &dir.path().join("other.exe")).unwrap();
        assert!(other.read().unwrap().is_none());
        let replacement = dir.path().join("replacement");
        let _store = candidate(&replacement);
        reopened.save(&replacement).unwrap();
        assert_eq!(reopened.read().unwrap(), Some(replacement));
        assert!(chosen.join("genx.sqlite3").exists());
    }
    #[test]
    fn corrupt_oversized_and_missing_bookmarks_never_fall_back() {
        let dir = tempfile::tempdir().unwrap();
        let selected = dir.path().join("selected");
        fs::create_dir(&selected).unwrap();
        let bookmarks =
            Bookmarks::new(dir.path().join("config"), &dir.path().join("app.exe")).unwrap();
        bookmarks.save(&selected).unwrap();
        fs::remove_dir(&selected).unwrap();
        assert_eq!(
            bookmarks.read().unwrap_err(),
            "storage-choice-directory-unavailable"
        );
        assert!(!selected.exists());
        fs::write(bookmarks.file(), b"broken").unwrap();
        assert_eq!(bookmarks.read().unwrap_err(), "storage-bookmark-invalid");
        fs::write(bookmarks.file(), vec![b' '; BOOKMARK_LIMIT as usize + 1]).unwrap();
        assert_eq!(bookmarks.read().unwrap_err(), "storage-bookmark-invalid");
    }
    #[test]
    fn single_choice_commit_publishes_only_after_bookmark() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("selected");
        let bookmarks =
            Bookmarks::new(dir.path().join("config"), &dir.path().join("app.exe")).unwrap();
        let owner = Arc::new(RecoveryOwner::default());
        let choice = owner.begin().unwrap();
        assert!(owner.begin().is_err());
        let mut current = Err("initial read failed".into());
        choice
            .commit(
                &bookmarks,
                &path,
                candidate(&path),
                &mut current,
                &AtomicBool::new(false),
                &AtomicBool::new(false),
            )
            .unwrap();
        assert!(current.as_ref().unwrap().read_pair().is_ok());
        assert_eq!(bookmarks.read().unwrap(), Some(path));
        drop(choice);
        assert!(!owner.active());
    }
    #[test]
    fn failed_bookmark_cannot_activate_prepared_store() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        fs::write(&config, b"blocking file").unwrap();
        let bookmarks = Bookmarks::new(config, &dir.path().join("app.exe")).unwrap();
        let owner = Arc::new(RecoveryOwner::default());
        let mut current = Err("initial error".into());
        let path = dir.path().join("candidate");
        assert!(owner
            .begin()
            .unwrap()
            .commit(
                &bookmarks,
                &path,
                candidate(&path),
                &mut current,
                &AtomicBool::new(false),
                &AtomicBool::new(false)
            )
            .is_err());
        assert_eq!(current.err().unwrap(), "initial error");
        assert!(path.join("genx.sqlite3").exists()); // Explicit preparation is preserved, never deleted.
        assert!(!owner.active());
    }
    #[test]
    fn closing_and_obsolete_owners_never_write_bookmark() {
        for cancel in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let bookmarks =
                Bookmarks::new(dir.path().join("config"), &dir.path().join("app.exe")).unwrap();
            let owner = Arc::new(RecoveryOwner::default());
            let choice = owner.begin().unwrap();
            let path = dir.path().join("selected");
            let prepared = candidate(&path);
            if cancel {
                owner.cancel();
            }
            let mut current = Err("initial error".into());
            assert_eq!(
                choice
                    .commit(
                        &bookmarks,
                        &path,
                        prepared,
                        &mut current,
                        &AtomicBool::new(!cancel),
                        &AtomicBool::new(false)
                    )
                    .unwrap_err(),
                "storage-choice-canceled"
            );
            assert!(bookmarks.read().unwrap().is_none());
            assert!(current.is_err());
        }
    }
    #[test]
    fn successful_initial_read_permanently_prevents_hot_swap_even_after_later_error() {
        let dir = tempfile::tempdir().unwrap();
        let bookmarks =
            Bookmarks::new(dir.path().join("config"), &dir.path().join("app.exe")).unwrap();
        let owner = Arc::new(RecoveryOwner::default());
        let path = dir.path().join("selected");
        let mut current = Err("later runtime failure".into());
        assert_eq!(
            owner
                .begin()
                .unwrap()
                .commit(
                    &bookmarks,
                    &path,
                    candidate(&path),
                    &mut current,
                    &AtomicBool::new(false),
                    &AtomicBool::new(true)
                )
                .unwrap_err(),
            "storage-healthy-switch-refused"
        );
        assert!(bookmarks.read().unwrap().is_none());
    }
    #[test]
    fn choice_refuses_relative_control_parent_and_symlink_locations() {
        assert!(validate_path(Path::new("relative")).is_err());
        let dir = tempfile::tempdir().unwrap();
        assert!(validate_path(&dir.path().join("..\\outside")).is_err());
        assert!(validate_path(&dir.path().join("bad\nname")).is_err());
        assert!(validate_path(&dir.path().join("x".repeat(PATH_LIMIT + 1))).is_err());
        let target = dir.path().join("target");
        fs::create_dir(&target).unwrap();
        let link = dir.path().join("link");
        // NTFS junctions exercise the same reparse boundary without requiring
        // developer mode, elevation, or security-policy changes for symlink creation.
        let status = std::process::Command::new("cmd.exe")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(validate_path(&link).unwrap_err(), "storage-link-refused");
        assert!(!target.join("genx.sqlite3").exists());
    }
}
