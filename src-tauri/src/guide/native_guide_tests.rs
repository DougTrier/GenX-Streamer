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
fn staged(source: &str, request: &str, generation: u64, canceled: Arc<AtomicBool>) -> Stage {
    Stage {
        request_id: request.into(),
        source_id: source.into(),
        source_revision: 1,
        root_generation: 1,
        retention_scope: None,
        generation,
        parsed: Arc::new(
            parser::parse_guide(
                b"<tv><channel id='fox'><display-name>Fox</display-name></channel></tv>",
            )
            .unwrap(),
        ),
        canceled,
        created: Instant::now(),
    }
}
#[test]
fn superseded_preview_cannot_publish_or_reuse_its_ticket() {
    let owner = Arc::new(NativeGuides::default());
    let (old, old_flag, old_active) = owner.begin("g", "old").unwrap();
    let ticket = owner
        .stage(staged("g", "old", old, old_flag.clone()))
        .unwrap();
    drop(old_active);
    let (new, new_flag, _active) = owner.begin("g", "new").unwrap();
    assert!(old_flag.load(Ordering::SeqCst));
    assert!(owner.ticket(&ticket).is_err());
    assert!(owner.stage(staged("g", "old", old, old_flag)).is_err());
    let current = owner.stage(staged("g", "new", new, new_flag)).unwrap();
    assert!(owner.ticket(&current).is_ok());
}
#[test]
fn late_cancel_after_preview_completion_revokes_staged_commit_flag() {
    let owner = Arc::new(NativeGuides::default());
    let (generation, flag, active) = owner.begin("g", "request").unwrap();
    let ticket = owner
        .stage(staged("g", "request", generation, flag.clone()))
        .unwrap();
    drop(active);
    let stage = owner.ticket(&ticket).unwrap();
    let _commit = owner
        .active_commit(&ticket, stage.canceled.clone())
        .unwrap();
    assert!(owner.active_commit(&ticket, flag.clone()).is_err());
    owner.cancel_request("request").unwrap();
    assert!(flag.load(Ordering::SeqCst));
    assert!(owner.ticket(&ticket).is_err());
}
#[test]
fn preview_ticket_limit_and_expiry_are_explicit() {
    let owner = Arc::new(NativeGuides::default());
    let mut tickets = Vec::new();
    for n in 0..2 {
        let id = format!("guide-{n}");
        let (generation, flag, active) = owner.begin(&id, &id).unwrap();
        tickets.push(owner.stage(staged(&id, &id, generation, flag)).unwrap());
        drop(active);
    }
    let (generation, flag, _active) = owner.begin("third", "third").unwrap();
    assert_eq!(
        owner
            .stage(staged("third", "third", generation, flag.clone()))
            .unwrap_err(),
        "guide-preview-ticket-limit"
    );
    owner
        .ownership
        .lock()
        .unwrap()
        .stages
        .get_mut(&tickets[0])
        .unwrap()
        .created = Instant::now() - Duration::from_secs(121);
    assert!(owner.ticket(&tickets[0]).is_err());
    assert!(owner
        .stage(staged("third", "third", generation, flag))
        .is_ok());
}
#[tokio::test]
async fn shutdown_cancels_and_waits_for_owned_work() {
    let owner = Arc::new(NativeGuides::default());
    let (_, flag, active) = owner.begin("g", "running").unwrap();
    let shutdown_owner = owner.clone();
    let shutdown = tokio::spawn(async move { shutdown_owner.shutdown().await });
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert!(flag.load(Ordering::SeqCst));
    assert!(owner.begin("g", "late").is_err());
    assert!(!shutdown.is_finished());
    drop(active);
    assert!(tokio::time::timeout(Duration::from_secs(1), shutdown)
        .await
        .unwrap()
        .unwrap()
        .is_ok());
}

#[tokio::test]
async fn file_upload_exact_chunks_preserve_original_generation_and_revision() {
    let owner = Arc::new(NativeGuides::default());
    let started = owner
        .start_upload("file".into(), "request".into(), 7, FILE_CHUNK + 2)
        .unwrap();
    assert_eq!(started.chunk_bytes, FILE_CHUNK);
    assert_eq!(
        owner
            .append_upload(&started.upload_id, 0, vec![65; FILE_CHUNK])
            .unwrap()
            .received_bytes,
        FILE_CHUNK
    );
    assert_eq!(
        owner
            .append_upload(&started.upload_id, FILE_CHUNK, vec![66, 67])
            .unwrap()
            .received_bytes,
        FILE_CHUNK + 2
    );
    let upload = owner.take_upload(&started.upload_id).unwrap();
    assert_eq!(upload.admission.revision, 7);
    assert_eq!(&upload.bytes[FILE_CHUNK..], &[66, 67]);
    let generation = upload.admission.generation;
    let (admitted, flag, active) = owner
        .admit_upload(&upload.source_id, &upload.request_id, upload.admission)
        .unwrap();
    assert_eq!(admitted, generation);
    assert!(owner
        .stage(staged("file", "request", admitted, flag))
        .is_ok());
    drop(active);
    owner.shutdown().await.unwrap();
}
#[tokio::test]
async fn malformed_offset_size_or_overflow_invalidates_whole_file_upload() {
    for (offset, bytes) in [
        (1, vec![1]),
        (0, vec![]),
        (0, vec![1; FILE_CHUNK + 1]),
        (0, vec![1; 4]),
    ] {
        let owner = Arc::new(NativeGuides::default());
        let start = owner.start_upload("f".into(), "r".into(), 1, 3).unwrap();
        let canceled = owner.ownership.lock().unwrap().latest["f"].1.clone();
        assert!(owner
            .append_upload(&start.upload_id, offset, bytes)
            .is_err());
        assert!(owner.take_upload(&start.upload_id).is_err());
        assert!(canceled.load(Ordering::SeqCst));
        owner.discard_upload(&start.upload_id).unwrap();
        owner.discard_upload(&start.upload_id).unwrap();
        owner.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn one_upload_slot_and_input_limit_refuse_without_replacing_owner() {
    let owner = Arc::new(NativeGuides::default());
    for total in [0, input::INPUT_LIMIT + 1] {
        assert!(owner
            .start_upload("f".into(), "r".into(), 1, total)
            .is_err());
    }
    let start = owner.start_upload("f".into(), "r".into(), 1, 3).unwrap();
    assert!(owner
        .start_upload("other".into(), "other-request".into(), 2, 1)
        .is_err());
    assert_eq!(owner.ownership.lock().unwrap().uploads.len(), 1);
    owner.append_upload(&start.upload_id, 0, vec![1]).unwrap();
    assert!(owner.take_upload(&start.upload_id).is_err());
    assert!(owner.ownership.lock().unwrap().uploads.is_empty());
    owner.shutdown().await.unwrap();
}
#[tokio::test]
async fn cancel_and_supersession_release_file_buffer_and_refuse_old_generation() {
    let owner = Arc::new(NativeGuides::default());
    let first = owner.start_upload("f".into(), "r".into(), 1, 3).unwrap();
    owner.append_upload(&first.upload_id, 0, vec![1]).unwrap();
    owner.cancel_request("r").unwrap();
    assert!(owner.ownership.lock().unwrap().uploads.is_empty());
    assert!(owner.take_upload(&first.upload_id).is_err());
    let second = owner.start_upload("f".into(), "r2".into(), 1, 1).unwrap();
    owner.append_upload(&second.upload_id, 0, vec![2]).unwrap();
    let upload = owner.take_upload(&second.upload_id).unwrap();
    let (_, _, new_active) = owner.begin("f", "new-preview").unwrap();
    assert!(owner.admit_upload("f", "r2", upload.admission).is_err());
    drop(new_active);
    owner.shutdown().await.unwrap();
}
#[tokio::test(start_paused = true)]
async fn owned_expiry_timer_drops_idle_buffer_even_while_chunks_arrive() {
    let owner = Arc::new(NativeGuides::default());
    let start = owner
        .start_upload_for("f".into(), "r".into(), 1, 10, Duration::from_secs(120))
        .unwrap();
    let flag = owner.ownership.lock().unwrap().latest["f"].1.clone();
    let deadline = owner.ownership.lock().unwrap().uploads[&start.upload_id].deadline;
    // Register the actual owned timer, then move its scheduler clock. A busy
    // host must not turn an intended pre-expiry chunk into a late append.
    tokio::task::yield_now().await;
    for offset in 0..2 {
        owner
            .append_upload(&start.upload_id, offset, vec![1])
            .unwrap();
        assert_eq!(
            owner.ownership.lock().unwrap().uploads[&start.upload_id].deadline,
            deadline
        );
        tokio::time::advance(Duration::from_secs(40)).await;
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_secs(39)).await;
    tokio::task::yield_now().await;
    assert_eq!(owner.ownership.lock().unwrap().uploads.len(), 1);
    assert!(!flag.load(Ordering::SeqCst));
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    // Observe timer-owned removal before calling any API that could prune it.
    assert!(owner.ownership.lock().unwrap().uploads.is_empty());
    assert!(flag.load(Ordering::SeqCst));
    assert!(owner.append_upload(&start.upload_id, 2, vec![1]).is_err());
    owner.shutdown().await.unwrap();
}
#[tokio::test]
async fn close_clears_and_joins_upload_timer_without_retaining_owner() {
    let owner = Arc::new(NativeGuides::default());
    let start = owner.start_upload("f".into(), "r".into(), 1, 3).unwrap();
    owner.append_upload(&start.upload_id, 0, vec![1]).unwrap();
    owner.shutdown().await.unwrap();
    owner.shutdown().await.unwrap();
    assert!(owner.ownership.lock().unwrap().uploads.is_empty());
    assert_eq!(Arc::strong_count(&owner), 1);
    assert!(owner
        .start_upload("f".into(), "again".into(), 1, 1)
        .is_err());
}
#[tokio::test]
async fn queued_cancel_after_admission_cannot_skip_new_file_owner() {
    let owner = Arc::new(NativeGuides::default());
    let requests = Arc::new(Mutex::new(crate::requests::Requests::default()));
    {
        let mut locked = requests.lock().unwrap();
        locked.admit_pending("request").unwrap();
        let cancel_owner = owner.clone();
        let cancel_requests = requests.clone();
        let cancel = std::thread::spawn(move || {
            cancel_requests
                .lock()
                .unwrap()
                .cancel("request".into())
                .unwrap();
            cancel_owner.cancel_request("request").unwrap();
        });
        let start = owner
            .start_upload("f".into(), "request".into(), 1, 1)
            .unwrap();
        drop(locked);
        cancel.join().unwrap();
        assert!(owner.append_upload(&start.upload_id, 0, vec![1]).is_err());
    }
    owner.shutdown().await.unwrap();
}

#[test]
fn terminal_unique_preview_generations_are_reclaimed_without_erasing_live_fences() {
    let owner = Arc::new(NativeGuides::default());
    for n in 0..512 {
        let id = format!("failed-proposal-{n}");
        let (_, flag, active) = owner.begin(&id, &id).unwrap();
        drop(flag);
        drop(active); // Models HTTP/parse refusal before stage publication.
        assert!(owner.ownership.lock().unwrap().latest.is_empty());
    }
    for n in 0..512 {
        let id = format!("discarded-proposal-{n}");
        let (generation, flag, active) = owner.begin(&id, &id).unwrap();
        let ticket = owner.stage(staged(&id, &id, generation, flag)).unwrap();
        drop(active);
        assert_eq!(owner.ownership.lock().unwrap().latest.len(), 1);
        owner.discard(&ticket).unwrap();
        assert!(owner.ownership.lock().unwrap().latest.is_empty());
    }
}
#[test]
fn pruning_keeps_active_staged_and_committing_generation_until_last_owner_settles() {
    let owner = Arc::new(NativeGuides::default());
    let (generation, flag, active) = owner.begin("live", "request").unwrap();
    owner.ownership.lock().unwrap().prune();
    assert_eq!(owner.ownership.lock().unwrap().latest["live"].0, generation);
    let ticket = owner
        .stage(staged("live", "request", generation, flag))
        .unwrap();
    drop(active);
    owner.ownership.lock().unwrap().prune();
    let stage = owner.ticket(&ticket).unwrap();
    let commit = owner
        .active_commit(&ticket, stage.canceled.clone())
        .unwrap();
    owner.discard(&ticket).unwrap();
    owner.ownership.lock().unwrap().prune();
    assert!(stage.canceled.load(Ordering::SeqCst));
    assert_eq!(owner.ownership.lock().unwrap().latest["live"].0, generation);
    drop(stage);
    drop(commit);
    assert!(owner.ownership.lock().unwrap().latest.is_empty());
}
#[tokio::test]
async fn generation_cleanup_preserves_taken_upload_admission_and_reclaims_terminal_uploads() {
    let owner = Arc::new(NativeGuides::default());
    for n in 0..64 {
        let id = format!("upload-{n}");
        let start = owner.start_upload(id.clone(), id.clone(), 1, 1).unwrap();
        owner.append_upload(&start.upload_id, 0, vec![1]).unwrap();
        let upload = owner.take_upload(&start.upload_id).unwrap();
        owner.ownership.lock().unwrap().prune();
        assert_eq!(
            owner.ownership.lock().unwrap().latest[&id].0,
            upload.admission.generation
        );
        let (_, flag, active) = owner.admit_upload(&id, &id, upload.admission).unwrap();
        drop(flag);
        drop(active);
        assert!(owner.ownership.lock().unwrap().latest.is_empty());
        let start = owner.start_upload(id.clone(), id, 1, 1).unwrap();
        owner.discard_upload(&start.upload_id).unwrap();
        assert!(owner.ownership.lock().unwrap().latest.is_empty());
    }
    owner.shutdown().await.unwrap();
}
