import type { Channel } from '../catalog/parser';
import { queryGuide, type GuideProgram } from '../guide/query';
import { validGuideInstant } from '../guide/time';
import { guideCategoryKey, guideCategorySearchText } from '../guide/categories';
export const SEARCH_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export type SearchChannel = Pick<Channel, 'id' | 'sourceId' | 'name' | 'category'>;
export interface SearchMapping {
  catalogSourceId: string;
  appChannelId: string;
  guideSourceId: string;
  xmltvChannelId: string;
}
export interface SearchCoverage {
  guideSourceId: string;
  revision: string;
  updatedAtMs: number | null;
  windowStartMs: number | null;
  windowEndMs: number | null;
}
export interface CoverageSummary {
  guideSourceId: string;
  revision: string | null;
  freshness: 'fresh' | 'stale' | 'unknown';
  range: 'covers-window' | 'partial-window' | 'outside-window' | 'unknown';
}
export interface ChannelMatch extends SearchChannel {
  mapping: 'mapped' | 'unmapped' | 'ambiguous';
}
export interface EventMatch {
  channel: SearchChannel;
  program: GuideProgram;
  timing: 'live' | 'upcoming' | 'unknown-end' | 'overlap';
  conflict: boolean;
  coverage: CoverageSummary;
}
export interface SearchResult {
  query: string;
  nowMs: number;
  horizonEndMs: number;
  channels: ChannelMatch[];
  events: EventMatch[];
  coverage: CoverageSummary[];
  counts: { channels: number; events: number; unmappedChannels: number; ambiguousChannels: number };
}
const scope = (source: string, channel: string) => JSON.stringify([source, channel]);
const programKey = (p: GuideProgram) =>
  JSON.stringify([
    p.guideSourceId,
    p.channelId,
    p.startMs,
    p.stopMs,
    p.title,
    p.description ?? null,
    guideCategoryKey(p.categories),
  ]);
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function text(value: string, max = 16384): boolean {
  return typeof value === 'string' && !!value.trim() && value.length <= max;
}
/** No stream addresses are returned. Invoke off-thread for full imported guide feeds. */
export function searchCatalog(input: {
  query: string;
  channels: readonly SearchChannel[];
  programs: readonly GuideProgram[];
  mappings: readonly SearchMapping[];
  coverage: readonly SearchCoverage[];
  nowMs: number;
  horizonMs?: number;
  staleAfterMs?: number;
  channelOffset?: number;
  eventOffset?: number;
  limit?: number;
}): SearchResult {
  const horizon = input.horizonMs ?? SEARCH_WEEK_MS;
  const staleAfter = input.staleAfterMs ?? 24 * 60 * 60 * 1000;
  const end = input.nowMs + horizon;
  const limit = input.limit ?? 50;
  const channelOffset = input.channelOffset ?? 0;
  const eventOffset = input.eventOffset ?? 0;
  if (
    typeof input.query !== 'string' ||
    input.query.length > 256 ||
    !validGuideInstant(input.nowMs) ||
    !Number.isSafeInteger(horizon) ||
    horizon <= 0 ||
    horizon > SEARCH_WEEK_MS ||
    !validGuideInstant(end) ||
    !Number.isSafeInteger(staleAfter) ||
    staleAfter <= 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    ![channelOffset, eventOffset].every((value) => Number.isSafeInteger(value) && value >= 0)
  )
    throw new Error('The search query or window is invalid.');
  if (
    input.channels.length > 100000 ||
    input.programs.length > 500000 ||
    input.mappings.length > 100000 ||
    input.coverage.length > 100000
  )
    throw new Error('Search input exceeds the supported catalog or guide limit.');
  const channels = new Map<string, SearchChannel>();
  for (const channel of input.channels) {
    if (
      !text(channel.id, 256) ||
      !text(channel.sourceId, 256) ||
      !text(channel.name) ||
      typeof channel.category !== 'string' ||
      channel.category.length > 16384
    )
      throw new Error('A search channel is invalid.');
    const key = scope(channel.sourceId, channel.id);
    if (channels.has(key)) throw new Error('Search channel identities are repeated.');
    channels.set(key, {
      id: channel.id,
      sourceId: channel.sourceId,
      name: channel.name,
      category: channel.category,
    });
  }
  const maps = new Map<string, Map<string, SearchMapping>>();
  for (const mapping of input.mappings) {
    if (
      !text(mapping.catalogSourceId, 256) ||
      !text(mapping.appChannelId, 256) ||
      !text(mapping.guideSourceId, 256) ||
      !text(mapping.xmltvChannelId)
    )
      throw new Error('A search guide mapping is invalid.');
    const key = scope(mapping.catalogSourceId, mapping.appChannelId);
    if (!channels.has(key)) continue;
    const targets = maps.get(key) ?? new Map<string, SearchMapping>();
    targets.set(scope(mapping.guideSourceId, mapping.xmltvChannelId), { ...mapping });
    maps.set(key, targets);
  }
  const coverage = new Map<string, CoverageSummary>();
  for (const record of input.coverage) {
    if (
      !text(record.guideSourceId, 256) ||
      !text(record.revision, 256) ||
      coverage.has(record.guideSourceId) ||
      [record.updatedAtMs, record.windowStartMs, record.windowEndMs].some(
        (value) => value !== null && !validGuideInstant(value),
      ) ||
      (record.windowStartMs !== null &&
        record.windowEndMs !== null &&
        record.windowEndMs <= record.windowStartMs)
    )
      throw new Error('Search guide coverage is invalid.');
    const freshness =
      record.updatedAtMs === null || record.updatedAtMs > input.nowMs
        ? 'unknown'
        : input.nowMs - record.updatedAtMs > staleAfter
          ? 'stale'
          : 'fresh';
    const range =
      record.windowStartMs === null || record.windowEndMs === null
        ? 'unknown'
        : record.windowStartMs <= input.nowMs && record.windowEndMs >= end
          ? 'covers-window'
          : record.windowStartMs >= end || record.windowEndMs <= input.nowMs
            ? 'outside-window'
            : 'partial-window';
    coverage.set(record.guideSourceId, {
      guideSourceId: record.guideSourceId,
      revision: record.revision,
      freshness,
      range,
    });
  }
  const byGuide = new Map<string, SearchChannel[]>();
  let unmappedChannels = 0;
  let ambiguousChannels = 0;
  const channelMatches: ChannelMatch[] = [];
  const tokens = normalize(input.query).match(/[\p{L}\p{N}]+/gu) ?? [];
  const matches = (value: string) => {
    if (!tokens.length) return false;
    const normalized = normalize(value);
    return tokens.every((token) => normalized.includes(token));
  };
  for (const [key, channel] of channels) {
    const targets = maps.get(key);
    const mapping = !targets?.size ? 'unmapped' : targets.size > 1 ? 'ambiguous' : 'mapped';
    if (mapping === 'unmapped') unmappedChannels++;
    if (mapping === 'ambiguous') ambiguousChannels++;
    if (matches(`${channel.name} ${channel.category}`))
      channelMatches.push({ ...channel, mapping });
    if (mapping !== 'mapped') continue;
    const target = [...targets!.values()][0];
    const guideKey = scope(target.guideSourceId, target.xmltvChannelId);
    const list = byGuide.get(guideKey) ?? [];
    list.push(channel);
    byGuide.set(guideKey, list);
    if (!coverage.has(target.guideSourceId))
      coverage.set(target.guideSourceId, {
        guideSourceId: target.guideSourceId,
        revision: null,
        freshness: 'unknown',
        range: 'unknown',
      });
  }
  const programs = new Map<string, GuideProgram[]>();
  for (const program of input.programs) {
    const key = scope(program.guideSourceId, program.channelId);
    if (!byGuide.has(key)) continue;
    const list = programs.get(key) ?? [];
    list.push(program);
    programs.set(key, list);
  }
  const templates: Array<{
    key: string;
    title: string;
    program: GuideProgram;
    timing: EventMatch['timing'];
    conflict: boolean;
    channels: SearchChannel[];
  }> = [];
  for (const [key, list] of programs) {
    const first = list[0];
    const result = queryGuide(list, {
      guideSourceId: first.guideSourceId,
      channelId: first.channelId,
      nowMs: input.nowMs,
      windowStartMs: input.nowMs,
      windowEndMs: end,
    });
    const conflicts = new Set(result.conflicts.map(programKey));
    const unique = new Map<string, GuideProgram>();
    for (const program of list) {
      if (
        program.startMs >= end ||
        (program.stopMs !== null && program.stopMs <= input.nowMs) ||
        (program.stopMs === null && program.startMs < input.nowMs) ||
        !matches(
          `${program.title} ${program.description ?? ''} ${guideCategorySearchText(program.categories)}`,
        )
      )
        continue;
      unique.set(programKey(program), program);
    }
    for (const program of unique.values()) {
      const conflict = conflicts.has(programKey(program));
      const timing: EventMatch['timing'] =
        program.startMs > input.nowMs
          ? 'upcoming'
          : program.stopMs === null
            ? 'unknown-end'
            : result.currentStatus === 'overlap'
              ? 'overlap'
              : 'live';
      templates.push({
        key: programKey(program),
        title: normalize(program.title),
        program,
        timing,
        conflict,
        channels: byGuide.get(key)!,
      });
    }
  }
  channelMatches.sort(
    (a, b) =>
      compareText(normalize(a.name), normalize(b.name)) ||
      compareText(a.sourceId, b.sourceId) ||
      compareText(a.id, b.id),
  );
  templates.sort(
    (a, b) =>
      a.program.startMs - b.program.startMs ||
      compareText(a.title, b.title) ||
      compareText(a.key, b.key),
  );
  for (const list of byGuide.values())
    list.sort((a, b) => compareText(a.sourceId, b.sourceId) || compareText(a.id, b.id));
  const events: EventMatch[] = [];
  let eventCount = 0;
  // Compute fan-out counts without materializing programs × mapped channels.
  for (const template of templates) {
    const start = eventCount;
    eventCount += template.channels.length;
    if (eventCount <= eventOffset || start >= eventOffset + limit) continue;
    for (
      let index = Math.max(0, eventOffset - start);
      index < Math.min(template.channels.length, eventOffset + limit - start);
      index++
    )
      events.push({
        channel: { ...template.channels[index] },
        program: { ...template.program },
        timing: template.timing,
        conflict: template.conflict,
        coverage: { ...coverage.get(template.program.guideSourceId)! },
      });
  }
  return {
    query: input.query.trim(),
    nowMs: input.nowMs,
    horizonEndMs: end,
    channels: channelMatches.slice(channelOffset, channelOffset + limit),
    events,
    coverage: [...coverage.values()].sort((a, b) => compareText(a.guideSourceId, b.guideSourceId)),
    counts: {
      channels: channelMatches.length,
      events: eventCount,
      unmappedChannels,
      ambiguousChannels,
    },
  };
}
