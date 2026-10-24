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

//! Opt-in explicit Map receipt. No source addition, permission grant or name matching.
use super::database::{self as db, sql, GuideMapping};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Receipt {
    pub schema_version: u8,
    pub mapping: GuideMapping,
    pub root_generation: String,
    pub catalog_revision: String,
    pub guide_revision: i64,
    pub source_revision: i64,
    pub source_fingerprint: String,
}
pub(crate) fn root(receipt: &Receipt) -> Result<u64, String> {
    let generation = receipt
        .root_generation
        .parse::<u64>()
        .map_err(|_| "guide-mapping-receipt-invalid")?;
    if receipt.schema_version != 1
        || generation == 0
        || generation.to_string() != receipt.root_generation
        || receipt.guide_revision < 0
        || receipt.source_revision < 1
        || receipt
            .catalog_revision
            .parse::<i64>()
            .ok()
            .is_none_or(|n| n < 0 || n.to_string() != receipt.catalog_revision)
        || receipt.source_fingerprint.len() != 64
        || !receipt
            .source_fingerprint
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("guide-mapping-receipt-invalid".into());
    }
    Ok(generation)
}
pub(crate) fn same_generation(expected: u64, actual: u64) -> Result<(), String> {
    if expected != actual {
        Err("scan-manifest-root-changed".into())
    } else {
        Ok(())
    }
}
fn fingerprint(source: &db::GuideSource) -> Result<String, String> {
    db::key((
        &source.id,
        &source.location,
        &source.kind,
        source.allow_http,
    ))
}
fn source(c: &Connection, id: &str) -> Result<db::GuideSource, String> {
    db::list_sources(c)?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("guide-source-missing".into())
}
pub(crate) fn save(
    c: &mut Connection,
    mapping: GuideMapping,
    generation: u64,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Receipt, String> {
    check()?;
    for id in [&mapping.catalog_source_id, &mapping.guide_source_id] {
        db::valid_text(id, 256, true)?;
    }
    for id in [&mapping.app_channel_id, &mapping.xmltv_channel_id] {
        db::valid_text(id, 16384, true)?;
    }
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let admitted:bool=sql(tx.query_row("SELECT EXISTS(SELECT 1 FROM channel c WHERE c.id=?1 AND c.source_id=?2 AND NOT EXISTS(SELECT 1 FROM removed r WHERE r.id=c.id)) AND EXISTS(SELECT 1 FROM guide_channel WHERE guide_source_id=?3 AND id=?4)",params![mapping.app_channel_id,mapping.catalog_source_id,mapping.guide_source_id,mapping.xmltv_channel_id],|r|r.get(0)))?;
    if !admitted {
        return Err("guide-mapping-target-missing".into());
    }
    let saved_source = source(&tx, &mapping.guide_source_id)?;
    sql(tx.execute("INSERT INTO guide_mapping VALUES(?1,?2,?3,?4) ON CONFLICT(catalog_source_id,app_channel_id) DO UPDATE SET guide_source_id=excluded.guide_source_id,xmltv_channel_id=excluded.xmltv_channel_id",params![mapping.catalog_source_id,mapping.app_channel_id,mapping.guide_source_id,mapping.xmltv_channel_id]))?;
    db::advance(&tx)?;
    let (catalog, guide): (i64, i64) = sql(tx.query_row(
        "SELECT m.catalog_revision,g.revision FROM metadata m,guide_meta g WHERE m.singleton=1 AND g.singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    let receipt = Receipt {
        schema_version: 1,
        mapping,
        root_generation: generation.to_string(),
        catalog_revision: catalog.to_string(),
        guide_revision: guide,
        source_revision: saved_source.revision,
        source_fingerprint: fingerprint(&saved_source)?,
    };
    root(&receipt)?;
    check()?;
    sql(tx.commit())?;
    // No cancellation check after COMMIT: this receipt is already durable.
    Ok(receipt)
}
/// Caller holds the receipt's exact root-generation lease. Preview also checks
/// guide revision; later status checks accept only the actual committed source revision.
pub(crate) fn verify(
    c: &Connection,
    receipt: &Receipt,
    revision: i64,
    strict_guide: bool,
) -> Result<db::GuideSource, String> {
    root(receipt)?;
    let m = &receipt.mapping;
    let (catalog, guide): (i64, i64) = sql(c.query_row(
        "SELECT m.catalog_revision,g.revision FROM metadata m,guide_meta g WHERE m.singleton=1 AND g.singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    if catalog.to_string() != receipt.catalog_revision
        || (strict_guide && guide != receipt.guide_revision)
    {
        return Err("guide-mapping-scope-changed".into());
    }
    let valid:bool=sql(c.query_row("SELECT EXISTS(SELECT 1 FROM guide_mapping m JOIN channel c ON c.id=m.app_channel_id AND c.source_id=m.catalog_source_id JOIN guide_channel h ON h.guide_source_id=m.guide_source_id AND h.id=m.xmltv_channel_id WHERE m.catalog_source_id=?1 AND m.app_channel_id=?2 AND m.guide_source_id=?3 AND m.xmltv_channel_id=?4 AND NOT EXISTS(SELECT 1 FROM removed r WHERE r.id=c.id))",params![m.catalog_source_id,m.app_channel_id,m.guide_source_id,m.xmltv_channel_id],|r|r.get(0)))?;
    let s = source(c, &m.guide_source_id)?;
    if !valid || s.revision != revision || fingerprint(&s)? != receipt.source_fingerprint {
        return Err("guide-mapping-scope-changed".into());
    }
    Ok(s)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub kind: String,
    pub listed: bool,
}
pub(crate) fn status(
    c: &Connection,
    r: &Receipt,
    revision: i64,
    now: i64,
) -> Result<Status, String> {
    db::valid_time(now)?;
    let end = now
        .checked_add(7 * 86400000)
        .ok_or("guide-invalid-instant")?;
    db::valid_time(end)?;
    let tx = sql(c.unchecked_transaction())?;
    let s = verify(&tx, r, revision, false)?;
    let published: Option<i64> = sql(tx.query_row(
        "SELECT published_revision FROM guide_source WHERE id=?1",
        [&s.id],
        |row| row.get(0),
    ))?;
    let listed:bool=sql(tx.query_row("SELECT EXISTS(SELECT 1 FROM guide_program WHERE guide_source_id=?1 AND channel_id=?2 AND start_ms<?3 AND ((stop_ms IS NOT NULL AND stop_ms>?4) OR (stop_ms IS NULL AND start_ms>=?4)))",params![s.id,r.mapping.xmltv_channel_id,end,now],|row|row.get(0)))?;
    sql(tx.commit())?;
    Ok(Status {
        kind: s.kind,
        listed: published == Some(revision) && listed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,catalog_revision INTEGER);INSERT INTO metadata VALUES(1,2);CREATE TABLE guide_meta(singleton INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO guide_meta VALUES(1,2);CREATE TABLE channel(id TEXT,source_id TEXT);INSERT INTO channel VALUES('channel','catalog');CREATE TABLE removed(id TEXT);CREATE TABLE guide_source(id TEXT,name TEXT,location TEXT,kind TEXT,allow_http INTEGER,revision INTEGER,updated_ms INTEGER,published_revision INTEGER);INSERT INTO guide_source VALUES('guide','Selected guide','https://fixture.invalid/guide','url',0,4,NULL,4);CREATE TABLE guide_channel(guide_source_id TEXT,id TEXT);INSERT INTO guide_channel VALUES('guide','selected');CREATE TABLE guide_mapping(catalog_source_id TEXT,app_channel_id TEXT,guide_source_id TEXT,xmltv_channel_id TEXT,PRIMARY KEY(catalog_source_id,app_channel_id));CREATE TABLE guide_program(guide_source_id TEXT,channel_id TEXT,start_ms INTEGER,stop_ms INTEGER);").unwrap();
        c
    }
    fn mapping() -> GuideMapping {
        GuideMapping {
            catalog_source_id: "catalog".into(),
            app_channel_id: "channel".into(),
            guide_source_id: "guide".into(),
            xmltv_channel_id: "selected".into(),
        }
    }
    fn saved(c: &mut Connection) -> Receipt {
        save(c, mapping(), 1, &mut || Ok(())).unwrap()
    }
    #[test]
    fn durable_receipt_matches_the_saved_mapping_and_source_scope() {
        let mut c = fixture();
        let r = saved(&mut c);
        assert_eq!(root(&r).unwrap(), 1);
        assert_eq!(r.guide_revision, 3);
        assert_eq!(verify(&c, &r, 4, true).unwrap().id, "guide");
    }
    #[test]
    fn precommit_cancel_rolls_mapping_and_revision_back() {
        let mut c = fixture();
        let mut n = 0;
        assert!(save(&mut c, mapping(), 1, &mut || {
            n += 1;
            if n == 2 {
                Err("canceled".into())
            } else {
                Ok(())
            }
        })
        .is_err());
        assert_eq!(
            c.query_row("SELECT count(*) FROM guide_mapping", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT revision FROM guide_meta", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
    #[test]
    fn root_replacement_with_identical_sql_ids_cannot_reuse_mapping_ack() {
        let mut first = fixture();
        let r = saved(&mut first);
        let mut replacement = fixture();
        let other = save(&mut replacement, mapping(), 2, &mut || Ok(())).unwrap();
        assert!(verify(&replacement, &r, 4, true).is_ok());
        assert!(same_generation(root(&r).unwrap(), root(&other).unwrap()).is_err());
    }
    #[test]
    fn mapping_or_catalog_race_refuses_even_when_source_still_exists() {
        for sql in [
            "UPDATE guide_mapping SET xmltv_channel_id='another'",
            "UPDATE metadata SET catalog_revision=3",
            "INSERT INTO removed VALUES('channel')",
            "DELETE FROM guide_channel",
        ] {
            let mut c = fixture();
            let r = saved(&mut c);
            c.execute_batch(sql).unwrap();
            assert!(verify(&c, &r, 4, true).is_err(), "{sql}");
        }
    }
    #[test]
    fn source_descriptor_revision_and_guide_revision_races_refuse_preview() {
        for sql in [
            "UPDATE guide_source SET location='https://fixture.invalid/changed'",
            "UPDATE guide_source SET allow_http=1",
            "UPDATE guide_source SET revision=5",
            "UPDATE guide_meta SET revision=4",
        ] {
            let mut c = fixture();
            let r = saved(&mut c);
            c.execute_batch(sql).unwrap();
            assert!(verify(&c, &r, 4, true).is_err(), "{sql}");
        }
    }
    #[test]
    fn target_status_never_borrows_unrelated_or_expired_programmes() {
        let mut c = fixture();
        let r = saved(&mut c);
        c.execute_batch(
            "INSERT INTO guide_program VALUES('guide','other',100,10000),('guide','selected',50,100),('guide','selected',50,NULL)",
        )
        .unwrap();
        assert!(!status(&c, &r, 4, 100).unwrap().listed);
        c.execute_batch("INSERT INTO guide_program VALUES('guide','selected',100,200)")
            .unwrap();
        assert!(status(&c, &r, 4, 100).unwrap().listed);
    }
    #[test]
    fn final_status_accepts_only_actual_new_revision_and_preserves_mapping() {
        let mut c = fixture();
        let r = saved(&mut c);
        c.execute_batch("UPDATE guide_source SET revision=5,published_revision=5;UPDATE guide_meta SET revision=4;INSERT INTO guide_program VALUES('guide','selected',100,200)").unwrap();
        assert!(status(&c, &r, 4, 100).is_err());
        assert!(status(&c, &r, 5, 100).unwrap().listed);
        assert_eq!(
            c.query_row("SELECT count(*) FROM guide_mapping", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn invalid_receipt_or_removed_channel_cannot_write_or_admit() {
        let mut c = fixture();
        c.execute_batch("INSERT INTO removed VALUES('channel')")
            .unwrap();
        assert!(save(&mut c, mapping(), 1, &mut || Ok(())).is_err());
        let mut c = fixture();
        let mut r = saved(&mut c);
        r.root_generation = "01".into();
        assert!(root(&r).is_err());
    }
}
