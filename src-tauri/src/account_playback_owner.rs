//! One local account playback transport. No receiver/LAN route is enabled here.
use crate::{
    account_catalog_owner,
    account_playback_proxy::{AccountPlaybackProxy, Authority},
    scan_manifest_work,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use zeroize::Zeroizing;

static ACTIVE: tokio::sync::Mutex<Option<(String, String, AccountPlaybackProxy)>> =
    tokio::sync::Mutex::const_new(None);
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Per account, the live format ("ts"/"m3u8") that last delivered real video
/// (XC-026/XC-040). Never set by a failure: providers' error codes differ, so
/// only media that actually arrived counts. Kept for this run of GenX, so each
/// start of the app checks again.
static PROVEN: Mutex<Option<HashMap<String, &'static str>>> = Mutex::new(None);
fn extension(url: &str) -> Option<&'static str> {
    let path = reqwest::Url::parse(url).ok()?.path().to_ascii_lowercase();
    if path.ends_with(".ts") {
        Some("ts")
    } else if path.ends_with(".m3u8") {
        Some("m3u8")
    } else {
        None
    }
}
/// The same live channel in the provider's other format (".ts" <-> ".m3u8" on
/// the last path segment of a /live/ address only).
fn other_format(url: &str) -> Option<String> {
    let mut parsed = reqwest::Url::parse(url).ok()?;
    let path = parsed.path().to_owned();
    if !path.contains("/live/") {
        return None;
    }
    let swapped = if let Some(stem) = path.strip_suffix(".ts") {
        format!("{stem}.m3u8")
    } else if let Some(stem) = path.strip_suffix(".m3u8") {
        format!("{stem}.ts")
    } else {
        return None;
    };
    parsed.set_path(&swapped);
    Some(parsed.to_string())
}
/// Which stored address a start uses, and whether another stored format remains
/// to try. Only an address the import stored is ever used (never a guess).
fn choose<'a>(urls: &'a [String], proven: Option<&str>, alternate: bool) -> (&'a str, bool) {
    let Some(primary) = urls.first() else {
        return ("", false);
    };
    let other = other_format(primary).and_then(|o| urls.iter().find(|u| **u == o));
    let Some(other) = other else {
        return (primary, false);
    };
    let (first, second) = if proven.is_some() && proven == extension(other) {
        (other, primary)
    } else {
        (primary, other)
    };
    if alternate {
        (second, false)
    } else {
        (first, true)
    }
}
fn proven(account: &str) -> Option<String> {
    PROVEN
        .lock()
        .ok()?
        .as_ref()?
        .get(account)
        .map(|f| f.to_string())
}
fn prove(account: &str, url: &str) {
    if let (Some(format), Ok(mut map)) = (extension(url), PROVEN.lock()) {
        map.get_or_insert_with(HashMap::new)
            .insert(account.to_owned(), format);
    }
}
#[cfg(test)]
fn forget(account: &str) {
    if let Ok(mut map) = PROVEN.lock() {
        if let Some(map) = map.as_mut() {
            map.remove(account);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Started {
    schema_version: u8,
    session_generation: String,
    media_url: String,
    /// The provider's other advertised format is stored for this channel and
    /// has not been tried in this start (the player may ask for it once).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    alternate_available: bool,
    /// Stream format from the upstream address's extension only ("hls" or
    /// "mpegts"), so the player can skip a separate format check (a second
    /// connection, which one-connection providers refuse). Never the address.
    #[serde(skip_serializing_if = "Option::is_none")]
    media_hint: Option<&'static str>,
}
fn media_hint(url: &str) -> Option<&'static str> {
    let path = reqwest::Url::parse(url).ok()?.path().to_ascii_lowercase();
    if path.ends_with(".m3u8") {
        Some("hls")
    } else if path.ends_with(".ts") {
        Some("mpegts")
    } else if path
        .rsplit('/')
        .next()
        .is_some_and(|last| !last.is_empty() && last.bytes().all(|b| b.is_ascii_digit()))
    {
        // Xtream-style playlist entries (".../USER/PASS/12345", no extension)
        // are served as live MPEG-TS by Xtream panels.
        Some("mpegts")
    } else {
        None
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Stopped {
    schema_version: u8,
    session_generation: String,
    stopped: bool,
}
fn advance() -> Result<u64, String> {
    GENERATION
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
        .map(|prior| prior + 1)
        .map_err(|_| "account-playback-generation-exhausted".into())
}
fn generation(value: &str) -> Result<u64, String> {
    if value.is_empty()
        || value.len() > 20
        || value.starts_with('0')
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("account-playback-session-invalid".into());
    }
    value
        .parse()
        .map_err(|_| "account-playback-session-invalid".into())
}
pub(crate) async fn start(
    request: account_catalog_owner::ResolveRequest,
    alternate: bool,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Started, String> {
    let media_app = app.clone();
    let busy_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        // Refuse concurrent startup instead of retaining an unbounded queue.
        let mut active = ACTIVE.try_lock().map_err(|_| "account-playback-busy")?;
        let current = advance()?;
        if let Some((_, _, previous)) = active.as_mut() {
            previous.stop().await?;
        }
        *active = None;
        owner.check()?;
        let account_id = request.account_id.clone();
        let selection = account_catalog_owner::resolve(owner.clone(), media_app, request).await?;
        let channel_id = selection.media.channel_id().to_owned();
        if selection.media.urls().is_empty() {
            return Err("account-media-unavailable".into());
        }
        let remembered = proven(&account_id);
        let (url, alternate_available) =
            choose(selection.media.urls(), remembered.as_deref(), alternate);
        let url = url.to_owned();
        let hint = media_hint(&url);
        let origin = selection.authority.origin.clone();
        let authority_owner = owner.clone();
        let captured = selection.authority;
        let authority: Authority = Arc::new(move || {
            let owner = authority_owner.clone();
            let captured = captured.clone();
            Box::pin(async move {
                if GENERATION.load(Ordering::SeqCst) != current {
                    return Err("account-playback-session-replaced".into());
                }
                account_catalog_owner::verify(owner, captured).await?;
                if GENERATION.load(Ordering::SeqCst) != current {
                    return Err("account-playback-session-replaced".into());
                }
                Ok(())
            })
        });
        // Tell the player (by session number only) that the provider is still
        // busy with the previous channel, so it can say so while waiting.
        let busy: crate::account_playback_proxy::BusyNotice = Arc::new(move || {
            use tauri::Emitter;
            let _ = busy_app.emit("account-playback-busy", current.to_string());
        });
        let proven_account = account_id.clone();
        let proven_url = url.clone();
        let on_media: crate::account_playback_proxy::MediaNotice =
            Arc::new(move || prove(&proven_account, &proven_url));
        let proxy = AccountPlaybackProxy::start(
            Zeroizing::new(url.clone()),
            origin,
            current,
            authority,
            false,
            Some(busy),
            Some(on_media),
        )
        .await?;
        let media_url = proxy.media_url().to_owned();
        *active = Some((account_id, channel_id, proxy));
        // Abort during startup must join the newly created listener before a
        // canceled response. Failed cleanup retains its handle for retry/exit.
        if let Err(error) = owner.check() {
            active
                .as_mut()
                .ok_or("account-playback-owner-lost")?
                .2
                .stop()
                .await?;
            *active = None;
            return Err(error);
        }
        Ok(Started {
            schema_version: 1,
            session_generation: current.to_string(),
            media_url,
            alternate_available,
            media_hint: hint,
        })
    })
    .await
}
/// Movies and series episodes: the same single session and relay as live TV,
/// with the relay in VOD mode (large ranged video files, bounded reads).
pub(crate) async fn start_vod(
    request: crate::account_vod::PlayRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Started, String> {
    let resolve_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let mut active = ACTIVE.try_lock().map_err(|_| "account-playback-busy")?;
        let current = advance()?;
        if let Some((_, _, previous)) = active.as_mut() {
            previous.stop().await?;
        }
        *active = None;
        owner.check()?;
        let revision = crate::account_vod::revision(
            request.schema_version,
            &request.account_id,
            &request.expected_revision,
        )?;
        let (resolved, _) =
            crate::account_vod::resolve(&owner, &resolve_app, request.account_id.clone(), revision)
                .await?;
        // A title listed without a container: its own detail, or a plain refusal.
        let extension = if request.extension.is_empty() {
            crate::account_vod::missing_extension(&resolved, &owner, request.kind, &request.item_id)
                .await?
        } else {
            request.extension.clone()
        };
        let url = crate::account_vod::media_url(
            &resolved,
            request.kind,
            &request.item_id,
            &extension,
        )?;
        let origin = resolved.metadata.server_origin.clone();
        drop(resolved);
        let hint = match extension.as_str() {
            "m3u8" => "hls",
            "ts" => "mpegts",
            _ => "file",
        };
        let authority_owner = owner.clone();
        let account = request.account_id.clone();
        let authority: Authority = Arc::new(move || {
            let owner = authority_owner.clone();
            let account = account.clone();
            Box::pin(async move {
                if GENERATION.load(Ordering::SeqCst) != current {
                    return Err("account-playback-session-replaced".into());
                }
                crate::account_vod::verify(owner, account, revision).await
            })
        });
        let proxy =
            AccountPlaybackProxy::start(url, origin, current, authority, true, None, None).await?;
        let media_url = proxy.media_url().to_owned();
        *active = Some((
            request.account_id.clone(),
            format!("vod-{}", request.item_id),
            proxy,
        ));
        if let Err(error) = owner.check() {
            active
                .as_mut()
                .ok_or("account-playback-owner-lost")?
                .2
                .stop()
                .await?;
            *active = None;
            return Err(error);
        }
        Ok(Started {
            schema_version: 1,
            session_generation: current.to_string(),
            media_url,
            alternate_available: false,
            media_hint: Some(hint),
        })
    })
    .await
}
pub(crate) async fn stop(session_generation: String) -> Result<Stopped, String> {
    let expected = generation(&session_generation)?;
    let mut active = ACTIVE.lock().await;
    if expected > GENERATION.load(Ordering::SeqCst) {
        return Err("account-playback-session-invalid".into());
    }
    if let Some((_, _, proxy)) = active.as_mut() {
        if proxy.generation()? == expected {
            proxy.stop().await?;
            *active = None;
        }
    }
    // Older generations have already been joined before their replacement.
    // Their cleanup cannot stop the currently playing newer generation.
    Ok(Stopped {
        schema_version: 1,
        session_generation,
        stopped: true,
    })
}
pub(crate) async fn shutdown() -> Result<(), &'static str> {
    let mut active = ACTIVE.lock().await;
    let advanced = advance();
    if let Some((_, _, proxy)) = active.as_mut() {
        proxy
            .stop()
            .await
            .map_err(|_| "account-playback-stop-unconfirmed")?;
    }
    *active = None;
    advanced
        .map(|_| ())
        .map_err(|_| "account-playback-stop-unconfirmed")
}
pub(crate) async fn stop_account(account: &str) -> Result<(), String> {
    let mut active = ACTIVE.lock().await;
    if let Some((id, _, proxy)) = active.as_mut() {
        if id == account {
            proxy.stop().await?;
            *active = None;
        }
    }
    Ok(())
}
pub(crate) async fn stop_channel(account: &str, channel: &str) -> Result<(), String> {
    let mut active = ACTIVE.lock().await;
    if let Some((id, selected, proxy)) = active.as_mut() {
        if id == account && selected == channel {
            proxy.stop().await?;
            *active = None;
        }
    }
    Ok(())
}

#[cfg(test)]
mod hint_tests {
    #[test]
    fn hint_comes_from_the_extension_only() {
        assert_eq!(
            super::media_hint("http://x.invalid/live/u/p/1.m3u8"),
            Some("hls")
        );
        assert_eq!(
            super::media_hint("http://x.invalid/live/u/p/1.TS"),
            Some("mpegts")
        );
        assert_eq!(super::media_hint("http://x.invalid/u/p/1"), Some("mpegts"));
        assert_eq!(super::media_hint("http://x.invalid/stream/live"), None);
        assert_eq!(super::media_hint("http://x.invalid/"), None);
        assert_eq!(
            super::media_hint("http://x.invalid/a.ts?token=1"),
            Some("mpegts")
        );
        assert_eq!(super::media_hint("not a url"), None);
    }
}

#[cfg(test)]
mod format_tests {
    use super::*;
    fn urls(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn the_other_format_is_only_ever_one_the_import_stored() {
        let ts = "http://tv.fixture.example/live/u/p/7.ts";
        let hls = "http://tv.fixture.example/live/u/p/7.m3u8";
        assert_eq!(other_format(ts).as_deref(), Some(hls));
        assert_eq!(other_format(hls).as_deref(), Some(ts));
        assert_eq!(other_format("http://tv.fixture.example/live/u/p/7"), None);
        assert_eq!(other_format("http://tv.fixture.example/movie/u/p/7.mkv"), None);
        // Stored: primary + the provider's other advertised format.
        let both = urls(&[ts, hls]);
        assert_eq!(choose(&both, None, false), (ts, true));
        assert_eq!(choose(&both, None, true), (hls, false));
        // A format that delivered media before is used first; its other one stays available.
        assert_eq!(choose(&both, Some("m3u8"), false), (hls, true));
        assert_eq!(choose(&both, Some("m3u8"), true), (ts, false));
        // Only one format stored (provider advertised one): never a guessed address.
        let only = urls(&[ts]);
        assert_eq!(choose(&only, None, false), (ts, false));
        assert_eq!(choose(&only, None, true), (ts, false));
        assert_eq!(choose(&only, Some("m3u8"), false), (ts, false));
        // A backup that is not the other format is not treated as one.
        let backup = urls(&[ts, "http://tv.fixture.example/live/u/p/8.m3u8"]);
        assert_eq!(choose(&backup, None, true), (ts, false));
    }
    #[test]
    fn only_media_that_arrived_is_remembered_per_account() {
        let account = "format-test-account";
        forget(account);
        assert_eq!(proven(account), None);
        prove(account, "http://tv.fixture.example/live/u/p/7.m3u8");
        assert_eq!(proven(account).as_deref(), Some("m3u8"));
        assert_eq!(proven("another-account"), None);
        prove(account, "http://tv.fixture.example/live/u/p/7.ts");
        assert_eq!(proven(account).as_deref(), Some("ts"));
        forget(account);
    }
}
