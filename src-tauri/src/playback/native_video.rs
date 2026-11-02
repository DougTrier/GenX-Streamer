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

//! Native on-demand player (Android Media3) for Paid TV movies and episodes,
//! so embedded audio languages and subtitles can be chosen
//! (docs/native-vod-player.md). It opens local account/Archive/live proxies,
//! never provider addresses. Archive and Paid-live opens require exact active grants.

#[cfg(target_os = "android")]
struct NativeVideo(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry, ()>::new("native-video")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                app.manage(NativeVideo(
                    api.register_android_plugin("com.tmg.tv", "NativeVideoPlugin")?,
                ));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

const ACTIONS: [&str; 12] = [
    "open", "place", "play", "pause", "seek", "volume", "audio", "text", "status", "close",
    "replay", "buffer",
];
/// Instant replay speeds (docs/instant-replay.md).
const REPLAY_RATES: [f64; 4] = [0.125, 0.25, 0.5, 1.0];
const WEEK_MS: u64 = 7 * 24 * 3_600_000;

#[derive(serde::Deserialize, Debug)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
enum BufferPreference {
    Auto {},
    Manual {
        #[serde(rename = "targetSeconds")]
        target_seconds: u8,
    },
}

impl BufferPreference {
    fn valid(&self) -> bool {
        match self {
            Self::Auto {} => true,
            Self::Manual { target_seconds } => (1..=20).contains(target_seconds),
        }
    }
    #[cfg(target_os = "android")]
    fn mode(&self) -> &'static str {
        match self {
            Self::Auto {} => "auto",
            Self::Manual { .. } => "manual",
        }
    }
    #[cfg(target_os = "android")]
    fn target_seconds(&self) -> u8 {
        match self {
            Self::Auto {} => 0,
            Self::Manual { target_seconds } => *target_seconds,
        }
    }
}

/// The account relay's media capability on this device, and nothing else.
fn relay_url(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    let hex = |v: &str| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit());
    let segments: Vec<&str> = url.path_segments().map(|s| s.collect()).unwrap_or_default();
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && segments.len() == 4
        && segments[0] == "account"
        && hex(segments[1])
        && segments[2] == "media"
        && hex(segments[3])
}
/// A track identity from Media3 ("group:index"); empty means "off" for text.
fn track_id(raw: &str) -> bool {
    raw.len() <= 64
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-' | b'.'))
}

#[derive(serde::Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    action: String,
    session: u64,
    #[serde(default)]
    url: Option<String>,
    /// CSS pixels with viewport; legacy view pixels otherwise. Zero size hides it.
    #[serde(default)]
    rect: Option<[f64; 4]>,
    #[serde(default)]
    viewport: Option<[i32; 2]>,
    #[serde(default)]
    position_ms: Option<u64>,
    #[serde(default)]
    volume: Option<f64>,
    #[serde(default)]
    track: Option<String>,
    /// The address is an HLS playlist (a live channel's loopback relay).
    #[serde(default)]
    hls: Option<bool>,
    #[serde(default)]
    archive: Option<bool>,
    #[serde(default)]
    account_live: Option<bool>,
    #[serde(default)]
    public_live: Option<bool>,
    /// Replay only: one of REPLAY_RATES.
    #[serde(default)]
    rate: Option<f64>,
    /// Replay only: a stream position (stays put while the live window slides).
    #[serde(default)]
    stream_ms: Option<u64>,
    /// Replay only: play (true) or pause (false).
    #[serde(default)]
    playing: Option<bool>,
    #[serde(default)]
    live_buffer: Option<BufferPreference>,
}

/// `live` is the exact current live/Archive proxy grant. Either flagged open
/// must match it; it never admits arbitrary loopback addresses or expired URLs.
pub(crate) fn validate(request: &Request, live: Option<&str>) -> Result<(), &'static str> {
    if !ACTIONS.contains(&request.action.as_str()) || request.session == 0 {
        return Err("native-video-invalid");
    }
    if (request.action == "buffer" && request.live_buffer.is_none())
        || request
            .live_buffer
            .as_ref()
            .is_some_and(|policy| !policy.valid())
        || (request.live_buffer.is_some() && !matches!(request.action.as_str(), "open" | "buffer"))
    {
        return Err("native-video-invalid");
    }
    if request.action == "buffer"
        && (request.rect.is_some()
            || request.viewport.is_some()
            || request.position_ms.is_some()
            || request.volume.is_some()
            || request.track.is_some())
    {
        return Err("native-video-invalid");
    }
    if request.archive == Some(true)
        && (request.hls == Some(true)
            || request.account_live == Some(true)
            || request.public_live == Some(true))
    {
        return Err("native-video-invalid");
    }
    if request.public_live == Some(true) && request.account_live == Some(true) {
        return Err("native-video-invalid");
    }
    let admitted = if request.public_live == Some(true) {
        request.url.as_deref().is_some_and(|url| live == Some(url))
    } else if request.account_live == Some(true) {
        request
            .url
            .as_deref()
            .is_some_and(|url| relay_url(url) && live == Some(url))
    } else {
        match (
            request.url.as_deref(),
            request.hls == Some(true) || request.archive == Some(true),
        ) {
            (Some(url), false) => relay_url(url),
            (Some(url), true) => live.is_some_and(|live| live == url),
            (None, _) => false,
        }
    };
    if request.action == "open" && !admitted {
        return Err("native-video-source-refused");
    }
    if request.action != "open"
        && (request.url.is_some()
            || request.hls.is_some()
            || request.archive.is_some()
            || request.account_live.is_some()
            || request.public_live.is_some())
    {
        return Err("native-video-invalid");
    }
    if request.rect.is_some_and(|r| {
        r.iter()
            .any(|v| !v.is_finite() || !(0.0..=16_384.0).contains(v))
    }) || request
        .viewport
        .is_some_and(|v| v.iter().any(|n| !(1..=16_384).contains(n)))
        || request.position_ms.is_some_and(|p| p > WEEK_MS)
        || request
            .volume
            .is_some_and(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
        || request.track.as_deref().is_some_and(|t| !track_id(t))
    {
        return Err("native-video-invalid");
    }
    let replay_fields =
        request.rate.is_some() || request.stream_ms.is_some() || request.playing.is_some();
    if (request.action == "replay") != replay_fields
        || request.rate.is_some_and(|r| !REPLAY_RATES.contains(&r))
        || request.stream_ms.is_some_and(|p| p > WEEK_MS)
    {
        return Err("native-video-invalid");
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_video(
    request: Request,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let live = if request.account_live == Some(true) {
        crate::account_playback_owner::native_live_url().await
    } else if request.archive == Some(true) {
        crate::archive_playback_owner::native_media_url().await
    } else {
        match tauri::Manager::try_state::<crate::native_live::NativeLive>(&app) {
            Some(live) if request.hls == Some(true) || request.public_live == Some(true) => {
                live.current_url().await
            }
            _ => None,
        }
    };
    validate(&request, live.as_deref())?;
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let player = app
            .try_state::<NativeVideo>()
            .ok_or("native-video-unavailable")?;
        let [left, top, width, height] = request.rect.unwrap_or([0.0, 0.0, 0.0, 0.0]);
        let [viewport_width, viewport_height] = request.viewport.unwrap_or([0, 0]);
        player
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                &request.action,
                serde_json::json!({
                    "session": request.session,
                    "url": request.url.unwrap_or_default(),
                    "left": left, "top": top, "width": width, "height": height,
                    "viewportWidth": viewport_width, "viewportHeight": viewport_height,
                    "positionMs": request.position_ms.unwrap_or(0),
                    "volume": request.volume.unwrap_or(1.0),
                    "track": request.track.unwrap_or_default(),
                    "hls": request.hls.unwrap_or(false),
                    "archive": request.archive.unwrap_or(false),
                    "accountLive": request.account_live.unwrap_or(false),
                    "publicLive": request.public_live.unwrap_or(false),
                    "rate": request.rate.unwrap_or(0.0),
                    "streamMs": request.stream_ms.map_or(-1, |p| p as i64),
                    "playing": request.playing.map_or(-1, i32::from),
                    "bufferMode": request.live_buffer.as_ref().map_or("", BufferPreference::mode),
                    "bufferTargetSeconds": request.live_buffer.as_ref().map_or(0, BufferPreference::target_seconds),
                }),
            )
            .await
            .map_err(|_| "native-video-failed".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("native-video-unavailable".into())
    }
}

/// Numeric, read-only geometry/decoder facts; no page or provider addresses.
pub(crate) async fn playback_diagnostics(app: &tauri::AppHandle) -> Option<serde_json::Value> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.try_state::<NativeVideo>()?
            .0
            .run_mobile_plugin_async::<serde_json::Value>("diagnostics", serde_json::json!({}))
            .await
            .ok()
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        None
    }
}

pub(crate) async fn export_playback_diagnostics(
    app: &tauri::AppHandle,
    report: String,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.try_state::<NativeVideo>()
            .ok_or("playback-trace-unavailable")?
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "exportDiagnostics",
                serde_json::json!({"report":report}),
            )
            .await
            .map_err(|_| "playback-trace-export".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, report);
        Err("playback-trace-export-unsupported".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(action: &str) -> Request {
        Request {
            action: action.into(),
            session: 1,
            ..Default::default()
        }
    }
    const RELAY: &str = "http://127.0.0.1:41234/account/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    #[test]
    fn paid_live_decoder_requires_the_current_account_proxy_for_both_formats() {
        for hls in [true, false] {
            let command = Request {
                url: Some(RELAY.into()),
                account_live: Some(true),
                hls: Some(hls),
                ..request("open")
            };
            assert!(validate(&command, Some(RELAY)).is_ok());
            assert!(validate(&command, None).is_err());
            assert!(validate(&command, Some(&format!("{RELAY}other"))).is_err());
            assert!(validate(
                &Request {
                    archive: Some(true),
                    ..command
                },
                Some(RELAY)
            )
            .is_err());
        }
        let remote = "https://provider.invalid/channel.m3u8";
        assert!(validate(
            &Request {
                url: Some(remote.into()),
                account_live: Some(true),
                ..request("open")
            },
            Some(remote)
        )
        .is_err());
    }
    #[test]
    fn archive_decoder_requires_the_exact_current_proxy_grant() {
        let url = format!(
            "http://127.0.0.1:41234/archive/{}/{}.mp4",
            "a".repeat(64),
            "b".repeat(64)
        );
        let command = Request {
            url: Some(url.clone()),
            archive: Some(true),
            ..request("open")
        };
        assert!(validate(&command, Some(&url)).is_ok());
        assert!(validate(&command, None).is_err()); // absent/expired/revoked owner
        assert!(validate(&command, Some(&format!("{url}?other"))).is_err());
        assert!(validate(
            &Request {
                hls: Some(true),
                ..command
            },
            Some(&url)
        )
        .is_err());
        assert!(validate(
            &Request {
                archive: Some(true),
                ..request("play")
            },
            Some(&url)
        )
        .is_err());
        assert!(validate(
            &Request {
                url: Some(url),
                ..request("open")
            },
            None
        )
        .is_err());
    }
    #[test]
    fn only_the_loopback_account_relay_can_be_opened() {
        let open = |url: &str| {
            validate(
                &Request {
                    url: Some(url.into()),
                    ..request("open")
                },
                None,
            )
        };
        assert!(open(RELAY).is_ok());
        for refused in [
            // A provider address (with the sign-in in its path) is never accepted.
            "http://provider.invalid:8080/movie/user/pass/1.mkv",
            "https://127.0.0.1:41234/account/aa/media/bb",
            "http://localhost:41234/account/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "http://127.0.0.1/account/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            &format!("{RELAY}?x=1"),
            &format!("{RELAY}/extra"),
            "http://u:p@127.0.0.1:41234/account/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "file:///sdcard/movie.mkv",
        ] {
            assert_eq!(open(refused), Err("native-video-source-refused"), "{refused}");
        }
        assert_eq!(
            validate(&request("open"), None),
            Err("native-video-source-refused")
        );
    }
    #[test]
    fn replay_takes_only_its_own_bounded_fields() {
        let replay = |rate: Option<f64>, stream_ms: Option<u64>, playing: Option<bool>| {
            validate(
                &Request {
                    rate,
                    stream_ms,
                    playing,
                    ..request("replay")
                },
                None,
            )
        };
        assert!(replay(Some(0.25), None, None).is_ok());
        assert!(replay(None, Some(12_345), None).is_ok());
        assert!(replay(None, None, Some(false)).is_ok());
        assert!(replay(Some(1.0), Some(0), Some(true)).is_ok());
        // Nothing to do, an unknown speed, or a position beyond a week.
        for refused in [
            replay(None, None, None),
            replay(Some(2.0), None, None),
            replay(Some(0.3), None, None),
            replay(Some(f64::NAN), None, None),
            replay(None, Some(WEEK_MS + 1), None),
        ] {
            assert_eq!(refused, Err("native-video-invalid"));
        }
        // Other commands never carry replay fields.
        assert_eq!(
            validate(
                &Request {
                    rate: Some(0.25),
                    ..request("play")
                },
                None
            ),
            Err("native-video-invalid")
        );
    }
    #[test]
    fn runtime_buffer_policy_is_bounded_and_has_no_other_command_fields() {
        let decode = |value: serde_json::Value| serde_json::from_value::<Request>(value);
        for policy in [
            serde_json::json!({"mode":"auto"}),
            serde_json::json!({"mode":"manual","targetSeconds":1}),
            serde_json::json!({"mode":"manual","targetSeconds":20}),
        ] {
            let command =
                decode(serde_json::json!({"action":"buffer","session":1,"liveBuffer":policy}))
                    .unwrap();
            assert!(validate(&command, None).is_ok());
        }
        for policy in [
            serde_json::json!({"mode":"manual","targetSeconds":0}),
            serde_json::json!({"mode":"manual","targetSeconds":21}),
        ] {
            let command =
                decode(serde_json::json!({"action":"buffer","session":1,"liveBuffer":policy}))
                    .unwrap();
            assert_eq!(validate(&command, None), Err("native-video-invalid"));
        }
        for value in [
            serde_json::json!({"mode":"manual","targetSeconds":1.5}),
            serde_json::json!({"mode":"manual","targetSeconds":-1}),
            serde_json::json!({"mode":"manual","targetSeconds":999}),
            serde_json::json!({"mode":"auto","targetSeconds":4}),
            serde_json::json!({"mode":"other"}),
            serde_json::json!({"mode":"manual","targetSeconds":4,"url":"https://private.invalid"}),
        ] {
            assert!(
                decode(serde_json::json!({"action":"buffer","session":1,"liveBuffer":value}))
                    .is_err()
            );
        }
        assert_eq!(
            validate(&request("buffer"), None),
            Err("native-video-invalid")
        );
        for extra in [
            serde_json::json!({"volume":0.5}),
            serde_json::json!({"positionMs":20}),
            serde_json::json!({"rect":[0,0,10,10]}),
            serde_json::json!({"track":"1:0"}),
            serde_json::json!({"url":RELAY}),
        ] {
            let mut command = serde_json::json!({"action":"buffer","session":1,"liveBuffer":{"mode":"manual","targetSeconds":4}});
            command
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert_eq!(
                validate(&decode(command).unwrap(), None),
                Err("native-video-invalid")
            );
        }
    }

    #[test]
    fn saved_buffer_target_never_bypasses_open_grant_or_session_rules() {
        let command = |action: &str, session: u64| {
            serde_json::from_value::<Request>(serde_json::json!({"action":action,"session":session,"liveBuffer":{"mode":"manual","targetSeconds":8}})).unwrap()
        };
        assert_eq!(
            validate(&command("buffer", 0), None),
            Err("native-video-invalid")
        );
        assert_eq!(
            validate(&command("play", 1), None),
            Err("native-video-invalid")
        );
        let open = Request {
            url: Some(RELAY.into()),
            account_live: Some(true),
            ..command("open", 1)
        };
        assert_eq!(validate(&open, None), Err("native-video-source-refused"));
        assert!(validate(&open, Some(RELAY)).is_ok());
    }

    #[test]
    fn commands_and_values_are_bounded() {
        for viewport in [[0, 1080], [1920, -1], [16_385, 1080]] {
            assert!(validate(
                &Request {
                    viewport: Some(viewport),
                    ..request("place")
                },
                None
            )
            .is_err());
        }
        assert!(validate(
            &Request {
                rect: Some([784.0, 257.5, 1088.0, 612.0]),
                viewport: Some([1920, 1080]),
                ..request("place")
            },
            None
        )
        .is_ok());
        assert!(validate(
            &Request {
                rect: Some([f64::NAN, 0.0, 10.0, 10.0]),
                ..request("place")
            },
            None
        )
        .is_err());
        assert!(validate(&request("status"), None).is_ok());
        assert_eq!(
            validate(&request("eval"), None),
            Err("native-video-invalid")
        );
        assert_eq!(
            validate(
                &Request {
                    session: 0,
                    ..request("status")
                },
                None
            ),
            Err("native-video-invalid")
        );
        // Only "open" carries an address.
        assert_eq!(
            validate(
                &Request {
                    url: Some(RELAY.into()),
                    ..request("play")
                },
                None
            ),
            Err("native-video-invalid")
        );
        assert!(validate(
            &Request {
                rect: Some([0.0, 0.0, 1920.0, 1080.0]),
                ..request("place")
            },
            None
        )
        .is_ok());
        assert!(validate(
            &Request {
                rect: Some([-1.0, 0.0, 10.0, 10.0]),
                ..request("place")
            },
            None
        )
        .is_err());
        assert!(validate(
            &Request {
                volume: Some(0.5),
                ..request("volume")
            },
            None
        )
        .is_ok());
        assert!(validate(
            &Request {
                volume: Some(1.5),
                ..request("volume")
            },
            None
        )
        .is_err());
        assert!(validate(
            &Request {
                volume: Some(f64::NAN),
                ..request("volume")
            },
            None
        )
        .is_err());
        assert!(validate(
            &Request {
                position_ms: Some(WEEK_MS + 1),
                ..request("seek")
            },
            None
        )
        .is_err());
        assert!(validate(
            &Request {
                track: Some("2:0".into()),
                ..request("audio")
            },
            None
        )
        .is_ok());
        assert!(validate(
            &Request {
                track: Some(String::new()),
                ..request("text")
            },
            None
        )
        .is_ok());
        assert!(validate(
            &Request {
                track: Some("<script>".into()),
                ..request("text")
            },
            None
        )
        .is_err());
    }
    #[test]
    fn public_progressive_requires_the_exact_active_live_grant() {
        let mut r = Request {
            public_live: Some(true),
            hls: Some(false),
            url: Some(RELAY.into()),
            ..request("open")
        };
        assert!(validate(&r, Some(RELAY)).is_ok());
        assert!(validate(&r, None).is_err());
        assert!(validate(&r, Some("http://127.0.0.1:1234/other")).is_err());
        r.account_live = Some(true);
        assert!(validate(&r, Some(RELAY)).is_err());
        r.account_live = None;
        r.archive = Some(true);
        assert!(validate(&r, Some(RELAY)).is_err());
        r.archive = None;
        r.action = "play".into();
        assert!(validate(&r, Some(RELAY)).is_err());
    }
    #[test]
    fn a_live_channel_opens_only_the_relay_genx_opened_for_it() {
        const LIVE: &str = "http://127.0.0.1:41000/media/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        let open = |url: &str, hls: bool, live: Option<&str>| {
            validate(
                &Request {
                    url: Some(url.into()),
                    hls: Some(hls),
                    ..request("open")
                },
                live,
            )
        };
        assert!(open(LIVE, true, Some(LIVE)).is_ok());
        // Not without the open relay, not another address, not as a movie.
        assert!(open(LIVE, true, None).is_err());
        assert!(open("http://127.0.0.1:41000/media/dd", true, Some(LIVE)).is_err());
        assert!(open(
            "http://23.239.31.26:8989/accnetwork/index.m3u8",
            true,
            Some(LIVE)
        )
        .is_err());
        assert!(open(LIVE, false, Some(LIVE)).is_err());
        // The movie relay stays as it was.
        assert!(open(RELAY, false, Some(LIVE)).is_ok());
        assert!(open(RELAY, true, Some(LIVE)).is_err());
        assert_eq!(
            validate(
                &Request {
                    hls: Some(true),
                    ..request("play")
                },
                Some(LIVE)
            ),
            Err("native-video-invalid")
        );
    }
}
