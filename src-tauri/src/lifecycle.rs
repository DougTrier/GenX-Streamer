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

//! Orderly exit: the close attempt, draining owned work, shutdown and the exit commands.
use crate::*;

#[tauri::command]
pub(crate) fn force_exit(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<NativeState>() {
        state.closing.store(true, Ordering::SeqCst);
        #[cfg(windows)]
        state.recovery.cancel();
    }
    app.exit(0);
}

pub(crate) async fn shutdown_owned(app: &tauri::AppHandle) -> Result<(), &'static str> {
    #[cfg(target_os = "android")]
    renderer_recovery::join_registration(app).await;
    app.state::<NativeState>().startup.join().await;
    let cast = app.state::<Arc<casting::CastingManager>>().inner().clone();
    let lan = app.state::<Arc<lan::LanManager>>().inner().clone();
    let guides = app
        .state::<Arc<native_guide::NativeGuides>>()
        .inner()
        .clone();
    native_shutdown::join_owned(
        async {
            #[cfg(windows)]
            {
                let state = app.state::<NativeState>();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                while state.recovery.active() {
                    if std::time::Instant::now() >= deadline {
                        return Err("storage-recovery-stop-unconfirmed");
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            }
            Ok(())
        },
        async {
            native_speech::shutdown(app)
                .await
                .map_err(|_| "speech-stop-unconfirmed")
        },
        cast.shutdown(),
        async {
            let live = app.state::<native_live::NativeLive>();
            let (lan, accounts, archive, downloads, _) = tokio::join!(
                lan.shutdown(),
                account_playback_owner::shutdown(),
                archive_playback_owner::shutdown(),
                archive_download_owner::shutdown(),
                // The Android player's live relay is joined too (LX02, LX05).
                live.shutdown()
            );
            lan?;
            accounts?;
            downloads.map_err(|_| "archive-download-stop-unconfirmed")?;
            archive.map_err(|_| "archive-playback-stop-unconfirmed")
        },
        guides.shutdown(),
        async {
            let state = app.state::<NativeState>();
            let requests = state
                .requests
                .lock()
                .map(|requests| requests.drain_owner())
                .map_err(|_| "request-lock");
            match requests {
                Ok(requests) => {
                    let (resume, _, _) = tokio::join!(
                        state.scan_resume.shutdown(),
                        requests.drained(),
                        state.work.drained()
                    );
                    resume.map_err(|_| "scan-resume-stop-unconfirmed")
                }
                Err(_) => {
                    let _ = tokio::join!(state.scan_resume.shutdown(), state.work.drained());
                    Err("request-lock")
                }
            }
        },
    )
    .await
}

#[tauri::command]
pub(crate) fn acknowledge_cleanup(
    request_id: String,
    generation: u64,
    result: close_owner::CleanupResult,
    state: tauri::State<NativeState>,
) -> Result<(), String> {
    // The exact active ticket is already the authority. Preparation deliberately
    // accepts its ACK before closing revokes final renderer storage work.
    state
        .close_owner
        .acknowledge(
            &close_owner::CloseTicket {
                request_id,
                generation,
            },
            result,
        )
        .map_err(str::to_string)
}
pub(crate) fn emit_close_progress(app: &tauri::AppHandle, ticket: &close_owner::CloseTicket) {
    let state = app.state::<NativeState>();
    if let Some(snapshot) = state.close_owner.snapshot(ticket) {
        let _ = app.emit("native-close-progress", snapshot);
    }
}
pub(crate) async fn complete_close_attempt(
    app: tauri::AppHandle,
    ticket: close_owner::CloseTicket,
    ack: tokio::sync::oneshot::Receiver<close_owner::CleanupResult>,
) {
    use close_owner::{CloseReason, CloseStage};
    let state = app.state::<NativeState>();
    let result: Result<(), (&'static str, CloseReason)> = async {
        // Every close route first freezes/drains the renderer while final
        // session-bound saves still own ordinary native admission. A missing
        // renderer cannot postpone starting native cleanup beyond this budget.
        state.close_owner.phase(&ticket, CloseStage::Frontend);
        let emitted = app.emit("native-close-starting", ticket.clone()).is_ok();
        emit_close_progress(&app, &ticket);
        let frontend = native_shutdown::prepare_frontend(
            ack,
            emitted,
            tokio::time::sleep(std::time::Duration::from_secs(120)),
        )
        .await;
        state.closing.store(true, Ordering::SeqCst);
        #[cfg(windows)]
        state.recovery.cancel();
        let request_stop = state
            .requests
            .lock()
            .map(|mut requests| requests.stop())
            .map_err(|_| ("request-lock", CloseReason::RequestLock));
        let (native, start_native, native_admission) = match state.close_owner.native_drain() {
            Ok((native, start)) => (native, start, Ok(())),
            Err(error) => (
                Arc::new(close_owner::NativeDrain::default()),
                true,
                Err((error, CloseReason::NativeFailed)),
            ),
        };
        if start_native {
            let owned = native.clone();
            let native_app = app.clone();
            tauri::async_runtime::spawn(async move {
                owned.complete(shutdown_owned(&native_app).await);
            });
        }
        let joined = state
            .close_owner
            .join_cleanup(&ticket, frontend.settled(), &native, emitted, || {
                emit_close_progress(&app, &ticket);
            })
            .await;
        // Cleanup-only IPC can admit actual disposal work after the native phase.
        state
            .close_owner
            .phase(&ticket, CloseStage::FinalNativeDrain);
        emit_close_progress(&app, &ticket);
        let requests = state
            .requests
            .lock()
            .map(|requests| requests.drain_owner())
            .map_err(|_| ("request-lock", CloseReason::RequestLock));
        let final_requests = match requests {
            Ok(requests) => {
                tokio::join!(requests.drained(), state.work.drained());
                Ok(())
            }
            Err(error) => {
                state.work.drained().await;
                Err(error)
            }
        };
        // Admission errors cannot abandon either original cleanup join or the
        // final owned-work drain, and never become successful close receipts.
        request_stop?;
        native_admission?;
        joined?;
        final_requests?;
        #[cfg(target_os = "android")]
        {
            state.close_owner.phase(&ticket, CloseStage::ActivityFinish);
            emit_close_progress(&app, &ticket);
            let (finish, start) = state
                .close_owner
                .activity_drain()
                .map_err(|error| (error, CloseReason::ActivityUnconfirmed))?;
            if start {
                android_task_finish::start_owned(
                    finish.clone(),
                    state.work.acquire(),
                    android_task_finish::request(app.clone()),
                    finalize_activity_exit(app.clone(), ticket.clone()),
                );
            }
            finish
                .settled()
                .await
                .map_err(|error| (error, CloseReason::ActivityUnconfirmed))?;
        }
        Ok(())
    }
    .await;
    let (completion, reason) = match result {
        Ok(()) => (Ok(()), None),
        Err((error, reason)) => (Err(error), Some(reason)),
    };
    state.close_owner.settle(&ticket, completion, reason);
    emit_close_progress(&app, &ticket);
    match completion {
        Ok(()) => {
            #[cfg(not(target_os = "android"))]
            app.exit(0);
            #[cfg(target_os = "android")]
            finalize_activity_exit(app, ticket).await;
        }
        Err(reason) => {
            let _ = app.emit("native-close-blocked", reason);
        }
    }
}
pub(crate) async fn coordinated_exit(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<NativeState>();
    let attempt = state.close_owner.begin_retained().map_err(str::to_string)?;
    if let Some(ack) = attempt.acknowledgment {
        // This producer owns the attempt through actual settlement. A caller's timeout
        // observes progress and cannot invalidate its ticket or drop its ACK receiver.
        tauri::async_runtime::spawn(complete_close_attempt(
            app.clone(),
            attempt.ticket.clone(),
            ack,
        ));
    } else {
        // Explicit Retry repeats the exact pending ticket; frontend ownership coalesces it.
        let _ = app.emit("native-close-starting", attempt.ticket.clone());
        emit_close_progress(&app, &attempt.ticket);
    }
    match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        attempt.completion.settled(),
    )
    .await
    {
        Ok(result) => result.map_err(str::to_string),
        Err(_) => {
            if !state.close_owner.observation_deadline(&attempt.ticket) {
                return attempt.completion.settled().await.map_err(str::to_string);
            }
            emit_close_progress(&app, &attempt.ticket);
            // The owned producer may settle while the observation timer wakes. Do not
            // publish a stale blocked notification for a terminal/superseded attempt.
            if !state
                .close_owner
                .snapshot(&attempt.ticket)
                .is_some_and(|snapshot| snapshot.running)
            {
                return attempt.completion.settled().await.map_err(str::to_string);
            }
            let _ = app.emit("native-close-blocked", "cleanup-stop-timeout");
            Err("cleanup-stop-timeout".into())
        }
    }
}
#[cfg(target_os = "android")]
pub(crate) async fn finalize_activity_exit(
    app: tauri::AppHandle,
    ticket: close_owner::CloseTicket,
) {
    let state = app.state::<NativeState>();
    let requests = match state.requests.lock() {
        Ok(requests) => requests.drain_owner(),
        Err(_) => return,
    };
    // Closing forbids fresh work; cleanup-only operations must still actually settle.
    // Only then, and only for this accepted close, does the process end (LX06):
    // without the C exit handlers that app.exit runs, which raced WebView's GPU
    // thread into a 'destroyed mutex' abort on every exit (ViewingPlugin.endProcess).
    // app.exit stays as the fallback if the plugin cannot be reached.
    let viewing = app.clone();
    android_task_finish::end_after_drain(
        &state.closing,
        &state.close_owner,
        &ticket,
        requests,
        &state.work,
        || async move {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                viewing
                    .state::<AndroidViewing>()
                    .0
                    .run_mobile_plugin_async::<serde_json::Value>(
                        "endProcess",
                        serde_json::json!({}),
                    ),
            )
            .await;
            viewing.exit(0);
        },
    )
    .await;
}
#[tauri::command]
pub(crate) async fn request_exit(app: tauri::AppHandle) -> Result<(), String> {
    coordinated_exit(app).await
}
