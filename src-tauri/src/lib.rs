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

// The native layer by component (see ARCHITECTURE.md): each folder's mod.rs
// says what the component is. Its modules are re-exported below under their
// old names, so code anywhere in the crate refers to them as crate::<module>.
mod accounts;
mod browser;
mod catalog;
mod database;
mod discovery;
mod genxtra;
mod platform;
mod playback;
mod sharing;
use accounts::account_acquisition;
use accounts::account_catalog_owner;
use accounts::account_catalog_query;
use accounts::account_guide;
use accounts::account_guide_owner;
use accounts::account_media_store;
use accounts::account_playback_owner;
use accounts::account_playback_proxy;
use accounts::account_preferences;
use accounts::account_vault;
use accounts::account_vault_owner;
use accounts::account_vod;
use catalog::catalog_endpoint_projection;
use catalog::catalog_group_mutation;
use catalog::catalog_query;
use catalog::channel_logos;
use genxtra::archive_artwork;
use genxtra::archive_bookmarks;
use genxtra::archive_catalog;
use genxtra::archive_date_assessment;
use genxtra::archive_discovery;
use genxtra::archive_download_owner;
use genxtra::archive_download_store;
use genxtra::archive_download_transfer;
use genxtra::archive_library_store;
use genxtra::archive_playback_owner;
use genxtra::archive_playback_proxy;
use genxtra::archive_provider_catalog;
use genxtra::archive_provider_commons;
use genxtra::archive_provider_contract;
use genxtra::archive_provider_discovery;
use genxtra::archive_provider_loc;
use genxtra::archive_provider_nasa;
use genxtra::archive_provider_net;
use genxtra::archive_provider_probe;
// Its callers are Android-only; the Windows test build compiles it inside platform.
#[cfg(target_os = "android")]
use platform::android_manifest_protector;
#[cfg(any(target_os = "android", test))]
use platform::android_task_finish;
use platform::close_owner;
pub use sharing::casting;
mod commands;
use accounts::group_country;
use browser::donation;
use discovery::discovery_input;
use discovery::discovery_unavailable;
use platform::device_capabilities;
use platform::diagnostics;
pub mod guide;
use catalog::health_storage;
pub use sharing::lan;
mod lifecycle;
use catalog::local_favorites;
use catalog::native_catalog;
use catalog::series_identity;
use discovery::local_streams;
use discovery::network;
use discovery::network_media_probe;
use discovery::scan_batch;
use discovery::scan_candidate_manifest;
use discovery::scan_checkpoint;
use discovery::scan_checkpoint_summary;
use discovery::scan_manifest_work;
use discovery::scan_resume_commit_owner;
use discovery::scan_resume_owner;
use discovery::scan_resume_probe;
use discovery::scan_resume_projection;
use discovery::scan_resume_reconcile;
use discovery::scan_resume_registry;
use discovery::scan_resume_release;
use discovery::scan_resume_runtime;
use discovery::scan_resume_take;
use discovery::scan_window;
use discovery::source_directory;
use discovery::source_snapshot_activation_owner;
use guide::native_guide;
// Its callers are Android-only.
use database::storage;
use database::storage_backup_policy;
use database::storage_budget;
use database::storage_leases;
#[cfg(windows)]
use database::storage_recovery;
use database::storage_startup;
use database::storage_timings;
use database::storage_transaction;
#[cfg(target_os = "android")]
use platform::native_debug_stages;
use platform::native_shutdown;
use platform::native_speech;
use platform::renderer_recovery;
use platform::requests;
use platform::startup_milestones;
use playback::native_live;
use playback::native_video;
use sharing::native_sharing;
pub use sharing::relay;
use sharing::share_links;
pub use sharing::sharing_policy;
pub mod trier_video;
use browser::web_page;
use platform::vpn_status;
#[cfg(windows)]
use platform::windows_manifest_protector;
#[cfg(windows)]
use platform::windows_speech;
use playback::ts_align;
use playback::viewing_settings;
use playback::viewing_wake;

use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::Emitter;
use tauri::Manager;

struct NativeState {
    store: Arc<storage_leases::StoreOwner>,
    startup: Arc<storage_startup::Owner>,
    storage_target: Arc<Mutex<Result<storage::StorageTarget, String>>>,
    read_succeeded: Arc<AtomicBool>,
    #[cfg(windows)]
    recovery: Arc<storage_recovery::RecoveryOwner>,
    #[cfg(windows)]
    bookmarks: Arc<Result<storage_recovery::Bookmarks, String>>,
    requests: Mutex<requests::Requests>,
    closing: Arc<AtomicBool>,
    close_owner: close_owner::CloseOwner,
    work: Arc<close_owner::WorkOwner>,
    scan_resume: Arc<scan_resume_registry::Registry<scan_resume_runtime::Episode>>,
}

#[cfg(target_os = "android")]
struct AndroidViewing(tauri::plugin::PluginHandle<tauri::Wry>);

impl NativeState {
    fn admit_work(&self) -> Result<close_owner::WorkGuard, String> {
        let guard = self.work.acquire();
        if self.closing.load(Ordering::SeqCst) {
            return Err("application-closing".into());
        }
        Ok(guard)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A genx:// link opened while GenX runs goes to the running copy (docs/share-links.md).
    #[cfg(windows)]
    if share_links::forward_to_running_copy() {
        return;
    }
    startup_milestones::start();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("viewing")
                .setup(|_app, _api| {
                    #[cfg(target_os = "android")]
                    _app.manage(AndroidViewing(
                        _api.register_android_plugin("com.tmg.tv", "ViewingPlugin")?,
                    ));
                    Ok(())
                })
                .build(),
        );
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(android_manifest_protector::init())
        .plugin(renderer_recovery::init())
        .plugin(web_page::init())
        .plugin(native_video::init())
        .plugin(vpn_status::init())
        .plugin(share_links::init());
    builder
        .setup(|app| {
            use startup_milestones::{observe_root, root_mark, RootEvent};
            startup_milestones::mark(startup_milestones::Event::SetupEntry);
            let _startup_time = storage_timings::measure(storage_timings::Stage::Setup);
            let base = observe_root(
                RootEvent::AppDataDirStarted,
                RootEvent::AppDataDirFinished,
                || app.path().app_data_dir(),
            )?;
            // An explicit isolated profile (TMG_DATA_DIR) also owns these small stores,
            // so test runs never write into the installed app's own folder.
            let side_root = std::env::var_os("TMG_DATA_DIR")
                .map(std::path::PathBuf::from)
                .filter(|path| path.is_absolute())
                .unwrap_or_else(|| base.clone());
            app.manage(Arc::new(diagnostics::Store::new(
                side_root.join("diagnostic-events.json"),
            )));
            app.manage(native_live::NativeLive::default());
            app.manage(Arc::new(discovery_unavailable::Store::new(
                side_root.join("discovery-unavailable-v1.json"),
            )));
            app.manage(Arc::new(local_favorites::Store::new(
                side_root.join("local-favorites-v1.json"),
            )));
            root_mark(RootEvent::DiagnosticsReady);
            #[cfg(windows)]
            let bookmarks = observe_root(
                RootEvent::WindowsBookmarksStarted,
                RootEvent::WindowsBookmarksFinished,
                || {
                    app.path()
                        .app_config_dir()
                        .map_err(|_| "storage-bookmark-unavailable".to_string())
                        .and_then(|config| {
                            std::env::current_exe()
                                .map_err(|_| "storage-bookmark-unavailable".to_string())
                                .and_then(|exe| storage_recovery::Bookmarks::new(config, &exe))
                        })
                },
            );
            // Android's OS-selected sandbox commonly includes /data/user/0 alias.
            // Resolve only this trusted platform default; explicit user paths retain link refusal.
            #[cfg(target_os = "android")]
            let base = observe_root(
                RootEvent::CanonicalizationStarted,
                RootEvent::CanonicalizationFinished,
                || std::fs::canonicalize(base),
            )?;
            #[cfg(windows)]
            let root = observe_root(RootEvent::PolicyStarted, RootEvent::PolicyFinished, || {
                storage::data_root_with_bookmark(base, &bookmarks)
            });
            #[cfg(not(windows))]
            let root = observe_root(RootEvent::PolicyStarted, RootEvent::PolicyFinished, || {
                storage::data_root(base).map_err(|_| "storage-directory-invalid".to_string())
            });
            let target = observe_root(
                RootEvent::TargetInspectionStarted,
                RootEvent::TargetInspectionFinished,
                || {
                    root.map(|(path, mode)| storage::StorageTarget {
                        require_existing: mode == "explicit-directory"
                            && std::env::var_os("TMG_DATA_DIR").is_none()
                            || path.is_dir(),
                        require_database: path.join(storage_transaction::DB).is_file(),
                        path,
                        mode,
                    })
                },
            );
            startup_milestones::mark(startup_milestones::Event::RootSelected);
            let (pending, ticket) = storage_leases::StoreOwner::initializing();
            let store = Arc::new(pending);
            let startup = Arc::new(storage_startup::Owner::default());
            let target = Arc::new(Mutex::new(target));
            let closing = Arc::new(AtomicBool::new(false));
            let work = Arc::new(close_owner::WorkOwner::default());
            app.manage(NativeState {
                store: store.clone(),
                startup: startup.clone(),
                storage_target: target.clone(),
                read_succeeded: Arc::new(AtomicBool::new(false)),
                #[cfg(windows)]
                recovery: Arc::new(storage_recovery::RecoveryOwner::default()),
                #[cfg(windows)]
                bookmarks: Arc::new(bookmarks),
                requests: Mutex::new(requests::Requests::default()),
                closing: closing.clone(),
                close_owner: close_owner::CloseOwner::default(),
                work: work.clone(),
                scan_resume: Arc::new(scan_resume_registry::Registry::default()),
            });
            app.manage(Arc::new(casting::CastingManager::default()));
            app.manage(Arc::new(lan::LanManager::default()));
            app.manage(Arc::new(native_guide::NativeGuides::default()));
            #[cfg(target_os = "android")]
            renderer_recovery::start(app.handle().clone());
            #[cfg(windows)]
            app.manage(Arc::new(windows_speech::WindowsSpeech::default()));
            startup_milestones::mark(startup_milestones::Event::StateManaged);
            let native_app = app.handle().clone();
            startup.start(store, ticket, target, closing, work.acquire(), async move {
                #[cfg(target_os = "android")]
                renderer_recovery::join_registration(&native_app).await;
                #[cfg(not(target_os = "android"))]
                let _ = native_app;
            })?;
            commands::viewing::spawn_backup_owner(app.handle().clone());
            commands::viewing::spawn_download_sweep(app.handle().clone());
            #[cfg(windows)]
            web_page::forget_sites(app.handle());
            #[cfg(windows)]
            share_links::start_windows(app.handle());
            startup_milestones::mark(startup_milestones::Event::SetupFinished);
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(windows)]
            if matches!(event, tauri::WindowEvent::Focused(false)) {
                if let Some(speech) = window.try_state::<Arc<windows_speech::WindowsSpeech>>() {
                    speech.background();
                }
            }
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = lifecycle::coordinated_exit(app).await;
                });
            }

            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<NativeState>() {
                    state.closing.store(true, Ordering::SeqCst);
                    #[cfg(windows)]
                    state.recovery.cancel();
                    if let Ok(mut requests) = state.requests.lock() {
                        requests.stop();
                    }
                }
                if let Some(casting) = window.try_state::<Arc<casting::CastingManager>>() {
                    let owned = casting.inner().clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = owned.shutdown().await;
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            diagnostics::append_diagnostic_event,
            discovery_unavailable::read_discovery_unavailable,
            discovery_unavailable::record_discovery_unavailable,
            diagnostics::read_diagnostic_events,
            diagnostics::clear_diagnostic_events,
            native_guide::guide_sources,
            native_guide::guide_save_source,
            native_guide::guide_remove_source,
            native_guide::guide_preview,
            native_guide::guide_preview_proposed_source,
            native_guide::guide_preview_file,
            native_guide::guide_file_begin,
            native_guide::guide_file_append,
            native_guide::guide_file_finish,
            native_guide::guide_file_discard,
            native_guide::guide_commit,
            native_guide::guide_commit_and_match,
            native_guide::guide_commit_if_matched,
            native_guide::guide_connect_cached_catalog,
            archive_discovery::archive_query_catalog,
            archive_discovery::archive_title_artwork,
            archive_discovery::archive_title_files,
            archive_discovery::archive_discover_step,
            archive_provider_discovery::public_archive_discover_step,
            archive_discovery::archive_discovery_progress,
            archive_discovery::archive_set_favorite,
            archive_discovery::archive_remove_title,
            archive_discovery::archive_remove_file,
            archive_discovery::archive_clear_library,
            archive_discovery::archive_item_files_progress,
            archive_discovery::archive_item_files_step,
            commands::archive::start_archive_playback,
            commands::archive::start_archive_download_playback,
            commands::archive::start_archive_download,
            commands::archive::list_archive_downloads,
            commands::archive::remove_archive_download,
            commands::archive::archive_download_status,
            commands::archive::stop_archive_downloads,
            commands::archive::stop_archive_playback,
            commands::archive::renew_archive_playback,
            commands::archive::read_archive_bookmark,
            commands::archive::save_archive_bookmark,
            native_guide::guide_refresh_plan,
            native_guide::guide_refresh_due,
            native_guide::guide_discard,
            native_guide::guide_channels,
            native_guide::guide_mappings,
            native_guide::guide_save_mapping,
            native_guide::guide_save_mapping_receipt,
            native_guide::guide_preview_mapped,
            native_guide::guide_mapped_schedule_status,
            native_guide::guide_remove_mapping,
            native_guide::guide_programs,
            native_guide::guide_listed_channels,
            donation::open_donation,
            native_guide::guide_selected_summary,
            native_guide::guide_visible_summaries,
            native_guide::guide_coverage,
            native_guide::guide_pack_suggestions,
            native_guide::guide_grabber_channels,
            native_guide::guide_retention_cleanup,
            native_guide::guide_channel_coverage,
            native_guide::guide_suggest_mapping,
            commands::storage::runtime_info,
            commands::storage::get_native_startup_milestones,
            commands::storage::get_native_root_selection_milestones,
            commands::storage::read_record,
            commands::storage::write_record,
            commands::storage::read_record_pair,
            commands::storage::read_scan_health,
            commands::storage::read_guide_capture,
            native_catalog::query_catalog_page,
            channel_logos::channel_logos,
            commands::scan::mutate_catalog_group,
            native_catalog::cancel_catalog_query,
            native_catalog::query_cancellation_snapshot,
            commands::storage::get_storage_timings,
            commands::storage::storage_recovery_status,
            commands::storage::retry_storage,
            commands::storage::choose_storage_directory,
            commands::storage::write_record_pair,
            commands::scan::read_scan_checkpoint,
            commands::scan::read_scan_checkpoint_summary,
            commands::scan::scan_checkpoint_capabilities,
            commands::scan::scan_candidate_manifest_capabilities,
            commands::scan::begin_scan_candidate_manifest,
            commands::scan::append_scan_candidate_manifest_page,
            commands::scan::seal_scan_candidate_manifest,
            commands::scan::scan_resume_capabilities,
            commands::scan::close_scan_resume_open,
            commands::scan::begin_source_snapshot,
            commands::scan::append_source_snapshot,
            commands::scan::promote_source_snapshot,
            commands::scan::source_snapshot_status,
            commands::scan::list_source_snapshot_checks,
            commands::scan::read_channel_checks,
            commands::scan::record_channel_checks,
            commands::scan::record_scan_channel_checks,
            commands::scan::record_channel_start,
            commands::scan::activate_source_snapshot_checks,
            commands::scan::open_scan_resume_plan,
            commands::scan::close_scan_resume_plan,
            commands::scan::take_scan_resume_candidates,
            commands::scan::probe_scan_resume_candidate,
            commands::scan::commit_scan_resume_candidates,
            commands::scan::read_scan_resume_publication_projection,
            commands::scan::release_scan_resume_candidates,
            commands::scan::defer_scan_resume_candidates,
            commands::scan::find_scan_candidate_manifest,
            commands::scan::read_scan_candidate_manifest_page,
            commands::scan::scan_batch_capabilities,
            commands::scan::scan_window_capabilities,
            commands::scan::read_scan_commit_revisions,
            commands::scan::commit_scan_batch,
            commands::scan::commit_scan_window,
            commands::scan::write_scan_checkpoint,
            commands::scan::discard_scan_checkpoint,
            commands::scan::advance_scan_checkpoint,
            commands::storage::write_health,
            commands::storage::write_record_receipt,
            commands::sources::fetch_playlist,
            commands::viewing::acknowledge_back,
            lifecycle::acknowledge_cleanup,
            commands::sources::inspect_source,
            commands::sources::inspect_health_source,
            commands::sources::inspect_media_resources,
            commands::sources::inspect_discovery_page,
            commands::sources::inspect_source_directory,
            commands::sources::series_identity_lookup,
            native_speech::speech_capabilities,
            native_speech::speech_request_permission,
            native_speech::speech_start,
            native_speech::speech_end,
            native_speech::speech_cancel,
            commands::sources::fetch_media,
            commands::sources::fetch_media_bytes,
            device_capabilities::device_capabilities,
            commands::casting::cast_discover,
            commands::casting::cast_cancel_discovery,
            commands::accounts::list_iptv_accounts,
            commands::accounts::save_iptv_account,
            commands::accounts::remove_iptv_account,
            commands::accounts::inspect_iptv_account,
            account_vod::account_vod_list,
            local_streams::local_streams_scan,
            local_favorites::local_favorites_read,
            local_favorites::local_favorites_save,
            web_page::web_page,
            native_video::native_video,
            native_live::native_live_open,
            native_live::native_live_renew,
            native_live::native_live_close,
            vpn_status::vpn_status,
            share_links::take_incoming_link,
            share_links::share_text,
            share_links::share_app_file,
            share_links::check_shared_destination,
            account_vod::account_series_info,
            account_vod::account_vod_details,
            viewing_settings::read_viewing_settings,
            viewing_settings::write_viewing_settings,
            commands::accounts::start_iptv_vod_playback,
            commands::accounts::refresh_iptv_account,
            commands::accounts::refresh_iptv_account_guide,
            commands::accounts::read_iptv_account_guide_status,
            commands::accounts::read_iptv_account_guide_channels,
            commands::accounts::read_iptv_account_guide_listed,
            commands::accounts::read_iptv_account_guide_programs,
            commands::accounts::list_iptv_account_channels,
            commands::accounts::query_iptv_account_channels,
            commands::accounts::list_iptv_account_countries,
            commands::accounts::write_iptv_account_preferences,
            commands::accounts::start_iptv_playback,
            commands::accounts::stop_iptv_playback,
            commands::accounts::account_playback_start_timing,
            commands::casting::cast_network_scope,
            commands::casting::cast_validate_receiver,
            commands::casting::cast_start,
            commands::casting::cast_register_receiver,
            commands::casting::cast_discovery_warnings,
            commands::casting::cast_status,
            commands::casting::cast_stop,
            commands::sources::cancel_playlist,
            commands::viewing::set_fullscreen,
            commands::viewing::set_viewing_active,
            commands::viewing::get_viewing_wake_diagnostics,
            lifecycle::force_exit,
            lifecycle::request_exit,
            renderer_recovery::renderer_recovery_bootstrap,
            native_sharing::start_server,
            native_sharing::stop_server,
            native_sharing::sharing_invite,
            native_sharing::sharing_publish,
            native_sharing::sharing_selection_changed,
            native_sharing::sharing_viewers,
            native_sharing::sharing_revoke,
            native_sharing::next_remote_control,
            native_sharing::remote_control_active,
            native_sharing::remote_control_allows,
            native_sharing::sharing_control_allows,
            native_sharing::acknowledge_remote_control
        ])
        .run(tauri::generate_context!())
        .expect("GenX Streamer could not initialize its native application runtime");
}

use catalog::refresh_cadence;
