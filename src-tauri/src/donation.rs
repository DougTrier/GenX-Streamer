//! Explicit fixed donation destinations; no caller-provided URLs or programs.
use crate::NativeState;
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::sync::atomic::Ordering;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DonationReceipt {
    pub opened: bool,
    pub target: String,
}
fn destination(target: &str) -> Result<&'static str, &'static str> {
    match target {
        "github" => Ok("https://github.com/sponsors/dougtrier"),
        "opencollective" => Ok("https://opencollective.com/trier-os"),
        "coffee" => Ok("https://www.buymeacoffee.com/dougtrier"),
        _ => Err("donation-target-refused"),
    }
}
#[cfg(any(windows, test))]
fn open_fixed(
    target: &str,
    closing: bool,
    open: impl FnOnce(&'static str) -> Result<(), ()>,
) -> Result<DonationReceipt, String> {
    let url = destination(target).map_err(str::to_string)?;
    if closing {
        return Err("application-closing".into());
    }
    open(url).map_err(|_| "donation-browser-unavailable".to_string())?;
    // OS launch accepted, not proof that the site loaded or a donation succeeded.
    Ok(DonationReceipt {
        opened: true,
        target: target.into(),
    })
}
#[tauri::command]
pub(crate) async fn open_donation(
    target: String,
    app: tauri::AppHandle,
) -> Result<DonationReceipt, String> {
    destination(&target).map_err(str::to_string)?;
    let state = app.state::<NativeState>();
    let work = state.admit_work()?;
    let closing = state.closing.clone();
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        open_fixed(&target, closing.load(Ordering::SeqCst), system_open)
    })
    .await
    .map_err(|_| "donation-browser-unavailable".to_string())?;
    #[cfg(target_os = "android")]
    return crate::viewing_wake::spawn_owned(work, closing, true, async move {
        app.state::<crate::AndroidViewing>()
            .0
            .run_mobile_plugin_async::<DonationReceipt>(
                "openDonation",
                serde_json::json!({"target":target.clone()}),
            )
            .await
            .map_err(|_| "donation-browser-unavailable".to_string())
            .and_then(|receipt| {
                if receipt.opened && receipt.target == target {
                    Ok(receipt)
                } else {
                    Err("donation-browser-unavailable".into())
                }
            })
    })
    .await
    .map_err(|_| "donation-browser-unavailable".to_string())?;
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _work = work;
        let _ = (closing, app);
        Err("donation-platform-unavailable".into())
    }
}
#[cfg(windows)]
fn system_open(url: &'static str) -> Result<(), ()> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    // URL is an exact constant; parameters and directory are always null, never a shell command.
    let operation: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
    let destination: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let result = ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            destination.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
        if initialized {
            CoUninitialize();
        }
        if result as isize > 32 {
            Ok(())
        } else {
            Err(())
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_exact_fixed_targets_are_passed_to_system_opener() {
        for (target, url) in [
            ("github", "https://github.com/sponsors/dougtrier"),
            ("opencollective", "https://opencollective.com/trier-os"),
            ("coffee", "https://www.buymeacoffee.com/dougtrier"),
        ] {
            let reply = open_fixed(target, false, |actual| {
                assert_eq!(actual, url);
                Ok(())
            })
            .unwrap();
            assert!(reply.opened);
            assert_eq!(reply.target, target);
        }
        for invalid in [
            "",
            "Github",
            "github ",
            "https://github.com/sponsors/dougtrier",
            "coffee?x=1",
            "file:///C:/",
            "cmd.exe",
        ] {
            assert_eq!(
                open_fixed(invalid, false, |_| panic!("must not launch")).unwrap_err(),
                "donation-target-refused"
            );
        }
    }
    #[test]
    fn closing_and_backend_failure_never_report_success_or_raw_error() {
        assert_eq!(
            open_fixed("coffee", true, |_| panic!("must not launch")).unwrap_err(),
            "application-closing"
        );
        assert_eq!(
            open_fixed("github", false, |_| Err(())).unwrap_err(),
            "donation-browser-unavailable"
        );
    }
    #[tokio::test]
    async fn canceled_caller_retains_open_task_until_actual_backend_settles() {
        use crate::close_owner::WorkOwner;
        use std::sync::{atomic::AtomicBool, Arc};
        let owner = Arc::new(WorkOwner::default());
        let (release, wait) = tokio::sync::oneshot::channel();
        let task = crate::viewing_wake::spawn_owned(
            owner.acquire(),
            Arc::new(AtomicBool::new(false)),
            true,
            async move {
                wait.await.unwrap();
                open_fixed("coffee", false, |url| {
                    assert_eq!(url, "https://www.buymeacoffee.com/dougtrier");
                    Ok(())
                })
            },
        );
        drop(task);
        assert_eq!(owner.count(), 1);
        release.send(()).unwrap();
        owner.drained().await;
        assert_eq!(owner.count(), 0);
    }
}
