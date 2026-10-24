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

//! genx:// on Windows, the way Tauri's deep-link and single-instance plugins
//! do it (their current releases need a newer Tauri than GenX pins):
//!
//! - The packaged GenX Streamer.exe registers genx:// for the current user
//!   (HKCU\Software\Classes\genx) to its own path at each start, so a moved
//!   portable copy still opens. Development and test runs (another file name,
//!   or an isolated TMG_DATA_DIR profile) never touch the registry.
//! - Windows starts GenX with the link as its argument. When a copy is already
//!   running, the new process hands the link to it (WM_COPYDATA to its hidden
//!   link inbox) and ends, so the shared storage keeps one owner. Without a
//!   running copy, the link waits for the interface (IncomingLinks).
use super::*;
use std::sync::OnceLock;
use tauri::{Emitter, Manager};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::DataExchange::COPYDATASTRUCT;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, CreateWindowExW, DefWindowProcW, DispatchMessageW, FindWindowExW,
    GetMessageW, RegisterClassW, SendMessageTimeoutW, TranslateMessage, ASFW_ANY, HWND_MESSAGE,
    MSG, SMTO_ABORTIFHUNG, WM_COPYDATA, WNDCLASSW,
};

/// Marks a WM_COPYDATA as a GenX link ("GENX").
const LINK_MESSAGE: usize = 0x4745_4e58;
/// The name a packaged build is copied to (scripts/build-windows.ps1).
const PACKAGED_NAME: &str = "GenX Streamer.exe";
const CLASSES: &str = r"Software\Classes\genx";

static INBOX_APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The first argument that is a GenX link (Windows passes it as "%1").
pub(crate) fn link_argument(arguments: impl IntoIterator<Item = String>) -> Option<String> {
    arguments
        .into_iter()
        .skip(1)
        .find_map(|arg| admit_link(&arg))
}

/// One inbox per data profile, so an isolated test profile never receives the
/// installed app's links (or the other way round).
pub(crate) fn inbox_class(profile: Option<&std::ffi::OsStr>) -> String {
    use sha2::{Digest, Sha256};
    match profile {
        None => "GenXStreamerLinkInbox".into(),
        Some(path) => {
            let digest = Sha256::digest(path.to_string_lossy().as_bytes());
            let short: String = digest[..6].iter().map(|b| format!("{b:02x}")).collect();
            format!("GenXStreamerLinkInbox-{short}")
        }
    }
}

fn profile() -> Option<std::ffi::OsString> {
    std::env::var_os("TMG_DATA_DIR")
}

/// The values that send genx:// to this exe: (subkey, value name, data).
pub(crate) fn scheme_values(root: &str, exe: &str) -> [(String, Option<&'static str>, String); 4] {
    [
        (root.to_string(), None, "URL:GenX Streamer link".into()),
        (root.to_string(), Some("URL Protocol"), String::new()),
        (format!(r"{root}\DefaultIcon"), None, format!("\"{exe}\",0")),
        (
            format!(r"{root}\shell\open\command"),
            None,
            format!("\"{exe}\" \"%1\""),
        ),
    ]
}

pub(crate) fn write_scheme(root: &str, exe: &str) -> Result<(), u32> {
    for (key, name, data) in scheme_values(root, exe) {
        let key = wide(&key);
        let name = name.map(wide);
        let data = wide(&data);
        let status = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ref().map_or(std::ptr::null(), |n| n.as_ptr()),
                REG_SZ,
                data.as_ptr().cast(),
                (data.len() * 2) as u32,
            )
        };
        if status != 0 {
            return Err(status);
        }
    }
    Ok(())
}

/// Registers genx:// for the packaged app only (see the module comment).
fn register_packaged() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let packaged = exe.file_name().and_then(|name| name.to_str()) == Some(PACKAGED_NAME);
    if !packaged || profile().is_some() {
        return;
    }
    if let Some(path) = exe.to_str() {
        // A refused write leaves links opening in the browser page; GenX still runs.
        let _ = write_scheme(CLASSES, path);
    }
}

/// Before GenX starts: hands a link argument to a running copy. True when the
/// running copy took it, and this process should end.
pub(crate) fn forward_to_running_copy() -> bool {
    let Some(link) = link_argument(std::env::args()) else {
        return false;
    };
    let class = wide(&inbox_class(profile().as_deref()));
    let inbox = unsafe {
        FindWindowExW(
            HWND_MESSAGE,
            std::ptr::null_mut(),
            class.as_ptr(),
            std::ptr::null(),
        )
    };
    if inbox.is_null() {
        return false;
    }
    let units: Vec<u16> = link.encode_utf16().collect();
    let data = COPYDATASTRUCT {
        dwData: LINK_MESSAGE,
        cbData: (units.len() * 2) as u32,
        lpData: units.as_ptr() as *mut _,
    };
    let mut answer = 0usize;
    unsafe {
        // The running copy may then come to the front.
        AllowSetForegroundWindow(ASFW_ANY);
        let sent = SendMessageTimeoutW(
            inbox,
            WM_COPYDATA,
            0,
            &data as *const COPYDATASTRUCT as LPARAM,
            SMTO_ABORTIFHUNG,
            5000,
            &mut answer,
        );
        sent != 0 && answer == 1
    }
}

/// A link that arrived (argument or inbox): kept for the interface, which is told.
fn deliver(app: &tauri::AppHandle, link: String) {
    if let Some(links) = app.try_state::<IncomingLinks>() {
        links.offer(link);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit(INCOMING_EVENT, ());
}

/// The link inside a WM_COPYDATA, if it is one of ours.
pub(crate) fn copied_link(kind: usize, units: &[u16]) -> Option<String> {
    if kind != LINK_MESSAGE || units.is_empty() || units.len() > MAX_LINK {
        return None;
    }
    String::from_utf16(units)
        .ok()
        .and_then(|text| admit_link(&text))
}

unsafe extern "system" fn inbox_procedure(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_COPYDATA && lparam != 0 {
        let data = unsafe { &*(lparam as *const COPYDATASTRUCT) };
        let count = data.cbData as usize / 2;
        if data.lpData.is_null() || data.cbData % 2 != 0 || count > MAX_LINK {
            return 0;
        }
        let units = unsafe { std::slice::from_raw_parts(data.lpData as *const u16, count) };
        return match (copied_link(data.dwData, units), INBOX_APP.get()) {
            (Some(link), Some(app)) => {
                deliver(app, link);
                1
            }
            _ => 0,
        };
    }
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

/// In setup: keeps the start-up link, registers genx:// and opens the inbox.
pub(crate) fn start(app: &tauri::AppHandle) {
    app.manage(IncomingLinks::default());
    if let Some(link) = link_argument(std::env::args()) {
        app.state::<IncomingLinks>().offer(link);
    }
    register_packaged();
    if INBOX_APP.set(app.clone()).is_err() {
        return;
    }
    let class = inbox_class(profile().as_deref());
    // The inbox has its own thread and message loop; it ends with the process.
    let _ = std::thread::Builder::new()
        .name("genx-link-inbox".into())
        .spawn(move || unsafe {
            let class = wide(&class);
            let instance = GetModuleHandleW(std::ptr::null());
            let description = WNDCLASSW {
                lpfnWndProc: Some(inbox_procedure),
                hInstance: instance,
                lpszClassName: class.as_ptr(),
                ..std::mem::zeroed()
            };
            if RegisterClassW(&description) == 0 {
                return;
            }
            let window = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            if window.is_null() {
                return;
            }
            let mut message: MSG = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        });
}
