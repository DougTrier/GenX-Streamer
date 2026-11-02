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

//! One complete inventory per open store. Never owns a database/network handle.
use super::Channel;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
pub(crate) const MAX_RETAINED_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_RETAINED_ROWS: usize = 100_000;
type Entry = Option<(String, Arc<Vec<Channel>>)>;
pub(crate) struct InventoryCache {
    entry: Mutex<Entry>,
    #[cfg(test)]
    max_bytes: usize,
}
impl Default for InventoryCache {
    fn default() -> Self {
        Self {
            entry: Mutex::new(None),
            #[cfg(test)]
            max_bytes: MAX_RETAINED_BYTES,
        }
    }
}
impl InventoryCache {
    #[cfg(test)]
    pub(super) fn inspect(&self) -> &Mutex<Entry> {
        &self.entry
    }
    #[cfg(test)]
    pub(super) fn with_limit(max_bytes: usize) -> Self {
        Self {
            entry: Mutex::new(None),
            max_bytes,
        }
    }
    pub(super) fn byte_limit(&self) -> usize {
        #[cfg(test)]
        {
            self.max_bytes
        }
        #[cfg(not(test))]
        {
            MAX_RETAINED_BYTES
        }
    }
    pub(super) fn get(&self, key: &str) -> Result<Option<Arc<Vec<Channel>>>, String> {
        Ok(self
            .entry
            .lock()
            .map_err(|_| "guide-listed-cache-lock")?
            .as_ref()
            .filter(|(saved, _)| saved == key)
            .map(|(_, rows)| rows.clone()))
    }
    pub(super) fn put(&self, key: String, rows: Arc<Vec<Channel>>) -> Result<(), String> {
        *self.entry.lock().map_err(|_| "guide-listed-cache-lock")? = Some((key, rows));
        Ok(())
    }
}
pub(super) fn retained_bytes(row: &Channel) -> usize {
    std::mem::size_of::<Channel>()
        + row.catalog_source_id.capacity()
        + row.app_channel_id.capacity()
        + row.guide_source_id.capacity()
        + row.xmltv_channel_id.capacity()
}
/// File identity also changes on restore/replacement when SQLite revisions,
/// file length and timestamps happen to repeat. A fresh PairStore owns a fresh
/// cache; root-generation is an additional query fence, not file identity.
pub(crate) fn database_stamp(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|_| "guide-listed-cache-stamp")?;
    let _meta = file.metadata().map_err(|_| "guide-listed-cache-stamp")?;
    #[cfg(windows)]
    let identity = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // The handle stays alive for the complete metadata capture.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err("guide-listed-cache-stamp".into());
        }
        format!(
            "{}:{}:{}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        )
    };
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", _meta.dev(), _meta.ino())
    };
    #[cfg(not(any(windows, unix)))]
    compile_error!("Guide inventory cache needs stable platform file identity");
    Ok(identity)
}
