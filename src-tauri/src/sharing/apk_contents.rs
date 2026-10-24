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

//! What an APK really holds (SH-010, SH-017): the CPU architectures of its
//! native libraries, read from the ZIP central directory, so a nearby page
//! offers the installed file for what it is, never for what it should be.
// Read on Android only (and by the tests): Windows shares its exe.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]
use crate::sharing::compatibility::Package;
use std::io::{Read, Seek, SeekFrom};

const END_SIGNATURE: u32 = 0x0605_4b50;
const ENTRY_SIGNATURE: u32 = 0x0201_4b50;
/// End record (22 bytes) plus the longest comment a ZIP may carry.
const TAIL: u64 = 22 + 65_535;
/// More central directory than any GenX APK has; anything bigger is refused.
const MAX_DIRECTORY: u64 = 16 * 1024 * 1024;

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// The architectures under `lib/` (for example "arm64-v8a"), sorted.
pub(crate) fn architectures(path: &std::path::Path) -> Result<Vec<String>, String> {
    let unreadable = || "share-app-unavailable".to_string();
    let mut file = std::fs::File::open(path).map_err(|_| unreadable())?;
    let length = file.metadata().map_err(|_| unreadable())?.len();
    let start = length.saturating_sub(TAIL);
    file.seek(SeekFrom::Start(start))
        .map_err(|_| unreadable())?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).map_err(|_| unreadable())?;
    let end = (0..tail.len().saturating_sub(21))
        .rev()
        .find(|&at| u32_at(&tail, at) == Some(END_SIGNATURE))
        .ok_or_else(unreadable)?;
    let entries = u16_at(&tail, end + 10).ok_or_else(unreadable)?;
    let size = u64::from(u32_at(&tail, end + 12).ok_or_else(unreadable)?);
    let offset = u64::from(u32_at(&tail, end + 16).ok_or_else(unreadable)?);
    if size > MAX_DIRECTORY || offset + size > length {
        return Err(unreadable());
    }
    let mut directory = vec![0u8; size as usize];
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| unreadable())?;
    file.read_exact(&mut directory).map_err(|_| unreadable())?;
    let mut found = Vec::<String>::new();
    let mut at = 0;
    for _ in 0..entries {
        if u32_at(&directory, at) != Some(ENTRY_SIGNATURE) {
            return Err(unreadable());
        }
        let name_length = usize::from(u16_at(&directory, at + 28).ok_or_else(unreadable)?);
        let extra = usize::from(u16_at(&directory, at + 30).ok_or_else(unreadable)?);
        let comment = usize::from(u16_at(&directory, at + 32).ok_or_else(unreadable)?);
        let name = directory
            .get(at + 46..at + 46 + name_length)
            .ok_or_else(unreadable)?;
        if let Some(rest) = name.strip_prefix(b"lib/") {
            if let Some(slash) = rest.iter().position(|&b| b == b'/') {
                let abi = String::from_utf8_lossy(&rest[..slash]).into_owned();
                if !abi.is_empty() && !found.contains(&abi) {
                    found.push(abi);
                }
            }
        }
        at += 46 + name_length + extra + comment;
    }
    found.sort();
    Ok(found)
}

/// Which package an APK with these architectures is. None when it lacks the
/// 64-bit ARM library every GenX APK carries (not offered at all).
pub(crate) fn android_package(architectures: &[String]) -> Option<Package> {
    let has = |abi: &str| architectures.iter().any(|found| found == abi);
    match (has("arm64-v8a"), has("armeabi-v7a")) {
        (true, true) => Some(Package::AndroidUniversal),
        (true, false) => Some(Package::AndroidArm64),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A ZIP central directory and end record, as an APK's tail has them
    /// (the reader never looks at the local entries before them).
    fn zip(names: &[&str], comment: &[u8]) -> Vec<u8> {
        let mut bytes = b"local entries are not read".to_vec();
        let offset = bytes.len() as u32;
        for name in names {
            bytes.extend_from_slice(&ENTRY_SIGNATURE.to_le_bytes());
            bytes.extend_from_slice(&[0u8; 24]);
            bytes.extend_from_slice(&(name.len() as u16).to_le_bytes());
            bytes.extend_from_slice(&3u16.to_le_bytes()); // extra field
            bytes.extend_from_slice(&0u16.to_le_bytes()); // comment
            bytes.extend_from_slice(&[0u8; 12]);
            bytes.extend_from_slice(name.as_bytes());
            bytes.extend_from_slice(b"xyz");
        }
        let size = bytes.len() as u32 - offset;
        bytes.extend_from_slice(&END_SIGNATURE.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 4]);
        bytes.extend_from_slice(&(names.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&(names.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&size.to_le_bytes());
        bytes.extend_from_slice(&offset.to_le_bytes());
        bytes.extend_from_slice(&(comment.len() as u16).to_le_bytes());
        bytes.extend_from_slice(comment);
        bytes
    }

    fn read(bytes: &[u8]) -> Result<Vec<String>, String> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.apk");
        std::fs::write(&path, bytes).unwrap();
        architectures(&path)
    }

    #[test]
    fn the_architectures_are_read_from_the_library_folders() {
        let universal = read(&zip(
            &[
                "AndroidManifest.xml",
                "lib/arm64-v8a/libgenx.so",
                "lib/armeabi-v7a/libgenx.so",
                "lib/arm64-v8a/libc++_shared.so",
                "assets/lib/x86/not-a-library.txt",
            ],
            b"",
        ))
        .unwrap();
        assert_eq!(universal, ["arm64-v8a", "armeabi-v7a"]);
        assert_eq!(android_package(&universal), Some(Package::AndroidUniversal));
        let arm64 = read(&zip(&["lib/arm64-v8a/libgenx.so"], b"signed")).unwrap();
        assert_eq!(android_package(&arm64), Some(Package::AndroidArm64));
        let none = read(&zip(&["classes.dex"], b"")).unwrap();
        assert!(none.is_empty());
        assert_eq!(android_package(&none), None);
        assert_eq!(android_package(&["armeabi-v7a".into()]), None);
    }

    #[test]
    fn a_damaged_file_is_refused() {
        assert!(read(b"not a zip at all").is_err());
        let mut cut = zip(&["lib/arm64-v8a/libgenx.so"], b"");
        let end = cut.len() - 22;
        cut[end + 16..end + 20].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(read(&cut).is_err());
        let mut wrong_count = zip(&["lib/arm64-v8a/libgenx.so"], b"");
        let end = wrong_count.len() - 22;
        wrong_count[end + 10..end + 12].copy_from_slice(&9u16.to_le_bytes());
        assert!(read(&wrong_count).is_err());
    }
}
