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

fn scope() -> Scope {
    Scope {
        sport: None,
        league: None,
        include_ppv: false,
        window_start_ms: 1_000,
        window_end_ms: 1_000 + WEEK,
        vocabulary_version: registry().vocabulary_version.clone(),
    }
}

#[test]
fn ascii_token_fast_path_matches_unicode_definition() {
    for byte in 0u8..=127 {
        let text = format!("NFL{}Bears_01 / MLB\tP.P.V.3", char::from(byte));
        assert_eq!(tokens(&text), unicode_tokens(&text), "ASCII byte {byte}");
    }
    for text in [
        "NFL Chicago Bears at Green Bay Packers",
        "ＰＰＶ　ＮＦＬ",
        "Fußball CAFÉ NCAAF",
        "Équipe １２３ \u{200d} 東京",
        "İSTANBUL K NHL",
    ] {
        assert_eq!(tokens(text), unicode_tokens(text));
    }
}

#[test]
fn necessary_evidence_prefilter_preserves_all_rule_and_context_candidates() {
    let r = registry();
    let aliases = r
        .sports
        .iter()
        .flat_map(|v| &v.evidence_aliases)
        .chain(r.leagues.iter().flat_map(|v| &v.evidence_aliases))
        .chain(r.teams.iter().flat_map(|v| &v.evidence_aliases))
        .chain(r.teams.iter().flat_map(|v| &v.contextual_aliases));
    for alias in aliases {
        for prefix in ["Before", "Préfixe 東京"] {
            let fields = vec![
                format!("{prefix} {alias} After"),
                "Cached description".into(),
            ];
            assert!(possible_evidence(&fields), "{alias}");
            assert_eq!(facts_fields(&fields), compute_facts(&fields));
        }
    }
    for n in 0..1000 {
        let fields = vec![
            format!("Ordinary programme {n}"),
            format!("Cached episode description {n}"),
        ];
        assert!(!possible_evidence(&fields));
        assert_eq!(facts_fields(&fields), compute_facts(&fields));
    }
    for text in ["東京", "Cafe\u{301}", "東京NFL", "ＮＦＬive", "éＮＦＬ"] {
        let fields = vec![text.into()];
        assert!(!possible_evidence(&fields), "{text}");
        assert_eq!(facts_fields(&fields), compute_facts(&fields));
    }
    for text in [
        "ＮＦＬ",
        "Chicago\u{200d}Bears",
        "東京 NFL",
        "ＮＦＬ\u{0307}",
        "ＮＦＬ_日本",
        "Ｂｅａｒｓ",
    ] {
        let fields = vec![text.into()];
        assert!(possible_evidence(&fields));
        assert_eq!(facts_fields(&fields), compute_facts(&fields));
    }
}

#[test]
fn query_fact_memo_reuses_exact_inputs_without_context_leakage() {
    let mut s = scope();
    s.sport = Some("american-football".into());
    s.league = Some("nfl".into());
    let p = Plan::new(&s, "").unwrap();
    let neutral = vec!["FOX".into(), "News".into(), "News".into()];
    let nfl = vec!["FOX".into(), "NFL".into(), "News".into()];
    let nba = vec!["FOX".into(), "NBA".into(), "News".into()];
    let mascot = vec!["Bears at Packers".into(), "Cached title".into()];
    let before = fact_calls();
    assert!(!p.program_fields(&neutral, &mascot, false));
    assert!(p.program_fields(&nfl, &mascot, false));
    assert!(p.program_fields(&nfl, &mascot, true));
    assert!(!p.program_fields(&neutral, &mascot, true));
    assert!(!p.program_fields(&nba, &mascot, false));
    assert_eq!(
        fact_calls() - before,
        4,
        "three exact channels and one programme"
    );
    let conflicting = vec!["NBA Basketball".into(), "Cached title".into()];
    assert!(!p.program_fields(&nfl, &conflicting, false));
    assert!(p.program_fields(&nfl, &mascot, false));
    assert_eq!(fact_calls() - before, 5, "mutated programme is recomputed");
    let mut fresh = scope();
    fresh.sport = Some("basketball".into());
    let other = Plan::new(&fresh, "").unwrap();
    assert!(other.program_fields(&nba, &conflicting, false));
    assert!(!p.program_fields(&nba, &conflicting, false));
}

#[test]
fn query_fact_memo_caps_entries_and_retained_text() {
    let mut memo = FactMemo::default();
    for n in 0..FACT_MEMO_ENTRIES + 5 {
        memo.insert(&[format!("Channel {n}")], Arc::new(Facts::default()));
        assert!(memo.entries.len() <= FACT_MEMO_ENTRIES);
        assert!(memo.bytes <= FACT_MEMO_BYTES);
    }
    let entries = memo.entries.len();
    let bytes = memo.bytes;
    memo.insert(
        &["x".repeat(FACT_MEMO_BYTES + 1)],
        Arc::new(Facts::default()),
    );
    assert_eq!(memo.entries.len(), entries);
    assert_eq!(memo.bytes, bytes, "oversized values bypass the cache");
}
#[test]
fn conservative_full_teams_leagues_and_contextual_mascots() {
    for query in ["NFL", "National Football League", "Football"] {
        let plan = Plan::new(&scope(), query).unwrap();
        assert!(plan.channel("Chicago Bears at Green Bay Packers"));
        assert!(!plan.channel("Bears vs Cardinals"));
        assert!(!plan.channel("NCAA college championship"));
        assert!(!plan.channel("Manchester City at Chelsea"));
    }
    let plan = Plan::new(&scope(), "Chicago Bears").unwrap();
    assert!(plan.program("NFL 12", "Bears at Packers"));
    assert!(!plan.program("", "Bears at Packers"));
    assert!(!plan.program("NFL 12", "MLB Cardinals at Giants"));
    assert!(!plan.program("NFL 12", "NBA Basketball: Bears at Packers"));
    let literal = Plan::new(&scope(), "Bears").unwrap();
    assert!(literal.channel("Bears documentary"));
    assert!(!literal.specific);
}
#[test]
fn facet_evidence_and_leftover_tokens_are_cumulative() {
    let mut s = scope();
    s.sport = Some("american-football".into());
    let p = Plan::new(&s, "NFL live").unwrap();
    assert!(p.channel("Chicago Bears Live HD"));
    assert!(!p.channel("Chicago Bears Replay"));
    assert!(!p.channel("Soccer Football Live"));
    assert!(p.program("FOX", "Live Chicago Bears at Detroit Lions"));
    assert!(!p.program("FOX", "News at Nine"));
    assert!(Plan::new(&s, "college")
        .unwrap()
        .program("", "College Football"));
    assert!(!Plan::new(&s, "college")
        .unwrap()
        .program("", "College Basketball"));
}
#[test]
fn only_specific_intent_can_include_ppv_and_scope_is_bounded() {
    let mut s = scope();
    s.include_ppv = true;
    for q in ["NFL", "Chicago Bears", "Basketball"] {
        assert!(Plan::new(&s, q).unwrap().include_ppv());
    }
    for q in ["football", "Bears", "Chicago", "NCAA", ""] {
        assert!(Plan::new(&s, q).is_err(), "{q}");
    }
    s.league = Some("nfl".into());
    assert!(Plan::new(&s, "").is_ok());
    s.sport = Some("soccer".into());
    assert!(Plan::new(&s, "").is_err());
    s = scope();
    s.window_end_ms += 1;
    assert!(Plan::new(&s, "NFL").is_err());
    s = scope();
    s.vocabulary_version = "old".into();
    assert!(Plan::new(&s, "NFL").is_err());
}
#[test]
fn unicode_boundaries_match_registry_policy() {
    let p = Plan::new(&scope(), "ＮＦＬ").unwrap();
    assert!(p.channel("ＮＦＬ games"));
    assert!(p.channel("NFL\u{0345}"));
    assert!(!p.channel("N\u{0345}FL"));
    assert!(p.channel("conflict NFLive"), "ordinary literal hits remain");
    assert!(
        !p.channel_fields(&["conflict NFLive".into()], true),
        "PPV promotion requires evidence"
    );
}
#[test]
fn programme_category_text_is_evidence_not_language_or_malformed_json() {
    let c = Connection::open_in_memory().unwrap();
    let p = Plan::new(&scope(), "NFL").unwrap();
    register(&c, &p).unwrap();
    let read = |raw: &str| {
        c.query_row(
            "SELECT genx_sports_program('FOX','','','Bears at Packers',NULL,?1,'')",
            [raw],
            |r| r.get::<_, bool>(0),
        )
    };
    assert!(read(r#"[{"text":"NFL","language":"en"}]"#).unwrap());
    assert!(!read(r#"[{"text":"Sports","language":"NFL"}]"#).unwrap());
    assert!(read("invalid").is_err());
}

#[test]
fn shared_row_evidence_golden_corpus() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/sports-classifier-cases.json"
    ))
    .unwrap();
    for case in cases["cases"].as_array().unwrap() {
        let fields = case["texts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        let f = facts_fields(&fields);
        let expected = |key: &str| {
            case[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(f.sports, expected("sports"), "{}", case["id"]);
        assert_eq!(f.leagues, expected("leagues"), "{}", case["id"]);
    }
}

#[test]
fn shared_query_parity_corpus() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/sports-query-cases.json"
    ))
    .unwrap();
    let fields = |v: &serde_json::Value| {
        v.as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    for case in corpus["cases"].as_array().unwrap() {
        let p = Plan::new(&scope(), case["query"].as_str().unwrap()).unwrap();
        assert_eq!(
            p.specific,
            case["specific"].as_bool().unwrap(),
            "{}",
            case["id"]
        );
        for (strict, key) in [(false, "normalMatch"), (true, "strictSemanticMatch")] {
            let result = if case.get("program").is_some() {
                let prog = &case["program"];
                let mut program = vec![
                    prog["title"].as_str().unwrap().to_owned(),
                    prog["description"].as_str().unwrap_or_default().to_owned(),
                ];
                if let Some(categories) = prog["categories"].as_array() {
                    program.extend(
                        categories
                            .iter()
                            .map(|v| v["text"].as_str().unwrap().to_owned()),
                    );
                }
                p.program_fields(&fields(&case["channelTexts"]), &program, strict)
            } else {
                p.channel_fields(&fields(&case["texts"]), strict)
            };
            assert_eq!(result, case[key].as_bool().unwrap(), "{} {key}", case["id"]);
        }
    }
}

#[test]
fn literal_extras_supply_residual_terms_but_never_sport_evidence() {
    let p = Plan::new(&scope(), "NFL Canada").unwrap();
    assert!(p.program_fields_extra(
        &["FOX".into()],
        &["NFL Live".into()],
        &["Canada".into()],
        true
    ));
    assert!(!p.program_fields_extra(
        &["FOX".into()],
        &["Wildlife Bears".into()],
        &["NFL Canada".into()],
        true
    ));
    assert!(!p.program_fields_extra(
        &["NFL 1".into()],
        &["NBA Live".into()],
        &["Canada".into()],
        false
    ));
}
