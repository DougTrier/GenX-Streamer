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

import { expect, it } from 'vitest';
import { createAccountGuide, validateAccountGuideStatus } from '../../src/platform/account-guide';
import type { AccountMetadata } from '../../src/platform/account-vault';
import { captureSportsScope } from '../../src/search/sports';

const account: AccountMetadata = {
  schemaVersion: 1,
  id: 'a'.repeat(32),
  name: 'Provider',
  kind: 'xtream',
  serverOrigin: 'https://provider.invalid',
  allowHttp: false,
  revision: '3',
  requiresSignIn: false,
};
const channel = {
  id: `account-${'a'.repeat(32)}-${'f'.repeat(64)}`,
  name: 'FOX 32',
  category: 'US| LOCALS',
  epgId: 'fox32.us',
  providerId: '32',
  streamReference: 'b'.repeat(32),
  favorite: true,
};

it('History Guide requires exact same-account membership and passes the whole ordered scope to programme reads', async () => {
  const history = { ids: [channel.id], hideAdult: true };
  const listed = bridge({
    revision: 1,
    epgIds: ['shared'],
    channelIds: [channel.id],
    ppvChannelIds: [channel.id],
  });
  await expect(
    listed.guide.listed(account, 1, 2, '', undefined, false, undefined, history),
  ).resolves.toMatchObject({ channelIds: [channel.id] });
  expect(listed.calls[0].args.request).toMatchObject({ historyIds: [channel.id], hideAdult: true });
  await expect(
    bridge({ revision: 1, epgIds: ['shared'] }).guide.listed(
      account,
      1,
      2,
      '',
      undefined,
      false,
      undefined,
      history,
    ),
  ).rejects.toThrow();
  await expect(
    bridge({ revision: 1, epgIds: ['shared'], channelIds: [channel.id] }).guide.listed(
      account,
      1,
      2,
      '',
      undefined,
      false,
      undefined,
      history,
    ),
  ).rejects.toThrow();
  const otherId = `account-${account.id}-${'e'.repeat(64)}`;
  await expect(
    bridge({ revision: 1, epgIds: ['shared'], channelIds: [otherId] }).guide.listed(
      account,
      1,
      2,
      '',
      undefined,
      false,
      undefined,
      history,
    ),
  ).rejects.toThrow();
  const programs = bridge({ revision: 1, programs: [] });
  await programs.guide.programs(
    account,
    'shared',
    1,
    2,
    null,
    10,
    undefined,
    false,
    channel.id,
    undefined,
    '',
    history,
  );
  expect(programs.calls[0].args.request).toMatchObject({
    channelId: channel.id,
    historyIds: [channel.id],
    hideAdult: true,
  });
  expect(programs.calls[0].args.request).not.toHaveProperty('ppv');
  for (const id of [undefined, otherId])
    expect(() =>
      programs.guide.programs(
        account,
        'shared',
        1,
        2,
        null,
        10,
        undefined,
        false,
        id,
        undefined,
        '',
        history,
      ),
    ).toThrow();
  expect(() =>
    programs.guide.listed(account, 1, 2, '', undefined, true, undefined, history),
  ).toThrow();
  expect(() =>
    programs.guide.listed(account, 1, 2, '', undefined, false, undefined, {
      ids: [`account-${'c'.repeat(32)}-${'d'.repeat(64)}`],
      hideAdult: true,
    }),
  ).toThrow();
  expect(programs.calls).toHaveLength(1);
});

it('sports Guide scope carries the captured window and exact channel authority, with bounded PPV membership', async () => {
  const sports = captureSportsScope('NFL', { sport: 'american-football', league: 'nfl' }, 1000)!;
  const listed = bridge({
    revision: 1,
    epgIds: ['shared'],
    channelIds: [channel.id],
    ppvChannelIds: [channel.id],
  });
  await expect(
    listed.guide.listed(account, 1, 2, 'NFL', undefined, false, sports),
  ).resolves.toMatchObject({ ppvChannelIds: [channel.id] });
  expect(listed.calls[0].args.request).toMatchObject({ sports, search: 'NFL' });
  for (const reply of [
    { revision: 1, epgIds: ['shared'] },
    { revision: 1, epgIds: ['shared'], channelIds: [channel.id] },
    { revision: 1, epgIds: ['shared'], channelIds: [], ppvChannelIds: [channel.id] },
    {
      revision: 1,
      epgIds: ['shared'],
      channelIds: [channel.id],
      ppvChannelIds: [channel.id, channel.id],
    },
  ])
    await expect(
      bridge(reply).guide.listed(account, 1, 2, 'NFL', undefined, false, sports),
    ).rejects.toThrow();
  const programs = bridge({ revision: 1, programs: [] });
  expect(() =>
    programs.guide.programs(
      account,
      'shared',
      1,
      2,
      null,
      10,
      undefined,
      false,
      undefined,
      sports,
      'NFL',
    ),
  ).toThrow();
  expect(programs.calls).toHaveLength(0);
  await programs.guide.programs(
    account,
    'shared',
    1,
    2,
    null,
    10,
    undefined,
    false,
    channel.id,
    sports,
    'NFL',
  );
  expect(programs.calls[0].args.request).toMatchObject({
    channelId: channel.id,
    sports,
    search: 'NFL',
  });
});

it('keeps original provider category available for sport search after a local category override', async () => {
  const overridden = { ...channel, category: 'Sports', originalCategory: 'US | NFL' };
  await expect(bridge([overridden]).guide.channels(account)).resolves.toEqual([overridden]);
});
/** Records each native call and answers with the given reply. */
function bridge(reply: unknown) {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const guide = createAccountGuide({
    invoke: async (command, args) => {
      calls.push({ command, args: args ?? {} });
      return reply;
    },
    idFactory: () => 'request-1',
  });
  return { guide, calls };
}

it('the download asks for this account revision and accepts only a complete receipt', async () => {
  const status = { revision: 2, fetchedMs: 1, programs: 10, channels: 3, skipped: 1 };
  const { guide, calls } = bridge(status);
  await expect(guide.refresh(account)).resolves.toEqual(status);
  expect(calls[0]).toEqual({
    command: 'refresh_iptv_account_guide',
    args: {
      request: { schemaVersion: 1, accountId: account.id, expectedRevision: '3' },
      requestId: 'request-1',
    },
  });
  // A refresh never answers "no guide".
  await expect(bridge(null).guide.refresh(account)).rejects.toThrow();
  expect(validateAccountGuideStatus(null)).toBeNull();
  for (const bad of [
    { ...status, revision: 0 },
    { ...status, skipped: -1 },
    { ...status, programs: 1.5 },
    { ...status, address: 'http://x' },
  ])
    expect(() => validateAccountGuideStatus(bad)).toThrow();
});

it('channels must belong to this account and carry only an opaque playback reference', async () => {
  await expect(bridge([channel]).guide.channels(account)).resolves.toEqual([channel]);
  for (const bad of [
    { ...channel, id: `account-${'c'.repeat(32)}-x` },
    { ...channel, streamReference: 'http://provider.invalid/live/u/p/1.ts' },
    { ...channel, url: 'http://provider.invalid' },
    { ...channel, favorite: 'yes' },
  ])
    await expect(bridge([bad]).guide.channels(account)).rejects.toThrow();
  await expect(bridge([channel, channel]).guide.channels(account)).rejects.toThrow();
  await expect(bridge([{ ...channel, ppv: true }]).guide.channels(account)).resolves.toEqual([
    { ...channel, ppv: true },
  ]);
  await expect(bridge([{ ...channel, ppv: 'true' }]).guide.channels(account)).rejects.toThrow();
});

it('only explicit PPV Guide scope reaches listed and program requests', async () => {
  const listed = bridge({ revision: 1, epgIds: ['x'], channelIds: [] });
  await listed.guide.listed(account, 1, 2, 'boxing');
  await listed.guide.listed(account, 1, 2, 'boxing', undefined, true);
  expect(listed.calls.map((call) => (call.args.request as { ppv?: boolean }).ppv)).toEqual([
    undefined,
    true,
  ]);
  const programs = bridge({ revision: 1, programs: [] });
  await programs.guide.programs(account, 'x', 1, 2, null, 10);
  await programs.guide.programs(account, 'x', 1, 2, null, 10, undefined, true, channel.id);
  expect(programs.calls.map((call) => (call.args.request as { ppv?: boolean }).ppv)).toEqual([
    undefined,
    true,
  ]);
  expect((programs.calls[1]!.args.request as { channelId: string }).channelId).toBe(channel.id);
  expect(() => programs.guide.programs(account, 'x', 1, 2, null, 10, undefined, true)).toThrow();
  expect(() =>
    programs.guide.programs(account, 'x', 1, 2, null, 10, undefined, false, 'other-account'),
  ).toThrow();
});
it('Paid listed membership validates authoritative channel identity without widening shared EPG aliases', async () => {
  await expect(
    bridge({ revision: 1, epgIds: ['shared'], channelIds: [channel.id] }).guide.listed(
      account,
      1,
      2,
      '',
    ),
  ).resolves.toEqual({ revision: 1, epgIds: ['shared'], channelIds: [channel.id] });
  await expect(
    bridge({ revision: 1, epgIds: ['shared'], channelIds: [] }).guide.listed(account, 1, 2, ''),
  ).resolves.toMatchObject({ channelIds: [] });
  for (const channelIds of [[channel.id, channel.id], ['wrong-account'], 'not-an-array'])
    await expect(
      bridge({ revision: 1, epgIds: ['shared'], channelIds }).guide.listed(account, 1, 2, ''),
    ).rejects.toThrow();
  await expect(
    bridge({ revision: 1, epgIds: ['shared'] }).guide.listed(account, 1, 2, ''),
  ).resolves.toEqual({ revision: 1, epgIds: ['shared'] });
  await expect(
    bridge({ revision: 1, epgIds: ['shared'] }).guide.listed(account, 1, 2, '', undefined, true),
  ).rejects.toThrow();
});
it('preserves canonical country facts and refuses noncanonical or malformed metadata', async () => {
  for (const country of ['US', 'CA', 'UK', null])
    await expect(bridge([{ ...channel, country }]).guide.channels(account)).resolves.toEqual([
      { ...channel, country },
    ]);
  for (const country of ['USA', 'us', ['US'], 12, {}])
    await expect(bridge([{ ...channel, country }]).guide.channels(account)).rejects.toThrow();
});

it('listings are checked against the asked channel, time order and page size', async () => {
  const program = {
    epgId: 'fox32.us',
    startMs: 1000,
    stopMs: 2000,
    ordinal: 0,
    title: 'NFL Football',
    description: null,
    categories: [],
  };
  const { guide, calls } = bridge({ revision: 2, programs: [program] });
  const page = await guide.programs(account, 'fox32.us', 0, 5000, { startMs: 1, ordinal: 0 }, 50);
  expect(page.programs[0]!.title).toBe('NFL Football');
  expect(calls[0]!.args.request).toEqual({
    schemaVersion: 1,
    accountId: account.id,
    epgId: 'fox32.us',
    fromMs: 0,
    toMs: 5000,
    limit: 50,
    afterStartMs: 1,
    afterOrdinal: 0,
  });
  for (const bad of [
    { ...program, epgId: 'other.us' },
    { ...program, stopMs: 500 },
    { ...program, title: '' },
  ])
    await expect(
      bridge({ revision: 2, programs: [bad] }).guide.programs(
        account,
        'fox32.us',
        0,
        5000,
        null,
        50,
      ),
    ).rejects.toThrow();
  await expect(
    bridge({ revision: 2, programs: [program, program] }).guide.programs(
      account,
      'fox32.us',
      0,
      5000,
      null,
      1,
    ),
  ).rejects.toThrow();
});

it('automatic cached renewal explicitly carries its native permission and due policy', async () => {
  const status = { revision: 2, fetchedMs: 1, programs: 10, channels: 3, skipped: 1 };
  const { guide, calls } = bridge(status);
  await guide.refresh(account, undefined, { automatic: true });
  expect(calls[0].args.request).toEqual({
    schemaVersion: 1,
    accountId: account.id,
    expectedRevision: '3',
    automatic: true,
  });
});
