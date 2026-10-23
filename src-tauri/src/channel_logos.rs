//! Public directory logos for exact saved channel IDs. Never an arbitrary URL API.
use crate::scan_manifest_work::{self, Context};
use base64::Engine;
use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::ToSocketAddrs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::time::Instant;
const DIRECTORY_URL: &str = "https://iptv-org.github.io/api/logos.json";
const DIRECTORY_BYTES: usize = 12 * 1024 * 1024;
const IMAGE_BYTES: usize = 256 * 1024;
const IMAGE_PIXELS: u32 = 262144;
const CACHE_IMAGES: usize = 128;
const DAY: Duration = Duration::from_secs(86400);
pub(crate) struct LogoRow {
    pub channel_id: String,
    pub provider_ids: Vec<String>,
}
pub(crate) struct Capture {
    pub root: PathBuf,
    pub rows: Vec<LogoRow>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    schema_version: u8,
    channel_ids: Vec<String>,
    expected_revision: String,
}
#[derive(Clone, Deserialize)]
struct Logo {
    channel: String,
    feed: Option<String>,
    in_use: bool,
    width: u32,
    height: u32,
    format: Option<String>,
    url: String,
    #[serde(default)]
    tags: Vec<String>,
}
struct Directory {
    root: PathBuf,
    loaded: SystemTime,
    ttl: Duration,
    logos: HashMap<String, Vec<Logo>>,
}
static DIRECTORY: tokio::sync::Mutex<Option<Directory>> = tokio::sync::Mutex::const_new(None);
static BATCH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Image {
    channel_id: String,
    provider_id: String,
    mime_type: String,
    width: u32,
    height: u32,
    byte_length: usize,
    data_url: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reply {
    schema_version: u8,
    catalog_revision: String,
    attempted_channel_ids: Vec<String>,
    images: Vec<Image>,
}
fn check(owner: &Arc<Context>, deadline: Instant) -> Result<(), String> {
    owner.check()?;
    if Instant::now() >= deadline {
        return Err("channel-logo-timeout".into());
    }
    Ok(())
}
fn destination(raw: &str) -> Result<Url, String> {
    if raw.len() > 4096
        || !raw.starts_with("https://")
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("channel-logo-destination-refused".into());
    }
    let url = Url::parse(raw).map_err(|_| "channel-logo-destination-refused")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("channel-logo-destination-refused".into());
    }
    Ok(url)
}
async fn client(owner: &Arc<Context>, deadline: Instant, host: &str) -> Result<Client, String> {
    check(owner, deadline)?;
    let host_owned = host.to_owned();
    let mut task = tauri::async_runtime::spawn_blocking(move || {
        let mut addresses = Vec::new();
        for address in (host_owned.as_str(), 443)
            .to_socket_addrs()
            .map_err(|_| "channel-logo-dns")?
        {
            if addresses.len() >= 128 || !crate::sharing_policy::public_upstream(address.ip()) {
                return Err("channel-logo-destination-refused");
            }
            addresses.push(address);
        }
        if addresses.is_empty() {
            return Err("channel-logo-dns");
        }
        Ok(addresses)
    });
    let addresses = loop {
        if let Err(e) = check(owner, deadline) {
            let _ = task.await;
            return Err(e);
        }
        tokio::select! { r=&mut task=>{let addresses=r.map_err(|_|"channel-logo-dns")?.map_err(str::to_owned)?; check(owner,deadline)?;break addresses;},_=tokio::time::sleep(Duration::from_millis(50))=>{} }
    };
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(5))
        .user_agent("GenX-Streamer/0.1 (channel artwork)")
        .build()
        .map_err(|_| "channel-logo-client".into())
}
async fn fetch(
    owner: &Arc<Context>,
    deadline: Instant,
    raw: &str,
    limit: usize,
    image: bool,
) -> Result<(Vec<u8>, String), String> {
    let mut url = destination(raw)?;
    for redirect in 0..=3 {
        check(owner, deadline)?;
        let request = client(
            owner,
            deadline,
            url.host_str().ok_or("channel-logo-destination-refused")?,
        )
        .await?;
        let mut response = observe(deadline, || owner.check(), async {
            request
                .get(url.clone())
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .send()
                .await
                .map_err(|_| "channel-logo-network".to_owned())
        })
        .await?;
        check(owner, deadline)?;
        if response.status().is_redirection() {
            if redirect == 3 {
                return Err("channel-logo-redirect-limit".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("channel-logo-redirect-refused")?;
            url = destination(
                url.join(location)
                    .map_err(|_| "channel-logo-redirect-refused")?
                    .as_str(),
            )?;
            if !image && url.as_str() != DIRECTORY_URL {
                return Err("channel-logo-directory-redirect-refused".into());
            }
            continue;
        }
        if response.status().as_u16() != 200
            || response.content_length().is_some_and(|n| n > limit as u64)
            || response
                .headers()
                .get(reqwest::header::CONTENT_ENCODING)
                .is_some_and(|v| v.as_bytes() != b"identity")
            || response
                .headers()
                .contains_key(reqwest::header::CONTENT_RANGE)
        {
            return Err("channel-logo-response-refused".into());
        }
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_lowercase();
        if image && !matches!(mime.as_str(), "image/png" | "image/jpeg") {
            return Err("channel-logo-format-refused".into());
        }
        let declared = response.content_length();
        let mut bytes = Vec::new();
        while let Some(chunk) = observe(deadline, || owner.check(), async {
            response
                .chunk()
                .await
                .map_err(|_| "channel-logo-network".to_owned())
        })
        .await?
        {
            check(owner, deadline)?;
            if bytes
                .len()
                .checked_add(chunk.len())
                .is_none_or(|n| n > limit)
            {
                return Err("channel-logo-byte-limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() || declared.is_some_and(|n| n != bytes.len() as u64) {
            return Err("channel-logo-truncated".into());
        }
        check(owner, deadline)?;
        return Ok((bytes, mime));
    }
    Err("channel-logo-redirect-limit".into())
}
fn directory(bytes: &[u8]) -> Result<HashMap<String, Vec<Logo>>, String> {
    if bytes.len() > DIRECTORY_BYTES {
        return Err("channel-logo-directory-limit".into());
    }
    let logos: Vec<Logo> =
        serde_json::from_slice(bytes).map_err(|_| "channel-logo-directory-invalid")?;
    if logos.len() > 100000 {
        return Err("channel-logo-directory-limit".into());
    }
    let mut by_channel = HashMap::<String, Vec<Logo>>::new();
    for logo in logos {
        if logo.channel.is_empty()
            || logo.channel.len() > 1024
            || logo
                .channel
                .chars()
                .any(|c| c.is_control() || c.is_whitespace())
            || logo.feed.as_ref().is_some_and(|s| {
                s.is_empty()
                    || s.len() > 256
                    || s.chars().any(|c| c.is_control() || c.is_whitespace())
            })
            || !logo.in_use
            || !matches!(logo.format.as_deref(), Some("PNG" | "JPEG"))
            || logo.width == 0
            || logo.height == 0
            || logo.width > 2048
            || logo.height > 2048
            || logo
                .width
                .checked_mul(logo.height)
                .is_none_or(|n| n > IMAGE_PIXELS)
            || logo.tags.len() > 32
            || logo.tags.iter().any(|s| s.len() > 64)
            || destination(&logo.url).is_err()
        {
            continue;
        }
        let candidates = by_channel.entry(logo.channel.clone()).or_default();
        if candidates.len() < 32 {
            candidates.push(logo);
        }
    }
    Ok(by_channel)
}
fn choose<'a>(logos: &'a HashMap<String, Vec<Logo>>, provider: &str) -> Option<&'a Logo> {
    if provider.len() > 1024
        || provider
            .chars()
            .any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }
    let (channel, feed) = provider
        .split_once('@')
        .map_or((provider, None), |(c, f)| (c, Some(f)));
    if feed.is_some_and(|f| f.is_empty() || f.contains('@'))
        || channel.is_empty()
        || channel.len() > 1024
        || channel.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return None;
    }
    logos
        .get(channel)?
        .iter()
        .filter(|logo| logo.feed.is_none() || logo.feed.as_deref() == feed)
        .min_by_key(|logo| {
            (
                u8::from(logo.feed.as_deref() != feed),
                u8::from(logo.tags.iter().any(|s| s == "black")),
                logo.width.abs_diff(512) + logo.height.abs_diff(256),
                logo.url.as_str(),
            )
        })
}
fn cache_dir(root: &Path) -> Result<PathBuf, String> {
    crate::storage::refuse_link(root)?;
    let path = root.join("channel-logo-cache-v1");
    crate::storage::refuse_link(&path)?;
    std::fs::create_dir_all(&path).map_err(|_| "channel-logo-cache")?;
    Ok(path)
}
fn cache_read(path: &Path, limit: usize) -> Option<Vec<u8>> {
    crate::storage::refuse_link(path).ok()?;
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return None;
    }
    std::fs::read(path).ok()
}
fn cache_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    crate::storage::refuse_link(path)?;
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("channel-logo-cache")?)
        .map_err(|_| "channel-logo-cache")?;
    temp.write_all(bytes).map_err(|_| "channel-logo-cache")?;
    temp.as_file()
        .sync_all()
        .map_err(|_| "channel-logo-cache")?;
    temp.persist(path).map_err(|_| "channel-logo-cache")?;
    Ok(())
}
async fn load_directory(
    owner: &Arc<Context>,
    root: &Path,
    deadline: Instant,
) -> Result<HashMap<String, Vec<Logo>>, String> {
    let mut slot = loop {
        check(owner, deadline)?;
        tokio::select! { guard=DIRECTORY.lock()=>break guard,_=tokio::time::sleep(Duration::from_millis(50))=>{} }
    };
    if let Some(current) = slot
        .as_ref()
        .filter(|d| d.root == root && d.loaded.elapsed().is_ok_and(|age| age < d.ttl))
    {
        return Ok(current.logos.clone());
    }
    let cache_root = root.to_owned();
    let disk = tauri::async_runtime::spawn_blocking(move || {
        let cache = cache_dir(&cache_root).ok()?;
        let path = cache.join("directory.json");
        let fresh = std::fs::metadata(&path)
            .ok()?
            .modified()
            .ok()?
            .elapsed()
            .is_ok_and(|age| age < DAY);
        Some((directory(&cache_read(&path, DIRECTORY_BYTES)?).ok()?, fresh))
    })
    .await
    .map_err(|_| "channel-logo-cache")?;
    check(owner, deadline)?;
    let stale = disk.as_ref().map(|(logos, _)| logos.clone()).or_else(|| {
        slot.as_ref()
            .filter(|d| d.root == root)
            .map(|d| d.logos.clone())
    });
    let (logos, ttl) = if let Some((logos, true)) = disk {
        (logos, DAY)
    } else {
        let refresh_deadline = if stale.is_some() {
            deadline.min(Instant::now() + Duration::from_secs(8))
        } else {
            deadline
        };
        let fresh = async {
            let (bytes, _) = fetch(
                owner,
                refresh_deadline,
                DIRECTORY_URL,
                DIRECTORY_BYTES,
                false,
            )
            .await?;
            let bytes_for_parse = bytes.clone();
            let parsed = tauri::async_runtime::spawn_blocking(move || directory(&bytes_for_parse))
                .await
                .map_err(|_| "channel-logo-directory-invalid")??;
            check(owner, deadline)?;
            let cache_root = root.to_owned();
            // Best-effort cache only. Cache errors cannot change canonical storage.
            tauri::async_runtime::spawn_blocking(move || {
                if let Ok(cache) = cache_dir(&cache_root) {
                    let _ = cache_write(&cache.join("directory.json"), &bytes);
                }
            })
            .await
            .map_err(|_| "channel-logo-cache")?;
            Ok::<_, String>(parsed)
        }
        .await;
        settle_refresh(fresh, stale, || check(owner, deadline))?
    };
    *slot = Some(Directory {
        root: root.to_owned(),
        loaded: SystemTime::now(),
        ttl,
        logos: logos.clone(),
    });
    Ok(logos)
}
// Reuse representation checks, then apply the tighter Live-logo allocation cap.
fn validate_image(bytes: &[u8], mime: &str) -> Result<(u32, u32), String> {
    if bytes.len() > IMAGE_BYTES {
        return Err("channel-logo-byte-limit".into());
    }
    let (width, height) = crate::archive_artwork::validate(bytes, mime)?;
    if width
        .checked_mul(height)
        .is_none_or(|pixels| pixels > IMAGE_PIXELS)
    {
        return Err("channel-logo-dimensions-refused".into());
    }
    Ok((width, height))
}
fn settle_refresh<T>(
    fresh: Result<T, String>,
    stale: Option<T>,
    check: impl FnOnce() -> Result<(), String>,
) -> Result<(T, Duration), String> {
    // A valid stale directory is availability fallback, never cancel/deadline authority.
    check()?;
    match fresh {
        Ok(value) => Ok((value, DAY)),
        Err(error) => stale
            .map(|value| (value, Duration::from_secs(3600)))
            .ok_or(error),
    }
}
async fn observe<T>(
    deadline: Instant,
    check: impl Fn() -> Result<(), String>,
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::pin!(future);
    loop {
        check()?;
        if Instant::now() >= deadline {
            return Err("channel-logo-timeout".into());
        }
        tokio::select! {
            result=&mut future => { check()?; if Instant::now()>=deadline {return Err("channel-logo-timeout".into());} return result; },
            _=tokio::time::sleep_until(deadline)=>return Err("channel-logo-timeout".into()),
            _=tokio::time::sleep(Duration::from_millis(50))=>{}
        }
    }
}
async fn image(
    owner: &Arc<Context>,
    root: &Path,
    logo: &Logo,
    deadline: Instant,
) -> Result<(Vec<u8>, String, u32, u32), String> {
    let mime = if logo.format.as_deref() == Some("PNG") {
        "image/png"
    } else {
        "image/jpeg"
    };
    let key = format!("{:x}.img", Sha256::digest(logo.url.as_bytes()));
    let cache_root = root.to_owned();
    let disk_key = key.clone();
    let disk = tauri::async_runtime::spawn_blocking(move || {
        cache_dir(&cache_root)
            .ok()
            .and_then(|cache| cache_read(&cache.join(disk_key), IMAGE_BYTES))
    })
    .await
    .map_err(|_| "channel-logo-cache")?;
    check(owner, deadline)?;
    if let Some(bytes) = disk {
        if let Ok((w, h)) = validate_image(&bytes, mime) {
            return Ok((bytes, mime.into(), w, h));
        }
    }
    let (bytes, actual_mime) = fetch(owner, deadline, &logo.url, IMAGE_BYTES, true).await?;
    if actual_mime != mime {
        return Err("channel-logo-format-refused".into());
    }
    let (w, h) = validate_image(&bytes, &actual_mime)?;
    check(owner, deadline)?;
    let cache_root = root.to_owned();
    let saved = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(cache) = cache_dir(&cache_root) {
            // Only exact owned hash names are eligible for bounded cache eviction.
            if let Ok(entries) = std::fs::read_dir(&cache) {
                let entries: Vec<_> = entries.take(1025).collect();
                if entries.len() > 1024 {
                    return;
                }
                let mut owned: Vec<_> = entries
                    .into_iter()
                    .filter_map(Result::ok)
                    .filter(|e| {
                        let name = e.file_name();
                        let s = name.to_string_lossy();
                        s.len() == 68
                            && s.ends_with(".img")
                            && s.as_bytes()[..64].iter().all(u8::is_ascii_hexdigit)
                            && e.file_type().is_ok_and(|t| t.is_file())
                    })
                    .collect();
                owned.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
                while owned.len() >= CACHE_IMAGES {
                    let old = owned.remove(0);
                    let _ = std::fs::remove_file(old.path());
                }
            }
            let _ = cache_write(&cache.join(key), &saved);
        }
    })
    .await
    .map_err(|_| "channel-logo-cache")?;
    Ok((bytes, actual_mime, w, h))
}
#[tauri::command]
pub(crate) async fn channel_logos(
    request: Request,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Reply, String> {
    if request.schema_version != 1 {
        return Err("channel-logo-request-invalid".into());
    }
    scan_manifest_work::owned(request_id,app,move |owner|async move {
        let _batch=loop {
            owner.check()?;
            tokio::select! { guard=BATCH.lock()=>break guard,_=tokio::time::sleep(Duration::from_millis(50))=>{} }
        };
        let ids=request.channel_ids; let final_ids=ids.clone(); let revision=request.expected_revision;
        let read_revision=revision.clone();
        let (capture,generation)=owner.storage(None,move |store,check|store.channel_logo_capture(&ids,&read_revision,check)).await?;
        let deadline=Instant::now()+Duration::from_secs(25);
        let logos=load_directory(&owner,&capture.root,deadline).await?;
        let mut images=Vec::new(); let mut attempted_channel_ids=Vec::new(); let mut total=0usize;
        for row in capture.rows {
            owner.check()?;
            if Instant::now()>=deadline { break; }
            attempted_channel_ids.push(row.channel_id.clone());
            let Some((provider,logo))=row.provider_ids.iter().find_map(|p|choose(&logos,p).map(|l|(p,l))) else {continue};
            if let Ok((bytes,mime,width,height))=image(&owner,&capture.root,logo,deadline).await {
                total+=bytes.len(); if total>8*1024*1024 {return Err("channel-logo-batch-limit".into());}
                images.push(Image { channel_id:row.channel_id,provider_id:provider.clone(),mime_type:mime.clone(),width,height,byte_length:bytes.len(),data_url:format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes)) });
            }
        }
        owner.check()?;
        // Confirm the same root/catalog before any image can reach a live card.
        let expected=revision.clone(); owner.storage(Some(generation),move |store,check|store.channel_logo_capture(&final_ids,&expected,check)).await?;
        Ok(Reply {schema_version:1,catalog_revision:revision,attempted_channel_ids,images})
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn logo(channel: &str, feed: Option<&str>, url: &str) -> serde_json::Value {
        serde_json::json!({"channel":channel,"feed":feed,"in_use":true,"width":512,"height":256,"format":"PNG","url":url,"tags":[]})
    }
    fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut data = vec![
            0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 0, 0xff, 0xda, 0, 2, 0xff, 0xd9,
        ];
        data[7..9].copy_from_slice(&height.to_be_bytes());
        data[9..11].copy_from_slice(&width.to_be_bytes());
        data
    }
    #[test]
    fn channel_logo_metadata_selects_exact_provider_feed_without_name_guessing() {
        let bytes = serde_json::to_vec(&serde_json::json!([
            logo("Exact.us", None, "https://example.invalid/generic.png"),
            logo("Exact.us", Some("East"), "https://example.invalid/east.png"),
            logo("Exact.us", Some("West"), "https://example.invalid/west.png"),
            logo(
                "Exact.usExtra",
                None,
                "https://example.invalid/unrelated.png"
            )
        ]))
        .unwrap();
        let rows = directory(&bytes).unwrap();
        assert!(choose(&rows, "Exact").is_none());
        assert!(choose(&rows, "exact.us").is_none());
        assert_eq!(
            choose(&rows, "Exact.us@East").unwrap().url,
            "https://example.invalid/east.png"
        );
        assert_eq!(
            choose(&rows, "Exact.us@West").unwrap().url,
            "https://example.invalid/west.png"
        );
        assert_eq!(
            choose(&rows, "Exact.us@Other").unwrap().url,
            "https://example.invalid/generic.png"
        );
        for invalid in [
            "Exact.us@",
            "Exact.us@East@West",
            "Exact.us@\nEast",
            " Exact.us",
        ] {
            assert!(choose(&rows, invalid).is_none());
        }
    }
    #[test]
    fn channel_logo_directory_filters_inactive_large_unsafe_and_unsupported_claims() {
        let valid = logo("Exact.us", None, "https://example.invalid/generic.png");
        let mut rows = vec![valid.clone()];
        for (key, value) in [
            ("in_use", serde_json::json!(false)),
            ("format", serde_json::json!("SVG")),
            ("height", serde_json::json!(1024)),
            ("width", serde_json::json!(0)),
            ("url", serde_json::json!("http://example.invalid/a.png")),
            ("feed", serde_json::json!("bad feed")),
            ("channel", serde_json::json!("bad\nchannel")),
            ("tags", serde_json::json!(["x".repeat(65)])),
        ] {
            let mut row = valid.clone();
            row[key] = value;
            rows.push(row);
        }
        let rows = directory(&serde_json::to_vec(&rows).unwrap()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows["Exact.us"].len(), 1);
        assert!(directory(b"not json").is_err());
        assert!(directory(&vec![b' '; DIRECTORY_BYTES + 1]).is_err());
        let many = vec![valid; 40];
        assert_eq!(
            directory(&serde_json::to_vec(&many).unwrap()).unwrap()["Exact.us"].len(),
            32
        );
    }
    #[test]
    fn channel_logo_actual_image_dimensions_and_bytes_use_live_limit() {
        assert_eq!(
            validate_image(&jpeg(512, 512), "image/jpeg").unwrap(),
            (512, 512)
        );
        // The common Archive validator allows this image; Live's smaller bound refuses it.
        let larger = jpeg(1024, 512);
        assert!(crate::archive_artwork::validate(&larger, "image/jpeg").is_ok());
        assert_eq!(
            validate_image(&larger, "image/jpeg").unwrap_err(),
            "channel-logo-dimensions-refused"
        );
        assert!(validate_image(&jpeg(0, 1), "image/jpeg").is_err());
        assert!(validate_image(&jpeg(1, 1), "image/png").is_err());
        assert!(validate_image(&vec![0; IMAGE_BYTES + 1], "image/jpeg").is_err());
        assert!(validate_image(b"<svg/>", "image/svg+xml").is_err());
    }
    #[test]
    fn channel_logo_stale_cache_outage_fallback_never_overrides_cancel_or_deadline() {
        let unavailable = || Err::<u8, _>("channel-logo-network".to_owned());
        assert_eq!(
            settle_refresh(unavailable(), Some(7), || Ok(())).unwrap(),
            (7, Duration::from_secs(3600))
        );
        assert_eq!(settle_refresh(Ok(8), Some(7), || Ok(())).unwrap(), (8, DAY));
        assert_eq!(
            settle_refresh(unavailable(), None, || Ok(())).unwrap_err(),
            "channel-logo-network"
        );
        for error in ["canceled", "channel-logo-timeout", "application-closing"] {
            assert_eq!(
                settle_refresh(unavailable(), Some(7), || Err(error.into())).unwrap_err(),
                error
            );
        }
    }
    #[test]
    fn channel_logo_cache_reads_are_bounded_and_do_not_trust_arbitrary_paths() {
        let root = tempfile::tempdir().unwrap();
        let cache = cache_dir(root.path()).unwrap();
        let image = cache.join("owned.img");
        cache_write(&image, b"abc").unwrap();
        assert_eq!(cache_read(&image, 3).unwrap(), b"abc");
        assert!(cache_read(&image, 2).is_none());
        assert!(cache_read(&cache, 100).is_none());
        assert!(cache_read(&cache.join("missing"), 100).is_none());
        let fake = root.path().join("fake");
        std::fs::write(&fake, b"file").unwrap();
        assert!(cache_dir(&fake).is_err());
    }
    #[tokio::test]
    async fn channel_logo_cancel_and_deadline_interrupt_original_network_observer() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let canceled = Arc::new(AtomicBool::new(false));
        let observed = canceled.clone();
        let entered = Arc::new(tokio::sync::Notify::new());
        let entered_check = entered.clone();
        let task = tokio::spawn(async move {
            observe(
                Instant::now() + Duration::from_secs(10),
                || {
                    entered_check.notify_one();
                    if observed.load(Ordering::SeqCst) {
                        Err("canceled".into())
                    } else {
                        Ok(())
                    }
                },
                std::future::pending::<Result<(), String>>(),
            )
            .await
        });
        entered.notified().await;
        assert!(!task.is_finished());
        canceled.store(true, Ordering::SeqCst);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err(),
            "canceled"
        );
        assert_eq!(
            observe(
                Instant::now() - Duration::from_millis(1),
                || Ok(()),
                async { Ok(()) }
            )
            .await
            .unwrap_err(),
            "channel-logo-timeout"
        );
    }
    #[test]
    fn channel_logo_destination_refuses_downgrades_credentials_fragments_and_controls() {
        assert!(destination(DIRECTORY_URL).is_ok());
        for raw in [
            "http://example.invalid/a.png",
            "https://u:p@example.invalid/a.png",
            "https://example.invalid:444/a.png",
            "https://example.invalid/a.png#b",
            "https://example.invalid/a\nb.png",
        ] {
            assert!(destination(raw).is_err(), "{raw}");
        }
    }
}
