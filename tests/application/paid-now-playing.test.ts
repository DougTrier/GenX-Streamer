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

import { describe, expect, it } from 'vitest';
import { createPaidNowPlaying, type NowPlayingRow } from '../../src/application/paid-now-playing';
import type { AccountGuideProgram } from '../../src/platform/account-guide';
import type { AccountMetadata } from '../../src/platform/account-vault';

const NOW = Date.UTC(2026, 9, 18, 20, 30);
const account = (id: string): AccountMetadata => ({
  schemaVersion: 1,
  id,
  name: 'Provider',
  kind: 'xtream',
  serverOrigin: 'https://provider.invalid',
  allowHttp: false,
  revision: '1',
  requiresSignIn: false,
});
const program = (title: string, startMs: number, stopMs: number | null): AccountGuideProgram => ({
  epgId: 'e',
  startMs,
  stopMs,
  ordinal: 0,
  title,
  description: null,
  categories: [],
});

/** A controlled stored guide: listings per EPG ID, held until released when asked. */
function fixture() {
  let selected: AccountMetadata | null = account('a1');
  const listings: Record<string, AccountGuideProgram[]> = {
    'e.one': [
      program('Late News', NOW - 1_800_000, NOW + 1_800_000),
      program('Film', NOW + 1_800_000, NOW + 7_200_000),
    ],
    'e.two': [program('Starts Soon', NOW + 600_000, NOW + 4_200_000)],
    'e.open': [program('No End', NOW - 600_000, null)],
  };
  const epg: Record<string, string> = { c1: 'e.one', c2: 'e.two', c3: 'e.open', c4: 'e.fail' };
  const calls: { account: string; epgId: string; fromMs: number; toMs: number }[] = [];
  const published: (readonly NowPlayingRow[])[] = [];
  const held: (() => void)[] = [];
  let hold = false;
  let tick: (() => void) | null = null;
  const owner = createPaidNowPlaying({
    guide: {
      programs: async (a, epgId, fromMs, toMs, _after, _limit, signal) => {
        calls.push({ account: a.id, epgId, fromMs, toMs });
        if (hold) await new Promise<void>((resolve) => held.push(resolve));
        signal?.throwIfAborted();
        if (epgId === 'e.fail') throw new Error('unreadable');
        return { revision: 1, programs: listings[epgId] ?? [] };
      },
    } as Parameters<typeof createPaidNowPlaying>[0]['guide'],
    account: () => selected,
    epgId: (id) => epg[id] ?? null,
    now: () => NOW,
    publish: (rows) => published.push(rows),
    setInterval: (callback) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
  });
  const rows = (...ids: string[]) =>
    ids.map((id) => ({ catalogSourceId: id === 'f1' ? 'free' : 'account-a1', appChannelId: id }));
  return {
    owner,
    calls,
    published,
    rows,
    select: (id: string | null) => (selected = id ? account(id) : null),
    hold: (on: boolean) => (hold = on),
    release: () => held.splice(0).forEach((resolve) => resolve()),
    get ticking() {
      return tick !== null;
    },
    tick: () => tick?.(),
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Paid TV now playing', () => {
  it("reads only the selected account's rows on screen and publishes what is on now", async () => {
    const f = fixture();
    f.owner.setScope(f.rows('c1', 'c2', 'c3', 'c4', 'c9', 'f1'));
    await settle();
    // Free TV rows and rows without an EPG ID are never read.
    expect(f.calls.map((c) => c.epgId)).toEqual(['e.one', 'e.two', 'e.open', 'e.fail']);
    expect(f.calls.every((c) => c.account === 'a1' && c.fromMs === NOW && c.toMs > NOW)).toBe(true);
    // Only a listing on air now with a known end counts; failures stay silent.
    expect(f.published.at(-1)).toEqual([
      {
        catalogSourceId: 'account-a1',
        appChannelId: 'c1',
        title: 'Late News',
        startMs: NOW - 1_800_000,
        stopMs: NOW + 1_800_000,
      },
    ]);
    expect(f.ticking).toBe(true);
  });

  it('a newer scope or another account drops older results', async () => {
    const f = fixture();
    f.hold(true);
    f.owner.setScope(f.rows('c1'));
    f.owner.setScope(f.rows('c2'));
    f.hold(false);
    f.release();
    await settle();
    expect(f.published.flat().some((row) => row.appChannelId === 'c1')).toBe(false);

    f.hold(true);
    f.owner.refresh();
    f.select('a2');
    f.release();
    await settle();
    expect(f.published.flat().some((row) => row.catalogSourceId !== 'account-a1')).toBe(false);
  });

  it('Free TV, no account or no rows clears the set and stops the refresh timer', async () => {
    const f = fixture();
    f.owner.setScope(f.rows('c1'));
    await settle();
    expect(f.published.at(-1)).toHaveLength(1);
    f.select(null);
    f.tick();
    await settle();
    expect(f.published.at(-1)).toEqual([]);
    f.owner.setScope([]);
    expect(f.ticking).toBe(false);
  });

  it('dispose cancels reads in flight and publishes nothing more', async () => {
    const f = fixture();
    f.hold(true);
    f.owner.setScope(f.rows('c1'));
    const before = f.published.length;
    f.owner.dispose();
    f.hold(false);
    f.release();
    await settle();
    expect(f.published.length).toBe(before);
    expect(f.ticking).toBe(false);
  });
});
