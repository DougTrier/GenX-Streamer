//! Production local-start core with a real Context, namespace and ordinary file.
use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[tokio::test]
async fn archive_download_native_context_uses_same_session_and_joined_removal_without_provider_metadata(
) {
    let (root, _command, owner, _work, _requests) = scan_manifest_work::bookmark_context_fixture();
    let directory = root.path().join("archive-downloads-v1");
    let (saved, data) = crate::archive_download_store::local_fixture(&directory);
    let reference = saved.entry.download_ref.clone();
    // There is deliberately no online Archive entry. Only the exact saved bytes
    // can authorize this session, including after discovery metadata disappears.
    owner
        .storage(None, |store, check| {
            check()?;
            store.with_archive_read(|c| {
                assert_eq!(
                    c.query_row("SELECT count(*) FROM archive_file_v1", [], |r| r
                        .get::<_, i64>(0))
                        .unwrap(),
                    0
                );
                Ok(())
            })
        })
        .await
        .unwrap();
    let result = start_download_owned(
        DownloadStartRequest {
            schema_version: 1,
            download_ref: reference.clone(),
            expected_revision: saved.revision.clone(),
        },
        owner.clone(),
    )
    .await
    .unwrap();
    let StartResult::Started { receipt } = result else {
        panic!("offline mustneverreportproviderdead")
    };
    assert_eq!(receipt.lease_ms, 60000);
    {
        let active = ACTIVE.lock().await;
        let session = active.as_ref().unwrap();
        assert_eq!(session.download_ref.as_deref(), Some(reference.as_str()));
        assert!(session.bookmark.local.is_some());
    }
    revoke_removed(&archive_catalog::RemovalScope::All)
        .await
        .unwrap();
    assert!(ACTIVE.lock().await.is_some());
    let url = reqwest::Url::parse(&receipt.media_url).unwrap();
    let address = url.socket_addrs(|| None).unwrap()[0];
    let mut decoder = tokio::net::TcpStream::connect(address).await.unwrap();
    decoder
        .write_all(
            format!(
                "GET {} HTTP/1.1\r\nHost: {address}\r\nRange: bytes=4-63\r\n\r\n",
                url.path()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        decoder.read_to_end(&mut response),
    )
    .await
    .unwrap()
    .unwrap();
    let at = response.windows(4).position(|v| v == b"\r\n\r\n").unwrap() + 4;
    assert_eq!(&response[at..], &data[4..64]);
    drop(decoder);
    #[cfg(windows)]
    assert!(
        std::fs::remove_file(directory.join(format!("{reference}.mp4"))).is_err(),
        "live ordinaryhandle must prevent unlink beforejoin"
    );
    let remove_ref = reference.clone();
    with_download_removal(&reference, move || async move {
        owner
            .storage(None, move |store, check| {
                let removed =
                    store.remove_archive_download_checked(&remove_ref, &saved.revision, check)?;
                std::fs::remove_file(removed.directory.join(removed.managed_name))
                    .map_err(|_| "fixture-remove-failed")?;
                Ok(())
            })
            .await?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(ACTIVE.lock().await.is_none());
    assert!(std::net::TcpListener::bind(address).is_ok());
    assert!(!directory.join(format!("{reference}.mp4")).exists());
}
