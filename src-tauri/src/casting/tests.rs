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

#[test]
fn receiver_fetch_needs_a_grant_on_the_actual_response() {
    use reqwest::header::HeaderValue;
    assert!(grants_receiver(Some(&HeaderValue::from_static("*"))));
    assert!(grants_receiver(Some(&HeaderValue::from_static(
        "https://www.gstatic.com"
    ))));
    assert!(!grants_receiver(None));
    assert!(!grants_receiver(Some(&HeaderValue::from_static(
        "https://example.com"
    ))));
}

#[tokio::test]
async fn plain_http_and_invalid_streams_always_relay() {
    assert!(!receiver_can_fetch("http://example.invalid/live.m3u8").await);
    assert!(!receiver_can_fetch("not a url").await);
    assert!(!receiver_can_fetch("https://user:pass@example.invalid/live.m3u8").await);
}

use super::*;
#[test]
fn discovery_requests_fence_supersession_and_retain_actual_work_until_lease_drop() {
    let manager = CastingManager::default();
    let first = manager.begin_discovery("first").unwrap();
    assert!(first.check_current().is_ok());
    let second = manager.begin_discovery("second").unwrap();
    assert_eq!(first.check_current(), Err("cast-discovery-canceled"));
    assert!(second.check_current().is_ok());
    manager.cancel_discovery("first").unwrap();
    assert!(second.check_current().is_ok());
    assert_eq!(manager.operations.load(Ordering::SeqCst), 2);
    manager.cancel_discovery("second").unwrap();
    assert_eq!(second.check_current(), Err("cast-discovery-canceled"));
    assert_eq!(manager.operations.load(Ordering::SeqCst), 2);
    drop(first);
    drop(second);
    assert_eq!(manager.operations.load(Ordering::SeqCst), 0);
    assert!(manager.discoveries.lock().unwrap().active.is_empty());
}
#[test]
fn discovery_cancel_before_admission_is_bounded_and_never_scans() {
    let manager = CastingManager::default();
    manager.cancel_discovery("cancel-before-start").unwrap();
    assert!(matches!(
        manager.begin_discovery("cancel-before-start"),
        Err("cast-discovery-canceled")
    ));
    for id in 0..256 {
        manager.cancel_discovery(&format!("canceled-{id}")).unwrap();
    }
    assert_eq!(manager.discoveries.lock().unwrap().canceled.len(), 128);
    assert_eq!(manager.operations.load(Ordering::SeqCst), 0);
    assert!(manager.begin_discovery("invalid request").is_err());
}
#[tokio::test]
async fn canceled_discovery_returns_before_any_interface_snapshot_or_socket() {
    let manager = CastingManager::default();
    let request = manager.begin_discovery("no-network-fixture").unwrap();
    manager.cancel_discovery("no-network-fixture").unwrap();
    assert!(matches!(
        manager.discover(&request).await,
        Err("cast-discovery-canceled")
    ));
}
#[tokio::test]
async fn dlna_selected_description_recheck_detects_recycled_receiver_before_any_control_action() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (fresh_id, expected) in [
        ("uuid:A", Ok("matched")),
        ("uuid:B", Err("cast-receiver-identity-changed")),
        ("", Ok("unavailable")),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            let size = stream.read(&mut bytes).await.unwrap();
            let request = String::from_utf8_lossy(&bytes[..size]);
            assert!(request.starts_with("GET /device.xml "));
            assert!(!request.contains("SOAPAction"));
            let xml=format!("<root><device><friendlyName>TV</friendlyName><UDN>{fresh_id}</UDN><modelName>Model</modelName><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/control</controlURL></service></serviceList></device></root>");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                xml.len(),
                xml
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let endpoint = Endpoint::Dlna {
            name: "TV".into(),
            control: reqwest::Url::parse(&format!("http://{address}/control")).unwrap(),
            description: reqwest::Url::parse(&format!("http://{address}/device.xml")).unwrap(),
            service: "urn:schemas-upnp-org:service:AVTransport:1".into(),
            protocol_id: Some("uuid:A".into()),
            model: Some("Model".into()),
        };
        assert_eq!(recheck_endpoint(&endpoint).await, expected);
        task.await.unwrap();
    }
}
#[tokio::test]
async fn raw_roster_id_cannot_start_or_allocate_a_receiver_session() {
    let manager = CastingManager::default();
    let result = manager
        .start(
            "roster-id",
            "session",
            MediaSelection {
                id: "channel".into(),
                name: "Fixture".into(),
                url: "https://1.1.1.1/media".into(),
                content_type: "video/mp4".into(),
            },
            false,
            false,
        )
        .await;
    assert!(matches!(
        result,
        Err("cast-issued-handle-expired-revalidate")
    ));
    assert!(manager.active.lock().await.is_none());
}
#[test]
fn immutable_grant_expires_and_network_epoch_changes_cannot_retarget_it() {
    let network = ReceiverNetworkScope {
        generation: 1,
        scope_id: "opaque".into(),
        observation: "interfaces-only".into(),
    };
    let mut grant = IssuedGrant {
        endpoint: Endpoint::Chromecast {
            name: "TV".into(),
            address: "192.168.1.9:8009".parse().unwrap(),
            protocol_id: None,
            model: None,
            instance: None,
        },
        network: network.clone(),
        time: Instant::now(),
        allow_unverified_identity: true,
    };
    assert_eq!(grant_is_current(&grant, &network), Ok(()));
    let mut changed = network.clone();
    changed.generation += 1;
    assert_eq!(
        grant_is_current(&grant, &changed),
        Err("cast-network-changed")
    );
    changed = network.clone();
    changed.scope_id = "different".into();
    assert!(grant_is_current(&grant, &changed).is_err());
    grant.time = Instant::now() - Duration::from_secs(121);
    assert_eq!(
        grant_is_current(&grant, &network),
        Err("cast-issued-handle-expired-revalidate")
    );
}
#[test]
fn unavailable_identity_needs_explicit_acknowledgment_and_matched_cannot_silently_downgrade() {
    assert!(!identity_admitted("unavailable", false));
    assert!(identity_admitted("unavailable", true));
    assert!(identity_admitted("matched", false));
}
#[test]
fn duplicate_friendly_names_preserve_distinct_protocol_ids_and_never_claim_attestation() {
    let endpoint = |id: &str| Endpoint::Chromecast {
        name: "Living room".into(),
        address: "192.168.1.9:8009".parse().unwrap(),
        protocol_id: Some(id.into()),
        model: Some("Model".into()),
        instance: Some("room._googlecast._tcp.local".into()),
    };
    let a = endpoint("A").device("opaque-A".into());
    let b = endpoint("B").device("opaque-B".into());
    assert_eq!(a.name, b.name);
    assert_ne!(a.protocol_receiver_id, b.protocol_receiver_id);
    assert!(!a.cryptographically_attested);
    assert_eq!(a.identity_status, "protocol-reported");
}
#[tokio::test]
async fn shutdown_waits_for_owned_operations_and_refuses_late_work() {
    let manager = Arc::new(CastingManager::default());
    let operation = manager.enter().unwrap();
    let closing = manager.cancel.notified();
    tokio::pin!(closing);
    closing.as_mut().enable();
    let owner = manager.clone();
    let task = tokio::spawn(async move { owner.shutdown().await });
    tokio::time::timeout(Duration::from_secs(1), closing)
        .await
        .unwrap();
    assert!(manager.enter().is_err());
    assert!(!task.is_finished());
    drop(operation);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap(),
        Ok(())
    );
    assert!(manager.begin_discovery("after-shutdown").is_err());
}
#[test]
fn native_operations_are_bounded() {
    let manager = CastingManager::default();
    let operations: Vec<_> = (0..4).map(|_| manager.enter().unwrap()).collect();
    assert!(manager.enter().is_err());
    drop(operations);
    assert_eq!(manager.operations.load(Ordering::SeqCst), 0);
    assert!(manager.enter().is_ok());
}
#[tokio::test]
async fn known_receiver_never_accepts_public_loopback_hostnames_or_arbitrary_ports() {
    let manager = CastingManager::default();
    for address in [
        "8.8.8.8",
        "127.0.0.1",
        "169.254.1.2",
        "example.com",
        "192.168.1.2:9999",
    ] {
        assert!(manager
            .register_receiver(address, "Known TV")
            .await
            .is_err());
    }
    assert!(manager.manual.lock().await.is_empty());
}
#[test]
fn receiver_boundary_is_private_lan_only() {
    assert!(private_address("192.168.1.5".parse().unwrap()));
    assert!(!private_address("127.0.0.1".parse().unwrap()));
    assert!(!private_address("169.254.169.254".parse().unwrap()));
    assert!(!private_address("8.8.8.8".parse().unwrap()));
}
#[tokio::test]
async fn commands_cannot_take_over_unknown_sessions() {
    let manager = CastingManager::default();
    assert!(manager.stop("other").await.is_err());
    assert!(manager.status("other").await.is_err());
    assert!(manager.shutdown().await.is_ok());
}
#[tokio::test]
async fn media_policy_never_permits_local_device_urls_as_upstream_media() {
    let manager = CastingManager::default();
    let selection = MediaSelection {
        id: "channel".into(),
        name: "fixture".into(),
        url: "http://127.0.0.1/media".into(),
        content_type: "video/mp4".into(),
    };
    assert!(matches!(
        manager
            .start("unknown", "session", selection, true, false)
            .await,
        Err("cast-media-public-url-required")
    ));
    assert!(manager.active.lock().await.is_none());
}
