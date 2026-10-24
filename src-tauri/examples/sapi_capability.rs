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

#[cfg(windows)]
fn main() {
    use windows::{
        core::PCWSTR,
        Win32::{Media::Speech::*, System::Com::*},
    };
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }
    // Dedicated process/apartment; no input device or active recognition is selected.
    let result = (|| -> windows::core::Result<(u32, u32)> {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
            let _apartment = Apartment;
            let category: ISpObjectTokenCategory =
                CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_INPROC_SERVER)?;
            category.SetId(SPCAT_RECOGNIZERS, false)?;
            let tokens = category.EnumTokens(PCWSTR::null(), PCWSTR::null())?;
            let mut count = 0;
            tokens.GetCount(&mut count)?;
            let mut available = 0;
            for i in 0..count.min(16) {
                let probe = (|| -> windows::core::Result<()> {
                    let recognizer: ISpRecognizer =
                        CoCreateInstance(&SpInprocRecognizer, None, CLSCTX_INPROC_SERVER)?;
                    recognizer.SetRecognizer(&tokens.Item(i)?)?;
                    recognizer.SetRecoState(SPRST_INACTIVE)?;
                    let context = recognizer.CreateRecoContext()?;
                    let grammar = context.CreateGrammar(1)?;
                    grammar.LoadDictation(PCWSTR::null(), SPLO_STATIC)?;
                    grammar.SetDictationState(SPRS_INACTIVE)?;
                    Ok(())
                })();
                if probe.is_ok() {
                    available += 1;
                }
            }
            Ok((count, available))
        }
    })();
    match result {
        Ok((count, available)) => {
            println!("{{\"installedTokens\":{count},\"inactiveDictationGrammars\":{available},\"microphoneOpened\":false}}")
        }
        Err(_) => {
            eprintln!("sapi-capability-unavailable");
            std::process::exit(1)
        }
    }
}
#[cfg(not(windows))]
fn main() {
    println!("sapi-windows-only")
}
