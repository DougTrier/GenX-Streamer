// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
use super::*;

struct Fixture {
    _root: tempfile::TempDir,
    store: PairStore,
    catalog: Value,
    prefs: Value,
    now: u64,
}
impl Fixture {
    fn new(urls: &[&str]) -> Self {
        let root = tempfile::tempdir().unwrap();
        let store = PairStore::new(root.path().into()).unwrap();
        let sources = json!([
            {"id":"s1","name":"One","kind":"url","location":"https://lists.invalid/one.m3u"},
            {"id":"s2","name":"Two","kind":"url","location":"https://lists.invalid/two.m3u"}
        ]);
        let catalog = json!({"schemaVersion":1,"sources":sources,"channels":[{"id":"c","sourceId":"s1","name":"Retired channel","category":"Sports","urls":urls}]});
        let prefs = json!({"schemaVersion":1,"sources":sources,"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":300});
        store
            .write_pair(&catalog.to_string(), &prefs.to_string())
            .unwrap();
        Self {
            _root: root,
            store,
            catalog,
            prefs,
            now: scan_now(),
        }
    }
    fn c(&self) -> Connection {
        connect(&self.store.root.join(DB), false).unwrap()
    }
    fn round(&self) -> Finish {
        let r = self
            .store
            .begin_source_cleanup(
                &Begin {
                    schema_version: 1,
                    expected_catalog_revision: self.store.read_snapshot().unwrap().catalog_revision,
                },
                "windows",
                self.now,
                || Ok(()),
            )
            .unwrap();
        Finish {
            schema_version: 1,
            round_id: r.round_id,
        }
    }
    fn promote(&self, index: usize, channels: Vec<Value>) {
        self.promote_definition(self.catalog["sources"][index].clone(), channels);
    }
    fn promote_definition(&self, definition: Value, mut channels: Vec<Value>) {
        let id = definition["id"].as_str().unwrap();
        let previous = source_revision(&self.c(), id).unwrap_or(0);
        let stage = self
            .store
            .begin_source_snapshot(
                &source_snapshot::Begin {
                    schema_version: 1,
                    source: definition.clone(),
                    expected_source_revision: previous.to_string(),
                    entry_count: channels.len(),
                    platform: "windows".into(),
                    observer_profile: PROFILE.into(),
                },
                || Ok(()),
            )
            .unwrap();
        if !channels.is_empty() {
            for channel in &mut channels {
                channel["sourceId"] = definition["id"].clone();
            }
            self.store
                .append_source_snapshot(
                    &source_snapshot::Append {
                        snapshot_id: stage.snapshot_id.clone(),
                        expected_next_index: 0,
                        entries: channels
                            .into_iter()
                            .map(|channel| source_snapshot::Entry {
                                entry_id: "input".into(),
                                channel,
                            })
                            .collect(),
                    },
                    || Ok(()),
                )
                .unwrap();
        }
        self.store
            .promote_source_snapshot(
                &source_snapshot::Promote {
                    snapshot_id: stage.snapshot_id,
                    expected_source_revision: previous.to_string(),
                    completed: true,
                },
                || Ok(()),
            )
            .unwrap();
    }
    fn empty_all(&self) {
        self.promote(0, vec![]);
        self.promote(1, vec![]);
    }
    fn prepare(&self, r: &Finish) -> Prepared {
        self.store
            .prepare_source_cleanup(r, "windows", self.now + 100, || Ok(()))
            .unwrap()
    }
    fn facts(&self, p: &Prepared, status: Option<u16>) -> Vec<Fact> {
        p.targets
            .iter()
            .map(|t| Fact {
                key: t.key.clone(),
                status,
                recognized: status == Some(200),
                observed_at: self.now + 200,
            })
            .collect()
    }
    fn commit(&self, p: &Prepared, facts: &[Fact]) -> Reply {
        self.store
            .commit_source_cleanup(
                p,
                facts,
                "windows",
                self.now + 300,
                facts.len(),
                false,
                || Ok(()),
            )
            .unwrap()
    }
    fn preferences(&self) -> Value {
        serde_json::from_str(
            self.store
                .read_snapshot()
                .unwrap()
                .pair
                .preferences
                .as_ref()
                .unwrap(),
        )
        .unwrap()
    }
    fn health(
        &self,
        ordinal: usize,
        status: u16,
        profile: &str,
        at: u64,
        origin: &str,
        platform: &str,
    ) -> Value {
        let channel = &self.catalog["channels"][0];
        let source = &self.catalog["sources"][0];
        json!({"schemaVersion":1,"channelId":channel["id"],"sourceId":source["id"],"checkedUrlOrdinal":ordinal,"targetFingerprint":crate::health_storage::fingerprint(source,channel,ordinal).unwrap(),"platform":platform,"observerProfile":profile,"observedAt":at,"verdict":if status==200{"Reachable"}else{"TemporaryUnavailable"},"origin":origin,"evidence":{"kind":"http","status":status,"contentRecognized":status==200}})
    }
    fn save_health(&self, record: Value) {
        let s = self.store.read_snapshot().unwrap();
        self.store
            .write_health_guarded(
                &json!({"schemaVersion":1,"records":[record]}).to_string(),
                &s.catalog_revision,
                &s.health_revision,
                || Ok(()),
            )
            .unwrap();
    }
    fn save_config(&self) {
        self.store
            .write_pair(&self.catalog.to_string(), &self.prefs.to_string())
            .unwrap();
    }
}
fn entry(urls: &[&str]) -> Value {
    json!({"name":"Unrelated feed entry","category":"Sports","urls":urls})
}

#[test]
fn a_refreshed_playlist_removes_expired_games_with_reused_addresses_and_guide_ids() {
    let mut f = Fixture::new(&["https://streams.invalid/event"]);
    let game = json!({"id":"c","sourceId":"s1","name":"[NBA] Boston at Philadelphia","category":"Live Events",
        "providerId":"NBA.Basketball.Dummy.us","urls":["https://streams.invalid/event"]});
    f.catalog["channels"][0] = game.clone();
    for (id, source_id, title) in [
        ("favorite-game", "s1", "[NBA] Denver at Los Angeles"),
        ("kept-game", "s1", "[NBA] Chicago at Washington"),
        ("failed-source-game", "s2", "[NBA] New York at Cleveland"),
        ("concert", "s1", "[Music] Jazz at the Plaza"),
    ] {
        let mut other = game.clone();
        other["id"] = json!(id);
        other["sourceId"] = json!(source_id);
        other["name"] = json!(title);
        f.catalog["channels"].as_array_mut().unwrap().push(other);
    }
    f.prefs["favorites"] = json!(["favorite-game"]);
    f.save_config();
    let r = f.round();
    f.promote(
        0,
        vec![
            json!({"name":"[NBA] Utah at Phoenix","category":"Live Events",
                "providerId":"NBA.Basketball.Dummy.us","urls":["https://streams.invalid/event"]}),
            json!({"name":"[NBA] Chicago at Washington","category":"Live Events",
                "providerId":"NBA.Basketball.Dummy.us","urls":["https://streams.invalid/new"]}),
        ],
    );
    let p = f.prepare(&r);
    assert!(!p.coverage_complete);
    assert!(p.targets.is_empty());
    let result = f.commit(&p, &[]);
    assert_eq!(result.archived_count, 0);
    assert_eq!(result.expired_event_ids, ["c"]);
    assert_eq!(f.preferences()["removedChannels"], json!([]));
    assert_eq!(f.preferences()["favorites"], json!(["favorite-game"]));
    assert_eq!(
        f.c()
            .query_row("SELECT count(*) FROM channel WHERE id='c'", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn an_unreplaceable_checkpoint_arriving_after_prepare_defers_game_expiry() {
    let mut f = Fixture::new(&["https://streams.invalid/event"]);
    f.catalog["channels"][0]["name"] = json!("[NBA] Boston at Philadelphia");
    f.catalog["channels"][0]["category"] = json!("Live Events");
    f.save_config();
    let round = f.round();
    f.promote(0, vec![entry(&["https://streams.invalid/current"])]);
    let prepared = f.prepare(&round);
    assert_eq!(prepared.expired_event_ids, ["c"]);
    let c = f.c();
    crate::scan_checkpoint::ensure(&c).unwrap();
    c.execute(
        "UPDATE scan_checkpoint SET revision=1,job_id='unrecovered',contents='{}' WHERE singleton=1",
        [],
    )
    .unwrap();
    let receipt = f.commit(&prepared, &[]);
    assert!(receipt.expired_event_ids.is_empty());
    assert_eq!(receipt.deferred_count, 1);
    assert_eq!(
        c.query_row("SELECT count(*) FROM channel WHERE id='c'", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn a_changed_saved_address_enters_refresh_even_when_the_same_stream_is_mirrored() {
    let mut f = Fixture::new(&["https://streams.invalid/old"]);
    f.prefs["favorites"] = json!(["c"]);
    f.save_config();
    let rotated = "https://streams.invalid/current";
    f.promote(1, vec![entry(&[rotated])]);
    f.promote(
        0,
        vec![json!({"name":"Retired channel","category":"Sports","urls":[rotated]})],
    );
    let prepared = f
        .store
        .prepare_source_snapshot_activation(
            source_snapshot_activation::Request {
                schema_version: 1,
                sources: ["s2", "s1"]
                    .into_iter()
                    .map(|source_id| source_snapshot_activation::SourceRevision {
                        source_id: source_id.into(),
                        source_revision: "1".into(),
                    })
                    .collect(),
                query: String::new(),
                preferred_region: None,
                budget_ms: 20_000,
                mode: source_snapshot_activation::Mode::Refresh,
                expected_catalog_revision: f.store.read_snapshot().unwrap().catalog_revision,
                expected_checkpoint_revision: "0".into(),
                alias_provider_ids: Vec::new(),
                demoted_provider_ids: Vec::new(),
            },
            "windows",
            || Ok(()),
        )
        .unwrap();
    let header = prepared.header.unwrap();
    assert_eq!(header.candidate_count, 2);
    assert_eq!(
        f.c()
            .query_row(
                "SELECT source_id FROM source_activation_row WHERE manifest_id=?1 AND ordinal=0",
                [&header.manifest_id],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
        "s1"
    );
}

#[test]
fn cleanup_does_not_block_first_refresh_with_reviewed_providers_and_no_catalog_record() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let provider = json!({"id":"included","name":"Included source","location":"https://lists.invalid/first.m3u","allowHttp":false,"provenance":"https://lists.invalid/about"});
    let prefs = json!({"schemaVersion":1,"sources":[],"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":300,"reviewedChannelProviders":[provider]});
    store.write("preferences", &prefs.to_string()).unwrap();
    let f = Fixture {
        _root: root,
        store,
        catalog: json!({"sources":[],"channels":[]}),
        prefs,
        now: scan_now(),
    };
    assert!(f.store.read_snapshot().unwrap().pair.catalog.is_none());
    let r = f.round();
    assert_eq!(configuration(&f.c()).unwrap().0.len(), 1);
    let definition = configuration(&f.c()).unwrap().0[0].clone();
    f.promote_definition(definition, vec![entry(&["https://streams.invalid/new"])]);
    let p = f.prepare(&r);
    assert!(p.coverage_complete);
    assert!(p.targets.is_empty());
    let receipt = f.commit(&p, &[]);
    assert_eq!(receipt.archived_count, 0);
    assert_eq!(receipt.catalog_revision, "0");
    assert!(f.store.read_snapshot().unwrap().pair.catalog.is_none());
}

#[test]
fn completed_absence_and_native_404_archive_canonical_preferences_atomically_and_remain_restorable()
{
    let f = Fixture::new(&["https://streams.invalid/retired"]);
    let r = f.round();
    f.empty_all();
    let before = f.store.read_snapshot().unwrap();
    let p = f.prepare(&r);
    assert!(p.coverage_complete);
    assert_eq!(p.targets.len(), 1);
    let result = f.commit(&p, &f.facts(&p, Some(404)));
    assert_eq!(result.archived_count, 1);
    assert_eq!(result.catalog_revision, before.catalog_revision);
    assert_eq!(f.preferences()["removedChannels"], json!(["c"]));
    let c = f.c();
    assert_eq!(
        c.query_row("SELECT count(*) FROM removed WHERE id='c'", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM channel WHERE id='c'", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM channel_url WHERE channel_id='c'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(revisions(&c).unwrap().2.to_string(), result.view_revision);
    assert!(
        result.health_revision.parse::<u64>().unwrap()
            > before.health_revision.parse::<u64>().unwrap()
    );
    assert_eq!(
        f.store.read_snapshot().unwrap().pair.catalog,
        before.pair.catalog
    );
    let mut restored = f.preferences();
    restored["removedChannels"] = json!([]);
    f.store.write("preferences", &restored.to_string()).unwrap();
    assert_eq!(f.preferences()["removedChannels"], json!([]));
    assert_eq!(f.preferences()["volume"], f.prefs["volume"]);
    assert!(f.store.root.join(BACKUP).exists());
}

#[test]
fn missing_only_or_incomplete_alternative_never_archives() {
    let f = Fixture::new(&["https://streams.invalid/one", "https://streams.invalid/two"]);
    let r = f.round();
    f.empty_all();
    let p = f.prepare(&r);
    let facts = f.facts(&p, Some(404));
    let result = f.commit(&p, &facts[..1]);
    assert_eq!(result.archived_count, 0);
    assert_eq!(result.deferred_count, 1);
    assert_eq!(f.preferences()["removedChannels"], json!([]));
}

#[test]
fn auth_network_busy_timeout_and_success_answers_are_never_hard_dead_authority() {
    for status in [
        None,
        Some(200),
        Some(301),
        Some(401),
        Some(403),
        Some(408),
        Some(425),
        Some(429),
        Some(451),
        Some(500),
        Some(503),
    ] {
        let f = Fixture::new(&["https://streams.invalid/one"]);
        let r = f.round();
        f.empty_all();
        let p = f.prepare(&r);
        assert_eq!(
            f.commit(&p, &f.facts(&p, status)).archived_count,
            0,
            "{status:?}"
        );
    }
}

#[test]
fn every_current_list_and_backup_url_position_vetoes_absence_regardless_of_label() {
    let f = Fixture::new(&["https://streams.invalid/retired?signature=exact"]);
    let r = f.round();
    f.promote(0, vec![]);
    f.promote(
        1,
        vec![entry(&[
            "https://streams.invalid/other",
            "https://streams.invalid/retired?signature=exact",
        ])],
    );
    let p = f.prepare(&r);
    assert!(p.coverage_complete);
    assert!(p.targets.is_empty());
    assert!(p.candidates.is_empty());
    assert_eq!(f.commit(&p, &[]).archived_count, 0);
    let c = f.c();
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM source_snapshot_transport WHERE url_ordinal=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn any_current_fallback_of_the_saved_channel_vetoes_cleanup() {
    let f = Fixture::new(&[
        "https://streams.invalid/dead",
        "https://streams.invalid/backup",
    ]);
    let r = f.round();
    f.promote(0, vec![entry(&["https://streams.invalid/backup"])]);
    f.promote(1, vec![]);
    let p = f.prepare(&r);
    assert!(p.targets.is_empty());
    assert_eq!(f.commit(&p, &[]).archived_count, 0);
}

#[test]
fn old_absence_after_a_failed_or_unfinished_feed_refresh_is_not_complete_coverage() {
    let f = Fixture::new(&["https://streams.invalid/dead"]);
    f.empty_all();
    let r = f.round();
    f.promote(0, vec![]);
    let source = f.catalog["sources"][1].clone();
    f.store
        .begin_source_snapshot(
            &source_snapshot::Begin {
                schema_version: 1,
                source,
                expected_source_revision: "1".into(),
                entry_count: 1,
                platform: "windows".into(),
                observer_profile: PROFILE.into(),
            },
            || Ok(()),
        )
        .unwrap();
    let p = f.prepare(&r);
    assert!(!p.coverage_complete);
    assert!(p.targets.is_empty());
    let result = f.commit(&p, &[]);
    assert_eq!(result.status, "coverage-incomplete");
    assert_eq!(result.archived_count, 0);
}

#[test]
fn fresh_current_positive_evidence_is_reused_without_a_network_recheck() {
    let f = Fixture::new(&["https://streams.invalid/working"]);
    f.save_health(f.health(0, 200, PROFILE, f.now - 1000, "local", "windows"));
    let r = f.round();
    f.empty_all();
    let p = f.prepare(&r);
    assert!(p.targets.is_empty());
    assert!(p.candidates.is_empty());
    assert_eq!(f.commit(&p, &[]).archived_count, 0);
}

#[test]
fn strict_current_local_404_and_410_cache_facts_preserve_their_original_time() {
    let f = Fixture::new(&["https://streams.invalid/one", "https://streams.invalid/two"]);
    f.save_health(f.health(0, 404, CLEANUP_PROFILE, f.now - 2000, "local", "windows"));
    f.save_health(f.health(1, 410, CLEANUP_PROFILE, f.now - 1000, "local", "windows"));
    let r = f.round();
    f.empty_all();
    let p = f.prepare(&r);
    assert!(p.targets.is_empty());
    assert_eq!(
        p.candidates[0].targets[0]
            .cached
            .as_ref()
            .unwrap()
            .observed_at,
        f.now - 2000
    );
    assert_eq!(f.commit(&p, &[]).archived_count, 1);
}

#[test]
fn a_media_resource_404_is_not_root_dead_proof_even_with_a_current_root_fingerprint() {
    for legacy_profile in [20_000, 45_000, 60_000].map(source_snapshot_activation::profile) {
        let f = Fixture::new(&["https://streams.invalid/recovered.m3u8"]);
        f.save_health(f.health(0, 404, CLEANUP_PROFILE, f.now - 2000, "local", "windows"));
        // Root 200 + expired key/segment 404 is represented this way by the
        // existing media-resource checker, and must require a new root check.
        f.save_health(f.health(0, 404, &legacy_profile, f.now - 1000, "local", "windows"));
        let r = f.round();
        f.empty_all();
        let p = f.prepare(&r);
        assert_eq!(p.targets.len(), 1);
        assert!(p.candidates[0].targets[0].cached.is_none());
        assert_eq!(f.commit(&p, &f.facts(&p, Some(200))).archived_count, 0);
    }
}

#[test]
fn a_newer_ambiguous_resource_failure_vetoes_prepared_cached_or_earlier_live_root_failure() {
    for (cached, tied) in [(false, false), (true, false), (false, true), (true, true)] {
        let f = Fixture::new(&["https://streams.invalid/recovered.m3u8"]);
        if cached {
            f.save_health(f.health(0, 404, CLEANUP_PROFILE, f.now - 1000, "local", "windows"));
        }
        let r = f.round();
        f.empty_all();
        let p = f.prepare(&r);
        assert_eq!(p.targets.len(), usize::from(!cached));
        let facts = f.facts(&p, Some(404));
        // This may be root 200 + child 404, discovered after preparation and
        // after any supplied live root failure. It must invalidate older proof.
        let observed = if tied {
            if cached {
                f.now - 1000
            } else {
                f.now + 200
            }
        } else {
            f.now + 250
        };
        f.save_health(f.health(0, 404, PROFILE, observed, "local", "windows"));
        assert_eq!(f.commit(&p, &facts).archived_count, 0);
        assert_eq!(f.preferences()["removedChannels"], json!([]));
    }
}

#[test]
fn clearing_the_current_cached_failure_invalidates_its_prepared_copy() {
    let f = Fixture::new(&["https://streams.invalid/dead"]);
    f.save_health(f.health(0, 404, CLEANUP_PROFILE, f.now - 1000, "local", "windows"));
    let r = f.round();
    f.empty_all();
    let p = f.prepare(&r);
    assert!(p.targets.is_empty());
    f.c().execute("DELETE FROM channel_health", []).unwrap();
    assert_eq!(f.commit(&p, &[]).archived_count, 0);
}

#[test]
fn imported_foreign_future_expired_and_wrong_profile_failures_do_not_authorize_removal() {
    for (origin, platform, profile, offset) in [
        ("imported", "windows", CLEANUP_PROFILE, 0),
        ("local", "android", CLEANUP_PROFILE, 0),
        ("local", "windows", "old-policy", 0),
        ("local", "windows", CLEANUP_PROFILE, 1),
        ("local", "windows", CLEANUP_PROFILE, -86_400_001),
    ] {
        let f = Fixture::new(&["https://streams.invalid/dead"]);
        let at = if offset == 1 {
            f.now + 10_000
        } else {
            (f.now as i64 + offset) as u64
        };
        f.save_health(f.health(0, 404, profile, at, origin, platform));
        let r = f.round();
        f.empty_all();
        let p = f.prepare(&r);
        assert_eq!(p.targets.len(), 1, "{origin}/{platform}/{profile}/{offset}");
        assert_eq!(f.commit(&p, &[]).archived_count, 0);
    }
}

#[test]
fn positive_arriving_during_network_work_vetoes_an_older_hard_failure_fact() {
    let f = Fixture::new(&["https://streams.invalid/dead"]);
    let r = f.round();
    f.empty_all();
    let p = f.prepare(&r);
    let facts = f.facts(&p, Some(404));
    f.save_health(f.health(
        0,
        200,
        "decoder-v1/html-video-quality-presented-v1",
        f.now + 250,
        "local",
        "windows",
    ));
    assert_eq!(f.commit(&p, &facts).archived_count, 0);
    assert_eq!(f.preferences()["removedChannels"], json!([]));
}

#[test]
fn favorites_manual_removals_and_recovery_data_are_preserved() {
    for field in ["favorites", "removedChannels"] {
        let mut f = Fixture::new(&["https://streams.invalid/dead"]);
        f.prefs[field] = json!(["c"]);
        f.save_config();
        let r = f.round();
        f.empty_all();
        let p = f.prepare(&r);
        assert!(p.targets.is_empty());
        assert_eq!(f.commit(&p, &[]).archived_count, 0);
        assert_eq!(f.preferences()[field], json!(["c"]));
    }
}

#[test]
fn rotated_url_with_a_provider_or_only_matching_identity_is_retained_until_publication() {
    for provider in [false, true] {
        let mut f = Fixture::new(&["https://streams.invalid/old"]);
        if provider {
            f.catalog["channels"][0]["providerId"] = json!("station.id");
            f.save_config();
        }
        let r = f.round();
        let mut replacement = f.catalog["channels"][0].clone();
        replacement["urls"] = json!(["https://streams.invalid/new"]);
        if provider {
            replacement["name"] = json!("New published label");
        }
        f.promote(0, vec![replacement]);
        f.promote(1, vec![]);
        let p = f.prepare(&r);
        assert!(p.targets.is_empty());
        assert_eq!(f.commit(&p, &[]).archived_count, 0);
    }
}

#[test]
fn reappearance_changed_catalog_config_or_cancel_refuses_inflight_commit() {
    for change in ["reappear", "catalog", "grant", "new-round", "cancel"] {
        let mut f = Fixture::new(&["https://streams.invalid/dead"]);
        let r = f.round();
        f.empty_all();
        let p = f.prepare(&r);
        let facts = f.facts(&p, Some(404));
        match change {
            "reappear" => f.promote(1, vec![entry(&["https://streams.invalid/dead"])]),
            "catalog" => {
                f.catalog["channels"][0]["urls"] = json!(["https://streams.invalid/replacement"]);
                f.save_config();
            }
            "grant" => {
                f.prefs["reviewedChannelProviders"] = json!([{"id":"third","name":"New","location":"https://lists.invalid/third.m3u","provenance":"https://lists.invalid/about","allowHttp":true}]);
                f.save_config();
            }
            "new-round" => {
                f.round();
            }
            _ => {
                f.store.cancel_source_cleanup(&r, || Ok(())).unwrap();
            }
        }
        assert!(
            f.store
                .commit_source_cleanup(&p, &facts, "windows", f.now + 300, 1, false, || Ok(()))
                .is_err(),
            "{change}"
        );
        assert_eq!(f.preferences()["removedChannels"], json!([]));
    }
}

#[test]
fn claimed_round_cannot_replay_and_runtime_restart_or_another_root_refuses_old_proof() {
    let f = Fixture::new(&["https://streams.invalid/dead"]);
    let r = f.round();
    f.empty_all();
    let p = f.prepare(&r);
    assert!(f
        .store
        .prepare_source_cleanup(&r, "windows", f.now + 101, || Ok(()))
        .is_err());
    let other = Fixture::new(&["https://streams.invalid/dead"]);
    assert!(other
        .store
        .prepare_source_cleanup(&r, "windows", other.now + 100, || Ok(()))
        .is_err());
    // Reopening even this same root in this process creates a new owner.
    let reopened = PairStore::new(f.store.root.clone()).unwrap();
    assert!(reopened
        .commit_source_cleanup(
            &p,
            &f.facts(&p, Some(404)),
            "windows",
            f.now + 300,
            1,
            false,
            || Ok(())
        )
        .is_err());
    f.c()
        .execute(
            "UPDATE source_cleanup_round SET proof=json_set(proof,'$.runtime','previous-process')",
            [],
        )
        .unwrap();
    assert!(f
        .store
        .commit_source_cleanup(
            &p,
            &f.facts(&p, Some(404)),
            "windows",
            f.now + 300,
            1,
            false,
            || Ok(())
        )
        .is_err());
    assert!(
        f.store
            .cancel_source_cleanup(&r, || Ok(()))
            .unwrap()
            .canceled
    );
    assert!(
        f.store
            .cancel_source_cleanup(&r, || Ok(()))
            .unwrap()
            .canceled
    );
}

#[test]
fn separate_http_grants_require_separate_completed_list_coverage() {
    let mut f = Fixture::new(&["https://streams.invalid/dead"]);
    f.prefs["reviewedChannelProviders"] = json!([{"id":"http-enabled","name":"Allowed","location":"https://lists.invalid:443/one.m3u","provenance":"https://lists.invalid/about","allowHttp":true}]);
    f.save_config();
    let defs = configuration(&f.c()).unwrap().0;
    assert_eq!(defs.len(), 3);
    let r = f.round();
    f.empty_all();
    let p = f.prepare(&r);
    assert!(!p.coverage_complete);
    f.store.cancel_source_cleanup(&r, || Ok(())).unwrap();
    let r = f.round();
    f.empty_all();
    f.promote_definition(defs[2].clone(), vec![]);
    let p = f.prepare(&r);
    assert!(p.coverage_complete);
    f.store.cancel_source_cleanup(&r, || Ok(())).unwrap();
    f.prefs["reviewedChannelProviders"][0]["allowHttp"] = json!(false);
    f.save_config();
    assert_eq!(configuration(&f.c()).unwrap().0.len(), 2);
}

#[test]
fn unknown_file_coverage_retains_channels_and_budget_exhaustion_keeps_unassessed_targets() {
    let mut f = Fixture::new(&["https://streams.invalid/dead"]);
    f.catalog["sources"][1]["kind"] = json!("file");
    f.catalog["sources"][1]["location"] = json!("unknown.m3u");
    f.prefs["sources"] = f.catalog["sources"].clone();
    f.save_config();
    let r = f.round();
    f.promote(0, vec![]);
    let p = f.prepare(&r);
    assert!(!p.coverage_complete);
    assert_eq!(f.commit(&p, &[]).archived_count, 0);
    let f = Fixture::new(&["https://streams.invalid/one", "https://streams.invalid/two"]);
    let r = f.round();
    f.empty_all();
    let p = f.prepare(&r);
    let facts = f.facts(&p, Some(404));
    let result = f
        .store
        .commit_source_cleanup(&p, &facts[..1], "windows", f.now + 300, 1, true, || Ok(()))
        .unwrap();
    assert_eq!(result.status, "budget-exhausted");
    assert_eq!(result.archived_count, 0);
}

#[test]
fn cancellation_at_the_final_precommit_check_rolls_back_preferences_health_and_derived_views() {
    let f = Fixture::new(&["https://streams.invalid/dead"]);
    let r = f.round();
    f.empty_all();
    let p = f.prepare(&r);
    let mut checks = 0;
    f.store
        .commit_source_cleanup(
            &p,
            &f.facts(&p, Some(404)),
            "windows",
            f.now + 300,
            1,
            false,
            || {
                checks += 1;
                Ok(())
            },
        )
        .unwrap();
    let f = Fixture::new(&["https://streams.invalid/dead"]);
    let r = f.round();
    f.empty_all();
    let p = f.prepare(&r);
    let before = f.store.read_snapshot().unwrap();
    let view = revisions(&f.c()).unwrap().2;
    let mut count = 0;
    let result = f.store.commit_source_cleanup(
        &p,
        &f.facts(&p, Some(404)),
        "windows",
        f.now + 300,
        1,
        false,
        || {
            count += 1;
            if count == checks {
                Err("canceled".into())
            } else {
                Ok(())
            }
        },
    );
    assert_eq!(result.unwrap_err(), "canceled");
    assert_eq!(f.store.read_snapshot().unwrap(), before);
    assert_eq!(revisions(&f.c()).unwrap().2, view);
    assert_eq!(
        f.c()
            .query_row("SELECT count(*) FROM removed", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
