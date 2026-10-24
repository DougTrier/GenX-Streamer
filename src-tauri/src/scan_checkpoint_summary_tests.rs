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
use serde_json::json;

fn connection() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,catalog_revision INTEGER);INSERT INTO metadata VALUES(1,19);CREATE TABLE scan_checkpoint(singleton INTEGER PRIMARY KEY,schema_version INTEGER,revision INTEGER,job_id TEXT,contents TEXT);INSERT INTO scan_checkpoint VALUES(1,1,7,NULL,NULL)").unwrap();
    c
}
fn value(version: u8) -> Value {
    if version == 3 {
        json!({"schemaVersion":3,"jobId":"private-job","review":{"candidates":[["a",0,[],"secret-name",0,[],[],"hash",[]],["b",0,[],"name",0,[],[],"hash",[]]]},"observations":[[0,100,"Reachable",{}],[1,101,"TimedOut",{}]],"publishedIndices":[]})
    } else {
        json!({"schemaVersion":version,"jobId":"private-job","review":{"candidates":[{"key":"a","channel":{"urls":["https://secret.invalid/private"]}},{"key":"b"}]},"observations":[{"channelId":"a","verdict":"Reachable"},{"channelId":"b","verdict":"TimedOut"}],"publishedKeys":[]})
    }
}
fn install(c: &Connection, v: &Value) {
    c.execute(
        "UPDATE scan_checkpoint SET job_id='private-job',contents=?1",
        [v.to_string()],
    )
    .unwrap();
}
#[test]
fn all_three_formats_count_unpublished_responders_without_exposing_private_fields() {
    for version in 1..=3 {
        let c = connection();
        let mut v = value(version);
        install(&c, &v);
        let s = finish(capture(&c).unwrap(), || Ok(())).unwrap();
        assert_eq!(
            (s.total, s.checked, s.responded, s.published, s.unfinished),
            (2, 2, 1, 0, true)
        );
        assert_eq!(s.stored_version, Some(version));
        assert_eq!(s.catalog_revision, "19");
        assert_eq!(s.checkpoint_revision, "7");
        let encoded = serde_json::to_string(&s).unwrap();
        for secret in [
            "private-job",
            "secret-name",
            "secret.invalid",
            "urls",
            "query",
        ] {
            assert!(!encoded.contains(secret));
        }
        v[if version == 3 {
            "publishedIndices"
        } else {
            "publishedKeys"
        }] = if version == 3 {
            json!([0])
        } else {
            json!(["a"])
        };
        install(&c, &v);
        let s = finish(capture(&c).unwrap(), || Ok(())).unwrap();
        assert_eq!(
            (s.total, s.checked, s.responded, s.published, s.unfinished),
            (2, 2, 1, 1, false)
        );
    }
}
#[test]
fn absent_invalid_and_unreadable_are_distinct_and_invalid_counts_never_leak() {
    let c = connection();
    let s = finish(capture(&c).unwrap(), || Ok(())).unwrap();
    assert_eq!(s.checkpoint_status, "absent");
    for mode in [
        "json",
        "future",
        "job",
        "duplicate",
        "unknown",
        "unobserved",
        "verdict",
        "oversize",
    ] {
        let mut v = value(1);
        match mode {
            "future" => v["schemaVersion"] = json!(4),
            "job" => v["jobId"] = json!("other"),
            "duplicate" => {
                let previous = v["observations"][0].clone();
                v["observations"].as_array_mut().unwrap().push(previous);
            }
            "unknown" => v["observations"][0]["channelId"] = json!("unknown"),
            "unobserved" => v["publishedKeys"] = json!(["b"]),
            "verdict" => v["observations"][0]["verdict"] = json!("Canceled"),
            _ => {}
        }
        install(&c, &v);
        if mode == "json" {
            c.execute("UPDATE scan_checkpoint SET contents='not-json'", [])
                .unwrap();
        }
        if mode == "oversize" {
            c.execute(
                "UPDATE scan_checkpoint SET contents=?1",
                ["x".repeat(LIMIT + 1)],
            )
            .unwrap();
        }
        let s = finish(capture(&c).unwrap(), || Ok(())).unwrap();
        assert_eq!(s.checkpoint_status, "invalid", "{mode}");
        assert_eq!(
            (
                s.total,
                s.checked,
                s.responded,
                s.published,
                s.unfinished,
                s.stored_version
            ),
            (0, 0, 0, 0, false, None)
        );
    }
    c.execute_batch("DROP TABLE metadata").unwrap();
    assert_eq!(capture(&c).err().unwrap(), "scan-checkpoint-storage-failed");
}
#[test]
fn captured_summary_remains_coherent_after_later_sql_changes_and_cancellation_refuses() {
    let c = connection();
    install(&c, &value(3));
    let captured = capture(&c).unwrap();
    c.execute_batch("UPDATE metadata SET catalog_revision=20;UPDATE scan_checkpoint SET revision=8,contents=NULL,job_id=NULL").unwrap();
    let old = finish(captured, || Ok(())).unwrap();
    assert_eq!(
        (
            old.catalog_revision.as_str(),
            old.checkpoint_revision.as_str(),
            old.total
        ),
        ("19", "7", 2)
    );
    let new = finish(capture(&c).unwrap(), || Ok(())).unwrap();
    assert_eq!(
        (
            new.catalog_revision.as_str(),
            new.checkpoint_revision.as_str(),
            new.checkpoint_status
        ),
        ("20", "8", "absent")
    );
    assert_eq!(
        finish(capture(&c).unwrap(), || Err("canceled".into())).unwrap_err(),
        "canceled"
    );
    c.execute_batch("UPDATE metadata SET catalog_revision=-1")
        .unwrap();
    assert_eq!(capture(&c).err().unwrap(), "storage-revision-invalid");
}

#[test]
fn summary_cardinality_limit_rejects_whole_instead_of_truncating() {
    let c = connection();
    let mut v = value(1);
    v["review"]["candidates"] = Value::Array(
        (0..COUNT_LIMIT)
            .map(|i| json!({"key":format!("key-{i}")}))
            .collect(),
    );
    v["observations"] = json!([]);
    install(&c, &v);
    assert_eq!(
        finish(capture(&c).unwrap(), || Ok(())).unwrap().total,
        COUNT_LIMIT
    );
    v["review"]["candidates"]
        .as_array_mut()
        .unwrap()
        .push(json!({"key":"extra"}));
    install(&c, &v);
    assert_eq!(
        finish(capture(&c).unwrap(), || Ok(()))
            .unwrap()
            .checkpoint_status,
        "invalid"
    );
}

#[test]
fn real_pair_store_summary_is_readonly_reopens_and_keeps_snapshot_revision_identity() {
    use crate::storage_transaction::{PairStore, DB};
    let dir = tempfile::tempdir().unwrap();
    let store = PairStore::new(dir.path().into()).unwrap();
    store.write_pair(
        &json!({"schemaVersion":1,"sources":[],"channels":[]}).to_string(),
        &json!({"schemaVersion":1,"sources":[],"favorites":[],"removedChannels":[],"volume":0.5,"muted":false,"panelWidth":300}).to_string(),
    ).unwrap();
    let mut c = Connection::open(dir.path().join(DB)).unwrap();
    crate::scan_checkpoint::ensure(&c).unwrap();
    install(&c, &value(3));
    let tx = c.transaction().unwrap();
    let captured = capture(&tx).unwrap();
    tx.commit().unwrap();
    c.execute_batch("UPDATE metadata SET catalog_revision=2;UPDATE scan_checkpoint SET revision=1,contents=NULL,job_id=NULL").unwrap();
    let previous = finish(captured, || Ok(())).unwrap();
    assert_eq!(
        (
            previous.catalog_revision.as_str(),
            previous.checkpoint_revision.as_str(),
            previous.total
        ),
        ("1", "0", 2)
    );
    drop(c);
    let before_pair = store.read_pair().unwrap();
    let before_bytes = std::fs::read(dir.path().join(DB)).unwrap();
    let current = store.read_scan_checkpoint_summary(|| Ok(())).unwrap();
    assert_eq!(
        (
            current.catalog_revision.as_str(),
            current.checkpoint_revision.as_str(),
            current.checkpoint_status
        ),
        ("2", "1", "absent")
    );
    assert_eq!(std::fs::read(dir.path().join(DB)).unwrap(), before_bytes);
    assert_eq!(store.read_pair().unwrap(), before_pair);
    drop(store);
    let reopened = PairStore::new(dir.path().into()).unwrap();
    assert_eq!(
        reopened.read_scan_checkpoint_summary(|| Ok(())).unwrap(),
        current
    );
    assert_eq!(
        reopened
            .read_scan_checkpoint_summary(|| Err("canceled".into()))
            .unwrap_err(),
        "canceled"
    );
}
