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

//! Current-user DPAPI. No machine-wide scope, UI prompt, persistent plaintext, or fallback.
use crate::scan_candidate_manifest::{BINDING_LIMIT, CIPHER_PAGE_LIMIT, PAGE_LIMIT};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
};
use zeroize::Zeroize;
fn transform(binding: &str, input: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    if binding.is_empty()
        || binding.len() > BINDING_LIMIT
        || input.is_empty()
        || input.len()
            > if decrypt {
                CIPHER_PAGE_LIMIT
            } else {
                PAGE_LIMIT
            }
    {
        return Err("scan-manifest-protection-invalid".into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: binding.len() as u32,
        pbData: binding.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let success = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if success == 0 {
        return Err("scan-manifest-protection-unavailable".into());
    }
    let result = if output.pbData.is_null() || output.cbData == 0 {
        Err("scan-manifest-protection-invalid".into())
    } else {
        let raw = unsafe { std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize) };
        let result = if raw.len()
            > if decrypt {
                PAGE_LIMIT
            } else {
                CIPHER_PAGE_LIMIT
            } {
            Err("scan-manifest-protection-invalid".into())
        } else {
            Ok(raw.to_vec())
        };
        if decrypt {
            raw.zeroize();
        }
        result
    };
    if !output.pbData.is_null() {
        unsafe {
            LocalFree(output.pbData.cast());
        }
    }
    result
}
pub fn seal(binding: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    transform(binding, plaintext, false)
}
pub fn open(binding: &str, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    transform(binding, ciphertext, true)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_user_roundtrip_binding_tamper_and_boundaries() {
        let secret = b"synthetic public scan URL only";
        let cipher = seal("GenX.synthetic.manifest.fixture", secret).unwrap();
        assert_ne!(cipher, secret);
        assert_eq!(
            open("GenX.synthetic.manifest.fixture", &cipher).unwrap(),
            secret
        );
        assert!(open("GenX.other.manifest.fixture", &cipher).is_err());
        let mut corrupt = cipher.clone();
        let last = corrupt.len() - 1;
        corrupt[last] ^= 1;
        assert!(open("GenX.synthetic.manifest.fixture", &corrupt).is_err());
        assert!(seal("", secret).is_err());
        assert!(seal("binding", &vec![0; PAGE_LIMIT + 1]).is_err());
    }
}
