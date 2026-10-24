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

//! Which GenX package fits a receiving device (docs/share-links.md SH-009,
//! SH-011, SH-019, SH-020). The receiving device decides; a browser only
//! claims what it is (its user agent), so the answer is one of three:
//! it fits, it cannot run here, or it cannot be told (say so, let them choose).

/// What a browser says it is. A claim, never proof of the CPU architecture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Receiver {
    Android,
    Windows,
    /// iPhone, iPad or Mac: no GenX build exists for them.
    Apple,
    Unknown,
}

/// The kinds of package GenX can hand over.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Package {
    /// The universal Android APK (arm64-v8a and armeabi-v7a, Android 7.0+).
    AndroidUniversal,
    /// An APK with only the 64-bit ARM library (development comparison builds).
    AndroidArm64,
    // Served by Windows copies only (and named by the tests).
    #[cfg_attr(target_os = "android", allow(dead_code))]
    WindowsExe,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Fit {
    Fits,
    /// Offer it with its requirements stated plainly (SH-011, SH-020).
    Uncertain,
    /// Never offered (SH-009, SH-019).
    Incompatible,
}

/// Reads a browser's user agent (bounded; anything odd is Unknown).
pub(crate) fn receiver(user_agent: &str) -> Receiver {
    let ua = user_agent.get(..512).unwrap_or(user_agent);
    if ua.contains("Android") {
        Receiver::Android
    } else if ["iPhone", "iPad", "iPod", "Macintosh", "Mac OS X"]
        .iter()
        .any(|word| ua.contains(word))
    {
        Receiver::Apple
    } else if ua.contains("Windows NT") {
        Receiver::Windows
    } else {
        Receiver::Unknown
    }
}

/// Whether `package` may be offered to a device that says it is `receiver`.
pub(crate) fn fit(package: Package, receiver: Receiver) -> Fit {
    match (package, receiver) {
        // ARM phones and TVs are covered by both libraries; an x86 Android
        // device cannot be told apart by a browser, so the requirements are shown.
        (Package::AndroidUniversal, Receiver::Android) => Fit::Fits,
        // A 32-bit-only phone cannot run it, and a browser cannot say which it is.
        (Package::AndroidArm64, Receiver::Android) => Fit::Uncertain,
        (Package::WindowsExe, Receiver::Windows) => Fit::Fits,
        (_, Receiver::Unknown) => Fit::Uncertain,
        _ => Fit::Incompatible,
    }
}

/// What the person is told the package needs.
pub(crate) fn requirements(package: Package) -> &'static str {
    match package {
        Package::AndroidUniversal => {
            "GenX Streamer for Android 7.0 or newer on ARM phones, tablets and TVs (32- and 64-bit)."
        }
        Package::AndroidArm64 => {
            "GenX Streamer for Android 7.0 or newer on 64-bit ARM phones, tablets and TVs."
        }
        Package::WindowsExe => {
            "GenX Streamer for 64-bit Windows 10 or 11 with the Microsoft Edge WebView2 Runtime."
        }
    }
}

pub(crate) fn platform(package: Package) -> &'static str {
    match package {
        Package::AndroidUniversal | Package::AndroidArm64 => "Android",
        Package::WindowsExe => "Windows",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PIXEL: &str =
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile";
    const SAMSUNG: &str =
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 SamsungBrowser/29.0 Chrome/138 Mobile";
    const IPHONE: &str =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
    const IPAD: &str =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0";
    const WINDOWS: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/140";
    const LINUX: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

    #[test]
    fn browsers_are_read_as_what_they_claim() {
        assert_eq!(receiver(PIXEL), Receiver::Android);
        assert_eq!(receiver(SAMSUNG), Receiver::Android);
        assert_eq!(receiver(IPHONE), Receiver::Apple);
        // iPadOS asks for desktop pages as a Mac: still no GenX build for it.
        assert_eq!(receiver(IPAD), Receiver::Apple);
        assert_eq!(receiver(WINDOWS), Receiver::Windows);
        assert_eq!(receiver(LINUX), Receiver::Unknown);
        assert_eq!(receiver(""), Receiver::Unknown);
        assert_eq!(receiver(&"x".repeat(10_000)), Receiver::Unknown);
    }

    #[test]
    fn every_package_and_device_has_one_answer() {
        use Fit::*;
        let table = [
            (Package::AndroidUniversal, Receiver::Android, Fits),
            (Package::AndroidUniversal, Receiver::Windows, Incompatible),
            (Package::AndroidUniversal, Receiver::Apple, Incompatible),
            (Package::AndroidUniversal, Receiver::Unknown, Uncertain),
            (Package::AndroidArm64, Receiver::Android, Uncertain),
            (Package::AndroidArm64, Receiver::Windows, Incompatible),
            (Package::AndroidArm64, Receiver::Apple, Incompatible),
            (Package::AndroidArm64, Receiver::Unknown, Uncertain),
            (Package::WindowsExe, Receiver::Windows, Fits),
            (Package::WindowsExe, Receiver::Android, Incompatible),
            (Package::WindowsExe, Receiver::Apple, Incompatible),
            (Package::WindowsExe, Receiver::Unknown, Uncertain),
        ];
        for (package, device, expected) in table {
            assert_eq!(fit(package, device), expected, "{package:?} to {device:?}");
        }
    }
}
