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

//! Prepared fixture coverage; running these requires the normal native test gate.
use super::*;

#[test]
fn declared_region_priority_matches_shared_order_without_excluding_unknowns() {
    let region = json!({"country":"US","state":"US-IL","origin":"manual"});
    for (channel, rank) in [
        (json!({"geography":{"country":"US","state":"US-IL"}}), 0),
        (json!({"geography":{"country":"US","state":"US-CA"}}), 1),
        (json!({"geography":{"country":"GB"}}), 2),
        (json!({}), 3),
        (json!({"geography":{"state":"US-IL"}}), 3),
    ] {
        assert_eq!(region_priority(&channel, Some(&region)), rank);
        assert_eq!(region_priority(&channel, None), 3);
    }
}

#[test]
fn global_priority_keeps_packed_metadata_and_url_reference_indices_aligned() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE selected(ordinal INTEGER PRIMARY KEY,source_id TEXT,entry_id TEXT,priority INTEGER);
        INSERT INTO selected VALUES(0,'first','foreign',2),(1,'first','unknown',3),(2,'second','local',0),(3,'second','national',1),(4,'third','local-second',0),(5,'third','foreign-second',2);").unwrap();
    let mut candidates = vec![
        (2, "foreign"),
        (3, "unknown"),
        (0, "local"),
        (1, "national"),
        (0, "local-second"),
        (2, "foreign-second"),
    ];
    candidates.sort_by_key(|(priority, _)| *priority);
    let mut statement = c
        .prepare("SELECT ROW_NUMBER() OVER(ORDER BY priority,ordinal)-1,entry_id FROM selected ORDER BY priority,ordinal")
        .unwrap();
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .unwrap();
    let observed = rows.collect::<Result<Vec<_>, _>>().unwrap();
    assert_eq!(observed.len(), candidates.len());
    for (index, ((ordinal, entry), (_, candidate))) in observed.iter().zip(&candidates).enumerate()
    {
        assert_eq!(*ordinal, i64::try_from(index).unwrap());
        assert_eq!(entry.as_str(), *candidate);
    }
    assert_eq!(
        candidates
            .into_iter()
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>(),
        vec![
            "local",
            "local-second",
            "national",
            "foreign",
            "foreign-second",
            "unknown"
        ]
    );
}

#[test]
fn relevance_tier_orders_exact_prefix_word_alias_and_other_matches() {
    assert_eq!(relevance_tier("ESPN", "espn", false), 0);
    assert_eq!(relevance_tier("espn", "ESPN 2 Latin America", false), 1);
    assert_eq!(
        relevance_tier("latin espn", "ESPN 2 Latin America", false),
        2
    );
    assert_eq!(relevance_tier("lionsgate", "MovieSphere", true), 2);
    assert_eq!(relevance_tier("spn", "ESPN", false), 3);
    assert_eq!(relevance_tier("  ", "Anything", true), 3);
}

#[test]
fn combined_priority_keeps_region_order_when_there_is_no_query_or_hint() {
    // Empty query: every tier is 3, so only the established region rank orders.
    let base: Vec<u8> = (0..4)
        .map(|region| activation_priority(relevance_tier("", "x", false), region, false))
        .collect();
    assert!(base.windows(2).all(|w| w[0] < w[1]));
    // Relevance outranks region; demoted channels follow every undemoted tier.
    assert!(activation_priority(0, 3, false) < activation_priority(1, 0, false));
    assert!(activation_priority(3, 3, false) < activation_priority(0, 0, true));
}

#[test]
fn activation_hints_are_bounded_suffix_free_and_require_a_query() {
    let base = Request {
        schema_version: 1,
        sources: vec![SourceRevision {
            source_id: "s".into(),
            source_revision: "1".into(),
        }],
        query: "fox".into(),
        preferred_region: None,
        budget_ms: 20000,
        mode: Mode::Refresh,
        expected_catalog_revision: "1".into(),
        expected_checkpoint_revision: "0".into(),
        alias_provider_ids: vec!["FoxNews.us".into()],
        demoted_provider_ids: vec!["Closed.us".into()],
    };
    assert!(validate_request(&base).is_ok());
    for bad in [
        Request {
            alias_provider_ids: vec!["FoxNews.us@SD".into()],
            ..base.clone()
        },
        Request {
            alias_provider_ids: vec![String::new()],
            ..base.clone()
        },
        Request {
            demoted_provider_ids: vec!["bad\nid".into()],
            ..base.clone()
        },
        Request {
            alias_provider_ids: vec!["x".into(); ALIAS_HINT_LIMIT + 1],
            ..base.clone()
        },
        Request {
            demoted_provider_ids: vec!["x".into(); DEMOTED_HINT_LIMIT + 1],
            ..base.clone()
        },
        Request {
            query: " ".into(),
            ..base.clone()
        },
    ] {
        assert!(validate_request(&bad).is_err());
    }
    // Hints are optional: the original request shape still deserializes and validates.
    let legacy: Request = serde_json::from_value(json!({
        "schemaVersion":1,"sources":[{"sourceId":"s","sourceRevision":"1"}],"query":"",
        "preferredRegion":null,"budgetMs":20000,"mode":"refresh",
        "expectedCatalogRevision":"1","expectedCheckpointRevision":"0"
    }))
    .unwrap();
    assert!(legacy.alias_provider_ids.is_empty() && validate_request(&legacy).is_ok());
    assert!(serde_json::to_value(&legacy)
        .unwrap()
        .get("aliasProviderIds")
        .is_none());
}

#[test]
fn reordered_candidates_renumber_categories_in_first_use_order() {
    let categories = vec![json!("News"), json!("Sports"), json!("Movies")];
    // After relevance ordering, Sports (1) is used first, then News (0), then Movies (2).
    let mut candidates = vec![
        json!(["k1", 0, [], "A", 1]),
        json!(["k2", 0, [], "B", 0]),
        json!(["k3", 1, [], "C", 1]),
        json!(["k4", 1, [], "D", 2]),
    ];
    let ordered = renumber_categories(&mut candidates, &categories).unwrap();
    assert_eq!(
        ordered,
        vec![json!("Sports"), json!("News"), json!("Movies")]
    );
    let indices: Vec<u64> = candidates.iter().map(|c| c[4].as_u64().unwrap()).collect();
    assert_eq!(indices, vec![0, 1, 0, 2]);
    // Every candidate still names its original category text.
    for (candidate, original) in candidates
        .iter()
        .zip(["Sports", "News", "Sports", "Movies"])
    {
        assert_eq!(
            ordered[candidate[4].as_u64().unwrap() as usize],
            json!(original)
        );
    }
    // First-use order, as the packed checkpoint validator requires.
    let mut seen = Vec::new();
    for index in indices {
        if !seen.contains(&index) {
            assert_eq!(index as usize, seen.len());
            seen.push(index);
        }
    }
    // An out-of-range index or an unused category refuses instead of guessing.
    let mut bad = vec![json!(["k", 0, [], "X", 9])];
    assert!(renumber_categories(&mut bad, &categories).is_err());
    let mut partial = vec![json!(["k", 0, [], "X", 0])];
    assert!(renumber_categories(&mut partial, &categories).is_err());
}

#[test]
fn current_checks_seed_stream_identity_so_mirrored_copies_are_not_rechecked() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE source_snapshot_entry(source_id TEXT,entry_id TEXT,ordinal INTEGER,content_hash TEXT,address_hash TEXT,available INTEGER,check_ms INTEGER,check_verdict TEXT,check_permission TEXT,check_address TEXT,checked_content_hash TEXT,evidence TEXT);").unwrap();
    let now = 10 * POSITIVE_TTL;
    let insert = |entry: &str,
                  address: &str,
                  available: i64,
                  verdict: Option<&str>,
                  at: u64,
                  grant: &str| {
        c.execute(
            "INSERT INTO source_snapshot_entry VALUES('s',?1,?2,'c',?3,?4,?5,?6,?7,?3,'c',NULL)",
            params![
                entry,
                entry.len() as i64,
                address,
                available,
                verdict.map(|_| at as i64),
                verdict,
                grant
            ],
        )
        .unwrap();
    };
    insert("fresh", "a-fresh", 1, Some("Reachable"), now - 1000, "g");
    insert(
        "failed",
        "a-failed",
        1,
        Some("Unreachable"),
        now - 1000,
        "g",
    );
    insert(
        "expired",
        "a-expired",
        1,
        Some("Reachable"),
        now - POSITIVE_TTL - 1,
        "g",
    );
    insert("never", "a-never", 1, None, 0, "g");
    insert(
        "other-grant",
        "a-other",
        1,
        Some("Reachable"),
        now - 1000,
        "other",
    );
    insert(
        "removed",
        "a-removed",
        0,
        Some("Reachable"),
        now - 1000,
        "g",
    );
    let mut seeded = checked_streams(&c, "s", &g3(), now).unwrap();
    seeded.sort();
    assert_eq!(seeded, vec!["a-failed", "a-fresh"]);
    assert!(checked_streams(&c, "missing", &g3(), now)
        .unwrap()
        .is_empty());
}

/// Refresh trusts failures by kind (owner decision, October 21, 2026): a
/// definite answer from the server for a week, no answer for a day.
#[test]
fn refresh_trusts_definite_failures_for_a_week_and_no_answer_for_a_day() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE source_snapshot_entry(source_id TEXT,entry_id TEXT,ordinal INTEGER,content_hash TEXT,address_hash TEXT,available INTEGER,check_ms INTEGER,check_verdict TEXT,check_permission TEXT,check_address TEXT,checked_content_hash TEXT,evidence TEXT);").unwrap();
    let now = 10 * POSITIVE_TTL;
    let day = NO_ANSWER_TTL;
    let mut ordinal = 0i64;
    let mut insert = |entry: &str, verdict: &str, evidence: Option<serde_json::Value>, age: u64| {
        ordinal += 1;
        let record = evidence.map(|e| {
            json!({"schemaVersion":1,"records":[{"verdict":verdict,"evidence":e}]}).to_string()
        });
        c.execute(
            "INSERT INTO source_snapshot_entry VALUES('s',?1,?2,'c',?1,1,?3,?4,'g',?1,'c',?5)",
            params![entry, ordinal, (now - age) as i64, verdict, record],
        )
        .unwrap();
    };
    let http = |status: u16| Some(json!({"kind":"http","status":status}));
    // Definite answers, two days old: still trusted (not due).
    insert("gone-404", "TemporaryUnavailable", http(404), 2 * day);
    insert("gone-410", "TemporaryUnavailable", http(410), 2 * day);
    insert("denied", "AccessDenied", http(403), 2 * day);
    insert(
        "unsupported",
        "UnsupportedHere",
        Some(json!({"kind":"unsupported"})),
        2 * day,
    );
    // No answer, two days old: due again.
    insert(
        "timeout",
        "TimedOut",
        Some(json!({"kind":"timeout"})),
        2 * day,
    );
    insert(
        "network",
        "TemporaryUnavailable",
        Some(json!({"kind":"network-failure"})),
        2 * day,
    );
    insert("busy-429", "TemporaryUnavailable", http(429), 2 * day);
    insert("server-503", "TemporaryUnavailable", http(503), 2 * day);
    insert("no-evidence", "TemporaryUnavailable", None, 2 * day);
    // No answer within the day: not yet due.
    insert(
        "timeout-recent",
        "TimedOut",
        Some(json!({"kind":"timeout"})),
        day / 2,
    );
    // A definite answer older than a week: due again.
    insert(
        "gone-old",
        "TemporaryUnavailable",
        http(404),
        DEFINITE_FAILURE_TTL + 1000,
    );
    let mut current = checked_streams(&c, "s", &g3(), now).unwrap();
    current.sort();
    assert_eq!(
        current,
        vec![
            "denied",
            "gone-404",
            "gone-410",
            "timeout-recent",
            "unsupported"
        ]
    );
}

fn g3() -> [String; 3] {
    ["g".to_owned(), "g45".to_owned(), "g60".to_owned()]
}

/// The Slow list (owner design, October 21, 2026): the Slow pass selects only
/// streams whose newest check is a 3-second triage "slow" result under the
/// triage grant, no older than the no-answer window. A check made with a
/// longer time limit counts as current for an ordinary Refresh.
#[test]
fn slow_pass_selects_triage_slow_streams_and_longer_checks_stay_current() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE source_snapshot_entry(source_id TEXT,entry_id TEXT,ordinal INTEGER,content_hash TEXT,address_hash TEXT,available INTEGER,check_ms INTEGER,check_verdict TEXT,check_permission TEXT,check_address TEXT,checked_content_hash TEXT,evidence TEXT);").unwrap();
    let now = 10 * POSITIVE_TTL;
    let day = NO_ANSWER_TTL;
    let mut ordinal = 0i64;
    let mut insert = |entry: &str, verdict: &str, kind: &str, age: u64, grant: &str| {
        ordinal += 1;
        let record =
            json!({"schemaVersion":1,"records":[{"verdict":verdict,"evidence":{"kind":kind}}]})
                .to_string();
        c.execute(
            "INSERT INTO source_snapshot_entry VALUES('s',?1,?2,'c',?1,1,?3,?4,?5,?1,'c',?6)",
            params![entry, ordinal, (now - age) as i64, verdict, grant, record],
        )
        .unwrap();
    };
    insert("slow", "TimedOut", "slow", 1000, "g");
    insert("slow-old", "TimedOut", "slow", day + 1000, "g");
    insert("timeout", "TimedOut", "timeout", 1000, "g");
    insert("slow-other-grant", "TimedOut", "slow", 1000, "other");
    insert("fast", "Reachable", "recognized-media-response", 1000, "g");
    // Checked by a Slow pass (45-second grant): current for a 20-second Refresh.
    insert(
        "saved-slow",
        "Reachable",
        "recognized-media-response",
        1000,
        "g45",
    );
    insert("no-answer-slow", "TimedOut", "timeout", 1000, "g45");
    let mut statement = c
        .prepare(&format!(
            "SELECT entry_id FROM source_snapshot_entry WHERE source_id=?1 AND ordinal>?2 AND {SLOW_LISTED} ORDER BY ordinal"
        ))
        .unwrap();
    let selected: Vec<String> = statement
        .query_map(
            params![
                "s",
                -1i64,
                false,
                now as i64,
                "g",
                now.saturating_sub(POSITIVE_TTL) as i64,
                now.saturating_sub(DEFINITE_FAILURE_TTL) as i64,
                now.saturating_sub(NO_ANSWER_TTL) as i64,
                "g",
                "g"
            ],
            |r| r.get(0),
        )
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(selected, vec!["slow"]);
    let mut current = checked_streams(&c, "s", &g3(), now).unwrap();
    current.sort();
    assert_eq!(
        current,
        vec!["fast", "no-answer-slow", "saved-slow", "slow", "timeout"]
    );
}
