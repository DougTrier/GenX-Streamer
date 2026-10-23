//! Real Store writer/preimage behavior; no public feeds or devices.
use super::*;
use crate::guide::{cached_matching as cached, database as db, reviewed_crosswalk::Outcome};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};

fn fixture() -> (tempfile::TempDir, Arc<Store>, db::GuideSource) {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::new(root.path().into(), "test".into()).unwrap());
    store.with_guide_write(|c| {
        c.execute_batch("CREATE TABLE preflight_sentinel(payload BLOB);INSERT INTO preflight_sentinel VALUES(zeroblob(1048576));INSERT INTO source(id,name,location,kind,allow_http,ordinal) VALUES('catalog','Fixture','https://example.invalid/list','url',0,0);INSERT INTO channel(id,source_id,provider_id,name,category,ordinal) VALUES('channel','catalog','exact','Fixture','News',0);INSERT INTO guide_source(id,name,location,kind,allow_http,revision,published_revision,updated_ms) VALUES('guide','Guide','https://example.invalid/guide','url',0,2,2,1000);INSERT INTO guide_channel VALUES('guide','exact','[]','exact');INSERT INTO guide_program(guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,description,search_text) VALUES('guide',0,'exact',1000,2000,'Retained program',NULL,'retained program');VACUUM;").map_err(|e|e.to_string())?;
        Ok(())
    }).unwrap();
    store
        .with_guide_write_checked(|_| Ok(()), || Ok(()))
        .unwrap();
    let source = db::GuideSource {
        id: "guide".into(),
        name: "Guide".into(),
        location: "https://example.invalid/guide".into(),
        kind: "url".into(),
        allow_http: false,
        revision: 2,
        updated_ms: None,
    };
    (root, store, source)
}
fn image(root: &Path) -> (Vec<u8>, Vec<u8>) {
    (
        fs::read(root.join("genx.sqlite3")).unwrap(),
        fs::read(root.join("genx.sqlite3.backup")).unwrap(),
    )
}
// SQLite's backup API may change destination header bookkeeping. A committed
// change requires a complete logical preimage, while no-op/cancel tests below
// deliberately continue requiring exact unchanged bytes.
fn logical_image(path: &Path) -> [u8; 32] {
    let c = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let tx = c.unchecked_transaction().unwrap();
    let mut digest = Sha256::new();
    for pragma in ["user_version", "application_id"] {
        let value: i64 = tx.pragma_query_value(None, pragma, |r| r.get(0)).unwrap();
        digest.update(pragma.as_bytes());
        digest.update(value.to_be_bytes());
    }
    let schema: Vec<(String, String, String, Option<String>)> = tx
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for entry in &schema {
        let encoded = serde_json::to_vec(entry).unwrap();
        digest.update((encoded.len() as u64).to_be_bytes());
        digest.update(encoded);
        if entry.0 != "table" {
            continue;
        }
        let query = format!("SELECT * FROM \"{}\"", entry.1.replace('"', "\"\""));
        let mut statement = tx.prepare(&query).unwrap();
        let columns = statement.column_count();
        let mut rows = statement.query([]).unwrap();
        let mut row_digests: Vec<[u8; 32]> = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            let mut row_digest = Sha256::new();
            row_digest.update((columns as u64).to_be_bytes());
            for i in 0..columns {
                use rusqlite::types::ValueRef;
                match row.get_ref(i).unwrap() {
                    ValueRef::Null => row_digest.update([0]),
                    ValueRef::Integer(v) => {
                        row_digest.update([1]);
                        row_digest.update(v.to_be_bytes());
                    }
                    ValueRef::Real(v) => {
                        row_digest.update([2]);
                        row_digest.update(v.to_bits().to_be_bytes());
                    }
                    ValueRef::Text(v) | ValueRef::Blob(v) => {
                        row_digest.update([
                            if matches!(row.get_ref(i).unwrap(), ValueRef::Text(_)) {
                                3
                            } else {
                                4
                            },
                        ]);
                        row_digest.update((v.len() as u64).to_be_bytes());
                        row_digest.update(v);
                    }
                }
            }
            row_digests.push(row_digest.finalize().into());
        }
        row_digests.sort_unstable();
        digest.update((row_digests.len() as u64).to_be_bytes());
        for row_digest in row_digests {
            digest.update(row_digest);
        }
    }
    tx.commit().unwrap();
    digest.finalize().into()
}
fn save(store: &Store, source: &db::GuideSource) -> Result<db::GuideSource, String> {
    store.with_guide_write_preflight_checked(
        |c| db::preflight_save_source(c, source, source.revision),
        |c, check| db::save_source_checked(c, source, source.revision, check),
        || Ok(()),
    )
}
fn cache_scope() -> cached::CachedSource {
    cached::CachedSource {
        id: "guide".into(),
        location: "https://example.invalid/guide".into(),
        expected_source_revision: 2,
        expected_published_revision: 2,
    }
}
fn catalog_revision(store: &Store) -> String {
    store
        .with_guide_read(|c| {
            c.query_row("SELECT catalog_revision FROM metadata", [], |r| {
                r.get::<_, i64>(0)
            })
            .map(|n| n.to_string())
            .map_err(|e| e.to_string())
        })
        .unwrap()
}
#[test]
fn identical_source_save_skips_backup_and_preserves_source_schedule_and_revisions() {
    let (root, store, source) = fixture();
    let before = image(root.path());
    let meta = store
        .with_guide_read(|c| {
            c.query_row("SELECT revision FROM guide_meta", [], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(|e| e.to_string())
        })
        .unwrap();
    let receipt = save(&store, &source).unwrap();
    assert_eq!(receipt.revision, 2);
    assert_eq!(receipt.updated_ms, Some(1000));
    assert_eq!(image(root.path()), before);
    store
        .with_guide_read(|c| {
            assert_eq!(
                c.query_row("SELECT revision FROM guide_meta", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                meta
            );
            assert_eq!(
                c.query_row("SELECT count(*) FROM guide_program", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            Ok(())
        })
        .unwrap();
    let mut stale = source.clone();
    stale.revision = 1;
    assert_eq!(save(&store, &stale).unwrap_err(), "guide-stale-revision");
    assert_eq!(image(root.path()), before);
}
#[test]
fn no_op_succeeds_with_unwritable_backup_but_real_configuration_change_is_refused() {
    let (root, store, source) = fixture();
    let main = fs::read(root.path().join("genx.sqlite3")).unwrap();
    let backup = root.path().join("genx.sqlite3.backup");
    fs::remove_file(&backup).unwrap();
    fs::create_dir(&backup).unwrap();
    assert!(store
        .with_guide_write(|c| db::save_source(c, &source, 2))
        .is_err());
    assert_eq!(save(&store, &source).unwrap().revision, 2);
    let mut changed = source.clone();
    changed.name = "Changed guide".into();
    assert!(save(&store, &changed).is_err());
    assert_eq!(fs::read(root.path().join("genx.sqlite3")).unwrap(), main);
}
#[test]
fn changed_source_still_backs_up_and_real_sqlite_full_rolls_back_prior_schedule() {
    let (root, store, source) = fixture();
    let before = image(root.path());
    let logical_before = logical_image(&root.path().join("genx.sqlite3"));
    let mut changed = source.clone();
    changed.location = format!("https://example.invalid/{}", "x".repeat(12000));
    let error = store
        .with_guide_write_preflight_checked(
            |c| db::preflight_save_source(c, &changed, 2),
            |c, check| {
                let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
                c.pragma_update(None, "max_page_count", pages).unwrap();
                db::save_source_checked(c, &changed, 2, check)
            },
            || Ok(()),
        )
        .unwrap_err();
    assert_eq!(error, "sqlite-storage-full");
    assert_eq!(image(root.path()), before);
    let mut renamed = source.clone();
    renamed.name = "Renamed".into();
    let receipt = save(&store, &renamed).unwrap();
    assert_eq!(receipt.revision, 3);
    assert_eq!(receipt.updated_ms, Some(1000));
    assert_ne!(image(root.path()).0, before.0);
    assert_eq!(
        logical_image(&root.path().join("genx.sqlite3.backup")),
        logical_before
    );
}
#[test]
fn cached_zero_change_read_receipt_skips_backup_and_preserves_all_choices() {
    let (root, store, _) = fixture();
    let revision = catalog_revision(&store);
    let scope = cache_scope();
    store
        .with_guide_write(|c| {
            c.execute(
                "INSERT INTO guide_mapping VALUES('catalog','channel','guide','exact')",
                [],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap();
    store
        .with_guide_write_checked(|_| Ok(()), || Ok(()))
        .unwrap();
    let before = image(root.path());
    let receipt = store
        .with_guide_write_preflight_checked(
            |c| {
                cached::preflight_connection(
                    c,
                    &revision,
                    std::slice::from_ref(&scope),
                    &[],
                    None,
                    Outcome::not_requested(),
                    &|| false,
                    false,
                )
            },
            |_, _| Err("must-not-write".into()),
            || Ok(()),
        )
        .unwrap();
    assert_eq!((receipt.matched, receipt.preserved_mappings), (0, 1));
    assert_eq!(image(root.path()), before);
}
#[test]
fn cached_actual_mapping_requires_backup_and_refuses_failed_backup() {
    let (root, store, _) = fixture();
    let revision = catalog_revision(&store);
    let scope = cache_scope();
    let backup = root.path().join("genx.sqlite3.backup");
    let before = fs::read(root.path().join("genx.sqlite3")).unwrap();
    fs::remove_file(&backup).unwrap();
    fs::create_dir(&backup).unwrap();
    let entered = std::cell::Cell::new(false);
    assert!(store
        .with_guide_write_preflight_checked(
            |c| cached::preflight_connection(
                c,
                &revision,
                std::slice::from_ref(&scope),
                &[],
                None,
                Outcome::not_requested(),
                &|| false,
                false
            ),
            |c, _| {
                entered.set(true);
                cached::connect(c, &revision, std::slice::from_ref(&scope), &[], &|| false)
            },
            || Ok(())
        )
        .is_err());
    assert!(!entered.get());
    assert_eq!(fs::read(root.path().join("genx.sqlite3")).unwrap(), before);
}
#[test]
fn preflight_is_readonly_and_changed_mapping_rechecks_preference_after_snapshot() {
    let (root, store, _) = fixture();
    let revision = catalog_revision(&store);
    let scope = cache_scope();
    assert!(store
        .with_guide_write_preflight_checked(
            |c| {
                assert!(c
                    .execute("UPDATE guide_meta SET revision=revision+1", [])
                    .is_err());
                Ok(Some(()))
            },
            |_, _| Err("must-not-write".into()),
            || Ok(())
        )
        .is_ok());
    let path = root.path().join("genx.sqlite3");
    let result = store.with_guide_write_preflight_checked(
        |c| {
            assert!(cached::preflight_connection(
                c,
                &revision,
                std::slice::from_ref(&scope),
                &[],
                None,
                Outcome::not_requested(),
                &|| false,
                true
            )?
            .is_none());
            Connection::open(&path)
                .unwrap()
                .execute("UPDATE metadata SET automatic_guide_updates=0", [])
                .unwrap();
            Ok(None)
        },
        |c, _| {
            cached::connect_automatic_cached(
                c,
                &revision,
                std::slice::from_ref(&scope),
                &[],
                None,
                Outcome::not_requested(),
                &|| false,
            )
        },
        || Ok(()),
    );
    assert_eq!(result.unwrap_err(), "guide-refresh-disabled");
    store
        .with_guide_read(|c| {
            assert_eq!(
                c.query_row("SELECT count(*) FROM guide_mapping", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            Ok(())
        })
        .unwrap();
}
#[test]
fn checked_preflight_wait_cancels_before_writer_is_released() {
    let (root, store, source) = fixture();
    let before = image(root.path());
    let held = store.write_lease().unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let worker_store = store.clone();
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let result = worker_store.with_guide_write_preflight_checked(
            |c| db::preflight_save_source(c, &source, 2),
            |c, check| db::save_source_checked(c, &source, 2, check),
            || {
                if flag.load(Ordering::SeqCst) {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
        );
        tx.send(result).unwrap();
    });
    cancel.store(true, Ordering::SeqCst);
    assert_eq!(
        rx.recv_timeout(std::time::Duration::from_secs(2))
            .unwrap()
            .unwrap_err(),
        "canceled"
    );
    drop(held);
    worker.join().unwrap();
    assert_eq!(image(root.path()), before);
}

#[test]
fn real_mapping_commit_has_checked_preimage_and_exact_new_mapping() {
    let (root, store, _) = fixture();
    let revision = catalog_revision(&store);
    let scope = cache_scope();
    let before = image(root.path());
    let logical_before = logical_image(&root.path().join("genx.sqlite3"));
    let result = store
        .with_guide_write_preflight_checked(
            |c| {
                cached::preflight_connection(
                    c,
                    &revision,
                    std::slice::from_ref(&scope),
                    &[],
                    None,
                    Outcome::not_requested(),
                    &|| false,
                    false,
                )
            },
            |c, _| cached::connect(c, &revision, std::slice::from_ref(&scope), &[], &|| false),
            || Ok(()),
        )
        .unwrap();
    assert_eq!(result.matched, 1);
    assert_eq!(
        logical_image(&root.path().join("genx.sqlite3.backup")),
        logical_before
    );
    assert_ne!(image(root.path()).0, before.0);
    store.with_guide_read(|c| {
        let mapping:(String,String) = c.query_row("SELECT guide_source_id,xmltv_channel_id FROM guide_mapping WHERE catalog_source_id='catalog' AND app_channel_id='channel'", [], |r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(mapping,("guide".into(),"exact".into()));
        assert_eq!(c.query_row("SELECT title FROM guide_program",[],|r|r.get::<_,String>(0)).unwrap(),"Retained program");
        Ok(())
    }).unwrap();
}
#[test]
fn cancellation_after_readonly_proof_prevents_noop_receipt_without_any_write() {
    let (root, store, source) = fixture();
    let before = image(root.path());
    let canceled = AtomicBool::new(false);
    let result = store.with_guide_write_preflight_checked(
        |c| {
            let proof = db::preflight_save_source(c, &source, 2)?;
            canceled.store(true, Ordering::SeqCst);
            Ok(proof)
        },
        |_, _| Err("must-not-write".into()),
        || {
            if canceled.load(Ordering::SeqCst) {
                Err("canceled".into())
            } else {
                Ok(())
            }
        },
    );
    assert_eq!(result.unwrap_err(), "canceled");
    assert_eq!(image(root.path()), before);
}
