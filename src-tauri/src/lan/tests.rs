use super::*;
#[tokio::test]
async fn host_generation_prevents_stale_publication_and_preserves_only_authorized_command() {
    let manager = LanManager::default();
    manager.start(config()).await.unwrap();
    manager.selection_changed(1, None).await.unwrap();
    let first = manager
        .publish_guarded("https://example.org/one", 1)
        .await
        .unwrap();
    manager.selection_changed(2, None).await.unwrap();
    assert!(manager
        .publish_guarded("https://example.org/stale", 1)
        .await
        .is_err());
    assert!(manager.selection_changed(1, None).await.is_err());
    {
        let running = manager.running.lock().await;
        let mut state = running.as_ref().unwrap().state.lock().unwrap();
        assert!(state.resources.is_empty());
        assert_eq!(state.revision, 0);
        let token = "a".repeat(64);
        state.controllers.insert(
            token.clone(),
            Controller {
                channels: HashSet::from(["one".into()]),
                labels: vec![],
                sequence: 1,
            },
        );
        state.viewers.insert("viewer".into(), (token.clone(), 100));
        for id in ["owned", "obsolete"] {
            let (sender, _receiver) = oneshot::channel();
            state.pending_controls.insert(
                id.into(),
                PendingControl {
                    token: token.clone(),
                    expires: 100,
                    revision: 0,
                    reply: sender,
                },
            );
        }
    }
    manager.selection_changed(3, Some("owned")).await.unwrap();
    assert!(manager.control_active("owned").await);
    assert!(!manager.control_active("obsolete").await);
    assert!(manager.selection_changed(4, Some("unknown")).await.is_err());
    assert!(manager.control_active("owned").await);
    manager.selection_changed(4, None).await.unwrap();
    assert!(!manager.control_active("owned").await);
    assert!(
        manager
            .publish_guarded("https://example.org/new", 4)
            .await
            .unwrap()
            .revision
            > first.revision
    );
    manager.stop().await.unwrap();
}
fn config() -> StartConfig {
    StartConfig {
        bind: "127.0.0.1:0".parse().unwrap(),
        certificate_chain: vec![
            include_bytes!("fixtures/loopback-cert.der").to_vec(),
            include_bytes!("fixtures/loopback-root.der").to_vec(),
        ],
        private_key: include_bytes!("fixtures/loopback-key.der").to_vec(),
        allow_http_upstream: false,
    }
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .add_root_certificate(
            reqwest::Certificate::from_der(include_bytes!("fixtures/loopback-root.der")).unwrap(),
        )
        .build()
        .unwrap()
}
#[tokio::test]
async fn real_tls_pause_transition_preserves_viewer_publication_and_fences_pending_controls() {
    let manager = Arc::new(LanManager::default());
    let info = manager.start(config()).await.unwrap();
    let client = client();
    let (viewer, _) = pair(&client, &info, &info.pairing_secret).await;
    manager.selection_changed(1, None).await.unwrap();
    // The admitted ID is real; loopback upstream stays refused without external network traffic.
    let publication = manager
        .publish_guarded("https://127.0.0.1/never-fetched", 1)
        .await
        .unwrap();
    let secret = manager
        .invite_controller(vec!["channel".into()])
        .await
        .unwrap();
    let (controller, _) = pair(&client, &info, &secret).await;
    let second_secret = manager
        .invite_controller(vec!["channel".into()])
        .await
        .unwrap();
    let (second_controller, _) = pair(&client, &info, &second_secret).await;
    let control = |cookie: String| {
        let client = client.clone();
        let address = info.address.clone();
        tokio::spawn(async move {
            client
                .post(format!("{address}/control"))
                .header("Origin", &address)
                .header("Cookie", cookie)
                .body(json(
                    &serde_json::json!({"sequence":1,"revision":1,"action":"pause"}),
                ))
                .send()
                .await
                .unwrap()
        })
    };
    let obsolete_response = control(controller);
    let obsolete = await_control(&manager).await;
    let owned_response = control(second_controller);
    let owned = await_control(&manager).await;
    assert_eq!(
        manager
            .selection_changed_with_publication(2, Some("unknown"), true)
            .await
            .err(),
        Some("control-command-inactive")
    );
    let receipt = manager
        .selection_changed_with_publication(2, Some(&owned.command_id), true)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(receipt).unwrap(),
        serde_json::json!({"generation":2,"publicationRevision":1})
    );
    assert!(!manager.control_active(&obsolete.command_id).await);
    assert!(!manager
        .acknowledge_control(&obsolete.command_id, true)
        .await
        .unwrap());
    assert_eq!(obsolete_response.await.unwrap().status(), 409);
    assert!(manager.control_active(&owned.command_id).await);
    assert!(manager
        .acknowledge_control(&owned.command_id, true)
        .await
        .unwrap());
    assert_eq!(owned_response.await.unwrap().status(), 200);
    let state: serde_json::Value = serde_json::from_slice(
        &heartbeat(&client, &info, &viewer, false)
            .await
            .bytes()
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(state["revision"], publication.revision);
    let media_path = format!("/media/{}/{}", publication.revision, publication.media_id);
    assert_eq!(state["mediaPath"], media_path);
    assert_eq!(
        client
            .get(format!("{}{media_path}", info.address))
            .header("Cookie", &viewer)
            .send()
            .await
            .unwrap()
            .status(),
        502
    );
    let repeat = manager
        .selection_changed_with_publication(2, None, false)
        .await
        .unwrap();
    assert_eq!(repeat.publication_revision, 1); // Same generation is an idempotent receipt, not a new invalidation.
    assert!(manager
        .selection_changed_with_publication(1, None, true)
        .await
        .is_err());
    assert!(manager
        .publish_guarded("https://127.0.0.1/stale", 1)
        .await
        .is_err());
    {
        let running = manager.running.lock().await;
        let state = running.as_ref().unwrap().state.lock().unwrap();
        assert_eq!(state.resources.len(), 1);
        assert_eq!(state.revision, 1);
    }
    let cleared = manager
        .selection_changed_with_publication(3, None, false)
        .await
        .unwrap();
    assert_eq!(cleared.publication_revision, 0);
    let state: serde_json::Value = serde_json::from_slice(
        &heartbeat(&client, &info, &viewer, false)
            .await
            .bytes()
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(state["revision"].is_null());
    assert!(state["mediaPath"].is_null());
    assert_eq!(
        client
            .get(format!("{}{media_path}", info.address))
            .header("Cookie", &viewer)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let next = manager
        .publish_guarded("https://127.0.0.1/new-channel", 3)
        .await
        .unwrap();
    assert!(next.revision > publication.revision);
    manager.stop().await.unwrap();
    assert!(client
        .post(format!("{}/state", info.address))
        .header("Origin", &info.address)
        .header("Cookie", viewer)
        .body("{}")
        .send()
        .await
        .is_err());
}
#[tokio::test]
async fn preservation_receipt_captures_a_completed_publication_and_expired_command_cannot_mutate() {
    let manager = LanManager::default();
    manager.start(config()).await.unwrap();
    manager.selection_changed(1, None).await.unwrap();
    let published = manager
        .publish_guarded("https://127.0.0.1/owned", 1)
        .await
        .unwrap();
    let receipt = manager
        .selection_changed_with_publication(2, None, true)
        .await
        .unwrap();
    assert_eq!(receipt.publication_revision, published.revision);
    {
        let running = manager.running.lock().await;
        let mut state = running.as_ref().unwrap().state.lock().unwrap();
        let token = "a".repeat(64);
        state.controllers.insert(
            token.clone(),
            Controller {
                channels: HashSet::new(),
                labels: vec![],
                sequence: 1,
            },
        );
        state
            .viewers
            .insert("expired-viewer".into(), (token.clone(), 0));
        let (reply, _receiver) = oneshot::channel();
        state.pending_controls.insert(
            "expired-command".into(),
            PendingControl {
                token,
                expires: u64::MAX,
                revision: published.revision,
                reply,
            },
        );
    }
    assert_eq!(
        manager
            .selection_changed_with_publication(3, Some("expired-command"), true)
            .await
            .err(),
        Some("control-command-inactive")
    );
    let unchanged = manager
        .selection_changed_with_publication(2, None, true)
        .await
        .unwrap();
    assert_eq!(unchanged.generation, 2);
    assert_eq!(unchanged.publication_revision, published.revision);
    assert!(manager
        .selection_changed_with_publication(9_007_199_254_740_992, None, true)
        .await
        .is_err());
    manager.stop().await.unwrap();
}
#[tokio::test]
async fn real_tls_publication_change_between_active_check_and_ack_refuses_stale_application() {
    let manager = Arc::new(LanManager::default());
    let info = manager.start(config()).await.unwrap();
    let client = client();
    manager.publish("https://127.0.0.1/first").await.unwrap();
    let secret = manager
        .invite_controller(vec!["channel".into()])
        .await
        .unwrap();
    let (cookie, _) = pair(&client, &info, &secret).await;
    let address = info.address.clone();
    let response = tokio::spawn(async move {
        client
            .post(format!("{address}/control"))
            .header("Origin", &address)
            .header("Cookie", cookie)
            .body(json(
                &serde_json::json!({"sequence":1,"revision":1,"action":"pause"}),
            ))
            .send()
            .await
            .unwrap()
    });
    let command = await_control(&manager).await;
    assert!(manager.control_active(&command.command_id).await);
    manager.publish("https://127.0.0.1/second").await.unwrap();
    assert!(!manager
        .acknowledge_control(&command.command_id, true)
        .await
        .unwrap());
    assert_eq!(response.await.unwrap().status(), 409);
    manager.stop().await.unwrap();
}
async fn pair(client: &reqwest::Client, info: &StartInfo, secret: &str) -> (String, String) {
    let reply = client
        .post(format!("{}/pair", info.address))
        .header("Origin", &info.address)
        .body(json(&serde_json::json!({"secret":secret})))
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 200);
    let cookie = reply
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let body: serde_json::Value = serde_json::from_slice(&reply.bytes().await.unwrap()).unwrap();
    (cookie, body["viewerId"].as_str().unwrap().to_string())
}
async fn heartbeat(
    client: &reqwest::Client,
    info: &StartInfo,
    cookie: &str,
    paused: bool,
) -> reqwest::Response {
    client
        .post(format!("{}/state", info.address))
        .header("Origin", &info.address)
        .header("Cookie", cookie)
        .body(json(&serde_json::json!({"paused":paused})))
        .send()
        .await
        .unwrap()
}
#[tokio::test]
async fn real_tls_two_viewers_pair_revoke_revision_expiry_and_stop() {
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    let client = client();
    assert_eq!(
        client
            .post(format!("{}/state", info.address))
            .header("Origin", &info.address)
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let (first, first_id) = pair(&client, &info, &info.pairing_secret).await;
    let denied = client
        .post(format!("{}/pair", info.address))
        .header("Origin", &info.address)
        .body(json(&serde_json::json!({"secret":info.pairing_secret})))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
    let invite = manager.invite().await.unwrap();
    let (second, _) = pair(&client, &info, &invite).await;
    let published = manager
        .publish("https://example.org/no-extension")
        .await
        .unwrap();
    assert_eq!(published.revision, 1);
    for cookie in [&first, &second] {
        let reply = heartbeat(&client, &info, cookie, false).await;
        assert_eq!(reply.status(), 200);
        let body: serde_json::Value =
            serde_json::from_slice(&reply.bytes().await.unwrap()).unwrap();
        assert_eq!(body["revision"], 1);
        assert!(body["mediaPath"].as_str().unwrap().starts_with("/media/1/"));
    }
    manager
        .publish("https://example.org/changed")
        .await
        .unwrap();
    let reply = heartbeat(&client, &info, &second, true).await;
    assert_eq!(reply.status(), 200);
    {
        let running = manager.running.lock().await;
        let mut state = running.as_ref().unwrap().state.lock().unwrap();
        assert_eq!(
            {
                let now = state.now();
                state.policy.active_consumers(now)
            },
            1
        );
    }
    manager.revoke(&first_id).await.unwrap();
    assert_eq!(heartbeat(&client, &info, &first, false).await.status(), 401);
    {
        let running = manager.running.lock().await;
        running.as_ref().unwrap().state.lock().unwrap().started =
            Instant::now() - Duration::from_secs(31);
    }
    assert_eq!(
        heartbeat(&client, &info, &second, false).await.status(),
        401
    );
    manager.stop().await.unwrap();
    manager.stop().await.unwrap();
    assert!(client
        .get(format!("{}/state", info.address))
        .send()
        .await
        .is_err());
}
#[tokio::test]
async fn tls_refuses_untrusted_certificate_wrong_origin_arbitrary_targets_and_private_upstream() {
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    assert!(reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("{}/state", info.address))
        .send()
        .await
        .is_err());
    let client = client();
    assert_eq!(
        client
            .post(format!("{}/pair", info.address))
            .header("Origin", "https://attacker.invalid")
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let (cookie, _) = pair(&client, &info, &info.pairing_secret).await;
    assert_eq!(
        client
            .post(format!("{}/control", info.address))
            .header("Origin", &info.address)
            .header("Cookie", &cookie)
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .get(format!("{}/media/1/../../etc", info.address))
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert!(manager.publish("file:///private").await.is_err());
    assert!(manager.publish("http://127.0.0.1/private").await.is_err());
    let publication = manager.publish("https://127.0.0.1/private").await.unwrap();
    let url = format!(
        "{}/media/{}/{}",
        info.address, publication.revision, publication.media_id
    );
    assert_eq!(
        client
            .get(url)
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        502
    );
    manager.stop().await.unwrap();
}
#[tokio::test]
async fn listener_collision_expired_invite_and_registry_bounds() {
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    assert!(manager.start(config()).await.is_err());
    let other = LanManager::default();
    let mut duplicate = config();
    duplicate.bind = info.address.trim_start_matches("https://").parse().unwrap();
    assert!(other.start(duplicate).await.is_err());
    let client = client();
    {
        let running = manager.running.lock().await;
        running.as_ref().unwrap().state.lock().unwrap().started =
            Instant::now() - Duration::from_secs(121);
    }
    assert_eq!(
        client
            .post(format!("{}/pair", info.address))
            .header("Origin", &info.address)
            .body(json(&serde_json::json!({"secret":info.pairing_secret})))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let publication = manager.publish("https://example.org/master").await.unwrap();
    {
        let running = manager.running.lock().await;
        let mut state = running.as_ref().unwrap().state.lock().unwrap();
        for number in 1..4096u64 {
            state
                .policy
                .admit_resource(
                    publication.revision,
                    format!("{number:064x}"),
                    format!("https://example.org/{number}"),
                )
                .unwrap();
        }
        assert!(state
            .policy
            .admit_resource(
                publication.revision,
                "f".repeat(64),
                "https://example.org/overflow".into()
            )
            .is_err());
    }
    manager.shutdown().await.unwrap();
}
#[tokio::test]
async fn controller_requires_separate_invite_scope_sequence_and_actual_host_ack() {
    let manager = Arc::new(LanManager::default());
    let info = manager.start(config()).await.unwrap();
    let client = client();
    let secret = manager
        .invite_controller(vec!["sports-1".into()])
        .await
        .unwrap();
    let (cookie, viewer_id) = pair(&client, &info, &secret).await;
    assert_eq!(
        client
            .post(format!("{}/control", info.address))
            .header("Origin", &info.address)
            .header("Cookie", &cookie)
            .body(json(
                &serde_json::json!({"sequence":1,"revision":0,"action":"select","channelId":"unknown"})
            ))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let sender = client.clone();
    let address = info.address.clone();
    let auth = cookie.clone();
    let response = tokio::spawn(async move {
        sender
            .post(format!("{address}/control"))
            .header("Origin", &address)
            .header("Cookie", auth)
            .body(json(
                &serde_json::json!({"sequence":1,"revision":0,"action":"select","channelId":"sports-1"}),
            ))
            .send()
            .await
            .unwrap()
    });
    let command = await_control(&manager).await;
    assert_eq!(command.channel_id.as_deref(), Some("sports-1"));
    assert!(manager.control_active(&command.command_id).await);
    assert!(manager
        .acknowledge_control(&command.command_id, true)
        .await
        .unwrap());
    assert_eq!(response.await.unwrap().status(), 200);
    assert!(!manager
        .acknowledge_control(&command.command_id, true)
        .await
        .unwrap());
    assert_eq!(
        client
            .post(format!("{}/control", info.address))
            .header("Origin", &info.address)
            .header("Cookie", &cookie)
            .body(json(
                &serde_json::json!({"sequence":1,"revision":0,"action":"select","channelId":"sports-1"})
            ))
            .send()
            .await
            .unwrap()
            .status(),
        409
    );
    let sender = client.clone();
    let address = info.address.clone();
    let auth = cookie.clone();
    let response = tokio::spawn(async move {
        sender
            .post(format!("{address}/control"))
            .header("Origin", &address)
            .header("Cookie", auth)
            .body(json(
                &serde_json::json!({"sequence":2,"revision":0,"action":"select","channelId":"sports-1"}),
            ))
            .send()
            .await
            .unwrap()
    });
    let command = await_control(&manager).await;
    manager.revoke(&viewer_id).await.unwrap();
    assert!(!manager.control_active(&command.command_id).await);
    assert!(!manager
        .acknowledge_control(&command.command_id, true)
        .await
        .unwrap());
    assert_eq!(response.await.unwrap().status(), 409);
    manager.shutdown().await.unwrap();
}
#[tokio::test]
async fn controller_timeout_cannot_acknowledge_queued_receipt_as_application() {
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    let client = client();
    let secret = manager.invite_controller(vec!["a".into()]).await.unwrap();
    let (cookie, _) = pair(&client, &info, &secret).await;
    let sender = client.clone();
    let address = info.address.clone();
    let response = tokio::spawn(async move {
        sender
            .post(format!("{address}/control"))
            .header("Origin", &address)
            .header("Cookie", cookie)
            .body(json(
                &serde_json::json!({"sequence":1,"revision":0,"action":"select","channelId":"a"}),
            ))
            .send()
            .await
            .unwrap()
    });
    let command = await_control(&manager).await;
    assert_eq!(response.await.unwrap().status(), 409);
    assert!(!manager.control_active(&command.command_id).await);
    assert!(!manager
        .acknowledge_control(&command.command_id, true)
        .await
        .unwrap());
    manager.stop().await.unwrap();
}
#[tokio::test]
async fn bundled_viewer_is_same_origin_and_static_paths_are_allowlisted() {
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    let client = client();
    let reply = client
        .get(format!("{}/", info.address))
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 200);
    assert!(reply
        .headers()
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("script-src 'self'"));
    let page = reply.text().await.unwrap();
    assert!(page.contains("GenX Streamer"));
    assert!(!page.contains("https://"));
    for path in ["/viewer.js", "/viewer.css", "/hls.js"] {
        assert_eq!(
            client
                .get(format!("{}{path}", info.address))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    assert_eq!(
        client
            .get(format!("{}/private-key.der", info.address))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let first = manager.next_control();
    let second = manager.next_control();
    let started = Instant::now();
    let _ = tokio::join!(first, second);
    assert!(started.elapsed() < Duration::from_millis(450));
    manager.stop().await.unwrap();
}
#[tokio::test]
async fn owner_shutdown_refuses_late_start_while_explicit_stop_can_restart() {
    let manager = Arc::new(LanManager::default());
    manager.start(config()).await.unwrap();
    manager.stop().await.unwrap();
    manager.start(config()).await.unwrap();
    manager.stop().await.unwrap();
    let gate = manager.running.lock().await;
    let next = manager.clone();
    let pending = tokio::spawn(async move { next.start(config()).await });
    let next = manager.clone();
    let closing = tokio::spawn(async move { next.shutdown().await });
    tokio::task::yield_now().await;
    drop(gate);
    assert!(matches!(pending.await.unwrap(), Err("lan-owner-closing")));
    closing.await.unwrap().unwrap();
    assert!(manager.start(config()).await.is_err());
}

#[test]
fn relay_refuses_unrewritable_uri_syntax_and_unsupported_dynamic_manifests() {
    for text in [
        "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI='private'",
        "#EXTM3U\n#EXT-X-KEY:URI=unquoted",
        "#EXTM3U\n#EXT-X-DEFINE:NAME=token,VALUE=secret",
        "#EXTM3U\n{$token}.ts",
        "#EXTM3U\n#EXT-X-PART:URI=\"part.ts\"",
    ] {
        assert!(!supported_manifest(text));
    }
    assert!(supported_manifest("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key?a=secret\"\n#EXT-X-MAP:URI=\"init.mp4\"\nsegment.ts"));
}

#[tokio::test]
async fn controller_actions_are_typed_bounded_scoped_and_revision_checked() {
    let manager = Arc::new(LanManager::default());
    let info = manager.start(config()).await.unwrap();
    let client = client();
    let secret = manager
        .invite_controller(vec!["a".into(), "b".into()])
        .await
        .unwrap();
    let (cookie, _) = pair(&client, &info, &secret).await;
    for payload in [
        serde_json::json!({"sequence":1,"revision":0,"action":"volume","volume":1.1}),
        serde_json::json!({"sequence":1,"revision":0,"action":"pause","channelId":"a"}),
        serde_json::json!({"sequence":1,"revision":0,"action":"admin"}),
        serde_json::json!({"sequence":1,"revision":0,"action":"select","channelId":"a","url":"http://private"}),
    ] {
        assert_eq!(
            client
                .post(format!("{}/control", info.address))
                .header("Origin", &info.address)
                .header("Cookie", &cookie)
                .body(json(&payload))
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
    }
    manager
        .publish("https://example.org/current")
        .await
        .unwrap();
    assert_eq!(
        client
            .post(format!("{}/control", info.address))
            .header("Origin", &info.address)
            .header("Cookie", &cookie)
            .body(json(
                &serde_json::json!({"sequence":1,"revision":0,"action":"pause"})
            ))
            .send()
            .await
            .unwrap()
            .status(),
        409
    );
    for (index, action) in ["next", "previous", "pause", "resume", "mute", "volume"]
        .iter()
        .enumerate()
    {
        let mut body = serde_json::json!({"sequence":index+1,"revision":1,"action":action});
        if *action == "mute" {
            body["muted"] = true.into();
        }
        if *action == "volume" {
            body["volume"] = 0.25.into();
        }
        let sender = client.clone();
        let address = info.address.clone();
        let auth = cookie.clone();
        let response = tokio::spawn(async move {
            sender
                .post(format!("{address}/control"))
                .header("Origin", &address)
                .header("Cookie", auth)
                .body(json(&body))
                .send()
                .await
                .unwrap()
        });
        let command = await_control(&manager).await;
        if matches!(
            command.action,
            ControlAction::Next | ControlAction::Previous
        ) {
            assert_eq!(command.allowed_channel_ids, vec!["a", "b"]);
            assert!(manager.control_allows(&command.command_id, "a").await);
            assert!(!manager.control_allows(&command.command_id, "outside").await);
        }
        assert_eq!(command.revision, 1);
        manager
            .acknowledge_control(&command.command_id, true)
            .await
            .unwrap();
        assert_eq!(response.await.unwrap().status(), 200);
    }
    manager.shutdown().await.unwrap();
}

async fn await_control(manager: &LanManager) -> ControlCommand {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(command) = manager.next_control().await.unwrap() {
                return command;
            }
        }
    })
    .await
    .expect("controller request should reach the host queue within fixture deadline")
}
#[tokio::test]
async fn friendly_channel_labels_stay_controller_scoped_and_bounded() {
    let manager = LanManager::default();
    let info = manager.start(config()).await.unwrap();
    let client = client();
    let (viewer, _) = pair(&client, &info, &info.pairing_secret).await;
    assert_eq!(
        client
            .get(format!("{}/channels", info.address))
            .header("Cookie", viewer)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    for labels in [
        vec![ControllerChannel {
            id: "outside".into(),
            name: "Unknown".into(),
        }],
        vec![ControllerChannel {
            id: "a".into(),
            name: "x".repeat(161),
        }],
        vec![
            ControllerChannel {
                id: "a".into(),
                name: "A".into(),
            },
            ControllerChannel {
                id: "a".into(),
                name: "Duplicate".into(),
            },
        ],
    ] {
        assert!(manager
            .invite_controller_labeled(vec!["a".into()], labels)
            .await
            .is_err());
    }
    let name = "News <img src=x onerror=alert(1)>";
    let secret = manager
        .invite_controller_labeled(
            vec!["a".into()],
            vec![ControllerChannel {
                id: "a".into(),
                name: name.into(),
            }],
        )
        .await
        .unwrap();
    let (controller, _) = pair(&client, &info, &secret).await;
    let reply = client
        .get(format!("{}/channels", info.address))
        .header("Cookie", controller)
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 200);
    let body: serde_json::Value = serde_json::from_slice(&reply.bytes().await.unwrap()).unwrap();
    assert_eq!(body[0]["name"], name);
    assert_eq!(body[0]["id"], "a");
    assert!(body[0].get("url").is_none());
    manager.stop().await.unwrap();
}
