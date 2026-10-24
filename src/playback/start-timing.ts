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
 * Channel start timing (measurement only; owner request, October 22, 2026).
 * Records when each stage of a start first happens, in milliseconds after the
 * viewer's choice, so slow starts can be split into network, decode and paint
 * before any playback behavior is tuned. Holds no channel names, addresses or
 * provider text: only stage names, times and byte counts. Recording never
 * changes what the player does.
 */

/** Stages in the order a start normally reaches them. */
export const START_STAGES = [
  'requested',
  'previous-released',
  'session-ready',
  'player-select',
  'engine-start',
  'source-known',
  'library-ready',
  'manifest-request',
  'manifest-first-byte',
  'manifest-loaded',
  'playlist-loaded',
  'first-segment-request',
  'first-segment-first-byte',
  'first-segment-loaded',
  'first-segment-buffered',
  'play-called',
  // Paid TV live channels pass through GenX's local relay (native wall clock).
  // The relay asks the provider at session start, before the player asks.
  'relay-request',
  'player-request',
  'upstream-headers',
  'upstream-first-byte',
  'player-first-byte',
  // MPEG-TS: the player has parsed the stream's video and audio description.
  'media-info',
  'first-decodable-frame',
  'first-visible-frame',
  'playing-event',
  'playback-start',
] as const;
export type StartStage = (typeof START_STAGES)[number];

export interface StartTimingRecord {
  /** What started: a Paid TV channel, or any other player selection. */
  readonly kind: 'account' | 'player';
  /** Milliseconds after `requested` at which each stage first happened. */
  readonly stages: Readonly<Partial<Record<StartStage, number>>>;
  /** Small numeric facts (bytes, segment seconds, retries); never text. */
  readonly facts: Readonly<Record<string, number | boolean>>;
}

const KEEP = 12;
/** Fact names are short words, never text from a source. */
const FACT_NAME = /^[a-z][a-z0-9-]{0,40}$/u;

/** Adds stages measured elsewhere to the record that reached playback. */
export interface StartEnrichment {
  /** A stage time on the wall clock (Unix milliseconds), such as the relay's. */
  wallStage(stage: StartStage, unixMs: number | null | undefined): void;
  fact(name: string, value: number | boolean): void;
}

export function createStartTiming(
  now: () => number = () => performance.now(),
  timeOrigin: () => number = () => performance.timeOrigin,
) {
  const records: Array<{
    kind: StartTimingRecord['kind'];
    at: number;
    stages: Partial<Record<StartStage, number>>;
    facts: Record<string, number | boolean>;
  }> = [];
  let current: (typeof records)[number] | null = null;
  let enrich: ((add: StartEnrichment) => void) | null = null;
  const validFact = (name: string, value: number | boolean): boolean =>
    FACT_NAME.test(name) && (typeof value !== 'number' || Number.isFinite(value));
  const begin = (kind: StartTimingRecord['kind'], at = now()): void => {
    current = { kind, at, stages: { requested: 0 }, facts: {} };
    records.push(current);
    if (records.length > KEEP) records.shift();
  };
  /** First occurrence wins; `at` is a `performance.now()` time (hls.js stats use the same clock). */
  const record = (
    target: (typeof records)[number],
    stage: StartStage,
    at: number,
    otherClock = false,
  ): boolean => {
    if (target.stages[stage] !== undefined || !Number.isFinite(at)) return false;
    // Times from another clock that fall before the choice belong to an older start.
    if (otherClock && at < target.at) return false;
    target.stages[stage] = Math.max(0, Math.round(at - target.at));
    return true;
  };
  const mark = (stage: StartStage, at = now()): void => {
    if (!current) return;
    const target = current;
    if (!record(target, stage, at)) return;
    if (stage !== 'playback-start' || target.kind !== 'account' || !enrich) return;
    try {
      enrich({
        wallStage: (wall, unixMs) => {
          if (typeof unixMs === 'number') record(target, wall, unixMs - timeOrigin(), true);
        },
        fact: (name, value) => {
          if (validFact(name, value)) target.facts[name] ??= value;
        },
      });
    } catch {
      // Measurement only: the stage times are simply not added.
    }
  };
  return {
    begin,
    mark,
    /** The player was asked to play: starts a new record unless a Paid TV start already did. */
    enterPlayer(): void {
      if (!current || current.stages['player-select'] !== undefined) begin('player');
      mark('player-select');
    },
    fact(name: string, value: number | boolean): void {
      if (current && validFact(name, value)) current.facts[name] ??= value;
    },
    /** Called when a Paid TV start reaches playback, to add the relay's times. */
    enrichAccountStarts(callback: ((add: StartEnrichment) => void) | null): void {
      enrich = callback;
    },
    count(name: string): void {
      if (!current || !FACT_NAME.test(name)) return;
      current.facts[name] = ((current.facts[name] as number | undefined) ?? 0) + 1;
    },
    snapshot(): readonly StartTimingRecord[] {
      return records.map((r) => ({ kind: r.kind, stages: { ...r.stages }, facts: { ...r.facts } }));
    },
  };
}

/** The application's one recorder (read through `window.__GENX_START_TIMING__`). */
export const startTiming = createStartTiming();
