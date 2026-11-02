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

//! Retained metadata paging and native-only account media resolution.
//! Only Page implements Serialize. NativeSelection and Authority never cross IPC;
//! callers retain Context through proxy work and join it on stop/background/exit.
use crate::platform::playback_trace::{native_authority_failure, AuthorityMode, AuthorityPhase};
use crate::{
    account_media_store,
    scan_manifest_work::{self, Context},
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};

const ERR: &str = "account-catalog-request-invalid";
const PAGE_LIMIT: usize = 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListRequest {
    pub schema_version: u8,
    pub account_id: String,
    pub expected_account_revision: String,
    pub expected_media_revision: Option<String>,
    pub after_id: String,
    pub limit: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    pub schema_version: u8,
    pub account_id: String,
    pub account_revision: String,
    pub media_revision: String,
    pub channels: Vec<account_media_store::Channel>,
    pub next_after_id: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResolveRequest {
    pub schema_version: u8,
    pub account_id: String,
    pub expected_account_revision: String,
    pub expected_media_revision: String,
    pub stream_reference: String,
}
#[derive(Clone, PartialEq, Eq)]
struct Snapshot {
    account_revision: i64,
    media_revision: i64,
    secret_ref: String,
    batch_id: String,
    origin: String,
}
/// Captured native authority contains only opaque identifiers, revisions and an
/// origin. It retains neither credentials nor an account media URL.
#[derive(Clone)]
pub(crate) struct Authority {
    request: ResolveRequest,
    snapshot: Snapshot,
    root_generation: u64,
    pub origin: String,
}
pub(crate) struct NativeSelection {
    pub media: account_media_store::ResolvedMedia,
    pub authority: Authority,
}
fn sql<T>(value: rusqlite::Result<T>) -> Result<T, String> {
    value.map_err(|error| match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseBusy) => "sqlite-busy".into(),
        Some(rusqlite::ErrorCode::DatabaseLocked) => "sqlite-locked".into(),
        Some(rusqlite::ErrorCode::DiskFull) => "sqlite-storage-full".into(),
        _ => "account-catalog-storage-failed".into(),
    })
}

fn opaque(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn decimal(value: &str) -> Result<i64, String> {
    if value.is_empty()
        || value.len() > 19
        || value.starts_with('0')
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("account-revision-invalid".into());
    }
    value
        .parse::<i64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| "account-revision-invalid".into())
}
fn scoped_id(value: &str, account: &str) -> bool {
    value
        .strip_prefix(&format!("account-{account}-"))
        .is_some_and(|suffix| {
            suffix.len() == 64
                && suffix
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}
fn table(c: &Connection, name: &str) -> Result<bool, String> {
    sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get::<_, bool>(0),
    ))
}
fn snapshot(c: &Connection, account: &str) -> Result<Snapshot, String> {
    if !table(c, "account_vault_meta_v1")? {
        return Err("account-sign-in-required".into());
    }
    let metadata = sql(c.query_row("SELECT m.revision,m.secret_ref,m.server_origin,m.allow_http,v.active,v.revision FROM account_vault_meta_v1 m JOIN account_vault_versions_v1 v ON v.id=m.id WHERE m.id=?1",[account],|r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,bool>(3)?,r.get::<_,bool>(4)?,r.get::<_,i64>(5)?))).optional())?
        .ok_or("account-removed")?;
    if metadata.0 <= 0 || metadata.0 != metadata.5 || !metadata.4 || !opaque(&metadata.1) {
        return Err("account-sign-in-required".into());
    }
    let origin_url = reqwest::Url::parse(&metadata.2).map_err(|_| "account-origin-refused")?;
    if !crate::account_vault::origin_allowed(&origin_url, &metadata.2, metadata.3) {
        return Err("account-origin-refused".into());
    }
    if !table(c, "account_media_catalog_v1")? {
        return Err("account-media-not-collected".into());
    }
    let media = sql(c
        .query_row(
            "SELECT account_revision,secret_ref,batch_id,revision FROM account_media_catalog_v1 WHERE account_id=?1",
            [account],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional())?
    .ok_or("account-media-not-collected")?;
    if media.0 != metadata.0 || media.1 != metadata.1 {
        return Err("account-media-reference-revoked".into());
    }
    if media.3 <= 0 || !opaque(&media.2) {
        return Err("account-media-invalid".into());
    }
    Ok(Snapshot {
        account_revision: metadata.0,
        media_revision: media.3,
        secret_ref: media.1,
        batch_id: media.2,
        origin: metadata.2,
    })
}
fn expect(actual: &Snapshot, account: &str, media: Option<&str>) -> Result<(), String> {
    if actual.account_revision != decimal(account)? {
        return Err("account-revision-conflict".into());
    }
    if let Some(media) = media {
        if actual.media_revision != decimal(media)? {
            return Err("account-media-revision-conflict".into());
        }
    }
    Ok(())
}
fn validate_list(request: &ListRequest) -> Result<(), String> {
    if request.schema_version != 1
        || !opaque(&request.account_id)
        || request.limit == 0
        || request.limit > 64
        || (!request.after_id.is_empty()
            && (!scoped_id(&request.after_id, &request.account_id)
                || request.expected_media_revision.is_none()))
    {
        return Err(ERR.into());
    }
    decimal(&request.expected_account_revision)?;
    if let Some(media) = &request.expected_media_revision {
        decimal(media)?;
    }
    Ok(())
}
fn validate_resolve(request: &ResolveRequest) -> Result<(), String> {
    if request.schema_version != 1
        || !opaque(&request.account_id)
        || !opaque(&request.stream_reference)
    {
        return Err(ERR.into());
    }
    decimal(&request.expected_account_revision)?;
    decimal(&request.expected_media_revision)?;
    Ok(())
}
/// One deferred read transaction pins metadata and both revisions to one SQLite
/// snapshot. Each subsequent page must present those exact captured revisions.
pub(crate) fn read_page(
    c: &Connection,
    request: &ListRequest,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Page, String> {
    validate_list(request)?;
    check()?;
    let tx = sql(c.unchecked_transaction())?;
    let captured = snapshot(&tx, &request.account_id)?;
    expect(
        &captured,
        &request.expected_account_revision,
        request.expected_media_revision.as_deref(),
    )?;
    let rows = account_media_store::list_channels(
        &tx,
        &request.account_id,
        captured.account_revision as u64,
        &request.after_id,
        request.limit,
    )?;
    let mut channels = Vec::with_capacity(rows.len());
    let mut bytes = 512usize;
    let mut previous = request.after_id.as_str();
    let mut refs = std::collections::HashSet::new();
    for row in &rows {
        check()?;
        if !scoped_id(&row.id, &request.account_id)
            || row.id.as_str() <= previous
            || !opaque(&row.stream_reference)
            || !refs.insert(&row.stream_reference)
        {
            return Err("account-media-invalid".into());
        }
        let size = serde_json::to_vec(row)
            .map_err(|_| "account-media-invalid")?
            .len()
            + 1;
        if bytes + size > PAGE_LIMIT {
            if channels.is_empty() {
                return Err("account-catalog-page-too-large".into());
            }
            break;
        }
        previous = &row.id;
        bytes += size;
        channels.push(row.clone());
    }
    let next_after_id = if let Some(last) = channels.last() {
        let remaining = account_media_store::list_channels(
            &tx,
            &request.account_id,
            captured.account_revision as u64,
            &last.id,
            1,
        )?;
        if remaining.is_empty() {
            None
        } else {
            Some(last.id.clone())
        }
    } else {
        None
    };
    check()?;
    sql(tx.commit())?;
    let page = Page {
        schema_version: 1,
        account_id: request.account_id.clone(),
        account_revision: captured.account_revision.to_string(),
        media_revision: captured.media_revision.to_string(),
        channels,
        next_after_id,
    };
    if serde_json::to_vec(&page)
        .map_err(|_| "account-media-invalid")?
        .len()
        > PAGE_LIMIT
    {
        return Err("account-catalog-page-too-large".into());
    }
    check()?;
    Ok(page)
}
pub(crate) async fn list(
    request: ListRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Page, String> {
    validate_list(&request)?;
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (page, _) = owner
            .storage(None, move |store, check| {
                store.with_guide_read(|c| read_page(c, &request, check))
            })
            .await?;
        owner.check()?;
        Ok(page)
    })
    .await
}
pub(crate) async fn resolve(
    owner: Arc<Context>,
    app: tauri::AppHandle,
    request: ResolveRequest,
) -> Result<NativeSelection, String> {
    validate_resolve(&request)?;
    owner.check()?;
    let root = crate::account_vault_owner::directory(&app).await?;
    owner.check()?;
    let preparation_request = request.clone();
    let ((prepared, captured), generation) = owner
        .storage_with_generation(None, move |store, generation, check| {
            store.with_guide_read(|c| {
                check()?;
                let tx = sql(c.unchecked_transaction())?;
                let captured = snapshot(&tx, &preparation_request.account_id)?;
                expect(
                    &captured,
                    &preparation_request.expected_account_revision,
                    Some(&preparation_request.expected_media_revision),
                )?;
                let prepared = account_media_store::prepare_load(
                    &tx,
                    &preparation_request.account_id,
                    &preparation_request.stream_reference,
                    generation,
                    &mut *check,
                )?;
                check()?;
                sql(tx.commit())?;
                Ok((prepared, captured))
            })
        })
        .await?;
    let opened = account_media_store::open(app, root, prepared, || owner.check()).await?;
    owner.check()?;
    let final_request = request.clone();
    let comparison = captured.clone();
    let (media, _) = owner
        .storage_with_generation(Some(generation), move |store, current, check| {
            store.with_guide_read(|c| {
                let tx = sql(c.unchecked_transaction())?;
                let actual = snapshot(&tx, &final_request.account_id)?;
                expect(
                    &actual,
                    &final_request.expected_account_revision,
                    Some(&final_request.expected_media_revision),
                )?;
                if actual != comparison {
                    return Err("account-media-reference-revoked".into());
                }
                let media = account_media_store::finish_load(&tx, opened, current, &mut *check)?;
                check()?;
                sql(tx.commit())?;
                Ok(media)
            })
        })
        .await?;
    for url in media.urls() {
        owner.check()?;
        let parsed = reqwest::Url::parse(url).map_err(|_| "account-media-invalid")?;
        // The origin comparison pins the scheme (HTTP only by explicit grant).
        if !matches!(parsed.scheme(), "https" | "http")
            || parsed.origin().ascii_serialization() != captured.origin
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("account-origin-refused".into());
        }
    }
    owner.check()?;
    let origin = captured.origin.clone();
    Ok(NativeSelection {
        media,
        authority: Authority {
            request,
            snapshot: captured,
            root_generation: generation,
            origin,
        },
    })
}
/// Proxy-compatible authority check. Capture cloned Context + Authority in the
/// proxy's native async callback and retain them until actual proxy shutdown.
pub(crate) async fn verify(owner: Arc<Context>, authority: Authority) -> Result<(), String> {
    verify_with_busy_budget(owner, authority, Duration::from_secs(12)).await
}
const ADMISSION_BUDGET: Duration = Duration::from_secs(20);
const ADMISSION_TIMEOUT: &str = "account-authority-read-admission-timeout";
struct AdmissionWait {
    started: Instant,
}
impl AdmissionWait {
    fn begin() -> Self {
        eprintln!("[GenX authority] event=wait-start reason=owned-writer");
        Self {
            started: Instant::now(),
        }
    }
}
impl Drop for AdmissionWait {
    fn drop(&mut self) {
        eprintln!(
            "[GenX authority] event=wait-end reason=owned-writer elapsed_ms={}",
            self.started.elapsed().as_millis()
        );
    }
}
struct VerifyFailure {
    error: String,
    phase: AuthorityPhase,
    diagnostic: Option<&'static str>,
}
impl VerifyFailure {
    fn owner(error: String) -> Self {
        Self {
            error,
            phase: AuthorityPhase::LiveVerify,
            diagnostic: None,
        }
    }
    fn finish(self) -> String {
        native_authority_failure(
            AuthorityMode::Paid,
            self.phase,
            self.diagnostic.unwrap_or(&self.error),
        );
        self.error
    }
}
/// External SQLite BUSY retains the interactive 2 s attempts and 12 s retry
/// budget. Our own writer's nonwaiting BUSY is pending admission, not a failed
/// snapshot; it releases every lease and is capped by the 20 s callback budget.
async fn verify_with_busy_budget(
    owner: Arc<Context>,
    authority: Authority,
    budget: Duration,
) -> Result<(), String> {
    verify_with_limits(owner, authority, budget, ADMISSION_BUDGET).await
}
async fn verify_with_limits(
    owner: Arc<Context>,
    authority: Authority,
    budget: Duration,
    admission_budget: Duration,
) -> Result<(), String> {
    let started = Instant::now();
    let deadline = started + admission_budget;
    let mut attempt = 0u32;
    let mut pending_busy: Option<VerifyFailure> = None;
    let mut admission_wait: Option<AdmissionWait> = None;
    loop {
        owner.check()?;
        if Instant::now() >= deadline {
            return Err(VerifyFailure::owner(ADMISSION_TIMEOUT.into()).finish());
        }
        // Bound both wall time and admission count, including immediate BUSY.
        if started.elapsed() >= budget || attempt >= 7 {
            if let Some(failure) = pending_busy.take() {
                return Err(failure.finish());
            }
        }
        let result = verify_attempt(owner.clone(), authority.clone(), deadline).await;
        #[cfg(test)]
        authority_sql_diagnostic_tests::observe_attempt_result(&owner, &result);
        // Cancellation/background/close wins even if a blocked read failed.
        owner.check()?;
        if Instant::now() >= deadline {
            return Err(VerifyFailure::owner(ADMISSION_TIMEOUT.into()).finish());
        }
        match result {
            Ok(Some(())) => return Ok(()),
            Ok(None) => {
                // No connection or root lease crosses this wait, and pending
                // admission never represents a successful authority check.
                // Retire an older SQL failure when ownership has moved to our
                // writer. The original SQL clock/count is NOT reset: one fresh
                // post-wait BUSY after that budget must still refuse at once.
                pending_busy = None;
                admission_wait.get_or_insert_with(AdmissionWait::begin);
                tokio::time::sleep(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .min(Duration::from_millis(100)),
                )
                .await;
            }
            Err(failure)
                if busy_retry_allowed(&failure.error, attempt + 1, started.elapsed(), budget) =>
            {
                attempt += 1;
                eprintln!(
                    "[GenX authority] retry reason=storage-busy attempt={attempt} elapsed_ms={}",
                    started.elapsed().as_millis()
                );
                let remaining = budget.saturating_sub(started.elapsed());
                pending_busy = Some(failure);
                tokio::time::sleep(remaining.min(Duration::from_millis(100))).await;
                owner.check()?;
            }
            Err(failure) => return Err(failure.finish()),
        }
    }
}
fn busy_retry_allowed(error: &str, attempt: u32, elapsed: Duration, budget: Duration) -> bool {
    error == "sqlite-busy" && attempt < 7 && elapsed < budget
}
/// Each attempt owns and drops its complete connection, transaction and root
/// lease before any retry wait. A successful old snapshot is never reused.
async fn verify_attempt(
    owner: Arc<Context>,
    authority: Authority,
    deadline: Instant,
) -> Result<Option<()>, VerifyFailure> {
    owner.check().map_err(VerifyFailure::owner)?;
    let (result, _) = owner
        .storage_with_generation(
            Some(authority.root_generation),
            move |store, generation, check| {
                let mut phase = AuthorityPhase::LiveSnapshot;
                let mut diagnostic = None;
                check()?;
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(ADMISSION_TIMEOUT.into());
                }
                let result = store.with_authority_read_admitted(remaining, |c| {
                    check()?;
                    let tx = sql(c.unchecked_transaction())?;
                    let current = snapshot(&tx, &authority.request.account_id)?;
                    if current != authority.snapshot {
                        diagnostic = Some(
                            if current.account_revision != authority.snapshot.account_revision
                                || current.secret_ref != authority.snapshot.secret_ref
                                || current.origin != authority.snapshot.origin
                            {
                                "account-authority-account-changed"
                            } else {
                                "account-authority-media-changed"
                            },
                        );
                        return Err("account-media-reference-revoked".into());
                    }
                    phase = AuthorityPhase::LiveReference;
                    account_media_store::prepare_load(
                        &tx,
                        &authority.request.account_id,
                        &authority.request.stream_reference,
                        generation,
                        &mut *check,
                    )?;
                    check()?;
                    sql(tx.commit())?;
                    Ok(())
                });
                Ok(result.map_err(|error| VerifyFailure {
                    error,
                    phase,
                    diagnostic,
                }))
            },
        )
        .await
        .map_err(VerifyFailure::owner)?;
    owner.check().map_err(VerifyFailure::owner)?;
    result
}

#[cfg(test)]
mod authority_sql_diagnostic_tests {
    use super::*;
    type AttemptObservers = std::collections::HashMap<usize, tokio::sync::oneshot::Sender<()>>;
    fn attempt_observers() -> &'static std::sync::Mutex<AttemptObservers> {
        static OBSERVERS: std::sync::OnceLock<std::sync::Mutex<AttemptObservers>> =
            std::sync::OnceLock::new();
        OBSERVERS.get_or_init(|| std::sync::Mutex::new(AttemptObservers::new()))
    }
    struct AttemptObservation(usize);
    impl Drop for AttemptObservation {
        fn drop(&mut self) {
            attempt_observers().lock().unwrap().remove(&self.0);
        }
    }
    fn observe_first_external_attempt(
        owner: &Arc<Context>,
    ) -> (AttemptObservation, tokio::sync::oneshot::Receiver<()>) {
        let key = Arc::as_ptr(owner) as usize;
        let (send, receive) = tokio::sync::oneshot::channel();
        assert!(attempt_observers()
            .lock()
            .unwrap()
            .insert(key, send)
            .is_none());
        (AttemptObservation(key), receive)
    }
    pub(super) fn observe_attempt_result(
        owner: &Arc<Context>,
        result: &Result<Option<()>, VerifyFailure>,
    ) {
        if !result.as_ref().err().is_some_and(|failure| {
            failure.error == "sqlite-busy" && matches!(failure.phase, AuthorityPhase::LiveSnapshot)
        }) {
            return;
        }
        let observer = attempt_observers()
            .lock()
            .unwrap()
            .remove(&(Arc::as_ptr(owner) as usize));
        if let Some(observer) = observer {
            let _ = observer.send(());
        }
    }
    async fn retained_authority_fixture() -> (
        tempfile::TempDir,
        Arc<Context>,
        Arc<Context>,
        Arc<crate::close_owner::WorkOwner>,
        crate::requests::Requests,
        Authority,
    ) {
        let (root, command, owner, work, requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        let (authority, _) = owner
            .storage_with_generation(None, |store, generation, check| {
                store.with_guide_write(|c| {
                    account_media_store::initialize(c)?;
                    let account = "a".repeat(32);
                    let secret = "b".repeat(32);
                    let batch = "c".repeat(32);
                    let page = "d".repeat(32);
                    let reference = "e".repeat(32);
                    let channel = format!("account-{account}-{}", "f".repeat(64));
                    sql(c.execute("INSERT INTO account_vault_versions_v1(id,revision,active) VALUES(?1,1,1)", [&account]))?;
                    sql(c.execute("INSERT INTO account_vault_meta_v1(id,name,kind,server_origin,allow_http,revision,secret_ref) VALUES(?1,'Fixture','xtream','https://example.invalid',0,1,?2)", rusqlite::params![account, secret]))?;
                    sql(c.execute("INSERT INTO account_vault_references_v1(reference,account_id,account_revision,purpose) VALUES(?1,?2,1,'media')", rusqlite::params![reference, account]))?;
                    sql(c.execute("INSERT INTO account_media_catalog_v1(account_id,account_revision,secret_ref,batch_id,revision) VALUES(?1,1,?2,?3,1)", rusqlite::params![account, secret, batch]))?;
                    sql(c.execute("INSERT INTO account_media_page_v1(page_ref,account_id,batch_id,page_index,cipher_bytes) VALUES(?1,?2,?3,0,1)", rusqlite::params![page, account, batch]))?;
                    sql(c.execute("INSERT INTO account_media_entry_v1(account_id,channel_id,name,category,stream_ref,page_ref) VALUES(?1,?2,'Fixture','News',?3,?4)", rusqlite::params![account, channel, reference, page]))?;
                    sql(c.execute_batch("CREATE TABLE authority_unrelated_probe(n INTEGER);INSERT INTO authority_unrelated_probe VALUES(0);"))?;
                    let captured = snapshot(c, &account)?;
                    account_media_store::prepare_load(c, &account, &reference, generation, &mut *check)?;
                    Ok(Authority {
                        request: ResolveRequest { schema_version: 1, account_id: account, expected_account_revision: "1".into(), expected_media_revision: "1".into(), stream_reference: reference },
                        origin: captured.origin.clone(), snapshot: captured, root_generation: generation,
                    })
                })
            })
            .await
            .unwrap();
        (root, command, owner, work, requests, authority)
    }
    async fn hold_owned_writer(
        command: Arc<Context>,
        mutation: &'static str,
        exclusive: bool,
    ) -> (
        tokio::task::JoinHandle<Result<(), String>>,
        std::sync::mpsc::Sender<()>,
    ) {
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, joined) = std::sync::mpsc::channel();
        let task = tokio::spawn(async move {
            command
                .storage(None, move |store, check| {
                    store.with_guide_write_checked(
                        |c| {
                            if exclusive {
                                sql(c.execute_batch("BEGIN EXCLUSIVE"))?;
                            }
                            sql(c.execute_batch(mutation))?;
                            let _ = entered.send(());
                            joined
                                .recv_timeout(Duration::from_secs(30))
                                .map_err(|_| "fixture-release-missing")?;
                            if exclusive {
                                sql(c.execute_batch("COMMIT"))?;
                            }
                            Ok(())
                        },
                        check,
                    )
                })
                .await
                .map(|_| ())
        });
        ready.await.unwrap();
        (task, release)
    }

    #[derive(Clone, Copy)]
    enum MixedOutcome {
        Success,
        Busy,
        Changed,
        Unknown,
    }
    #[tokio::test]
    async fn external_attempt_ack_requires_the_exact_context_and_live_snapshot_busy_result() {
        let (_root, command, owner, work, requests, _authority) =
            retained_authority_fixture().await;
        let (observation, mut received) = observe_first_external_attempt(&owner);
        let busy = || {
            Err(VerifyFailure {
                error: "sqlite-busy".into(),
                phase: AuthorityPhase::LiveSnapshot,
                diagnostic: None,
            })
        };
        observe_attempt_result(&owner, &Ok(None));
        observe_attempt_result(&command, &busy());
        for (error, phase) in [
            ("sqlite-locked", AuthorityPhase::LiveSnapshot),
            (
                "account-catalog-storage-failed",
                AuthorityPhase::LiveSnapshot,
            ),
            ("sqlite-busy", AuthorityPhase::LiveVerify),
        ] {
            observe_attempt_result(
                &owner,
                &Err(VerifyFailure {
                    error: error.into(),
                    phase,
                    diagnostic: None,
                }),
            );
        }
        assert_eq!(
            received.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        );
        observe_attempt_result(&owner, &busy());
        assert_eq!(received.try_recv(), Ok(()));
        drop(observation);
        let (canceled, mut never) = observe_first_external_attempt(&owner);
        drop(canceled);
        observe_attempt_result(&owner, &busy());
        assert_eq!(
            never.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Closed)
        );
        drop(command);
        drop(owner);
        drop(requests);
        work.drained().await;
    }
    async fn mixed_external_to_owned_writer(outcome: MixedOutcome) {
        let (root, command, owner, work, requests, authority) = retained_authority_fixture().await;
        let path = root.path().join(crate::storage_transaction::DB);
        let external = Connection::open(&path).unwrap();
        external
            .execute_batch("BEGIN EXCLUSIVE;UPDATE authority_unrelated_probe SET n=n+1;")
            .unwrap();
        let started = Instant::now();
        let (observation, actual_attempt) = observe_first_external_attempt(&owner);
        let checking = owner.clone();
        let captured = authority.clone();
        let verifying = tokio::spawn(async move { verify(checking, captured).await });
        // ACK the real verifier's completed external SQL BUSY result. A polling
        // read here would itself take the gate and could starve the verifier.
        let saw_verifier = matches!(
            tokio::time::timeout(
                Duration::from_secs(5).saturating_sub(started.elapsed()),
                actual_attempt,
            )
            .await,
            Ok(Ok(()))
        );
        drop(observation);
        if !saw_verifier {
            external.execute_batch("ROLLBACK").unwrap();
            let _ = verifying.await;
            drop(command);
            drop(owner);
            drop(requests);
            work.drained().await;
            panic!("fixture never observed the original external SQLite attempt");
        }
        let (gate_entered, gate_ready) = tokio::sync::oneshot::channel();
        let (handoff, transferred) = std::sync::mpsc::channel::<Connection>();
        let (sql_entered, sql_ready) = tokio::sync::oneshot::channel();
        let (commit, committed_wait) = std::sync::mpsc::channel();
        let (committed, committed_ready) = tokio::sync::oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let writing = command.clone();
        let writer = tokio::spawn(async move {
            writing
                .storage(None, move |store, check| {
                    let _gate = store.write_lease_checked(&mut || check())?;
                    let _ = gate_entered.send(());
                    // Hand off the still-exclusive real connection, without an
                    // unlocked gap in which a valid snapshot could legitimately win.
                    let c = transferred
                        .recv_timeout(Duration::from_secs(10))
                        .map_err(|_| "fixture-handoff-missing")?;
                    match outcome {
                        MixedOutcome::Changed => {
                            sql(c.execute_batch("UPDATE account_media_catalog_v1 SET revision=2"))?
                        }
                        MixedOutcome::Unknown => sql(c.execute_batch(
                            "ALTER TABLE account_vault_versions_v1 RENAME TO fixture_versions",
                        ))?,
                        _ => (),
                    }
                    let _ = sql_entered.send(());
                    committed_wait
                        .recv_timeout(Duration::from_secs(25))
                        .map_err(|_| "fixture-commit-missing")?;
                    check()?;
                    sql(c.execute_batch("COMMIT"))?;
                    let _ = committed.send(());
                    released
                        .recv_timeout(Duration::from_secs(10))
                        .map_err(|_| "fixture-release-missing")?;
                    Ok(())
                })
                .await
                .map(|_| ())
        });
        gate_ready.await.unwrap();
        handoff
            .send(external)
            .unwrap_or_else(|_| panic!("fixture connection handoff failed"));
        sql_ready.await.unwrap();
        // Past the original12s retry clock, but inside the unchanged20s cap.
        tokio::time::sleep(Duration::from_secs(13).saturating_sub(started.elapsed())).await;
        let prematurely_finished = verifying.is_finished();
        commit.send(()).unwrap();
        committed_ready.await.unwrap();
        let later_external = if matches!(outcome, MixedOutcome::Busy) {
            let c = Connection::open(&path).unwrap();
            c.execute_batch("BEGIN EXCLUSIVE").unwrap();
            Some(c)
        } else {
            None
        };
        release.send(()).unwrap();
        writer.await.unwrap().unwrap();
        let result = verifying.await.unwrap();
        let elapsed = started.elapsed();
        if let Some(c) = later_external {
            c.execute_batch("ROLLBACK").unwrap();
        }
        drop(command);
        drop(owner);
        drop(requests);
        work.drained().await;
        assert!(
            !prematurely_finished,
            "old BUSY incorrectly ended owned admission"
        );
        assert!(
            elapsed < ADMISSION_BUDGET,
            "mixed admission exceeded its existing callback cap"
        );
        match outcome {
            MixedOutcome::Success => assert!(
                result.is_ok(),
                "fresh post-wait success refused: {result:?}"
            ),
            MixedOutcome::Busy => assert_eq!(result.unwrap_err(), "sqlite-busy"),
            MixedOutcome::Changed => {
                assert_eq!(result.unwrap_err(), "account-media-reference-revoked")
            }
            MixedOutcome::Unknown => {
                assert_eq!(result.unwrap_err(), "account-catalog-storage-failed")
            }
        }
    }
    #[tokio::test]
    async fn external_busy_then_owned_admission_allows_one_fresh_success_without_resetting_budgets()
    {
        mixed_external_to_owned_writer(MixedOutcome::Success).await;
    }
    #[tokio::test]
    async fn fresh_busy_after_owned_admission_cannot_restart_the_expired_sql_retry_budget() {
        mixed_external_to_owned_writer(MixedOutcome::Busy).await;
    }
    #[tokio::test]
    async fn changed_account_after_mixed_admission_is_still_refused() {
        mixed_external_to_owned_writer(MixedOutcome::Changed).await;
    }
    #[tokio::test]
    async fn unknown_storage_failure_after_mixed_admission_is_still_refused() {
        mixed_external_to_owned_writer(MixedOutcome::Unknown).await;
    }

    #[tokio::test]
    async fn readable_owned_writer_preparation_does_not_delay_fresh_authority_for_its_gate() {
        let (_root, command, owner, work, requests, authority) = retained_authority_fixture().await;
        let (writer, release) = hold_owned_writer(
            command.clone(),
            "UPDATE authority_unrelated_probe SET n=n+1",
            false,
        )
        .await;
        let started = Instant::now();
        let result =
            tokio::time::timeout(Duration::from_secs(1), verify(owner.clone(), authority)).await;
        let elapsed = started.elapsed();
        // Retain a readable real writer gate for the same17s as the exclusive
        // fixture. Merely queuing behind the gate would wrongly delay/expire.
        tokio::time::sleep(Duration::from_secs(17).saturating_sub(started.elapsed())).await;
        release.send(()).unwrap();
        writer.await.unwrap().unwrap();
        drop(command);
        drop(owner);
        drop(requests);
        work.drained().await;
        assert!(
            matches!(result, Ok(Ok(()))),
            "readable preparation delayed or denied fresh authority: {result:?}"
        );
        assert!(elapsed < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn owned_writer_admission_rechecks_account_media_and_reference_mutations() {
        for mutation in [
            "UPDATE account_vault_versions_v1 SET revision=2;UPDATE account_vault_meta_v1 SET revision=2;UPDATE account_media_catalog_v1 SET account_revision=2",
            "UPDATE account_media_catalog_v1 SET revision=2",
            "DELETE FROM account_vault_references_v1 WHERE purpose='media'",
        ] {
            let (_root, command, owner, work, requests, authority) = retained_authority_fixture().await;
            let (writer, release) = hold_owned_writer(command.clone(), mutation, true).await;
            let checking = owner.clone();
            let task = tokio::spawn(async move { verify(checking, authority).await });
            tokio::time::sleep(Duration::from_millis(250)).await;
            let prematurely_finished = task.is_finished();
            release.send(()).unwrap();
            writer.await.unwrap().unwrap();
            let result = task.await.unwrap();
            drop(command); drop(owner); drop(requests); work.drained().await;
            assert!(!prematurely_finished);
            assert_eq!(result.unwrap_err(), "account-media-reference-revoked");
        }
    }

    #[tokio::test]
    async fn pending_owned_writer_admission_releases_root_then_rejects_its_replacement() {
        let (_root, command, owner, work, requests, authority) = retained_authority_fixture().await;
        let (writer, release) = hold_owned_writer(
            command.clone(),
            "UPDATE authority_unrelated_probe SET n=n+1",
            true,
        )
        .await;
        // Exercise the exact pending boundary without timer/order races: no
        // root lease or connection can cross this returned pending result.
        assert!(matches!(
            verify_attempt(
                owner.clone(),
                authority.clone(),
                Instant::now() + ADMISSION_BUDGET
            )
            .await,
            Ok(None)
        ));
        release.send(()).unwrap();
        writer.await.unwrap().unwrap();
        let replacement = tempfile::tempdir().unwrap();
        owner
            .replace_root_for_test(replacement.path().to_owned())
            .unwrap();
        let result = verify(owner.clone(), authority).await;
        drop(command);
        drop(owner);
        drop(requests);
        work.drained().await;
        assert_eq!(result.unwrap_err(), "scan-manifest-root-changed");
    }

    #[tokio::test]
    async fn owned_writer_admission_stop_is_prompt_and_joins_its_original_writer() {
        let (_root, command, owner, work, mut requests, authority) =
            retained_authority_fixture().await;
        let (writer, release) = hold_owned_writer(
            command.clone(),
            "UPDATE authority_unrelated_probe SET n=n+1",
            true,
        )
        .await;
        assert!(matches!(
            verify_attempt(
                owner.clone(),
                authority.clone(),
                Instant::now() + ADMISSION_BUDGET
            )
            .await,
            Ok(None)
        ));
        let checking = owner.clone();
        let task = tokio::spawn(async move { verify(checking, authority).await });
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!task.is_finished());
        requests.cancel("manifest-fixture".into()).unwrap();
        let started = Instant::now();
        let result = task.await.unwrap();
        let elapsed = started.elapsed();
        release.send(()).unwrap();
        writer.await.unwrap().unwrap();
        drop(command);
        drop(owner);
        drop(requests);
        work.drained().await;
        assert_eq!(result.unwrap_err(), "canceled");
        assert!(elapsed < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn owned_writer_admission_has_a_hard_policy_cap_and_never_creates_permission() {
        assert_eq!(ADMISSION_BUDGET, Duration::from_secs(20));
        let (_root, command, owner, work, requests, authority) = retained_authority_fixture().await;
        let (writer, release) = hold_owned_writer(
            command.clone(),
            "UPDATE authority_unrelated_probe SET n=n+1",
            true,
        )
        .await;
        let started = Instant::now();
        let result = verify_with_limits(
            owner.clone(),
            authority.clone(),
            Duration::from_secs(12),
            Duration::from_millis(250),
        )
        .await;
        let elapsed = started.elapsed();
        release.send(()).unwrap();
        writer.await.unwrap().unwrap();
        // Expiry was a refusal, not cached success; a later fresh request is
        // independently rechecked only after actual commit/unlock.
        let later = verify(owner.clone(), authority).await;
        drop(command);
        drop(owner);
        drop(requests);
        work.drained().await;
        assert_eq!(result.unwrap_err(), ADMISSION_TIMEOUT);
        assert!(elapsed >= Duration::from_millis(250) && elapsed < Duration::from_secs(1));
        assert!(later.is_ok());
    }

    #[tokio::test]
    async fn held_readable_writer_does_not_hide_unknown_storage_failure_as_pending() {
        let (_root, command, owner, work, requests, authority) = retained_authority_fixture().await;
        let (writer, release) = hold_owned_writer(
            command.clone(),
            "ALTER TABLE account_vault_versions_v1 RENAME TO fixture_versions",
            false,
        )
        .await;
        let started = Instant::now();
        let result = verify(owner.clone(), authority).await;
        let elapsed = started.elapsed();
        release.send(()).unwrap();
        writer.await.unwrap().unwrap();
        drop(command);
        drop(owner);
        drop(requests);
        work.drained().await;
        assert_eq!(result.unwrap_err(), "account-catalog-storage-failed");
        assert!(elapsed < Duration::from_secs(1));
    }
    /// Actual production Store/Context maintenance owns the writer gate and an
    /// exclusive SQLite lock after the unrelated COMMIT. Paid authority remains
    /// unchanged, but must wait for a fresh transaction rather than be revoked.
    #[tokio::test]
    async fn authority_waits_for_same_store_maintenance_then_reads_fresh_committed_snapshot() {
        let (_root, command, owner, work, requests, authority) = retained_authority_fixture().await;
        verify(owner.clone(), authority.clone()).await.unwrap();
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, joined) = std::sync::mpsc::channel();
        let writing = command.clone();
        let writer = tokio::spawn(async move {
            writing
                .storage(None, move |store, check| {
                    store.with_guide_maintenance_preflight_checked(
                        |_| Ok(None::<()>),
                        |c, check| {
                            let tx = sql(c.transaction_with_behavior(
                                rusqlite::TransactionBehavior::Immediate,
                            ))?;
                            sql(tx.execute("UPDATE authority_unrelated_probe SET n=n+1", []))?;
                            check()?;
                            sql(tx.commit())?;
                            let _ = entered.send(());
                            // The callback's committed receipt still owns the same
                            // production maintenance connection/exclusive lock.
                            joined
                                .recv_timeout(Duration::from_secs(30))
                                .map_err(|_| "fixture-release-missing")?;
                            Ok(())
                        },
                        Arc::new(std::sync::atomic::AtomicBool::new(false)),
                        check,
                    )
                })
                .await
        });
        ready.await.unwrap();
        let checking = owner.clone();
        let expected = authority.clone();
        let started = Instant::now();
        let verifying = tokio::spawn(async move { verify(checking, expected).await });
        // Exceed12s plus the final interactive attempt overlap; no media/network/device
        // is involved. Always release/join the actual maintenance operation.
        tokio::time::sleep(Duration::from_secs(17)).await;
        let refused_before_writer_join = verifying.is_finished();
        release.send(()).unwrap();
        let result = verifying.await.unwrap();
        let maintenance = writer.await.unwrap().unwrap().0;
        assert!(maintenance.fatal_verification.is_none());
        eprintln!("[Paid authority fixture] same_store_maintenance=true unchanged=true refused_before_writer_join={refused_before_writer_join} elapsed_ms={} result={}", started.elapsed().as_millis(), result.as_ref().err().map(String::as_str).unwrap_or("fresh-success"));
        let account = authority.request.account_id.clone();
        let (after, _) = owner
            .storage(None, move |store, _| {
                store.with_guide_read(|c| snapshot(c, &account))
            })
            .await
            .unwrap();
        assert!(after == authority.snapshot);
        drop(command);
        drop(owner);
        drop(requests);
        work.drained().await;
        assert!(
            !refused_before_writer_join,
            "our own maintenance must be joined before fresh authority can be refused"
        );
        assert!(result.is_ok(), "unchanged authority failed: {result:?}");
    }

    /// Mechanism characterization only: this does not attribute a device failure.
    /// An unrelated DELETE-journal writer can make unchanged Paid authority fail.
    #[tokio::test]
    async fn unchanged_authority_is_denied_by_interactive_sql_budget_during_a_six_second_writer() {
        use std::time::{Duration, Instant};
        let (root, command, owner, work, requests, authority) = retained_authority_fixture().await;
        verify(owner.clone(), authority.clone()).await.unwrap();
        let writer = Connection::open(root.path().join(crate::storage_transaction::DB)).unwrap();
        let journal: String = writer
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(journal.to_lowercase(), "delete");
        writer
            .execute_batch("BEGIN EXCLUSIVE;UPDATE authority_unrelated_probe SET n=n+1;")
            .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(6));
            writer.execute_batch("COMMIT").unwrap();
        });
        let started = Instant::now();
        let result = verify_attempt(
            owner.clone(),
            authority.clone(),
            Instant::now() + ADMISSION_BUDGET,
        )
        .await;
        let elapsed = started.elapsed();
        release.join().unwrap();
        assert_eq!(result.err().unwrap().error, "sqlite-busy");
        assert!(elapsed >= Duration::from_millis(1800));
        assert!(elapsed < Duration::from_secs(6));
        let account = authority.request.account_id.clone();
        let (after, _) = owner
            .storage(None, move |store, _| {
                store.with_guide_read(|c| snapshot(c, &account))
            })
            .await
            .unwrap();
        assert!(after == authority.snapshot);
        verify(owner.clone(), authority).await.unwrap();
        eprintln!("[Paid authority fixture] unchanged=true writer_ms=6000 denial=sqlite-busy elapsed_ms={}", elapsed.as_millis());
        drop(command);
        drop(owner);
        drop(requests);
        work.drained().await;
    }
    fn locked_writer(
        root: &std::path::Path,
        mutation: &str,
        seconds: u64,
    ) -> std::thread::JoinHandle<()> {
        let writer = Connection::open(root.join(crate::storage_transaction::DB)).unwrap();
        writer
            .execute_batch("PRAGMA foreign_keys=ON;BEGIN EXCLUSIVE")
            .unwrap();
        writer.execute_batch(mutation).unwrap();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(seconds));
            writer.execute_batch("COMMIT").unwrap();
        })
    }
    #[tokio::test]
    async fn busy_retry_rechecks_fresh_unchanged_authority_after_a_six_second_writer() {
        let (root, command, owner, work, requests, authority) = retained_authority_fixture().await;
        verify(owner.clone(), authority.clone()).await.unwrap();
        let release = locked_writer(root.path(), "UPDATE authority_unrelated_probe SET n=n+1", 6);
        let started = Instant::now();
        let result = verify(owner.clone(), authority.clone()).await;
        let elapsed = started.elapsed();
        release.join().unwrap();
        assert!(result.is_ok(), "{:?}", result.err());
        assert!(elapsed >= Duration::from_secs(6));
        assert!(elapsed < Duration::from_secs(10));
        let account = authority.request.account_id.clone();
        let (after, _) = owner
            .storage(None, move |store, _| {
                store.with_guide_read(|c| snapshot(c, &account))
            })
            .await
            .unwrap();
        assert!(after == authority.snapshot);
        eprintln!(
            "[Paid authority fixture] fresh_success=true writer_ms=6000 elapsed_ms={}",
            elapsed.as_millis()
        );
        drop(command);
        drop(owner);
        drop(requests);
        work.drained().await;
    }
    #[tokio::test]
    async fn busy_retry_denies_account_media_and_reference_changes_committed_during_wait() {
        for mutation in [
            "UPDATE account_vault_versions_v1 SET revision=2;UPDATE account_vault_meta_v1 SET revision=2;UPDATE account_media_catalog_v1 SET account_revision=2",
            "UPDATE account_media_catalog_v1 SET revision=2",
            "DELETE FROM account_vault_references_v1 WHERE purpose='media'",
        ] {
            let (root, command, owner, work, requests, authority) = retained_authority_fixture().await;
            verify(owner.clone(), authority.clone()).await.unwrap();
            let release = locked_writer(root.path(), mutation, 3);
            let result = verify(owner.clone(), authority).await;
            release.join().unwrap();
            assert_eq!(result.unwrap_err(), "account-media-reference-revoked");
            drop(command); drop(owner); drop(requests); work.drained().await;
        }
    }
    #[tokio::test]
    async fn busy_retry_cancellation_during_blocked_attempt_never_admits_stale_success() {
        let (root, command, owner, work, mut requests, authority) =
            retained_authority_fixture().await;
        let release = locked_writer(root.path(), "UPDATE authority_unrelated_probe SET n=n+1", 6);
        let cancel = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(250)).await;
            requests.cancel("manifest-fixture".into()).unwrap();
            requests
        });
        let started = Instant::now();
        let result = verify(owner.clone(), authority).await;
        let elapsed = started.elapsed();
        let requests = cancel.await.unwrap();
        release.join().unwrap();
        assert_eq!(result.unwrap_err(), "canceled");
        assert!(elapsed < Duration::from_secs(4));
        drop(command);
        drop(owner);
        drop(requests);
        work.drained().await;
    }
    #[tokio::test]
    async fn busy_retry_root_replacement_between_attempts_denies_old_authority() {
        let (root, command, owner, work, requests, authority) = retained_authority_fixture().await;
        let release = locked_writer(root.path(), "UPDATE authority_unrelated_probe SET n=n+1", 6);
        let replacement = tempfile::tempdir().unwrap();
        let target = replacement.path().to_owned();
        let replacing = owner.clone();
        let replace = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            replacing.replace_root_for_test(target).unwrap();
        });
        let result = verify(owner.clone(), authority).await;
        replace.join().unwrap();
        release.join().unwrap();
        assert_eq!(result.unwrap_err(), "scan-manifest-root-changed");
        drop(command);
        drop(owner);
        drop(requests);
        work.drained().await;
    }
    #[tokio::test]
    async fn busy_retry_exhaustion_remains_a_refusal_with_at_most_one_final_attempt() {
        let (root, command, owner, work, requests, authority) = retained_authority_fixture().await;
        let release = locked_writer(root.path(), "UPDATE authority_unrelated_probe SET n=n+1", 8);
        let budget = Duration::from_secs(3);
        let started = Instant::now();
        let result = verify_with_busy_budget(owner.clone(), authority, budget).await;
        let elapsed = started.elapsed();
        release.join().unwrap();
        assert_eq!(result.unwrap_err(), "sqlite-busy");
        assert!(elapsed >= budget);
        assert!(elapsed < budget + Duration::from_secs(3));
        drop(command);
        drop(owner);
        drop(requests);
        work.drained().await;
    }
    #[test]
    fn busy_retry_admission_is_exact_and_bounds_even_immediate_busy_results() {
        let budget = Duration::from_secs(12);
        assert!(busy_retry_allowed("sqlite-busy", 1, Duration::ZERO, budget));
        assert!(busy_retry_allowed("sqlite-busy", 6, Duration::ZERO, budget));
        assert!(!busy_retry_allowed(
            "sqlite-busy",
            7,
            Duration::ZERO,
            budget
        ));
        assert!(!busy_retry_allowed("sqlite-busy", 1, budget, budget));
        for error in [
            "sqlite-locked",
            "sqlite-operation-failed",
            "account-media-reference-revoked",
            "account-revision-conflict",
            "scan-manifest-root-changed",
            "canceled",
            "application-closing",
            "unknown",
        ] {
            assert!(!busy_retry_allowed(error, 1, Duration::ZERO, budget));
        }
    }
    #[test]
    fn authority_snapshot_sql_preserves_contention_categories_without_error_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("authority.sqlite3");
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch("CREATE TABLE authority_probe(n);BEGIN EXCLUSIVE;")
            .unwrap();
        let reader = Connection::open(&path).unwrap();
        reader.busy_timeout(std::time::Duration::ZERO).unwrap();
        assert_eq!(
            sql(
                reader.query_row("SELECT count(*) FROM authority_probe", [], |row| row
                    .get::<_, i64>(0))
            )
            .unwrap_err(),
            "sqlite-busy"
        );
        writer.execute_batch("ROLLBACK;").unwrap();
        for (code, expected) in [
            (rusqlite::ffi::SQLITE_LOCKED, "sqlite-locked"),
            (rusqlite::ffi::SQLITE_FULL, "sqlite-storage-full"),
            (
                rusqlite::ffi::SQLITE_ERROR,
                "account-catalog-storage-failed",
            ),
        ] {
            let error = rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(code),
                Some("https://private.invalid/password".into()),
            );
            assert_eq!(sql::<()>(Err(error)).unwrap_err(), expected);
        }
        assert_eq!(sql(Ok(7)).unwrap(), 7);
    }
}
