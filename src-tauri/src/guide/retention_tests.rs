use super::super::parser::{GuideChannel, GuideProgram};
use super::*;
fn fixture() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,catalog_revision INTEGER,automatic_guide_updates INTEGER);INSERT INTO metadata VALUES(1,7,1);CREATE TABLE channel(id TEXT PRIMARY KEY,source_id TEXT,provider_id TEXT);CREATE TABLE removed(id TEXT PRIMARY KEY);PRAGMA user_version=1;").unwrap();
    db::migrate(&mut c).unwrap();
    c.execute_batch("PRAGMA user_version=3;").unwrap();
    db::migrate_suggestions(&mut c).unwrap();
    install(&c).unwrap();
    db::save_source(
        &mut c,
        &db::GuideSource {
            id: "g".into(),
            name: "Guide".into(),
            location: "https://example.invalid/g.xml".into(),
            kind: "url".into(),
            allow_http: false,
            revision: 0,
            updated_ms: None,
        },
        0,
    )
    .unwrap();
    c
}
fn h(id: &str) -> GuideChannel {
    GuideChannel {
        id: id.into(),
        names: vec![id.into()],
    }
}
fn p(id: &str, start: i64, stop: Option<i64>) -> GuideProgram {
    GuideProgram {
        channel_id: id.into(),
        start_ms: start,
        stop_ms: stop,
        title: format!("Program {start}"),
        description: Some("Full exact description".into()),
        categories: vec![],
    }
}
fn now() -> i64 {
    4 * DAY + DAY / 2
}
fn request(c: &Connection) -> Request {
    Request {
        scope: capture_snapshot(c, "g", now()).unwrap(),
        authority: None,
        aliases: None,
        automatic: false,
        allow_empty: false,
    }
}
fn saved(c: &Connection, id: &str, provider: &str) {
    c.execute(
        "INSERT INTO channel VALUES(?1,'catalog',?2)",
        params![id, provider],
    )
    .unwrap();
}
fn feed() -> ParsedGuide {
    ParsedGuide {
        channels: vec![h("exact"), h("foreign"), h("manual")],
        programs: vec![
            p("exact", now() - 1000, Some(now() + 100000)),
            p("foreign", now(), Some(now() + 200000)),
            p("manual", now(), Some(now() + 300000)),
        ],
    }
}
fn rows(c: &Connection) -> usize {
    usize::try_from(
        c.query_row("SELECT count(*) FROM guide_program", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap(),
    )
    .expect("nonnegative bounded fixture row count")
}
#[test]
fn production_publication_retains_only_exact_and_explicit_interests_but_all_headers() {
    let mut c = fixture();
    saved(&c, "live", "exact");
    saved(&c, "chosen", "unrelated");
    c.execute(
        "INSERT INTO guide_mapping VALUES('catalog','chosen','g','manual')",
        [],
    )
    .unwrap();
    let r = request(&c);
    db::replace_guide_projected(&mut c, &r, &feed(), now(), &AtomicBool::new(false)).unwrap();
    assert_eq!(rows(&c), 2);
    assert_eq!(
        c.query_row("SELECT count(*) FROM guide_channel", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        3
    );
    let st = status(&c, "g").unwrap().unwrap();
    assert_eq!((st.input_programs, st.retained_programs), (3, 2));
    assert!(compatibility(&c, &request(&c).scope, None).unwrap().0);
    validate(&c).unwrap();
}
#[test]
fn duplicate_validated_input_records_actual_durable_count_and_remains_cache_compatible() {
    let mut c = fixture();
    saved(&c, "live", "exact");
    let r = request(&c);
    let mut f = feed();
    f.programs.push(f.programs[0].clone());
    db::replace_guide_projected(&mut c, &r, &f, now(), &AtomicBool::new(false)).unwrap();
    let status = status(&c, "g").unwrap().unwrap();
    assert_eq!(status.input_programs, 4);
    assert_eq!(status.retained_programs, 1);
    assert_eq!(rows(&c), 1);
    assert_eq!(
        compatibility(&c, &request(&c).scope, None).unwrap(),
        (true, Some(1))
    );
}
#[test]
fn malformed_foreign_row_refuses_before_projection_and_preserves_prior_rows() {
    let mut c = fixture();
    saved(&c, "live", "exact");
    let initial = request(&c);
    db::replace_guide_projected(&mut c, &initial, &feed(), now(), &AtomicBool::new(false)).unwrap();
    let previous = db::list_sources(&c).unwrap();
    let mut bad = feed();
    bad.programs[1].channel_id = "missing-header".into();
    let r = request(&c);
    assert_eq!(
        db::replace_guide_projected(&mut c, &r, &bad, now(), &AtomicBool::new(false)).unwrap_err(),
        "guide-unknown-channel"
    );
    assert_eq!(db::list_sources(&c).unwrap(), previous);
    assert_eq!(rows(&c), 1);
    let xml=b"<tv><channel id='exact'><display-name>Good</display-name></channel><channel id='foreign'><display-name>Other</display-name></channel><programme channel='foreign' start='20261015010000 +0000' stop='20261014010000 +0000'><title>Bad</title></programme></tv>";
    assert!(super::super::parser::parse_guide(xml).is_err());
}
#[test]
fn utc_bucket_retains_overlap_and_complete_unknown_context_group_without_inventing_end() {
    let c = fixture();
    saved(&c, "live", "exact");
    let r = request(&c);
    let (_, lower, upper) = window(now()).unwrap();
    let mut f = feed();
    f.programs = vec![
        p("exact", lower - 10000, Some(lower)),
        p("exact", lower - 9000, Some(lower + 1)),
        p("exact", upper, Some(upper + 1)),
        p("exact", upper - 1, Some(upper + 100000)),
        p("exact", lower - 20, None),
        p("exact", lower - 10, None),
        p("exact", lower, None),
    ];
    let mut tied = p("exact", lower - 10, None);
    tied.title = "Conflicting unknown context".into();
    f.programs.push(tied);
    let projection = project(&c, &r, &f, &AtomicBool::new(false)).unwrap();
    assert_eq!(projection.feed.programs.len(), 5);
    assert_eq!(
        projection
            .feed
            .programs
            .iter()
            .filter(|p| p.stop_ms.is_none() && p.start_ms < lower)
            .count(),
        2
    );
    assert!(projection.feed.programs.iter().all(|p| p.start_ms < upper));
    assert_eq!(window(now() + DAY / 2 - 1).unwrap(), window(now()).unwrap());
    assert_ne!(window(now() + DAY / 2).unwrap(), window(now()).unwrap());
}
#[test]
fn removed_and_missing_catalog_mappings_do_not_retain_programs_or_destroy_choices() {
    let mut c = fixture();
    saved(&c, "removed", "exact");
    c.execute("INSERT INTO removed VALUES('removed')", [])
        .unwrap();
    c.execute_batch("INSERT INTO guide_mapping VALUES('catalog','removed','g','exact'),('catalog','missing','g','manual');").unwrap();
    let r = request(&c);
    db::replace_guide_projected(&mut c, &r, &feed(), now(), &AtomicBool::new(false)).unwrap();
    assert_eq!(rows(&c), 0);
    assert_eq!(db::list_mappings(&c).unwrap().len(), 2);
    assert_eq!(
        compatibility(&c, &request(&c).scope, None).unwrap(),
        (true, Some(0))
    );
}
#[test]
fn zero_interest_is_compatible_but_new_channel_or_manual_map_forces_body() {
    let mut c = fixture();
    let r = request(&c);
    db::replace_guide_projected(&mut c, &r, &feed(), now(), &AtomicBool::new(false)).unwrap();
    assert_eq!(
        compatibility(&c, &request(&c).scope, None).unwrap(),
        (true, Some(0))
    );
    saved(&c, "new", "foreign");
    assert_eq!(
        compatibility(&c, &request(&c).scope, None).unwrap(),
        (false, None)
    );
    let r = request(&c);
    assert!(super::super::conditional::read_projected(&c, &r)
        .unwrap()
        .is_none());
    c.execute("DELETE FROM channel WHERE id='new'", []).unwrap();
    saved(&c, "manual-channel", "unrelated");
    c.execute(
        "INSERT INTO guide_mapping VALUES('catalog','manual-channel','g','manual')",
        [],
    )
    .unwrap();
    assert!(!compatibility(&c, &request(&c).scope, None).unwrap().0);
}
#[test]
fn authority_unavailable_refuses_publication_without_certifying_or_pruning() {
    let mut c = fixture();
    c.execute(
        "UPDATE guide_source SET location=?1",
        [reviewed_crosswalk::FEED],
    )
    .unwrap();
    let r = request(&c);
    assert_eq!(
        db::replace_guide_projected(&mut c, &r, &feed(), now(), &AtomicBool::new(false))
            .unwrap_err(),
        "guide-retention-identity-unavailable"
    );
    assert!(status(&c, "g").unwrap().is_none());
    assert_eq!(rows(&c), 0);
    assert_eq!(
        compatibility(&c, &request(&c).scope, None).unwrap(),
        (false, None)
    );
}
#[test]
fn fresh_projection_does_not_erase_last_useful_interested_schedule() {
    let mut c = fixture();
    saved(&c, "live", "exact");
    let r = request(&c);
    db::replace_guide_projected(&mut c, &r, &feed(), now(), &AtomicBool::new(false)).unwrap();
    let mut next = feed();
    next.programs.retain(|p| p.channel_id != "exact");
    let r = request(&c);
    assert_eq!(
        db::replace_guide_projected(&mut c, &r, &next, now(), &AtomicBool::new(false)).unwrap_err(),
        "guide-retention-would-drop-useful-schedule"
    );
    assert_eq!(rows(&c), 1);
}
#[test]
fn captured_catalog_mapping_source_and_permission_races_refuse_publication() {
    for mutate in [
        "UPDATE metadata SET catalog_revision=catalog_revision+1",
        "INSERT INTO guide_mapping VALUES('catalog','live','g','manual')",
        "UPDATE guide_source SET revision=revision+1",
        "UPDATE metadata SET automatic_guide_updates=0",
        "INSERT INTO removed VALUES('live')",
    ] {
        let mut c = fixture();
        saved(&c, "live", "exact");
        let r = request(&c);
        c.execute_batch(mutate).unwrap();
        assert_eq!(
            db::replace_guide_projected(&mut c, &r, &feed(), now(), &AtomicBool::new(false))
                .unwrap_err(),
            "guide-retention-scope-stale"
        );
        assert_eq!(rows(&c), 0);
    }
}
#[test]
fn conditional_304_requires_unchanged_interest_window_and_keeps_original_schedule_age() {
    let mut c = fixture();
    saved(&c, "live", "exact");
    let mut r = request(&c);
    r.automatic = true;
    let validators = super::super::conditional::Validators {
        etag: Some("\"body1\"".into()),
        last_modified: None,
    };
    db::replace_guide_conditional_projected(
        &mut c,
        &r,
        &feed(),
        now(),
        &validators,
        &AtomicBool::new(false),
    )
    .unwrap();
    let mut r = request(&c);
    r.automatic = true;
    let cached = super::super::conditional::read_projected(&c, &r)
        .unwrap()
        .unwrap();
    super::super::conditional::revalidate_projected(
        &mut c,
        &r,
        &cached,
        &validators,
        now() + 1000,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(db::list_sources(&c).unwrap()[0].updated_ms, Some(now()));
    let mut future = r.scope.clone();
    future.anchor_ms += DAY;
    assert!(!permits_304(&c, &future, None).unwrap());
    let mut backward = r.scope.clone();
    backward.anchor_ms -= DAY;
    assert!(!permits_304(&c, &backward, None).unwrap());
    saved(&c, "new", "foreign");
    assert!(super::super::conditional::revalidate_projected(
        &mut c,
        &r,
        &cached,
        &validators,
        now() + 2000,
        &AtomicBool::new(false)
    )
    .is_err());
}
#[test]
fn explicit_cleanup_prunes_legacy_foreign_rows_once_preserving_metadata_and_choices() {
    let mut c = fixture();
    saved(&c, "live", "exact");
    db::replace_guide(
        &mut c,
        "g",
        1,
        &feed(),
        now() - 5000,
        &AtomicBool::new(false),
    )
    .unwrap();
    c.execute_batch("CREATE TABLE unrelated(payload TEXT);INSERT INTO unrelated VALUES('untouched');INSERT INTO guide_mapping VALUES('catalog','missing','g','manual');").unwrap();
    let before = db::list_sources(&c).unwrap()[0].updated_ms;
    let plan = prepare_cleanup(&c, now(), None, &AtomicBool::new(false)).unwrap();
    assert_eq!(plan.receipt.programs_removed, 2);
    assert!(cleanup_receipt_if_unchanged(&c, &plan).unwrap().is_none());
    let result = commit_cleanup(&mut c, &plan, &AtomicBool::new(false), &mut || Ok(())).unwrap();
    assert_eq!(result.programs_after, 1);
    assert_eq!(db::list_sources(&c).unwrap()[0].updated_ms, before);
    assert_eq!(db::list_mappings(&c).unwrap().len(), 1);
    assert_eq!(
        c.query_row("SELECT payload FROM unrelated", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "untouched"
    );
    let again = prepare_cleanup(&c, now(), None, &AtomicBool::new(false)).unwrap();
    assert_eq!(again.receipt.sources_changed, 0);
    assert!(cleanup_receipt_if_unchanged(&c, &again).unwrap().is_some());
}
#[test]
fn cleanup_batch_cancellation_and_stale_scope_preserve_every_source() {
    let mut c = fixture();
    db::replace_guide(&mut c, "g", 1, &feed(), now(), &AtomicBool::new(false)).unwrap();
    let plan = prepare_cleanup(&c, now(), None, &AtomicBool::new(false)).unwrap();
    assert!(commit_cleanup(&mut c, &plan, &AtomicBool::new(true), &mut || Ok(())).is_err());
    assert_eq!(rows(&c), 3);
    c.execute("UPDATE metadata SET catalog_revision=8", [])
        .unwrap();
    assert_eq!(
        commit_cleanup(&mut c, &plan, &AtomicBool::new(false), &mut || Ok(())).unwrap_err(),
        "guide-retention-scope-stale"
    );
    assert_eq!(rows(&c), 3);
}
#[test]
fn unsupported_future_policy_is_dedicated_refusal() {
    let c = fixture();
    c.execute("INSERT INTO guide_projection_v1 VALUES('g',99,1,0,-7200000,691200000,?1,'not-required',?1,0,0,0,1)",["0".repeat(64)]).unwrap();
    assert_eq!(
        validate(&c).unwrap_err(),
        "guide-projection-policy-unsupported"
    );
}
#[test]
fn cleanup_source_scopes_share_one_immutable_catalog_and_mapping_snapshot() {
    let mut c = fixture();
    saved(&c, "live", "exact");
    for n in 0..12 {
        db::save_source(
            &mut c,
            &db::GuideSource {
                id: format!("other-{n}"),
                name: "Other".into(),
                location: format!("https://example.invalid/{n}"),
                kind: "url".into(),
                allow_http: false,
                revision: 0,
                updated_ms: None,
            },
            0,
        )
        .unwrap();
    }
    let plan = prepare_cleanup(&c, now(), None, &AtomicBool::new(false)).unwrap();
    assert_eq!(plan.sources.len(), 13);
    let first = &plan.sources[0].scope;
    for source in &plan.sources {
        assert!(Arc::ptr_eq(&first.channels, &source.scope.channels));
        assert!(Arc::ptr_eq(&first.mappings, &source.scope.mappings));
        verify(&c, &source.scope).unwrap();
    }
}
#[test]
fn cleanup_plan_budget_exact_boundary_and_whole_plan_refusal_never_mutate() {
    let mut c = fixture();
    saved(&c, "live", "exact");
    db::replace_guide(
        &mut c,
        "g",
        1,
        &feed(),
        now() - 5000,
        &AtomicBool::new(false),
    )
    .unwrap();
    let sources_before = db::list_sources(&c).unwrap();
    let meta_before: i64 = c
        .query_row("SELECT revision FROM guide_meta", [], |r| r.get(0))
        .unwrap();
    let plan = prepare_cleanup(&c, now(), None, &AtomicBool::new(false)).unwrap();
    assert!(plan.estimated_bytes < CLEANUP_PLAN_BYTES);
    assert!(plan.estimated_bytes > std::mem::size_of::<CleanupPlan>());
    let exact = prepare_cleanup_limited(
        &c,
        now(),
        None,
        &AtomicBool::new(false),
        plan.estimated_bytes,
    )
    .unwrap();
    assert_eq!(exact.estimated_bytes, plan.estimated_bytes);
    assert_eq!(exact.receipt.programs_removed, 2);
    let error = prepare_cleanup_limited(
        &c,
        now(),
        None,
        &AtomicBool::new(false),
        plan.estimated_bytes - 1,
    )
    .err()
    .unwrap();
    assert_eq!(error, "guide-retention-cleanup-plan-limit");
    assert!(c.is_autocommit());
    assert_eq!(db::list_sources(&c).unwrap(), sources_before);
    assert_eq!(rows(&c), 3);
    assert_eq!(
        c.query_row("SELECT revision FROM guide_meta", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        meta_before
    );
    assert!(status(&c, "g").unwrap().is_none());
}

#[test]
fn pinned_verified_crosswalk_retains_exact_target_and_quarantined_id_never_guesses() {
    let mut c = fixture();
    c.execute(
        "UPDATE guide_source SET location=?1",
        [reviewed_crosswalk::FEED],
    )
    .unwrap();
    saved(&c, "golazo", "CBSSportsGolazoNetwork.us@SD");
    let authority = Arc::new(reviewed_crosswalk::pinned_fixture());
    let target = authority
        .target("CBSSportsGolazoNetwork.us@SD")
        .unwrap()
        .to_owned();
    let f = ParsedGuide {
        channels: vec![h(&target), h("foreign")],
        programs: vec![
            p(&target, now(), Some(now() + 100000)),
            p("foreign", now(), Some(now() + 200000)),
        ],
    };
    let mut r = request(&c);
    r.authority = Some(authority.clone());
    db::replace_guide_projected(&mut c, &r, &f, now(), &AtomicBool::new(false)).unwrap();
    assert_eq!(rows(&c), 1);
    assert_eq!(
        compatibility(&c, &request(&c).scope, Some(&authority)).unwrap(),
        (true, Some(1))
    );
    assert_eq!(
        compatibility(&c, &request(&c).scope, None).unwrap(),
        (false, None)
    );
    assert!(db::list_mappings(&c).unwrap().is_empty());
    let previous_sources = db::list_sources(&c).unwrap();
    let previous_policy = serde_json::to_value(status(&c, "g").unwrap()).unwrap();
    let cold = request(&c);
    assert_eq!(
        db::replace_guide_projected(&mut c, &cold, &f, now(), &AtomicBool::new(false)).unwrap_err(),
        "guide-retention-identity-unavailable"
    );
    assert_eq!(
        prepare_cleanup(&c, now(), None, &AtomicBool::new(false))
            .err()
            .unwrap(),
        "guide-retention-identity-unavailable"
    );
    assert_eq!(rows(&c), 1);
    assert_eq!(db::list_sources(&c).unwrap(), previous_sources);
    assert_eq!(
        serde_json::to_value(status(&c, "g").unwrap()).unwrap(),
        previous_policy
    );
    assert!(db::list_mappings(&c).unwrap().is_empty());
}
#[test]
fn identical_saved_identity_interest_is_retained_in_both_feeds_without_creating_mapping() {
    let c = fixture();
    saved(&c, "live", "exact");
    let a = request(&c);
    let f = feed();
    let p1 = project(&c, &a, &f, &AtomicBool::new(false)).unwrap();
    assert_eq!(p1.feed.programs.len(), 1);
    // Second explicitly configured feed has the same exact header; interest
    // projection does not choose a winner or insert a mapping.
    let mut c = c;
    db::save_source(
        &mut c,
        &db::GuideSource {
            id: "second-guide".into(),
            name: "Other".into(),
            location: "https://example.invalid/other".into(),
            kind: "url".into(),
            allow_http: false,
            revision: 0,
            updated_ms: None,
        },
        0,
    )
    .unwrap();
    let r = Request {
        scope: capture_snapshot(&c, "second-guide", now()).unwrap(),
        authority: None,
        aliases: None,
        automatic: false,
        allow_empty: false,
    };
    let p2 = project(&c, &r, &f, &AtomicBool::new(false)).unwrap();
    assert_eq!(p2.feed.programs.len(), 1);
    assert!(db::list_mappings(&c).unwrap().is_empty());
}
