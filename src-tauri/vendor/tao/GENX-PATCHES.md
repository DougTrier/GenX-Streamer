# Android IPC event delivery backports

This is the complete published Tao **0.35.0** crate, including its original Apache-2.0 licenses. Its registry archive SHA-256 is `1cf65722394c2ac443e80120064987f8914ee1d4e4e36e63cdf10f2990f01159`, matching the project's original Cargo.lock. `GENX-PATCH-PROVENANCE.json` records the original hash of every archive file.

Only `src/platform_impl/android/mod.rs` differs from that archive. Two upstream fixes are adapted to the existing 0.35.0 event-handler macro:

- [Tao PR 1271](https://github.com/tauri-apps/tao/pull/1271): enqueue with `send` before waking the looper. The original channel is unbounded; this does not add a capacity wait. Related [Tauri issue 14994](https://github.com/tauri-apps/tauri/issues/14994) reports IPC responses waiting for another IPC message.
- [Tao PR 1304](https://github.com/tauri-apps/tao/pull/1304): drain pending user events after every poll iteration, even when an Android file-descriptor event takes priority over the wake indication. This is the upstream fix for first-IPC startup hangs.

The official [Tao release notes](https://github.com/tauri-apps/tao/releases) include the fixes in 0.36.0 and 0.37.0 respectively. Those versions also change Android JNI lifecycle names. This backport retains the locked API/JNI contract and every non-Android byte instead of upgrading the surrounding Tauri runtime.

`[patch.crates-io]` in the application Cargo.toml selects this source. Package evidence must hash the entire vendored tree. Tests at `tests/tooling/test_android_event_loop_patch.py` verify the registry-file inventory, reverse both allowed changes to reproduce the original source hash, and exercise a deterministic mixed-poll queue model tied to the source's unconditional drain. Model tests do not prove Android scheduling or physical startup; actual cold startup and normal coordinated exit remain required on the new APK. No dummy IPC, periodic wake loop, timeout increase, or dropped listener promise is introduced.
