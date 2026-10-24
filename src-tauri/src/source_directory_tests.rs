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
#[test]
fn documented_dynamic_repository_paths_queries_and_unicode_content_are_admitted() {
    for url in [
        "https://api.github.com/search/repositories?q=xmltv+guide&sort=updated&order=desc&per_page=25&page=2",
        "https://api.github.com/repos/Any-Owner/dynamic.repo",
        "https://api.github.com/repos/o/r/readme?ref=release%2Fstable",
        "https://api.github.com/repos/o/r/git/trees/main?recursive=1",
        "https://api.github.com/repos/o/r/git/trees/release%2Fstable",
        "https://api.github.com/repos/o/r/contents/guides/US.xml",
        "https://api.github.com/repos/o/r/contents/%E6%8C%87%E5%8D%97.xml?ref=main",
    ] {
        assert!(validate_endpoint(url).is_ok(), "{url}")
    }
}
#[test]
fn hostile_hosts_transport_paths_and_credentials_are_whole_refused() {
    for url in [
        "http://api.github.com/repos/o/r",
        "https://api.github.com:443/repos/o/r",
        "https://api.github.com.evil.invalid/repos/o/r",
        "https://user:secret@api.github.com/repos/o/r",
        "https://api.github.com/repos/o/r#",
        "https://api.github.com/repos/o/r/contents/../secret",
        "https://api.github.com/repos/o/r/contents/%2e%2e/secret",
        "https://api.github.com/repos/o/r/contents/%2Fsecret",
        "https://api.github.com/repos/o/r/contents/a%5Cb",
        "https://api.github.com/repos/o/r/contents/%FF",
        "https://api.github.com/repos/o/r/git/trees",
        "https://api.github.com/repos/o/r/issues",
        "https://api.github.com/users/o",
        "https://api.github.com/repos/o/r/",
        "https://api.github.com/repos/o/r/contents/%GG",
    ] {
        assert_eq!(
            validate_endpoint(url).unwrap_err().code,
            DirectoryCode::EndpointRefused,
            "{url}"
        )
    }
}
#[test]
fn unknown_duplicate_query_auth_and_unbounded_pagination_are_refused() {
    for url in [
        "https://api.github.com/search/repositories",
        "https://api.github.com/search/repositories?q=",
        "https://api.github.com/search/repositories?q=a&q=b",
        "https://api.github.com/search/repositories?q=a&access_token=secret",
        "https://api.github.com/search/repositories?q=a&per_page=101",
        "https://api.github.com/search/repositories?q=a&page=0",
        "https://api.github.com/search/repositories?q=a&page=1001",
        "https://api.github.com/search/repositories?q=%FF",
        "https://api.github.com/search/repositories?q=%0Asecret",
        "https://api.github.com/repos/o/r?ref=main",
        "https://api.github.com/repos/o/r/readme?other=1",
        "https://api.github.com/repos/o/r/git/trees/main?recursive=0",
    ] {
        assert!(validate_endpoint(url).is_err(), "{url}")
    }
    assert!(validate_endpoint(&format!(
        "https://api.github.com/search/repositories?q={}",
        "x".repeat(513)
    ))
    .is_err());
}
#[test]
fn bounded_json_utf8_and_container_boundary_never_leaks_body() {
    for bytes in [b"{}".as_slice(), b"[]", br#"{"items":[],"total_count":0}"#] {
        assert!(decode_body(bytes).is_ok())
    }
    assert_eq!(
        decode_body(&[0xff]).unwrap_err().code,
        DirectoryCode::BodyInvalidUtf8
    );
    for bytes in [
        b"null".as_slice(),
        b"1",
        b"\"private-marker\"",
        b"{bad secret-marker",
    ] {
        let error = decode_body(bytes).unwrap_err();
        assert_eq!(error.code, DirectoryCode::BodyInvalidJson);
        assert!(!serde_json::to_string(&error).unwrap().contains("marker"));
    }
    let mut exact = b"[\"".to_vec();
    exact.extend(vec![b'x'; BODY_LIMIT - 4]);
    exact.extend(b"\"]");
    assert_eq!(exact.len(), BODY_LIMIT);
    assert!(decode_body(&exact).is_ok());
    exact.push(b' ');
    assert_eq!(
        decode_body(&exact).unwrap_err().code,
        DirectoryCode::BodyTooLarge
    );
}
#[test]
fn status_and_retry_after_are_fixed_bounded_and_cancellation_is_explicit() {
    assert!(check_status(200, None).is_ok());
    assert_eq!(
        check_status(429, Some("60")).unwrap_err(),
        DirectoryFailure {
            code: DirectoryCode::HttpRateLimited,
            http_status: Some(429),
            retry_after: Some("60".into()),
            rate_limit_reset: None
        }
    );
    assert_eq!(
        check_status(403, None).unwrap_err().code,
        DirectoryCode::HttpForbidden
    );
    assert_eq!(
        check_status(302, None).unwrap_err().code,
        DirectoryCode::HttpUnavailable
    );
    for value in ["x\r\nsecret".into(), "x".repeat(129), "".into()] {
        assert!(check_status(429, Some(&value))
            .unwrap_err()
            .retry_after
            .is_none())
    }
    assert_eq!(
        canceled(&AtomicBool::new(true)).unwrap_err().code,
        DirectoryCode::Canceled
    );
    assert!(canceled(&AtomicBool::new(false)).is_ok());
}
#[test]
fn numeric_repository_identity_is_positive_canonical_and_query_free() {
    assert!(validate_endpoint("https://api.github.com/repositories/123456").is_ok());
    for suffix in [
        "0",
        "01",
        "-1",
        "1.0",
        "9007199254740992",
        "123?ref=main",
        "123/contents",
    ] {
        assert!(
            validate_endpoint(&format!("https://api.github.com/repositories/{suffix}")).is_err()
        )
    }
    assert!(
        validate_endpoint("https://api.github.com/repos/o/r/git/trees/release%2F..%2Fsecret")
            .is_err()
    );
}
#[test]
fn exhausted_primary_limit_403_is_rate_limited_with_bounded_digit_reset() {
    let failure = check_status_limits(403, None, Some("0"), Some("1760000000")).unwrap_err();
    assert_eq!(failure.code, DirectoryCode::HttpRateLimited);
    assert_eq!(failure.rate_limit_reset.as_deref(), Some("1760000000"));
    // A 403 with quota remaining is an ordinary refusal and exposes no reset.
    let forbidden = check_status_limits(403, None, Some("12"), Some("1760000000")).unwrap_err();
    assert_eq!(forbidden.code, DirectoryCode::HttpForbidden);
    assert!(forbidden.rate_limit_reset.is_none());
    for reset in ["", "17600000000000", "176 0", "-1", "1e9"] {
        assert!(check_status_limits(429, None, None, Some(reset))
            .unwrap_err()
            .rate_limit_reset
            .is_none());
    }
    let json = serde_json::to_value(check_status(500, None).unwrap_err()).unwrap();
    assert!(json.get("rateLimitReset").is_none());
}
#[test]
fn directory_cache_is_fresh_then_revalidates_exact_etag_and_falls_back_stale() {
    let mut cache = DirectoryCache::default();
    let start = Instant::now();
    let key = "https://api.github.com/repositories/1";
    assert_eq!(cache.lookup(key, start), CacheLookup::Miss);
    cache.store(key, Some("\"abc\""), b"{}".to_vec(), start);
    assert!(matches!(cache.lookup(key, start), CacheLookup::Fresh(_)));
    let later = start + CACHE_FRESH;
    assert_eq!(
        cache.lookup(key, later),
        CacheLookup::Revalidate("\"abc\"".into())
    );
    // A different validator never renews another representation.
    assert!(cache.revalidated(key, "\"other\"", later).is_none());
    assert!(cache.revalidated(key, "\"abc\"", later).is_some());
    assert!(matches!(cache.lookup(key, later), CacheLookup::Fresh(_)));
    assert!(cache.stale(key, later + CACHE_STALE_LIMIT).is_none());
    assert!(cache.stale(key, later + CACHE_FRESH).is_some());
    // No validator means a later miss rather than an unconditional revalidation.
    cache.store("k2", None, b"[]".to_vec(), start);
    assert_eq!(cache.lookup("k2", later), CacheLookup::Miss);
    // Control-character validators are never retained.
    cache.store("k3", Some("bad\r\n"), b"[]".to_vec(), start);
    assert_eq!(cache.lookup("k3", later), CacheLookup::Miss);
}
#[test]
fn directory_cache_count_and_byte_bounds_evict_oldest_and_refuse_oversize() {
    let mut cache = DirectoryCache::default();
    let start = Instant::now();
    for i in 0..200u64 {
        cache.store(
            &format!("key-{i}"),
            None,
            b"{}".to_vec(),
            start + Duration::from_millis(i),
        );
    }
    let (count, bytes) = cache.len_and_bytes();
    assert!(count <= 128);
    assert!(bytes <= 16 * 1024 * 1024);
    assert_eq!(cache.lookup("key-0", start), CacheLookup::Miss);
    assert!(matches!(
        cache.lookup("key-199", start + Duration::from_millis(199)),
        CacheLookup::Fresh(_)
    ));
    cache.store("huge", None, vec![b' '; BODY_LIMIT + 1], start);
    assert_eq!(cache.lookup("huge", start), CacheLookup::Miss);
    for i in 0..10u64 {
        cache.store(
            &format!("big-{i}"),
            None,
            vec![b' '; BODY_LIMIT],
            start + Duration::from_secs(10 + i),
        );
    }
    assert!(cache.len_and_bytes().1 <= 16 * 1024 * 1024);
}
