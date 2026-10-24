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
use std::sync::atomic::{AtomicBool, Ordering};
#[test]
fn sequential_cache_publication_reports_preserved_conflict_without_changing_mapping_or_schedule() {
    let mut c = fixture();
    let first = cache(&c, "a");
    c.execute("INSERT INTO guide_program(guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,description,search_text) VALUES('a',0,'exact',1000,2000,'Retained schedule',NULL,'retained schedule')", []).unwrap();
    channel(&c, "mapped", "catalog", "exact");
    let initial = connect(&mut c, "7", std::slice::from_ref(&first), &[], &|| false).unwrap();
    assert_eq!(initial.matched, 1);
    assert_eq!(initial.preserved_mapping_conflicts, Some(0));
    let second = cache(&c, "b");
    let before = mappings(&c);
    let revision: i64 = c
        .query_row(
            "SELECT revision FROM guide_meta WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let result = connect(&mut c, "7", &[first, second], &[], &|| false).unwrap();
    assert_eq!(
        (result.matched, result.ambiguous, result.preserved_mappings),
        (0, 0, 1)
    );
    assert_eq!(result.mapping_conflict_assessment, "complete");
    assert_eq!(result.preserved_mapping_conflicts, Some(1));
    assert_eq!(mappings(&c), before);
    assert_eq!(
        c.query_row(
            "SELECT start_ms,stop_ms,title FROM guide_program WHERE guide_source_id='a'",
            [],
            |r| Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?
            ))
        )
        .unwrap(),
        (1000, 2000, "Retained schedule".into())
    );
    assert_eq!(
        c.query_row(
            "SELECT revision FROM guide_meta WHERE singleton=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        revision
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM guide_channel", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}
#[test]
fn optional_assessment_limit_returns_unknown_and_preserves_unmapped_ambiguity() {
    let mut c = fixture();
    let sources: Vec<_> = (0..1000)
        .map(|i| cache(&c, &format!("guide-{i}")))
        .collect();
    for i in 0..1001 {
        let id = format!("mapped-{i}");
        channel(&c, &id, "catalog", "not-an-exact-match");
        c.execute(
            "INSERT INTO guide_mapping VALUES('catalog',?1,'guide-0','exact')",
            [&id],
        )
        .unwrap();
    }
    channel(&c, "unmapped", "catalog", "exact");
    let before = mappings(&c);
    let result = connect(&mut c, "7", &sources, &[], &|| false).unwrap();
    assert_eq!(result.mapping_conflict_assessment, "not-assessed");
    assert_eq!(result.preserved_mapping_conflicts, None);
    assert_eq!(
        (result.matched, result.unmatched, result.ambiguous),
        (0, 1, 1)
    );
    assert_eq!(mappings(&c), before);
}
#[test]
fn large_guide_scope_preserves_cross_feed_ambiguity_and_refuses_1001_atomically() {
    for count in [101, 1000] {
        let mut c = fixture();
        let sources: Vec<_> = (0..count)
            .map(|i| cache(&c, &format!("guide-{i}")))
            .collect();
        channel(&c, "new", "catalog", "exact");
        let result = connect(&mut c, "7", &sources, &[], &|| false).unwrap();
        assert_eq!(
            (result.checked_sources, result.matched, result.ambiguous),
            (count, 0, 1)
        );
        assert!(mappings(&c).is_empty());
        if count == 1000 {
            let mut over = sources.clone();
            over.push(sources[0].clone());
            assert_eq!(
                connect(&mut c, "7", &over, &[], &|| false).unwrap_err(),
                "guide-cache-match-limit"
            );
            assert!(mappings(&c).is_empty());
        }
    }
}
#[test]
fn native_guide_source_capacity_allows_1000_and_both_creation_paths_refuse_1001() {
    use super::super::database as db;
    let mut c = fixture();
    for i in 0..1000 {
        let source = db::GuideSource {
            id: format!("g-{i}"),
            name: "Guide".into(),
            location: format!("https://fixture.invalid/{i}.xml"),
            kind: "url".into(),
            allow_http: false,
            revision: 0,
            updated_ms: None,
        };
        db::save_source(&mut c, &source, 0).unwrap();
    }
    assert_eq!(db::list_sources(&c).unwrap().len(), 1000);
    let source = db::GuideSource {
        id: "extra".into(),
        name: "Guide".into(),
        location: "https://fixture.invalid/extra.xml".into(),
        kind: "url".into(),
        allow_http: false,
        revision: 0,
        updated_ms: None,
    };
    assert_eq!(
        db::save_source(&mut c, &source, 0).unwrap_err(),
        "guide-source-limit"
    );
    let parsed = super::super::parser::parse_guide(
        br#"<tv><channel id="exact"><display-name>Fixture</display-name></channel></tv>"#,
    )
    .unwrap();
    assert_eq!(
        db::publish_source(&mut c, &source, 0, &parsed, 1000, &AtomicBool::new(false)).unwrap_err(),
        "guide-source-limit"
    );
    assert_eq!(db::list_sources(&c).unwrap().len(), 1000);
}
fn fixture() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON; PRAGMA user_version=1; CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,catalog_revision INTEGER); INSERT INTO metadata VALUES(1,7); CREATE TABLE channel(id TEXT PRIMARY KEY,source_id TEXT,provider_id TEXT); CREATE TABLE removed(id TEXT PRIMARY KEY);").unwrap();
    super::super::database::migrate(&mut c).unwrap();
    c.execute_batch("PRAGMA user_version=3").unwrap();
    super::super::database::migrate_suggestions(&mut c).unwrap();
    c
}
fn cache(c: &Connection, id: &str) -> CachedSource {
    let location = format!("https://fixture.invalid/{id}.xml");
    c.execute(
        "INSERT INTO guide_source VALUES(?1,?1,?2,'url',0,2,1000,2)",
        params![id, location],
    )
    .unwrap();
    c.execute(
        "INSERT INTO guide_channel VALUES(?1,'exact','[]','exact')",
        [id],
    )
    .unwrap();
    CachedSource {
        id: id.into(),
        location,
        expected_source_revision: 2,
        expected_published_revision: 2,
    }
}
fn channel(c: &Connection, id: &str, source: &str, provider: &str) {
    c.execute(
        "INSERT INTO channel VALUES(?1,?2,?3)",
        params![id, source, provider],
    )
    .unwrap();
}
fn mappings(c: &Connection) -> Vec<(String, String, String, String)> {
    c.prepare("SELECT * FROM guide_mapping ORDER BY app_channel_id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn readonly_preflight_preserves_crossfeed_ambiguity_and_then_detects_actual_change() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("guide.sqlite3");
    let source = fixture();
    let a = cache(&source, "a");
    let b = cache(&source, "b");
    channel(&source, "ambiguous", "catalog", "exact");
    channel(&source, "removed", "catalog", "exact");
    source
        .execute("INSERT INTO removed VALUES('removed')", [])
        .unwrap();
    let mut target = Connection::open(&path).unwrap();
    rusqlite::backup::Backup::new(&source, &mut target)
        .unwrap()
        .run_to_completion(100, std::time::Duration::from_millis(1), None)
        .unwrap();
    drop(target);
    let read =
        Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    read.execute_batch("PRAGMA query_only=ON").unwrap();
    let before = std::fs::read(&path).unwrap();
    let receipt = preflight_connection(
        &read,
        ConnectionRequest {
            expected_catalog_revision: "7",
            sources: &[a.clone(), b.clone()],
            aliases: &[],
            authority: None,
            outcome: Outcome::not_requested(),
            automatic: false,
        },
        &|| false,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        (receipt.matched, receipt.unmatched, receipt.ambiguous),
        (0, 1, 1)
    );
    assert_eq!(receipt.checked_sources, 2);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(preflight_connection(
        &read,
        ConnectionRequest {
            expected_catalog_revision: "7",
            sources: &[a],
            aliases: &[],
            authority: None,
            outcome: Outcome::not_requested(),
            automatic: false
        },
        &|| false
    )
    .unwrap()
    .is_none());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        preflight_connection(
            &read,
            ConnectionRequest {
                expected_catalog_revision: "6",
                sources: std::slice::from_ref(&b),
                aliases: &[],
                authority: None,
                outcome: Outcome::not_requested(),
                automatic: false
            },
            &|| false
        )
        .unwrap_err(),
        "catalog-revision-stale"
    );
    let mut stale = b;
    stale.expected_published_revision = 1;
    assert_eq!(
        preflight_connection(
            &read,
            ConnectionRequest {
                expected_catalog_revision: "7",
                sources: &[stale],
                aliases: &[],
                authority: None,
                outcome: Outcome::not_requested(),
                automatic: false
            },
            &|| false
        )
        .unwrap_err(),
        "guide-stale-revision"
    );
    assert!(read.is_autocommit());
}

#[test]
fn readonly_preflight_retains_existing_choices_and_current_automatic_permission() {
    let c = fixture();
    c.execute_batch(
        "ALTER TABLE metadata ADD COLUMN automatic_guide_updates INTEGER NOT NULL DEFAULT 1;",
    )
    .unwrap();
    let a = cache(&c, "a");
    let b = cache(&c, "b");
    channel(&c, "mapped", "catalog", "exact");
    c.execute(
        "INSERT INTO guide_mapping VALUES('catalog','mapped','a','exact')",
        [],
    )
    .unwrap();
    let receipt = preflight_connection(
        &c,
        ConnectionRequest {
            expected_catalog_revision: "7",
            sources: &[a.clone(), b],
            aliases: &[],
            authority: None,
            outcome: Outcome::not_requested(),
            automatic: true,
        },
        &|| false,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        (
            receipt.matched,
            receipt.preserved_mappings,
            receipt.preserved_mapping_conflicts
        ),
        (0, 1, Some(1))
    );
    c.execute("UPDATE metadata SET automatic_guide_updates=0", [])
        .unwrap();
    assert_eq!(
        preflight_connection(
            &c,
            ConnectionRequest {
                expected_catalog_revision: "7",
                sources: std::slice::from_ref(&a),
                aliases: &[],
                authority: None,
                outcome: Outcome::not_requested(),
                automatic: true
            },
            &|| false
        )
        .unwrap_err(),
        "guide-refresh-disabled"
    );
    assert!(preflight_connection(
        &c,
        ConnectionRequest {
            expected_catalog_revision: "7",
            sources: std::slice::from_ref(&a),
            aliases: &[],
            authority: None,
            outcome: Outcome::not_requested(),
            automatic: false
        },
        &|| false
    )
    .unwrap()
    .is_some());
    assert_eq!(
        preflight_connection(
            &c,
            ConnectionRequest {
                expected_catalog_revision: "7",
                sources: &[a],
                aliases: &[],
                authority: None,
                outcome: Outcome::not_requested(),
                automatic: false
            },
            &|| true
        )
        .unwrap_err(),
        "guide-cancelled"
    );
    assert_eq!(mappings(&c).len(), 1);
}
#[test]
fn adds_new_channels_from_distinct_catalog_sources_without_replacing_cache_or_existing_mapping() {
    let mut c = fixture();
    let source = cache(&c, "guide");
    channel(&c, "first", "catalog-a", "exact");
    let first = connect(&mut c, "7", std::slice::from_ref(&source), &[], &|| false).unwrap();
    assert_eq!((first.matched, first.unmatched), (1, 0));
    channel(&c, "new", "catalog-b", "exact");
    channel(&c, "unknown", "catalog-b", "EXACT");
    c.execute("UPDATE metadata SET catalog_revision=8", [])
        .unwrap();
    let result = connect(&mut c, "8", &[source], &[], &|| false).unwrap();
    assert_eq!(
        (result.matched, result.unmatched, result.preserved_mappings),
        (1, 1, 1)
    );
    assert_eq!(result.catalog_revision, "8");
    assert_eq!(mappings(&c).len(), 2);
    assert_eq!(
        c.query_row("SELECT revision FROM guide_source", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    let repeated = connect(&mut c, "8", &[], &[], &|| false).unwrap();
    assert_eq!(repeated.matched, 0);
}
#[test]
fn stale_catalog_refuses_all_writes() {
    let mut c = fixture();
    let source = cache(&c, "guide");
    channel(&c, "new", "catalog", "exact");
    assert_eq!(
        connect(&mut c, "6", &[source], &[], &|| false).unwrap_err(),
        "catalog-revision-stale"
    );
    assert!(mappings(&c).is_empty());
}
#[test]
fn excludes_removed_and_preserves_every_existing_mapping_even_unavailable_target() {
    let mut c = fixture();
    let source = cache(&c, "guide");
    channel(&c, "removed", "catalog", "exact");
    channel(&c, "existing", "catalog", "exact");
    c.execute("INSERT INTO removed VALUES('removed')", [])
        .unwrap();
    c.execute(
        "INSERT INTO guide_mapping VALUES('catalog','existing','missing','old-target')",
        [],
    )
    .unwrap();
    let before = mappings(&c);
    let result = connect(&mut c, "7", &[source], &[], &|| false).unwrap();
    assert_eq!(
        (result.matched, result.unmatched, result.preserved_mappings),
        (0, 0, 1)
    );
    assert_eq!(mappings(&c), before);
}
#[test]
fn duplicate_exact_ids_across_allowed_feeds_are_ambiguous_not_arbitrarily_selected() {
    let mut c = fixture();
    let first = cache(&c, "a");
    let second = cache(&c, "b");
    channel(&c, "new", "catalog", "exact");
    let result = connect(&mut c, "7", &[first.clone(), second], &[], &|| false).unwrap();
    assert_eq!(
        (result.matched, result.unmatched, result.ambiguous),
        (0, 1, 1)
    );
    assert!(mappings(&c).is_empty());
    assert_eq!(
        connect(&mut c, "7", &[first], &[], &|| false)
            .unwrap()
            .matched,
        1
    );
}
#[test]
fn missing_stale_empty_or_wrong_location_cache_refuses_without_partial_mapping() {
    for mode in ["missing", "stale", "empty", "location"] {
        let mut c = fixture();
        let mut source = cache(&c, "guide");
        channel(&c, "new", "catalog", "exact");
        match mode {
            "missing" => {
                c.execute("DELETE FROM guide_source", []).unwrap();
            }
            "stale" => {
                c.execute("UPDATE guide_source SET revision=3", []).unwrap();
            }
            "empty" => {
                c.execute("DELETE FROM guide_channel", []).unwrap();
            }
            _ => source.location = "https://other.invalid/feed".into(),
        }
        assert!(connect(&mut c, "7", &[source], &[], &|| false).is_err());
        assert!(mappings(&c).is_empty());
    }
}
#[test]
fn cancellation_after_insert_rolls_back_mapping_and_global_guide_revision() {
    let mut c = fixture();
    let source = cache(&c, "guide");
    channel(&c, "a", "catalog", "exact");
    channel(&c, "b", "catalog", "exact");
    let canceled = AtomicBool::new(false);
    let result = connect_inner(
        &mut c,
        "7",
        &[source],
        &[],
        &|| canceled.load(Ordering::SeqCst),
        &mut || {
            canceled.store(true, Ordering::SeqCst);
            Ok(())
        },
    );
    assert_eq!(result.unwrap_err(), "guide-cancelled");
    assert!(mappings(&c).is_empty());
    assert_eq!(
        c.query_row("SELECT revision FROM guide_meta", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn duplicate_source_requests_are_refused() {
    let mut c = fixture();
    let source = cache(&c, "guide");
    channel(&c, "new", "catalog", "exact");
    assert!(connect(&mut c, "7", &[source.clone(), source], &[], &|| false).is_err());
    assert!(mappings(&c).is_empty());
}

fn alias_fixture(c: &Connection) -> (CachedSource, ReviewedAliases) {
    let mut source = cache(c, "pluto");
    source.location =
        "https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/PlutoTV/us.xml.gz".into();
    c.execute("UPDATE guide_source SET location=?1", [&source.location])
        .unwrap();
    c.execute(
        "INSERT INTO guide_channel VALUES('pluto','5de94dacb394a300099fa22a','[]','PGA')",
        [],
    )
    .unwrap();
    channel(c, "pga", "catalog", "PGATour.us@SD");
    let descriptor = ReviewedAliases {
        schema_version: 1,
        guide_location: source.location.clone(),
        provenance_location: "https://raw.githubusercontent.com/iptv-org/epg/master/sites/pluto.tv/pluto.tv_us.channels.xml".into(),
        provenance_sha256: "dc1eaca8b90b1d227850f81fb02793c74a804c473eb26dd674cd1eaa8084c89e".into(),
        pairs: vec![super::super::reviewed_aliases::AliasPair {
            catalog_source_id: "catalog".into(),
            app_channel_id: "pga".into(),
            provider_id: "PGATour.us@SD".into(),
            xmltv_channel_id: "5de94dacb394a300099fa22a".into(),
        }],
    };
    (source, descriptor)
}

#[test]
fn admitted_reviewed_alias_connects_exact_canonical_target() {
    let mut c = fixture();
    let (source, descriptor) = alias_fixture(&c);
    let result = connect(&mut c, "7", &[source], &[descriptor], &|| false).unwrap();
    assert_eq!((result.matched, result.unmatched), (1, 0));
    assert_eq!(
        mappings(&c),
        vec![(
            "catalog".into(),
            "pga".into(),
            "pluto".into(),
            "5de94dacb394a300099fa22a".into()
        )]
    );
}

#[test]
fn caller_provenance_or_unreviewed_alias_cannot_grant_authority() {
    for mode in [
        "hash",
        "target",
        "provider",
        "canonical",
        "identity-conflict",
    ] {
        let mut c = fixture();
        let (source, mut descriptor) = alias_fixture(&c);
        match mode {
            "hash" => descriptor.provenance_sha256 = "0".repeat(64),
            "target" => descriptor.pairs[0].xmltv_channel_id = "exact".into(),
            "provider" => descriptor.pairs[0].provider_id = "PGA".into(),
            "identity-conflict" => {
                c.execute(
                    "INSERT INTO guide_channel VALUES('pluto','PGATour.us@SD','[]','PGA exact')",
                    [],
                )
                .unwrap();
            }
            _ => descriptor.pairs[0].app_channel_id = "other".into(),
        }
        assert!(connect(&mut c, "7", &[source], &[descriptor], &|| false).is_err());
        assert!(mappings(&c).is_empty());
    }
}

#[test]
fn cache_only_publication_survives_zero_matches_and_can_connect_later_catalog() {
    let mut c = fixture();
    let mut source = cache(&c, "guide");
    channel(&c, "unmatched", "catalog", "unrelated");
    let parsed = super::super::parser::parse_guide(br#"<tv><channel id="later"><display-name>Later</display-name></channel><programme channel="later" start="20261011120000 +0000" stop="20261011130000 +0000"><title>Stored listing</title></programme></tv>"#).unwrap();
    let flag = AtomicBool::new(false);
    assert_eq!(
        super::super::database::replace_guide(&mut c, "guide", 2, &parsed, 2000, &flag).unwrap(),
        3
    );
    source.expected_source_revision = 3;
    source.expected_published_revision = 3;
    let zero = connect(&mut c, "7", std::slice::from_ref(&source), &[], &|| false).unwrap();
    assert_eq!((zero.matched, zero.unmatched), (0, 1));
    assert_eq!(
        c.query_row("SELECT count(*) FROM guide_program", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(mappings(&c).is_empty());
    channel(&c, "new", "catalog", "later");
    c.execute("UPDATE metadata SET catalog_revision=8", [])
        .unwrap();
    assert_eq!(
        connect(&mut c, "8", &[source], &[], &|| false)
            .unwrap()
            .matched,
        1
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM guide_program", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
fn pack_cache(c: &Connection, id: &str, location: &str, headers: &[&str]) -> CachedSource {
    c.execute(
        "INSERT INTO guide_source VALUES(?1,?1,?2,'url',0,2,1000,2)",
        params![id, location],
    )
    .unwrap();
    for header in headers {
        c.execute(
            "INSERT INTO guide_channel VALUES(?1,?2,'[]',?2)",
            params![id, header],
        )
        .unwrap();
    }
    CachedSource {
        id: id.into(),
        location: location.into(),
        expected_source_revision: 2,
        expected_published_revision: 2,
    }
}
#[test]
fn embedded_publisher_tuples_and_main_feed_equivalence_map_only_present_headers() {
    let pack = super::super::crosswalk_pack::loaded().unwrap();
    assert_eq!(pack.main_feed("beINSPORTSXTRA.us"), Some("SD"));
    let mut c = fixture();
    let samsung = pack_cache(
        &c,
        "samsung",
        "https://i.mjh.nz/SamsungTVPlus/us.xml.gz",
        &["USAJ4300001Q7"],
    );
    // Feed-qualified and bare playlist IDs both reach the exact published header.
    channel(&c, "qualified", "catalog", "beINSPORTSXTRA.us@SD");
    channel(&c, "bare", "free-tv", "beINSPORTSXTRA.us");
    // A non-main feed and a tuple whose header is absent never match.
    channel(&c, "other-feed", "catalog", "beINSPORTSXTRA.us@HD");
    channel(&c, "absent", "catalog", "Pac12Insider.us@SD");
    let result = connect(&mut c, "7", std::slice::from_ref(&samsung), &[], &|| false).unwrap();
    assert_eq!(
        (result.matched, result.unmatched, result.ambiguous),
        (2, 2, 0)
    );
    assert_eq!(
        mappings(&c),
        vec![
            (
                "free-tv".into(),
                "bare".into(),
                "samsung".into(),
                "USAJ4300001Q7".into()
            ),
            (
                "catalog".into(),
                "qualified".into(),
                "samsung".into(),
                "USAJ4300001Q7".into()
            ),
        ]
    );
}
#[test]
fn main_feed_equivalence_applies_to_any_feed_but_two_present_targets_stay_ambiguous() {
    let mut c = fixture();
    // A feed that uses bare canonical IDs.
    let bare = pack_cache(
        &c,
        "bare",
        "https://fixture.invalid/bare.xml",
        &["beINSPORTSXTRA.us"],
    );
    channel(&c, "playlist", "catalog", "beINSPORTSXTRA.us@SD");
    let result = connect(&mut c, "7", std::slice::from_ref(&bare), &[], &|| false).unwrap();
    assert_eq!(result.matched, 1);
    let mut c = fixture();
    // Exact and equivalent headers both present in one feed: never pick one.
    let both = pack_cache(
        &c,
        "both",
        "https://fixture.invalid/both.xml",
        &["beINSPORTSXTRA.us", "beINSPORTSXTRA.us@SD"],
    );
    channel(&c, "playlist", "catalog", "beINSPORTSXTRA.us@SD");
    let result = connect(&mut c, "7", &[both], &[], &|| false).unwrap();
    assert_eq!((result.matched, result.ambiguous), (0, 1));
    assert!(mappings(&c).is_empty());
}
fn programme(c: &Connection, guide: &str, ordinal: i64, start: i64, stop: Option<i64>) {
    c.execute(
        "INSERT INTO guide_program(guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,search_text) VALUES(?1,?2,'exact',?3,?4,'Show','show')",
        params![guide, ordinal, start, stop],
    )
    .unwrap();
}
fn clock() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}
const HOUR: i64 = 3_600_000;
#[test]
fn equal_identity_from_two_feeds_prefers_clearly_longer_continuous_schedule() {
    let mut c = fixture();
    let short = cache(&c, "short");
    let long = cache(&c, "long");
    channel(&c, "new", "catalog", "exact");
    let now = clock();
    programme(&c, "short", 1, now - HOUR, Some(now + HOUR / 2));
    programme(&c, "long", 1, now - HOUR, Some(now + HOUR));
    programme(&c, "long", 2, now + HOUR, Some(now + 3 * HOUR));
    let result = connect(&mut c, "7", &[short, long], &[], &|| false).unwrap();
    assert_eq!((result.matched, result.ambiguous), (1, 0));
    assert_eq!(mappings(&c)[0].2, "long");
}
#[test]
fn a_gap_ends_continuous_coverage_and_near_ties_remain_ambiguous() {
    let mut c = fixture();
    let gappy = cache(&c, "gappy");
    let steady = cache(&c, "steady");
    channel(&c, "new", "catalog", "exact");
    let now = clock();
    // Gappy: 1 h now, then nothing until +2 h, then a long tail that does not count.
    programme(&c, "gappy", 1, now - HOUR, Some(now + HOUR));
    programme(&c, "gappy", 2, now + 2 * HOUR, Some(now + 20 * HOUR));
    programme(&c, "steady", 1, now - HOUR, Some(now + 3 * HOUR));
    let result = connect(&mut c, "7", &[gappy, steady], &[], &|| false).unwrap();
    assert_eq!(mappings(&c)[0].2, "steady");
    assert_eq!(result.matched, 1);
    let mut c = fixture();
    let a = cache(&c, "a");
    let b = cache(&c, "b");
    channel(&c, "new", "catalog", "exact");
    programme(&c, "a", 1, now - HOUR, Some(now + 3 * HOUR));
    programme(&c, "b", 1, now - HOUR, Some(now + 3 * HOUR - HOUR / 2));
    let result = connect(&mut c, "7", &[a, b], &[], &|| false).unwrap();
    assert_eq!((result.matched, result.ambiguous), (0, 1));
    assert!(mappings(&c).is_empty());
}
#[test]
fn unknown_programme_end_stops_coverage_instead_of_extending_it() {
    let mut c = fixture();
    let open = cache(&c, "open");
    let known = cache(&c, "known");
    channel(&c, "new", "catalog", "exact");
    let now = clock();
    programme(&c, "open", 1, now - HOUR, None);
    programme(&c, "known", 1, now - HOUR, Some(now + 2 * HOUR));
    connect(&mut c, "7", &[open, known], &[], &|| false).unwrap();
    assert_eq!(mappings(&c)[0].2, "known");
}
