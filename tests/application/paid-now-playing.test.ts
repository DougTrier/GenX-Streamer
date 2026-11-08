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
import {
  createPaidNowPlaying,
  type NowPlayingRow,
} from '../../src/application/accounts/paid-now-playing';
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

it('retains independently cached league categories and description without any additional guide read', async () => {
  const cached = {
    ...program('Bears vs Packers', NOW - 1000, NOW + 3600000),
    description: 'Replay from the saved provider schedule',
    categories: [{ text: 'NFL' }],
    replay: { originalAirDate: '2026-09-04', previousAirDate: null },
  };
  const published: (readonly NowPlayingRow[])[] = [];
  let calls = 0;
  const owner = createPaidNowPlaying({
    guide: {
      programs: async () => {
        calls++;
        return { revision: 1, programs: [cached] };
      },
    } as Parameters<typeof createPaidNowPlaying>[0]['guide'],
    account: () => account('a1'),
    epgId: () => 'cached-epg',
    now: () => NOW,
    publish: (rows) => published.push(rows),
    setInterval: () => 1,
    clearInterval: () => {},
  });
  try {
    owner.setScope([{ catalogSourceId: 'account-a1', appChannelId: 'one' }]);
    await settle();
    expect(calls).toBe(1);
    expect(published.at(-1)?.[0]).toMatchObject({
      title: 'Bears vs Packers',
      description: cached.description,
      categories: [{ text: 'NFL' }],
      replay: cached.replay,
    });
    cached.categories[0]!.text = 'NBA';
    expect(published.at(-1)?.[0]?.categories).toEqual([{ text: 'NFL' }]);
  } finally {
    await owner.dispose();
  }
});

it('binds the existing local read to exact channel and PPV permission, rereads changed capability, and drops late old scope', async () => {
  let ppv = true;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: {
    epgId: string;
    channelId: string | undefined;
    ppv: boolean | undefined;
    signal: AbortSignal | undefined;
  }[] = [];
  const published: (readonly NowPlayingRow[])[] = [];
  const current = account('a1');
  const owner = createPaidNowPlaying({
    guide: {
      programs: async (
        _account,
        epgId,
        _from,
        _to,
        _after,
        _limit,
        signal,
        scopePpv,
        channelId,
      ) => {
        calls.push({ epgId, channelId, ppv: scopePpv, signal });
        if (calls.length === 1) await held;
        return {
          revision: 1,
          programs: [
            program(scopePpv ? 'Scoped PPV title' : 'Ordinary title', NOW - 1000, NOW + 3600000),
          ],
        };
      },
    },
    account: () => current,
    epgId: () => 'shared-epg',
    scopeFor: () => ({ epgId: 'shared-epg', ppv }),
    now: () => NOW,
    publish: (rows) => published.push(rows),
    setInterval: () => 1,
    clearInterval: () => {},
  });
  const rows = [{ catalogSourceId: 'account-a1', appChannelId: 'exact-channel' }];
  try {
    owner.setScope(rows);
    expect(calls).toHaveLength(1);
    ppv = false;
    owner.setScope(rows);
    await settle();
    expect(calls.map(({ epgId, channelId, ppv }) => ({ epgId, channelId, ppv }))).toEqual([
      { epgId: 'shared-epg', channelId: 'exact-channel', ppv: true },
      { epgId: 'shared-epg', channelId: 'exact-channel', ppv: false },
    ]);
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(published.at(-1)?.[0]?.title).toBe('Ordinary title');
    release();
    await settle();
    expect(published.flatMap((rows) => rows.map((row) => row.title))).not.toContain(
      'Scoped PPV title',
    );
  } finally {
    release();
    owner.dispose();
  }
});

it('retires an already published PPV title before a changed-capability read settles, retaining same-key refresh titles', async () => {
  let ppv = true;
  let hold = false;
  let release!: () => void;
  let calls = 0;
  const published: (readonly NowPlayingRow[])[] = [];
  const owner = createPaidNowPlaying({
    guide: {
      programs: async (_account, _epg, _from, _to, _after, _limit, _signal, scopePpv) => {
        calls++;
        if (hold)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return {
          revision: 1,
          programs: [program(scopePpv ? 'PPV title' : 'Ordinary title', NOW - 1000, NOW + 3600000)],
        };
      },
    },
    account: () => account('a1'),
    epgId: () => 'shared-epg',
    scopeFor: () => ({ epgId: 'shared-epg', ppv }),
    now: () => NOW,
    publish: (rows) => published.push(rows),
    setInterval: () => 1,
    clearInterval: () => {},
  });
  const rows = [{ catalogSourceId: 'account-a1', appChannelId: 'same-visible-id' }];
  try {
    owner.setScope(rows);
    await settle();
    expect(published.at(-1)?.[0]?.title).toBe('PPV title');
    const changedAt = published.length;
    hold = true;
    ppv = false;
    owner.setScope(rows);
    expect(calls).toBe(2);
    expect(published.at(-1)).toEqual([]);
    release();
    await settle();
    expect(published.at(-1)?.[0]?.title).toBe('Ordinary title');
    expect(
      published.slice(changedAt).flatMap((rows) => rows.map((row) => row.title)),
    ).not.toContain('PPV title');
    owner.refresh();
    expect(calls).toBe(3);
    expect(published.at(-1)?.[0]?.title).toBe('Ordinary title');
    release();
    await settle();
  } finally {
    release?.();
    owner.dispose();
  }
});

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
