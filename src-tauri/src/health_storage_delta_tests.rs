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

fn database() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(
        "CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,health_present INTEGER NOT NULL);
         INSERT INTO metadata VALUES(1,0);
         CREATE TABLE channel_health(channel_id TEXT NOT NULL,url_ordinal INTEGER NOT NULL,
         platform TEXT NOT NULL,observer_profile TEXT NOT NULL,source_id TEXT NOT NULL,
         target_fingerprint TEXT NOT NULL,observed_at INTEGER NOT NULL,verdict TEXT NOT NULL,
         origin TEXT NOT NULL,evidence_json TEXT NOT NULL,
         PRIMARY KEY(channel_id,url_ordinal,platform,observer_profile));
         CREATE TABLE audit(kind TEXT NOT NULL);
         CREATE TRIGGER health_insert AFTER INSERT ON channel_health BEGIN INSERT INTO audit VALUES('insert'); END;
         CREATE TRIGGER health_update AFTER UPDATE ON channel_health BEGIN INSERT INTO audit VALUES('update'); END;
         CREATE TRIGGER health_delete AFTER DELETE ON channel_health BEGIN INSERT INTO audit VALUES('delete'); END;
         CREATE TRIGGER health_presence AFTER UPDATE ON metadata BEGIN INSERT INTO audit VALUES('presence'); END;",
    )
    .unwrap();
    c
}

fn record(index: usize) -> Record {
    Record {
        schema_version: 1,
        channel_id: format!("channel-{index:06}"),
        source_id: "source".into(),
        checked_url_ordinal: 0,
        target_fingerprint: "a".repeat(64),
        platform: "android".into(),
        observer_profile: "fixture".into(),
        observed_at: 100,
        verdict: "Reachable".into(),
        evidence: json!({"kind":"http","status":200,"contentRecognized":true}),
        origin: "local".into(),
    }
}

fn counts(c: &Connection) -> [i64; 4] {
    ["insert", "update", "delete", "presence"].map(|kind| {
        c.query_row("SELECT count(*) FROM audit WHERE kind=?1", [kind], |r| {
            r.get(0)
        })
        .unwrap()
    })
}

fn clear_audit(c: &Connection) {
    c.execute("DELETE FROM audit", []).unwrap();
}

#[test]
fn adding_64_to_2000_only_inserts_new_rows_and_replay_has_zero_dml() {
    let c = database();
    let mut records: Vec<_> = (0..2000).map(record).collect();
    replace(&c, Some(&encode(&records).unwrap())).unwrap();
    clear_audit(&c);
    records.extend((2000..2064).map(record));
    let payload = encode(&records).unwrap();
    replace(&c, Some(&payload)).unwrap();
    assert_eq!(counts(&c), [64, 0, 0, 0]);
    assert_eq!(read(&c).unwrap(), Some(payload.clone()));
    clear_audit(&c);
    replace(&c, Some(&payload)).unwrap();
    assert_eq!(counts(&c), [0, 0, 0, 0]);
}

#[test]
fn changes_and_removals_touch_only_their_exact_context_identity() {
    let c = database();
    let mut records: Vec<_> = (0..4).map(record).collect();
    let mut other_context = records[0].clone();
    other_context.observer_profile = "other-profile".into();
    records.push(other_context.clone());
    replace(&c, Some(&encode(&records).unwrap())).unwrap();
    clear_audit(&c);
    records[0].observed_at += 1;
    records[0].origin = "imported".into();
    records[0].evidence = json!({"kind":"timeout"});
    records[0].verdict = "TimedOut".into();
    records.remove(1);
    records.push(record(4));
    replace(&c, Some(&encode(&records).unwrap())).unwrap();
    assert_eq!(counts(&c), [1, 1, 1, 0]);
    let actual = parse(&read(&c).unwrap().unwrap()).unwrap();
    assert_eq!(actual.len(), records.len());
    for expected in records {
        assert!(actual.contains(&expected));
    }
    assert!(actual.contains(&other_context));
}

#[test]
fn none_and_present_empty_remain_distinct_without_redundant_writes() {
    let c = database();
    replace(&c, None).unwrap();
    assert_eq!(counts(&c), [0, 0, 0, 0]);
    let empty = encode(&[]).unwrap();
    replace(&c, Some(&empty)).unwrap();
    assert_eq!(counts(&c), [0, 0, 0, 1]);
    assert_eq!(read(&c).unwrap(), Some(empty.clone()));
    clear_audit(&c);
    replace(&c, Some(&empty)).unwrap();
    assert_eq!(counts(&c), [0, 0, 0, 0]);
    replace(&c, None).unwrap();
    assert_eq!(counts(&c), [0, 0, 0, 1]);
    assert_eq!(read(&c).unwrap(), None);
}

#[test]
fn caller_rollback_restores_deleted_updated_and_inserted_rows() {
    let c = database();
    let original = encode(&[record(0), record(1)]).unwrap();
    replace(&c, Some(&original)).unwrap();
    clear_audit(&c);
    let mut changed = record(0);
    changed.observed_at += 1;
    c.execute_batch("BEGIN IMMEDIATE").unwrap();
    replace(&c, Some(&encode(&[changed, record(2)]).unwrap())).unwrap();
    assert_eq!(counts(&c), [1, 1, 1, 0]);
    c.execute_batch("ROLLBACK").unwrap();
    assert_eq!(read(&c).unwrap(), Some(original));
    assert_eq!(counts(&c), [0, 0, 0, 0]);
}

#[test]
fn sql_failure_preserves_static_category_and_caller_can_rollback() {
    let c = database();
    let original = encode(&[record(0), record(1)]).unwrap();
    replace(&c, Some(&original)).unwrap();
    clear_audit(&c);
    c.execute_batch("CREATE TRIGGER refuse_new BEFORE INSERT ON channel_health WHEN NEW.channel_id='channel-000002' BEGIN SELECT RAISE(ABORT,'fixture'); END; BEGIN IMMEDIATE").unwrap();
    let mut changed = record(0);
    changed.observed_at += 1;
    assert_eq!(
        replace(&c, Some(&encode(&[changed, record(2)]).unwrap())).unwrap_err(),
        "health-sqlite-failed"
    );
    c.execute_batch("ROLLBACK").unwrap();
    assert_eq!(read(&c).unwrap(), Some(original));
    assert_eq!(counts(&c), [0, 0, 0, 0]);
}

#[test]
fn invalid_new_payload_has_no_dml_and_hidden_invalid_evidence_can_be_removed() {
    let c = database();
    let original = encode(&[record(0)]).unwrap();
    replace(&c, Some(&original)).unwrap();
    clear_audit(&c);
    assert!(replace(&c, Some("{} ")).is_err());
    assert_eq!(counts(&c), [0, 0, 0, 0]);
    assert_eq!(read(&c).unwrap(), Some(original));
    c.execute(
        "UPDATE channel_health SET evidence_json='invalid',url_ordinal='invalid'",
        [],
    )
    .unwrap();
    c.execute("UPDATE metadata SET health_present=0", [])
        .unwrap();
    clear_audit(&c);
    replace(&c, None).unwrap();
    assert_eq!(counts(&c), [0, 0, 1, 0]);
    assert_eq!(
        c.query_row("SELECT count(*) FROM channel_health", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(read(&c).unwrap(), None);
}

#[test]
fn target_invalidation_deletes_only_obsolete_health() {
    let c = database();
    let source = json!({"id":"source","kind":"url","location":"https://example.invalid/list.m3u","allowHttp":false});
    let channels: Vec<_> = (0..2)
        .map(|i| json!({"id":record(i).channel_id,"sourceId":"source","urls":[format!("https://example.invalid/{i}.m3u8")]}))
        .collect();
    let mut records: Vec<_> = (0..2).map(record).collect();
    for (r, channel) in records.iter_mut().zip(&channels) {
        r.target_fingerprint = fingerprint(&source, channel, 0).unwrap();
    }
    let original = encode(&records).unwrap();
    replace(&c, Some(&original)).unwrap();
    clear_audit(&c);
    let mut changed = channels;
    changed[0]["urls"] = json!(["https://example.invalid/replacement.m3u8"]);
    let catalog = json!({"sources":[source],"channels":changed});
    let next = reconcile(Some(&original), None, Some(&catalog))
        .unwrap()
        .unwrap();
    replace(&c, Some(&next)).unwrap();
    assert_eq!(counts(&c), [0, 0, 1, 0]);
    assert_eq!(
        parse(&read(&c).unwrap().unwrap()).unwrap(),
        vec![records[1].clone()]
    );
}
