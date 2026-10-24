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

//! Guide database tests: indexed suggestions and alias refreshes.

use super::*;

pub(super) fn suggestion_query(id: &str, name: &str) -> GuideSuggestionQuery {
    GuideSuggestionQuery {
        guide_source_id: id.into(),
        expected_source_revision: 2,
        expected_published_revision: Some(2),
        provider_id: None,
        name: name.into(),
    }
}

#[test]
fn indexed_suggestions_preserve_exact_provider_precedence_and_complete_name_scope() {
    let mut f = fixture();
    let mut data = feed("X");
    data.channels[0].names = vec!["ＦＯＯ  News".into(), "Foo News".into()];
    data.channels.push(GuideChannel {
        id: "other".into(),
        names: vec!["Foo News HD".into()],
    });
    save_source(&mut f.c, &source("g"), 0).unwrap();
    replace_guide(&mut f.c, "g", 1, &data, 3000, &AtomicBool::new(false)).unwrap();
    install(&mut f.c, "elsewhere", "Y");
    let mut q = suggestion_query("g", "foo\u{feff}news");
    let found = lookup_suggestions(&f.c, &q).unwrap();
    assert!(matches!(found.r#match, SuggestionMatch::DisplayName));
    assert_eq!(found.candidate_count, 1); // repeated normalized aliases do not create ambiguity
    assert_eq!(found.candidates_preview[0].xmltv_channel_id, "xml-a");
    assert!(found.review_required);
    q.provider_id = Some("other".into());
    assert!(matches!(
        lookup_suggestions(&f.c, &q).unwrap().r#match,
        SuggestionMatch::ProviderId
    ));
    q.provider_id = Some("OTHER".into());
    assert!(matches!(
        lookup_suggestions(&f.c, &q).unwrap().r#match,
        SuggestionMatch::DisplayName
    ));
    q.provider_id = None;
    q.name = "foo".into();
    assert_eq!(lookup_suggestions(&f.c, &q).unwrap().candidate_count, 0); // no substring/HD stripping
    q.name = "Channel A".into();
    assert_eq!(lookup_suggestions(&f.c, &q).unwrap().candidate_count, 0); // no cross-source names
}

#[test]
fn suggestion_ambiguity_counts_every_match_but_preview_is_bounded_and_revision_fenced() {
    let mut f = fixture();
    let mut data = feed("X");
    data.channels = (0..25)
        .map(|n| GuideChannel {
            id: format!("id-{n:02}"),
            names: vec!["Same".into(), "SAME".into()],
        })
        .collect();
    data.programs.clear();
    save_source(&mut f.c, &source("g"), 0).unwrap();
    replace_guide(&mut f.c, "g", 1, &data, 3000, &AtomicBool::new(false)).unwrap();
    let mut q = suggestion_query("g", "same");
    let result = lookup_suggestions(&f.c, &q).unwrap();
    assert!(matches!(result.r#match, SuggestionMatch::Ambiguous));
    assert_eq!(result.candidate_count, 25);
    assert_eq!(result.candidates_preview.len(), 20);
    assert!(!result.preview_complete);
    q.expected_source_revision = 1;
    assert!(lookup_suggestions(&f.c, &q).is_err());
    q.expected_source_revision = 2;
    let mut edited = source("g");
    edited.revision = 2;
    edited.location = "https://guide.example/new".into();
    save_source(&mut f.c, &edited, 2).unwrap();
    assert!(lookup_suggestions(&f.c, &q).is_err());
    q.expected_source_revision = 3;
    let stale = lookup_suggestions(&f.c, &q).unwrap();
    assert!(matches!(stale.cache_status, SuggestionCacheStatus::Stale));
    assert_eq!(stale.candidate_count, 0);
    assert!(stale.candidates_preview.is_empty());
    save_source(&mut f.c, &source("new"), 0).unwrap();
    q.guide_source_id = "new".into();
    q.expected_source_revision = 1;
    q.expected_published_revision = None;
    assert!(matches!(
        lookup_suggestions(&f.c, &q).unwrap().cache_status,
        SuggestionCacheStatus::Unavailable
    ));
}

#[test]
fn alias_refresh_cancellation_rolls_back_and_survives_file_reopen() {
    let mut f = fixture();
    install(&mut f.c, "g", "X");
    let mut data = feed("New");
    data.channels[0].names = vec!["Changed".into()];
    let flag = AtomicBool::new(false);
    assert!(replace_inner(&mut f.c, "g", 2, &data, 4000, &flag, |p| {
        if p == usize::MAX {
            flag.store(true, Ordering::Release);
        }
        Ok(())
    })
    .is_err());
    let path = f._dir.path().join("guide.sqlite3");
    drop(f.c);
    let reopened = Connection::open(path).unwrap();
    assert_eq!(
        lookup_suggestions(&reopened, &suggestion_query("g", "Channel A"))
            .unwrap()
            .candidate_count,
        1
    );
    assert_eq!(
        lookup_suggestions(&reopened, &suggestion_query("g", "Changed"))
            .unwrap()
            .candidate_count,
        0
    );
}

#[test]
fn suggestions_migration_backfills_atomically_and_refuses_invalid_names() {
    let mut f = fixture();
    install(&mut f.c, "g", "X");
    f.c.execute_batch("DROP TABLE guide_channel_name;PRAGMA user_version=3")
        .unwrap();
    f.c.execute("UPDATE guide_channel SET names_json='[]'", [])
        .unwrap();
    assert!(migrate_suggestions(&mut f.c).is_err());
    assert_eq!(
        f.c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        f.c.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='guide_channel_name'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    f.c.execute("UPDATE guide_channel SET names_json='[\"Ｃhannel A\"]'", [])
        .unwrap();
    migrate_suggestions(&mut f.c).unwrap();
    migrate_suggestions(&mut f.c).unwrap();
    migrate(&mut f.c).unwrap();
    assert_eq!(
        lookup_suggestions(&f.c, &suggestion_query("g", "channel a"))
            .unwrap()
            .candidate_count,
        1
    );
    let plan: String =
        f.c.query_row(
            "EXPLAIN QUERY PLAN SELECT channel_id FROM guide_channel_name WHERE guide_source_id='g' AND normalized_name='channel a'",
            [],
            |r| r.get(3),
        )
        .unwrap();
    assert!(plan.contains("guide_channel_name_exact"));
}
