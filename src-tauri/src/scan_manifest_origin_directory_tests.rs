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

//! SQLite/domain proof. XOR is only a deterministic test transform, NOT crypto proof.
use super::super::tests as legacy;
use super::*;
use crate::storage_transaction::PairStore;
struct Fixture {
    connection: Connection,
    store: PairStore,
    header: Header,
    prefs: Value,
    catalog: Value,
    _dir: tempfile::TempDir,
}
impl Fixture {
    fn staged(count: usize) -> Self {
        let (dir, store, checkpoint, entries) = legacy::fixture(count);
        let mut header = store
            .begin_scan_candidate_manifest(&legacy::begin_request(&checkpoint), || Ok(()))
            .unwrap();
        for chunk in entries.chunks(64) {
            header = legacy::append(&store, &header, chunk);
        }
        let pair = store.read_pair().unwrap();
        let connection = Connection::open(dir.path().join("genx.sqlite3")).unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        Self {
            _dir: dir,
            store,
            connection,
            header,
            prefs: serde_json::from_str(pair.preferences.as_ref().unwrap()).unwrap(),
            catalog: serde_json::from_str(pair.catalog.as_ref().unwrap()).unwrap(),
        }
    }
    fn context(&self, cp: i64) -> Context<'_> {
        Context {
            preferences: &self.prefs,
            catalog: &self.catalog,
            catalog_revision: 1,
            checkpoint_revision: cp,
            now: legacy::now(),
        }
    }
    fn find(&self) -> Find {
        Find {
            job_id: self.header.job_id.clone(),
            review_digest: self.header.review_digest.clone(),
            expected_catalog_revision: "1".into(),
            expected_checkpoint_revision: "1".into(),
        }
    }
    fn seal_with_capsule(&mut self) {
        let request = legacy::seal_request(&self.header);
        let proof = prepare_seal(&self.connection, &request, &self.context(0), || Ok(())).unwrap();
        let cipher = xor(&proof.plaintext);
        let seed = seal_seed(&self.connection, &request, &self.context(0)).unwrap();
        let prefs = &self.prefs;
        let catalog = &self.catalog;
        let context = Context {
            preferences: prefs,
            catalog,
            catalog_revision: 1,
            checkpoint_revision: 0,
            now: legacy::now(),
        };
        let tx = self.connection.transaction().unwrap();
        finish_seal(&tx, &request, &proof, &cipher, &context, || Ok(())).unwrap();
        crate::scan_checkpoint::apply(
            &tx,
            &crate::scan_checkpoint::Mutation::Save { checkpoint: seed },
            0,
            prefs,
            catalog,
            (1, 1, context.now),
            || Ok(()),
        )
        .unwrap();
        seal(&tx, &request).unwrap();
        tx.commit().unwrap();
    }
}
fn xor(input: &[u8]) -> Vec<u8> {
    input.iter().map(|b| b ^ 0xa5).collect()
}
#[test]
fn primary_origin_matches_default_port_idna_ipv6_and_preserves_scope() {
    for (a, b) in [
        (
            "https://EXAMPLE.com:443/a?token=1#one",
            "https://example.com/b#two",
        ),
        ("http://example.com:80/a", "http://EXAMPLE.com/b"),
        ("https://[::1]:443/a", "https://[::1]/b"),
        (
            "https://bücher.example/a",
            "https://xn--bcher-kva.example/b",
        ),
    ] {
        assert_eq!(origin_token(a).unwrap(), origin_token(b).unwrap());
    }
    assert_ne!(
        origin_token("https://example.com/a").unwrap(),
        origin_token("http://example.com/a").unwrap()
    );
    assert_ne!(
        origin_token("https://example.com:444/a").unwrap(),
        origin_token("https://example.com/a").unwrap()
    );
    for raw in [
        "file:///a",
        "https://user:secret@example.com/a",
        "https://example.com/a\n",
    ] {
        assert!(origin_token(raw).is_err());
    }
}
#[test]
fn page_capture_origin_rows_and_capsule_seal_share_atomic_checkpoint_transaction() {
    let mut f = Fixture::staged(65);
    let before = f.store.read_pair().unwrap();
    let count: i64 = f
        .connection
        .query_row("SELECT COUNT(*) FROM scan_manifest_origin", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 65);
    f.seal_with_capsule();
    let request = f.find();
    let proof = prepare_open(&f.connection, &request, &f.context(1), || Ok(())).unwrap();
    let admitted = finish_open(
        &f.connection,
        &request,
        &proof,
        xor(&proof.ciphertext),
        &f.context(1),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(admitted.rows.len(), 65);
    assert_eq!(admitted.rows[64].ordinal, 64);
    assert_eq!(f.store.read_pair().unwrap().catalog, before.catalog);
    assert_eq!(f.store.read_pair().unwrap().preferences, before.preferences);
    assert_eq!(
        f.store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "1"
    );
    let columns: i64 = f
        .connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('scan_manifest_origin') WHERE name LIKE '%url%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(columns, 1); // Only binary hash, never original URL.
    let size: i64 = f
        .connection
        .query_row(
            "SELECT MAX(length(metadata_hash)+length(primary_url_hash)+length(origin_token)) FROM scan_manifest_origin",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(size, 96);
}
#[test]
fn sidecar_origin_tamper_cannot_authenticate_or_relabel_concurrency() {
    let mut f = Fixture::staged(2);
    f.seal_with_capsule();
    let request = f.find();
    let proof = prepare_open(&f.connection, &request, &f.context(1), || Ok(())).unwrap();
    f.connection
        .execute(
            "UPDATE scan_manifest_origin SET origin_token=zeroblob(32) WHERE ordinal=0",
            [],
        )
        .unwrap();
    assert_eq!(
        finish_open(
            &f.connection,
            &request,
            &proof,
            xor(&proof.ciphertext),
            &f.context(1),
            || Ok(())
        )
        .err()
        .unwrap(),
        "scan-origin-authentication-failed"
    );
    assert_eq!(
        f.store.read_scan_checkpoint().unwrap().checkpoint_revision,
        "1"
    );
}
#[test]
fn cancellation_after_capsule_sql_update_rolls_back_every_seal_part() {
    let mut f = Fixture::staged(2);
    let request = legacy::seal_request(&f.header);
    let proof = prepare_seal(&f.connection, &request, &f.context(0), || Ok(())).unwrap();
    let cipher = xor(&proof.plaintext);
    let prefs = &f.prefs;
    let catalog = &f.catalog;
    let context = Context {
        preferences: prefs,
        catalog,
        catalog_revision: 1,
        checkpoint_revision: 0,
        now: legacy::now(),
    };
    let tx = f.connection.transaction().unwrap();
    let mut n = 0;
    assert_eq!(
        finish_seal(&tx, &request, &proof, &cipher, &context, || {
            n += 1;
            if n == 3 {
                Err("canceled".into())
            } else {
                Ok(())
            }
        })
        .unwrap_err(),
        "canceled"
    );
    drop(tx);
    let state: i64 = f
        .connection
        .query_row(
            "SELECT state FROM scan_manifest_origin_directory",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(state, 0);
    let state: i64 = f
        .connection
        .query_row("SELECT state FROM scan_manifest", [], |r| r.get(0))
        .unwrap();
    assert_eq!(state, 0);
    assert_eq!(
        f.store.read_scan_checkpoint().unwrap().checkpoint_status,
        "absent"
    );
}
#[test]
fn legacy_offline_backfill_is_bounded_authenticated_and_keeps_exact_checkpoint() {
    let mut f = Fixture::staged(65);
    f.store
        .seal_scan_candidate_manifest(&legacy::seal_request(&f.header), || Ok(()))
        .unwrap();
    f.connection
        .execute("DELETE FROM scan_manifest_origin_directory", [])
        .unwrap();
    f.connection
        .execute("DELETE FROM scan_manifest_origin", [])
        .unwrap();
    let before = f.store.read_scan_checkpoint().unwrap();
    let request = f.find();
    let prefs = &f.prefs;
    let catalog = &f.catalog;
    let context = Context {
        preferences: prefs,
        catalog,
        catalog_revision: 1,
        checkpoint_revision: 1,
        now: legacy::now(),
    };
    let tx = f.connection.transaction().unwrap();
    let mut h = begin_backfill(&tx, &request, &context, || Ok(())).unwrap();
    tx.commit().unwrap();
    while h.next_index < 65 {
        let read = legacy::read_request(&f.header, h.next_index);
        let encrypted = read_page(&f.connection, &read, &context).unwrap();
        let plain = xor(&encrypted.ciphertext);
        verify_read(&f.connection, &read, &context, &encrypted).unwrap();
        let authenticated = finish_page_authenticated(encrypted, plain).unwrap();
        let tx = f.connection.transaction().unwrap();
        h = append_backfill(
            &tx,
            &request,
            &h.origin_revision,
            &authenticated,
            &context,
            || Ok(()),
        )
        .unwrap();
        tx.commit().unwrap();
    }
    let proof = prepare_backfill_seal(&f.connection, &request, &context, || Ok(())).unwrap();
    let cipher = xor(&proof.plaintext);
    let tx = f.connection.transaction().unwrap();
    let sealed = finish_backfill_seal(&tx, &request, &proof, &cipher, &context, || Ok(())).unwrap();
    tx.commit().unwrap();
    assert_eq!(sealed.state, "sealed");
    let after = f.store.read_scan_checkpoint().unwrap();
    assert_eq!(before.checkpoint, after.checkpoint);
    assert_eq!(before.checkpoint_revision, after.checkpoint_revision);
    let proof = prepare_open(&f.connection, &request, &context, || Ok(())).unwrap();
    assert_eq!(
        finish_open(
            &f.connection,
            &request,
            &proof,
            xor(&proof.ciphertext),
            &context,
            || Ok(())
        )
        .unwrap()
        .rows
        .len(),
        65
    );
}
#[test]
fn crypto_boundary_revision_cancel_and_directory_version_fail_closed() {
    let mut f = Fixture::staged(1);
    f.seal_with_capsule();
    let request = f.find();
    let proof = prepare_open(&f.connection, &request, &f.context(1), || Ok(())).unwrap();
    let mut stale = f.context(1);
    stale.checkpoint_revision = 2;
    assert_eq!(
        finish_open(
            &f.connection,
            &request,
            &proof,
            xor(&proof.ciphertext),
            &stale,
            || Ok(())
        )
        .err()
        .unwrap(),
        "scan-checkpoint-revision-stale"
    );
    assert_eq!(
        finish_open(
            &f.connection,
            &request,
            &proof,
            xor(&proof.ciphertext),
            &f.context(1),
            || Err("canceled".into())
        )
        .err()
        .unwrap(),
        "canceled"
    );
    f.connection.execute_batch("PRAGMA ignore_check_constraints=ON;UPDATE scan_manifest_origin_namespace SET schema_version=2;PRAGMA ignore_check_constraints=OFF").unwrap();
    assert_eq!(
        prepare_open(&f.connection, &request, &f.context(1), || Ok(()))
            .err()
            .unwrap(),
        "scan-origin-version-unsupported"
    );
}
