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

//! Windows' own share sheet (Nearby Sharing, mail, messaging apps), opened for
//! GenX's window through IDataTransferManagerInterop, the way desktop browsers
//! offer navigator.share. It runs on the window's thread; the app file is
//! looked up first on a worker thread, since the lookup may wait.
use super::*;
use std::cell::RefCell;
use std::path::PathBuf;
use windows::core::{factory, AgileReference, Interface, HSTRING};
use windows::ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager};
use windows::Foundation::{TypedEventHandler, Uri};
use windows::Storage::{IStorageItem, StorageFile};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Shell::IDataTransferManagerInterop;
use windows_collections::IIterable;

pub(super) enum Payload {
    Text {
        title: String,
        text: String,
    },
    File {
        title: String,
        text: String,
        exe: PathBuf,
    },
}

thread_local! {
    /// The window's share source and its handler, replaced by each share.
    static SOURCE: RefCell<Option<(DataTransferManager, i64)>> = const { RefCell::new(None) };
}

/// The first web address in a message, offered as the shared link as well.
pub(crate) fn first_link(text: &str) -> Option<&str> {
    text.split_whitespace()
        .find(|word| word.starts_with("https://") || word.starts_with("genx://"))
}

fn show(
    hwnd: HWND,
    title: HSTRING,
    text: HSTRING,
    link: Option<HSTRING>,
    file: Option<AgileReference<StorageFile>>,
) -> windows::core::Result<()> {
    let interop = factory::<DataTransferManager, IDataTransferManagerInterop>()?;
    let manager: DataTransferManager = unsafe { interop.GetForWindow(hwnd)? };
    SOURCE.with(|source| {
        if let Some((old, token)) = source.borrow_mut().take() {
            let _ = old.RemoveDataRequested(token);
        }
    });
    let handler =
        TypedEventHandler::<DataTransferManager, DataRequestedEventArgs>::new(move |_, args| {
            let data = args.ok()?.Request()?.Data()?;
            data.Properties()?.SetTitle(&title)?;
            data.SetText(&text)?;
            if let Some(link) = &link {
                if let Ok(uri) = Uri::CreateUri(link) {
                    data.SetWebLink(&uri)?;
                }
            }
            if let Some(file) = &file {
                let item: IStorageItem = file.resolve()?.cast()?;
                data.SetStorageItemsReadOnly(&IIterable::<IStorageItem>::from(vec![Some(item)]))?;
            }
            Ok(())
        });
    let token = manager.DataRequested(&handler)?;
    SOURCE.with(|source| *source.borrow_mut() = Some((manager, token)));
    unsafe { interop.ShowShareUIForWindow(hwnd) }
}

fn agile_file(exe: PathBuf) -> Result<AgileReference<StorageFile>, String> {
    let path = HSTRING::from(exe.as_os_str());
    StorageFile::GetFileFromPathAsync(&path)
        .and_then(|operation| operation.get())
        .and_then(|file| AgileReference::new(&file))
        .map_err(|_| "share-app-unavailable".to_string())
}

pub(super) async fn share(app: tauri::AppHandle, payload: Payload) -> Result<ShareReceipt, String> {
    use tauri::Manager;
    let window = app.get_webview_window("main").ok_or("share-unavailable")?;
    let raw = window.hwnd().map_err(|_| "share-unavailable")?.0;
    let hwnd = raw as usize;
    let (title, text, file) = match payload {
        Payload::Text { title, text } => (title, text, None),
        Payload::File { title, text, exe } => {
            let file = tauri::async_runtime::spawn_blocking(move || agile_file(exe))
                .await
                .map_err(|_| "share-app-unavailable".to_string())??;
            (title, text, Some(file))
        }
    };
    let (done, shown) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let link = first_link(&text).map(HSTRING::from);
        let result = show(
            HWND(hwnd as *mut core::ffi::c_void),
            HSTRING::from(title),
            HSTRING::from(text),
            link,
            file,
        );
        let _ = done.send(result.is_ok());
    })
    .map_err(|_| "share-unavailable".to_string())?;
    match shown.await {
        Ok(true) => Ok(ShareReceipt { shown: true }),
        _ => Err("share-unavailable".into()),
    }
}
