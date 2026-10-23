//! Paid TV guide commands. The download runs only when the viewer asks for the
//! guide (opening it, or Refresh); nothing here starts on its own. The guide
//! address carries the sign-in, so it never leaves native code or a log.
use crate::{account_guide, account_vault, account_vault_owner, scan_manifest_work};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;
use tokio::time::Instant;

static GUIDE_WRITER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const PREFIX: &str = "account-guide-";
/// One download: providers' guides are tens of MB and slow to generate.
const DOWNLOAD_WINDOW: Duration = Duration::from_secs(240);

fn now_ms() -> Result<i64, String> {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "account-clock-unavailable")?
        .as_millis();
    i64::try_from(ms).map_err(|_| "account-clock-unavailable".into())
}
/// The temporary download. Always removed, success or failure (W15).
struct Download(PathBuf);
impl Drop for Download {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
/// Leftovers from a process that ended mid-download. Only GenX's own guide
/// downloads, and only while this process holds the guide writer.
fn sweep(directory: &Path) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(PREFIX) && name.ends_with(".part") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

pub(crate) async fn refresh(
    request: account_vault_owner::InspectRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_guide::Status, String> {
    let crypto_app = app.clone();
    let paths_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let _writer = GUIDE_WRITER.try_lock().map_err(|_| "account-guide-busy")?;
        let revision = request.revision()?;
        let id = request.account_id().to_owned();
        let root = account_vault_owner::directory(&crypto_app).await?;
        let read_id = id.clone();
        let ((prepared, wanted), generation) = owner
            .storage_with_generation(None, move |store, generation, check| {
                store.with_guide_read(|c| {
                    let prepared =
                        account_vault::prepare_resolve(c, &read_id, revision, generation, check)?;
                    Ok((prepared, account_guide::wanted(c, &read_id)?))
                })
            })
            .await?;
        if wanted.is_empty() {
            return Err("account-guide-no-ids".into());
        }
        owner.check()?;
        let resolved = account_vault::open(crypto_app, root, prepared).await?;
        let address = crate::account_acquisition::guide_address(&resolved, &owner)
            .await?
            .ok_or("account-guide-not-offered")?;
        let origin = resolved.metadata.server_origin.clone();
        let directory = paths_app
            .path()
            .app_cache_dir()
            .map_err(|_| "account-guide-storage-unavailable")?;
        std::fs::create_dir_all(&directory).map_err(|_| "account-guide-storage-unavailable")?;
        sweep(&directory);
        let mut name = [0u8; 16];
        getrandom::fill(&mut name).map_err(|_| "account-guide-storage-unavailable")?;
        let name: String = name.iter().map(|b| format!("{b:02x}")).collect();
        let download = Download(directory.join(format!("{PREFIX}{name}.part")));
        {
            use std::io::Write;
            let mut file = std::io::BufWriter::new(
                std::fs::File::create(&download.0)
                    .map_err(|_| "account-guide-storage-unavailable")?,
            );
            crate::account_acquisition::fetch_into(
                address,
                &origin,
                account_guide::DOWNLOAD_LIMIT,
                &owner,
                Instant::now() + DOWNLOAD_WINDOW,
                &mut |chunk| {
                    file.write_all(chunk)
                        .map_err(|_| "account-guide-storage-full".into())
                },
            )
            .await?;
            file.flush().map_err(|_| "account-guide-storage-full")?;
        }
        drop(resolved);
        let now = now_ms()?;
        let path = download.0.clone();
        let parse_owner = owner.clone();
        let parsed = tauri::async_runtime::spawn_blocking(move || {
            let file = std::fs::File::open(&path).map_err(|_| "account-guide-read-failed")?;
            account_guide::parse(
                account_guide::open_reader(file, account_guide::EXPANDED_LIMIT)?,
                &wanted,
                now - account_guide::KEEP_BEFORE_MS,
                now + account_guide::KEEP_AFTER_MS,
                account_guide::PROGRAM_LIMIT,
                &mut || parse_owner.check(),
            )
        })
        .await
        .map_err(|_| "account-guide-read-failed")??;
        drop(download);
        let account = id.clone();
        let (status, _) = owner
            .storage_with_generation(Some(generation), move |store, _, check| {
                store.with_guide_write(|c| {
                    account_guide::commit(c, &account, revision as i64, &parsed, now, check)
                })
            })
            .await?;
        Ok(status)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadRequest {
    schema_version: u8,
    account_id: String,
    #[serde(default)]
    from_ms: Option<i64>,
    #[serde(default)]
    to_ms: Option<i64>,
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    epg_id: Option<String>,
    #[serde(default)]
    after_start_ms: Option<i64>,
    #[serde(default)]
    after_ordinal: Option<i64>,
    #[serde(default)]
    limit: Option<usize>,
}
const SAFE: i64 = 9_007_199_254_740_991;
impl ReadRequest {
    fn account(&self) -> Result<&str, String> {
        if self.schema_version != 1
            || self.account_id.len() != 32
            || !self
                .account_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("account-reference-invalid".into());
        }
        Ok(&self.account_id)
    }
    fn window(&self) -> Result<(i64, i64), String> {
        match (self.from_ms, self.to_ms) {
            (Some(from), Some(to))
                if (0..=SAFE).contains(&from)
                    && (0..=SAFE).contains(&to)
                    && to > from
                    && to - from <= account_guide::KEEP_AFTER_MS + account_guide::KEEP_BEFORE_MS =>
            {
                Ok((from, to))
            }
            _ => Err("account-guide-window-invalid".into()),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Listed {
    revision: i64,
    epg_ids: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Programs {
    revision: i64,
    programs: Vec<account_guide::Program>,
}

async fn read<T: Send + 'static>(
    request_id: String,
    app: tauri::AppHandle,
    work: impl FnOnce(&rusqlite::Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (value, _) = owner
            .storage(None, move |store, check| {
                check()?;
                store.with_guide_read(work)
            })
            .await?;
        Ok(value)
    })
    .await
}
pub(crate) async fn status(
    request: ReadRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Option<account_guide::Status>, String> {
    let account = request.account()?.to_owned();
    read(request_id, app, move |c| account_guide::status(c, &account)).await
}
pub(crate) async fn channels(
    request: ReadRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<account_guide::GuideChannel>, String> {
    let account = request.account()?.to_owned();
    read(request_id, app, move |c| account_guide::channels(c, &account)).await
}
pub(crate) async fn listed(
    request: ReadRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Listed, String> {
    let account = request.account()?.to_owned();
    let (from, to) = request.window()?;
    let search = request.search.unwrap_or_default();
    if search.len() > 256 || search.chars().any(char::is_control) {
        return Err("account-guide-search-invalid".into());
    }
    read(request_id, app, move |c| {
        let revision = account_guide::status(c, &account)?.map_or(0, |s| s.revision);
        Ok(Listed {
            revision,
            epg_ids: account_guide::listed(c, &account, from, to, &search)?,
        })
    })
    .await
}
pub(crate) async fn programs(
    request: ReadRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Programs, String> {
    let account = request.account()?.to_owned();
    let (from, to) = request.window()?;
    let epg = request
        .epg_id
        .clone()
        .filter(|v| !v.is_empty() && v.len() <= 16_384)
        .ok_or("account-guide-channel-invalid")?;
    let after = match (request.after_start_ms, request.after_ordinal) {
        (Some(start), Some(ordinal)) if start.abs() <= SAFE && (0..=SAFE).contains(&ordinal) => {
            Some((start, ordinal))
        }
        (None, None) => None,
        _ => return Err("account-guide-cursor-invalid".into()),
    };
    let limit = request.limit.unwrap_or(100).clamp(1, 100);
    read(request_id, app, move |c| {
        let revision = account_guide::status(c, &account)?.map_or(0, |s| s.revision);
        Ok(Programs {
            revision,
            programs: account_guide::programs(c, &account, &epg, from, to, after, limit)?,
        })
    })
    .await
}
