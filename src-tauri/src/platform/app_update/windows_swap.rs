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

//! Replacing the portable GenX Streamer.exe (docs/updates.md). A running exe
//! cannot be overwritten, but Windows lets it be renamed: the verified new
//! file is copied beside it as GenX Streamer.exe.new, the running one becomes
//! GenX Streamer.exe.old, and the new one takes its name. If any step fails,
//! the old exe gets its name back, so GenX still starts (UP-007). Nothing
//! else in the folder is touched: tmg-portable.flag and the data folder stay
//! (UP-008). The .old file is removed at the next start.
//!
//! Restart (only when the viewer chooses it) starts the new exe after an
//! ordinary exit; the new process first waits for this one to end, so the
//! saved data has one owner at a time.
use super::*;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

const PACKAGED_NAME: &str = "GenX Streamer.exe";
const AFTER_UPDATE: &str = "--genx-after-update";
/// A Restart is honored only by an exit that follows it promptly.
const RELAUNCH_WINDOW: Duration = Duration::from_secs(120);

static RELAUNCH: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

fn sibling(exe: &Path, suffix: &str) -> PathBuf {
    exe.with_file_name(format!("{PACKAGED_NAME}{suffix}"))
}

pub(crate) fn rename(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)
}

/// Puts the verified file in place of `exe`; on failure the old exe keeps its name.
pub(crate) fn install(
    staged: &Path,
    exe: &Path,
    sha256: &str,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    if exe.file_name().and_then(|name| name.to_str()) != Some(PACKAGED_NAME) {
        return Err("update-development-build".into());
    }
    let new = sibling(exe, ".new");
    let old = sibling(exe, ".old");
    if old.exists() && std::fs::remove_file(&old).is_err() {
        // The previous update's old exe is still in use: restart first.
        return Err("update-restart-pending".into());
    }
    let _ = std::fs::remove_file(&new);
    std::fs::copy(staged, &new).map_err(|_| "update-folder-read-only".to_string())?;
    let fail = |code: &str| {
        let _ = std::fs::remove_file(&new);
        code.to_string()
    };
    // Flushing needs a handle that may write.
    std::fs::OpenOptions::new()
        .write(true)
        .open(&new)
        .and_then(|file| file.sync_all())
        .map_err(|_| fail("update-folder-read-only"))?;
    if hash_file(&new)? != sha256 {
        return Err(fail("update-digest-mismatch"));
    }
    rename(exe, &old).map_err(|_| fail("update-in-use"))?;
    if rename(&new, exe).is_err() {
        // Roll back: the running version keeps its name and starts next time.
        let restored = rename(&old, exe).is_ok();
        let _ = std::fs::remove_file(&new);
        return Err(if restored {
            "update-install-failed".into()
        } else {
            "update-install-incomplete".into()
        });
    }
    Ok(())
}

/// At start-up: removes the exe an earlier update replaced, when it is free.
pub(crate) fn remove_previous() {
    if let Ok(exe) = std::env::current_exe() {
        if exe.file_name().and_then(|name| name.to_str()) == Some(PACKAGED_NAME) {
            let _ = std::fs::remove_file(sibling(&exe, ".old"));
        }
    }
}

/// The viewer chose Restart after Install.
pub(crate) fn request_relaunch() {
    if let Ok(mut pending) = RELAUNCH.get_or_init(|| Mutex::new(None)).lock() {
        *pending = Some(Instant::now());
    }
}

/// The process id a relaunched GenX waits for (`--genx-after-update <pid>`).
pub(crate) fn waited_process(arguments: impl IntoIterator<Item = String>) -> Option<u32> {
    let mut arguments = arguments.into_iter().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == AFTER_UPDATE {
            return arguments
                .next()
                .and_then(|pid| pid.parse().ok())
                .filter(|pid| *pid != 0);
        }
    }
    None
}

/// Called by an ordinary exit that has finished: starts the new exe if the
/// viewer chose Restart (moments ago) after installing.
pub(crate) fn relaunch_after_exit() {
    let chosen = RELAUNCH
        .get()
        .and_then(|pending| pending.lock().ok().and_then(|mut pending| pending.take()))
        .is_some_and(|at| at.elapsed() <= RELAUNCH_WINDOW);
    if !chosen {
        return;
    }
    if let Ok(exe) = std::env::current_exe() {
        // The packaged name, which the new exe now has (whatever Windows reports for this one).
        let _ = std::process::Command::new(sibling(&exe, ""))
            .arg(AFTER_UPDATE)
            .arg(std::process::id().to_string())
            .spawn();
    }
}

/// Before anything else in a relaunched GenX: waits (at most a minute) for
/// the previous process to end.
pub(crate) fn after_update_wait() {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
    const SYNCHRONIZE: u32 = 0x0010_0000;
    let Some(pid) = waited_process(std::env::args()) else {
        return;
    };
    unsafe {
        let process = OpenProcess(SYNCHRONIZE, 0, pid);
        if !process.is_null() {
            WaitForSingleObject(process, 60_000);
            CloseHandle(process);
        }
    }
}
