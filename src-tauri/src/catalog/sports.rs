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

//! Cached metadata only. Query aliases express intent; they never create row
//! evidence. Every caller keeps its own current mapping/account authority.
use rusqlite::{functions::FunctionFlags, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashMap},
    sync::{Arc, Mutex, OnceLock},
};
use unicode_normalization::UnicodeNormalization;

pub(crate) const VOCABULARY: &str = include_str!("../../../config/sports-vocabulary.json");
const ERR: &str = "sports-query-invalid";
const WEEK: i64 = 7 * 86_400_000;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    #[serde(default)]
    pub sport: Option<String>,
    #[serde(default)]
    pub league: Option<String>,
    #[serde(default)]
    pub include_ppv: bool,
    pub window_start_ms: i64,
    pub window_end_ms: i64,
    pub vocabulary_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    schema_version: u8,
    vocabulary_version: String,
    policy_version: String,
    normalization: String,
    sports: Vec<Sport>,
    leagues: Vec<League>,
    teams: Vec<Team>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sport {
    id: String,
    evidence_aliases: Vec<String>,
    query_aliases: Vec<String>,
    #[serde(default)]
    literal_expansion_aliases: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct League {
    id: String,
    sport_id: String,
    evidence_aliases: Vec<String>,
    query_aliases: Vec<String>,
    #[serde(default)]
    programme_context_aliases: Vec<String>,
    #[serde(default)]
    programme_required_aliases: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Team {
    id: String,
    league_id: String,
    evidence_aliases: Vec<String>,
    query_aliases: Vec<String>,
    #[serde(default)]
    contextual_aliases: Vec<String>,
}
fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let r: Registry = serde_json::from_str(VOCABULARY).expect("checked sports vocabulary");
        assert!(
            r.schema_version == 1
                && r.policy_version == "explicit-sports-v1"
                && r.normalization == "nfkc-lowercase-ln-tokens"
        );
        assert!(r.sports.len() <= 32 && r.leagues.len() <= 128 && r.teams.len() <= 2048);
        r
    })
}
pub(crate) fn tokens(text: &str) -> Vec<String> {
    // NFKC is the identity on ASCII, and Unicode L/N token boundaries are
    // exactly ASCII alphanumeric boundaries there. Avoid the normalizer and
    // regex for the overwhelmingly common cached provider text.
    if text.is_ascii() {
        return text
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|word| !word.is_empty())
            .map(str::to_ascii_lowercase)
            .collect();
    }
    unicode_tokens(text)
}
fn unicode_tokens(text: &str) -> Vec<String> {
    static TOKEN: OnceLock<regex::Regex> = OnceLock::new();
    let text = text.nfkc().collect::<String>().to_lowercase();
    TOKEN
        .get_or_init(|| regex::Regex::new(r"[\p{L}\p{N}]+").expect("fixed sports tokens"))
        .find_iter(&text)
        .map(|m| m.as_str().to_owned())
        .collect()
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Facts {
    sports: BTreeSet<String>,
    leagues: BTreeSet<String>,
    teams: BTreeSet<String>,
    contextual_teams: BTreeSet<String>,
    programme_contexts: BTreeSet<String>,
    programme_evidence: BTreeSet<String>,
}
const FACT_MEMO_ENTRIES: usize = 16_384;
const FACT_MEMO_BYTES: usize = 8 * 1024 * 1024;
#[derive(Default)]
struct FactMemo {
    entries: HashMap<Vec<String>, Arc<Facts>>,
    bytes: usize,
}
impl FactMemo {
    fn insert(&mut self, fields: &[String], facts: Arc<Facts>) {
        // This is a query-local performance cache, never authority. Bound both
        // entry count and retained text/fact storage; an oversized input still
        // receives the exact uncached classification.
        let bytes = 256usize
            .saturating_add(fields.len().saturating_mul(32))
            .saturating_add(fields.iter().map(String::len).sum::<usize>())
            .saturating_add(
                [
                    &facts.sports,
                    &facts.leagues,
                    &facts.teams,
                    &facts.contextual_teams,
                    &facts.programme_contexts,
                    &facts.programme_evidence,
                ]
                .into_iter()
                .flatten()
                .map(|id| id.len() + 128)
                .sum::<usize>(),
            );
        if bytes > FACT_MEMO_BYTES {
            return;
        }
        if self.entries.len() >= FACT_MEMO_ENTRIES
            || self.bytes.saturating_add(bytes) > FACT_MEMO_BYTES
        {
            self.entries.clear();
            self.bytes = 0;
        }
        if !self.entries.contains_key(fields) {
            self.entries.insert(fields.to_vec(), facts);
            self.bytes += bytes;
        }
    }
}
#[derive(Default)]
struct QueryFacts {
    channel: FactMemo,
    program: FactMemo,
}
type Rule = (Vec<String>, Target);
struct Rules {
    evidence: std::collections::HashMap<String, Vec<Rule>>,
    contextual: std::collections::HashMap<String, Vec<Rule>>,
    query: Vec<(Vec<String>, Target, bool)>,
    programme_contexts: std::collections::HashMap<String, Vec<Rule>>,
    programme_evidence: std::collections::HashMap<String, Vec<Rule>>,
}
fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let mut out = Rules {
            evidence: Default::default(),
            contextual: Default::default(),
            query: Vec::new(),
            programme_contexts: Default::default(),
            programme_evidence: Default::default(),
        };
        let mut add = |aliases: &[String], target: Target, contextual: bool| {
            for alias in aliases {
                let words = tokens(alias);
                assert!(!words.is_empty() && words.len() <= 16 && alias.len() <= 256);
                let index = if contextual {
                    &mut out.contextual
                } else {
                    &mut out.evidence
                };
                index
                    .entry(words[0].clone())
                    .or_default()
                    .push((words, target.clone()));
            }
        };
        let r = registry();
        for sport in &r.sports {
            add(
                &sport.evidence_aliases,
                Target::Sport(sport.id.clone()),
                false,
            );
        }
        for league in &r.leagues {
            add(
                &league.evidence_aliases,
                Target::League(league.id.clone()),
                false,
            );
        }
        for team in &r.teams {
            add(&team.evidence_aliases, Target::Team(team.id.clone()), false);
            add(
                &team.contextual_aliases,
                Target::Team(team.id.clone()),
                true,
            );
        }
        for sport in &r.sports {
            for alias in &sport.query_aliases {
                out.query
                    .push((tokens(alias), Target::Sport(sport.id.clone()), true));
            }
            for alias in &sport.literal_expansion_aliases {
                out.query
                    .push((tokens(alias), Target::Sport(sport.id.clone()), false));
            }
        }
        for league in &r.leagues {
            for alias in &league.query_aliases {
                out.query
                    .push((tokens(alias), Target::League(league.id.clone()), true));
            }
        }
        for team in &r.teams {
            for alias in &team.query_aliases {
                out.query
                    .push((tokens(alias), Target::Team(team.id.clone()), true));
            }
        }
        for league in &r.leagues {
            for (aliases, index) in [
                (
                    &league.programme_context_aliases,
                    &mut out.programme_contexts,
                ),
                (
                    &league.programme_required_aliases,
                    &mut out.programme_evidence,
                ),
            ] {
                for alias in aliases {
                    let words = tokens(alias);
                    assert!(!words.is_empty() && words.len() <= 16 && alias.len() <= 256);
                    index
                        .entry(words[0].clone())
                        .or_default()
                        .push((words, Target::League(league.id.clone())));
                }
            }
        }
        out.query
            .sort_by_key(|(a, _, _)| std::cmp::Reverse(a.len()));
        out
    })
}
fn visit_rules(
    words: &[String],
    index: &std::collections::HashMap<String, Vec<Rule>>,
    mut action: impl FnMut(&Target),
) {
    for start in 0..words.len() {
        if let Some(rules) = index.get(&words[start]) {
            for (alias, target) in rules {
                if start + alias.len() <= words.len() && &words[start..start + alias.len()] == alias
                {
                    action(target);
                }
            }
        }
    }
}
#[cfg(test)]
thread_local! {
    static FACT_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static FULL_FACT_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
#[cfg(test)]
pub(crate) fn fact_calls() -> usize {
    FACT_CALLS.with(|v| v.get())
}
#[cfg(test)]
pub(crate) fn full_fact_calls() -> usize {
    FULL_FACT_CALLS.with(|v| v.get())
}
fn possible_evidence(fields: &[String]) -> bool {
    // Every rule must start with one complete token in one field. ASCII needs
    // no allocations; Unicode uses precisely the classifier's normalization
    // and L/N boundaries, without allocating a vector of every word.
    let rules = rules();
    let mut folded = [0u8; 256];
    for field in fields {
        if !field.is_ascii() {
            if unicode_possible_evidence(field) {
                return true;
            }
            continue;
        }
        for word in field.split(|c: char| !c.is_ascii_alphanumeric()) {
            if word.is_empty() || word.len() > folded.len() {
                continue;
            }
            for (out, byte) in folded.iter_mut().zip(word.bytes()) {
                *out = byte.to_ascii_lowercase();
            }
            let word = std::str::from_utf8(&folded[..word.len()]).expect("ASCII lowercase token");
            if rules.evidence.contains_key(word)
                || rules.contextual.contains_key(word)
                || rules.programme_contexts.contains_key(word)
                || rules.programme_evidence.contains_key(word)
            {
                return true;
            }
        }
    }
    false
}
fn unicode_possible_evidence(text: &str) -> bool {
    static FIRST_TOKEN: OnceLock<regex::Regex> = OnceLock::new();
    let first_token = FIRST_TOKEN.get_or_init(|| {
        let r = rules();
        let words: BTreeSet<&str> = r
            .evidence
            .keys()
            .chain(r.contextual.keys())
            .chain(r.programme_contexts.keys())
            .chain(r.programme_evidence.keys())
            .map(String::as_str)
            .collect();
        let alternatives = words
            .into_iter()
            .map(regex::escape)
            .collect::<Vec<_>>()
            .join("|");
        regex::Regex::new(&format!(
            r"(?:^|[^\p{{L}}\p{{N}}])(?:{alternatives})(?:$|[^\p{{L}}\p{{N}}])"
        ))
        .expect("registered sports first tokens")
    });
    let normalized = text.nfkc().collect::<String>().to_lowercase();
    first_token.is_match(&normalized)
}
fn facts_fields(fields: &[String]) -> Facts {
    #[cfg(test)]
    FACT_CALLS.with(|v| v.set(v.get() + 1));
    if !possible_evidence(fields) {
        return Facts::default();
    }
    compute_facts(fields)
}
fn compute_facts(fields: &[String]) -> Facts {
    #[cfg(test)]
    FULL_FACT_CALLS.with(|v| v.set(v.get() + 1));
    let mut f = Facts::default();
    for words in fields.iter().map(|s| tokens(s)) {
        visit_rules(&words, &rules().evidence, |t| match t {
            Target::Sport(id) => {
                f.sports.insert(id.clone());
            }
            Target::League(id) => {
                f.leagues.insert(id.clone());
            }
            Target::Team(id) => {
                f.teams.insert(id.clone());
                let team = registry()
                    .teams
                    .iter()
                    .find(|t| &t.id == id)
                    .expect("registered team");
                f.leagues.insert(team.league_id.clone());
            }
        });
        visit_rules(&words, &rules().contextual, |target| {
            if let Target::Team(id) = target {
                f.contextual_teams.insert(id.clone());
            }
        });
        visit_rules(&words, &rules().programme_contexts, |target| {
            if let Target::League(id) = target {
                f.programme_contexts.insert(id.clone());
            }
        });
        visit_rules(&words, &rules().programme_evidence, |target| {
            if let Target::League(id) = target {
                f.programme_evidence.insert(id.clone());
            }
        });
    }
    contextual(&mut f);
    f
}
fn contextual(f: &mut Facts) {
    for id in &f.contextual_teams {
        let team = registry()
            .teams
            .iter()
            .find(|t| &t.id == id)
            .expect("registered team");
        if f.leagues.contains(&team.league_id) {
            f.teams.insert(id.clone());
        }
    }
    for l in &registry().leagues {
        if f.leagues.contains(&l.id) {
            f.sports.insert(l.sport_id.clone());
        }
    }
}
#[derive(Clone)]
enum Target {
    Sport(String),
    League(String),
    Team(String),
}
impl Target {
    fn matches(&self, f: &Facts) -> bool {
        match self {
            Self::Sport(id) => f.sports.contains(id),
            Self::League(id) => f.leagues.contains(id),
            Self::Team(id) => f.teams.contains(id),
        }
    }
}
#[derive(Clone)]
pub(crate) struct Plan {
    pub scope: Scope,
    literal: String,
    leftover: Vec<String>,
    targets: Vec<Target>,
    pub specific: bool,
    query_specific: bool,
    facts: Arc<Mutex<QueryFacts>>,
}
impl Plan {
    pub(crate) fn new(scope: &Scope, query: &str) -> Result<Self, String> {
        let r = registry();
        if scope.vocabulary_version != r.vocabulary_version
            || scope.window_start_ms < 0
            || scope.window_end_ms > 253_402_351_200_000
            || scope.window_end_ms <= scope.window_start_ms
            || scope.window_end_ms - scope.window_start_ms > WEEK
            || query.len() > 16384
            || scope
                .sport
                .as_ref()
                .is_some_and(|id| !r.sports.iter().any(|s| &s.id == id))
            || scope.league.as_ref().is_some_and(|id| {
                !r.leagues
                    .iter()
                    .any(|l| &l.id == id && scope.sport.as_ref().is_none_or(|s| s == &l.sport_id))
            })
        {
            return Err(ERR.into());
        }
        let words = tokens(query);
        if words.len() > 128 {
            return Err(ERR.into());
        }
        let mut consumed = vec![false; words.len()];
        let mut targets = Vec::new();
        let mut specific = scope.sport.is_some() || scope.league.is_some();
        let mut query_specific = false;
        for (a, target, explicit) in &rules().query {
            if a.is_empty() {
                continue;
            }
            for start in 0..words.len().saturating_sub(a.len()).saturating_add(1) {
                if start + a.len() <= words.len()
                    && words[start..start + a.len()] == *a
                    && !consumed[start..start + a.len()].iter().any(|v| *v)
                {
                    consumed[start..start + a.len()].fill(true);
                    targets.push(target.clone());
                    specific |= *explicit;
                    query_specific |= *explicit;
                }
            }
        }
        if scope.include_ppv && !specific {
            return Err(ERR.into());
        }
        let leftover = words
            .into_iter()
            .zip(consumed)
            .filter_map(|(w, c)| (!c).then_some(w))
            .collect();
        Ok(Self {
            scope: scope.clone(),
            literal: query
                .nfkc()
                .collect::<String>()
                .to_lowercase()
                .trim()
                .into(),
            leftover,
            targets,
            specific,
            query_specific,
            facts: Arc::new(Mutex::new(QueryFacts::default())),
        })
    }
    pub(crate) fn sports_filter(&self) -> bool {
        self.specific || !self.targets.is_empty()
    }
    pub(crate) fn include_ppv(&self) -> bool {
        self.specific && self.scope.include_ppv
    }
    fn facts(&self, fields: &[String], program: bool) -> Arc<Facts> {
        if let Ok(memo) = self.facts.lock() {
            let memo = if program {
                &memo.program
            } else {
                &memo.channel
            };
            if let Some(facts) = memo.entries.get(fields) {
                return facts.clone();
            }
        }
        let facts = Arc::new(facts_fields(fields));
        if let Ok(mut memo) = self.facts.lock() {
            let memo = if program {
                &mut memo.program
            } else {
                &mut memo.channel
            };
            memo.insert(fields, facts.clone());
        }
        facts
    }
    #[cfg(test)]
    fn channel(&self, text: &str) -> bool {
        self.channel_fields(&[text.to_owned()], false)
    }
    fn channel_fields(&self, fields: &[String], strict: bool) -> bool {
        if !self.sports_filter() {
            return !strict
                && (self.literal.is_empty()
                    || fields.iter().any(|s| {
                        s.nfkc()
                            .collect::<String>()
                            .to_lowercase()
                            .contains(&self.literal)
                    }));
        }
        self.matches(fields, &self.facts(fields, false), strict)
    }
    #[cfg(test)]
    fn program(&self, channel: &str, program: &str) -> bool {
        self.program_fields(&[channel.into()], &[program.into()], false)
    }
    #[cfg(test)]
    fn program_fields(&self, channel: &[String], program: &[String], strict: bool) -> bool {
        self.program_fields_extra(channel, program, &[], strict)
    }
    fn program_fields_extra(
        &self,
        channel: &[String],
        program: &[String],
        extra: &[String],
        strict: bool,
    ) -> bool {
        if !self.sports_filter() {
            let mut fields = program.to_vec();
            fields.extend_from_slice(channel);
            fields.extend_from_slice(extra);
            return self.channel_fields(&fields, strict);
        }
        let mut f = (*self.facts(program, true)).clone();
        let inherited = (*self.facts(channel, false)).clone();
        // Neutral collegiate context never establishes membership by itself.
        // The whole programme term is required; direct conflicting sport or
        // league evidence prevents the inference.
        for league in &registry().leagues {
            if f.programme_evidence.contains(&league.id)
                && (f.programme_contexts.contains(&league.id)
                    || inherited.programme_contexts.contains(&league.id))
                && f.sports.iter().all(|sport| sport == &league.sport_id)
                && f.leagues.iter().all(|id| id == &league.id)
            {
                f.leagues.insert(league.id.clone());
                f.sports.insert(league.sport_id.clone());
            }
        }
        let conflict = (!f.sports.is_empty()
            && !inherited.sports.is_empty()
            && !inherited.sports.is_subset(&f.sports))
            || (!f.leagues.is_empty()
                && !inherited.leagues.is_empty()
                && !inherited.leagues.is_subset(&f.leagues));
        let mut accepted_leagues = BTreeSet::new();
        for id in inherited.leagues {
            let l = registry()
                .leagues
                .iter()
                .find(|l| l.id == id)
                .expect("registered league");
            if if f.leagues.is_empty() {
                f.sports.is_empty() || f.sports.contains(&l.sport_id)
            } else {
                f.leagues.contains(&id)
            } {
                accepted_leagues.insert(id);
            }
        }
        let direct_sports = f.sports.clone();
        for id in inherited.sports {
            if direct_sports.is_empty() || direct_sports.contains(&id) {
                f.sports.insert(id);
            }
        }
        for id in inherited.teams {
            let t = registry()
                .teams
                .iter()
                .find(|t| t.id == id)
                .expect("registered team");
            if accepted_leagues.contains(&t.league_id) {
                f.teams.insert(id);
            }
        }
        f.leagues.extend(accepted_leagues);
        contextual(&mut f);
        let mut texts = program.to_vec();
        if !conflict {
            texts.extend_from_slice(channel);
            texts.extend_from_slice(extra);
        }
        self.matches(&texts, &f, strict)
    }
    fn matches(&self, fields: &[String], f: &Facts, strict: bool) -> bool {
        if self
            .scope
            .sport
            .as_ref()
            .is_some_and(|id| !f.sports.contains(id))
            || self
                .scope
                .league
                .as_ref()
                .is_some_and(|id| !f.leagues.contains(id))
        {
            return false;
        }
        if self.literal.is_empty() {
            return true;
        }
        let selected_facet = self.scope.sport.is_some() || self.scope.league.is_some();
        // Explicit query intent requires independent row evidence; a literal
        // substring cannot substitute for the queried league facts.
        // Bare football and other generic text retain their literal branch.
        let semantic_only = self.query_specific || (strict && !selected_facet);
        if !semantic_only
            && fields.iter().any(|text| {
                text.nfkc()
                    .collect::<String>()
                    .to_lowercase()
                    .contains(&self.literal)
            })
        {
            return true;
        }
        let words = fields.iter().flat_map(|s| tokens(s)).collect::<Vec<_>>();
        !self.targets.is_empty()
            && self.targets.iter().all(|t| t.matches(f))
            && self
                .leftover
                .iter()
                .all(|q| words.iter().any(|w| w.starts_with(q)))
    }
}
fn db<T>(value: rusqlite::Result<T>) -> Result<T, String> {
    value.map_err(|e| crate::storage_transaction::sql_error_code(&e, "sports-query-storage-failed"))
}
pub(crate) fn category_fields(raw: &str) -> rusqlite::Result<Vec<String>> {
    if raw.len() > 32768 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let values: Vec<crate::guide::category::GuideCategory> =
        serde_json::from_str(raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(values.into_iter().map(|v| v.text).collect())
}
pub(crate) fn category_text(raw: &str) -> rusqlite::Result<String> {
    Ok(category_fields(raw)?.join(" "))
}
pub(crate) fn register_evidence(c: &Connection) -> Result<(), String> {
    db(c.create_scalar_function(
        "genx_sports_evidence",
        3,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let fields = (0..3)
                .map(|i| ctx.get::<Option<String>>(i).map(Option::unwrap_or_default))
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(!facts_fields(&fields).sports.is_empty())
        },
    ))
}
pub(crate) fn register(c: &Connection, plan: &Plan) -> Result<(), String> {
    let flag = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    db(
        c.create_scalar_function("genx_sports_country", 1, flag, |ctx| {
            Ok(crate::group_country::group_country(&ctx.get::<String>(0)?)
                .and_then(|id| crate::group_country::country_name(&id)))
        }),
    )?;
    for (name, strict) in [
        ("genx_sports_channel", false),
        ("genx_sports_ppv_channel", true),
    ] {
        let p = plan.clone();
        db(c.create_scalar_function(name, 3, flag, move |ctx| {
            let fields = (0..3)
                .map(|i| ctx.get::<Option<String>>(i).map(Option::unwrap_or_default))
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(p.channel_fields(&fields, strict))
        }))?;
    }
    for (name, strict) in [
        ("genx_sports_list_channel", false),
        ("genx_sports_ppv_list_channel", true),
    ] {
        let p = plan.clone();
        db(c.create_scalar_function(name, 4, flag, move |ctx| {
            let mut fields = (0..3)
                .map(|i| ctx.get::<Option<String>>(i).map(Option::unwrap_or_default))
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if !p.sports_filter() {
                fields.push(ctx.get::<Option<String>>(3)?.unwrap_or_default());
                return Ok(p.channel_fields(&fields, strict));
            }
            let facts = p.facts(&fields, false);
            fields.push(ctx.get::<Option<String>>(3)?.unwrap_or_default());
            Ok(p.matches(&fields, &facts, strict))
        }))?;
    }
    for (name, strict) in [
        ("genx_sports_program", false),
        ("genx_sports_ppv_program", true),
    ] {
        let p = plan.clone();
        db(c.create_scalar_function(name, 7, flag, move |ctx| {
            let channel = (0..3)
                .map(|i| ctx.get::<Option<String>>(i).map(Option::unwrap_or_default))
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut program = (3..5)
                .map(|i| ctx.get::<Option<String>>(i).map(Option::unwrap_or_default))
                .collect::<rusqlite::Result<Vec<_>>>()?;
            program.extend(category_fields(&ctx.get::<String>(5)?)?);
            Ok(p.program_fields_extra(
                &channel,
                &program,
                &[ctx.get::<Option<String>>(6)?.unwrap_or_default()],
                strict,
            ))
        }))?;
    }
    Ok(())
}

pub(crate) fn present(c: &Connection, table: &str) -> Result<bool, String> {
    db(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
        [table],
        |r| r.get(0),
    ))
}
#[derive(Clone, Default)]
pub(crate) struct Matches {
    pub all: std::collections::HashSet<String>,
    pub specific: std::collections::HashSet<String>,
    pub event_only_ppv: std::collections::HashSet<String>,
}
/// Seek programmes for each current mapping context. Later predicates use
/// constant-time membership, never a full Guide/account scan for each row.
pub(crate) fn register_public_list(
    c: &Connection,
    plan: &Plan,
    ppv_only: bool,
) -> Result<Matches, String> {
    register_public_list_scoped(c, plan, ppv_only, false)
}
pub(crate) fn register_public_watched_list(c: &Connection, plan: &Plan) -> Result<Matches, String> {
    register_public_list_scoped(c, plan, true, true)
}
fn register_public_list_scoped(
    c: &Connection,
    plan: &Plan,
    ppv_only: bool,
    watched: bool,
) -> Result<Matches, String> {
    register(c, plan)?;
    let mut matches = Matches::default();
    let mut normal = std::collections::HashSet::new();
    if present(c, "guide_program")? && present(c, "guide_mapping")? {
        let effective = if present(c, "channel_category_override")? {
            "COALESCE((SELECT category FROM channel_category_override WHERE channel_id=c.id),c.category)"
        } else {
            "c.category"
        };
        let ppv = if ppv_only {
            "1".to_owned()
        } else if plan.include_ppv() {
            format!("(NOT genx_ppv_program(p.title,p.categories_json) OR genx_sports_ppv_program(c.name,c.category,{effective},p.title,p.description,p.categories_json,cp.search_text||char(10)||cp.provider_key))")
        } else {
            "NOT genx_ppv_program(p.title,p.categories_json)".into()
        };
        let specific = if plan.include_ppv() {
            format!("genx_sports_ppv_program(c.name,c.category,{effective},p.title,p.description,p.categories_json,cp.search_text||char(10)||cp.provider_key)")
        } else {
            "0".into()
        };
        // Pin mapping-first order, then use the existing source/channel time
        // index. Unrelated feeds cannot inflate this work; every overlapping
        // mapped programme and each distinct channel context remains eligible.
        let history = if watched {
            " AND m.app_channel_id IN(SELECT value FROM json_each(genx_watch_ids()))"
        } else {
            ""
        };
        let query=format!("SELECT m.app_channel_id,{specific},genx_ppv_program(p.title,p.categories_json),genx_sports_list_channel(c.name,c.category,{effective},cp.search_text||char(10)||cp.provider_key) FROM guide_mapping m CROSS JOIN channel c ON c.id=m.app_channel_id AND c.source_id=m.catalog_source_id CROSS JOIN catalog_projection cp ON cp.channel_id=c.id CROSS JOIN guide_source s ON s.id=m.guide_source_id AND s.published_revision IS NOT NULL AND s.published_revision<=s.revision CROSS JOIN guide_program p INDEXED BY guide_program_channel_time ON p.guide_source_id=m.guide_source_id AND p.channel_id=m.xmltv_channel_id WHERE p.start_ms<?2{history} AND ((p.stop_ms IS NOT NULL AND p.stop_ms>?1) OR(p.stop_ms IS NULL AND p.start_ms>=?1)) AND {ppv} AND genx_sports_program(c.name,c.category,{effective},p.title,p.description,p.categories_json,cp.search_text||char(10)||cp.provider_key)");
        #[cfg(test)]
        record_public_plan(c, &query, &plan.scope)?;
        let mut stmt = db(c.prepare(&query))?;
        let mut rows = db(stmt.query(rusqlite::params![
            plan.scope.window_start_ms,
            plan.scope.window_end_ms
        ]))?;
        while let Some(row) = db(rows.next())? {
            let id = db(row.get::<_, String>(0))?;
            if !matches.all.contains(&id) && matches.all.len() >= 100_000 {
                return Err("sports-query-too-large".into());
            }
            if db(row.get::<_, bool>(1))? {
                matches.specific.insert(id.clone());
            }
            if db(row.get::<_, bool>(2))? {
                matches.event_only_ppv.insert(id.clone());
            }
            if !db(row.get::<_, bool>(2))? || db(row.get::<_, bool>(3))? {
                normal.insert(id.clone());
            }
            matches.all.insert(id);
        }
    }
    matches.event_only_ppv.retain(|id| !normal.contains(id));
    register_list(c, &matches)?;
    Ok(matches)
}
pub(crate) fn register_list(c: &Connection, matches: &Matches) -> Result<(), String> {
    let ids = matches.all.clone();
    let specific = matches.specific.clone();
    db(c.create_scalar_function(
        "genx_sports_cached",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        move |ctx| Ok(ids.contains(&ctx.get::<String>(0)?)),
    ))?;
    db(c.create_scalar_function(
        "genx_sports_ppv_cached",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        move |ctx| Ok(specific.contains(&ctx.get::<String>(0)?)),
    ))
}
pub(crate) fn register_paid_list(
    c: &Connection,
    plan: &Plan,
    account: &str,
    ppv_only: bool,
) -> Result<Matches, String> {
    register_paid_list_scoped(c, plan, account, ppv_only, false)
}
pub(crate) fn register_paid_watched_list(
    c: &Connection,
    plan: &Plan,
    account: &str,
) -> Result<Matches, String> {
    register_paid_list_scoped(c, plan, account, true, true)
}
fn register_paid_list_scoped(
    c: &Connection,
    plan: &Plan,
    account: &str,
    ppv_only: bool,
    watched: bool,
) -> Result<Matches, String> {
    register(c, plan)?;
    let mut matches = Matches::default();
    if crate::account_guide::status(c, account)?.is_some() {
        let live = crate::account_catalog_query::live_scope(c)?;
        let ppv = if ppv_only {
            "1"
        } else if plan.include_ppv() {
            "(NOT genx_ppv_program(g.title,g.categories) OR genx_sports_ppv_program(l.name,l.original,l.effective,g.title,g.description,g.categories,l.extra))"
        } else {
            "NOT genx_ppv_program(g.title,g.categories)"
        };
        let specific = if plan.include_ppv() {
            "genx_sports_ppv_program(l.name,l.original,l.effective,g.title,g.description,g.categories,l.extra)"
        } else {
            "0"
        };
        // Authorized live rows are materialized once; each programme lookup is a
        // PK range on (account,epg,start). Shared EPG IDs never merge channels.
        let history = if watched {
            " AND e.channel_id IN(SELECT value FROM json_each(genx_watch_ids()))"
        } else {
            ""
        };
        let query=format!("WITH live AS MATERIALIZED(SELECT e.channel_id,e.epg_id,e.name,e.category AS original,{} AS effective,COALESCE(e.provider_id,'')||char(10)||COALESCE(e.epg_id,'')||char(10)||COALESCE(genx_sports_country(e.category),'') AS extra{} AND e.epg_id IS NOT NULL{history}), matched AS MATERIALIZED(SELECT l.channel_id,{specific} AS specific,genx_ppv_program(g.title,g.categories) AS ppv,genx_sports_list_channel(l.name,l.original,l.effective,l.extra) AS channel_match FROM live l CROSS JOIN account_guide_program_v1 g INDEXED BY sqlite_autoindex_account_guide_program_v1_1 ON g.account_id=?1 AND g.epg_id=l.epg_id AND g.start_ms>=?2-43200000 AND g.start_ms<?3 WHERE (g.stop_ms>?2 OR(g.stop_ms IS NULL AND g.start_ms>=?2)) AND {ppv} AND genx_sports_program(l.name,l.original,l.effective,g.title,g.description,g.categories,l.extra)) SELECT channel_id,MAX(specific),MAX(ppv) AND NOT MAX(NOT ppv OR channel_match) FROM matched GROUP BY channel_id",live.category,live.from);
        #[cfg(test)]
        record_paid_plan(c, &query, account, &plan.scope)?;
        let mut stmt = db(c.prepare(&query))?;
        let mut rows = db(stmt.query(rusqlite::params![
            account,
            plan.scope.window_start_ms,
            plan.scope.window_end_ms
        ]))?;
        while let Some(row) = db(rows.next())? {
            if matches.all.len() >= 100_000 {
                return Err("sports-query-too-large".into());
            }
            let id = db(row.get::<_, String>(0))?;
            if db(row.get::<_, bool>(1))? {
                matches.specific.insert(id.clone());
            }
            if db(row.get::<_, bool>(2))? {
                matches.event_only_ppv.insert(id.clone());
            }
            matches.all.insert(id);
        }
    }
    register_list(c, &matches)?;
    Ok(matches)
}

#[cfg(test)]
thread_local! {static PUBLIC_PLAN: std::cell::RefCell<Vec<String>> = const {std::cell::RefCell::new(Vec::new())};}
#[cfg(test)]
fn record_public_plan(c: &Connection, query: &str, scope: &Scope) -> Result<(), String> {
    let mut stmt = db(c.prepare(&format!("EXPLAIN QUERY PLAN {query}")))?;
    let values = db(stmt.query_map(
        rusqlite::params![scope.window_start_ms, scope.window_end_ms],
        |r| r.get::<_, String>(3),
    ))?;
    let plan = db(values.collect::<rusqlite::Result<Vec<_>>>())?;
    PUBLIC_PLAN.with(|p| *p.borrow_mut() = plan);
    Ok(())
}
#[cfg(test)]
pub(crate) fn public_plan() -> Vec<String> {
    PUBLIC_PLAN.with(|p| p.borrow().clone())
}

#[cfg(test)]
thread_local! {static PAID_PLAN: std::cell::RefCell<Vec<String>> = const {std::cell::RefCell::new(Vec::new())}; static PAID_SQL:std::cell::RefCell<String>=const{std::cell::RefCell::new(String::new())};}
#[cfg(test)]
fn record_paid_plan(
    c: &Connection,
    query: &str,
    account: &str,
    scope: &Scope,
) -> Result<(), String> {
    let mut stmt = db(c.prepare(&format!("EXPLAIN QUERY PLAN {query}")))?;
    let values = db(stmt.query_map(
        rusqlite::params![account, scope.window_start_ms, scope.window_end_ms],
        |r| r.get::<_, String>(3),
    ))?;
    let plan = db(values.collect::<rusqlite::Result<Vec<_>>>())?;
    PAID_PLAN.with(|p| *p.borrow_mut() = plan);
    PAID_SQL.with(|p| *p.borrow_mut() = query.to_owned());
    Ok(())
}
#[cfg(test)]
pub(crate) fn paid_plan() -> Vec<String> {
    PAID_PLAN.with(|p| p.borrow().clone())
}

#[cfg(test)]
pub(crate) fn reordered_paid_probe(
    c: &Connection,
    account: &str,
    scope: &Scope,
) -> rusqlite::Result<usize> {
    let current = PAID_SQL.with(|q| q.borrow().clone());
    let reordered=current.replace("live l CROSS JOIN account_guide_program_v1 g INDEXED BY sqlite_autoindex_account_guide_program_v1_1 ON","live l JOIN account_guide_program_v1 g ON");
    assert_ne!(current, reordered);
    let mut stmt = c.prepare(&reordered)?;
    let mut rows = stmt.query(rusqlite::params![
        account,
        scope.window_start_ms,
        scope.window_end_ms
    ])?;
    let mut count = 0;
    while rows.next()?.is_some() {
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests;
