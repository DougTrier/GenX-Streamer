//! Native account media pages. Secret URLs never enter canonical SQLite, exports,
//! UI replies or diagnostics. The caller retains its joined work/writer owner
//! across prepare -> OS seal -> commit and prepare_load -> OS open -> finish_load.
//! vault_root is native app-private no-backup storage, never an IPC path.
use crate::account_vault::Metadata;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use zeroize::{Zeroize, Zeroizing};

const PAGE: usize = 1024 * 1024;
const CIPHER: usize = PAGE + 16 * 1024;
const WHOLE: usize = 20 * 1024 * 1024;
const ENTRIES: usize = 100_000;
const PAGES: usize = 64;
const ERR: &str = "account-media-invalid";
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS account_media_catalog_v1(
 account_id TEXT PRIMARY KEY REFERENCES account_vault_meta_v1(id) ON DELETE CASCADE,account_revision INTEGER NOT NULL,
 secret_ref TEXT NOT NULL,batch_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0));
 CREATE TABLE IF NOT EXISTS account_media_page_v1(
 page_ref TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES account_media_catalog_v1(account_id) ON DELETE CASCADE,
 batch_id TEXT NOT NULL,page_index INTEGER NOT NULL,cipher_bytes INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS account_media_entry_v1(
 account_id TEXT NOT NULL REFERENCES account_media_catalog_v1(account_id) ON DELETE CASCADE,
 channel_id TEXT NOT NULL,name TEXT NOT NULL,category TEXT NOT NULL,provider_id TEXT,epg_id TEXT,
 stream_ref TEXT NOT NULL UNIQUE REFERENCES account_vault_references_v1(reference) ON DELETE CASCADE,
 page_ref TEXT NOT NULL REFERENCES account_media_page_v1(page_ref) ON DELETE CASCADE,
 PRIMARY KEY(account_id,channel_id));";

// Native-only acquisition input: neither Debug nor Serialize.
pub(crate) struct Input {
    pub stable_id: String,
    pub provider_id: Option<String>,
    pub name: String,
    pub category: String,
    pub epg_id: Option<String>,
    pub urls: Vec<String>,
}
impl Drop for Input {
    fn drop(&mut self) {
        self.urls.zeroize();
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Channel {
    pub id: String,
    pub name: String,
    pub category: String,
    pub provider_id: Option<String>,
    pub epg_id: Option<String>,
    pub stream_reference: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SecretEntry {
    reference: String,
    urls: Vec<String>,
}
impl Drop for SecretEntry {
    fn drop(&mut self) {
        self.urls.zeroize();
    }
}
#[derive(Clone)]
struct Fence {
    account: String,
    revision: u64,
    secret: String,
    generation: u64,
}
struct Page {
    reference: String,
    index: usize,
    plaintext: Zeroizing<Vec<u8>>,
}
struct Entry {
    channel: Channel,
    page: String,
}
pub(crate) struct PreparedInstall {
    fence: Fence,
    expected_media_revision: i64,
    batch: String,
    pages: Vec<Page>,
    entries: Vec<Entry>,
}
pub(crate) struct SealedInstall {
    prepared: PreparedInstall,
    files: Vec<(PathBuf, usize)>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Commit {
    pub channel_count: usize,
    pub media_revision: String,
    #[serde(skip)]
    pub obsolete_pages: Vec<String>,
}
pub(crate) struct PreparedLoad {
    channel_id: String,
    fence: Fence,
    batch: String,
    media_revision: i64,
    page: String,
    page_index: usize,
    reference: String,
    cipher_bytes: usize,
}
// Native-only output. Do not Serialize, Debug, place in channel metadata or IPC.
pub(crate) struct OpenedMedia {
    prepared: PreparedLoad,
    urls: Vec<String>,
}
impl Drop for OpenedMedia {
    fn drop(&mut self) {
        self.urls.zeroize();
    }
}
pub(crate) struct ResolvedMedia {
    opened: OpenedMedia,
}
impl ResolvedMedia {
    pub(crate) fn urls(&self) -> &[String] {
        &self.opened.urls
    }
    pub(crate) fn account_id(&self) -> &str {
        &self.opened.prepared.fence.account
    }
    pub(crate) fn channel_id(&self) -> &str {
        &self.opened.prepared.channel_id
    }
}
fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|_| "account-media-storage-failed".into())
}
fn opaque(v: &str) -> bool {
    v.len() == 32
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn random() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "account-media-random-unavailable")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn text(v: &str, max: usize, empty: bool) -> bool {
    v.len() <= max
        && (empty || !v.trim().is_empty())
        && !v.chars().any(char::is_control)
        && !v.to_ascii_lowercase().contains("://")
}
/// HTTPS, or plain HTTP only for an account with its own explicit HTTP grant.
fn secure_url(v: &str, allow_http: bool) -> Result<(), String> {
    if v.len() > 16384 || v.chars().any(char::is_control) {
        return Err(ERR.into());
    }
    let url = reqwest::Url::parse(v).map_err(|_| ERR)?;
    if !(url.scheme() == "https" || (allow_http && url.scheme() == "http"))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("account-media-https-required".into());
    }
    // DNS/public-address/redirect admission is still required at actual fetch.
    Ok(())
}
fn fence(c: &Connection, f: &Fence, generation: u64) -> Result<(), String> {
    if f.generation != generation {
        return Err("account-storage-changed".into());
    }
    let current = sql(c.query_row("SELECT m.revision,m.secret_ref,m.allow_http,v.active,v.revision FROM account_vault_meta_v1 m JOIN account_vault_versions_v1 v ON v.id=m.id WHERE m.id=?1", [&f.account], |r| Ok((r.get::<_, i64>(0)?,r.get::<_, String>(1)?,r.get::<_, bool>(2)?,r.get::<_, bool>(3)?,r.get::<_, i64>(4)?))).optional())?;
    // Changing the HTTP grant saves a new revision, so the revision fence covers it.
    let Some((revision, secret, _http, active, version)) = current else {
        return Err("account-removed".into());
    };
    if revision != f.revision as i64 || secret != f.secret || !active || version != revision {
        return Err("account-revision-conflict".into());
    }
    Ok(())
}
fn binding(f: &Fence, batch: &str, page: &str, index: usize) -> String {
    format!(
        "GenX.account-media.v1:{}:{}:{}:{}:{}:{}",
        f.account, f.revision, f.secret, batch, page, index
    )
}
fn file(root: &Path, reference: &str) -> Result<PathBuf, String> {
    if !root.is_absolute() || !opaque(reference) {
        return Err("account-vault-path-invalid".into());
    }
    crate::storage::refuse_link(root).map_err(|_| "account-vault-path-invalid")?;
    let path = root.join(format!("{reference}.gxam"));
    crate::storage::refuse_link(&path).map_err(|_| "account-vault-path-invalid")?;
    Ok(path)
}
pub(crate) fn initialize(c: &Connection) -> Result<(), String> {
    if !sql(c.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, bool>(0)))? {
        return Err("account-media-storage-policy".into());
    }
    crate::account_vault::initialize(c)?;
    crate::account_preferences::initialize(c)?;
    sql(c.execute_batch(SCHEMA))?;
    crate::account_guide::install(c)
}
fn revision(c: &Connection, account: &str) -> Result<i64, String> {
    Ok(sql(c
        .query_row(
            "SELECT revision FROM account_media_catalog_v1 WHERE account_id=?1",
            [account],
            |r| r.get::<_, i64>(0),
        )
        .optional())?
    .unwrap_or(0))
}
pub(crate) fn prepare(
    c: &Connection,
    metadata: &Metadata,
    generation: u64,
    inputs: Vec<Input>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<PreparedInstall, String> {
    check()?;
    if !opaque(&metadata.id)
        || !opaque(&metadata.secret_ref)
        || metadata.revision == 0
        || metadata.revision >= i64::MAX as u64
        || inputs.is_empty()
        || inputs.len() > ENTRIES
    {
        return Err(ERR.into());
    }
    initialize(c)?;
    let authority = Fence {
        account: metadata.id.clone(),
        revision: metadata.revision,
        secret: metadata.secret_ref.clone(),
        generation,
    };
    fence(c, &authority, generation)?;
    let expected = revision(c, &metadata.id)?;
    if expected == i64::MAX {
        return Err("account-media-revision-exhausted".into());
    }
    let mut prepared = PreparedInstall {
        fence: authority,
        expected_media_revision: expected,
        batch: random()?,
        pages: Vec::new(),
        entries: Vec::with_capacity(inputs.len()),
    };
    let mut encoded = Zeroizing::new(Vec::new());
    encoded.push(b'[');
    let mut page_reference = random()?;
    let mut total = 0usize;
    let mut metadata_bytes = 0usize;
    let mut seen = std::collections::HashSet::new();
    let identity_prefix = format!("account-{}-", metadata.id);
    for mut input in inputs {
        check()?;
        if !input
            .stable_id
            .strip_prefix(&identity_prefix)
            .is_some_and(|id| {
                id.len() == 64
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            || !seen.insert(input.stable_id.clone())
            || !text(&input.name, 16384, false)
            || !text(&input.category, 16384, true)
            || input
                .provider_id
                .as_ref()
                .is_some_and(|v| !text(v, 16384, false))
            || input
                .epg_id
                .as_ref()
                .is_some_and(|v| !text(v, 16384, false))
            || input.urls.is_empty()
            || input.urls.len() > 16
        {
            return Err(ERR.into());
        }
        for url in &input.urls {
            secure_url(url, metadata.allow_http)?;
        }
        let reference = random()?;
        let channel = Channel {
            id: std::mem::take(&mut input.stable_id),
            name: std::mem::take(&mut input.name),
            category: std::mem::take(&mut input.category),
            provider_id: input.provider_id.take(),
            epg_id: input.epg_id.take(),
            stream_reference: reference.clone(),
        };
        metadata_bytes = metadata_bytes
            .checked_add(serde_json::to_vec(&channel).map_err(|_| ERR)?.len())
            .ok_or(ERR)?;
        let row = SecretEntry {
            reference,
            urls: std::mem::take(&mut input.urls),
        };
        let bytes = Zeroizing::new(serde_json::to_vec(&row).map_err(|_| ERR)?);
        if bytes.len() + 2 > PAGE {
            return Err("account-media-page-too-large".into());
        }
        if encoded.len() + bytes.len() + 2 > PAGE {
            encoded.push(b']');
            total = total.checked_add(encoded.len()).ok_or(ERR)?;
            prepared.pages.push(Page {
                reference: page_reference,
                index: prepared.pages.len(),
                plaintext: encoded,
            });
            page_reference = random()?;
            encoded = Zeroizing::new(vec![b'[']);
        }
        if encoded.len() > 1 {
            encoded.push(b',');
        }
        encoded.extend_from_slice(&bytes);
        if total + encoded.len() + metadata_bytes > WHOLE || prepared.pages.len() >= PAGES {
            return Err("account-media-too-large".into());
        }
        prepared.entries.push(Entry {
            channel,
            page: page_reference.clone(),
        });
    }
    encoded.push(b']');
    if total + encoded.len() + metadata_bytes > WHOLE {
        return Err("account-media-too-large".into());
    }
    prepared.pages.push(Page {
        reference: page_reference,
        index: prepared.pages.len(),
        plaintext: encoded,
    });
    check()?;
    Ok(prepared)
}

pub(crate) async fn seal(
    app: tauri::AppHandle,
    vault_root: PathBuf,
    mut prepared: PreparedInstall,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<SealedInstall, String> {
    let mut files = Vec::with_capacity(prepared.pages.len());
    for page in &mut prepared.pages {
        check()?;
        let plaintext = std::mem::take(&mut *page.plaintext);
        let ciphertext = crate::protect_scan_manifest_page(
            app.clone(),
            binding(
                &prepared.fence,
                &prepared.batch,
                &page.reference,
                page.index,
            ),
            plaintext,
            false,
        )
        .await
        .map_err(|_| "account-vault-unavailable")?;
        if ciphertext.is_empty() || ciphertext.len() > CIPHER {
            return Err("account-media-page-too-large".into());
        }
        check()?;
        let root = vault_root.clone();
        let reference = page.reference.clone();
        let bytes = ciphertext.len();
        let path = tauri::async_runtime::spawn_blocking(move || {
            let path = file(&root, &reference)?;
            fs::create_dir_all(&root).map_err(|_| "account-vault-unavailable")?;
            crate::storage::refuse_link(&root).map_err(|_| "account-vault-path-invalid")?;
            let mut temp = tempfile::Builder::new()
                .prefix(".gxam-pending-")
                .tempfile_in(&root)
                .map_err(|_| "account-vault-unavailable")?;
            temp.write_all(&ciphertext)
                .map_err(|_| "account-vault-unavailable")?;
            temp.as_file()
                .sync_all()
                .map_err(|_| "account-vault-unavailable")?;
            temp.persist_noclobber(&path)
                .map_err(|_| "account-vault-unavailable")?;
            Ok::<_, String>(path)
        })
        .await
        .map_err(|_| "account-vault-worker-failed")??;
        files.push((path, bytes));
        check()?;
    }
    Ok(SealedInstall { prepared, files })
}
pub(crate) fn commit(
    c: &mut Connection,
    sealed: SealedInstall,
    generation: u64,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Commit, String> {
    check()?;
    initialize(c)?;
    let prepared = sealed.prepared;
    if prepared.pages.len() != sealed.files.len() {
        return Err(ERR.into());
    }
    for (path, bytes) in &sealed.files {
        crate::storage::refuse_link(path).map_err(|_| "account-vault-path-invalid")?;
        let meta = fs::metadata(path).map_err(|_| "account-vault-unavailable")?;
        if !meta.is_file() || meta.len() != *bytes as u64 || *bytes == 0 || *bytes > CIPHER {
            return Err("account-vault-unavailable".into());
        }
    }
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    fence(&tx, &prepared.fence, generation)?;
    if revision(&tx, &prepared.fence.account)? != prepared.expected_media_revision {
        return Err("account-media-revision-conflict".into());
    }
    let obsolete = {
        let mut statement = sql(
            tx.prepare("SELECT page_ref FROM account_media_page_v1 WHERE account_id=?1 LIMIT 65")
        )?;
        let rows = sql(statement.query_map([&prepared.fence.account], |r| r.get::<_, String>(0)))?;
        let values = sql(rows.collect::<rusqlite::Result<Vec<_>>>())?;
        if values.len() > PAGES {
            return Err(ERR.into());
        }
        values
    };
    sql(tx.execute(
        "DELETE FROM account_vault_references_v1 WHERE account_id=?1 AND purpose='media'",
        [&prepared.fence.account],
    ))?;
    sql(tx.execute(
        "DELETE FROM account_media_catalog_v1 WHERE account_id=?1",
        [&prepared.fence.account],
    ))?;
    sql(tx.execute(
        "INSERT INTO account_media_catalog_v1 VALUES(?1,?2,?3,?4,?5)",
        params![
            prepared.fence.account,
            prepared.fence.revision as i64,
            prepared.fence.secret,
            prepared.batch,
            prepared.expected_media_revision + 1
        ],
    ))?;
    for (page, (_, bytes)) in prepared.pages.iter().zip(&sealed.files) {
        check()?;
        sql(tx.execute(
            "INSERT INTO account_media_page_v1 VALUES(?1,?2,?3,?4,?5)",
            params![
                page.reference,
                prepared.fence.account,
                prepared.batch,
                page.index as i64,
                *bytes as i64
            ],
        ))?;
    }
    for entry in &prepared.entries {
        check()?;
        let channel = &entry.channel;
        sql(tx.execute(
            "INSERT INTO account_vault_references_v1 VALUES(?1,?2,?3,'media')",
            params![
                channel.stream_reference,
                prepared.fence.account,
                prepared.fence.revision as i64
            ],
        ))?;
        sql(tx.execute(
            "INSERT INTO account_media_entry_v1 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                prepared.fence.account,
                channel.id,
                channel.name,
                channel.category,
                channel.provider_id,
                channel.epg_id,
                channel.stream_reference,
                entry.page
            ],
        ))?;
    }
    fence(&tx, &prepared.fence, generation)?;
    check()?;
    sql(tx.commit())?;
    // No cancellation check after durable commit: this is completion.
    Ok(Commit {
        channel_count: prepared.entries.len(),
        media_revision: (prepared.expected_media_revision + 1).to_string(),
        obsolete_pages: obsolete,
    })
}

pub(crate) fn prepare_load(
    c: &Connection,
    account: &str,
    reference: &str,
    generation: u64,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<PreparedLoad, String> {
    check()?;
    let channel_id: String = sql(c
        .query_row(
            "SELECT channel_id FROM account_media_entry_v1 WHERE account_id=?1 AND stream_ref=?2",
            params![account, reference],
            |row| row.get(0),
        )
        .optional())?
    .ok_or("account-media-reference-revoked")?;
    if crate::account_preferences::is_removed(c, account, &channel_id)? {
        return Err("account-channel-removed".into());
    }
    check()?;
    if !opaque(account) || !opaque(reference) {
        return Err("account-reference-invalid".into());
    }
    let row = sql(c.query_row("SELECT cat.account_revision,cat.secret_ref,cat.batch_id,cat.revision,p.page_ref,p.page_index,p.cipher_bytes FROM account_media_entry_v1 e JOIN account_media_catalog_v1 cat ON cat.account_id=e.account_id JOIN account_media_page_v1 p ON p.page_ref=e.page_ref AND p.account_id=e.account_id AND p.batch_id=cat.batch_id JOIN account_vault_references_v1 r ON r.reference=e.stream_ref AND r.account_id=e.account_id AND r.account_revision=cat.account_revision AND r.purpose='media' WHERE e.account_id=?1 AND e.stream_ref=?2", params![account,reference], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?))).optional())?.ok_or("account-media-reference-revoked")?;
    if row.0 <= 0
        || row.3 <= 0
        || row.5 < 0
        || row.5 >= PAGES as i64
        || row.6 <= 0
        || row.6 > CIPHER as i64
        || !opaque(&row.1)
        || !opaque(&row.2)
        || !opaque(&row.4)
    {
        return Err(ERR.into());
    }
    let prepared = PreparedLoad {
        channel_id,
        fence: Fence {
            account: account.into(),
            revision: row.0 as u64,
            secret: row.1,
            generation,
        },
        batch: row.2,
        media_revision: row.3,
        page: row.4,
        page_index: row.5 as usize,
        reference: reference.into(),
        cipher_bytes: row.6 as usize,
    };
    fence(c, &prepared.fence, generation)?;
    check()?;
    Ok(prepared)
}
pub(crate) async fn open(
    app: tauri::AppHandle,
    vault_root: PathBuf,
    prepared: PreparedLoad,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<OpenedMedia, String> {
    check()?;
    let reference = prepared.page.clone();
    let expected = prepared.cipher_bytes;
    let cipher = tauri::async_runtime::spawn_blocking(move || {
        let path = file(&vault_root, &reference)?;
        let input = fs::File::open(path).map_err(|_| "account-sign-in-required")?;
        let mut bytes = Vec::new();
        input
            .take((CIPHER + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "account-vault-unavailable")?;
        if bytes.len() != expected || bytes.is_empty() || bytes.len() > CIPHER {
            return Err("account-sign-in-required".into());
        }
        Ok::<_, String>(bytes)
    })
    .await
    .map_err(|_| "account-vault-worker-failed")??;
    check()?;
    let plaintext = Zeroizing::new(
        crate::protect_scan_manifest_page(
            app,
            binding(
                &prepared.fence,
                &prepared.batch,
                &prepared.page,
                prepared.page_index,
            ),
            cipher,
            true,
        )
        .await
        .map_err(|_| "account-sign-in-required")?,
    );
    check()?;
    if plaintext.is_empty() || plaintext.len() > PAGE {
        return Err("account-sign-in-required".into());
    }
    let entries: Vec<SecretEntry> =
        serde_json::from_slice(&plaintext).map_err(|_| "account-sign-in-required")?;
    if entries.len() > ENTRIES {
        return Err(ERR.into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut selected = None;
    for mut entry in entries {
        check()?;
        if !opaque(&entry.reference)
            || !seen.insert(entry.reference.clone())
            || entry.urls.is_empty()
            || entry.urls.len() > 16
        {
            return Err(ERR.into());
        }
        // Syntax only here: the caller then requires every address to match the
        // account's stored origin, which admits HTTP only with the account's grant.
        for url in &entry.urls {
            secure_url(url, true)?;
        }
        if entry.reference == prepared.reference {
            selected = Some(std::mem::take(&mut entry.urls));
        }
    }
    let urls = selected.ok_or("account-media-reference-revoked")?;
    Ok(OpenedMedia { prepared, urls })
}
pub(crate) fn finish_load(
    c: &Connection,
    resolved: OpenedMedia,
    generation: u64,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<ResolvedMedia, String> {
    let current = prepare_load(
        c,
        &resolved.prepared.fence.account,
        &resolved.prepared.reference,
        generation,
        &mut check,
    )?;
    let old = &resolved.prepared;
    if old.fence.generation != generation
        || current.media_revision != old.media_revision
        || current.batch != old.batch
        || current.page != old.page
        || current.fence.revision != old.fence.revision
        || current.fence.secret != old.fence.secret
    {
        return Err("account-media-reference-revoked".into());
    }
    check()?;
    Ok(ResolvedMedia { opened: resolved })
}
pub(crate) fn list_channels(
    c: &Connection,
    account: &str,
    expected_account_revision: u64,
    after_id: &str,
    limit: usize,
) -> Result<Vec<Channel>, String> {
    if !opaque(account)
        || expected_account_revision == 0
        || expected_account_revision > i64::MAX as u64
        || limit == 0
        || limit > 64
        || after_id.len() > 128
    {
        return Err(ERR.into());
    }
    let mut statement = sql(c.prepare("SELECT e.channel_id,e.name,e.category,e.provider_id,e.epg_id,e.stream_ref FROM account_media_entry_v1 e JOIN account_media_catalog_v1 cat ON cat.account_id=e.account_id JOIN account_vault_meta_v1 m ON m.id=cat.account_id AND m.revision=cat.account_revision AND m.secret_ref=cat.secret_ref JOIN account_vault_references_v1 r ON r.reference=e.stream_ref AND r.account_id=e.account_id AND r.account_revision=m.revision AND r.purpose='media' WHERE e.account_id=?1 AND m.revision=?2 AND e.channel_id>?3 ORDER BY e.channel_id LIMIT ?4"))?;
    let rows = sql(statement.query_map(
        params![
            account,
            expected_account_revision as i64,
            after_id,
            limit as i64
        ],
        |r| {
            Ok(Channel {
                id: r.get(0)?,
                name: r.get(1)?,
                category: r.get(2)?,
                provider_id: r.get(3)?,
                epg_id: r.get(4)?,
                stream_reference: r.get(5)?,
            })
        },
    ))?;
    sql(rows.collect::<rusqlite::Result<Vec<_>>>())
}
/// Writer-owned cleanup only, after joined seal/open work. Never invoke beside an
/// unpublished seal. Missing files are harmless; live page references refuse.
pub(crate) fn cleanup_page(c: &Connection, root: &Path, reference: &str) -> Result<(), String> {
    if sql(c.query_row("SELECT EXISTS(SELECT 1 FROM account_media_page_v1 p JOIN account_media_catalog_v1 cat ON cat.account_id=p.account_id JOIN account_vault_meta_v1 m ON m.id=cat.account_id AND m.revision=cat.account_revision AND m.secret_ref=cat.secret_ref WHERE p.page_ref=?1)",[reference],|r| r.get::<_,bool>(0)))? { return Err("account-media-still-referenced".into()); }
    match fs::remove_file(file(root, reference)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("account-vault-cleanup-failed".into()),
    }
}
/// Bounded orphan reconciliation under the same joined account writer owner.
/// Only this namespace's files are touched; no recursive enumeration/deletion.
pub(crate) fn recover_orphans(
    c: &Connection,
    root: &Path,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    check()?;
    if !root.is_absolute() {
        return Err("account-vault-path-invalid".into());
    }
    crate::storage::refuse_link(root).map_err(|_| "account-vault-path-invalid")?;
    initialize(c)?;
    let reader = match fs::read_dir(root) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("account-vault-cleanup-failed".into()),
    };
    let mut candidates = Vec::new();
    let mut inspected = 0usize;
    // Enumerate and validate the complete bounded directory before any delete.
    for entry in reader {
        check()?;
        inspected += 1;
        if inspected > 8192 {
            return Err("account-media-cleanup-limit".into());
        }
        let entry = entry.map_err(|_| "account-vault-cleanup-failed")?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let reference = name
            .strip_suffix(".gxam")
            .filter(|v| opaque(v))
            .map(str::to_owned);
        if reference.is_none() && !name.starts_with(".gxam-pending-") {
            continue;
        }
        crate::storage::refuse_link(&entry.path()).map_err(|_| "account-vault-path-invalid")?;
        if !entry
            .file_type()
            .map_err(|_| "account-vault-cleanup-failed")?
            .is_file()
        {
            return Err("account-vault-path-invalid".into());
        }
        candidates.push((entry.path(), reference));
    }
    for (path, reference) in candidates {
        check()?;
        if let Some(reference) = reference {
            match cleanup_page(c, root, &reference) {
                Ok(()) => {}
                Err(code) if code == "account-media-still-referenced" => {}
                Err(code) => return Err(code),
            }
        } else {
            fs::remove_file(path).map_err(|_| "account-vault-cleanup-failed")?;
        }
    }
    check()?;
    Ok(())
}
