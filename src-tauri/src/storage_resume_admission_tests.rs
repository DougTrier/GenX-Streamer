//! Real SQLite admission/crypto boundary; XOR is a fixture, not platform protection.
use super::*;
use crate::scan_candidate_manifest::{Append, Begin, Seal};
fn fixture() -> (PairStore, tempfile::TempDir) {
    let (mut checkpoint, prefs, catalog, _, entries, _, _) =
        crate::scan_checkpoint::resume_plan::tests::fixture(65);
    checkpoint["createdAtMs"] = json!(scan_now());
    let dir = tempfile::tempdir().unwrap();
    let store = PairStore::new(dir.path().to_owned()).unwrap();
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    let mut header = store
        .begin_scan_candidate_manifest(
            &Begin {
                schema_version: 1,
                checkpoint: checkpoint.to_string(),
                expected_catalog_revision: "1".into(),
                expected_checkpoint_revision: "0".into(),
            },
            || Ok(()),
        )
        .unwrap();
    for entries in entries.chunks(64) {
        let page = store
            .prepare_scan_candidate_manifest_page(
                Append {
                    manifest_id: header.manifest_id.clone(),
                    expected_manifest_revision: header.manifest_revision.clone(),
                    expected_catalog_revision: "1".into(),
                    expected_checkpoint_revision: "0".into(),
                    entries: entries.to_vec(),
                },
                || Ok(()),
            )
            .unwrap();
        let cipher = xor(&page.plaintext);
        header = store
            .append_scan_candidate_manifest_page(&page, &cipher, || Ok(()))
            .unwrap();
    }
    let seal = Seal {
        manifest_id: header.manifest_id,
        expected_manifest_revision: header.manifest_revision,
        expected_catalog_revision: "1".into(),
        expected_checkpoint_revision: "0".into(),
    };
    let prepared = store
        .prepare_scan_candidate_manifest_seal(&seal, || Ok(()))
        .unwrap();
    store
        .seal_protected_scan_candidate_manifest(&seal, &prepared, &xor(&prepared.plaintext), || {
            Ok(())
        })
        .unwrap();
    (store, dir)
}
fn xor(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().map(|b| b ^ 0xa5).collect()
}
fn prepare(store: &PairStore) -> Result<PreparedAdmission, String> {
    store.prepare_scan_resume_admission("1", "1", 7, "android", "fixture", || Ok(()))
}
#[test]
fn coherent_sql_admission_returns_only_plan_and_authenticated_directory() {
    let (store, dir) = fixture();
    let before = store.read_pair().unwrap();
    let connection = Connection::open(dir.path().join(DB)).unwrap();
    let stored_health: i64 = connection
        .query_row(
            "SELECT health_revision FROM metadata WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored_health, 0); // No health records were written by this fixture.
    let prepared = prepare(&store).unwrap();
    assert_eq!(
        prepared.plan.fence(),
        Fence {
            root_generation: 7,
            catalog: 1,
            health: stored_health,
            checkpoint: 1
        }
    );
    let plaintext = xor(&prepared.encrypted_capsule.ciphertext);
    let admitted = store
        .finish_scan_resume_admission(prepared, plaintext, || Ok(()))
        .unwrap();
    assert_eq!(admitted.directory.rows.len(), 65);
    assert_eq!(admitted.plan.counts().total, 65);
    assert_eq!(admitted.plan.pending_work(64), Some("probe"));
    assert_eq!(store.read_pair().unwrap(), before);
    assert!(admitted.plan.header().get("observations").is_none());
}
#[test]
fn stale_revision_or_policy_between_crypto_phases_refuses_without_writes() {
    let (store, dir) = fixture();
    let prepared = prepare(&store).unwrap();
    let plaintext = xor(&prepared.encrypted_capsule.ciphertext);
    let c = Connection::open(dir.path().join(DB)).unwrap();
    c.execute("UPDATE metadata SET health_revision=health_revision+1", [])
        .unwrap();
    assert!(
        matches!(store.finish_scan_resume_admission(prepared, plaintext, || Ok(())), Err(e) if e=="scan-resume-plan-stale")
    );
    c.execute("UPDATE metadata SET health_revision=health_revision-1", [])
        .unwrap();
    let prepared = prepare(&store).unwrap();
    let plaintext = xor(&prepared.encrypted_capsule.ciphertext);
    c.execute(
        "UPDATE preference SET preferred_region=?1",
        [r#"{"country":"US"}"#],
    )
    .unwrap();
    assert!(store
        .finish_scan_resume_admission(prepared, plaintext, || Ok(()))
        .is_err());
    assert_eq!(
        c.query_row(
            "SELECT revision FROM scan_checkpoint WHERE singleton=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
#[test]
fn writer_after_coherent_capture_cannot_mix_new_revision_with_old_admission() {
    let (store, dir) = fixture();
    let c = Connection::open(dir.path().join(DB)).unwrap();
    let mut checks = 0;
    let result = store.prepare_scan_resume_admission("1", "1", 7, "android", "fixture", || {
        checks += 1;
        if checks == 2 {
            // The full pair/checkpoint snapshot was captured and its reader TX
            // ended. A writer is now allowed, but must invalidate this admission.
            c.execute("UPDATE metadata SET health_revision=health_revision+1", [])
                .unwrap();
        }
        Ok(())
    });
    assert!(matches!(result, Err(e) if e=="scan-resume-plan-stale"));
    assert_eq!(
        c.query_row(
            "SELECT revision FROM scan_checkpoint WHERE singleton=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
#[test]
fn profile_missing_index_tamper_and_cancel_are_explicit() {
    let (store, dir) = fixture();
    assert!(
        matches!(store.prepare_scan_resume_admission("1","1",7,"windows","fixture",||Ok(())), Err(e) if e=="scan-resume-profile-stale")
    );
    assert!(
        matches!(store.prepare_scan_resume_admission_runtime("1","1",7,"android",||Ok(())), Err(e) if e=="scan-resume-profile-stale")
    );
    let prepared = prepare(&store).unwrap();
    let mut plaintext = xor(&prepared.encrypted_capsule.ciphertext);
    plaintext[0] ^= 1;
    assert!(
        matches!(store.finish_scan_resume_admission(prepared,plaintext,||Ok(())), Err(e) if e=="scan-origin-authentication-failed")
    );
    let prepared = prepare(&store).unwrap();
    let plaintext = xor(&prepared.encrypted_capsule.ciphertext);
    assert!(
        matches!(store.finish_scan_resume_admission(prepared,plaintext,||Err("controlled-cancel".into())), Err(e) if e=="controlled-cancel")
    );
    let c = Connection::open(dir.path().join(DB)).unwrap();
    c.execute("DELETE FROM scan_manifest_origin_directory", [])
        .unwrap();
    assert!(matches!(prepare(&store), Err(e) if e=="scan-origin-directory-absent"));
}
