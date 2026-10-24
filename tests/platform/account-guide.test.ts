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
