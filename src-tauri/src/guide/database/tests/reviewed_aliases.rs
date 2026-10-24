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

//! Guide database tests: reviewed Pluto aliases.

use super::*;

pub(super) fn reviewed_fixture() -> (
    Fixture,
    super::super::super::reviewed_aliases::ReviewedAliases,
    ParsedGuide,
) {
    use super::super::super::reviewed_aliases::{AliasPair, ReviewedAliases};
    let mut f = fixture();
    f.c.execute_batch("ALTER TABLE metadata ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 7;ALTER TABLE channel ADD COLUMN provider_id TEXT;UPDATE channel SET provider_id='PGATour.us@SD';").unwrap();
    let mut src = source("pluto");
    src.location =
        "https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/PlutoTV/us.xml.gz".into();
    save_source(&mut f.c, &src, 0).unwrap();
    let mut data = feed("New PGA");
    data.channels[0].id = "5de94dacb394a300099fa22a".into();
    data.programs[0].channel_id = data.channels[0].id.clone();
    let aliases = ReviewedAliases {
        schema_version: 1,
        guide_location: src.location,
        provenance_location: "https://raw.githubusercontent.com/iptv-org/epg/master/sites/pluto.tv/pluto.tv_us.channels.xml".into(),
        provenance_sha256: "dc1eaca8b90b1d227850f81fb02793c74a804c473eb26dd674cd1eaa8084c89e".into(),
        pairs: vec![
            AliasPair {
                catalog_source_id: "catalog-a".into(),
                app_channel_id: "app-a".into(),
                provider_id: "PGATour.us@SD".into(),
                xmltv_channel_id: data.channels[0].id.clone(),
            },
            AliasPair {
                catalog_source_id: "catalog-b".into(),
                app_channel_id: "app-b".into(),
                provider_id: "PGATour.us@SD".into(),
                xmltv_channel_id: data.channels[0].id.clone(),
            },
        ],
    };
    (f, aliases, data)
}

#[test]
fn reviewed_pluto_aliases_publish_distinct_variants_and_retained_aliases_authorize_refresh() {
    let (mut f, aliases, data) = reviewed_fixture();
    let flag = AtomicBool::new(false);
    let receipt = replace_guide_if_matched_with_aliases(
        &mut f.c,
        "pluto",
        1,
        "7",
        &data,
        6000,
        &flag,
        Some(&aliases),
    )
    .unwrap();
    assert!(receipt.committed);
    assert_eq!((receipt.matched, receipt.preserved_mappings), (2, 0));
    let mappings = list_mappings(&f.c).unwrap();
    assert_eq!(mappings.len(), 2);
    assert!(mappings
        .iter()
        .all(|m| m.xmltv_channel_id == data.channels[0].id));
    let receipt = replace_guide_if_matched_with_aliases(
        &mut f.c,
        "pluto",
        2,
        "7",
        &data,
        7000,
        &flag,
        Some(&aliases),
    )
    .unwrap();
    assert!(receipt.committed);
    assert_eq!((receipt.matched, receipt.preserved_mappings), (2, 2));
    assert_eq!(list_mappings(&f.c).unwrap().len(), 2);
}

#[test]
fn reviewed_pluto_aliases_preserve_other_feed_mapping_without_authorizing_empty_publication() {
    let (mut f, aliases, data) = reviewed_fixture();
    install(&mut f.c, "other", "Other");
    save_mapping(&mut f.c, &mapping("other", "app-a", "catalog-a")).unwrap();
    save_mapping(&mut f.c, &mapping("other", "app-b", "catalog-b")).unwrap();
    let before = database_revision(&f.c).unwrap();
    let reply = replace_guide_if_matched_with_aliases(
        &mut f.c,
        "pluto",
        1,
        "7",
        &data,
        6000,
        &AtomicBool::new(false),
        Some(&aliases),
    )
    .unwrap();
    assert!(!reply.committed);
    assert_eq!(reply.matched, 0);
    assert_eq!(database_revision(&f.c).unwrap(), before);
    assert_eq!(source_coverage(&f.c, "pluto").unwrap().program_count, 0);
    assert!(list_mappings(&f.c)
        .unwrap()
        .iter()
        .all(|m| m.guide_source_id == "other"));
}

#[test]
fn reviewed_pluto_aliases_whole_refusal_preserves_schedule_and_revision() {
    let (mut f, aliases, data) = reviewed_fixture();
    let flag = AtomicBool::new(false);
    let before = database_revision(&f.c).unwrap();
    for mut invalid in [
        aliases.clone(),
        aliases.clone(),
        aliases.clone(),
        aliases.clone(),
    ]
    .into_iter()
    .enumerate()
    {
        match invalid.0 {
            0 => invalid.1.provenance_sha256 = "0".repeat(64),
            1 => invalid.1.pairs[0].provider_id = "PGATour.us".into(),
            2 => invalid.1.pairs[0].catalog_source_id = "wrong-source".into(),
            _ => invalid.1.pairs.push(invalid.1.pairs[0].clone()),
        }
        assert!(replace_guide_if_matched_with_aliases(
            &mut f.c,
            "pluto",
            1,
            "7",
            &data,
            6000,
            &flag,
            Some(&invalid.1)
        )
        .is_err());
    }
    assert_eq!(
        replace_guide_if_matched_with_aliases(
            &mut f.c,
            "pluto",
            1,
            "8",
            &data,
            6000,
            &flag,
            Some(&aliases)
        )
        .unwrap_err(),
        "catalog-revision-stale"
    );
    assert_eq!(
        replace_guide_if_matched_with_aliases(
            &mut f.c,
            "pluto",
            2,
            "7",
            &data,
            6000,
            &flag,
            Some(&aliases)
        )
        .unwrap_err(),
        "guide-stale-revision"
    );
    f.c.execute("INSERT INTO removed VALUES('app-a')", [])
        .unwrap();
    assert!(replace_guide_if_matched_with_aliases(
        &mut f.c,
        "pluto",
        1,
        "7",
        &data,
        6000,
        &flag,
        Some(&aliases)
    )
    .is_err());
    assert_eq!(database_revision(&f.c).unwrap(), before);
    assert_eq!(source_coverage(&f.c, "pluto").unwrap().program_count, 0);
    assert!(list_mappings(&f.c).unwrap().is_empty());
}

#[test]
fn reviewed_pluto_aliases_precommit_cancel_rolls_back_and_changed_source_refuses() {
    let (mut f, aliases, data) = reviewed_fixture();
    let flag = AtomicBool::new(false);
    let before = database_revision(&f.c).unwrap();
    let result = match_inner(
        &mut f.c,
        "pluto",
        1,
        Some(7),
        Some(&aliases),
        &data,
        6000,
        &flag,
        || {
            flag.store(true, Ordering::Release);
            Ok(())
        },
    );
    assert_eq!(result.unwrap_err(), "guide-cancelled");
    assert_eq!(database_revision(&f.c).unwrap(), before);
    assert!(list_mappings(&f.c).unwrap().is_empty());
    assert_eq!(source_coverage(&f.c, "pluto").unwrap().program_count, 0);
    flag.store(false, Ordering::Release);
    let mut changed = source("pluto");
    changed.revision = 1;
    changed.location = "https://changed.example/guide".into();
    save_source(&mut f.c, &changed, 1).unwrap();
    assert!(replace_guide_if_matched_with_aliases(
        &mut f.c,
        "pluto",
        2,
        "7",
        &data,
        6000,
        &flag,
        Some(&aliases)
    )
    .is_err());
    assert_eq!(source_coverage(&f.c, "pluto").unwrap().program_count, 0);
}
