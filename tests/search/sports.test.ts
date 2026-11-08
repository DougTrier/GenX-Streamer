// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import corpus from '../fixtures/sports-classifier-cases.json';
import queries from '../fixtures/sports-query-cases.json';
import {
  captureSportsScope,
  matchesSportsFacet,
  matchesSportsSearch,
  planSportsSearch,
  programmeSportsFacts,
  programmeSportsTexts,
  sportsMatchupTitle,
  sportsFacts,
  SPORTS_VOCABULARY_VERSION,
  SPORTS_WINDOW_MS,
  type SportsFacet,
  validateSportsScope,
} from '../../src/search/sports';

for (const entry of queries.cases)
  it(`shared sports query: ${entry.id}`, () => {
    const plan = planSportsSearch(entry.query);
    const channel = 'channelTexts' in entry ? (entry.channelTexts ?? []) : [];
    const program = 'program' in entry ? entry.program : undefined;
    const facet = 'facet' in entry ? (entry.facet as SportsFacet) : {};
    const texts = program
      ? programmeSportsTexts(program, channel, undefined, facet, plan)
      : 'texts' in entry
        ? (entry.texts ?? [])
        : [];
    const facts = program
      ? programmeSportsFacts(program, sportsFacts(channel), facet, plan)
      : sportsFacts(texts);
    expect(plan.specific).toBe(entry.specific);
    expect(
      matchesSportsFacet(facts, facet) && matchesSportsSearch(plan, texts, facts, false, facet),
    ).toBe(entry.normalMatch);
    expect(
      matchesSportsFacet(facts, facet) && matchesSportsSearch(plan, texts, facts, true, facet),
    ).toBe(entry.strictSemanticMatch);
  });

for (const entry of corpus.cases)
  it(`shared sports evidence: ${entry.id}`, () => {
    const facts = sportsFacts(entry.texts);
    expect([...facts.sports].sort()).toEqual([...entry.sports].sort());
    expect([...facts.leagues].sort()).toEqual([...entry.leagues].sort());
  });

it('matches full NFL team intent to contextual nicknames without making bare names into league evidence', () => {
  const texts = ['Bears at Packers'];
  const plan = planSportsSearch('Chicago Bears');
  expect(plan.specific).toBe(true);
  expect(matchesSportsSearch(plan, texts, sportsFacts(texts))).toBe(false);
  expect(matchesSportsSearch(plan, texts, sportsFacts(texts, sportsFacts(['US | NFL'])))).toBe(
    true,
  );
  expect(planSportsSearch('Bears').specific).toBe(false);
  expect(matchesSportsSearch(plan, ['Buffalo Bills'], sportsFacts(['Buffalo Bills']))).toBe(false);
});

it.each([
  ['Week 9: Bears vs. Packers (Replay)', 'Week 9: Chicago Bears vs. Green Bay Packers (Replay)'],
  ['Bills at Jaguars', 'Buffalo Bills at Jacksonville Jaguars'],
  ['Ｂｅａｒｓ＠Ｐａｃｋｅｒｓ', 'Chicago Bears@Green Bay Packers'],
  [
    'New England Patriots versus Jacksonville Jaguars',
    'New England Patriots versus Jacksonville Jaguars',
  ],
])(
  'expands only the two title opponents in order with independent NFL context: %s',
  (raw, expected) => {
    expect(sportsMatchupTitle(raw, sportsFacts(['NFL']))).toBe(expected);
  },
);
it.each([
  'Bears and Packers news roundup',
  'Bears vs Bears',
  'Bears vs Packers vs Bills',
  'CHI vs GB',
  'Bears vs a mystery team',
  'Preview: Packers',
])('keeps unknown, ambiguous or nonmatchup text unexpanded: %s', (raw) => {
  expect(sportsMatchupTitle(raw, sportsFacts(['NFL']))).toBeNull();
});
it('does not create matchup names from query intent or incompatible programme/channel evidence', () => {
  expect(sportsMatchupTitle('Bears vs Packers', sportsFacts([]))).toBeNull();
  expect(
    sportsMatchupTitle(
      'Bears vs Packers',
      programmeSportsFacts(
        { title: 'Bears vs Packers', categories: [{ text: 'NBA' }] },
        sportsFacts(['NFL']),
      ),
    ),
  ).toBeNull();
});
it('retains college league specificity, longest phrases and residual words', () => {
  const plan = planSportsSearch('college football highlights');
  expect(plan.semantic.map((entry) => [entry.kind, entry.id])).toEqual([
    ['league', 'college-football'],
  ]);
  expect(plan.remaining).toEqual(['highlights']);
  expect(matchesSportsSearch(plan, ['Highlights'], sportsFacts(['College Basketball']))).toBe(
    false,
  );
  expect(matchesSportsSearch(plan, ['Highlights'], sportsFacts(['NCAAF']))).toBe(true);
  expect(
    matchesSportsSearch(planSportsSearch('NFL Canada'), ['NFL Germany'], sportsFacts(['NFL'])),
  ).toBe(false);
});
it('requires football evidence while preserving soccer with a football label and keeping PPV opt-in', () => {
  const plan = planSportsSearch('football');
  expect(plan.specific).toBe(false);
  expect(
    matchesSportsSearch(
      plan,
      ['Chicago Bears at Buffalo Bills'],
      sportsFacts(['Chicago Bears at Buffalo Bills']),
    ),
  ).toBe(true);
  const soccer = sportsFacts(['Soccer', 'Football match']);
  expect(matchesSportsSearch(plan, ['Football match'], soccer)).toBe(true);
  expect(matchesSportsFacet(soccer, { sport: 'american-football' })).toBe(false);
  expect(captureSportsScope('football')?.includePpv).toBe(false);
});
it('does not use a literal substring as evidence for an explicit sports query', () => {
  const plan = planSportsSearch('NFL');
  expect(matchesSportsSearch(plan, ['NFLive cinema PPV'], sportsFacts(['NFLive cinema PPV']))).toBe(
    false,
  );
  expect(
    matchesSportsSearch(plan, ['NFLive cinema PPV'], sportsFacts(['NFLive cinema PPV']), true),
  ).toBe(false);
});
it('programme evidence fences conflicting channel context', () => {
  const facts = programmeSportsFacts(
    { title: 'Soccer: football final', categories: [{ text: 'MLS' }] },
    sportsFacts(['NFL']),
  );
  expect(facts.sports.has('soccer')).toBe(true);
  expect(facts.sports.has('american-football')).toBe(false);
  expect(facts.leagues.has('nfl')).toBe(false);
});
it('captures a bounded versioned window and refuses invalid or unauthorised PPV scopes', () => {
  const scope = captureSportsScope('NFL', {}, 1800001)!;
  expect(scope).toMatchObject({
    windowStartMs: 1800000,
    windowEndMs: 1800000 + SPORTS_WINDOW_MS,
    includePpv: true,
    vocabularyVersion: SPORTS_VOCABULARY_VERSION,
  });
  for (const delta of [
    { sport: 'unknown' },
    { sport: 'soccer', league: 'nfl' },
    { vocabularyVersion: 'old' },
    { windowEndMs: scope.windowStartMs + SPORTS_WINDOW_MS + 1 },
    { windowEndMs: scope.windowStartMs },
  ])
    expect(() => validateSportsScope({ ...scope, ...delta }, 'NFL')).toThrow();
  expect(() => validateSportsScope(scope, 'Bears')).toThrow();
  expect(captureSportsScope('', {})).toBeUndefined();
});
