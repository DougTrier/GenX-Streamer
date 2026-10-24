/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The timeline guide's host interface, its constants and the pure helpers
 * its parts share. Re-exported by guide-timeline.ts.
 */
import {
  type MappedProgram,
  type ProgramPage,
  type ProgramQuery,
  type SelectedGuideSummary,
} from '../guide/native';
import { type ChannelCoverageReply, type ChannelCoverageRequest } from '../guide/channel-coverage';
import { guideCategoryKey } from '../guide/categories';

export interface TimelineChannel {
  id: string;
  sourceId: string;
  providerId?: string;
  name: string;
  category?: string;
  favorite?: boolean;
  guideSourceId: string | null;
  xmltvChannelId: string | null;
  guideRevision?: number;
}

export interface TimelineHost {
  /** Null is pending; failed distinguishes refusal from a completed empty result. */
  listedCount?(
    count: number | null,
    windowStartMs: number,
    windowEndMs: number,
    failed?: boolean,
  ): void;
  /** With search, keeps channels whose name or a program in the window has every word. */
  listedChannels?(
    windowStartMs: number,
    windowEndMs: number,
    signal: AbortSignal,
    search?: string,
  ): Promise<{
    catalogRevision: string;
    databaseRevision: number;
    /** Omitted only by legacy/browser hosts; native bridge always declares both. */
    viewRevision?: string;
    groupingPolicy?: string;
    channels: readonly {
      catalogSourceId: string;
      appChannelId: string;
      guideSourceId: string;
      xmltvChannelId: string;
      sourceRevision: number;
      filterMask?: number;
    }[];
  }>;
  logos?: {
    get(channel: TimelineChannel): string | null;
    visible(channels: readonly TimelineChannel[]): void;
    rejected(channel: TimelineChannel): void;
    suspend(): Promise<void>;
  };
  initiallyForeground?: boolean;
  channels(): readonly TimelineChannel[];
  catalogRevision(): string;
  query(query: ProgramQuery, signal: AbortSignal): Promise<ProgramPage>;
  summary?(
    channel: TimelineChannel,
    atMs: number,
    signal: AbortSignal,
  ): Promise<SelectedGuideSummary>;
  channelCoverage?(
    query: ChannelCoverageRequest,
    signal: AbortSignal,
  ): Promise<ChannelCoverageReply>;
  watch(channel: TimelineChannel, signal: AbortSignal): Promise<void>;
  channelActivate?(channel: TimelineChannel): void;
  mapChannel?(channel: TimelineChannel): Promise<void> | void;
  now(): number;
  formatTime(ms: number): string;
  formatAxisTime?(ms: number): string;
  /** Below this width the one-channel agenda replaces the grid (default 650). */
  agendaWidth?: number | (() => number);
}

export const HALF = 1_800_000,
  WINDOW = 6 * HALF,
  WEEK = 7 * 86_400_000,
  ROW = 64,
  /** Rows the right-panel Guide shows at once on a TV or desktop. */
  GUIDE_ROWS = 12,
  MAX_ROWS = 32,
  MAX_CELLS = MAX_ROWS * 50;

/** Runs at most `limit` of the given tasks at once, in the order asked. */
export function limitConcurrency(limit: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (running >= limit) return;
    const start = queue.shift();
    if (start) start();
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        running++;
        let result: Promise<T>;
        try {
          result = task();
        } catch (error) {
          result = Promise.reject(error);
        }
        result.then(resolve, reject).finally(() => {
          running--;
          next();
        });
      });
      next();
    });
}

/** The right-panel Guide keeps the grid down to 480 px (a TV's panel is ~600 px);
 * phones, where the guide spans the screen, keep the usual 650 px agenda. */
export const PANEL_AGENDA_WIDTH = (): number =>
  (globalThis.innerWidth ?? 1000) <= 700 ? 650 : 480;

export type TimelineCategory = 'all' | 'favorites' | 'news' | 'sports';

/** Search words folded like the native guide search text. */
export const guideSearchWords = (value: string) =>
  value.normalize('NFKC').toLowerCase().split(/\s+/u).filter(Boolean);

/** Every search word starts a word of the text, as in the native search ("nfl" is not "conflict"). */
export function guideSearchMatches(search: string, text: string): boolean {
  const words = text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[\s([\-/:"#.]+/u);
  return guideSearchWords(search).every((term) => words.some((word) => word.startsWith(term)));
}

/** Filter only actual saved category metadata, using the existing channel filter vocabulary. */
export function timelineCategoryMatches(
  channel: TimelineChannel,
  filter: TimelineCategory,
): boolean {
  return (
    filter === 'all' ||
    (filter === 'favorites'
      ? channel.favorite === true
      : (channel.category ?? '').normalize('NFKC').toLowerCase().includes(filter))
  );
}

/** Navigation stays within the same bounded epoch window; this never claims feed coverage. */
export function timelineWindowStart(from: number, now: number, delta: number): number | null {
  if (![from, now, delta].every(Number.isSafeInteger)) throw new Error('Guide time invalid.');
  const first = Math.floor(now / HALF) * HALF,
    target = from + delta;
  return Number.isSafeInteger(target) && target >= first && target + WINDOW <= first + WEEK
    ? target
    : null;
}

export function cellBounds(
  start: number,
  stop: number | null,
  from: number,
): { left: number; width: number; unknown: boolean } | null {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(from) ||
    (stop !== null && (!Number.isSafeInteger(stop) || stop <= start))
  )
    throw new Error('Guide listing invalid.');
  if (stop === null)
    return start >= from && start < from + WINDOW
      ? { left: ((start - from) / WINDOW) * 100, width: 0, unknown: true }
      : null;
  const lo = Math.max(start, from),
    hi = Math.min(stop, from + WINDOW);
  return hi > lo
    ? { left: ((lo - from) / WINDOW) * 100, width: ((hi - lo) / WINDOW) * 100, unknown: false }
    : null;
}

/** Semantic identity includes actual provider categories, not a guessed title genre. */
export function timelineProgramKey(p: MappedProgram): string {
  return JSON.stringify([
    p.catalogSourceId,
    p.appChannelId,
    p.guideSourceId,
    p.xmltvChannelId,
    p.startMs,
    p.stopMs,
    p.ordinal,
    p.title,
    p.description,
    guideCategoryKey(p.categories),
  ]);
}

export const channelKey = (c: TimelineChannel) =>
  JSON.stringify([c.id, c.sourceId, c.guideSourceId, c.xmltvChannelId, c.guideRevision ?? null]);

export const savedChannelKey = (c: TimelineChannel) => JSON.stringify([c.sourceId, c.id]);

export const aborted = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError';

export type Listed = Awaited<ReturnType<NonNullable<TimelineHost['listedChannels']>>>;

export type ListedCache = {
  anchor: number;
  catalogRevision: string;
  signature: string;
  databaseRevision: number;
  grouped: boolean;
  search: string;
  channels: Map<string, Listed['channels'][number]>;
};

/** Clusters include the touch target width, so short/unknown cells cannot cover a sibling. */
export function clusterListings(
  programs: readonly MappedProgram[],
  from: number,
  trackWidth = 1000,
): MappedProgram[][] {
  const ordered = [...programs].sort(
    (a, b) =>
      a.startMs - b.startMs ||
      a.ordinal - b.ordinal ||
      (timelineProgramKey(a) < timelineProgramKey(b)
        ? -1
        : timelineProgramKey(a) > timelineProgramKey(b)
          ? 1
          : 0),
  );
  const groups: MappedProgram[][] = [];
  let right = -Infinity;
  for (const program of ordered) {
    const bounds = cellBounds(program.startMs, program.stopMs, from);
    if (!bounds) continue;
    const left = (bounds.left / 100) * trackWidth,
      end = left + Math.max(44, (bounds.width / 100) * trackWidth);
    if (groups.length && left < right) groups[groups.length - 1]!.push(program);
    else groups.push([program]);
    right = Math.max(right, end);
  }
  return groups;
}
