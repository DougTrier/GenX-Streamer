//! Renderer death is terminal for the current native epoch. Never resets owners in place.
use std::sync::Mutex;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Alive,
    Joining,
    Failed,
    Joined,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Bootstrap {
    schema_version: u8,
    recovered_renderer: bool,
}

pub(crate) struct Owner {
    phase: Mutex<Phase>,
    #[cfg(target_os = "android")]
    producer: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    #[cfg(target_os = "android")]
    registration: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}
impl Default for Owner {
    fn default() -> Self {
        Self {
            phase: Mutex::new(Phase::Alive),
            #[cfg(target_os = "android")]
            producer: Mutex::new(None),
            #[cfg(target_os = "android")]
            registration: Mutex::new(None),
        }
    }
}
impl Owner {
    fn begin(&self) -> bool {
        let Ok(mut phase) = self.phase.lock() else {
            return false;
        };
        if matches!(*phase, Phase::Joining | Phase::Joined) {
            return false;
        }
        *phase = Phase::Joining;
        true
    }
    fn finish(&self, joined: bool) {
        if let Ok(mut phase) = self.phase.lock() {
            if *phase == Phase::Joining {
                *phase = if joined { Phase::Joined } else { Phase::Failed };
            }
        }
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use serde::Deserialize;
    use std::sync::{atomic::Ordering, Arc};
    use tauri::{
        ipc::{Channel, InvokeResponseBody},
        Manager,
    };
    struct Adapter(tauri::plugin::PluginHandle<tauri::Wry>);
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Event {
        schema_version: u8,
        token: String,
    }
    pub(crate) fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
        tauri::plugin::Builder::<tauri::Wry, ()>::new("renderer-recovery")
            .setup(|app, api| {
                app.manage(Adapter(
                    api.register_android_plugin("com.tmg.tv", "RendererRecoveryPlugin")?,
                ));
                app.manage(Arc::new(Owner::default()));
                Ok(())
            })
            .build()
    }
    fn signal(app: tauri::AppHandle, event: Event) {
        if event.schema_version != 1
            || event.token.len() != 64
            || !event
                .token
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return;
        }
        let owner = app.state::<Arc<Owner>>().inner().clone();
        // Revoke work synchronously on native event delivery, before spawning cleanup.
        let state = app.state::<crate::NativeState>();
        state.closing.store(true, Ordering::SeqCst);
        if let Ok(mut requests) = state.requests.lock() {
            requests.stop();
        }
        if !owner.begin() {
            return;
        }
        let Ok(mut slot) = owner.producer.lock() else {
            owner.finish(false);
            return;
        };
        let previous = slot.take();
        let retained = owner.clone();
        *slot = Some(tauri::async_runtime::spawn(async move {
            // Failed attempt retries retain and join the original producer first.
            if let Some(previous) = previous {
                let _ = previous.await;
            }
            join_registration(&app).await;
            let joined = crate::shutdown_owned(&app).await.is_ok();
            // Publish terminal native outcome before making Retry/Reopen visible on UI.
            retained.finish(joined);
            let _result = app
                .state::<Adapter>()
                .0
                .run_mobile_plugin_async::<serde_json::Value>(
                    "complete",
                    serde_json::json!({"token":event.token,"joined":joined}),
                )
                .await;
        }));
    }
    pub(crate) fn start(app: tauri::AppHandle) {
        let work = app.state::<crate::NativeState>().work.acquire();
        let target = app.clone();
        let channel = Channel::<serde_json::Value>::new(move |body| {
            if let InvokeResponseBody::Json(body) = body {
                if let Ok(event) = serde_json::from_str::<Event>(&body) {
                    signal(target.clone(), event);
                }
            }
            Ok(())
        });
        let owner = app.state::<Arc<Owner>>().inner().clone();
        let Ok(mut registration) = owner.registration.lock() else {
            return;
        };
        *registration = Some(tauri::async_runtime::spawn(async move {
            let work = work;
            // Channel registry retains its native callback, independent of JavaScript.
            let result = app
                .state::<Adapter>()
                .0
                .run_mobile_plugin_async::<serde_json::Value>(
                    "registerListener",
                    serde_json::json!({"event":"rendererLost","handler":channel}),
                )
                .await;
            drop(work);
            if result.is_err() {
                // Observer failure must revoke native work even if its event channel never worked.
                let state = app.state::<crate::NativeState>();
                state.closing.store(true, Ordering::SeqCst);
                if let Ok(mut requests) = state.requests.lock() {
                    requests.stop();
                }
                let event = app
                    .state::<Adapter>()
                    .0
                    .run_mobile_plugin_async::<Event>("observerFailed", serde_json::json!({}))
                    .await
                    .unwrap_or(Event {
                        schema_version: 1,
                        token: "0".repeat(64),
                    });
                // The impossible fallback token cannot authorize Kotlin Reopen; cleanup still joins.
                signal(app, event);
            }
        }));
    }
    pub(crate) async fn join_registration(app: &tauri::AppHandle) {
        let owner = app.state::<Arc<Owner>>().inner().clone();
        let handle = owner
            .registration
            .lock()
            .ok()
            .and_then(|mut handle| handle.take());
        if let Some(handle) = handle {
            let _ = handle.await;
        }
    }
    #[tauri::command]
    pub(crate) async fn renderer_recovery_bootstrap(
        app: tauri::AppHandle,
    ) -> Result<Bootstrap, String> {
        let reply = app
            .state::<Adapter>()
            .0
            .run_mobile_plugin_async::<Bootstrap>("bootstrap", serde_json::json!({}))
            .await
            .map_err(|_| "renderer-recovery-bootstrap-unavailable".to_string())?;
        if reply.schema_version != 1 {
            return Err("renderer-recovery-bootstrap-invalid".into());
        }
        Ok(reply)
    }
}
#[cfg(target_os = "android")]
pub(crate) use android::*;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_join_prevents_duplicate_and_allows_only_failed_cleanup_retry() {
        let owner = Owner::default();
        assert!(owner.begin());
        assert!(!owner.begin());
        owner.finish(false);
        assert!(owner.begin());
        assert!(!owner.begin());
        owner.finish(true);
        assert!(!owner.begin());
        assert_eq!(*owner.phase.lock().unwrap(), Phase::Joined);
    }
    #[tokio::test]
    async fn original_held_cleanup_has_no_replacement_permission_before_actual_join() {
        let owner = std::sync::Arc::new(Owner::default());
        assert!(owner.begin());
        let (release, receive) = tokio::sync::oneshot::channel();
        let retained = owner.clone();
        let original = tokio::spawn(async move {
            receive.await.unwrap();
            retained.finish(true);
        });
        assert!(!owner.begin());
        assert_eq!(*owner.phase.lock().unwrap(), Phase::Joining);
        release.send(()).unwrap();
        original.await.unwrap();
        assert_eq!(*owner.phase.lock().unwrap(), Phase::Joined);
        assert!(!owner.begin());
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) async fn renderer_recovery_bootstrap() -> Result<Bootstrap, String> {
    Ok(Bootstrap {
        schema_version: 1,
        recovered_renderer: false,
    })
}
