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

//! Device-bound account secrets. Only Metadata is serializable back to the UI.
//! Callers hold the application work owner through prepare -> OS crypto -> commit,
//! release SQLite/root leases around crypto, and join actual crypto before cancel ACK.
//! vault_root must be native app-private storage (Android noBackupFilesDir), never
//! a frontend supplied path, portable directory, or ordinary export destination.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use zeroize::{Zeroize, Zeroizing};

const CIPHER_LIMIT: usize = 16 * 1024;
const SECRET_LIMIT: usize = 12 * 1024;
const ACCOUNT_LIMIT: i64 = 64;
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS account_vault_versions_v1(
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), active INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS account_vault_meta_v1(
 id TEXT PRIMARY KEY REFERENCES account_vault_versions_v1(id), name TEXT NOT NULL,
 kind TEXT NOT NULL, server_origin TEXT NOT NULL, allow_http INTEGER NOT NULL,
 revision INTEGER NOT NULL, secret_ref TEXT NOT NULL UNIQUE);
 CREATE TABLE IF NOT EXISTS account_vault_references_v1(
 reference TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account_vault_meta_v1(id),
 account_revision INTEGER NOT NULL, purpose TEXT NOT NULL);";

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Xtream,
    Playlist,
}
impl Kind {
    fn label(self) -> &'static str {
        match self {
            Self::Xtream => "xtream",
            Self::Playlist => "playlist",
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub schema_version: u8,
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub server_origin: String,
    pub allow_http: bool,
    #[serde(serialize_with = "decimal::serialize")]
    pub revision: u64,
    #[serde(skip_serializing)]
    pub secret_ref: String,
    pub requires_sign_in: bool,
}
// Intentionally neither Debug nor Serialize. Secret fields zeroize on Drop.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Put {
    pub schema_version: u8,
    pub account_id: Option<String>,
    #[serde(default, deserialize_with = "decimal::optional")]
    pub expected_revision: Option<u64>,
    pub name: String,
    pub kind: Kind,
    pub server_url: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub playlist_url: Option<String>,
    pub allow_http: bool,
}
impl Drop for Put {
    fn drop(&mut self) {
        for value in [
            &mut self.server_url,
            &mut self.username,
            &mut self.password,
            &mut self.playlist_url,
        ]
        .into_iter()
        .flatten()
        {
            value.zeroize();
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Remove {
    pub schema_version: u8,
    pub account_id: String,
    #[serde(deserialize_with = "decimal::deserialize")]
    pub expected_revision: u64,
}

// JSON numbers cannot preserve native revisions beyond Number.MAX_SAFE_INTEGER.
// The wire contract therefore accepts canonical decimal strings only.
mod decimal {
    use serde::{Deserialize, Deserializer, Serializer};
    fn parse<E: serde::de::Error>(value: &str) -> Result<u64, E> {
        if value.is_empty()
            || value.len() > 19
            || !value.bytes().all(|b| b.is_ascii_digit())
            || (value.len() > 1 && value.starts_with('0'))
        {
            return Err(E::custom("account-revision-invalid"));
        }
        let parsed = value
            .parse::<u64>()
            .map_err(|_| E::custom("account-revision-invalid"))?;
        if parsed > i64::MAX as u64 {
            return Err(E::custom("account-revision-invalid"));
        }
        Ok(parsed)
    }
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        parse(&String::deserialize(deserializer)?)
    }
    pub fn optional<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u64>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .as_deref()
            .map(parse)
            .transpose()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum Secret {
    Xtream {
        server_url: String,
        username: String,
        password: String,
    },
    Playlist {
        url: String,
    },
}
impl Drop for Secret {
    fn drop(&mut self) {
        match self {
            Self::Xtream {
                server_url,
                username,
                password,
            } => {
                server_url.zeroize();
                username.zeroize();
                password.zeroize();
            }
            Self::Playlist { url } => url.zeroize(),
        }
    }
}
pub struct PreparedPut {
    metadata: Metadata,
    expected: Option<u64>,
    root_generation: u64,
    plaintext: Zeroizing<Vec<u8>>,
}
pub struct SealedPut {
    prepared: PreparedPut,
    path: PathBuf,
}
pub struct Commit {
    pub metadata: Metadata,
    // Native-only obsolete file; safe cleanup after releasing storage leases.
    pub obsolete: Option<String>,
}
pub struct PreparedResolve {
    metadata: Metadata,
    root_generation: u64,
}
pub(crate) struct Resolved {
    pub metadata: Metadata,
    pub secret: Secret,
    root_generation: u64,
}

fn sql<T>(value: rusqlite::Result<T>) -> Result<T, String> {
    value.map_err(|_| "account-storage-failed".into())
}
fn opaque() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "account-random-unavailable")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn binding(m: &Metadata) -> String {
    format!(
        "GenX.account-vault.v1:{}:{}:{}:{}:{}",
        m.id,
        m.revision,
        m.kind.label(),
        m.allow_http,
        m.secret_ref
    )
}
fn file(root: &Path, reference: &str) -> Result<PathBuf, String> {
    if !root.is_absolute() || !valid_id(reference) {
        return Err("account-vault-path-invalid".into());
    }
    crate::storage::refuse_link(root).map_err(|_| "account-vault-path-invalid")?;
    let path = root.join(format!("{reference}.gxav"));
    crate::storage::refuse_link(&path).map_err(|_| "account-vault-path-invalid")?;
    Ok(path)
}
pub fn initialize(c: &Connection) -> Result<(), String> {
    sql(c.execute_batch(SCHEMA))
}
fn present(c: &Connection) -> Result<bool, String> {
    sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_vault_meta_v1')",
        [],
        |row| row.get(0),
    ))
}
fn metadata(c: &Connection, id: &str) -> Result<Option<Metadata>, String> {
    sql(c
        .query_row(
            "SELECT id,name,kind,server_origin,allow_http,revision,secret_ref FROM account_vault_meta_v1 WHERE id=?1",
            [id],
            |row| {
                let kind: String = row.get(2)?;
                let revision: i64 = row.get(5)?;
                if revision <= 0 {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                Ok(Metadata {
                    schema_version: 1,
                    id: row.get(0)?,
                    name: row.get(1)?,
                    kind: match kind.as_str() {
                        "xtream" => Kind::Xtream,
                        "playlist" => Kind::Playlist,
                        _ => return Err(rusqlite::Error::InvalidQuery),
                    },
                    server_origin: row.get(3)?,
                    allow_http: row.get(4)?,
                    revision: revision as u64,
                    secret_ref: row.get(6)?,
                    requires_sign_in: false,
                })
            },
        )
        .optional())
}
pub fn list(c: &Connection) -> Result<Vec<Metadata>, String> {
    if !present(c)? {
        return Ok(Vec::new());
    }
    let mut stmt =
        sql(c.prepare("SELECT id FROM account_vault_meta_v1 ORDER BY name,id LIMIT 65"))?;
    let ids =
        sql(stmt.query_map([], |r| r.get::<_, String>(0)))?.collect::<rusqlite::Result<Vec<_>>>();
    let ids = sql(ids)?;
    if ids.len() > ACCOUNT_LIMIT as usize {
        return Err("account-limit".into());
    }
    ids.iter()
        .map(|id| metadata(c, id)?.ok_or_else(|| "account-storage-failed".into()))
        .collect()
}
pub fn mark_missing(m: &mut Metadata, root: &Path) {
    m.requires_sign_in = file(root, &m.secret_ref)
        .ok()
        .and_then(|p| fs::metadata(p).ok())
        .map(|v| !v.is_file() || v.len() == 0 || v.len() > CIPHER_LIMIT as u64)
        .unwrap_or(true);
}
/// A stored account origin is usable when it is exactly an origin (no user
/// info or path) and HTTPS, or plain HTTP with this account's own grant.
pub(crate) fn origin_allowed(origin: &reqwest::Url, stored: &str, allow_http: bool) -> bool {
    (origin.scheme() == "https" || (allow_http && origin.scheme() == "http"))
        && origin.host_str().is_some()
        && origin.username().is_empty()
        && origin.password().is_none()
        && origin.origin().ascii_serialization() == stored
}
fn endpoint(raw: &str, allow_http: bool) -> Result<String, String> {
    // HTTPS by default. Plain HTTP only with this account's own explicit grant
    // (the public-source HTTP checkbox never applies). The stored origin pins
    // scheme, host and port, so an HTTPS account can never be downgraded.
    if raw.is_empty() || raw.len() > SECRET_LIMIT || raw.chars().any(char::is_control) {
        return Err("account-address-invalid".into());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "account-address-invalid")?;
    if url.scheme() == "http" && !allow_http {
        return Err("account-secure-transport-required".into());
    }
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("account-address-invalid".into());
    }
    Ok(url.origin().ascii_serialization())
}
pub fn prepare_put(
    c: &Connection,
    request: &Put,
    root_generation: u64,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<PreparedPut, String> {
    check()?;
    if request.schema_version != 1
        || request.name.trim().is_empty()
        || request.name.len() > 160
        || request.name.chars().any(char::is_control)
    {
        return Err("account-metadata-invalid".into());
    }
    initialize(c)?;
    let (id, expected) = match (&request.account_id, request.expected_revision) {
        (None, None) => {
            let count: i64 = sql(c.query_row(
                "SELECT count(*) FROM account_vault_meta_v1",
                [],
                |r| r.get(0),
            ))?;
            if count >= ACCOUNT_LIMIT {
                return Err("account-limit".into());
            }
            (opaque()?, None)
        }
        (Some(id), Some(revision))
            if valid_id(id) && revision > 0 && revision < i64::MAX as u64 =>
        {
            let current = metadata(c, id)?.ok_or("account-removed")?;
            if current.revision != revision {
                return Err("account-revision-conflict".into());
            }
            (id.clone(), Some(revision))
        }
        _ => return Err("account-revision-invalid".into()),
    };
    let (secret, origin) = match request.kind {
        Kind::Xtream => {
            if request.playlist_url.is_some() {
                return Err("account-fields-invalid".into());
            }
            let server = request
                .server_url
                .as_ref()
                .ok_or("account-address-required")?;
            let origin = endpoint(server, request.allow_http)?;
            let username = request.username.as_ref().ok_or("account-login-required")?;
            let password = request.password.as_ref().ok_or("account-login-required")?;
            if username.is_empty()
                || password.is_empty()
                || username.len() > 2048
                || password.len() > 2048
                || username.chars().any(char::is_control)
                || password.chars().any(char::is_control)
            {
                return Err("account-login-invalid".into());
            }
            (
                Secret::Xtream {
                    server_url: server.clone(),
                    username: username.clone(),
                    password: password.clone(),
                },
                origin,
            )
        }
        Kind::Playlist => {
            if request.server_url.is_some()
                || request.username.is_some()
                || request.password.is_some()
            {
                return Err("account-fields-invalid".into());
            }
            let url = request
                .playlist_url
                .as_ref()
                .ok_or("account-address-required")?;
            let origin = endpoint(url, request.allow_http)?;
            (Secret::Playlist { url: url.clone() }, origin)
        }
    };
    let plaintext =
        Zeroizing::new(serde_json::to_vec(&secret).map_err(|_| "account-secret-invalid")?);
    if plaintext.len() > SECRET_LIMIT {
        return Err("account-secret-too-large".into());
    }
    check()?;
    Ok(PreparedPut {
        metadata: Metadata {
            schema_version: 1,
            id,
            name: request.name.trim().into(),
            kind: request.kind,
            server_origin: origin,
            allow_http: request.allow_http,
            revision: expected.unwrap_or(0) + 1,
            secret_ref: opaque()?,
            requires_sign_in: false,
        },
        expected,
        root_generation,
        plaintext,
    })
}
pub async fn seal(
    app: tauri::AppHandle,
    vault_root: PathBuf,
    mut prepared: PreparedPut,
) -> Result<SealedPut, String> {
    let plaintext = std::mem::take(&mut *prepared.plaintext);
    let ciphertext =
        crate::protect_scan_manifest_page(app, binding(&prepared.metadata), plaintext, false)
            .await
            .map_err(|_| "account-vault-unavailable")?;
    if ciphertext.is_empty() || ciphertext.len() > CIPHER_LIMIT {
        return Err("account-secret-too-large".into());
    }
    // File operations, including fsync, never run on the viewing thread.
    let path = tauri::async_runtime::spawn_blocking(move || {
        let path = file(&vault_root, &prepared.metadata.secret_ref)?;
        fs::create_dir_all(&vault_root).map_err(|_| "account-vault-unavailable")?;
        crate::storage::refuse_link(&vault_root).map_err(|_| "account-vault-path-invalid")?;
        let mut tmp = tempfile::Builder::new()
            .prefix(".gxav-pending-")
            .tempfile_in(&vault_root)
            .map_err(|_| "account-vault-unavailable")?;
        tmp.write_all(&ciphertext)
            .map_err(|_| "account-vault-unavailable")?;
        tmp.as_file()
            .sync_all()
            .map_err(|_| "account-vault-unavailable")?;
        tmp.persist_noclobber(&path)
            .map_err(|_| "account-vault-unavailable")?;
        Ok::<_, String>((path, prepared))
    })
    .await
    .map_err(|_| "account-vault-worker-failed")??;
    Ok(SealedPut {
        path: path.0,
        prepared: path.1,
    })
}
pub fn commit_put(
    c: &mut Connection,
    sealed: SealedPut,
    root_generation: u64,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Commit, String> {
    check()?;
    let prepared = sealed.prepared;
    if prepared.root_generation != root_generation {
        return Err("account-storage-changed".into());
    }
    let file_meta = fs::metadata(&sealed.path).map_err(|_| "account-vault-unavailable")?;
    if !file_meta.is_file() || file_meta.len() == 0 || file_meta.len() > CIPHER_LIMIT as u64 {
        return Err("account-vault-unavailable".into());
    }
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let previous = metadata(&tx, &prepared.metadata.id)?;
    let version: Option<i64> = sql(tx
        .query_row(
            "SELECT revision FROM account_vault_versions_v1 WHERE id=?1",
            [&prepared.metadata.id],
            |r| r.get(0),
        )
        .optional())?;
    if previous.as_ref().map(|v| v.revision) != prepared.expected
        || version.map(|v| v as u64) != prepared.expected
    {
        return Err("account-revision-conflict".into());
    }
    if prepared.expected.is_none() {
        let count: i64 = sql(tx.query_row(
            "SELECT count(*) FROM account_vault_meta_v1",
            [],
            |r| r.get(0),
        ))?;
        if count >= ACCOUNT_LIMIT {
            return Err("account-limit".into());
        }
    }
    let m = &prepared.metadata;
    sql(tx.execute(
        "INSERT INTO account_vault_versions_v1(id,revision,active) VALUES(?1,?2,1)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,active=1",
        params![m.id, m.revision as i64],
    ))?;
    sql(tx.execute(
        "INSERT INTO account_vault_meta_v1(id,name,kind,server_origin,allow_http,revision,secret_ref) VALUES(?1,?2,?3,?4,?5,?6,?7)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,server_origin=excluded.server_origin,
        allow_http=excluded.allow_http,revision=excluded.revision,secret_ref=excluded.secret_ref",
        params![
            m.id,
            m.name,
            m.kind.label(),
            m.server_origin,
            m.allow_http,
            m.revision as i64,
            m.secret_ref
        ],
    ))?;
    // Previously issued resolution handles are revoked by the same transaction.
    sql(tx.execute(
        "DELETE FROM account_vault_references_v1 WHERE account_id=?1",
        [&m.id],
    ))?;
    check()?; // Actual root/request/grant owner recheck immediately before COMMIT.
    sql(tx.commit())?;
    Ok(Commit {
        metadata: prepared.metadata,
        obsolete: previous.map(|v| v.secret_ref),
    })
}
pub fn prepare_resolve(
    c: &Connection,
    account_id: &str,
    expected_revision: u64,
    root_generation: u64,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<PreparedResolve, String> {
    check()?;
    if !valid_id(account_id) {
        return Err("account-reference-invalid".into());
    }
    if !present(c)? {
        return Err("account-sign-in-required".into());
    }
    let m = metadata(c, account_id)?.ok_or("account-removed")?;
    if m.revision != expected_revision {
        return Err("account-revision-conflict".into());
    }
    check()?;
    Ok(PreparedResolve {
        metadata: m,
        root_generation,
    })
}
pub(crate) async fn open(
    app: tauri::AppHandle,
    vault_root: PathBuf,
    prepared: PreparedResolve,
) -> Result<Resolved, String> {
    let reference = prepared.metadata.secret_ref.clone();
    let cipher = tauri::async_runtime::spawn_blocking(move || {
        let path = file(&vault_root, &reference)?;
        let f = fs::File::open(path).map_err(|_| "account-sign-in-required")?;
        let mut ciphertext = Vec::new();
        f.take((CIPHER_LIMIT + 1) as u64)
            .read_to_end(&mut ciphertext)
            .map_err(|_| "account-vault-unavailable")?;
        if ciphertext.is_empty() || ciphertext.len() > CIPHER_LIMIT {
            return Err("account-sign-in-required".into());
        }
        Ok::<_, String>(ciphertext)
    })
    .await
    .map_err(|_| "account-vault-worker-failed")??;
    let plaintext = Zeroizing::new(
        crate::protect_scan_manifest_page(app, binding(&prepared.metadata), cipher, true)
            .await
            .map_err(|_| "account-sign-in-required")?,
    );
    if plaintext.is_empty() || plaintext.len() > SECRET_LIMIT {
        return Err("account-sign-in-required".into());
    }
    let secret: Secret =
        serde_json::from_slice(&plaintext).map_err(|_| "account-sign-in-required")?;
    let (kind, raw) = match &secret {
        Secret::Xtream { server_url, .. } => (Kind::Xtream, server_url),
        Secret::Playlist { url } => (Kind::Playlist, url),
    };
    if kind != prepared.metadata.kind
        || endpoint(raw, prepared.metadata.allow_http)? != prepared.metadata.server_origin
    {
        return Err("account-sign-in-required".into());
    }
    Ok(Resolved {
        metadata: prepared.metadata,
        secret,
        root_generation: prepared.root_generation,
    })
}
pub(crate) fn finish_resolve(
    c: &Connection,
    resolved: Resolved,
    root_generation: u64,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Resolved, String> {
    check()?;
    if root_generation != resolved.root_generation {
        return Err("account-storage-changed".into());
    }
    let current = metadata(c, &resolved.metadata.id)?.ok_or("account-removed")?;
    if current.revision != resolved.metadata.revision
        || current.secret_ref != resolved.metadata.secret_ref
        || current.allow_http != resolved.metadata.allow_http
        || current.server_origin != resolved.metadata.server_origin
    {
        return Err("account-revision-conflict".into());
    }
    check()?;
    Ok(resolved)
}
pub fn remove(
    c: &mut Connection,
    request: &Remove,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<String, String> {
    check()?;
    if request.schema_version != 1
        || !valid_id(&request.account_id)
        || request.expected_revision == 0
        || request.expected_revision >= i64::MAX as u64
    {
        return Err("account-reference-invalid".into());
    }
    initialize(c)?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let m = metadata(&tx, &request.account_id)?.ok_or("account-removed")?;
    if m.revision != request.expected_revision {
        return Err("account-revision-conflict".into());
    }
    sql(tx.execute(
        "DELETE FROM account_vault_references_v1 WHERE account_id=?1",
        [&m.id],
    ))?;
    sql(tx.execute("DELETE FROM account_vault_meta_v1 WHERE id=?1", [&m.id]))?;
    sql(tx.execute(
        "UPDATE account_vault_versions_v1 SET revision=revision+1,active=0 WHERE id=?1",
        [&m.id],
    ))?;
    check()?;
    sql(tx.commit())?;
    Ok(m.secret_ref)
}
/// Remove only an unreferenced envelope. Call under the same account writer owner
/// after commit; never delete envelopes from a different device root or race seal.
pub fn cleanup_unreferenced(
    c: &Connection,
    vault_root: &Path,
    reference: &str,
) -> Result<(), String> {
    let used: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM account_vault_meta_v1 WHERE secret_ref=?1)",
        [reference],
        |r| r.get(0),
    ))?;
    if used {
        return Err("account-vault-still-referenced".into());
    }
    match fs::remove_file(file(vault_root, reference)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("account-vault-cleanup-failed".into()),
    }
}
/// Crash recovery, exclusively while account work is stopped and joined. Never
/// run beside an in-flight seal: an unpublished envelope is still owned work.
/// Existing metadata with an absent/invalid device envelope remains recoverable
/// and is presented as re-entry; only orphaned ciphertext/temp files are removed.
pub fn recover_orphans(
    c: &Connection,
    vault_root: &Path,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<usize, String> {
    check()?;
    // Validate the native root even if no files currently exist.
    file(vault_root, "00000000000000000000000000000000")?;
    let entries = match fs::read_dir(vault_root) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(_) => return Err("account-vault-unavailable".into()),
    };
    let mut candidates = Vec::new();
    let mut inspected = 0usize;
    for entry in entries {
        check()?;
        inspected += 1;
        if inspected > 4096 {
            return Err("account-vault-recovery-limit".into());
        }
        let entry = entry.map_err(|_| "account-vault-unavailable")?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let reference = name.strip_suffix(".gxav").filter(|id| valid_id(id));
        if reference.is_none() && !name.starts_with(".gxav-pending-") {
            continue;
        }
        crate::storage::refuse_link(&entry.path()).map_err(|_| "account-vault-path-invalid")?;
        if !entry
            .file_type()
            .map_err(|_| "account-vault-unavailable")?
            .is_file()
        {
            continue;
        }
        let used = match reference {
            Some(reference) if present(c)? => sql(c.query_row(
                "SELECT EXISTS(SELECT 1 FROM account_vault_meta_v1 WHERE secret_ref=?1)",
                [reference],
                |r| r.get::<_, bool>(0),
            ))?,
            _ => false,
        };
        if !used {
            candidates.push(entry.path());
        }
    }
    // Finish the bounded inventory before deleting anything.
    let mut removed = 0;
    for path in candidates {
        check()?;
        fs::remove_file(path).map_err(|_| "account-vault-cleanup-failed")?;
        removed += 1;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Put {
        serde_json::from_value(serde_json::json!({"schemaVersion":1,"name":"Fixture","kind":"playlist",
            "playlistUrl":"https://fixture.invalid/private-marker/channel?token=fixture-secret","allowHttp":false}))
        .unwrap()
    }
    #[test]
    fn whole_url_is_secret_and_transport_grant_is_distinct() {
        let c = Connection::open_in_memory().unwrap();
        let p = prepare_put(&c, &request(), 3, || Ok(())).unwrap();
        let m = serde_json::to_string(&p.metadata).unwrap();
        assert!(!m.contains("fixture-secret"));
        assert!(!m.contains("private-marker"));
        assert_eq!(p.metadata.server_origin, "https://fixture.invalid");
        let mut r = request();
        r.playlist_url = Some("http://fixture.invalid:8080/?token=secret".into());
        // Without this account's own grant, plain HTTP is refused.
        assert_eq!(
            prepare_put(&c, &r, 3, || Ok(())).err().as_deref(),
            Some("account-secure-transport-required")
        );
        // With it, the exact HTTP origin (scheme, host and port) is pinned.
        r.allow_http = true;
        let http = prepare_put(&c, &r, 3, || Ok(())).unwrap();
        assert_eq!(http.metadata.server_origin, "http://fixture.invalid:8080");
        assert!(http.metadata.allow_http);
        r.playlist_url = Some("ftp://fixture.invalid/".into());
        assert!(prepare_put(&c, &r, 3, || Ok(())).is_err());
    }
    #[test]
    fn stale_update_and_remove_do_not_publish_or_recreate() {
        let mut c = Connection::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let p = prepare_put(&c, &request(), 3, || Ok(())).unwrap();
        let path = file(dir.path(), &p.metadata.secret_ref).unwrap();
        fs::write(&path, [7u8; 64]).unwrap();
        let committed = commit_put(&mut c, SealedPut { prepared: p, path }, 3, || Ok(())).unwrap();
        let mut update = request();
        update.account_id = Some(committed.metadata.id.clone());
        update.expected_revision = Some(1);
        let p = prepare_put(&c, &update, 3, || Ok(())).unwrap();
        let path = file(dir.path(), &p.metadata.secret_ref).unwrap();
        fs::write(&path, [8u8; 64]).unwrap();
        remove(
            &mut c,
            &Remove {
                schema_version: 1,
                account_id: committed.metadata.id,
                expected_revision: 1,
            },
            || Ok(()),
        )
        .unwrap();
        assert!(commit_put(&mut c, SealedPut { prepared: p, path }, 3, || Ok(())).is_err());
        assert!(list(&c).unwrap().is_empty());
    }
    #[test]
    fn canceled_commit_retains_previous_account_and_does_not_publish_secret() {
        let mut c = Connection::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let p = prepare_put(&c, &request(), 3, || Ok(())).unwrap();
        let path = file(dir.path(), &p.metadata.secret_ref).unwrap();
        fs::write(&path, [7u8; 64]).unwrap();
        let mut calls = 0;
        assert!(commit_put(&mut c, SealedPut { prepared: p, path }, 3, || {
            calls += 1;
            if calls == 2 {
                Err("canceled".into())
            } else {
                Ok(())
            }
        })
        .is_err());
        assert!(list(&c).unwrap().is_empty());
        assert_eq!(recover_orphans(&c, dir.path(), || Ok(())).unwrap(), 1);
    }
    #[test]
    fn revisions_are_decimal_strings_and_ids_remain_opaque() {
        let m = Metadata {
            schema_version: 1,
            id: "a".repeat(32),
            name: "Fixture".into(),
            kind: Kind::Playlist,
            server_origin: "https://fixture.invalid".into(),
            allow_http: false,
            revision: 9007199254740993,
            secret_ref: "b".repeat(32),
            requires_sign_in: false,
        };
        let wire = serde_json::to_value(&m).unwrap();
        assert_eq!(wire["revision"], "9007199254740993");
        assert!(wire.get("secretRef").is_none());
        assert!(serde_json::from_value::<Remove>(
            serde_json::json!({"schemaVersion":1,"accountId":"a".repeat(32),"expectedRevision":1})
        )
        .is_err());
        assert!(serde_json::from_value::<Remove>(
            serde_json::json!({"schemaVersion":1,"accountId":"a".repeat(32),"expectedRevision":"01"})
        )
        .is_err());
    }
}
