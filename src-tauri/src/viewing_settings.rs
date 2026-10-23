//! Device viewing choices kept beside the account data: whether adult channels
//! are hidden, and each paid account's playback buffer. Both live in their own
//! tables, created on first write; absent tables mean the defaults. An
//! account's buffer row is removed with the account (foreign-key cascade).
use crate::scan_manifest_work;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const ERR: &str = "viewing-settings-invalid";
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS viewing_settings_v1(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 hide_adult INTEGER NOT NULL CHECK(hide_adult IN(0,1)));";
const ACCOUNT_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS account_playback_settings_v1(
 account_id TEXT PRIMARY KEY REFERENCES account_vault_meta_v1(id) ON DELETE CASCADE,
 buffer TEXT NOT NULL CHECK(buffer IN('fast','balanced','smooth')));";
/// Adult channels stay hidden until the viewer chooses to show them.
const HIDE_ADULT_DEFAULT: bool = true;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Buffer {
    Fast,
    Balanced,
    Smooth,
}
impl Buffer {
    fn as_str(self) -> &'static str {
        match self {
            Buffer::Fast => "fast",
            Buffer::Balanced => "balanced",
            Buffer::Smooth => "smooth",
        }
    }
    fn parse(value: &str) -> Option<Self> {
        match value {
            "fast" => Some(Buffer::Fast),
            "balanced" => Some(Buffer::Balanced),
            "smooth" => Some(Buffer::Smooth),
            _ => None,
        }
    }
}
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    schema_version: u8,
    hide_adult: bool,
    /// Accounts without an entry use the balanced buffer.
    account_buffers: BTreeMap<String, Buffer>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Write {
    schema_version: u8,
    hide_adult: Option<bool>,
    account_id: Option<String>,
    buffer: Option<Buffer>,
}

fn sql<T>(value: rusqlite::Result<T>) -> Result<T, String> {
    value.map_err(|_| "viewing-settings-storage".to_string())
}
fn table(c: &Connection, name: &str) -> Result<bool, String> {
    sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    ))
}
fn opaque(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn read(c: &Connection) -> Result<Settings, String> {
    let hide_adult = if table(c, "viewing_settings_v1")? {
        sql(c
            .query_row(
                "SELECT hide_adult FROM viewing_settings_v1 WHERE singleton=1",
                [],
                |r| r.get::<_, bool>(0),
            )
            .optional())?
        .unwrap_or(HIDE_ADULT_DEFAULT)
    } else {
        HIDE_ADULT_DEFAULT
    };
    let mut account_buffers = BTreeMap::new();
    if table(c, "account_playback_settings_v1")? {
        let mut statement = sql(c.prepare(
            "SELECT s.account_id,s.buffer FROM account_playback_settings_v1 s
             JOIN account_vault_meta_v1 m ON m.id=s.account_id ORDER BY s.account_id",
        ))?;
        let rows =
            sql(statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))))?;
        for row in rows {
            let (account, buffer) = sql(row)?;
            let buffer = Buffer::parse(&buffer).ok_or("viewing-settings-storage")?;
            account_buffers.insert(account, buffer);
        }
    }
    Ok(Settings {
        schema_version: 1,
        hide_adult,
        account_buffers,
    })
}
fn validate(request: &Write) -> Result<(), String> {
    let account_change = request.account_id.is_some() || request.buffer.is_some();
    if request.schema_version != 1
        || (request.hide_adult.is_none() && !account_change)
        || (account_change && (request.account_id.is_none() || request.buffer.is_none()))
        || request.account_id.as_deref().is_some_and(|id| !opaque(id))
    {
        return Err(ERR.into());
    }
    Ok(())
}
pub(crate) fn apply(c: &mut Connection, request: &Write) -> Result<Settings, String> {
    validate(request)?;
    if !sql(c.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, bool>(0)))? {
        return Err("viewing-settings-storage-policy".into());
    }
    let tx = sql(c.transaction())?;
    if let Some(hide) = request.hide_adult {
        sql(tx.execute_batch(SCHEMA))?;
        sql(tx.execute(
            "INSERT INTO viewing_settings_v1(singleton,hide_adult) VALUES(1,?1)
             ON CONFLICT(singleton) DO UPDATE SET hide_adult=excluded.hide_adult",
            params![hide],
        ))?;
    }
    if let (Some(account), Some(buffer)) = (&request.account_id, request.buffer) {
        if !table(&tx, "account_vault_meta_v1")? {
            return Err("account-sign-in-required".into());
        }
        let known: bool = sql(tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM account_vault_meta_v1 WHERE id=?1)",
            [account],
            |r| r.get(0),
        ))?;
        if !known {
            return Err("account-not-found".into());
        }
        sql(tx.execute_batch(ACCOUNT_SCHEMA))?;
        sql(tx.execute(
            "INSERT INTO account_playback_settings_v1(account_id,buffer) VALUES(?1,?2)
             ON CONFLICT(account_id) DO UPDATE SET buffer=excluded.buffer",
            params![account, buffer.as_str()],
        ))?;
    }
    let settings = read(&tx)?;
    sql(tx.commit())?;
    Ok(settings)
}

#[tauri::command]
pub(crate) async fn read_viewing_settings(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Settings, String> {
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (settings, _) = owner
            .storage(None, move |store, check| {
                check()?;
                store.with_guide_read(read)
            })
            .await?;
        Ok(settings)
    })
    .await
}
#[tauri::command]
pub(crate) async fn write_viewing_settings(
    request: Write,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Settings, String> {
    validate(&request)?;
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (settings, _) = owner
            .storage(None, move |store, check| {
                check()?;
                store.with_guide_write(|c| apply(c, &request))
            })
            .await?;
        Ok(settings)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "PRAGMA foreign_keys=ON;CREATE TABLE account_vault_meta_v1(id TEXT PRIMARY KEY);
             INSERT INTO account_vault_meta_v1 VALUES('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');",
        )
        .unwrap();
        c
    }
    fn write(hide_adult: Option<bool>, account: Option<&str>, buffer: Option<Buffer>) -> Write {
        Write {
            schema_version: 1,
            hide_adult,
            account_id: account.map(str::to_owned),
            buffer,
        }
    }
    const ACCOUNT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn absent_tables_mean_defaults() {
        let settings = read(&database()).unwrap();
        assert!(settings.hide_adult);
        assert!(settings.account_buffers.is_empty());
    }
    #[test]
    fn choices_persist_and_follow_the_account() {
        let mut c = database();
        apply(&mut c, &write(Some(false), None, None)).unwrap();
        let settings = apply(&mut c, &write(None, Some(ACCOUNT), Some(Buffer::Smooth))).unwrap();
        assert!(!settings.hide_adult);
        assert_eq!(settings.account_buffers.get(ACCOUNT), Some(&Buffer::Smooth));
        c.execute("DELETE FROM account_vault_meta_v1 WHERE id=?1", [ACCOUNT])
            .unwrap();
        assert!(read(&c).unwrap().account_buffers.is_empty());
    }
    #[test]
    fn unknown_accounts_and_empty_writes_are_refused() {
        let mut c = database();
        let other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        assert_eq!(
            apply(&mut c, &write(None, Some(other), Some(Buffer::Fast))).unwrap_err(),
            "account-not-found"
        );
        assert!(apply(&mut c, &write(None, None, None)).is_err());
        assert!(apply(&mut c, &write(None, Some(ACCOUNT), None)).is_err());
        assert!(apply(&mut c, &write(None, Some("../x"), Some(Buffer::Fast))).is_err());
    }
}
