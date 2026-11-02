// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import vocabulary from '../../config/sports-vocabulary.json';
import { validGuideInstant } from '../guide/time';

interface VocabularyEntry {
  id: string;
  label: string;
  evidenceAliases: readonly string[];
  queryAliases: readonly string[];
}
interface Sport extends VocabularyEntry {
  literalExpansionAliases: readonly string[];
}
interface League extends VocabularyEntry {
  sportId: string;
}
interface Team extends VocabularyEntry {
  leagueId: string;
  contextualAliases: readonly string[];
}
const data = vocabulary as {
  vocabularyVersion: string;
  sports: Sport[];
  leagues: League[];
  teams: Team[];
};
export const SPORTS_VOCABULARY_VERSION = data.vocabularyVersion;
export const SPORTS_WINDOW_MS = 7 * 86400000;
export const sports = data.sports;
export const leagues = data.leagues;
const sportIds = new Set(sports.map((entry) => entry.id));
const leagueById = new Map(leagues.map((entry) => [entry.id, entry]));
const teamById = new Map(data.teams.map((entry) => [entry.id, entry]));

export interface SportsFacet {
  sport?: string;
  league?: string;
}
export interface SportsScope extends SportsFacet {
  includePpv?: boolean;
  windowStartMs: number;
  windowEndMs: number;
  vocabularyVersion: string;
}
export interface SportsFacts {
  sports: Set<string>;
  leagues: Set<string>;
  teams: Set<string>;
}
export interface SportsProgram {
  title: string;
  description?: string | null;
  categories?: readonly { text: string }[];
  startMs: number;
  stopMs: number | null;
}
export const sportsWords = (value: string): string[] =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
const normalized = (value: string) => value.normalize('NFKC').toLowerCase();
type Kind = 'sport' | 'league' | 'team' | 'literal-expansion';
interface Alias {
  words: string[];
  kind: Kind;
  id: string;
}
function index(entries: readonly Alias[]) {
  const result = new Map<string, Alias[]>();
  for (const entry of entries) {
    if (!entry.words.length) continue;
    const known = result.get(entry.words[0]!) ?? [];
    known.push(entry);
    result.set(entry.words[0]!, known);
  }
  for (const entries of result.values()) entries.sort((a, b) => b.words.length - a.words.length);
  return result;
}
const aliases = (entry: VocabularyEntry, kind: Kind, key: 'evidenceAliases' | 'queryAliases') =>
  entry[key].map((value) => ({ words: sportsWords(value), kind, id: entry.id }));
const evidence = index([
  ...sports.flatMap((entry) => aliases(entry, 'sport', 'evidenceAliases')),
  ...leagues.flatMap((entry) => aliases(entry, 'league', 'evidenceAliases')),
  ...data.teams.flatMap((entry) => aliases(entry, 'team', 'evidenceAliases')),
]);
const contextual = index(
  data.teams.flatMap((entry) =>
    entry.contextualAliases.map((value) => ({
      words: sportsWords(value),
      kind: 'team' as const,
      id: entry.id,
    })),
  ),
);
const matchupAliases = index(
  data.teams
    .filter((team) => team.leagueId === 'nfl')
    .flatMap((team) =>
      [...team.evidenceAliases, ...team.contextualAliases].map((value) => ({
        words: sportsWords(value),
        kind: 'team' as const,
        id: team.id,
      })),
    ),
);

/** Display-only expansion: two actual title spans and a matchup separator, never query intent. */
export function sportsMatchupTitle(title: string, facts: SportsFacts): string | null {
  if (!facts.leagues.has('nfl')) return null;
  const text = title.normalize('NFKC');
  const tokens = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  const words = tokens.map((match) => match[0].toLowerCase());
  const matches: { id: string; start: number; end: number }[] = [];
  for (let at = 0; at < words.length;) {
    const alias = (matchupAliases.get(words[at]!) ?? []).find((entry) => fits(entry, words, at));
    if (!alias) {
      at++;
      continue;
    }
    const last = tokens[at + alias.words.length - 1]!;
    matches.push({ id: alias.id, start: tokens[at]!.index!, end: last.index! + last[0].length });
    at += alias.words.length;
  }
  if (matches.length !== 2 || matches[0]!.id === matches[1]!.id) return null;
  const first = matches[0]!,
    second = matches[1]!;
  const between = text.slice(first.end, second.start);
  if (!/^(?:v(?:s)?\.?|versus|@|at)$/iu.test(between.trim())) return null;
  return (
    text.slice(0, first.start) +
    teamById.get(first.id)!.label +
    between +
    teamById.get(second.id)!.label +
    text.slice(second.end)
  );
}
const queries = index([
  ...sports.flatMap((entry) => aliases(entry, 'sport', 'queryAliases')),
  ...leagues.flatMap((entry) => aliases(entry, 'league', 'queryAliases')),
  ...data.teams.flatMap((entry) => aliases(entry, 'team', 'queryAliases')),
  ...sports.flatMap((entry) =>
    entry.literalExpansionAliases.map((value) => ({
      words: sportsWords(value),
      kind: 'literal-expansion' as const,
      id: entry.id,
    })),
  ),
]);
const fits = (entry: Alias, words: readonly string[], at: number) =>
  entry.words.every((word, offset) => words[at + offset] === word);
const emptyFacts = (): SportsFacts => ({ sports: new Set(), leagues: new Set(), teams: new Set() });
function add(facts: SportsFacts, kind: Kind, id: string) {
  if (kind === 'sport' || kind === 'literal-expansion') facts.sports.add(id);
  else if (kind === 'league') {
    facts.leagues.add(id);
    facts.sports.add(leagueById.get(id)!.sportId);
  } else {
    facts.teams.add(id);
    add(facts, 'league', teamById.get(id)!.leagueId);
  }
}
function merge(target: SportsFacts, source: SportsFacts) {
  for (const id of source.sports) target.sports.add(id);
  for (const id of source.leagues) target.leagues.add(id);
  for (const id of source.teams) target.teams.add(id);
}
/** A query is never supplied as evidence. Field boundaries cannot invent a franchise phrase. */
export function sportsFacts(texts: readonly string[], context?: SportsFacts): SportsFacts {
  const result = emptyFacts();
  const fields = texts.map(sportsWords);
  for (const words of fields)
    words.forEach((word, at) => {
      for (const alias of evidence.get(word) ?? [])
        if (fits(alias, words, at)) add(result, alias.kind, alias.id);
    });
  if (context) merge(result, context);
  for (const words of fields)
    words.forEach((word, at) => {
      for (const alias of contextual.get(word) ?? [])
        if (fits(alias, words, at) && result.leagues.has(teamById.get(alias.id)!.leagueId))
          add(result, 'team', alias.id);
    });
  return result;
}
export function programmeSportsFacts(
  program: Pick<SportsProgram, 'title' | 'description' | 'categories'>,
  channel: SportsFacts,
): SportsFacts {
  const texts = [
    program.title,
    program.description ?? '',
    ...(program.categories ?? []).map((entry) => entry.text),
  ];
  const direct = sportsFacts(texts);
  const inherited = emptyFacts();
  for (const id of channel.leagues) {
    const sport = leagueById.get(id)!.sportId;
    if (
      direct.leagues.size ? direct.leagues.has(id) : !direct.sports.size || direct.sports.has(sport)
    )
      add(inherited, 'league', id);
  }
  for (const id of channel.sports)
    if (!direct.sports.size || direct.sports.has(id)) inherited.sports.add(id);
  for (const id of channel.teams)
    if (inherited.leagues.has(teamById.get(id)!.leagueId)) inherited.teams.add(id);
  return sportsFacts(texts, inherited);
}
/** Conflicting schedule evidence cannot borrow a channel's league text to match a query. */
export function programmeSportsTexts(
  program: Pick<SportsProgram, 'title' | 'description' | 'categories'>,
  channelTexts: readonly string[],
  channel: SportsFacts = sportsFacts(channelTexts),
): string[] {
  const texts = [
    program.title,
    program.description ?? '',
    ...(program.categories ?? []).map((entry) => entry.text),
  ];
  const direct = sportsFacts(texts);
  const conflict =
    (direct.leagues.size > 0 &&
      channel.leagues.size > 0 &&
      [...channel.leagues].some((id) => !direct.leagues.has(id))) ||
    (direct.sports.size > 0 &&
      channel.sports.size > 0 &&
      [...channel.sports].some((id) => !direct.sports.has(id)));
  return conflict ? texts : [...texts, ...channelTexts];
}
export interface SportsSearchPlan {
  literal: string;
  remaining: string[];
  semantic: Alias[];
  specific: boolean;
}
export function planSportsSearch(query: string): SportsSearchPlan {
  const words = sportsWords(query),
    remaining: string[] = [],
    semantic: Alias[] = [];
  for (let at = 0; at < words.length;) {
    const alias = (queries.get(words[at]!) ?? []).find((entry) => fits(entry, words, at));
    if (alias) {
      semantic.push(alias);
      at += alias.words.length;
    } else {
      remaining.push(words[at]!);
      at++;
    }
  }
  return {
    literal: normalized(query.trim()),
    remaining,
    semantic,
    specific: semantic.some((entry) => entry.kind !== 'literal-expansion'),
  };
}
export function matchesSportsFacet(facts: SportsFacts, facet: SportsFacet): boolean {
  return (
    (!facet.sport || facts.sports.has(facet.sport)) &&
    (!facet.league || facts.leagues.has(facet.league))
  );
}
export function matchesSportsSearch(
  plan: SportsSearchPlan,
  texts: readonly string[],
  facts: SportsFacts,
  semanticOnly = false,
): boolean {
  if (!plan.literal) return true;
  const fields = texts.map(normalized);
  if (!semanticOnly && fields.some((text) => text.includes(plan.literal))) return true;
  if (!plan.semantic.length) return false;
  const words = texts.flatMap(sportsWords);
  return (
    plan.semantic.every((entry) =>
      entry.kind === 'team'
        ? facts.teams.has(entry.id)
        : entry.kind === 'league'
          ? facts.leagues.has(entry.id)
          : facts.sports.has(entry.id),
    ) && plan.remaining.every((term) => words.some((word) => word.startsWith(term)))
  );
}
export function hasSpecificSportsIntent(query: string, facet: SportsFacet = {}): boolean {
  return !!(facet.sport || facet.league || planSportsSearch(query).specific);
}
export function captureSportsScope(
  query: string,
  facet: SportsFacet = {},
  now = Date.now(),
): SportsScope | undefined {
  if (!query.trim() && !facet.sport && !facet.league) return undefined;
  const start = Math.floor(now / 1800000) * 1800000;
  return validateSportsScope(
    {
      ...facet,
      includePpv: hasSpecificSportsIntent(query, facet),
      windowStartMs: start,
      windowEndMs: start + SPORTS_WINDOW_MS,
      vocabularyVersion: SPORTS_VOCABULARY_VERSION,
    },
    query,
  );
}
export function validateSportsScope(raw: unknown, query: string): SportsScope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid sports scope.');
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
    Reflect.ownKeys(Object.getOwnPropertyDescriptors(raw)).some(
      (key) => typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(raw, key)!),
    )
  )
    throw new Error('Invalid sports scope.');
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'sport',
          'league',
          'includePpv',
          'windowStartMs',
          'windowEndMs',
          'vocabularyVersion',
        ].includes(key),
    ) ||
    (value.sport !== undefined &&
      (typeof value.sport !== 'string' || !sportIds.has(value.sport))) ||
    (value.league !== undefined &&
      (typeof value.league !== 'string' || !leagueById.has(value.league))) ||
    (value.sport !== undefined &&
      value.league !== undefined &&
      leagueById.get(value.league as string)!.sportId !== value.sport) ||
    (value.includePpv !== undefined && typeof value.includePpv !== 'boolean') ||
    !validGuideInstant(value.windowStartMs as number) ||
    !validGuideInstant(value.windowEndMs as number) ||
    (value.windowEndMs as number) <= (value.windowStartMs as number) ||
    (value.windowEndMs as number) - (value.windowStartMs as number) > SPORTS_WINDOW_MS ||
    value.vocabularyVersion !== SPORTS_VOCABULARY_VERSION ||
    (value.includePpv === true && !hasSpecificSportsIntent(query, value as SportsFacet))
  )
    throw new Error('Invalid sports scope.');
  return {
    ...(value.sport === undefined ? {} : { sport: value.sport as string }),
    ...(value.league === undefined ? {} : { league: value.league as string }),
    ...(value.includePpv === undefined ? {} : { includePpv: value.includePpv as boolean }),
    windowStartMs: value.windowStartMs as number,
    windowEndMs: value.windowEndMs as number,
    vocabularyVersion: SPORTS_VOCABULARY_VERSION,
  };
}
