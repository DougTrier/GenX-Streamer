//! Fixed-clock publisher fixtures; no provider network or application profile.
use super::*;
use crate::guide::{
    conditional,
    parser::{GuideChannel, GuideProgram, ParsedGuide},
};
use std::sync::atomic::AtomicBool;

const HOUR: i64 = 3_600_000;
const BASE: i64 = 20_000 * 86_400_000;

fn coverage_fixture() -> (Connection, GuideSource, ParsedGuide) {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;PRAGMA user_version=1;CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,revision INTEGER,automatic_guide_updates INTEGER);INSERT INTO metadata VALUES(1,0,1);CREATE TABLE preference(singleton INTEGER PRIMARY KEY,source_refresh_cadence TEXT,auto_source_refresh INTEGER);INSERT INTO preference VALUES(1,'off',0);CREATE TABLE source(id TEXT PRIMARY KEY);INSERT INTO source VALUES('catalog');CREATE TABLE channel(id TEXT PRIMARY KEY,source_id TEXT NOT NULL);CREATE TABLE removed(id TEXT PRIMARY KEY);").unwrap();
    db::migrate(&mut c).unwrap();
    c.execute_batch("PRAGMA user_version=3;").unwrap();
    db::migrate_suggestions(&mut c).unwrap();
    let source = GuideSource {
        id: "guide".into(),
        name: "Selected fixture".into(),
        location: "https://fixture.invalid/guide.xml".into(),
        kind: "url".into(),
        allow_http: false,
        revision: 0,
        updated_ms: None,
    };
    db::save_source(&mut c, &source, 0).unwrap();
    let mut feed = ParsedGuide {
        channels: vec![],
        programs: vec![],
    };
    for i in 0..54 {
        let id = format!("publisher-{i}");
        feed.channels.push(GuideChannel {
            id: id.clone(),
            names: vec![format!("Fixture {i}")],
        });
        feed.programs.push(GuideProgram {
            channel_id: id.clone(),
            start_ms: BASE - HOUR,
            stop_ms: Some(BASE + if i < 52 { 12 * HOUR } else { 4 * 86_400_000 }),
            title: "Real scheduled fixture".into(),
            description: None,
            categories: vec![],
        });
        if i < 53 {
            let app = format!("app-{i}");
            c.execute("INSERT INTO channel VALUES(?1,'catalog')", [&app])
                .unwrap();
            c.execute(
                "INSERT INTO guide_mapping VALUES('catalog',?1,'guide',?2)",
                params![app, id],
            )
            .unwrap();
        }
    }
    let source = db::list_sources(&c).unwrap().remove(0);
    db::replace_guide_conditional(
        &mut c,
        &source,
        &feed,
        BASE,
        &conditional::Validators {
            etag: Some("\"fixture\"".into()),
            last_modified: None,
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    let published = db::list_sources(&c).unwrap().remove(0);
    (c, published, feed)
}

#[test]
fn expired_52_of_53_mapped_targets_are_due_before_daily_even_with_far_future_programs() {
    let (c, _, _) = coverage_fixture();
    let now = BASE + 18 * HOUR;
    let plan = plan(&c, now).unwrap();
    assert_eq!(plan.sources.len(), 1);
    assert!(
        plan.sources[0].next_due_ms <= now,
        "One mapped/unmapped far-future programme must not hide 52 exhausted mapped horizons"
    );
}

#[test]
fn early_attempt_is_persistent_and_throttles_failed_or_unchanged_source_until_one_hour() {
    let (mut c, source, _) = coverage_fixture();
    let now = BASE + 18 * HOUR;
    let first = claim(&mut c, &source.id, source.revision, now).unwrap();
    assert!(first.2, "Expired mapped schedules need an early attempt");
    assert_eq!(first.1, now + HOUR);
    assert_eq!(
        c.query_row("SELECT attempted_ms FROM guide_refresh_state", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        now
    );
    // A new plan/claim has no shared timer or in-memory retry state.
    assert_eq!(
        plan(&c, now + 1).unwrap().sources[0].next_due_ms,
        now + HOUR
    );
    assert!(
        !claim(&mut c, &source.id, source.revision, now + HOUR - 1)
            .unwrap()
            .2
    );
    assert!(
        claim(&mut c, &source.id, source.revision, now + HOUR)
            .unwrap()
            .2
    );
}

#[test]
fn fresh_response_replans_from_earliest_mapped_horizon_before_publication() {
    let (mut c, source, mut feed) = coverage_fixture();
    let now = BASE + 18 * HOUR;
    assert!(claim(&mut c, &source.id, source.revision, now).unwrap().2);
    for p in &mut feed.programs {
        p.stop_ms = Some(now + 19 * HOUR);
    }
    feed.programs[0].stop_ms = Some(now + 16 * HOUR);
    let canceled = AtomicBool::new(false);
    let expected = now + 16 * HOUR - 15 * 60_000;
    let due = next_after_feed(&c, &source, &feed, now, &canceled).unwrap();
    assert_eq!(due, expected);
    db::replace_guide_conditional(
        &mut c,
        &source,
        &feed,
        now,
        &conditional::Validators::default(),
        &canceled,
    )
    .unwrap();
    assert_eq!(plan(&c, now).unwrap().sources[0].next_due_ms, expected);
}

#[test]
fn incomplete_200_and_304_never_hot_loop_or_pretend_missing_ends_are_coverage() {
    let (mut c, source, mut feed) = coverage_fixture();
    let now = BASE + 18 * HOUR;
    assert!(claim(&mut c, &source.id, source.revision, now).unwrap().2);
    let cached = conditional::read(&c, &source).unwrap().unwrap();
    conditional::revalidate(
        &mut c,
        &source,
        &cached,
        &conditional::Validators::default(),
        now + 1,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        plan(&c, now + 1).unwrap().sources[0].next_due_ms,
        now + HOUR
    );
    assert_eq!(db::list_sources(&c).unwrap()[0].updated_ms, Some(BASE));
    feed.programs[0].stop_ms = None;
    feed.programs.retain(|p| p.channel_id != "publisher-1");
    let published = now + HOUR;
    assert_eq!(
        next_after_feed(&c, &source, &feed, published, &AtomicBool::new(false)).unwrap(),
        published + HOUR
    );
    db::replace_guide_conditional(
        &mut c,
        &source,
        &feed,
        published,
        &conditional::Validators::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let stats = mapped_targets(&c, &source.id, published).unwrap();
    assert_eq!(stats.missing_end_count, 2);
    assert_eq!(stats.target_count, 53);
    assert_eq!(
        plan(&c, published).unwrap().sources[0].next_due_ms,
        published + HOUR
    );
}

#[test]
fn exact_catalog_scope_ignores_removed_or_missing_channels_and_deduplicates_aliases() {
    let (c, source, _) = coverage_fixture();
    c.execute("INSERT INTO channel VALUES('alias','catalog')", [])
        .unwrap();
    c.execute(
        "INSERT INTO guide_mapping VALUES('catalog','alias','guide','publisher-0')",
        [],
    )
    .unwrap();
    assert_eq!(
        mapped_targets(&c, &source.id, BASE).unwrap().target_count,
        53
    );
    c.execute("INSERT INTO removed VALUES('app-1')", [])
        .unwrap();
    c.execute("DELETE FROM channel WHERE id='app-2'", [])
        .unwrap();
    assert_eq!(
        mapped_targets(&c, &source.id, BASE).unwrap().target_count,
        51
    );
    c.execute(
        "UPDATE guide_mapping SET catalog_source_id='other' WHERE app_channel_id='app-3'",
        [],
    )
    .unwrap();
    assert_eq!(
        mapped_targets(&c, &source.id, BASE).unwrap().target_count,
        50
    );
}

#[test]
fn no_mapped_targets_retains_daily_and_read_plan_never_creates_attempt_state() {
    let (c, source, _) = coverage_fixture();
    c.execute("DELETE FROM guide_mapping", []).unwrap();
    assert_eq!(
        plan(&c, BASE + 18 * HOUR).unwrap().sources[0].next_due_ms,
        BASE + 24 * HOUR
    );
    assert!(
        preflight_claim(&c, &source.id, source.revision, BASE + 18 * HOUR)
            .unwrap()
            .is_some()
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='guide_refresh_state'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn permission_revision_cancel_and_clock_guards_preserve_attempt_state() {
    let (mut c, source, feed) = coverage_fixture();
    let now = BASE + 18 * HOUR;
    assert_eq!(
        preflight_claim(&c, &source.id, source.revision + 1, now).unwrap_err(),
        "guide-stale-revision"
    );
    c.execute("UPDATE metadata SET automatic_guide_updates=0", [])
        .unwrap();
    assert_eq!(
        claim(&mut c, &source.id, source.revision, now).unwrap_err(),
        "guide-refresh-disabled"
    );
    assert_eq!(
        next_after_feed(&c, &source, &feed, now, &AtomicBool::new(false)).unwrap_err(),
        "guide-refresh-disabled"
    );
    c.execute("UPDATE metadata SET automatic_guide_updates=1", [])
        .unwrap();
    assert_eq!(
        next_after_feed(&c, &source, &feed, now, &AtomicBool::new(true)).unwrap_err(),
        "canceled"
    );
    assert!(next_after_feed(&c, &source, &feed, i64::MAX, &AtomicBool::new(false)).is_err());
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='guide_refresh_state'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn present_app_schema_cannot_silently_fallback_when_catalog_tables_missing() {
    let (c, source, _) = coverage_fixture();
    c.execute_batch("DROP TABLE removed;PRAGMA user_version=19;")
        .unwrap();
    assert_eq!(
        mapped_targets(&c, &source.id, BASE).unwrap_err(),
        "guide-refresh-catalog-unavailable"
    );
}

#[test]
fn attempt_fingerprint_and_earliest_lead_are_source_scoped_and_read_only() {
    let (mut c, source, _) = coverage_fixture();
    let now = BASE + 18 * HOUR;
    assert!(claim(&mut c, &source.id, source.revision, now).unwrap().2);
    let before = c.total_changes();
    let stats = mapped_targets(&c, &source.id, now).unwrap();
    assert_eq!(stats.target_count, 53);
    assert_eq!(stats.known_end_count, 53);
    assert_eq!(stats.expired_count, 52);
    assert_eq!(stats.earliest_last_stop_ms, Some(BASE + 12 * HOUR));
    assert_eq!(stats.cooldown_until_ms, now + HOUR);
    assert!(preflight_claim(&c, &source.id, source.revision, now)
        .unwrap()
        .is_some());
    assert_eq!(c.total_changes(), before);
    c.execute(
        "UPDATE guide_refresh_state SET fingerprint='unrelated-descriptor'",
        [],
    )
    .unwrap();
    assert_eq!(
        plan(&c, now).unwrap().sources[0].next_due_ms,
        BASE + 12 * HOUR - 15 * 60_000
    );
    let json = serde_json::to_value(mapped_targets(&c, &source.id, now).unwrap()).unwrap();
    assert_eq!(json["version"], 1);
    assert_eq!(json.as_object().unwrap().len(), 8);
    assert!(!json.to_string().contains("fixture.invalid"));
}

#[test]
fn canceled_claim_rolls_back_attempt_before_commit_then_retry_is_due() {
    let (mut c, source, _) = coverage_fixture();
    let now = BASE + 18 * HOUR;
    let mut checks = 0;
    let result = claim_checked(&mut c, &source.id, source.revision, now, &mut || {
        checks += 1;
        if checks == 2 {
            Err("canceled".into())
        } else {
            Ok(())
        }
    });
    assert_eq!(result.unwrap_err(), "canceled");
    assert_eq!(checks, 2);
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='guide_refresh_state'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert!(claim(&mut c, &source.id, source.revision, now).unwrap().2);
    assert!(!claim(&mut c, &source.id, source.revision, now).unwrap().2);
}
