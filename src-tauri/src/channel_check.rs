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

//! Saved-channel checks (owner request, October 19, 2026): the newest result per
//! saved Free TV channel, so GenX can mark a channel that failed on two
//! different days with no success between as not responding. "Two days" is
//! measured as failures at least 20 hours apart, which needs no time zone.
//! Observational only: nothing here removes or hides a channel; the viewer
//! decides (Remove dead channels uses the ordinary, restorable removal).
use super::*;
use rusqlite::{OptionalExtension, Transaction};
const ERR: &str = "channel-check-invalid";
/// Failures this far apart count as two different days.
pub(crate) const NOT_RESPONDING_SPAN_MS: i64 = 20 * 3_600_000;
const TABLE: &str = "CREATE TABLE IF NOT EXISTS channel_check_v1(channel_id TEXT PRIMARY KEY CHECK(length(CAST(channel_id AS BLOB)) BETWEEN 1 AND 16384),checked_ms INTEGER NOT NULL CHECK(checked_ms>=0),ok_ms INTEGER,first_fail_ms INTEGER,last_fail_ms INTEGER,verdict TEXT NOT NULL CHECK(length(verdict) BETWEEN 1 AND 32))";
/// Channel speed (owner design, October 21, 2026): a channel saved by the
/// Slow pass, or slow to start playing, carries the Slow badge. Getting on the
/// list is stricter than losing it: a playback start under FAST_START_MS
/// clears the badge, one over SLOW_START_MS sets it; between, nothing changes.
const SPEED_TABLE: &str = "CREATE TABLE IF NOT EXISTS channel_speed_v1(channel_id TEXT PRIMARY KEY CHECK(length(CAST(channel_id AS BLOB)) BETWEEN 1 AND 16384),slow INTEGER NOT NULL CHECK(slow IN(0,1)),start_ms INTEGER CHECK(start_ms IS NULL OR start_ms>=0),updated_ms INTEGER NOT NULL CHECK(updated_ms>=0))";
pub(crate) const FAST_START_MS: i64 = 3_000;
pub(crate) const SLOW_START_MS: i64 = 5_000;
/// The longest playback start recorded (the controller's startup budget is 20 s,
/// with retries up to two minutes).
const MAX_START_MS: i64 = 120_000;
/// Catalog query predicate over a channel id expression (the table may not exist yet).
pub(crate) fn not_responding_predicate(channel: &str) -> String {
    format!(
        "{channel} IN(SELECT channel_id FROM channel_check_v1 WHERE first_fail_ms IS NOT NULL AND last_fail_ms-first_fail_ms>={NOT_RESPONDING_SPAN_MS})"
    )
}
const RESPONDED: [&str; 2] = ["Reachable", "PlayedHere"];
const FAILED: [&str; 4] = [
    "TimedOut",
    "AccessDenied",
    "UnsupportedHere",
    "TemporaryUnavailable",
];

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Observation {
    pub channel_id: String,
    pub verdict: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Record {
    pub schema_version: u8,
    pub observations: Vec<Observation>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Check {
    pub channel_id: String,
    pub checked_ms: i64,
    pub ok_ms: Option<i64>,
    pub first_fail_ms: Option<i64>,
    pub last_fail_ms: Option<i64>,
    pub verdict: String,
    pub not_responding: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Checks {
    pub schema_version: u8,
    pub now_ms: i64,
    pub checks: Vec<Check>,
    /// Saved channels carrying the Slow badge.
    pub slow_channels: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Recorded {
    pub schema_version: u8,
    pub recorded: usize,
    /// Channels a Slow pass saved, now marked Slow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marked: Option<usize>,
}

pub(crate) fn table_present(c: &Connection) -> Result<bool, String> {
    sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='channel_check_v1')",
        [],
        |r| r.get(0),
    ))
}

pub(crate) fn validate(request: &Record) -> Result<(), String> {
    if request.schema_version != 1
        || request.observations.is_empty()
        || request.observations.len() > 200
        || request.observations.iter().any(|o| {
            o.channel_id.is_empty()
                || o.channel_id.len() > 16384
                || o.channel_id.chars().any(char::is_control)
                || !(RESPONDED.contains(&o.verdict.as_str())
                    || FAILED.contains(&o.verdict.as_str()))
        })
    {
        return Err(ERR.into());
    }
    Ok(())
}

/// Every saved channel's newest check; rows of channels no longer saved are left out.
pub(crate) fn read(c: &Connection, now_ms: i64) -> Result<Checks, String> {
    let mut checks = Vec::new();
    let mut slow_channels = Vec::new();
    let speed_present: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='channel_speed_v1')",
        [],
        |r| r.get(0),
    ))?;
    if speed_present {
        let mut statement = sql(c.prepare(
            "SELECT s.channel_id FROM channel_speed_v1 s WHERE s.slow=1 AND EXISTS(SELECT 1 FROM channel c WHERE c.id=s.channel_id) ORDER BY s.channel_id LIMIT 200000",
        ))?;
        let rows = sql(statement.query_map([], |r| r.get::<_, String>(0)))?;
        for row in rows {
            slow_channels.push(sql(row)?);
        }
    }
    if table_present(c)? {
        let mut statement = sql(c.prepare(
            "SELECT k.channel_id,k.checked_ms,k.ok_ms,k.first_fail_ms,k.last_fail_ms,k.verdict FROM channel_check_v1 k WHERE EXISTS(SELECT 1 FROM channel c WHERE c.id=k.channel_id) ORDER BY k.channel_id LIMIT 200000",
        ))?;
        let mut rows = sql(statement.query([]))?;
        while let Some(row) = sql(rows.next())? {
            let first: Option<i64> = sql(row.get(3))?;
            let last: Option<i64> = sql(row.get(4))?;
            checks.push(Check {
                channel_id: sql(row.get(0))?,
                checked_ms: sql(row.get(1))?,
                ok_ms: sql(row.get(2))?,
                first_fail_ms: first,
                last_fail_ms: last,
                verdict: sql(row.get(5))?,
                not_responding: matches!((first, last), (Some(a), Some(b)) if b - a >= NOT_RESPONDING_SPAN_MS),
            });
        }
    }
    Ok(Checks {
        schema_version: 1,
        now_ms,
        checks,
        slow_channels,
    })
}

/// Records one batch in a single transaction, timed by the native clock. A
/// response clears any failure streak; a failure starts or extends it.
/// Channels no longer saved are skipped, and their old rows are dropped.
pub(crate) fn record(
    tx: &Transaction<'_>,
    request: &Record,
    now_ms: i64,
) -> Result<Recorded, String> {
    validate(request)?;
    sql(tx.execute_batch(TABLE))?;
    let mut recorded = 0;
    for observation in &request.observations {
        let saved: bool = sql(tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM channel WHERE id=?1)",
            [&observation.channel_id],
            |r| r.get(0),
        ))?;
        if !saved {
            continue;
        }
        if RESPONDED.contains(&observation.verdict.as_str()) {
            sql(tx.execute(
                "INSERT INTO channel_check_v1(channel_id,checked_ms,ok_ms,first_fail_ms,last_fail_ms,verdict) VALUES(?1,?2,?2,NULL,NULL,?3) ON CONFLICT(channel_id) DO UPDATE SET checked_ms=?2,ok_ms=?2,first_fail_ms=NULL,last_fail_ms=NULL,verdict=?3",
                params![observation.channel_id, now_ms, observation.verdict],
            ))?;
        } else {
            sql(tx.execute(
                "INSERT INTO channel_check_v1(channel_id,checked_ms,ok_ms,first_fail_ms,last_fail_ms,verdict) VALUES(?1,?2,NULL,?2,?2,?3) ON CONFLICT(channel_id) DO UPDATE SET checked_ms=?2,first_fail_ms=COALESCE(first_fail_ms,?2),last_fail_ms=?2,verdict=?3",
                params![observation.channel_id, now_ms, observation.verdict],
            ))?;
        }
        recorded += 1;
    }
    sql(tx.execute(
        "DELETE FROM channel_check_v1 WHERE channel_id NOT IN(SELECT id FROM channel)",
        [],
    ))?;
    Ok(Recorded {
        schema_version: 1,
        recorded,
        marked: None,
    })
}

/// A saved channel took `start_ms` from selection to its first media progress.
/// Applies the badge rule; returns whether the channel now carries the badge.
pub(crate) fn record_start(
    tx: &Transaction<'_>,
    channel_id: &str,
    start_ms: i64,
    now_ms: i64,
) -> Result<Option<bool>, String> {
    if channel_id.is_empty() || channel_id.len() > 16384 || !(0..=MAX_START_MS).contains(&start_ms)
    {
        return Err(ERR.into());
    }
    sql(tx.execute_batch(SPEED_TABLE))?;
    let saved: bool = sql(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM channel WHERE id=?1)",
        [channel_id],
        |r| r.get(0),
    ))?;
    if !saved {
        return Ok(None);
    }
    let before = is_slow(tx, channel_id)?;
    let decided = if start_ms < FAST_START_MS {
        Some(0)
    } else if start_ms > SLOW_START_MS {
        Some(1)
    } else {
        None
    };
    match decided {
        Some(slow) => {
            sql(tx.execute(
                "INSERT INTO channel_speed_v1(channel_id,slow,start_ms,updated_ms) VALUES(?1,?2,?3,?4) ON CONFLICT(channel_id) DO UPDATE SET slow=?2,start_ms=?3,updated_ms=?4",
                params![channel_id, slow, start_ms, now_ms],
            ))?;
        }
        None => {
            sql(tx.execute(
                "UPDATE channel_speed_v1 SET start_ms=?2,updated_ms=?3 WHERE channel_id=?1",
                params![channel_id, start_ms, now_ms],
            ))?;
        }
    }
    sql(tx.execute(
        "DELETE FROM channel_speed_v1 WHERE channel_id NOT IN(SELECT id FROM channel)",
        [],
    ))?;
    let slow = is_slow(tx, channel_id)?;
    if slow != before {
        list_order_changed(tx)?;
    }
    Ok(Some(slow))
}
fn is_slow(tx: &Transaction<'_>, channel_id: &str) -> Result<bool, String> {
    let slow: Option<i64> = sql(tx
        .query_row(
            "SELECT slow FROM channel_speed_v1 WHERE channel_id=?1",
            [channel_id],
            |r| r.get(0),
        )
        .optional())?;
    Ok(slow == Some(1))
}
/// Slow channels sort after fast ones, so a badge change reorders the list:
/// advance its view revision, and open list cursors are refused, not misread.
fn list_order_changed(tx: &Transaction<'_>) -> Result<(), String> {
    let listed: bool = sql(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_projection_meta')",
        [],
        |r| r.get(0),
    ))?;
    if listed {
        crate::catalog_query::advance_view_revision(tx, true)?;
    }
    Ok(())
}
/// Marks saved channels Slow (channels the Slow pass saved). Unsaved ids are
/// skipped; returns how many were newly marked.
pub(crate) fn mark_slow(
    tx: &Transaction<'_>,
    ids: &[String],
    now_ms: i64,
) -> Result<usize, String> {
    sql(tx.execute_batch(SPEED_TABLE))?;
    let mut marked = 0;
    for id in ids {
        marked += sql(tx.execute(
            "INSERT INTO channel_speed_v1(channel_id,slow,start_ms,updated_ms) SELECT ?1,1,NULL,?2 WHERE EXISTS(SELECT 1 FROM channel WHERE id=?1) ON CONFLICT(channel_id) DO UPDATE SET slow=1,updated_ms=?2 WHERE slow=0",
            params![id, now_ms],
        ))?;
    }
    if marked > 0 {
        list_order_changed(tx)?;
    }
    Ok(marked)
}
/// A scan's checks of saved channels count like quiet checks (owner decision,
/// October 21, 2026): a stream a scan found dead is one bad day, which the
/// quiet check confirms on another day; one that answered clears the streak.
/// Matched by the stream's first address; only checks made since `since_ms`.
/// A triage "slow" result is neither: the Slow pass settles it. After a Slow
/// pass (`slow_pass`), each channel it found answering is marked Slow.
pub(crate) fn record_from_scan(
    tx: &Transaction<'_>,
    since_ms: i64,
    now_ms: i64,
    slow_pass: bool,
) -> Result<Recorded, String> {
    let present: bool = sql(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_snapshot_entry')",
        [],
        |r| r.get(0),
    ))?;
    if !present {
        return Ok(Recorded {
            schema_version: 1,
            recorded: 0,
            marked: slow_pass.then_some(0),
        });
    }
    // CROSS JOIN keeps the entries outside, so SQLite indexes channel_url by
    // address for the lookup; the newest check of each channel wins.
    let mut statement = sql(tx.prepare(
        "SELECT cu.channel_id,e.check_verdict,MAX(e.check_ms) FROM source_snapshot_entry e CROSS JOIN channel_url cu ON cu.ordinal=0 AND cu.url=json_extract(e.channel,'$.urls[0]') WHERE e.available=1 AND e.check_ms>=?1 AND e.check_ms<=?2 AND e.check_verdict IS NOT NULL AND NOT (e.check_verdict='TimedOut' AND json_extract(e.evidence,'$.records[0].evidence.kind') IS 'slow') GROUP BY cu.channel_id",
    ))?;
    let rows = sql(statement.query_map(params![since_ms, now_ms], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    }))?;
    let mut observations = Vec::new();
    for row in rows {
        let (channel_id, verdict) = sql(row)?;
        if (RESPONDED.contains(&verdict.as_str()) || FAILED.contains(&verdict.as_str()))
            && !channel_id.is_empty()
            && channel_id.len() <= 16384
        {
            observations.push(Observation {
                channel_id,
                verdict,
            });
        }
    }
    drop(statement);
    let marked = if slow_pass {
        let answered: Vec<String> = observations
            .iter()
            .filter(|o| RESPONDED.contains(&o.verdict.as_str()))
            .map(|o| o.channel_id.clone())
            .collect();
        Some(mark_slow(tx, &answered, now_ms)?)
    } else {
        None
    };
    let mut recorded = 0;
    for chunk in observations.chunks(200) {
        recorded += record(
            tx,
            &Record {
                schema_version: 1,
                observations: chunk.to_vec(),
            },
            now_ms,
        )?
        .recorded;
    }
    Ok(Recorded {
        schema_version: 1,
        recorded,
        marked,
    })
}

impl PairStore {
    pub(crate) fn record_channel_start(
        &self,
        channel_id: &str,
        start_ms: i64,
        now_ms: i64,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Option<bool>, String> {
        check()?;
        let mut c = connect_background(&self.root.join(DB), false)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let slow = record_start(&tx, channel_id, start_ms, now_ms)?;
        check()?;
        sql(tx.commit())?;
        Ok(slow)
    }
    pub(crate) fn record_scan_channel_checks(
        &self,
        since_ms: i64,
        now_ms: i64,
        slow_pass: bool,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Recorded, String> {
        check()?;
        let mut c = connect_background(&self.root.join(DB), false)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let recorded = record_from_scan(&tx, since_ms, now_ms, slow_pass)?;
        check()?;
        sql(tx.commit())?;
        Ok(recorded)
    }
    pub(crate) fn channel_checks(
        &self,
        now_ms: i64,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Checks, String> {
        check()?;
        let c = connect_background(&self.root.join(DB), true)?;
        read(&c, now_ms)
    }
    pub(crate) fn record_channel_checks(
        &self,
        request: &Record,
        now_ms: i64,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Recorded, String> {
        validate(request)?;
        check()?;
        let mut c = connect_background(&self.root.join(DB), false)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let recorded = record(&tx, request, now_ms)?;
        check()?;
        sql(tx.commit())?;
        Ok(recorded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE channel(id TEXT PRIMARY KEY);INSERT INTO channel VALUES('a'),('b'),('c');").unwrap();
        c
    }
    fn batch(items: &[(&str, &str)]) -> Record {
        Record {
            schema_version: 1,
            observations: items
                .iter()
                .map(|(id, verdict)| Observation {
                    channel_id: (*id).into(),
                    verdict: (*verdict).into(),
                })
                .collect(),
        }
    }
    fn write(c: &mut Connection, items: &[(&str, &str)], now: i64) -> usize {
        let tx = c.transaction().unwrap();
        let recorded = record(&tx, &batch(items), now).unwrap().recorded;
        tx.commit().unwrap();
        recorded
    }
    fn state(c: &Connection, id: &str) -> Option<bool> {
        read(c, 0)
            .unwrap()
            .checks
            .into_iter()
            .find(|k| k.channel_id == id)
            .map(|k| k.not_responding)
    }
    const HOUR: i64 = 3_600_000;
    #[test]
    fn two_failures_on_different_days_mark_a_channel_and_one_success_clears_it() {
        let mut c = db();
        assert!(
            read(&c, 0).unwrap().checks.is_empty(),
            "no table yet: nothing marked"
        );
        write(&mut c, &[("a", "TimedOut"), ("b", "Reachable")], 0);
        assert_eq!(state(&c, "a"), Some(false), "one failure is not enough");
        write(&mut c, &[("a", "AccessDenied")], 5 * HOUR);
        assert_eq!(
            state(&c, "a"),
            Some(false),
            "the same day still counts once"
        );
        write(&mut c, &[("a", "TemporaryUnavailable")], 21 * HOUR);
        assert_eq!(state(&c, "a"), Some(true), "failed on two different days");
        // The query filter sees the same channels.
        let marked: Vec<String> = c
            .prepare(&format!(
                "SELECT id FROM channel WHERE {}",
                not_responding_predicate("id")
            ))
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(marked, vec!["a".to_string()]);
        write(&mut c, &[("a", "Reachable")], 30 * HOUR);
        assert_eq!(state(&c, "a"), Some(false), "a response clears the streak");
        let a = read(&c, 0)
            .unwrap()
            .checks
            .into_iter()
            .find(|k| k.channel_id == "a")
            .unwrap();
        assert_eq!(
            (a.ok_ms, a.first_fail_ms, a.last_fail_ms),
            (Some(30 * HOUR), None, None)
        );
    }
    #[test]
    fn unsaved_channels_and_invalid_batches_are_refused_or_skipped() {
        let mut c = db();
        assert_eq!(
            write(&mut c, &[("gone", "TimedOut"), ("c", "TimedOut")], 0),
            1
        );
        assert!(state(&c, "gone").is_none());
        c.execute("DELETE FROM channel WHERE id='c'", []).unwrap();
        write(&mut c, &[("a", "Reachable")], HOUR);
        let left: i64 = c
            .query_row(
                "SELECT count(*) FROM channel_check_v1 WHERE channel_id='c'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0, "rows of removed channels are dropped");
        for bad in [
            batch(&[]),
            batch(&[("a", "Canceled")]),
            batch(&[("a", "NotChecked")]),
            batch(&[("", "TimedOut")]),
        ] {
            assert!(validate(&bad).is_err());
        }
        let mut wrong = batch(&[("a", "Reachable")]);
        wrong.schema_version = 2;
        assert!(validate(&wrong).is_err());
        let many: Vec<(&str, &str)> = (0..201).map(|_| ("a", "Reachable")).collect();
        assert!(validate(&batch(&many)).is_err());
    }

    /// October 21, 2026: a scan's checks of saved channels count like quiet
    /// checks, matched by first stream address, newest check per channel.
    #[test]
    fn scan_checks_of_saved_channels_count_toward_not_responding() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE channel(id TEXT PRIMARY KEY);
             CREATE TABLE channel_url(channel_id TEXT,ordinal INTEGER,url TEXT);
             CREATE TABLE source_snapshot_entry(source_id TEXT,entry_id TEXT,available INTEGER,check_ms INTEGER,check_verdict TEXT,channel TEXT,evidence TEXT);
             INSERT INTO channel VALUES('dead'),('alive'),('mirror'),('old'),('unscanned'),('triaged');
             INSERT INTO channel_url VALUES('dead',0,'https://a/1'),('alive',0,'https://a/2'),('mirror',0,'https://a/3'),('old',0,'https://a/4'),('unscanned',0,'https://a/5'),('alive',1,'https://a/1'),('triaged',0,'https://a/6');",
        )
        .unwrap();
        let entry =
            |c: &Connection, id: &str, url: &str, at: i64, verdict: &str, available: i64| {
                c.execute(
                    "INSERT INTO source_snapshot_entry VALUES('s',?1,?2,?3,?4,?5,NULL)",
                    params![
                        id,
                        available,
                        at,
                        verdict,
                        format!("{{\"urls\":[\"{url}\"]}}")
                    ],
                )
                .unwrap();
            };
        let now = 100 * HOUR;
        let since = now - 5 * HOUR;
        entry(&c, "e1", "https://a/1", now - HOUR, "TimedOut", 1);
        entry(&c, "e2", "https://a/2", now - HOUR, "Reachable", 1);
        // Two copies of one stream: the newest check counts.
        entry(&c, "e3", "https://a/3", now - 3 * HOUR, "Reachable", 1);
        entry(
            &c,
            "e4",
            "https://a/3",
            now - HOUR,
            "TemporaryUnavailable",
            1,
        );
        // Checked before this scan, or no longer in its source: ignored.
        entry(&c, "e5", "https://a/4", since - HOUR, "TimedOut", 1);
        entry(&c, "e6", "https://a/5", now - HOUR, "TimedOut", 0);
        // A 3-second triage result is for the Slow pass, not a bad day.
        entry(&c, "e7", "https://a/6", now - HOUR, "TimedOut", 1);
        c.execute("UPDATE source_snapshot_entry SET evidence='{\"schemaVersion\":1,\"records\":[{\"evidence\":{\"kind\":\"slow\"}}]}' WHERE entry_id='e7'", []).unwrap();
        let tx = c.transaction().unwrap();
        let recorded = record_from_scan(&tx, since, now, false).unwrap();
        tx.commit().unwrap();
        assert_eq!(recorded.recorded, 3);
        assert!(recorded.marked.is_none());
        let row = |id: &str| {
            read(&c, 0)
                .unwrap()
                .checks
                .into_iter()
                .find(|k| k.channel_id == id)
        };
        assert!(row("dead").is_some_and(|s| s.first_fail_ms == Some(now)));
        assert!(row("alive").is_some_and(|s| s.ok_ms == Some(now) && s.first_fail_ms.is_none()));
        assert!(row("mirror").is_some_and(|s| s.first_fail_ms == Some(now)));
        assert!(row("old").is_none());
        assert!(row("unscanned").is_none());
        assert!(row("triaged").is_none());
        assert!(read(&c, 0).unwrap().slow_channels.is_empty());
        // A Slow pass: what answered is marked Slow, what failed is not.
        c.execute("UPDATE source_snapshot_entry SET check_verdict='Reachable',evidence=NULL,check_ms=?1 WHERE entry_id='e7'", [now]).unwrap();
        let tx = c.transaction().unwrap();
        let recorded = record_from_scan(&tx, now - 10, now, true).unwrap();
        tx.commit().unwrap();
        assert_eq!((recorded.recorded, recorded.marked), (1, Some(1)));
        assert_eq!(
            read(&c, 0).unwrap().slow_channels,
            vec!["triaged".to_string()]
        );
        // Without a snapshot table nothing is recorded.
        let mut empty = db();
        let tx = empty.transaction().unwrap();
        assert_eq!(
            record_from_scan(&tx, since, now, false).unwrap().recorded,
            0
        );
    }

    /// The Slow badge (owner design, October 21, 2026): stricter to lose than
    /// to get. Under 3 s clears it, over 5 s sets it, between changes nothing.
    #[test]
    fn slow_badge_follows_playback_start_with_a_3_and_5_second_rule() {
        let mut c = db();
        let slow = |c: &Connection| read(c, 0).unwrap().slow_channels;
        let start = |c: &mut Connection, id: &str, ms: i64| {
            let tx = c.transaction().unwrap();
            let result = record_start(&tx, id, ms, 1_000).unwrap();
            tx.commit().unwrap();
            result
        };
        // No badge to begin with; a 4 s start changes nothing.
        assert_eq!(start(&mut c, "a", 4_000), Some(false));
        assert!(slow(&c).is_empty());
        // Over 5 s: the badge.
        assert_eq!(start(&mut c, "a", 5_001), Some(true));
        assert_eq!(slow(&c), vec!["a".to_string()]);
        // 3-5 s keeps it; under 3 s clears it.
        assert_eq!(start(&mut c, "a", 3_000), Some(true));
        assert_eq!(start(&mut c, "a", 2_999), Some(false));
        assert!(slow(&c).is_empty());
        // The Slow pass marks channels it saved; unsaved ids are skipped.
        let tx = c.transaction().unwrap();
        assert_eq!(
            mark_slow(&tx, &["b".into(), "nope".into()], 2_000).unwrap(),
            1
        );
        tx.commit().unwrap();
        assert_eq!(slow(&c), vec!["b".to_string()]);
        // Unsaved channels, out-of-range times; removed channels drop out.
        assert_eq!(start(&mut c, "nope", 1_000), None);
        let tx = c.transaction().unwrap();
        assert!(record_start(&tx, "a", -1, 0).is_err());
        assert!(record_start(&tx, "a", 120_001, 0).is_err());
        assert!(record_start(&tx, "", 1_000, 0).is_err());
        drop(tx);
        c.execute("DELETE FROM channel WHERE id='b'", []).unwrap();
        assert!(slow(&c).is_empty());
    }
}
