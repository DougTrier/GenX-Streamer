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

//! A website's own player shown in GenX's viewing area. Android forwards
//! open/place/enter/video/page/hide/show/play/mute/status/close to
//! `WebPagePlugin`; Windows embeds a child webview in the main window.

#[cfg(target_os = "android")]
struct WebPage(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry, ()>::new("web-page")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                app.manage(WebPage(
                    api.register_android_plugin("com.tmg.tv", "WebPagePlugin")?,
                ));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

const ACTIONS: [&str; 13] = [
    "open", "place", "enter", "video", "page", "hide", "show", "play", "mute", "back", "forward",
    "status", "close",
];

#[tauri::command]
pub(crate) async fn web_page(
    action: String,
    url: Option<String>,
    rect: Option<[i32; 4]>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let url = url.unwrap_or_default();
    // Window pixels of the viewing area; absent means the whole window.
    let [left, top, width, height] = rect.unwrap_or([0, 0, 0, 0]);
    if [left, top, width, height]
        .iter()
        .any(|v| !(0..=16_384).contains(v))
    {
        return Err("web-page-invalid".into());
    }
    if !ACTIONS.contains(&action.as_str())
        || url.len() > 4096
        || (action == "open" && !url.starts_with("https://"))
    {
        return Err("web-page-invalid".into());
    }
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let page = app.try_state::<WebPage>().ok_or("web-page-unavailable")?;
        page.0
            .run_mobile_plugin_async::<serde_json::Value>(
                &action,
                serde_json::json!({ "url": url, "left": left, "top": top, "width": width, "height": height }),
            )
            .await
            .map_err(|_| "web-page-failed".into())
    }
    #[cfg(desktop)]
    {
        if action == "status" {
            return desktop::status(&app).await;
        }
        desktop::run(&app, &action, &url, [left, top, width, height])
    }
    #[cfg(not(any(target_os = "android", desktop)))]
    {
        let _ = (app, left, top, width, height);
        Err("web-page-unavailable".into())
    }
}

/// W15 on Windows: clears what pages left in GenX's shared WebView2 profile.
/// Called from setup, once the main window exists.
#[cfg(windows)]
pub(crate) fn forget_sites(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(main) = app.get_webview("main") {
        desktop::forget_sites(&main);
    }
}

/// Windows (and other desktops): the station's page is a child webview of the
/// main window over the viewing area. It is a remote origin, so GenX's
/// capability (local pages only) gives it no native commands; navigation stays
/// on https, popups and downloads are refused.
#[cfg(desktop)]
mod desktop {
    use std::sync::Mutex;
    use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewUrl};

    const LABEL: &str = "station-page";
    const FRAME_AGENT: &str = include_str!("../../page-scripts/frame-agent.js");
    const SHOW_VIDEO: &str = include_str!("../../page-scripts/show-video.js");
    const SHOW_PAGE: &str = include_str!("../../page-scripts/show-page.js");
    const HIDE_ADS: &str = include_str!("../../page-scripts/hide-ads.js");
    const NO_SITE_FULLSCREEN: &str = include_str!("../../page-scripts/no-site-fullscreen.js");
    const PAGE_GUARD: &str = include_str!("../../page-scripts/page-guard.js");

    /// The remote-command token of the open page.
    static TOKEN: Mutex<String> = Mutex::new(String::new());

    fn page(app: &tauri::AppHandle) -> Option<tauri::Webview> {
        app.get_webview(LABEL)
    }
    fn rect(webview: &tauri::Webview, [left, top, width, height]: [i32; 4]) -> Result<(), String> {
        if width <= 0 || height <= 0 {
            return Ok(());
        }
        webview
            .set_position(PhysicalPosition::new(left, top))
            .and_then(|_| webview.set_size(PhysicalSize::new(width as u32, height as u32)))
            .map_err(|_| "web-page-failed".into())
    }
    fn reply(key: &str, value: impl Into<serde_json::Value>) -> serde_json::Value {
        serde_json::json!({ "schemaVersion": 1, key: value.into() })
    }

    pub(super) fn run(
        app: &tauri::AppHandle,
        action: &str,
        url: &str,
        area: [i32; 4],
    ) -> Result<serde_json::Value, String> {
        match action {
            "open" => {
                if let Some(old) = page(app) {
                    let _ = old.close();
                }
                let window = app.get_window("main").ok_or("web-page-unavailable")?;
                let target = reqwest::Url::parse(url).map_err(|_| "web-page-invalid")?;
                let token = token()?;
                *TOKEN.lock().map_err(|_| "web-page-failed")? = token.clone();
                let builder =
                    tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(target))
                        .initialization_script_for_all_frames(
                            FRAME_AGENT.replace("__GENX_TOKEN__", &token),
                        )
                        .initialization_script_for_all_frames(NO_SITE_FULLSCREEN)
                        .initialization_script_for_all_frames(PAGE_GUARD)
                        .initialization_script(format!(
                            "addEventListener('DOMContentLoaded', () => {{ {HIDE_ADS} }});"
                        ))
                        .on_navigation(|next| next.scheme() == "https")
                        // A link meant for a new window ("Watch On Demand") opens in
                        // the station page itself, as on Android; never a new window.
                        .on_new_window({
                            let app = app.clone();
                            move |next, _| {
                                if next.scheme() == "https" {
                                    let app = app.clone();
                                    tauri::async_runtime::spawn(async move {
                                        if let Some(webview) = app.get_webview(LABEL) {
                                            let _ = webview.navigate(next);
                                        }
                                    });
                                }
                                tauri::webview::NewWindowResponse::Deny
                            }
                        })
                        .on_download(|_, _| false)
                        // W15: pages run InPrivate and leave nothing on disk.
                        .incognito(true);
                let [left, top, width, height] = area;
                let (size, position) = if width > 0 && height > 0 {
                    (
                        PhysicalSize::new(width as u32, height as u32),
                        PhysicalPosition::new(left, top),
                    )
                } else {
                    (
                        window.inner_size().map_err(|_| "web-page-failed")?,
                        PhysicalPosition::new(0, 0),
                    )
                };
                let webview = window
                    .add_child(builder, position, size)
                    .map_err(|_| "web-page-failed")?;
                #[cfg(windows)]
                harden(&webview);
                let _ = webview.set_focus();
                Ok(reply("opened", true))
            }
            "place" => {
                if let Some(webview) = page(app) {
                    rect(&webview, area)?;
                }
                Ok(reply("placed", page(app).is_some()))
            }
            "enter" => {
                if let Some(webview) = page(app) {
                    let _ = webview.set_focus();
                }
                Ok(reply("entered", page(app).is_some()))
            }
            "video" | "page" => {
                if let Some(webview) = page(app) {
                    webview
                        .eval(if action == "video" {
                            SHOW_VIDEO
                        } else {
                            SHOW_PAGE
                        })
                        .map_err(|_| "web-page-failed")?;
                }
                Ok(reply("videoOnly", action == "video"))
            }
            "play" | "mute" => {
                let token = TOKEN.lock().map_err(|_| "web-page-failed")?.clone();
                if let Some(webview) = page(app) {
                    webview
                        .eval(format!(
                            "window.postMessage({{genxRemote:'{token}',cmd:'{action}'}},'*')"
                        ))
                        .map_err(|_| "web-page-failed")?;
                }
                Ok(reply("sent", page(app).is_some()))
            }
            "back" | "forward" => {
                if let Some(webview) = page(app) {
                    webview
                        .eval(if action == "back" {
                            "history.back()"
                        } else {
                            "history.forward()"
                        })
                        .map_err(|_| "web-page-failed")?;
                }
                Ok(reply("moved", page(app).is_some()))
            }
            "hide" | "show" => {
                if let Some(webview) = page(app) {
                    let _ = if action == "hide" {
                        webview.hide()
                    } else {
                        webview.show()
                    };
                }
                Ok(reply("shown", action == "show"))
            }
            "close" => {
                if let Some(webview) = page(app) {
                    let _ = webview.close();
                }
                Ok(reply("closed", true))
            }
            _ => Err("web-page-invalid".into()),
        }
    }

    const AD_HOSTS: &str = include_str!("../../page-scripts/ad-hosts.txt");

    /// A host on the ad/tracker list, or a subdomain of one.
    pub(super) fn ad_host(host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        AD_HOSTS
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .any(|blocked| host == blocked || host.ends_with(&format!(".{blocked}")))
    }

    /// W15: website data does not build up on the PC. Pages run InPrivate;
    /// this clears what pages from earlier versions left in GenX's shared
    /// profile (HTTP cache, cookies, service workers and their caches) each
    /// start. GenX's own saved data (local storage, IndexedDB) is untouched.
    #[cfg(windows)]
    pub(crate) fn forget_sites(main: &tauri::Webview) {
        let _ = main.with_webview(|platform| unsafe {
            use webview2_com::ClearBrowsingDataCompletedHandler;
            use webview2_com::Microsoft::Web::WebView2::Win32::*;
            use windows::core::Interface;
            let Ok(core) = platform.controller().CoreWebView2() else {
                return;
            };
            let Ok(profile) = core.cast::<ICoreWebView2_13>().and_then(|c| c.Profile()) else {
                return;
            };
            let Ok(profile) = profile.cast::<ICoreWebView2Profile2>() else {
                return;
            };
            let kinds = COREWEBVIEW2_BROWSING_DATA_KINDS(
                COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE.0
                    | COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES.0
                    | COREWEBVIEW2_BROWSING_DATA_KINDS_SERVICE_WORKERS.0
                    | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE.0,
            );
            let _ = profile.ClearBrowsingData(
                kinds,
                &ClearBrowsingDataCompletedHandler::create(Box::new(|_| Ok(()))),
            );
        });
    }

    /// Engine-level rules for a hostile page (docs/web-viewer-invariants.md):
    /// no script dialogs (W04), every permission denied (W05), no context
    /// menu, dev tools, browser shortcuts or password/autofill capture (W06),
    /// ad and tracker hosts refused on the network (W11).
    #[cfg(windows)]
    fn harden(webview: &tauri::Webview) {
        let _ = webview.with_webview(|platform| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::*;
            use webview2_com::{
                take_pwstr, PermissionRequestedEventHandler, ScriptDialogOpeningEventHandler,
                WebResourceRequestedEventHandler,
            };
            use windows::core::{Interface, HSTRING, PWSTR};
            let Ok(core) = platform.controller().CoreWebView2() else {
                return;
            };
            if let Ok(settings) = core.Settings() {
                let _ = settings.SetAreDefaultScriptDialogsEnabled(false);
                let _ = settings.SetAreDefaultContextMenusEnabled(false);
                let _ = settings.SetAreDevToolsEnabled(false);
                let _ = settings.SetIsStatusBarEnabled(false);
                if let Ok(more) = settings.cast::<ICoreWebView2Settings3>() {
                    let _ = more.SetAreBrowserAcceleratorKeysEnabled(false);
                }
                if let Ok(more) = settings.cast::<ICoreWebView2Settings4>() {
                    let _ = more.SetIsPasswordAutosaveEnabled(false);
                    let _ = more.SetIsGeneralAutofillEnabled(false);
                }
            }
            let mut token = 0i64;
            // Dialogs never show; "Leave site?" is accepted so a page can't
            // hold the viewer, everything else is dismissed.
            let _ = core.add_ScriptDialogOpening(
                &ScriptDialogOpeningEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_SCRIPT_DIALOG_KIND::default();
                    args.Kind(&mut kind)?;
                    if kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD {
                        args.Accept()?;
                    }
                    Ok(())
                })),
                &mut token,
            );
            let _ = core.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    }
                    Ok(())
                })),
                &mut token,
            );
            let environment = platform.environment();
            if core
                .AddWebResourceRequestedFilter(
                    &HSTRING::from("*"),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                )
                .is_ok()
            {
                let _ = core.add_WebResourceRequested(
                    &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let uri = {
                            let mut uri = PWSTR::null();
                            args.Request()?.Uri(&mut uri)?;
                            take_pwstr(uri)
                        };
                        let blocked = reqwest::Url::parse(&uri)
                            .ok()
                            .and_then(|u| u.host_str().map(ad_host))
                            .unwrap_or(false);
                        if blocked {
                            let response = environment.CreateWebResourceResponse(
                                None,
                                204,
                                &HSTRING::from("No Content"),
                                &HSTRING::new(),
                            )?;
                            args.SetResponse(&response)?;
                        }
                        Ok(())
                    })),
                    &mut token,
                );
            }
        });
    }

    /// The open page's address and title (for saving it as a website).
    pub(super) async fn status(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
        let Some(webview) = page(app) else {
            return Ok(serde_json::json!({ "schemaVersion": 1, "open": false }));
        };
        let url = webview
            .url()
            .map(|u| u.as_str().chars().take(2048).collect::<String>())
            .unwrap_or_default();
        let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
        let sender = Mutex::new(Some(sender));
        let _ = webview.eval_with_callback("document.title", move |value| {
            if let Some(sender) = sender.lock().ok().and_then(|mut s| s.take()) {
                let _ = sender.send(value);
            }
        });
        let title = tokio::time::timeout(std::time::Duration::from_secs(2), receiver)
            .await
            .ok()
            .and_then(Result::ok)
            .and_then(|raw| serde_json::from_str::<String>(&raw).ok())
            .map(|t| {
                t.chars()
                    .filter(|c| !c.is_control())
                    .take(160)
                    .collect::<String>()
            })
            .unwrap_or_default();
        Ok(serde_json::json!({ "schemaVersion": 1, "open": true, "url": url, "title": title }))
    }

    /// A per-page token so a page cannot forge GenX's remote commands.
    fn token() -> Result<String, String> {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| "web-page-failed")?;
        Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
    }
}

#[cfg(all(test, desktop))]
mod tests {
    use super::desktop::ad_host;

    #[test]
    fn ad_hosts_match_whole_names_and_subdomains_only() {
        assert!(ad_host("doubleclick.net"));
        assert!(ad_host("pubads.g.doubleclick.net"));
        assert!(ad_host("SECURE.TABOOLA.COM"));
        assert!(!ad_host("notdoubleclick.net"));
        assert!(!ad_host("doubleclick.net.example.com"));
        assert!(!ad_host("www.wtvp.org"));
    }
}
