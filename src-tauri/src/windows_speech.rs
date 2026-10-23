//! Portable classic SAPI. COM objects stay on one owned worker thread.
//! Capability probes never select an audio input; only explicit start opens capture.
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use windows::{
    core::{IUnknown, Interface, PCWSTR, PWSTR},
    Win32::{Media::Speech::*, System::Com::*},
};
const CANCEL: u8 = 2;
const END: u8 = 1;
#[derive(Default)]
pub struct WindowsSpeech {
    state: Mutex<State>,
    probes: AtomicUsize,
}
#[derive(Default)]
struct State {
    closing: bool,
    active: Option<Arc<Job>>,
    canceled: VecDeque<String>,
}
struct Job {
    id: String,
    signal: AtomicU8,
    done: AtomicBool,
    result: Mutex<Option<Result<String, String>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}
impl WindowsSpeech {
    pub async fn capability(self: &Arc<Self>) -> Result<Value, String> {
        {
            let state = self.state.lock().unwrap();
            if state.closing {
                return Err("application-closing".into());
            }
            if self.probes.load(Ordering::SeqCst) > 0 || state.active.is_some() {
                return Err("speech-busy".into());
            }
            self.probes.fetch_add(1, Ordering::SeqCst);
        }
        let owner = self.clone();
        let available = tokio::task::spawn_blocking(move || {
            let _guard = ProbeGuard(owner);
            probe()
        })
        .await
        .map_err(|_| "speech-platform-failed")?;
        Ok(
            json!({"platform":"windows","onDeviceAvailable":available,"serviceAvailable":false,"permissionGranted":true,"cloudConsentRequired":true}),
        )
    }
    pub fn permission(&self, id: &str) -> Result<Value, String> {
        validate_id(id)?;
        let state = self.state.lock().unwrap();
        if state.closing {
            return Err("application-closing".into());
        }
        Ok(json!({"granted":!state.canceled.iter().any(|old|old==id)}))
    }
    pub async fn start(&self, id: String, language: String) -> Result<Value, String> {
        validate_id(&id)?;
        let language = language_filter(&language)?;
        let job = Arc::new(Job {
            id: id.clone(),
            signal: AtomicU8::new(0),
            done: AtomicBool::new(false),
            result: Mutex::new(None),
            thread: Mutex::new(None),
        });
        {
            let mut state = self.state.lock().unwrap();
            if state.closing {
                return Err("application-closing".into());
            }
            if state.canceled.iter().any(|old| old == &id) {
                return Err("speech-canceled".into());
            }
            if state.active.is_some() {
                return Err("speech-busy".into());
            }
            state.active = Some(job.clone());
            let worker = job.clone();
            match std::thread::Builder::new()
                .name("genx-speech".into())
                .spawn(move || {
                    let result = std::panic::catch_unwind(|| recognize(&worker, &language, None))
                        .unwrap_or_else(|_| Err("speech-platform-failed".into()));
                    *worker.result.lock().unwrap() = Some(result);
                    worker.done.store(true, Ordering::Release);
                }) {
                Ok(handle) => *job.thread.lock().unwrap() = Some(handle),
                Err(_) => {
                    state.active = None;
                    return Err("speech-platform-failed".into());
                }
            }
        }
        let result = wait(&job, Duration::from_secs(20)).await;
        if !job.done.load(Ordering::Acquire) {
            job.signal.store(CANCEL, Ordering::SeqCst);
        }
        if job.done.load(Ordering::Acquire) {
            self.release(&job)?;
        }
        result.map(|text|json!({"requestId":id,"text":text,"provider":"windows-sapi-local","cloudPossible":false}))
    }
    pub fn background(&self) {
        if let Some(job) = &self.state.lock().unwrap().active {
            job.signal.store(CANCEL, Ordering::SeqCst);
        }
    }
    pub fn end(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        let state = self.state.lock().unwrap();
        if let Some(job) = &state.active {
            if job.id != id {
                return Err("speech-owner-mismatch".into());
            }
            job.signal
                .compare_exchange(0, END, Ordering::SeqCst, Ordering::SeqCst)
                .ok();
        }
        Ok(())
    }
    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        let job = {
            let mut state = self.state.lock().unwrap();
            if !state.canceled.iter().any(|old| old == id) {
                if state.canceled.len() >= 128 {
                    state.canceled.pop_front();
                }
                state.canceled.push_back(id.into());
            }
            state.active.as_ref().filter(|job| job.id == id).cloned()
        };
        if let Some(job) = job {
            job.signal.store(CANCEL, Ordering::SeqCst);
            let _ = wait(&job, Duration::from_secs(2)).await;
            self.release(&job)?;
        }
        Ok(())
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        let job = {
            let mut state = self.state.lock().unwrap();
            state.closing = true;
            state.active.clone()
        };
        if let Some(job) = job {
            job.signal.store(CANCEL, Ordering::SeqCst);
            let _ = wait(&job, Duration::from_secs(2)).await;
            self.release(&job)?;
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while self.probes.load(Ordering::SeqCst) > 0 {
            if Instant::now() >= deadline {
                return Err("speech-stop-unconfirmed".into());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Ok(())
    }
    fn release(&self, job: &Arc<Job>) -> Result<(), String> {
        if !job.done.load(Ordering::Acquire) {
            return Err("speech-stop-unconfirmed".into());
        }
        if let Some(handle) = job.thread.lock().unwrap().take() {
            handle.join().map_err(|_| "speech-stop-unconfirmed")?;
        }
        if job
            .result
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|result| matches!(result,Err(reason) if reason=="speech-stop-unconfirmed"))
        {
            return Err("speech-stop-unconfirmed".into());
        }
        let mut state = self.state.lock().unwrap();
        if state
            .active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, job))
        {
            state.active = None;
            if !state.canceled.iter().any(|id| id == &job.id) {
                if state.canceled.len() >= 128 {
                    state.canceled.pop_front();
                }
                state.canceled.push_back(job.id.clone());
            }
        }
        Ok(())
    }
}
struct ProbeGuard(Arc<WindowsSpeech>);
impl Drop for ProbeGuard {
    fn drop(&mut self) {
        self.0.probes.fetch_sub(1, Ordering::SeqCst);
    }
}
async fn wait(job: &Job, budget: Duration) -> Result<String, String> {
    let until = Instant::now() + budget;
    while !job.done.load(Ordering::Acquire) {
        if Instant::now() >= until {
            return Err("speech-stop-unconfirmed".into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    job.result
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| Err("speech-platform-failed".into()))
}
fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Err("speech-invalid-request".into())
    } else {
        Ok(())
    }
}
fn language_filter(language: &str) -> Result<String, String> {
    let lcid = match language.to_ascii_lowercase().as_str() {
        "en-us" => 0x409,
        "en-gb" => 0x809,
        "de-de" => 0x407,
        "fr-fr" => 0x40c,
        "es-es" => 0xc0a,
        "it-it" => 0x410,
        "ja-jp" => 0x411,
        "zh-cn" => 0x804,
        _ => return Err("speech-language-unsupported".into()),
    };
    Ok(format!("Language={lcid:X}"))
}
struct Apartment;
impl Apartment {
    unsafe fn enter() -> Result<Self, String> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|_| "speech-provider-unavailable")?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}
unsafe fn recognizer(filter: &str) -> Result<ISpRecognizer, String> {
    unsafe {
        let category: ISpObjectTokenCategory =
            CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_INPROC_SERVER)
                .map_err(|_| "speech-provider-unavailable")?;
        category
            .SetId(SPCAT_RECOGNIZERS, false)
            .map_err(|_| "speech-provider-unavailable")?;
        let wide: Vec<u16> = filter.encode_utf16().chain(Some(0)).collect();
        let tokens = category
            .EnumTokens(PCWSTR(wide.as_ptr()), PCWSTR::null())
            .map_err(|_| "speech-provider-unavailable")?;
        let mut count = 0;
        tokens
            .GetCount(&mut count)
            .map_err(|_| "speech-provider-unavailable")?;
        for i in 0..count.min(16) {
            let Ok(token) = tokens.Item(i) else { continue };
            if !trusted_token(&token) {
                continue;
            }
            let attempt = (|| -> windows::core::Result<ISpRecognizer> {
                let reco: ISpRecognizer =
                    CoCreateInstance(&SpInprocRecognizer, None, CLSCTX_INPROC_SERVER)?;
                reco.SetRecognizer(&token)?;
                reco.SetRecoState(SPRST_INACTIVE)?;
                Ok(reco)
            })();
            if let Ok(reco) = attempt {
                return Ok(reco);
            }
        }
        Err("speech-language-unavailable".into())
    }
}
// Generic SAPI can load third-party/cloud engines. Admit only the reviewed local
// Microsoft desktop SR8 implementation; unknown providers fail closed.
fn reviewed_engine(clsid: &str, vendor: &str, name: &str) -> bool {
    clsid.eq_ignore_ascii_case("{DAC9F469-0C67-4643-9258-87EC128C5941}")
        && vendor == "Microsoft"
        && name.starts_with("MS-")
        && name.ends_with("-DESK")
}
unsafe fn key_text(key: &ISpDataKey, name: PCWSTR) -> Option<String> {
    unsafe {
        let pointer = key.GetStringValue(name).ok()?;
        if pointer.is_null() {
            return None;
        }
        let mut len = 0;
        while len <= 256 && *pointer.0.add(len) != 0 {
            len += 1;
        }
        let result = if len > 256 {
            None
        } else {
            String::from_utf16(std::slice::from_raw_parts(pointer.0, len)).ok()
        };
        CoTaskMemFree(Some(pointer.0.cast()));
        result
    }
}
unsafe fn trusted_token(token: &ISpObjectToken) -> bool {
    unsafe {
        let Some(clsid) = key_text(token, windows::core::w!("CLSID")) else {
            return false;
        };
        let Ok(attributes) = token.OpenKey(windows::core::w!("Attributes")) else {
            return false;
        };
        let Some(vendor) = key_text(&attributes, windows::core::w!("Vendor")) else {
            return false;
        };
        let Some(name) = key_text(&attributes, windows::core::w!("Name")) else {
            return false;
        };
        reviewed_engine(&clsid, &vendor, &name)
    }
}
fn probe() -> bool {
    unsafe {
        let Ok(_apartment) = Apartment::enter() else {
            return false;
        };
        let Ok(reco) = recognizer("") else {
            return false;
        };
        let Ok(context) = reco.CreateRecoContext() else {
            return false;
        };
        let Ok(grammar) = context.CreateGrammar(1) else {
            return false;
        };
        grammar.LoadDictation(PCWSTR::null(), SPLO_STATIC).is_ok()
            && grammar.SetDictationState(SPRS_INACTIVE).is_ok()
    }
}
fn recognize(
    job: &Job,
    filter: &str,
    input_path: Option<&std::path::Path>,
) -> Result<String, String> {
    unsafe {
        let _apartment = Apartment::enter()?;
        if job.signal.load(Ordering::SeqCst) == CANCEL {
            return Err("speech-canceled".into());
        }
        let reco = recognizer(filter)?;
        let context = reco
            .CreateRecoContext()
            .map_err(|_| "speech-provider-unavailable")?;
        let grammar = context
            .CreateGrammar(1)
            .map_err(|_| "speech-provider-unavailable")?;
        grammar
            .LoadDictation(PCWSTR::null(), SPLO_STATIC)
            .map_err(|_| "speech-language-unavailable")?;
        let interest = (1u64 << 38) | (1u64 << 30) | (1u64 << 33);
        context
            .SetInterest(interest, interest)
            .map_err(|_| "speech-platform-failed")?;
        if job.signal.load(Ordering::SeqCst) == CANCEL {
            return Err("speech-canceled".into());
        }
        // No automatic/default input: selecting this device happens only in explicit start.
        let mut file_input = None;
        let input: IUnknown = if let Some(path) = input_path {
            let file: ISpeechFileStream =
                CoCreateInstance(&SpFileStream, None, CLSCTX_INPROC_SERVER)
                    .map_err(|_| "speech-provider-unavailable")?;
            file.Open(
                &windows::core::BSTR::from(path.to_string_lossy().as_ref()),
                SSFMOpenForRead,
                windows::Win32::Foundation::VARIANT_FALSE,
            )
            .map_err(|_| "speech-provider-unavailable")?;
            let input = file.cast().map_err(|_| "speech-provider-unavailable")?;
            file_input = Some(file);
            input
        } else {
            let audio: ISpAudio = CoCreateInstance(&SpMMAudioIn, None, CLSCTX_INPROC_SERVER)
                .map_err(|_| "speech-permission-denied")?;
            audio.cast().map_err(|_| "speech-provider-unavailable")?
        };
        reco.SetInput(&input, true)
            .map_err(|_| "speech-permission-denied")?;
        grammar
            .SetDictationState(SPRS_ACTIVE)
            .map_err(|_| "speech-platform-failed")?;
        if let Err(error) = reco.SetRecoState(SPRST_ACTIVE_ALWAYS) {
            grammar.SetDictationState(SPRS_INACTIVE).ok();
            return Err(if error.code().0 == 0x80070005u32 as i32 {
                "speech-permission-denied"
            } else {
                "speech-provider-unavailable"
            }
            .into());
        }
        let result = (|| -> Result<String, String> {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut ended = None;
            loop {
                let signal = job.signal.load(Ordering::SeqCst);
                if signal == CANCEL {
                    return Err("speech-canceled".into());
                }
                if Instant::now() >= deadline {
                    return Err("speech-timeout".into());
                }
                if signal == END && ended.is_none() {
                    reco.SetRecoState(SPRST_INACTIVE)
                        .map_err(|_| "speech-stop-unconfirmed")?;
                    ended = Some(Instant::now());
                }
                let mut event = SPEVENT::default();
                let mut count = 0;
                context
                    .GetEvents(1, &mut event, &mut count)
                    .map_err(|_| "speech-platform-failed")?;
                if count > 0 {
                    if let Some(text) = event_text(event)? {
                        return Ok(text);
                    }
                }
                if ended.is_some_and(|time| time.elapsed() >= Duration::from_millis(700)) {
                    return Err("speech-no-match".into());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        })();
        // Stop and release all COM/audio ownership before the worker publishes its result.
        let recognizer_stopped = reco.SetRecoState(SPRST_INACTIVE_WITH_PURGE).is_ok();
        let grammar_stopped = grammar.SetDictationState(SPRS_INACTIVE).is_ok();
        let stopped = recognizer_stopped && grammar_stopped;
        drop(grammar);
        drop(context);
        drop(reco);
        drop(input);
        if let Some(file) = file_input {
            file.Close().map_err(|_| "speech-stop-unconfirmed")?;
        }
        if !stopped {
            return Err("speech-stop-unconfirmed".into());
        }
        result
    }
}
unsafe fn event_text(event: SPEVENT) -> Result<Option<String>, String> {
    unsafe {
        let id = (event._bitfield as u32 & 0xffff) as i32;
        let kind = ((event._bitfield as u32 >> 16) & 0xffff) as i32;
        if event.lParam.0 == 0 {
            return Ok(None);
        }
        if kind == SPET_LPARAM_IS_OBJECT.0 || kind == SPET_LPARAM_IS_TOKEN.0 {
            // GetEvents transfers one owned reference, released even on unrelated/error events.
            let object = IUnknown::from_raw(event.lParam.0 as *mut _);
            if id != SPEI_RECOGNITION.0 {
                return Ok(None);
            }
            let result: ISpRecoResult = object.cast().map_err(|_| "speech-platform-failed")?;
            let mut text = PWSTR::null();
            result
                .GetText(0, u32::MAX, true, &mut text, None)
                .map_err(|_| "speech-platform-failed")?;
            if text.is_null() {
                return Err("speech-no-match".into());
            }
            let mut len = 0;
            while len <= 512 && *text.0.add(len) != 0 {
                len += 1;
            }
            let value: Result<String, String> = if len > 512 {
                Err("speech-result-too-large".into())
            } else {
                String::from_utf16(std::slice::from_raw_parts(text.0, len))
                    .map_err(|_| "speech-recognition-failed".into())
            };
            CoTaskMemFree(Some(text.0.cast()));
            let value: String = value?;
            if value.trim().is_empty() {
                return Err("speech-no-match".into());
            }
            Ok(Some(value))
        } else {
            if kind == SPET_LPARAM_IS_POINTER.0 || kind == SPET_LPARAM_IS_STRING.0 {
                CoTaskMemFree(Some(event.lParam.0 as *const _));
            }
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job(id: &str) -> Arc<Job> {
        Arc::new(Job {
            id: id.into(),
            signal: AtomicU8::new(0),
            done: AtomicBool::new(false),
            result: Mutex::new(None),
            thread: Mutex::new(None),
        })
    }
    #[tokio::test]
    async fn precancel_and_closed_owner_never_open_audio() {
        let manager = WindowsSpeech::default();
        manager.cancel("before").await.unwrap();
        assert_eq!(
            manager
                .start("before".into(), "en-US".into())
                .await
                .unwrap_err(),
            "speech-canceled"
        );
        manager.shutdown().await.unwrap();
        assert_eq!(
            manager
                .start("late".into(), "en-US".into())
                .await
                .unwrap_err(),
            "application-closing"
        );
    }
    #[tokio::test]
    async fn cancel_waits_for_worker_and_stale_cancel_cannot_stop_current() {
        let manager = WindowsSpeech::default();
        let owned = job("current");
        manager.state.lock().unwrap().active = Some(owned.clone());
        manager.cancel("old").await.unwrap();
        assert_eq!(owned.signal.load(Ordering::SeqCst), 0);
        let worker = owned.clone();
        let handle = std::thread::spawn(move || {
            while worker.signal.load(Ordering::SeqCst) != CANCEL {
                std::thread::sleep(Duration::from_millis(1));
            }
            std::thread::sleep(Duration::from_millis(40));
            *worker.result.lock().unwrap() = Some(Err("speech-canceled".into()));
            worker.done.store(true, Ordering::Release);
        });
        *owned.thread.lock().unwrap() = Some(handle);
        manager.cancel("current").await.unwrap();
        assert!(owned.done.load(Ordering::Acquire));
        assert!(manager.state.lock().unwrap().active.is_none());
    }
    #[tokio::test]
    async fn unconfirmed_cleanup_retains_owner_and_refuses_new_input() {
        let manager = WindowsSpeech::default();
        let owned = job("unconfirmed");
        *owned.result.lock().unwrap() = Some(Err("speech-stop-unconfirmed".into()));
        owned.done.store(true, Ordering::Release);
        manager.state.lock().unwrap().active = Some(owned);
        assert_eq!(
            manager.cancel("unconfirmed").await.unwrap_err(),
            "speech-stop-unconfirmed"
        );
        assert_eq!(
            manager
                .start("new-input".into(), "en-US".into())
                .await
                .unwrap_err(),
            "speech-busy"
        );
        assert!(manager.state.lock().unwrap().active.is_some());
    }
    #[tokio::test]
    async fn background_cancels_only_owned_capture_and_probes_are_bounded() {
        let manager = Arc::new(WindowsSpeech::default());
        manager.probes.store(1, Ordering::SeqCst);
        assert_eq!(manager.capability().await.unwrap_err(), "speech-busy");
        manager.probes.store(0, Ordering::SeqCst);
        let owned = job("foreground");
        manager.state.lock().unwrap().active = Some(owned.clone());
        manager.background();
        assert_eq!(owned.signal.load(Ordering::SeqCst), CANCEL);
    }
    #[test]
    fn unknown_or_cloud_engine_is_never_admitted_as_local() {
        assert!(reviewed_engine(
            "{DAC9F469-0C67-4643-9258-87EC128C5941}",
            "Microsoft",
            "MS-1033-80-DESK"
        ));
        assert!(reviewed_engine(
            "{dac9f469-0c67-4643-9258-87ec128c5941}",
            "Microsoft",
            "MS-1031-80-DESK"
        ));
        assert!(!reviewed_engine("unknown", "Microsoft", "MS-1033-80-DESK"));
        assert!(!reviewed_engine(
            "{DAC9F469-0C67-4643-9258-87EC128C5941}",
            "CloudVendor",
            "MS-1033-80-DESK"
        ));
        assert!(!reviewed_engine(
            "{DAC9F469-0C67-4643-9258-87EC128C5941}",
            "Microsoft",
            "Cloud-recognizer"
        ));
    }
    #[test]
    fn unsupported_language_and_ids_fail_before_com() {
        assert!(validate_id("a/b").is_err());
        assert!(validate_id(&"a".repeat(129)).is_err());
        assert_eq!(language_filter("en-US").unwrap(), "Language=409");
        assert!(language_filter("unknown").is_err());
    }
    #[test]
    #[ignore = "real installed offline engine and file fixture, no microphone; run explicitly"]
    fn actual_sapi_file_recognition_and_cleanup() {
        unsafe {
            let path =
                std::env::temp_dir().join(format!("genx-sapi-fixture-{}.wav", std::process::id()));
            {
                let _apartment = Apartment::enter().unwrap();
                let file: ISpeechFileStream =
                    CoCreateInstance(&SpFileStream, None, CLSCTX_INPROC_SERVER).unwrap();
                file.Open(
                    &windows::core::BSTR::from(path.to_string_lossy().as_ref()),
                    SSFMCreateForWrite,
                    windows::Win32::Foundation::VARIANT_FALSE,
                )
                .unwrap();
                let voice: ISpVoice =
                    CoCreateInstance(&SpVoice, None, CLSCTX_INPROC_SERVER).unwrap();
                voice.SetOutput(&file, true).unwrap();
                voice
                    .Speak(windows::core::w!("Chicago Bears"), 0, None)
                    .unwrap();
                drop(voice);
                file.Close().unwrap();
            }
            let owned = job("file-proof");
            let result = recognize(&owned, "Language=409", Some(&path));
            std::fs::remove_file(&path).unwrap();
            let text = result.unwrap();
            assert!(
                text.to_lowercase().contains("chicago"),
                "actual transcript: {text}"
            );
            assert!(
                text.to_lowercase().contains("bears"),
                "actual transcript: {text}"
            );
            println!(
                "SAPI file-only transcript: {text}; microphoneOpened=false; fixtureRemoved=true"
            );
        }
    }
}
