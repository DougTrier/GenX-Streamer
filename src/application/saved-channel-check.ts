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

import type {
  ChannelCheck,
  ChannelChecks,
  ChannelCheckVerdict,
  ChannelObservation,
} from '../platform/channel-checks';

/**
 * The quiet saved-channel check (owner request, October 19, 2026). While GenX
 * is open and nothing is playing or scanning, it checks saved Free TV channels
 * a few at a time, each at most about once a day, and records the result
 * natively. A channel that failed on two different days with no response
 * between is marked Not responding; the viewer decides whether to remove it.
 * Nothing is ever removed or hidden here.
 */
export interface SavedChannel {
  id: string;
  url: string;
  allowHttp: boolean;
}
export type CheckOutcome = ChannelCheckVerdict | 'NotChecked' | 'Canceled';
export interface SavedChannelCheckHost {
  /** Saved, not removed, Free TV channels. */
  channels(): readonly SavedChannel[];
  /** True while checks may run: open, in front, nothing playing, no scan. */
  idle(): boolean;
  read(signal: AbortSignal): Promise<ChannelChecks>;
  record(observations: readonly ChannelObservation[], signal: AbortSignal): Promise<number>;
  probe(channel: SavedChannel, signal: AbortSignal): Promise<CheckOutcome>;
  /** Newest checks, after every read (marks, the filter count), and the
   *  channels carrying the Slow badge. */
  changed(checks: ReadonlyMap<string, ChannelCheck>, slow: ReadonlySet<string>): void;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}
export interface SavedChannelCheckOptions {
  /** Before the first check after start-up, so start-up keeps the network. */
  startDelayMs?: number;
  /** A channel checked this recently is not checked again. */
  dueAfterMs?: number;
  batch?: number;
  concurrency?: number;
  /** Between batches, and while waiting for GenX to become idle. */
  restMs?: number;
  /** Between two checks of one batch: checks never run back to back. */
  gapMs?: number;
  /** When nothing is due, or after a storage failure. */
  sleepMs?: number;
}
const HOUR = 3_600_000;

/** Due channels, failing ones first (to confirm or clear), then never checked, then oldest. */
export function dueChannels(
  channels: readonly SavedChannel[],
  checks: ReadonlyMap<string, ChannelCheck>,
  nowMs: number,
  dueAfterMs: number,
): SavedChannel[] {
  const rank = (channel: SavedChannel): [number, number] => {
    const check = checks.get(channel.id);
    if (!check) return [1, 0];
    return [check.firstFailMs !== null ? 0 : 2, check.checkedMs];
  };
  return channels
    .filter((channel) => {
      const check = checks.get(channel.id);
      return !check || nowMs - check.checkedMs >= dueAfterMs;
    })
    .map((channel) => ({ channel, rank: rank(channel) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1])
    .map(({ channel }) => channel);
}

export function createSavedChannelCheck(
  host: SavedChannelCheckHost,
  options: SavedChannelCheckOptions = {},
) {
  const startDelayMs = options.startDelayMs ?? 90_000;
  const dueAfterMs = options.dueAfterMs ?? 20 * HOUR;
  const batchSize = Math.min(options.batch ?? 12, 200);
  // One check at a time, with a rest after each: each opens new secure
  // connections, and two at once kept two of the Sansui TV's four cores busy
  // (October 21, 2026). Checking is meant to be quiet, not quick.
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const restMs = options.restMs ?? 15_000;
  const gapMs = options.gapMs ?? 3_000;
  const sleepMs = options.sleepMs ?? 30 * 60_000;
  const owner = new AbortController();
  // The batch's own cancellation: ends checks in flight as soon as GenX stops
  // being idle (a channel starts, the app leaves the front).
  let batchAbort: AbortController | null = null;
  let checks = new Map<string, ChannelCheck>();
  let running: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  const pending: ChannelObservation[] = [];

  const publish = (next: ChannelChecks) => {
    checks = new Map(next.checks.map((check) => [check.channelId, check]));
    host.changed(checks, new Set(next.slowChannels));
    return next.nowMs;
  };
  const rest = async (ms: number) => {
    owner.signal.throwIfAborted();
    // One signal for "closing or woken" (TV WebViews may predate AbortSignal.any).
    const early = new AbortController();
    const stop = () => early.abort();
    wake = stop;
    owner.signal.addEventListener('abort', stop, { once: true });
    try {
      await host.wait(ms, early.signal);
    } catch (error) {
      if (owner.signal.aborted) throw error;
    } finally {
      wake = null;
      owner.signal.removeEventListener('abort', stop);
    }
    owner.signal.throwIfAborted();
  };
  const flush = async () => {
    while (pending.length) {
      const part = pending.splice(0, 200);
      await host.record(part, owner.signal);
    }
  };
  async function checkBatch(batch: readonly SavedChannel[]): Promise<ChannelObservation[]> {
    // Channels sharing one stream address are checked once.
    const byUrl = new Map<string, SavedChannel[]>();
    for (const channel of batch)
      byUrl.set(channel.url, [...(byUrl.get(channel.url) ?? []), channel]);
    const queue = [...byUrl.values()];
    const observations: ChannelObservation[] = [];
    const abort = new AbortController();
    const stop = () => abort.abort();
    owner.signal.addEventListener('abort', stop, { once: true });
    batchAbort = abort;
    try {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
          let first = true;
          for (let group = queue.shift(); group; group = queue.shift()) {
            if (!first) {
              try {
                await host.wait(gapMs, abort.signal);
              } catch {
                return;
              }
            }
            first = false;
            if (abort.signal.aborted || !host.idle()) return;
            const outcome = await host
              .probe(group[0], abort.signal)
              .catch(() => 'NotChecked' as const);
            // Stopped because GenX is in use: nothing learned.
            if (abort.signal.aborted) return;
            // Canceled or unknown (for example the device is offline) never counts as a failure.
            if (outcome === 'NotChecked' || outcome === 'Canceled') continue;
            for (const channel of group)
              observations.push({ channelId: channel.id, verdict: outcome });
          }
        }),
      );
    } finally {
      owner.signal.removeEventListener('abort', stop);
      if (batchAbort === abort) batchAbort = null;
    }
    // Stopped part way: keep the channels that answered; a failure is never
    // counted without the connection check below, which waits for idle.
    const answered = (verdict: string) => verdict === 'Reachable' || verdict === 'PlayedHere';
    if (abort.signal.aborted) return observations.filter((o) => answered(o.verdict));
    // Failures only count while the connection itself works: when nothing in the
    // batch answered, the channel that answered most recently must answer now.
    if (observations.length && !observations.some((o) => answered(o.verdict))) {
      const inBatch = new Set(batch.map((channel) => channel.id));
      let canary: SavedChannel | undefined;
      let newest = -1;
      for (const channel of host.channels()) {
        const ok = checks.get(channel.id)?.okMs ?? null;
        if (ok !== null && ok > newest && !inBatch.has(channel.id)) {
          newest = ok;
          canary = channel;
        }
      }
      if (canary) {
        const outcome = await host.probe(canary, owner.signal).catch(() => 'NotChecked' as const);
        if (!answered(outcome)) return [];
        observations.push({ channelId: canary.id, verdict: outcome as ChannelCheckVerdict });
      }
    }
    return observations;
  }
  async function loop(): Promise<void> {
    // Marks from earlier days show at once; checking waits for start-up to settle.
    try {
      publish(await host.read(owner.signal));
    } catch (error) {
      if (owner.signal.aborted) throw error;
    }
    await rest(startDelayMs);
    for (;;) {
      owner.signal.throwIfAborted();
      try {
        await flush();
        const nowMs = publish(await host.read(owner.signal));
        if (!host.idle()) {
          await rest(restMs);
          continue;
        }
        const due = dueChannels(host.channels(), checks, nowMs, dueAfterMs).slice(0, batchSize);
        if (!due.length) {
          await rest(sleepMs);
          continue;
        }
        const observations = await checkBatch(due);
        if (observations.length) {
          await host.record(observations, owner.signal);
          publish(await host.read(owner.signal));
        }
        await rest(restMs);
      } catch (error) {
        if (owner.signal.aborted) throw error;
        await rest(sleepMs / 6);
      }
    }
  }
  return {
    start(): void {
      if (running || owner.signal.aborted) return;
      running = loop().catch(() => undefined);
    },
    /** Something changed (playback started or stopped, a scan, the app's
     *  place): checks in flight stop at once when GenX is no longer idle. */
    poke(): void {
      if (batchAbort && !host.idle()) batchAbort.abort();
      wake?.();
    },
    /** A saved channel just played here: record it so a working channel is never marked. */
    played(channelId: string): void {
      if (owner.signal.aborted) return;
      const known = checks.get(channelId);
      if (known?.verdict === 'PlayedHere' && known.firstFailMs === null && pending.length === 0)
        return;
      if (!pending.some((item) => item.channelId === channelId))
        pending.push({ channelId, verdict: 'PlayedHere' });
      wake?.();
    },
    snapshot: (): ReadonlyMap<string, ChannelCheck> => checks,
    async dispose(): Promise<void> {
      owner.abort();
      await running;
    },
  };
}
export type SavedChannelCheck = ReturnType<typeof createSavedChannelCheck>;
