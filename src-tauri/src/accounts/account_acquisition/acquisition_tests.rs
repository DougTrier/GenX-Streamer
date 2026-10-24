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

//! Tests of Paid TV account acquisition.

use super::*;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_redirects_may_change_server_but_never_downgrade() {
        let url = |raw: &str| Url::parse(raw).unwrap();
        // An HTTP account (explicit grant) whose front door hands the sign-in
        // to the provider's real server, as smartdns -> cf.onvpn did.
        let http = "http://front.fixture.example";
        assert!(redirect_target(
            &url("http://real.fixture.example/player_api.php?username=u&password=p"),
            http
        )
        .is_ok());
        assert!(redirect_target(&url("https://real.fixture.example:8443/get.php"), http).is_ok());
        // An HTTPS account: another HTTPS server is followed, plain HTTP is not.
        let https = "https://front.fixture.example";
        assert!(redirect_target(&url("https://lb1.fixture.example/player_api.php"), https).is_ok());
        assert!(redirect_target(&url("http://lb1.fixture.example/player_api.php"), https).is_err());
        // Never a private or loopback address, embedded user info or another scheme.
        assert!(redirect_target(&url("http://192.168.1.10/player_api.php"), http).is_err());
        assert!(redirect_target(&url("http://127.0.0.1:8080/player_api.php"), http).is_err());
        assert!(redirect_target(&url("http://u:p@real.fixture.example/x"), http).is_err());
        assert!(redirect_target(&url("ftp://real.fixture.example/x"), http).is_err());
    }
    #[test]
    fn request_preserves_base_port_and_escaped_credentials() {
        let url = endpoint(
            "https://fixture.invalid:8443/provider/base",
            "player_api.php",
            "fixture user&name",
            "fixture/pass?#",
            Some("get_live_streams"),
            "https://fixture.invalid:8443",
        )
        .unwrap();
        assert_eq!(url.port(), Some(8443));
        assert_eq!(url.path(), "/provider/base/player_api.php");
        let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs.get("username").unwrap(), "fixture user&name");
        assert_eq!(pairs.get("password").unwrap(), "fixture/pass?#");
        // An HTTPS account is never downgraded, including by a redirect.
        assert!(address("http://fixture.invalid/token", "https://fixture.invalid").is_err());
        // An HTTP account (explicit grant, stored HTTP origin) keeps its exact port.
        let plain = endpoint(
            "http://fixture.invalid:8080",
            "player_api.php",
            "u",
            "p",
            None,
            "http://fixture.invalid:8080",
        )
        .unwrap();
        assert_eq!((plain.scheme(), plain.port()), ("http", Some(8080)));
        assert!(address(
            "http://fixture.invalid:8080/live/x.ts",
            "http://fixture.invalid:8080"
        )
        .is_ok());
        assert!(address(
            "http://fixture.invalid/live/x.ts",
            "http://fixture.invalid:8080"
        )
        .is_err());
        assert!(address(
            "https://fixture.invalid:8080/x",
            "http://fixture.invalid:8080"
        )
        .is_err());
        assert!(address("https://other.invalid/token", "https://fixture.invalid").is_err());
        assert!(address("https://127.0.0.1/token", "https://127.0.0.1").is_err());
    }
    #[test]
    fn authentication_status_and_expiry_are_not_network_success() {
        let active = br#"{"user_info":{"auth":1,"status":"Active","exp_date":"2000","allowed_output_formats":["ts","m3u8"],"max_connections":"1","active_cons":"0"}}"#;
        let auth = login(active, 1_000_000).unwrap();
        assert_eq!(auth.format.as_deref(), Some("ts"));
        let hls_only =
            br#"{"user_info":{"auth":1,"status":"Active","allowed_output_formats":["m3u8"]}}"#;
        assert_eq!(login(hls_only, 0).unwrap().format.as_deref(), Some("m3u8"));
        // The provider's other advertised format is kept for a fallback only.
        assert_eq!(auth.alternate.as_deref(), Some("m3u8"));
        assert_eq!(login(hls_only, 0).unwrap().alternate, None);
        let base = "http://tv.fixture.example:8080/prefix";
        let origin = "http://tv.fixture.example:8080";
        let ts = live_address(base, origin, "u", "p&w", "7", "ts").unwrap();
        let hls = live_address(base, origin, "u", "p&w", "7", "m3u8").unwrap();
        assert_eq!(ts.path(), "/prefix/live/u/p&w/7.ts");
        assert_eq!(hls.path(), "/prefix/live/u/p&w/7.m3u8");
        assert_eq!(auth.max, Some(1));
        assert!(login(active, 2_000_000).is_err());
        assert!(login(br#"{"user_info":{"auth":0,"status":"Active"}}"#, 0).is_err());
        assert!(login(br#"{"user_info":{"auth":1,"status":"Expired"}}"#, 0).is_err());
        assert!(login(
            br#"{"user_info":{"auth":1,"status":"Active","allowed_output_formats":[1]}}"#,
            0
        )
        .is_err());
    }
    #[test]
    fn stable_ids_are_account_scoped_and_metadata_refuses_secret_markers() {
        assert_eq!(
            stable("a", "xtream", &["15"]),
            stable("a", "xtream", &["15"])
        );
        assert_ne!(
            stable("a", "xtream", &["15"]),
            stable("b", "xtream", &["15"])
        );
        let secret = Secret::Playlist {
            url: "https://fixture.invalid/secret-path?token=secret-query".into(),
        };
        let policy = DisplayPolicy::new(&secret);
        assert!(policy
            .text("Visible secret-query", TEXT_LIMIT, false)
            .is_err());
        assert!(policy
            .text("Visible secret-path", TEXT_LIMIT, false)
            .is_err());
        assert_eq!(
            policy.text("Fixture Channel", TEXT_LIMIT, false).unwrap(),
            "Fixture Channel"
        );
    }
}

#[cfg(test)]
mod playlist_marker_tests {
    use super::*;
    #[test]
    fn protocol_options_are_not_secrets_but_credentials_still_are() {
        // Same shape as a provider's get.php link; placeholder credentials.
        let secret = Secret::Playlist {
            url: "http://tv.fixture.invalid:8099/get.php?username=fixtureuser&password=fixturepass&type=m3u_plus&output=ts".into(),
        };
        let policy = DisplayPolicy::new(&secret);
        for name in ["US: ESPN Sports", "Nickelodeon Hits", "M3U Plus News"] {
            assert!(policy.text(name, TEXT_LIMIT, false).is_ok(), "{name}");
        }
        for leak in ["fixtureuser live", "pw fixturepass"] {
            assert!(policy.text(leak, TEXT_LIMIT, false).is_err(), "{leak}");
        }
    }
}

#[cfg(test)]
mod duplicate_entry_tests {
    use super::*;
    fn entry(id: &str, url: &str) -> PreparedEntry {
        PreparedEntry {
            stable_id: id.into(),
            provider_id: None,
            name: "Channel".into(),
            category: "Group".into(),
            epg_id: None,
            media_url: Zeroizing::new(url.into()),
            backup_urls: Vec::new(),
        }
    }
    #[test]
    fn identical_repeats_become_backups_never_extra_channels() {
        let (mut entries, mut ids) = (Vec::new(), HashMap::new());
        assert!(!admit_entry(&mut entries, &mut ids, entry("a", "http://x.invalid/1")).unwrap());
        assert!(admit_entry(&mut entries, &mut ids, entry("a", "http://x.invalid/2")).unwrap());
        // An exact repeat of an address adds nothing.
        assert!(admit_entry(&mut entries, &mut ids, entry("a", "http://x.invalid/2")).unwrap());
        assert!(!admit_entry(&mut entries, &mut ids, entry("b", "http://x.invalid/3")).unwrap());
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].backup_urls.len(), 1);
        assert_eq!(entries[0].backup_urls[0].as_str(), "http://x.invalid/2");
        // Bounded: 1 + 15 addresses per channel, then refused rather than truncated.
        for i in 0..14 {
            admit_entry(
                &mut entries,
                &mut ids,
                entry("a", &format!("http://x.invalid/a{i}")),
            )
            .unwrap();
        }
        assert!(admit_entry(&mut entries, &mut ids, entry("a", "http://x.invalid/over")).is_err());
    }
}

#[cfg(test)]
mod tolerance_tests {
    use super::*;
    fn auth() -> Auth {
        Auth {
            format: Some("ts".into()),
            alternate: None,
            max: None,
        }
    }
    fn parse(rows: &str) -> Result<(Vec<PreparedEntry>, usize), String> {
        let secret = Secret::Xtream {
            server_url: "http://tv.fixture.example".into(),
            username: "fixtureuser".into(),
            password: "fixturepass".into(),
        };
        let policy = DisplayPolicy::new(&secret);
        let (_root, context, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        let cats: HashMap<String, String> = [("1".to_string(), "US| NFL PPV".to_string())].into();
        let auth = auth();
        let live = LiveContext {
            account: "account",
            origin: "http://tv.fixture.example",
            base: "http://tv.fixture.example",
            username: "fixtureuser",
            password: "fixturepass",
            auth: &auth,
            cats: &cats,
            policy: &policy,
        };
        xtream_entries(
            rows.as_bytes(),
            live,
            &context,
            Instant::now() + Duration::from_secs(20),
        )
    }
    #[test]
    fn one_bad_row_never_costs_the_good_channels() {
        let rows = r#"[
            {"stream_id": 1, "name": "Good One", "category_id": "1", "stream_type": "live"},
            {"stream_id": "2", "name": "Good Two", "category_id": 1},
            {"stream_id": 3.0, "name": "Decimal id", "category_id": "1"},
            {"stream_id": 4, "name": "Unknown group", "category_id": "999"},
            {"stream_id": 5, "name": "Odd guide id", "epg_channel_id": 7},
            {"stream_id": 6, "name": "A radio", "stream_type": "radio_streams"},
            {"stream_id": 1, "name": "Repeated id"},
            {"name": "No id"},
            {"stream_id": "x9", "name": "Bad id"},
            {"stream_id": 8},
            {"stream_id": 9, "name": "fixturepass leak"},
            {"stream_id": 10, "name": "Foreign direct", "direct_source": "http://other.fixture.example/x.ts"}
        ]"#;
        let (entries, skipped) = parse(rows).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Good One",
                "Good Two",
                "Decimal id",
                "Unknown group",
                "Odd guide id"
            ]
        );
        assert_eq!(skipped, 7);
        assert_eq!(entries[2].provider_id.as_deref(), Some("3"));
        assert!(entries[2].media_url.ends_with("/3.ts"));
        assert_eq!(entries[3].category, "Uncategorised");
        assert_eq!(entries[4].epg_id, None);
        // Nothing skipped shows its sign-in text anywhere.
        assert!(!entries.iter().any(|e| e.name.contains("fixturepass")));
    }
    #[test]
    fn whole_document_problems_still_refuse_the_import() {
        assert!(parse("not json").is_err());
        assert!(parse("{}").is_err());
        // Empty stays refused: more likely a provider error than an empty
        // account, and it must not replace a saved library (XC-019).
        assert!(parse("[]").is_err());
        // Nothing usable at all is a failed import, not an empty success.
        assert!(parse(
            r#"[{"name": "No id"}, {"stream_id": 6, "stream_type": "radio_streams", "name": "r"}]"#
        )
        .is_err());
    }
}

#[cfg(test)]
mod playlist_tolerance_tests {
    use super::*;
    fn parse(text: &str) -> Result<ParsedPlaylist, String> {
        let secret = Secret::Playlist {
            url: "http://tv.fixture.example/get.php?username=fixtureuser&password=fixturepass&type=m3u_plus".into(),
        };
        let policy = DisplayPolicy::new(&secret);
        let (_root, context, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        playlist(
            text.as_bytes(),
            "account",
            "http://tv.fixture.example",
            &policy,
            &context,
            Instant::now() + Duration::from_secs(20),
        )
    }
    #[test]
    fn one_malformed_entry_never_costs_the_good_channels() {
        let text = "\u{feff}#EXTM3U\r\n\
            #EXTINF:-1 tvg-id=\"one\" group-title=\"News\",One, with a comma\r\n\
            http://tv.fixture.example/live/1.ts\r\n\
            #EXTINF:no-duration,Broken header\r\n\
            http://tv.fixture.example/live/2.ts\r\n\
            http://tv.fixture.example/live/orphan.ts\r\n\
            #EXTINF:-1 group-title=\"Sports\",Two\r\n\
            http://tv.fixture.example/live/3.ts\r\n\
            #EXTINF:-1,fixturepass leak\r\n\
            http://tv.fixture.example/live/4.ts\r\n\
            #EXTINF:-1 tvg-id=\"fixturepass\",Three keeps its channel\r\n\
            http://tv.fixture.example/live/5.ts\r\n\
            #EXTINF:-1,Elsewhere\r\n\
            http://other.fixture.example/live/6.ts\r\n\
            #EXTINF:-1,Lost its address\r\n\
            #EXTINF:-1,Four\r\n\
            http://tv.fixture.example/live/7.ts\r\n\
            #EXTINF:-1,Trailing without address";
        let (entries, _, skipped) = parse(text).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "One, with a comma",
                "Two",
                "Three keeps its channel",
                "Four"
            ]
        );
        // Broken header (+its address), orphan address, leaked name, other
        // server, lost address, trailing entry.
        assert_eq!(skipped, 6);
        assert_eq!(entries[0].category, "News");
        assert_eq!(
            entries[2].provider_id, None,
            "a tainted tvg-id is dropped, not shown"
        );
    }
    #[test]
    fn whole_file_problems_still_refuse_the_import() {
        assert!(parse("<html>login</html>").is_err());
        assert!(parse("#EXTM3U\n").is_err());
        assert!(parse("#EXTM3U\n#EXTINF:-1,Only broken\n").is_err());
    }
}
