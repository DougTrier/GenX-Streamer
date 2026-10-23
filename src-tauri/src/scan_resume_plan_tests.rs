//! Deterministic first-stage admission/ownership tests; not OS crypto or endpoint proof.
use super::*;
type Fixture = (Value, Value, Value, Vec<Value>, Vec<Entry>, Fence, u64);
pub(crate) fn fixture(count: usize) -> Fixture {
    fixture_category(count, "News")
}
fn fixture_category(count: usize, category: &str) -> Fixture {
    let now = 100_000;
    let source = json!({"id":"source","name":"Fixture public","kind":"url","location":"https://example.com/index.m3u","allowHttp":false});
    let catalog = json!({"schemaVersion":1,"sources":[source.clone()],"channels":[]});
    let prefs = json!({"schemaVersion":1,"sources":[source.clone()],"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":300.0});
    let entries: Vec<_> = (0..count)
        .map(|candidate_index| Entry {
            candidate_index,
            urls: vec![format!(
                "https://example.com/live/station/{candidate_index}.m3u8?public=1#metadata"
            )],
        })
        .collect();
    let candidates:Vec<_>=entries.iter().map(|entry|json!({"key":format!("key-{}",entry.candidate_index),"sourceId":"source","sourceFingerprint":"capture","sessionRevision":"session","channel":{"sourceId":"source","providerId":format!("provider-{}",entry.candidate_index),"name":format!("Station {}",entry.candidate_index),"category":category,"urls":entry.urls}})).collect();
    let mut raw = json!({"schemaVersion":1,"jobId":"job","createdAtMs":now,"catalogRevision":"1","sourceDefinitions":[{"source":source.clone(),"definitionFingerprint":crate::scan_checkpoint::source_fingerprint(&source).unwrap()}],"budgetMs":20000,"platform":"android","observerProfile":"fixture","review":{"sessionRevision":"session","query":"","status":"completed","sources":[{"sourceId":"source","fingerprint":"capture","status":"completed","inspected":count,"matched":count,"warnings":0}],"candidates":candidates,"counts":{"inspected":count,"matched":count,"failedSources":0,"canceledSources":0}},"observations":[],"publishedKeys":[]});
    raw["policyFingerprint"] =
        json!(crate::scan_checkpoint::policy_fingerprint(&raw, &prefs).unwrap());
    let raw = crate::scan_checkpoint::packed_fixture(&raw);
    let metadata = (0..count)
        .map(|i| crate::scan_checkpoint::resume_candidate(&raw, i).unwrap())
        .collect();
    (
        raw,
        prefs,
        catalog,
        metadata,
        entries,
        Fence {
            root_generation: 7,
            catalog: 1,
            health: 1,
            checkpoint: 1,
        },
        now,
    )
}
fn admit(
    raw: &Value,
    prefs: &Value,
    catalog: &Value,
    fence: Fence,
    now: u64,
) -> Result<Plan, String> {
    Plan::admit(
        &raw.to_string(),
        Context {
            preferences: prefs,
            catalog,
            fence,
            now,
            platform: "android",
            observer_profile: "fixture",
        },
        &mut || Ok(()),
    )
}
#[test]
fn complete_admission_retains_no_review_or_urls_and_bounds_page() {
    let (raw, prefs, catalog, metadata, entries, fence, now) = fixture(65);
    let plan = admit(&raw, &prefs, &catalog, fence, now).unwrap();
    assert!(plan.header()["review"].get("candidates").is_none());
    assert!(plan.header().get("observations").is_none());
    assert!(plan.header().get("categoryTable").is_none());
    assert!(!plan.header().to_string().contains("station/"));
    assert_eq!(plan.candidate_hashes.len(), 65);
    let header = plan.public_header("native-plan").unwrap();
    assert_eq!(header["schemaVersion"], 1);
    assert!(header.get("review").is_none());
    assert!(header.get("observations").is_none());
    assert_eq!(
        header["sourcePolicies"][0]["capturedFingerprint"],
        "capture"
    );
    assert_eq!(
        plan.counts(),
        Counts {
            total: 65,
            checked: 0,
            responded: 0,
            published: 0
        }
    );
    let page = plan
        .page(
            PageInput {
                fence,
                now,
                start: 0,
                metadata: &metadata[..64],
                entries: &entries[..64],
            },
            &mut || Ok(()),
        )
        .unwrap();
    assert_eq!(page.rows.len(), 64);
    assert_eq!(page.next_index, 64);
    assert_eq!(
        page.rows[0].candidate["channel"]["urls"],
        json!(entries[0].urls)
    );
    assert!(page.rows[0].candidate.get("reference").is_none());
    assert!(plan
        .page(
            PageInput {
                fence,
                now,
                start: 0,
                metadata: &metadata,
                entries: &entries
            },
            &mut || Ok(())
        )
        .is_err());
}
#[test]
fn original_and_directory_require_exact_hash_order_and_primary_reference() {
    let (raw, prefs, catalog, metadata, entries, fence, now) = fixture(2);
    let plan = admit(&raw, &prefs, &catalog, fence, now).unwrap();
    assert_eq!(plan.fence(), fence);
    plan.verify_original(0, &metadata[0], &entries[0].urls)
        .unwrap();
    assert!(plan
        .verify_original(0, &metadata[1], &entries[1].urls)
        .is_err());
    assert!(plan
        .verify_original(0, &metadata[0], &entries[1].urls)
        .is_err());
    assert!(plan
        .verify_original(2, &metadata[0], &entries[0].urls)
        .is_err());
    let rows = metadata
        .iter()
        .zip(&entries)
        .map(
            |(m, e)| crate::scan_candidate_manifest::origin_directory::OriginRow {
                ordinal: e.candidate_index,
                metadata_hash: hash(m).unwrap(),
                primary_url_hash: reference_hash(&m["reference"]["urlHashes"][0]).unwrap(),
                origin_token: crate::scan_candidate_manifest::origin_directory::origin_token(
                    &e.urls[0],
                )
                .unwrap(),
            },
        )
        .collect();
    let mut directory = crate::scan_candidate_manifest::origin_directory::AdmittedDirectory {
        manifest_id: "fixture".into(),
        manifest_revision: "1".into(),
        origin_revision: "1".into(),
        rows,
    };
    plan.validate_directory(&directory).unwrap();
    directory.rows.swap(0, 1);
    assert!(plan.validate_directory(&directory).is_err());
    directory.rows.swap(0, 1);
    directory.rows[0].primary_url_hash[0] ^= 1;
    assert!(plan.validate_directory(&directory).is_err());
}
#[test]
fn full_digest_ttl_profile_source_admission_not_summary() {
    let (mut raw, prefs, catalog, _, _, fence, now) = fixture(1);
    assert_eq!(
        admit(
            &raw,
            &prefs,
            &catalog,
            fence,
            now + crate::scan_checkpoint::DAY + 1
        )
        .err()
        .unwrap(),
        "scan-checkpoint-expired"
    );
    assert_eq!(
        Plan::admit(
            &raw.to_string(),
            Context {
                preferences: &prefs,
                catalog: &catalog,
                fence,
                now,
                platform: "windows",
                observer_profile: "fixture"
            },
            &mut || Ok(())
        )
        .err()
        .unwrap(),
        "scan-resume-profile-stale"
    );
    raw["review"]["candidates"][0][3] = json!("Tampered");
    assert!(admit(&raw, &prefs, &catalog, fence, now).is_err());
    let (raw, mut prefs, mut catalog, _, _, fence, now) = fixture(1);
    prefs["sources"] = json!([]);
    prefs["reviewedChannelProviders"] = json!([]);
    catalog["sources"] = json!([]);
    assert!(admit(&raw, &prefs, &catalog, fence, now).is_err());
}
#[test]
fn page_rejects_swapped_metadata_urls_ordinals_epoch_and_cancel() {
    let (raw, prefs, catalog, mut metadata, mut entries, fence, now) = fixture(2);
    let plan = admit(&raw, &prefs, &catalog, fence, now).unwrap();
    metadata.swap(0, 1);
    assert!(plan
        .page(
            PageInput {
                fence,
                now,
                start: 0,
                metadata: &metadata,
                entries: &entries
            },
            &mut || Ok(())
        )
        .is_err());
    metadata.swap(0, 1);
    entries.swap(0, 1);
    assert!(plan
        .page(
            PageInput {
                fence,
                now,
                start: 0,
                metadata: &metadata,
                entries: &entries
            },
            &mut || Ok(())
        )
        .is_err());
    entries.swap(0, 1);
    entries[0].urls[0].push_str("tamper");
    assert!(plan
        .page(
            PageInput {
                fence,
                now,
                start: 0,
                metadata: &metadata,
                entries: &entries
            },
            &mut || Ok(())
        )
        .is_err());
    let mut next = fence;
    next.root_generation += 1;
    assert_eq!(
        plan.check_fence(next, now).unwrap_err(),
        "scan-resume-plan-stale"
    );
    assert_eq!(
        plan.page(
            PageInput {
                fence,
                now,
                start: 0,
                metadata: &metadata,
                entries: &entries
            },
            &mut || Err("canceled".into())
        )
        .err()
        .unwrap(),
        "canceled"
    );
}
#[test]
fn settled_negative_skipped_positive_unack_published_without_reprobe() {
    let (mut raw, prefs, catalog, metadata, entries, fence, now) = fixture(3);
    raw["observations"] = json!([[0,now,"Reachable",{"kind":"recognized-media-response"}],[1,now,"AccessDenied",{"kind":"http","status":403}]]);
    let plan = admit(&raw, &prefs, &catalog, fence, now).unwrap();
    let page = plan
        .page(
            PageInput {
                fence,
                now,
                start: 0,
                metadata: &metadata,
                entries: &entries,
            },
            &mut || Ok(()),
        )
        .unwrap();
    assert_eq!(page.rows.len(), 2);
    assert_eq!(page.rows[0].candidate_index, 0);
    assert_eq!(page.rows[0].work, "publish");
    assert_eq!(
        page.rows[0].observation.as_ref().unwrap()["channelId"],
        "key-0"
    );
    assert_eq!(page.rows[1].candidate_index, 2);
    assert_eq!(page.rows[1].work, "probe");
}
#[test]
fn committed_sql_fences_required_no_client_rebase_or_progress_rewrite() {
    let (mut raw, prefs, catalog, _, _, fence, now) = fixture(1);
    let mut plan = admit(&raw, &prefs, &catalog, fence, now).unwrap();
    raw["observations"] = json!([[0,now,"Reachable",{"kind":"recognized-media-response"}]]);
    let after = Fence {
        health: 2,
        checkpoint: 2,
        ..fence
    };
    let mut receipt = CommitReceipt {
        committed: true,
        catalog_revision: "1".into(),
        health_revision: "2".into(),
        checkpoint_revision: Some("3".into()),
    };
    assert_eq!(
        plan.accept_committed(
            &receipt,
            Context {
                preferences: &prefs,
                catalog: &catalog,
                fence: after,
                now,
                platform: "android",
                observer_profile: "fixture"
            },
            &raw.to_string(),
            &mut || Ok(())
        )
        .unwrap_err(),
        "scan-resume-commit-stale"
    );
    assert_eq!(plan.fence, fence);
    assert_eq!(plan.counts().checked, 0);
    receipt.checkpoint_revision = Some("2".into());
    plan.accept_committed(
        &receipt,
        Context {
            preferences: &prefs,
            catalog: &catalog,
            fence: after,
            now,
            platform: "android",
            observer_profile: "fixture",
        },
        &raw.to_string(),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(plan.counts().responded, 1);
    assert_eq!(plan.fence, after);
    assert!(plan
        .accept_committed(
            &receipt,
            Context {
                preferences: &prefs,
                catalog: &catalog,
                fence: after,
                now,
                platform: "android",
                observer_profile: "fixture"
            },
            &raw.to_string(),
            &mut || Ok(())
        )
        .is_err());
    let newer = Fence {
        checkpoint: 3,
        ..after
    };
    receipt.checkpoint_revision = Some("3".into());
    raw["observations"] = json!([[0,now,"AccessDenied",{"kind":"http","status":403}]]);
    assert_eq!(
        plan.accept_committed(
            &receipt,
            Context {
                preferences: &prefs,
                catalog: &catalog,
                fence: newer,
                now,
                platform: "android",
                observer_profile: "fixture"
            },
            &raw.to_string(),
            &mut || Ok(())
        )
        .unwrap_err(),
        "scan-resume-progress-conflict"
    );
    assert_eq!(plan.counts().responded, 1);
}
#[test]
fn thirteen_thousand_compact_plan_does_not_retain_candidate_graph() {
    let (raw, prefs, catalog, metadata, entries, fence, now) = fixture(13_000);
    let plan = admit(&raw, &prefs, &catalog, fence, now).unwrap();
    assert_eq!(
        plan.candidate_hashes.len() * std::mem::size_of::<[u8; 32]>(),
        416_000
    );
    assert!(plan.header.to_string().len() < 4096);
    assert!(plan.progress.iter().all(|p| p.observation.is_none()));
    let page = plan
        .page(
            PageInput {
                fence,
                now,
                start: 12_992,
                metadata: &metadata[12_992..],
                entries: &entries[12_992..],
            },
            &mut || Ok(()),
        )
        .unwrap();
    assert_eq!(page.rows.len(), 8);
    assert_eq!(page.next_index, 13_000);
}
#[test]
fn full_review_variant_ambiguity_retained_privately() {
    let (mut raw, prefs, catalog, _, _, fence, now) = fixture(2);
    raw["review"]["candidates"][1][2] = raw["review"]["candidates"][0][2].clone();
    crate::scan_checkpoint::packed_redigest(&mut raw);
    let plan = admit(&raw, &prefs, &catalog, fence, now).unwrap();
    let c = crate::scan_checkpoint::resume_candidate(&raw, 0).unwrap();
    assert_eq!(
        plan.reconciliation_ambiguous(&c["channel"]).unwrap(),
        (true, false)
    );
}
#[test]
fn published_membership_is_native_authority_and_cached_counts_exact() {
    let (mut raw, prefs, mut catalog, metadata, entries, fence, now) = fixture(2);
    let mut channel = metadata[0]["channel"].clone();
    channel["id"] = json!("saved-id");
    channel["urls"] = json!(entries[0].urls);
    catalog["channels"] = json!([channel]);
    raw["observations"] = json!([[0,now,"Reachable",{"kind":"recognized-media-response"}]]);
    raw["publishedIndices"] = json!([0]);
    let plan = admit(&raw, &prefs, &catalog, fence, now).unwrap();
    let counts = Counts {
        total: 2,
        checked: 1,
        responded: 1,
        published: 1,
    };
    assert_eq!(plan.counts(), counts);
    assert_eq!(plan.counts(), counts);
    let page = plan
        .page(
            PageInput {
                fence,
                now,
                start: 0,
                metadata: &metadata,
                entries: &entries,
            },
            &mut || Ok(()),
        )
        .unwrap();
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].candidate_index, 1);
    catalog["channels"] = json!([]);
    assert_eq!(
        admit(&raw, &prefs, &catalog, fence, now).err().unwrap(),
        "scan-checkpoint-unpublished-channel"
    );
}
#[test]
fn metadata_normalization_matches_explicit_en_us_vectors() {
    assert_eq!(normalized(&json!(" ΟΣ ")).unwrap(), "ος");
    assert_eq!(normalized(&json!("ΟΣΑ")).unwrap(), "οσα");
    assert_eq!(normalized(&json!("İ")).unwrap(), "i\u{307}");
    assert_eq!(normalized(&json!("ＦＯＯ ")).unwrap(), "foo");
    assert_eq!(normalized(&json!("\u{feff}ＦＯＯ\u{feff}")).unwrap(), "foo");
    assert_eq!(
        normalized(&json!("\u{85}FOO\u{85}")).unwrap(),
        "\u{85}foo\u{85}"
    );
}

#[test]
fn long_shared_category_subpages_preserve_every_exact_original_ordinal() {
    let category = "x".repeat(16_384);
    let (raw, prefs, catalog, metadata, entries, fence, now) = fixture_category(128, &category);
    let plan = admit(&raw, &prefs, &catalog, fence, now).unwrap();
    let mut visited = Vec::new();
    let mut cursor = 0;
    let mut subpages = 0;
    while cursor < 128 {
        let boundary = ((cursor / 64) + 1) * 64;
        let page = plan
            .page(
                PageInput {
                    fence,
                    now,
                    start: cursor,
                    metadata: &metadata[cursor..boundary],
                    entries: &entries[cursor..boundary],
                },
                &mut || Ok(()),
            )
            .unwrap();
        assert!(page.next_index > cursor);
        assert!(page.next_index <= boundary);
        assert!(serde_json::to_vec(&page).unwrap().len() <= PAGE_BYTES);
        for row in &page.rows {
            assert_eq!(row.candidate["channel"]["category"], category);
            assert_eq!(
                row.candidate["channel"]["urls"],
                json!(entries[row.candidate_index].urls)
            );
            visited.push(row.candidate_index);
        }
        cursor = page.next_index;
        subpages += 1;
    }
    assert!(subpages > 2);
    assert_eq!(visited, (0..128).collect::<Vec<_>>());
}
