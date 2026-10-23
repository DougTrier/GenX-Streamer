//! Native on-demand player (Android Media3) for Paid TV movies and episodes,
//! so embedded audio languages and subtitles can be chosen
//! (docs/native-vod-player.md). It only ever opens the loopback account relay:
//! never a provider address, so the sign-in stays in the relay.

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

const ACTIONS: [&str; 11] = [
    "open", "place", "play", "pause", "seek", "volume", "audio", "text", "status", "close",
    "replay",
];
/// Instant replay speeds (docs/instant-replay.md).
const REPLAY_RATES: [f64; 4] = [0.125, 0.25, 0.5, 1.0];
const WEEK_MS: u64 = 7 * 24 * 3_600_000;

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
    /// Window pixels of the picture; absent or zero size hides it.
    #[serde(default)]
    rect: Option<[i32; 4]>,
    #[serde(default)]
    position_ms: Option<u64>,
    #[serde(default)]
    volume: Option<f64>,
    #[serde(default)]
    track: Option<String>,
    /// The address is an HLS playlist (a live channel's loopback relay).
    #[serde(default)]
    hls: Option<bool>,
    /// Replay only: one of REPLAY_RATES.
    #[serde(default)]
    rate: Option<f64>,
    /// Replay only: a stream position (stays put while the live window slides).
    #[serde(default)]
    stream_ms: Option<u64>,
    /// Replay only: play (true) or pause (false).
    #[serde(default)]
    playing: Option<bool>,
}

/// `live` is the loopback relay GenX opened for a live channel, if any; an
/// HLS open may name exactly that address and nothing else.
pub(crate) fn validate(request: &Request, live: Option<&str>) -> Result<(), &'static str> {
    if !ACTIONS.contains(&request.action.as_str()) || request.session == 0 {
        return Err("native-video-invalid");
    }
    let admitted = match (request.url.as_deref(), request.hls == Some(true)) {
        (Some(url), false) => relay_url(url),
        (Some(url), true) => live.is_some_and(|live| live == url),
        (None, _) => false,
    };
    if request.action == "open" && !admitted {
        return Err("native-video-source-refused");
    }
    if request.action != "open" && (request.url.is_some() || request.hls.is_some()) {
        return Err("native-video-invalid");
    }
    if request
        .rect
        .is_some_and(|r| r.iter().any(|v| !(0..=16_384).contains(v)))
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
    let live = match tauri::Manager::try_state::<crate::native_live::NativeLive>(&app) {
        Some(live) if request.hls == Some(true) => live.current_url().await,
        _ => None,
    };
    validate(&request, live.as_deref())?;
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let player = app
            .try_state::<NativeVideo>()
            .ok_or("native-video-unavailable")?;
        let [left, top, width, height] = request.rect.unwrap_or([0, 0, 0, 0]);
        player
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                &request.action,
                serde_json::json!({
                    "session": request.session,
                    "url": request.url.unwrap_or_default(),
                    "left": left, "top": top, "width": width, "height": height,
                    "positionMs": request.position_ms.unwrap_or(0),
                    "volume": request.volume.unwrap_or(1.0),
                    "track": request.track.unwrap_or_default(),
                    "hls": request.hls.unwrap_or(false),
                    "rate": request.rate.unwrap_or(0.0),
                    "streamMs": request.stream_ms.map_or(-1, |p| p as i64),
                    "playing": request.playing.map_or(-1, i32::from),
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
    fn commands_and_values_are_bounded() {
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
                rect: Some([0, 0, 1920, 1080]),
                ..request("place")
            },
            None
        )
        .is_ok());
        assert!(validate(
            &Request {
                rect: Some([-1, 0, 10, 10]),
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
