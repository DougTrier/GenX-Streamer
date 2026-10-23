//! Readback evidence and retained native work for the Activity-owned viewing flag.
use crate::close_owner::WorkGuard;
use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WakeReceipt {
    pub schema_version: u8,
    pub adapter_version: String,
    pub requested_active: bool,
    pub foreground: bool,
    pub window_keep_screen_on: Option<bool>,
    pub web_view_keep_screen_on: Option<bool>,
    pub decor_keep_screen_on: Option<bool>,
    pub platform: String,
}
impl WakeReceipt {
    #[cfg(any(not(target_os = "android"), test))]
    pub fn unsupported(active: bool) -> Self {
        Self {
            schema_version: 1,
            adapter_version: "viewing-wake-v1".into(),
            requested_active: active,
            foreground: false,
            window_keep_screen_on: None,
            web_view_keep_screen_on: None,
            decor_keep_screen_on: None,
            platform: if cfg!(windows) {
                "windows"
            } else {
                "unsupported"
            }
            .into(),
        }
    }
    #[cfg(any(target_os = "android", test))]
    pub fn validate_android(self, active: bool) -> Result<Self, String> {
        if self.schema_version != 1
            || self.adapter_version != "viewing-wake-v1"
            || self.platform != "android"
            || self.requested_active != active
            || self.window_keep_screen_on.is_none()
        {
            return Err("viewing-wake-receipt-invalid".into());
        }
        // Actual child/window mismatches remain in the receipt; they are never fabricated away.
        Ok(self)
    }
}
/// Dropping the caller's JoinHandle does not drop this task or its native-work guard.
pub fn spawn_owned<R, F>(
    work: WorkGuard,
    closing: Arc<AtomicBool>,
    active: bool,
    operation: F,
) -> tokio::task::JoinHandle<Result<R, String>>
where
    F: Future<Output = Result<R, String>> + Send + 'static,
    R: Send + 'static,
{
    tokio::spawn(async move {
        let _work = work;
        if active && closing.load(Ordering::SeqCst) {
            return Err("application-closing".into());
        }
        operation.await
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::close_owner::WorkOwner;
    #[tokio::test]
    async fn canceled_caller_retains_actual_native_work_until_settlement() {
        let owner = Arc::new(WorkOwner::default());
        let (release, receive) = tokio::sync::oneshot::channel();
        let task = spawn_owned(
            owner.acquire(),
            Arc::new(AtomicBool::new(false)),
            false,
            async move {
                receive.await.unwrap();
                Ok(WakeReceipt::unsupported(false))
            },
        );
        drop(task);
        assert_eq!(owner.count(), 1);
        release.send(()).unwrap();
        owner.drained().await;
        assert_eq!(owner.count(), 0);
    }
    #[tokio::test]
    async fn closing_refuses_enable_but_tracks_disable_settlement() {
        let owner = Arc::new(WorkOwner::default());
        let closing = Arc::new(AtomicBool::new(true));
        let result = spawn_owned::<WakeReceipt, _>(owner.acquire(), closing.clone(), true, async {
            panic!("must not enable")
        })
        .await
        .unwrap();
        assert_eq!(result.unwrap_err(), "application-closing");
        assert_eq!(owner.count(), 0);
        let receipt = spawn_owned(owner.acquire(), closing, false, async {
            Ok(WakeReceipt::unsupported(false))
        })
        .await
        .unwrap()
        .unwrap();
        assert!(!receipt.requested_active);
        assert_eq!(owner.count(), 0);
    }
    #[test]
    fn readback_mismatch_is_preserved_and_schema_mismatch_refused() {
        let json = r#"{"schemaVersion":1,"adapterVersion":"viewing-wake-v1","requestedActive":false,"foreground":true,"windowKeepScreenOn":false,"webViewKeepScreenOn":true,"decorKeepScreenOn":true,"platform":"android"}"#;
        let actual: WakeReceipt = serde_json::from_str(json).unwrap();
        let actual = actual.validate_android(false).unwrap();
        assert_eq!(actual.web_view_keep_screen_on, Some(true));
        assert!(actual.validate_android(true).is_err());
    }
}
