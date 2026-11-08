// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0

#[path = "../src/native_command_boundary.rs"]
mod native_command_boundary;

use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY},
    webview::InvokeRequest,
    WebviewWindowBuilder,
};

#[tauri::command]
fn security_probe() -> &'static str {
    "local-only"
}

#[test]
fn commands_reject_station_webviews_and_remote_origins() {
    let app = mock_builder()
        .invoke_handler(native_command_boundary::main_webview_commands(
            tauri::generate_handler![security_probe],
        ))
        .build(mock_context(noop_assets()))
        .unwrap();
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let station = WebviewWindowBuilder::new(&app, "station-page", Default::default())
        .build()
        .unwrap();
    let request = |url: &str| InvokeRequest {
        cmd: "security_probe".into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: url.parse().unwrap(),
        body: InvokeBody::default(),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.into(),
    };
    let local = "http://tauri.localhost/";
    let receipt = get_ipc_response(&main, request(local)).unwrap();
    assert_eq!(receipt.deserialize::<String>().unwrap(), "local-only");
    assert!(get_ipc_response(&station, request(local)).is_err());
    for origin in ["https://fixture.invalid/", "http://tauri.fixture.invalid/"] {
        assert!(get_ipc_response(&main, request(origin)).is_err());
        assert!(get_ipc_response(&station, request(origin)).is_err());
    }
}
