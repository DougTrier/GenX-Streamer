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

fn main() {
    // Tauri CLI 2.12 stopped setting this flag. The pinned tauri-build 2.6
    // still reads it to link the Visual C++ runtime into the executable.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        std::env::set_var("STATIC_VCRUNTIME", "true");
        // The Tauri IPC fixture links dialog code, but integration test
        // executables do not get Tauri's application manifest.
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
    tauri_build::build()
}
