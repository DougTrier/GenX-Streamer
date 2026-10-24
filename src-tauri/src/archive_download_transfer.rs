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

//! Exact public Archive file transfer. No renderer URL/path and no media lease.
//! Every blocking operation is joined by the retained download producer.
use crate::{archive_discovery::VerifiedFile, archive_playback_proxy};
use reqwest::redirect::Policy;
use sha1::Sha1;
use sha2::{Digest, Sha256};
#[cfg(not(windows))]
use std::fs::File;
use std::{
    fs,
    future::Future,
    io::Write,
    net::{SocketAddr, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime},
};
use tempfile::NamedTempFile;
use tokio::time::Instant;

pub(crate) const MAX_FILE: u64 = 64 * 1024 * 1024 * 1024;
const SLICE: usize = 64 * 1024;
const FRAME: usize = 256 * 1024;
const IDLE: Duration = Duration::from_secs(20);
pub(crate) type Check = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;
pub(crate) type Progress = Arc<dyn Fn(u64) + Send + Sync>;

fn io_error(error: std::io::Error) -> String {
    if error
        .raw_os_error()
        .is_some_and(|code| matches!(code, 28 | 39 | 112))
    {
        "archive-download-space-exhausted".into()
    } else {
        "archive-download-write-failed".into()
    }
}
fn ordinary(path: &Path, directory: bool) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "archive-download-path-unavailable")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("archive-download-path-refused".into());
        }
    }
    if meta.file_type().is_symlink()
        || (if directory {
            !meta.is_dir()
        } else {
            !meta.is_file()
        })
    {
        return Err("archive-download-path-refused".into());
    }
    Ok(())
}
fn reserve(size: u64, available: u64) -> Result<(), String> {
    let needed = size
        .checked_add((256 * 1024 * 1024).max(size / 20))
        .ok_or("archive-download-size-invalid")?;
    if size == 0 || size > MAX_FILE {
        return Err("archive-download-size-invalid".into());
    }
    if available < needed {
        return Err("archive-download-space-insufficient".into());
    }
    Ok(())
}
fn available_space(path: &Path) -> Result<u64, String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut caller = 0u64;
        if unsafe {
            GetDiskFreeSpaceExW(
                path.as_ptr(),
                &mut caller,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err("archive-download-space-unavailable".into());
        }
        Ok(caller)
    }
    #[cfg(not(windows))]
    {
        fs2::available_space(path).map_err(|_| "archive-download-space-unavailable".into())
    }
}
fn directory(path: &Path) -> Result<PathBuf, String> {
    if path.file_name().and_then(|s| s.to_str()) != Some("archive-downloads-v1") {
        return Err("archive-download-path-refused".into());
    }
    ordinary(path.parent().ok_or("archive-download-path-refused")?, true)?;
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(io_error(e)),
    }
    ordinary(path, true)?;
    sweep_abandoned(path, *FIRST_USE.get_or_init(SystemTime::now));
    // Nothing else is deleted implicitly. An excessive orphan count requires
    // explicit recovery.
    let mut entries = 0;
    for entry in fs::read_dir(path).map_err(io_error)?.take(513) {
        entry.map_err(io_error)?;
        entries += 1;
    }
    if entries > 512 {
        return Err("archive-download-directory-capacity".into());
    }
    path.canonicalize().map_err(io_error)
}
/// When this process first used the download folder.
static FIRST_USE: OnceLock<SystemTime> = OnceLock::new();

/// Startup: clears abandoned partial files even if no download follows.
/// Returns (files, bytes) removed; an absent or unusual folder is left alone.
pub(crate) fn sweep_abandoned_at_start(path: &Path) -> (u64, u64) {
    if path.file_name().and_then(|s| s.to_str()) != Some("archive-downloads-v1")
        || ordinary(path, true).is_err()
    {
        return (0, 0);
    }
    sweep_abandoned(path, *FIRST_USE.get_or_init(SystemTime::now))
}

/// Removes the partial files of transfers that ended with their process (a
/// crash, or Android reclaiming GenX mid-download). They are never resumed or
/// published, so they could only hold space. Only GenX's own `.download-`
/// regular files, last written before this process first used the folder:
/// every transfer of this process is newer. Returns (files, bytes) removed.
fn sweep_abandoned(path: &Path, before: SystemTime) -> (u64, u64) {
    let mut removed = (0, 0);
    let Ok(entries) = fs::read_dir(path) else {
        return removed;
    };
    for entry in entries.take(513).flatten() {
        if !entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(".download-"))
        {
            continue;
        }
        let file = entry.path();
        let Ok(meta) = fs::symlink_metadata(&file) else {
            continue;
        };
        if ordinary(&file, false).is_err() || !meta.modified().is_ok_and(|m| m < before) {
            continue;
        }
        if fs::remove_file(&file).is_ok() {
            removed.0 += 1;
            removed.1 += meta.len();
        }
    }
    removed
}
struct Writer {
    temp: Option<NamedTempFile>,
    size: u64,
    received: u64,
    sha1: Sha1,
    sha256: Sha256,
}
impl Writer {
    fn append(&mut self, bytes: &[u8], check: &Check) -> Result<(), String> {
        if bytes.len() > FRAME {
            return Err("archive-download-frame-limit".into());
        }
        let next = self
            .received
            .checked_add(bytes.len() as u64)
            .ok_or("archive-download-size-invalid")?;
        if next > self.size {
            return Err("archive-download-overflow".into());
        }
        for slice in bytes.chunks(SLICE) {
            check()?;
            self.temp
                .as_mut()
                .ok_or("archive-download-writer-lost")?
                .write_all(slice)
                .map_err(io_error)?;
            self.sha1.update(slice);
            self.sha256.update(slice);
            self.received += slice.len() as u64;
        }
        Ok(())
    }
    fn finish(&mut self, expected: Option<&str>, check: &Check) -> Result<StagedBody, String> {
        check()?;
        if self.received != self.size {
            return Err("archive-download-truncated".into());
        }
        let provider = format!("{:x}", self.sha1.clone().finalize());
        if expected.is_some_and(|value| !value.eq_ignore_ascii_case(&provider)) {
            return Err("archive-download-checksum-mismatch".into());
        }
        self.temp
            .as_ref()
            .ok_or("archive-download-writer-lost")?
            .as_file()
            .sync_all()
            .map_err(io_error)?;
        check()?;
        Ok(StagedBody {
            temp: self.temp.take().ok_or("archive-download-writer-lost")?,
            size: self.size,
            local_sha256: format!("{:x}", self.sha256.clone().finalize()),
            provider_sha1_verified: expected.is_some(),
        })
    }
}
pub(crate) struct StagedBody {
    temp: NamedTempFile,
    pub size: u64,
    pub local_sha256: String,
    pub provider_sha1_verified: bool,
}
pub(crate) struct PublishedBody {
    pub managed_name: String,
    pub size: u64,
    pub local_sha256: String,
    pub provider_sha1_verified: bool,
}
/// Only an opaque name obtained from the committed native tombstone is admitted.
/// After COMMIT this cleanup is noncancelable, but still an actually joined job.
#[cfg(test)]
pub(crate) async fn remove_published(
    directory: PathBuf,
    reference: String,
    name: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || remove_published_sync(&directory, &reference, &name))
        .await
        .map_err(|_| "archive-download-worker-failed")?
}
/// Caller retains its root read lease through the actual unlink and directory sync.
pub(crate) fn remove_published_sync(
    directory: &Path,
    reference: &str,
    name: &str,
) -> Result<(), String> {
    if !crate::archive_catalog::hex_ref(reference) || name != format!("{reference}.mp4") {
        return Err("archive-download-path-refused".into());
    }
    ordinary(directory, true)?;
    let path = directory.join(name);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("archive-download-cleanup-failed".into()),
        Ok(_) => ordinary(&path, false)?,
    }
    fs::remove_file(&path).map_err(|_| "archive-download-cleanup-failed")?;
    #[cfg(not(windows))]
    File::open(&directory)
        .map_err(|_| "archive-download-cleanup-failed")?
        .sync_all()
        .map_err(|_| "archive-download-cleanup-failed")?;
    Ok(())
}
impl StagedBody {
    pub(crate) async fn discard(self) -> Result<(), String> {
        tokio::task::spawn_blocking(move || {
            self.temp
                .close()
                .map_err(|_| "archive-download-cleanup-failed".to_owned())
        })
        .await
        .map_err(|_| "archive-download-worker-failed")?
    }
    #[cfg(test)]
    pub(crate) async fn publish(
        self,
        reference: String,
        check: Check,
    ) -> Result<PublishedBody, String> {
        tokio::task::spawn_blocking(move || self.publish_sync(reference, check))
            .await
            .map_err(|_| "archive-download-worker-failed")?
    }
    /// Caller retains the captured storage-root read lease through rename and sync.
    pub(crate) fn publish_sync(
        self,
        reference: String,
        check: Check,
    ) -> Result<PublishedBody, String> {
        let mut temp = Some(self.temp);
        let result = (|| {
            check()?;
            if !crate::archive_catalog::hex_ref(&reference) {
                return Err("archive-download-reference-invalid".into());
            }
            let parent = temp
                .as_ref()
                .ok_or("archive-download-writer-lost")?
                .path()
                .parent()
                .ok_or("archive-download-path-refused")?
                .to_owned();
            ordinary(&parent, true)?;
            let managed_name = format!("{reference}.mp4");
            let path = parent.join(&managed_name);
            check()?;
            #[cfg(windows)]
            {
                use std::os::windows::ffi::OsStrExt;
                use windows_sys::Win32::Storage::FileSystem::{
                    MoveFileExW, MOVEFILE_WRITE_THROUGH,
                };
                let (file, original) = temp
                    .take()
                    .ok_or("archive-download-writer-lost")?
                    .into_parts();
                drop(file);
                let from: Vec<u16> = original.as_os_str().encode_wide().chain(Some(0)).collect();
                let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
                if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
                    original
                        .close()
                        .map_err(|_| "archive-download-cleanup-failed")?;
                    return Err("archive-download-publish-failed".into());
                }
            }
            #[cfg(not(windows))]
            {
                if let Err(error) = temp
                    .take()
                    .ok_or("archive-download-writer-lost")?
                    .persist_noclobber(&path)
                {
                    error
                        .file
                        .close()
                        .map_err(|_| "archive-download-cleanup-failed")?;
                    return Err("archive-download-publish-failed".into());
                }
                File::open(&parent)
                    .map_err(io_error)?
                    .sync_all()
                    .map_err(io_error)?;
            }
            Ok(PublishedBody {
                managed_name,
                size: self.size,
                local_sha256: self.local_sha256,
                provider_sha1_verified: self.provider_sha1_verified,
            })
        })();
        if let Some(temp) = temp {
            temp.close()
                .map_err(|_| "archive-download-cleanup-failed")?;
        }
        result
    }
}

async fn checked<T>(
    check: &Check,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::pin!(future);
    let end = Instant::now() + IDLE;
    loop {
        check()?;
        tokio::select! {
            result = &mut future => return result,
            _ = tokio::time::sleep_until(end) => return Err("archive-download-timeout".into()),
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    }
}
fn addresses(values: impl IntoIterator<Item = SocketAddr>) -> Result<Vec<SocketAddr>, String> {
    let mut out = Vec::new();
    for addr in values {
        if out.len() >= 128 {
            return Err("archive-download-dns-limit".into());
        }
        if !crate::sharing_policy::public_upstream(addr.ip()) {
            return Err("archive-download-dns-private".into());
        }
        out.push(addr);
    }
    if out.is_empty() {
        return Err("archive-download-dns-failed".into());
    }
    Ok(out)
}
async fn resolve(host: String, check: &Check) -> Result<Vec<SocketAddr>, String> {
    // Timeout/cancel never drops the original OS resolver JoinHandle.
    let mut task = tokio::task::spawn_blocking(move || {
        addresses(
            (host.as_str(), 443)
                .to_socket_addrs()
                .map_err(|_| "archive-download-dns-failed")?,
        )
    });
    let mut consumed = false;
    let observed = checked(check, async {
        let result = (&mut task).await;
        consumed = true;
        result.map_err(|_| "archive-download-dns-join")?
    })
    .await;
    match observed {
        Ok(value) => Ok(value),
        Err(error) => {
            if !consumed {
                let _ = task.await;
            }
            Err(error)
        }
    }
}
async fn open(file: &VerifiedFile, check: &Check) -> Result<reqwest::Response, String> {
    let mut url = file.url.clone();
    for redirect in 0..=5 {
        check()?;
        archive_playback_proxy::validate(&url, &file.allowed_hosts, &file.expected_tail)?;
        let host = url
            .host_str()
            .ok_or("archive-download-host-refused")?
            .to_owned();
        let addrs = resolve(host.clone(), check).await?;
        check()?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .http1_only()
            .redirect(Policy::none())
            .resolve_to_addrs(&host, &addrs)
            .connect_timeout(IDLE)
            .read_timeout(IDLE)
            .user_agent("GenX-Streamer/0.1 ArchiveDownload")
            .build()
            .map_err(|_| "archive-download-network")?;
        let response = checked(check, async {
            client
                .get(url.clone())
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .send()
                .await
                .map_err(|_| "archive-download-network".to_owned())
        })
        .await?;
        check()?;
        if response.status().is_redirection() {
            if redirect == 5 {
                return Err("archive-download-redirect-limit".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("archive-download-redirect-refused")?;
            url = url
                .join(location)
                .map_err(|_| "archive-download-redirect-refused")?;
            archive_playback_proxy::validate(&url, &file.allowed_hosts, &file.expected_tail)?;
        } else {
            return Ok(response);
        }
    }
    Err("archive-download-network".into())
}
fn response(
    status: u16,
    mime: &str,
    length: Option<u64>,
    encoding: Option<&[u8]>,
    range: bool,
    size: u64,
) -> Result<(), String> {
    match status {
        401 | 403 => return Err("archive-download-access-refused".into()),
        404 | 410 => return Err("archive-download-unavailable".into()),
        429 => return Err("archive-download-rate-limited".into()),
        _ => {}
    }
    if status != 200
        || !mime.eq_ignore_ascii_case("video/mp4")
        || length != Some(size)
        || encoding.is_some_and(|v| v != b"identity")
        || range
    {
        return Err("archive-download-response-refused".into());
    }
    Ok(())
}
pub(crate) async fn fetch(
    file: VerifiedFile,
    expected_sha1: Option<String>,
    path: PathBuf,
    check: Check,
    progress: Progress,
) -> Result<StagedBody, String> {
    check()?;
    if expected_sha1
        .as_ref()
        .is_some_and(|v| v.len() != 40 || !v.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("archive-download-checksum-invalid".into());
    }
    let size = file.size_bytes;
    let check_prepare = check.clone();
    let state = tokio::task::spawn_blocking(move || {
        check_prepare()?;
        let path = directory(&path)?;
        reserve(size, available_space(&path)?)?;
        let temp = tempfile::Builder::new()
            .prefix(".download-")
            .tempfile_in(&path)
            .map_err(io_error)?;
        Ok::<_, String>(Arc::new(Mutex::new(Writer {
            temp: Some(temp),
            size,
            received: 0,
            sha1: Sha1::new(),
            sha256: Sha256::new(),
        })))
    })
    .await
    .map_err(|_| "archive-download-worker-failed")??;
    let result = match open(&file, &check).await {
        Ok(body) => receive(body, state.clone(), expected_sha1, check, progress).await,
        Err(error) => Err(error),
    };
    if result.is_err() {
        cleanup(state).await?;
    }
    result
}

async fn cleanup(state: Arc<Mutex<Writer>>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let temp = state
            .lock()
            .map_err(|_| "archive-download-cleanup-failed")?
            .temp
            .take();
        if let Some(temp) = temp {
            temp.close()
                .map_err(|_| "archive-download-cleanup-failed")?;
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| "archive-download-worker-failed")?
}
async fn receive(
    mut body: reqwest::Response,
    state: Arc<Mutex<Writer>>,
    expected_sha1: Option<String>,
    check: Check,
    progress: Progress,
) -> Result<StagedBody, String> {
    let size = state
        .lock()
        .map_err(|_| "archive-download-writer-lost")?
        .size;
    let mime = body
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    response(
        body.status().as_u16(),
        mime,
        body.content_length(),
        body.headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .map(|v| v.as_bytes()),
        body.headers().contains_key(reqwest::header::CONTENT_RANGE),
        size,
    )?;
    loop {
        let chunk = checked(&check, async {
            body.chunk()
                .await
                .map_err(|_| "archive-download-network".to_owned())
        })
        .await?;
        let Some(chunk) = chunk else {
            break;
        };
        if chunk.len() > FRAME {
            return Err("archive-download-frame-limit".into());
        }
        let writer = state.clone();
        let guard = check.clone();
        let received = tokio::task::spawn_blocking(move || {
            let mut w = writer.lock().map_err(|_| "archive-download-writer-lost")?;
            w.append(&chunk, &guard)?;
            Ok::<_, String>(w.received)
        })
        .await
        .map_err(|_| "archive-download-worker-failed")??;
        progress(received);
    }
    let writer = state.clone();
    let guard = check.clone();
    tokio::task::spawn_blocking(move || {
        writer
            .lock()
            .map_err(|_| "archive-download-writer-lost")?
            .finish(expected_sha1.as_deref(), &guard)
    })
    .await
    .map_err(|_| "archive-download-worker-failed")?
}

#[cfg(test)]
#[path = "archive_download_transfer_tests.rs"]
mod tests;
