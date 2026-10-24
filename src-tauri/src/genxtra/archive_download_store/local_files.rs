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

//! Downloaded files on this device: finding them, saving bookmarks, and
//! reading them in proven chunks.

use super::*;

impl DownloadStore {
    pub(crate) fn local(
        &self,
        reference: &str,
        expected: &str,
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<LocalBody, String> {
        check()?;
        let s = self.read()?;
        if s.revision != revision(expected)? {
            return Err("archive-download-revision-stale".into());
        }
        let saved = s
            .entries
            .into_iter()
            .find(|e| e.download_ref == reference && !e.tombstoned)
            .ok_or("archive-download-unavailable")?;
        let path = self.directory.join(&saved.managed_name);
        let length = size(&saved.size_bytes).ok_or(ERR)?;
        let before = ordinary(&path, length)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1);
        }
        let mut file = options
            .open(&path)
            .map_err(|_| "archive-download-file-unavailable")?;
        let opened = file.metadata().map_err(|_| ERR)?;
        if !same_file(&before, &opened) {
            return Err("archive-download-file-changed".into());
        }
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut count = 0u64;
        let mut prefix = [0u8; 8];
        loop {
            check()?;
            let n = file
                .read(&mut buffer)
                .map_err(|_| "archive-download-file-read-failed")?;
            if n == 0 {
                break;
            }
            if count < 8 {
                let start = count as usize;
                let available = n.min(8 - start);
                prefix[start..start + available].copy_from_slice(&buffer[..available]);
            }
            count = count.checked_add(n as u64).ok_or(ERR)?;
            if count > length {
                return Err("archive-download-file-changed".into());
            }
            hash.update(&buffer[..n]);
        }
        if count != length
            || format!("{:x}", hash.finalize()) != saved.local_sha256
            || &prefix[4..8] != b"ftyp"
        {
            return Err("archive-download-file-corrupt".into());
        }
        if !same_file(&opened, &file.metadata().map_err(|_| ERR)?)
            || !same_file(&opened, &ordinary(&path, length)?)
        {
            return Err("archive-download-file-changed".into());
        }
        file.seek(SeekFrom::Start(0)).map_err(|_| ERR)?;
        check()?;
        self.verify(&LocalProof {
            saved: saved.clone(),
        })?;
        Ok(LocalBody {
            entry: self.wire(&saved),
            proof: LocalProof { saved },
            file: Arc::new(file),
            metadata: opened,
            #[cfg(test)]
            before_read: None,
        })
    }

    pub(crate) fn verify(&self, proof: &LocalProof) -> Result<(), String> {
        // Fresh selected-row authority only; full namespace inspection/digest occurs
        // at admission and all writes, never per64KiB playback read.
        let c = connect(&self.directory.join(DB), false)?;
        let raw: Option<String> = sql(c
            .query_row(
                "SELECT record FROM download_entry WHERE identity=?1",
                [&proof.saved.download_ref],
                |r| r.get(0),
            )
            .optional())?;
        let live: Saved =
            serde_json::from_str(&raw.ok_or("archive-download-unavailable")?).map_err(|_| ERR)?;
        if live != proof.saved || live.tombstoned {
            return Err("archive-download-file-changed".into());
        }
        Ok(())
    }

    pub(crate) fn read_bookmark(
        &self,
        proof: &LocalProof,
    ) -> Result<archive_bookmarks::ReadReceipt, String> {
        self.verify(proof)?;
        let s = self.read()?;
        let id = proof.identity();
        Ok(archive_bookmarks::ReadReceipt {
            schema_version: 1,
            revision: s.bookmark_revision.to_string(),
            position: s
                .bookmarks
                .into_iter()
                .find(|b| b.identity == id)
                .map(|b| b.position),
        })
    }

    pub(crate) fn save_bookmark(
        &self,
        proof: &LocalProof,
        expected: &str,
        position: &archive_bookmarks::Position,
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<archive_bookmarks::Receipt, String> {
        archive_bookmarks::validate_input(expected, position)?;
        check()?;
        self.verify(proof)?;
        let mut s = self.read()?;
        if s.bookmark_revision != revision(expected)? {
            return Err("archive-bookmark-revision-stale".into());
        }
        let identity = proof.identity();
        let old = (s.revision, s.bookmark_revision);
        if s.bookmarks.iter().any(|b| {
            b.identity == identity
                && b.position.position_ms == position.position_ms
                && b.position.duration_ms == position.duration_ms
                && b.position.completed == position.completed
        }) {
            check()?;
            return Ok(archive_bookmarks::Receipt {
                schema_version: 1,
                committed: true,
                revision: s.bookmark_revision.to_string(),
                changed: false,
            });
        }
        s.bookmarks.retain(|b| b.identity != identity);
        s.bookmarks.push(LocalBookmark {
            identity,
            item_id: proof.saved.item_id.clone(),
            file_name: proof.saved.file_name.clone(),
            size_bytes: proof.saved.size_bytes.clone(),
            local_sha256: proof.saved.local_sha256.clone(),
            position: position.clone(),
        });
        s.bookmarks.sort_by(|a, b| a.identity.cmp(&b.identity));
        s.bookmark_revision = s
            .bookmark_revision
            .checked_add(1)
            .ok_or("archive-bookmark-revision-exhausted")?;
        let s = self.commit(s, old, check)?;
        Ok(archive_bookmarks::Receipt {
            schema_version: 1,
            committed: true,
            revision: s.bookmark_revision.to_string(),
            changed: true,
        })
    }
}

impl LocalProof {
    pub(crate) fn identity(&self) -> String {
        local_identity(
            &self.saved.item_id,
            &self.saved.file_name,
            &self.saved.size_bytes,
            &self.saved.local_sha256,
        )
    }
    #[cfg(test)]
    pub(crate) fn download_ref(&self) -> &str {
        &self.saved.download_ref
    }
    pub(crate) fn file(&self) -> archive_catalog::ResolvedFile {
        archive_catalog::ResolvedFile {
            item_id: self.saved.item_id.clone(),
            file_name: self.saved.file_name.clone(),
            size_bytes: self.saved.size_bytes.clone(),
            sha1: self.saved.provider_sha1.clone(),
            servers: vec![],
            duration_seconds: None,
            provider_index: None,
            public: None,
        }
    }
}

pub(crate) struct LocalBody {
    pub entry: Entry,
    pub proof: LocalProof,
    pub(super) file: Arc<File>,
    pub(super) metadata: std::fs::Metadata,
    #[cfg(test)]
    pub(crate) before_read: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl LocalBody {
    pub(crate) fn size(&self) -> u64 {
        self.metadata.len()
    }
    pub(crate) fn read_chunk(&self, offset: u64, length: usize) -> Result<Vec<u8>, String> {
        #[cfg(test)]
        if let Some(before) = &self.before_read {
            before();
        }
        if length > 64 * 1024
            || offset
                .checked_add(length as u64)
                .is_none_or(|end| end > self.size())
            || !same_file(&self.metadata, &self.file.metadata().map_err(|_| ERR)?)
        {
            return Err("archive-download-file-changed".into());
        }
        let mut bytes = vec![0u8; length];
        let mut read = 0;
        while read < length {
            #[cfg(windows)]
            let n = {
                use std::os::windows::fs::FileExt;
                self.file
                    .seek_read(&mut bytes[read..], offset + read as u64)
            };
            #[cfg(unix)]
            let n = {
                use std::os::unix::fs::FileExt;
                self.file.read_at(&mut bytes[read..], offset + read as u64)
            };
            let n = n.map_err(|_| "archive-download-file-read-failed")?;
            if n == 0 {
                return Err("archive-download-file-changed".into());
            }
            read += n;
        }
        Ok(bytes)
    }
}

pub(super) fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    if !a.is_file() || !b.is_file() || a.len() != b.len() || a.modified().ok() != b.modified().ok()
    {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if a.dev() != b.dev() || a.ino() != b.ino() {
            return false;
        }
    }
    true
}
