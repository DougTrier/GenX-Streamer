//! Live channels whose MPEG-2 picture the web player cannot show play in
//! GenX's Android player (docs/native-vod-player.md). The player only ever
//! opens this loopback relay, which fetches the public stream under the same
//! policy as casting (validated destinations, opaque addresses, a lease that
//! the page renews while the channel plays). One relay at a time.

use crate::casting::ReceiverRelay;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::Mutex;

#[derive(Default)]
pub(crate) struct NativeLive {
    active: Mutex<Option<(u64, ReceiverRelay)>>,
    next: AtomicU64,
    closed: AtomicBool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Opened {
    session: u64,
    url: String,
}

impl NativeLive {
    pub(crate) async fn open(&self, url: &str, allow_http: bool) -> Result<Opened, &'static str> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("native-live-closed");
        }
        if url.len() > 16_384 {
            return Err("native-live-source-invalid");
        }
        let mut relay = ReceiverRelay::start_loopback(url, allow_http).await?;
        let mut active = self.active.lock().await;
        // A shutdown that began while the relay was starting wins (LX01).
        if self.closed.load(Ordering::SeqCst) {
            drop(active);
            let _ = relay.stop().await;
            return Err("native-live-closed");
        }
        let session = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let opened = Opened {
            session,
            url: relay.media_url().to_owned(),
        };
        let previous = active.replace((session, relay));
        drop(active);
        if let Some((_, mut old)) = previous {
            let _ = old.stop().await;
        }
        Ok(opened)
    }
    pub(crate) async fn renew(&self, session: u64) -> Result<(), &'static str> {
        match self.active.lock().await.as_ref() {
            Some((id, relay)) if *id == session => relay.renew(),
            _ => Err("native-live-stale"),
        }
    }
    pub(crate) async fn close(&self, session: u64) {
        let mut active = self.active.lock().await;
        if active.as_ref().is_some_and(|(id, _)| *id == session) {
            if let Some((_, mut relay)) = active.take() {
                drop(active);
                let _ = relay.stop().await;
            }
        }
    }
    /// Closes the active relay and refuses later opens (app exit: LX01, LX02, LX05).
    pub(crate) async fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let active = self.active.lock().await.take();
        if let Some((_, mut relay)) = active {
            let _ = relay.stop().await;
        }
    }
    /// The address the native player may open for a live channel right now.
    pub(crate) async fn current_url(&self) -> Option<String> {
        self.active
            .lock()
            .await
            .as_ref()
            .map(|(_, relay)| relay.media_url().to_owned())
    }
}

#[tauri::command]
pub(crate) async fn native_live_open(
    url: String,
    allow_http: bool,
    live: tauri::State<'_, NativeLive>,
) -> Result<Opened, String> {
    live.open(&url, allow_http).await.map_err(String::from)
}
#[tauri::command]
pub(crate) async fn native_live_renew(
    session: u64,
    live: tauri::State<'_, NativeLive>,
) -> Result<(), String> {
    live.renew(session).await.map_err(String::from)
}
#[tauri::command]
pub(crate) async fn native_live_close(
    session: u64,
    live: tauri::State<'_, NativeLive>,
) -> Result<(), String> {
    live.close(session).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn one_relay_at_a_time_and_only_its_own_session_renews_or_closes_it() {
        let live = NativeLive::default();
        let first = live
            .open("https://fixture.test/a.m3u8", false)
            .await
            .unwrap();
        assert_eq!(
            live.current_url().await.as_deref(),
            Some(first.url.as_str())
        );
        let second = live
            .open("https://fixture.test/b.m3u8", false)
            .await
            .unwrap();
        assert_ne!(first.url, second.url);
        assert_eq!(
            live.current_url().await.as_deref(),
            Some(second.url.as_str())
        );
        assert_eq!(live.renew(first.session).await, Err("native-live-stale"));
        assert!(live.renew(second.session).await.is_ok());
        live.close(first.session).await;
        assert!(live.current_url().await.is_some());
        live.close(second.session).await;
        assert!(live.current_url().await.is_none());
        assert!(live.open("https://10.0.0.5/a.m3u8", false).await.is_err());
        assert!(live.current_url().await.is_none());
    }

    #[tokio::test]
    async fn shutdown_closes_the_relay_and_refuses_later_opens_lx01_lx05() {
        let live = NativeLive::default();
        let opened = live
            .open("https://fixture.test/a.m3u8", false)
            .await
            .unwrap();
        live.shutdown().await;
        assert!(live.current_url().await.is_none());
        assert_eq!(live.renew(opened.session).await, Err("native-live-stale"));
        assert_eq!(
            live.open("https://fixture.test/b.m3u8", false).await.err(),
            Some("native-live-closed")
        );
        live.shutdown().await; // idempotent (LX03)
    }
}
