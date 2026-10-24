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

//! Actual current_job storage-class/error regression and bounded native SQL measurement.
//! Synthetic payloads establish SQL cost, not packaged scan or hardware acceptance.
use super::{current_job, Context};
use rusqlite::{params, types::Value, Connection, OptionalExtension};
const DDL: &str = "CREATE TABLE scan_checkpoint(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),revision INTEGER NOT NULL CHECK(revision>=0),job_id TEXT,contents TEXT)";
const CURRENT: &str = "SELECT job_id,contents IS NOT NULL FROM scan_checkpoint WHERE singleton=1";
const TYPEOF: &str =
    "SELECT job_id,typeof(contents)!='null' FROM scan_checkpoint WHERE singleton=1";
const WHERE: &str = "SELECT job_id FROM scan_checkpoint WHERE singleton=1 AND contents IS NOT NULL";
#[test]
fn checkpoint_presence_typeof_preserves_all_storage_classes_and_missing_row() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(DDL).unwrap();
    c.execute("INSERT INTO scan_checkpoint VALUES(1,1,0,'job',NULL)", [])
        .unwrap();
    for job in [Some("job"), None] {
        c.execute("UPDATE scan_checkpoint SET job_id=?1", [job])
            .unwrap();
        for value in [
            Value::Null,
            Value::Text(String::new()),
            Value::Blob(vec![]),
            Value::Integer(0),
            Value::Real(0.5),
            Value::Blob(vec![255, 0]),
            Value::Text("null".into()),
            Value::Text("{}".into()),
            Value::Text("{invalid".into()),
        ] {
            c.execute("UPDATE scan_checkpoint SET contents=?1", params![value])
                .unwrap();
            let original: (Option<String>, bool) = c
                .query_row(CURRENT, [], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap();
            let proposed: (Option<String>, bool) = c
                .query_row(TYPEOF, [], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap();
            let filtered: Option<Option<String>> =
                c.query_row(WHERE, [], |r| r.get(0)).optional().unwrap();
            assert_eq!(original, proposed);
            let empty = serde_json::json!({});
            let context = Context {
                preferences: &empty,
                catalog: &empty,
                catalog_revision: 0,
                checkpoint_revision: 0,
                now: 1000,
            };
            let actual = current_job(&c, &context, "job", &"a".repeat(64));
            if original.1 && original.0.as_deref() == Some("job") {
                assert!(actual.is_ok());
            } else {
                assert_eq!(actual.err().unwrap(), "scan-manifest-job-stale");
            }
            assert_eq!(
                current_job(&c, &context, "job", &"a".repeat(63))
                    .err()
                    .unwrap(),
                "scan-manifest-job-stale"
            );
            assert_eq!(filtered, if original.1 { Some(original.0) } else { None });
        }
    }
    c.execute("DELETE FROM scan_checkpoint", []).unwrap();
    let empty = serde_json::json!({});
    let context = Context {
        preferences: &empty,
        catalog: &empty,
        catalog_revision: 0,
        checkpoint_revision: 0,
        now: 1000,
    };
    assert_eq!(
        current_job(&c, &context, "job", &"a".repeat(64))
            .err()
            .unwrap(),
        "scan-manifest-storage-failed"
    );
    for sql in [CURRENT, TYPEOF] {
        let result: rusqlite::Result<(Option<String>, bool)> =
            c.query_row(sql, [], |r| Ok((r.get(0)?, r.get(1)?)));
        assert!(matches!(result, Err(rusqlite::Error::QueryReturnedNoRows)));
    }
}
#[test]
fn checkpoint_presence_large_payload_native_opcode_and_timing_probe() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("synthetic.sqlite3");
    let c = Connection::open(&path).unwrap();
    c.execute_batch(DDL).unwrap();
    let rows: Vec<_> = (0..65000)
        .map(|i| {
            serde_json::json!([
                i,
                0,
                null,
                format!("Station {i}"),
                0,
                "x".repeat(180),
                "a".repeat(64)
            ])
        })
        .collect();
    let body =
        serde_json::json!({"reviewDigest":"a".repeat(64),"review":{"candidates":rows}}).to_string();
    c.execute(
        "INSERT INTO scan_checkpoint VALUES(1,1,0,'job',?1)",
        [&body],
    )
    .unwrap();
    drop(c);
    let mut measurements = Vec::new();
    for sql in [CURRENT, TYPEOF, WHERE] {
        let c =
            Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        c.execute_batch("PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON;PRAGMA cache_size=-2048;PRAGMA mmap_size=0;").unwrap();
        let mut statement = c.prepare(sql).unwrap();
        let mut samples = Vec::new();
        for _ in 0..16 {
            let t = std::time::Instant::now();
            let mut rows = statement.query([]).unwrap();
            assert!(rows.next().unwrap().is_some());
            assert!(rows.next().unwrap().is_none());
            samples.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(f64::total_cmp);
        let mut explain = c.prepare(&format!("EXPLAIN {sql}")).unwrap();
        let columns: Vec<_> = explain
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(6)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .into_iter()
            .filter(|r| r.0 == "Column")
            .collect();
        measurements.push(serde_json::json!({"sql":sql,"medianMs":samples[8],"minMs":samples[0],"iterations":16,"columnOpcodesP1P2P3P5":columns}));
    }
    println!(
        "NATIVE_PRESENCE_PROBE {}",
        serde_json::json!({"sqlite":rusqlite::version(),"candidateCount":65000,"contentsBytes":body.len(),"measurements":measurements,"scope":"synthetic localfixture, not packagedruntime or hardware acceptance"})
    );
}
