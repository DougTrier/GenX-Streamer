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
use std::sync::atomic::{AtomicBool, AtomicUsize};
fn bookmark_permit_database() -> (
    tempfile::TempDir,
    Arc<crate::storage_transaction::PairStore>,
    archive_bookmarks::Proof,
) {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(crate::storage_transaction::PairStore::new(root.path().into()).unwrap());
    let title = archive_catalog::opaque(&["archive-item-v1", "fixture"]);
    let reference = archive_catalog::opaque(&["archive-file-v1", "fixture", "episode.mp4"]);
    let proof=store.with_guide_write(|c| {
            c.execute_batch("CREATE TABLE permit_fixture(id INTEGER PRIMARY KEY,payload BLOB);INSERT INTO permit_fixture VALUES(1,zeroblob(1048576));").map_err(|_|"fixture")?;
            c.execute("INSERT INTO archive_title_v1(title_ref,item_id,title,kind,release_year,curated,searched,rights,downloads,observed_ms,search_text) VALUES(?1,'fixture','Fixture','tv',1964,0,1,NULL,1,1,'fixture')",[&title]).map_err(|_|"fixture")?;
            c.execute("INSERT INTO archive_file_v1(file_ref,title_ref,item_id,file_name,format,size_bytes,sha1,servers,observed_ms,eligible) VALUES(?1,?2,'fixture','episode.mp4','h.264','100','0123456789abcdef0123456789abcdef01234567','[]',1,1)",rusqlite::params![reference,title]).map_err(|_|"fixture")?;
            archive_bookmarks::capture(&reference,&archive_catalog::resolve(c,&reference,"0")?)
        }).unwrap();
    (root, store, proof)
}
fn bookmark_permit_position() -> archive_bookmarks::Position {
    archive_bookmarks::Position {
        position_ms: 16_182,
        duration_ms: Some(1_463_897),
        completed: false,
        observed_ms: 1000,
    }
}
#[test]
fn archive_bookmark_save_permit_real_admission_denies_expired_new_job_and_retains_context_cancellation(
) {
    for cancel_command in [false, true] {
        let (_root, command, playback, _work, mut requests) =
            scan_manifest_work::bookmark_context_fixture();
        let (valid, expire_media) = crate::archive_playback_proxy::bookmark_lease_fixture();
        let expected = GENERATION.load(Ordering::SeqCst);
        let session = Arc::new(BookmarkSession {
            local: None,
            file: Arc::new(archive_catalog::ResolvedFile {
                item_id: "fixture".into(),
                file_name: "episode.mp4".into(),
                size_bytes: "100".into(),
                sha1: Some("0123456789abcdef0123456789abcdef01234567".into()),
                servers: vec![],
                duration_seconds: Some(60.0),
                provider_index: None,
                public: None,
            }),
            reference: archive_catalog::opaque(&["archive-file-v1", "fixture", "episode.mp4"]),
            root_generation: 1,
            owner: playback.clone(),
            jobs: Arc::new(crate::close_owner::WorkOwner::default()),
            valid,
        });
        let original = BookmarkSavePermit::admit(
            command.clone(),
            session.clone(),
            expected,
            std::time::Instant::now(),
        )
        .unwrap();
        assert!(
            matches!(BookmarkSavePermit::admit(command.clone(),session.clone(),expected,std::time::Instant::now()-BOOKMARK_SAVE_BUDGET),Err(error) if error=="archive-bookmark-save-deadline")
        );
        expire_media();
        assert!(
            matches!(bookmark_admission(&command,&session,expected),Err(error) if error=="archive-playback-expired")
        );
        assert!(
            matches!(BookmarkSavePermit::admit(command.clone(), session, expected, std::time::Instant::now()),Err(error) if error=="archive-playback-expired")
        );
        original.check().unwrap();
        requests
            .cancel(
                if cancel_command {
                    "bookmark-command-fixture"
                } else {
                    "manifest-fixture"
                }
                .into(),
            )
            .unwrap();
        assert!(matches!(original.check(),Err(error) if error=="canceled"));
        if cancel_command {
            playback.check().unwrap();
        } else {
            command.check().unwrap();
        }
    }
}
#[tokio::test]
async fn archive_bookmark_save_permit_held_backup_survives_media_expiry_but_new_admission_is_denied(
) {
    for strict_media_during_job in [true, false] {
        let (_root, store, proof) = bookmark_permit_database();
        let (media_valid, expire_media) = crate::archive_playback_proxy::bookmark_lease_fixture();
        assert!(media_valid()); // Required before any save permit is minted.
        let admitted_at = std::time::Instant::now();
        let permit = BookmarkSavePermit {
            ends: admitted_at + BOOKMARK_SAVE_BUDGET,
            authority: Box::new(|| Ok(())),
        };
        let clock = Arc::new(AtomicU64::new(0));
        let actual_clock = clock.clone();
        let actual_media = media_valid.clone();
        let jobs = Arc::new(crate::close_owner::WorkOwner::default());
        let original_job = jobs.acquire();
        let producer_store = store.clone();
        let (entered, pinned) = tokio::sync::oneshot::channel();
        let (release, held) = std::sync::mpsc::channel();
        let (outcome, observed) = tokio::sync::oneshot::channel();
        let producer = tokio::task::spawn_blocking(move || {
            let _original_job = original_job;
            let calls = AtomicUsize::new(0);
            let signal = std::sync::Mutex::new(Some(entered));
            let check = || {
                // PairStore admission/preflight/backup admission precede the
                // fourth check, actual BackupPhase::SnapshotPinned.
                if calls.fetch_add(1, Ordering::SeqCst) == 3 {
                    signal.lock().unwrap().take().unwrap().send(()).unwrap();
                    held.recv().unwrap();
                }
                if strict_media_during_job && !actual_media() {
                    return Err("archive-playback-expired".into());
                }
                permit.check_with_clock(|| {
                    admitted_at
                        + std::time::Duration::from_secs(actual_clock.load(Ordering::SeqCst))
                })
            };
            let result = producer_store.write_archive_bookmark_checked(
                &proof,
                "0",
                &bookmark_permit_position(),
                check,
            );
            outcome.send(result).ok();
        });
        pinned.await.unwrap();
        drop(producer); // Original SQL worker remains owned independently.
        expire_media();
        clock.store(61, Ordering::SeqCst);
        assert!(!media_valid()); // Strict read/renew/new-save admission remains false.
        let retained_jobs = jobs.clone();
        let mut stop = tokio::spawn(async move { join_bookmark_jobs(&retained_jobs).await });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), &mut stop)
                .await
                .is_err()
        );
        assert_eq!(jobs.count(), 1);
        release.send(()).unwrap();
        stop.await.unwrap();
        let receipt = observed.await.unwrap();
        if strict_media_during_job {
            assert!(matches!(receipt,Err(error) if error=="archive-playback-expired"));
        } else {
            let receipt = receipt.unwrap();
            assert!(receipt.committed && receipt.changed);
            assert_eq!(receipt.revision, "1");
        }
        store
            .with_guide_read(|c| {
                let expected = if strict_media_during_job { 0 } else { 1 };
                assert_eq!(
                    c.query_row("SELECT revision FROM archive_bookmark_meta_v1", [], |r| r
                        .get::<_, i64>(
                        0
                    ))
                    .unwrap(),
                    expected
                );
                if !strict_media_during_job {
                    assert_eq!(
                        c.query_row("SELECT position_ms FROM archive_bookmark_v1", [], |r| r
                            .get::<_, i64>(0))
                            .unwrap(),
                        16_182
                    );
                }
                Ok(())
            })
            .unwrap();
        assert!(!media_valid()); // Committing storage never revives media.
        assert_eq!(jobs.count(), 0);
    }
}
#[tokio::test]
async fn archive_bookmark_save_permit_held_backup_still_refuses_cancel_close_replacement_and_deadline(
) {
    for revoke in [
        "command-cancel",
        "playback-cancel",
        "closing",
        "generation",
        "deadline",
    ] {
        let (root, store, proof) = bookmark_permit_database();
        let before = (
            std::fs::read(root.path().join("genx.sqlite3")).unwrap(),
            std::fs::read(root.path().join("genx.sqlite3.backup")).unwrap(),
        );
        let generation = Arc::new(AtomicU64::new(1));
        let command_canceled = Arc::new(AtomicBool::new(false));
        let playback_canceled = Arc::new(AtomicBool::new(false));
        let closing = Arc::new(AtomicBool::new(false));
        let actual_generation = generation.clone();
        let command = command_canceled.clone();
        let playback = playback_canceled.clone();
        let close = closing.clone();
        let admitted_at = std::time::Instant::now();
        // Controlled authority boundary corresponds to both retained native
        // Contexts and exact generation. Their real root/cancel behavior is
        // separately covered by scan_manifest_work ownership fixtures.
        let permit = BookmarkSavePermit {
            ends: admitted_at + BOOKMARK_SAVE_BUDGET,
            authority: Box::new(move || {
                if close.load(Ordering::SeqCst) {
                    return Err("application-closing".into());
                }
                if command.load(Ordering::SeqCst) || playback.load(Ordering::SeqCst) {
                    return Err("canceled".into());
                }
                if actual_generation.load(Ordering::SeqCst) != 1 {
                    return Err("archive-playback-session-invalid".into());
                }
                Ok(())
            }),
        };
        let clock = Arc::new(AtomicU64::new(0));
        let actual_clock = clock.clone();
        let jobs = Arc::new(crate::close_owner::WorkOwner::default());
        let original_job = jobs.acquire();
        let producer_store = store.clone();
        let (entered, pinned) = tokio::sync::oneshot::channel();
        let (release, held) = std::sync::mpsc::channel();
        let producer = tokio::task::spawn_blocking(move || {
            let _original_job = original_job;
            let calls = AtomicUsize::new(0);
            let signal = std::sync::Mutex::new(Some(entered));
            producer_store.write_archive_bookmark_checked(
                &proof,
                "0",
                &bookmark_permit_position(),
                || {
                    if calls.fetch_add(1, Ordering::SeqCst) == 3 {
                        signal.lock().unwrap().take().unwrap().send(()).unwrap();
                        held.recv().unwrap();
                    }
                    permit.check_with_clock(|| {
                        admitted_at
                            + std::time::Duration::from_secs(actual_clock.load(Ordering::SeqCst))
                    })
                },
            )
        });
        pinned.await.unwrap();
        match revoke {
            "command-cancel" => command_canceled.store(true, Ordering::SeqCst),
            "playback-cancel" => playback_canceled.store(true, Ordering::SeqCst),
            "closing" => closing.store(true, Ordering::SeqCst),
            "generation" => revoke_exact(&generation, 1),
            _ => clock.store(120, Ordering::SeqCst),
        }
        let retained_jobs = jobs.clone();
        let mut stop = tokio::spawn(async move { join_bookmark_jobs(&retained_jobs).await });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), &mut stop)
                .await
                .is_err()
        );
        release.send(()).unwrap();
        let result = producer.await.unwrap();
        let expected = match revoke {
            "closing" => "application-closing",
            "generation" => "archive-playback-session-invalid",
            "deadline" => "archive-bookmark-save-deadline",
            _ => "canceled",
        };
        assert!(matches!(result,Err(error) if error==expected));
        stop.await.unwrap();
        assert_eq!(jobs.count(), 0);
        assert_eq!(
            (
                std::fs::read(root.path().join("genx.sqlite3")).unwrap(),
                std::fs::read(root.path().join("genx.sqlite3.backup")).unwrap()
            ),
            before
        );
    }
}
#[test]
fn archive_bookmark_save_wire_is_session_only_and_rejects_invented_authority() {
    let base = serde_json::json!({"schemaVersion":1,"sessionGeneration":"1","expectedRevision":"0","positionMs":12345,"durationMs":60000,"completed":false});
    assert!(serde_json::from_value::<BookmarkSaveRequest>(base.clone()).is_ok());
    for field in ["fileRef", "url", "observedMs", "rootGeneration"] {
        let mut injected = base.clone();
        injected[field] = serde_json::json!("invented");
        assert!(serde_json::from_value::<BookmarkSaveRequest>(injected).is_err());
    }
    let mut injected = base;
    injected["positionMs"] = serde_json::json!(1.5);
    assert!(serde_json::from_value::<BookmarkSaveRequest>(injected).is_err());
}
#[tokio::test]
async fn archive_bookmark_stop_join_retains_original_sql_worker_after_observer_loss_and_revocation()
{
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(crate::storage_transaction::PairStore::new(root.path().into()).unwrap());
    let item = "fixture";
    let reference = archive_catalog::opaque(&["archive-file-v1", item, "episode.mp4"]);
    let title = archive_catalog::opaque(&["archive-item-v1", item]);
    let proof=store.with_guide_write(|c|{
            c.execute("INSERT INTO archive_title_v1(title_ref,item_id,title,kind,release_year,curated,searched,rights,downloads,observed_ms,search_text) VALUES(?1,'fixture','Fixture','tv',1964,0,1,NULL,1,1,'fixture')",[&title]).map_err(|_|"fixture")?;
            c.execute("INSERT INTO archive_file_v1(file_ref,title_ref,item_id,file_name,format,size_bytes,sha1,servers,observed_ms,eligible) VALUES(?1,?2,'fixture','episode.mp4','h.264','100','0123456789abcdef0123456789abcdef01234567','[]',1,1)",rusqlite::params![reference,title]).map_err(|_|"fixture")?;
            archive_bookmarks::capture(&reference,&archive_catalog::resolve(c,&reference,"0")?)
        }).unwrap();
    let jobs = Arc::new(crate::close_owner::WorkOwner::default());
    let actual_guard = jobs.acquire();
    let generation = Arc::new(AtomicU64::new(1));
    let g = generation.clone();
    let producer_store = store.clone();
    let (ready, started) = tokio::sync::oneshot::channel();
    let (release, held) = tokio::sync::oneshot::channel();
    let (outcome, result) = tokio::sync::oneshot::channel();
    let observer = tokio::task::spawn_blocking(move || {
        let _actual_guard = actual_guard;
        ready.send(()).unwrap();
        held.blocking_recv().unwrap();
        let check = || {
            if g.load(Ordering::SeqCst) == 1 {
                Ok(())
            } else {
                Err("archive-playback-session-invalid".into())
            }
        };
        let position = archive_bookmarks::Position {
            position_ms: 12345,
            duration_ms: Some(60000),
            completed: false,
            observed_ms: 1000,
        };
        let saved = producer_store.write_archive_bookmark_checked(&proof, "0", &position, check);
        outcome.send(saved.is_err()).unwrap();
    });
    started.await.unwrap();
    drop(observer); // Original producer still owns its job.
    revoke_exact(&generation, 1);
    let j = jobs.clone();
    let mut stop = tokio::spawn(async move {
        join_bookmark_jobs(&j).await;
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(5), &mut stop)
            .await
            .is_err()
    );
    assert_eq!(jobs.count(), 1);
    release.send(()).unwrap();
    stop.await.unwrap();
    assert!(result.await.unwrap());
    assert_eq!(jobs.count(), 0);
    store
        .with_guide_read(|c| {
            assert_eq!(
                c.query_row("SELECT revision FROM archive_bookmark_meta_v1", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
                0
            );
            assert_eq!(
                c.query_row("SELECT count(*) FROM archive_bookmark_v1", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            Ok(())
        })
        .unwrap();
}
#[tokio::test]
async fn cleanup_after_close_retains_actual_join_when_observer_disappears() {
    let mut requests = crate::requests::Requests::default();
    let owner = requests.drain_owner();
    requests.stop();
    assert_eq!(
        requests.register("ordinary-start".into()).unwrap_err(),
        "application-closing"
    );
    let (release, receive) = tokio::sync::oneshot::channel();
    let settled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let actual = settled.clone();
    let observer = spawn_cleanup(owner.acquire(), async move {
        receive
            .await
            .map_err(|_| "fixture-release-lost".to_string())?;
        actual.store(true, Ordering::SeqCst);
        Ok(())
    });
    drop(observer);
    assert_eq!(owner.count(), 1);
    assert!(!settled.load(Ordering::SeqCst));
    release.send(()).unwrap();
    owner.drained().await;
    assert!(settled.load(Ordering::SeqCst));
    assert_eq!(owner.count(), 0);
}
#[tokio::test]
async fn cleanup_preserves_failure_instead_of_claiming_joined_success() {
    let owner = Arc::new(crate::close_owner::WorkOwner::default());
    let result = spawn_cleanup::<(), _>(owner.acquire(), async {
        Err("archive-producer-stop-failed".to_string())
    })
    .await
    .unwrap();
    assert_eq!(result.unwrap_err(), "archive-producer-stop-failed");
    assert_eq!(owner.count(), 0);
}
#[test]
fn exact_stop_is_idempotent_after_shutdown_and_cannot_revoke_replacement() {
    let current = AtomicU64::new(10);
    revoke_exact(&current, 10);
    assert_eq!(current.load(Ordering::SeqCst), 11);
    revoke_exact(&current, 10);
    assert_eq!(current.load(Ordering::SeqCst), 11);
    // A shutdown or replacement has already revoked generation 10.
    current.store(12, Ordering::SeqCst);
    revoke_exact(&current, 10);
    assert_eq!(current.load(Ordering::SeqCst), 12);
    revoke_exact(&current, 13);
    assert_eq!(current.load(Ordering::SeqCst), 12);
}
#[test]
fn cleanup_wire_validation_is_preserved_without_request_registry_admission() {
    assert!(validate_cleanup_request_id("").is_err());
    assert!(validate_cleanup_request_id(&"x".repeat(129)).is_err());
    assert!(validate_cleanup_request_id(&"x".repeat(128)).is_ok());
    assert!(request_generation(&SessionRequest {
        schema_version: 2,
        session_generation: "1".into(),
    })
    .is_err());
}
#[test]
fn removal_scope_preserves_unrelated_archive_playback() {
    use archive_catalog::RemovalScope::*;
    assert!(removal_matches(&All, "title-a", "file-a"));
    assert!(removal_matches(
        &TitleRef("title-a".into()),
        "title-a",
        "file-a"
    ));
    assert!(removal_matches(
        &FileRef("file-a".into()),
        "title-a",
        "file-a"
    ));
    assert!(!removal_matches(
        &TitleRef("title-b".into()),
        "title-a",
        "file-a"
    ));
    assert!(!removal_matches(
        &FileRef("file-b".into()),
        "title-a",
        "file-a"
    ));
    assert!(!removal_matches(
        &TitleRef("file-a".into()),
        "title-a",
        "file-a"
    ));
}
#[test]
fn generations_are_canonical_positive_and_bounded() {
    for s in ["", "0", "01", "-1", "1.0", "18446744073709551616"] {
        assert!(generation(s).is_err());
    }
    assert_eq!(generation("18446744073709551615").unwrap(), u64::MAX);
}
#[test]
fn confirmed_dead_receipt_has_no_playback_or_upstream_fields() {
    let receipt = StartResult::ConfirmedDead {
        receipt: archive_catalog::DeadReceipt {
            schema_version: 1,
            committed: true,
            revision: "2".into(),
            confirmed_dead: 1,
            title_count: 0,
        },
    };
    let value = serde_json::to_value(receipt).unwrap();
    assert_eq!(value["kind"], "confirmedDead");
    assert_eq!(value["committed"], true);
    assert_eq!(value.as_object().unwrap().len(), 6);
    assert!(value.get("mediaUrl").is_none());
}
