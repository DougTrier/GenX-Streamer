// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0

pub(crate) fn main_webview_commands<R: tauri::Runtime>(
    dispatch: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        // An embedded station page belongs to the main window but is a separate webview.
        if invoke.message.webview_ref().label() != "main" {
            invoke.resolver.reject("native-command-origin-refused");
            return true;
        }
        dispatch(invoke)
    }
}
