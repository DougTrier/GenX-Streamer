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

//! Network media probe tests: recognized roots, variants, keys, DRM, ranges
//! and rate limits.

use super::*;

#[tokio::test]
async fn recognized_root_does_not_hide_segment_http_or_html_error_and_latest_complete_is_checked() {
    for (status, body, reason) in [
        (404, Vec::new(), "resource-http-unavailable"),
        (
            200,
            b"<html>error</html>".to_vec(),
            "resource-error-document",
        ),
        (200, ts(), "media-resources-responded"),
    ] {
        let f = fixture(HashMap::from([
            ("/root".into(), (200, media("latest"), None)),
            ("/latest".into(), (status, body, None)),
        ]))
        .await;
        let r = inspect(
            f.base.join("root").unwrap().as_str(),
            true,
            "r".into(),
            20_000,
        )
        .await
        .unwrap();
        assert_eq!(r.reason_code, reason);
        assert_eq!(r.checked_resources, 2);
        assert_eq!(f.count.load(std::sync::atomic::Ordering::SeqCst), 2);
    }
}

#[tokio::test]
async fn master_relative_variant_init_map_range_and_audio_are_real_requests() {
    let root=b"#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"audio\"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS=\"avc1.64001f,mp4a.40.2\",AUDIO=\"a\"\nvideo\n".to_vec();
    let video =
        b"#EXTM3U\n#EXT-X-MAP:URI=\"map\"\n#EXT-X-BYTERANGE:8@8\n#EXTINF:2,\nsegment\n".to_vec();
    let f = fixture(HashMap::from([
        ("/root".into(), (200, root, None)),
        ("/video".into(), (200, video, None)),
        ("/map".into(), (200, b"\0\0\0\x08ftyp".to_vec(), None)),
        (
            "/segment".into(),
            (
                206,
                b"\0\0\0\x08moof".to_vec(),
                Some("bytes 8-15/16".into()),
            ),
        ),
        ("/audio".into(), (200, media("aac"), None)),
        ("/aac".into(), (200, vec![0xff, 0xf1, 0, 0], None)),
    ]))
    .await;
    let r = inspect(
        f.base.join("root").unwrap().as_str(),
        true,
        "r".into(),
        20_000,
    )
    .await
    .unwrap();
    assert_eq!(r.status, "resources-responded");
    assert_eq!(r.checked_resources, 6);
}

#[tokio::test]
async fn encrypted_resources_require_exact_key_without_claiming_decoded_bytes() {
    for length in [15, 16, 17] {
        let text =
            b"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXTINF:2,\nsegment\n".to_vec();
        let f = fixture(HashMap::from([
            ("/root".into(), (200, text, None)),
            ("/key".into(), (200, vec![b'<'; length], None)),
            ("/segment".into(), (200, vec![1; 32], None)),
        ]))
        .await;
        let r = inspect(
            f.base.join("root").unwrap().as_str(),
            true,
            "r".into(),
            20_000,
        )
        .await
        .unwrap();
        if length == 16 {
            assert_eq!(r.reason_code, "encrypted-resources-responded");
        } else {
            assert_eq!(r.status, "unavailable");
        }
    }
}

#[tokio::test]
async fn unsupported_drm_and_master_cycle_never_request_media_and_no_http_override() {
    let f = fixture(HashMap::from([
        (
            "/drm".into(),
            (
                200,
                b"#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"key\"\n#EXTINF:2,\nsegment\n"
                    .to_vec(),
                None,
            ),
        ),
        (
            "/cycle".into(),
            (
                200,
                b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"avc1.64001f\"\ncycle\n".to_vec(),
                None,
            ),
        ),
    ]))
    .await;
    assert_eq!(
        inspect(
            f.base.join("drm").unwrap().as_str(),
            true,
            "r".into(),
            20_000
        )
        .await
        .unwrap()
        .reason_code,
        "drm-unverified"
    );
    assert_eq!(
        inspect(
            f.base.join("cycle").unwrap().as_str(),
            true,
            "r".into(),
            20_000
        )
        .await
        .unwrap()
        .reason_code,
        "manifest-cycle-unverified"
    );
    let before = f.count.load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        inspect(
            f.base.join("cycle").unwrap().as_str(),
            false,
            "r".into(),
            20_000
        )
        .await
        .unwrap()
        .status,
        "unavailable"
    );
    assert_eq!(f.count.load(std::sync::atomic::Ordering::SeqCst), before);
}

#[test]
fn parser_implicit_range_requires_same_resource_and_unsupported_codecs_do_not_guess() {
    let base = Url::parse("https://example.test/").unwrap();
    let p = parse(
        &base,
        "#EXTM3U\n#EXT-X-BYTERANGE:8@0\n#EXTINF:2,\nsame\n#EXT-X-BYTERANGE:8\n#EXTINF:2,\nsame\n",
    )
    .unwrap();
    assert_eq!(p.segment.unwrap().resource.range, Some((8, 15)));
    assert!(parse(&base, "#EXTM3U\n#EXT-X-BYTERANGE:8\n#EXTINF:2,\nother\n").is_err());
    assert!(parse(
        &base,
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"hev1.test\"\nv\n"
    )
    .is_err());
}

#[tokio::test]
async fn abandoned_held_segment_closes_actual_upstream_after_future_settlement() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let (ready_tx, ready) = tokio::sync::oneshot::channel();
    let (closed_tx, closed) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut root, _) = listener.accept().await.unwrap();
        let mut request = [0; 1024];
        assert!(root.read(&mut request).await.unwrap() > 0);
        let body = media("segment");
        root.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
        root.write_all(&body).await.unwrap();
        drop(root);
        let (mut segment, _) = listener.accept().await.unwrap();
        assert!(segment.read(&mut request).await.unwrap() > 0);
        segment
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 564\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        ready_tx.send(()).unwrap();
        let n = segment.read(&mut request).await.unwrap();
        assert_eq!(n, 0);
        closed_tx.send(()).unwrap();
    });
    let operation = tokio::spawn(async move { inspect(&url, true, "cancel".into(), 20_000).await });
    tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    operation.abort();
    assert!(operation.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(2), closed)
        .await
        .unwrap()
        .unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn rate_limit_is_one_request_with_safe_retry_after_and_invalid_ranges_refuse() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 1024];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        socket
            .write_all(b"HTTP/1.1 429 Busy\r\nRetry-After: 60\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    });
    let r = inspect(&url, true, "r".into(), 20_000).await.unwrap();
    assert_eq!(r.http_status, Some(429));
    assert_eq!(r.retry_after.as_deref(), Some("60"));
    assert_eq!(r.checked_resources, 1);
    server.await.unwrap();
    let f = fixture(HashMap::from([
        (
            "/root".into(),
            (
                200,
                b"#EXTM3U\n#EXT-X-BYTERANGE:8@0\n#EXTINF:2,\nsegment\n".to_vec(),
                None,
            ),
        ),
        ("/segment".into(), (200, b"\0\0\0\x08moof".to_vec(), None)),
    ]))
    .await;
    assert_eq!(
        inspect(
            f.base.join("root").unwrap().as_str(),
            true,
            "r".into(),
            20_000
        )
        .await
        .unwrap()
        .reason_code,
        "range-unavailable"
    );
}

#[tokio::test]
async fn request_ceiling_manifest_limit_and_binary_sample_are_bounded_without_truncating_success() {
    let mut routes = HashMap::new();
    for (path, next) in [("/root", "m1"), ("/m1", "m2"), ("/m2", "video")] {
        routes.insert(path.into(),(200,format!("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"avc1.test\",AUDIO=\"a\"\n{next}\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"audio\"\n").into_bytes(),None));
    }
    routes.insert(
        "/video".into(),
        (
            200,
            b"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXT-X-MAP:URI=\"map\"\n#EXTINF:2,\nsegment\n".to_vec(),
            None,
        ),
    );
    routes.insert("/key".into(), (200, vec![1; 16], None));
    routes.insert("/map".into(), (200, vec![1; 32], None));
    routes.insert("/segment".into(), (200, vec![1; 32], None));
    routes.insert("/audio".into(), (200, media("aac"), None));
    routes.insert("/aac".into(), (200, vec![0xff, 0xf1, 0, 0], None));
    let f = fixture(routes).await;
    let r = inspect(
        f.base.join("root").unwrap().as_str(),
        true,
        "r".into(),
        20_000,
    )
    .await
    .unwrap();
    assert_eq!(r.reason_code, "request-limit-unverified");
    assert_eq!(r.checked_resources, 8);
    assert_eq!(f.count.load(std::sync::atomic::Ordering::SeqCst), 8);
    let f = fixture(HashMap::from([(
        "/root".into(),
        (
            200,
            [b"#EXTM3U\n".to_vec(), vec![b'#'; MANIFEST]].concat(),
            None,
        ),
    )]))
    .await;
    assert_eq!(
        inspect(
            f.base.join("root").unwrap().as_str(),
            true,
            "r".into(),
            20_000
        )
        .await
        .unwrap()
        .reason_code,
        "resource-too-large"
    );
    let mut large = ts();
    large.resize(2 * SAMPLE, 0);
    let f = fixture(HashMap::from([("/root".into(), (200, large, None))])).await;
    let r = inspect(
        f.base.join("root").unwrap().as_str(),
        true,
        "r".into(),
        20_000,
    )
    .await
    .unwrap();
    assert_eq!(r.status, "resources-responded");
    assert_eq!(r.checked_resources, 1);
}

#[test]
fn multiplexed_audio_and_default_external_audio_are_distinguished() {
    let base = Url::parse("https://example.test/").unwrap();
    let p=parse(&base,"#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",DEFAULT=YES\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"avc1.test,mp4a.40.2\",AUDIO=\"a\"\nv\n").unwrap();
    assert!(p.audio.is_none());
    assert!(p.variant.is_some());
    let p=parse(&base,"#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"first\"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"default\",DEFAULT=YES\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"avc1.test,mp4a.40.2\",AUDIO=\"a\"\nv\n").unwrap();
    assert_eq!(p.audio.unwrap().path(), "/default");
}

#[tokio::test]
async fn init_map_uses_its_own_effective_key_after_segment_key_changes() {
    let text=b"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"old-key\"\n#EXT-X-MAP:URI=\"map\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"new-key\"\n#EXTINF:2,\nsegment\n".to_vec();
    let f = fixture(HashMap::from([
        ("/root".into(), (200, text, None)),
        ("/new-key".into(), (200, vec![1; 16], None)),
        ("/old-key".into(), (404, vec![], None)),
        ("/map".into(), (200, vec![1; 32], None)),
        ("/segment".into(), (200, vec![1; 32], None)),
    ]))
    .await;
    let r = inspect(
        f.base.join("root").unwrap().as_str(),
        true,
        "r".into(),
        20_000,
    )
    .await
    .unwrap();
    assert_eq!(r.status, "unavailable");
    assert_eq!(r.http_status, Some(404));
    assert_eq!(r.checked_resources, 3);
}
