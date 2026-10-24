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

use super::*;

const PAGE: &str = "https://dougtrier.github.io/GenX-Streamer/watch/#v=1&c=ch&n=News";

#[test]
fn only_genx_links_of_bounded_printable_shape_are_admitted() {
    assert_eq!(admit_link(PAGE).as_deref(), Some(PAGE));
    assert_eq!(
        admit_link("  genx://watch?v=1&c=gx  ").as_deref(),
        Some("genx://watch?v=1&c=gx")
    );
    assert!(admit_link("GENX://watch?v=1").is_some());
    for refused in [
        "",
        "genx://settings",
        "genx:watch",
        "https://dougtrier.github.io/other/watch/",
        "https://dougtrier.github.io.example/GenX-Streamer/watch/",
        "https://example.com/GenX-Streamer/watch/",
        "http://dougtrier.github.io/GenX-Streamer/watch/",
        "file:///C:/Windows/genx://watch",
        "genx://watch?n=a\nb",
        "genx://watch?n=a b",
        "genx://watch?n=\u{7}",
        "--genx://watch",
    ] {
        assert_eq!(admit_link(refused), None, "{refused:?}");
    }
    let long = format!("genx://watch?n={}", "a".repeat(MAX_LINK));
    assert_eq!(admit_link(&long), None);
}

#[test]
fn incoming_links_are_given_out_once_and_the_newest_wins() {
    let links = IncomingLinks::default();
    assert_eq!(links.take(), None);
    links.offer("genx://watch?a".into());
    links.offer("genx://watch?b".into());
    assert_eq!(links.take().as_deref(), Some("genx://watch?b"));
    assert_eq!(links.take(), None);
}

#[test]
fn share_messages_are_bounded_and_never_empty() {
    assert!(message_fields("News 24", "Watch News 24 on GenX Streamer").is_ok());
    assert!(message_fields("", "text").is_err());
    assert!(message_fields("title", "  ").is_err());
    assert!(message_fields("title", "a\0b").is_err());
    assert!(message_fields(&"t".repeat(MAX_TITLE + 1), "text").is_err());
    assert!(message_fields("title", &"x".repeat(MAX_TEXT + 1)).is_err());
}

#[test]
fn shared_destinations_need_a_host_and_carry_no_credentials() {
    assert_eq!(
        shared_destination("https://cdn.example.com/live/index.m3u8").unwrap(),
        ("cdn.example.com".to_string(), 443)
    );
    assert_eq!(
        shared_destination("http://203.0.113.9:8080/a.ts").unwrap(),
        ("203.0.113.9".to_string(), 8080)
    );
    assert_eq!(
        shared_destination("https://[2001:4860::8888]/a.m3u8")
            .unwrap()
            .0,
        "2001:4860::8888"
    );
    for refused in [
        "ftp://cdn.example.com/a.ts",
        "https://user:secret@cdn.example.com/a.m3u8",
        "https://user@cdn.example.com/a.m3u8",
        "file:///C:/a.ts",
        "https://cdn.example.com/a b.m3u8",
        "not a url",
    ] {
        assert_eq!(
            shared_destination(refused).unwrap_err(),
            "share-destination-invalid",
            "{refused}"
        );
    }
}

#[test]
fn every_resolved_address_must_be_public() {
    let public: SocketAddr = "8.8.8.8:443".parse().unwrap();
    let private: SocketAddr = "192.168.1.20:443".parse().unwrap();
    let loopback: SocketAddr = "[::1]:443".parse().unwrap();
    assert!(all_public(&[public]).is_ok());
    assert_eq!(
        all_public(&[public, private]).unwrap_err(),
        "share-destination-private"
    );
    assert_eq!(
        all_public(&[loopback]).unwrap_err(),
        "share-destination-private"
    );
    assert_eq!(all_public(&[]).unwrap_err(), "share-destination-unresolved");
    assert_eq!(
        all_public(&vec![public; 129]).unwrap_err(),
        "share-destination-unresolved"
    );
}

#[tokio::test]
async fn literal_private_destinations_are_refused_without_a_lookup() {
    for refused in [
        "http://127.0.0.1/a.ts",
        "http://10.0.0.8/live.m3u8",
        "https://[fe80::1]/a.m3u8",
        "http://169.254.169.254/latest",
    ] {
        assert_eq!(
            check_shared_destination(refused.into()).await.unwrap_err(),
            "share-destination-private",
            "{refused}"
        );
    }
}

#[cfg(windows)]
mod windows {
    use super::super::windows_links::*;
    use super::super::windows_share::first_link;
    use windows_sys::Win32::System::Registry::{
        RegDeleteKeyW, RegDeleteTreeW, RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    #[test]
    fn the_link_argument_is_found_after_the_program_name() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            link_argument(args(&["GenX Streamer.exe", "genx://watch?v=1"])).as_deref(),
            Some("genx://watch?v=1")
        );
        assert_eq!(link_argument(args(&["genx://watch?v=1"])), None);
        assert_eq!(
            link_argument(args(&[
                "GenX Streamer.exe",
                "--flag",
                "https://example.com"
            ])),
            None
        );
    }

    #[test]
    fn each_data_profile_has_its_own_inbox() {
        assert_eq!(inbox_class(None), "GenXStreamerLinkInbox");
        let a = inbox_class(Some(std::ffi::OsStr::new(r"N:\profiles\a")));
        let b = inbox_class(Some(std::ffi::OsStr::new(r"N:\profiles\b")));
        assert!(a.starts_with("GenXStreamerLinkInbox-") && a.len() == 34);
        assert_ne!(a, b);
    }

    #[test]
    fn only_our_copied_links_are_taken() {
        let units: Vec<u16> = "genx://watch?v=1".encode_utf16().collect();
        assert_eq!(
            copied_link(0x4745_4e58, &units).as_deref(),
            Some("genx://watch?v=1")
        );
        assert_eq!(copied_link(1, &units), None);
        let other: Vec<u16> = "https://example.com".encode_utf16().collect();
        assert_eq!(copied_link(0x4745_4e58, &other), None);
        assert_eq!(copied_link(0x4745_4e58, &[0xd800]), None);
        assert_eq!(copied_link(0x4745_4e58, &[]), None);
    }

    #[test]
    fn the_share_sheet_offers_the_message_link() {
        assert_eq!(
            first_link("Watch News on GenX Streamer: https://dougtrier.github.io/x"),
            Some("https://dougtrier.github.io/x")
        );
        assert_eq!(first_link("no link here"), None);
    }

    fn read(key: &str, name: Option<&str>) -> String {
        let key = wide(key);
        let name = name.map(wide);
        let mut buffer = vec![0u16; 1024];
        let mut size = (buffer.len() * 2) as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ref().map_or(std::ptr::null(), |n| n.as_ptr()),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        assert_eq!(status, 0);
        String::from_utf16_lossy(&buffer[..(size as usize / 2).saturating_sub(1)])
    }

    #[test]
    fn the_scheme_is_written_for_the_current_user_and_opens_this_exe() {
        // A throwaway key under the test user's own hive, removed afterwards;
        // the real HKCU\Software\Classes\genx is never touched by tests.
        let root = format!(
            r"Software\GenXStreamerTest-{}\Classes\genx",
            std::process::id()
        );
        let exe = r"N:\Apps\GenX Streamer\GenX Streamer.exe";
        write_scheme(&root, exe).unwrap();
        let result = std::panic::catch_unwind(|| {
            assert_eq!(read(&root, None), "URL:GenX Streamer link");
            assert_eq!(read(&root, Some("URL Protocol")), "");
            assert_eq!(
                read(&format!(r"{root}\shell\open\command"), None),
                format!("\"{exe}\" \"%1\"")
            );
            assert_eq!(
                read(&format!(r"{root}\DefaultIcon"), None),
                format!("\"{exe}\",0")
            );
        });
        let top = wide(&format!(
            r"Software\GenXStreamerTest-{}",
            std::process::id()
        ));
        unsafe {
            RegDeleteTreeW(HKEY_CURRENT_USER, top.as_ptr());
            RegDeleteKeyW(HKEY_CURRENT_USER, top.as_ptr());
        }
        result.unwrap();
    }
}
