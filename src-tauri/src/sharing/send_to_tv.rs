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

//! Install on TV (docs/send-to-tv.md): this phone pairs with a Google TV or
//! Android TV through the TV's built-in remote service (TvRemotePlugin.kt)
//! and opens GenX's own file on the nearby share there, so nobody types an
//! address (TV-003). Kept apart from the nearby download itself: if the
//! remote protocol changes, Share with everyone nearby, the share sheet and
//! Windows sharing are untouched. The person approves every install on the
//! TV; GenX never presses anything there (TV-004).
use serde::{Deserialize, Serialize};

/// The links GenX may open on a TV (mirrors TvLinks in TvRemoteWire.kt).
pub(crate) const DOWNLOADER_STORE: &str = "market://details?id=com.esaba.downloader";
/// Followed by the nearby share's `<session>/installed` address (TV-006).
pub(crate) const OPEN_GENX: &str = "genx://open?reply=";

/// What a TV opens to download GenX: the nearby session's file address.
pub(crate) fn file_link(session_url: &str) -> Option<String> {
    let rest = session_url.strip_prefix("http://")?;
    let (host, code) = rest.split_once('/')?;
    let (ip, port) = host.split_once(':')?;
    let ip: std::net::Ipv4Addr = ip.parse().ok()?;
    let valid = ip.is_private()
        && port.parse::<u16>().is_ok()
        && code.len() == 6
        && code.bytes().all(|b| b.is_ascii_digit());
    valid.then(|| format!("{session_url}/GenX-Streamer.apk"))
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FoundTv {
    pub name: String,
    pub host: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FoundTvs {
    pub tvs: Vec<FoundTv>,
}

/// The remote connection: whether it is up, the TV's model and the app in front.
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TvStatus {
    pub connected: bool,
    pub model: String,
    pub front_app: String,
    pub changes: u32,
}

#[cfg(target_os = "android")]
struct TvRemotePlugin(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry, ()>::new("send-to-tv")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                app.manage(TvRemotePlugin(
                    api.register_android_plugin("com.tmg.tv", "TvRemotePlugin")?,
                ));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
async fn call<R: serde::de::DeserializeOwned>(
    app: &tauri::AppHandle,
    command: &str,
    args: serde_json::Value,
) -> Result<R, String> {
    use tauri::Manager;
    let plugin = app.try_state::<TvRemotePlugin>().ok_or("tv-unavailable")?;
    plugin
        .0
        .run_mobile_plugin_async::<R>(command, args)
        .await
        .map_err(|error| match error {
            tauri::plugin::mobile::PluginInvokeError::InvokeRejected(rejected) => rejected
                .message
                .filter(|code| {
                    code.starts_with("tv-")
                        && code.len() <= 40
                        && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
                })
                .unwrap_or_else(|| "tv-unavailable".into()),
            _ => "tv-unavailable".into(),
        })
}

#[cfg(not(target_os = "android"))]
async fn call<R: serde::de::DeserializeOwned>(
    app: &tauri::AppHandle,
    command: &str,
    args: serde_json::Value,
) -> Result<R, String> {
    let _ = (app, command, args);
    Err("tv-unavailable".into())
}

fn local_host(host: &str) -> Result<(), String> {
    match host.parse::<std::net::Ipv4Addr>() {
        Ok(ip) if ip.is_private() => Ok(()),
        _ => Err("tv-address".into()),
    }
}

#[tauri::command]
pub(crate) async fn tv_find(app: tauri::AppHandle) -> Result<FoundTvs, String> {
    call(&app, "tvFind", serde_json::json!({})).await
}

/// Starts pairing; the TV shows a code (TV-001).
#[tauri::command]
pub(crate) async fn tv_pair_start(
    app: tauri::AppHandle,
    host: String,
    name: String,
) -> Result<(), String> {
    local_host(&host)?;
    let name: String = name.chars().filter(|c| !c.is_control()).take(80).collect();
    call::<serde_json::Value>(
        &app,
        "tvPairStart",
        serde_json::json!({ "host": host, "name": name }),
    )
    .await
    .map(|_| ())
}

#[tauri::command]
pub(crate) async fn tv_pair_finish(app: tauri::AppHandle, code: String) -> Result<(), String> {
    if code.chars().count() > 16 {
        return Err("tv-pair-wrong-code".into());
    }
    call::<serde_json::Value>(&app, "tvPairFinish", serde_json::json!({ "code": code }))
        .await
        .map(|_| ())
}

#[tauri::command]
pub(crate) async fn tv_connect(app: tauri::AppHandle, host: String) -> Result<TvStatus, String> {
    local_host(&host)?;
    call(
        &app,
        "tvConnect",
        serde_json::json!({ "host": host, "name": "" }),
    )
    .await
}

/// Opens GenX's file on the TV, starting the nearby share if it is not on
/// (it checks that this copy may send itself: official releases only).
#[tauri::command]
pub(crate) async fn tv_send_genx(app: tauri::AppHandle) -> Result<TvStatus, String> {
    let nearby = crate::nearby_download::nearby_start(app.clone()).await?;
    let link = nearby
        .url
        .as_deref()
        .and_then(file_link)
        .ok_or("tv-nearby-off")?;
    call(&app, "tvOpen", serde_json::json!({ "link": link })).await
}

/// Opens Downloader's store page: the TV has no app to download with.
#[tauri::command]
pub(crate) async fn tv_get_helper(app: tauri::AppHandle) -> Result<TvStatus, String> {
    call(
        &app,
        "tvOpen",
        serde_json::json!({ "link": DOWNLOADER_STORE }),
    )
    .await
}

/// Opens GenX on the TV with the nearby share's check address: the copy that
/// opens reports its installed file's SHA-256 there (TV-006).
pub(crate) fn open_link(session_url: &str) -> Option<String> {
    file_link(session_url).map(|_| format!("{OPEN_GENX}{session_url}/installed"))
}

#[tauri::command]
pub(crate) async fn tv_open_genx(app: tauri::AppHandle) -> Result<TvStatus, String> {
    use tauri::Manager;
    let url = app
        .state::<crate::nearby_download::NearbyOwner>()
        .current_url()
        .ok_or("tv-nearby-off")?;
    let link = open_link(&url).ok_or("tv-nearby-off")?;
    call(&app, "tvOpen", serde_json::json!({ "link": link })).await
}

#[tauri::command]
pub(crate) async fn tv_status(app: tauri::AppHandle) -> Result<TvStatus, String> {
    call(&app, "tvStatus", serde_json::json!({})).await
}

#[tauri::command]
pub(crate) async fn tv_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    call::<serde_json::Value>(&app, "tvDisconnect", serde_json::json!({}))
        .await
        .map(|_| ())
        .or_else(|code| {
            if code == "tv-unavailable" {
                Ok(())
            } else {
                Err(code)
            }
        })
}

/// Forgets this phone's TV key and every paired TV (TV-002).
#[tauri::command]
pub(crate) async fn tv_forget(app: tauri::AppHandle) -> Result<(), String> {
    call::<serde_json::Value>(&app, "tvForget", serde_json::json!({}))
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tv_opens_only_the_nearby_file_address() {
        assert_eq!(
            file_link("http://192.168.1.20:8080/482913").as_deref(),
            Some("http://192.168.1.20:8080/482913/GenX-Streamer.apk")
        );
        for refused in [
            "https://192.168.1.20:8080/482913",
            "http://8.8.8.8:8080/482913",
            "http://192.168.1.20:8080/48291",
            "http://192.168.1.20:8080/48291a",
            "http://192.168.1.20:99999/482913",
            "http://192.168.1.20/482913",
            "http://192.168.1.20:8080/482913/",
            "",
        ] {
            assert_eq!(file_link(refused), None, "{refused}");
        }
    }

    #[test]
    fn genx_on_the_tv_reports_back_to_the_nearby_share() {
        assert_eq!(
            open_link("http://192.168.1.20:8080/482913").as_deref(),
            Some("genx://open?reply=http://192.168.1.20:8080/482913/installed")
        );
        assert_eq!(open_link("http://8.8.8.8:8080/482913"), None);
    }

    #[test]
    fn only_tvs_on_this_network_are_contacted() {
        assert!(local_host("192.168.1.30").is_ok());
        assert!(local_host("10.0.0.4").is_ok());
        for refused in [
            "8.8.8.8",
            "localhost",
            "127.0.0.1",
            "fe80::1",
            "192.168.1.300",
            "",
        ] {
            assert_eq!(local_host(refused), Err("tv-address".into()), "{refused}");
        }
    }

    #[test]
    fn the_links_match_the_android_side() {
        let wire = include_str!("../../gen/android/app/src/main/java/com/tmg/tv/TvRemoteWire.kt");
        assert!(wire.contains(&format!("DOWNLOADER_STORE = \"{DOWNLOADER_STORE}\"")));
        assert!(wire.contains(&format!("OPEN_GENX = \"{OPEN_GENX}\"")));
    }
}
