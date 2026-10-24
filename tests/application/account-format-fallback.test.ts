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

import { expect, it, vi } from 'vitest';
import { createAccountPlayer } from '../../src/application/accounts/account-player';
import { validateAccountPlaybackReceipt } from '../../src/platform/account-playback';

const A = 'a'.repeat(32);
const mediaUrl = `http://127.0.0.1:41234/account/${'c'.repeat(64)}/media/${'d'.repeat(64)}`;
const channel = {
  id: `account-${A}-${'e'.repeat(64)}`,
  name: 'Fixture',
  category: 'Sports',
  providerId: null,
  epgId: null,
  streamReference: 'f'.repeat(32),
};
const fence = { accountId: A, accountRevision: '1', mediaRevision: '1' };

function harness(alternates: boolean[]) {
  const select = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  let generation = 0;
  const start = vi.fn(async (_input: unknown, _signal?: AbortSignal, _options?: unknown) => ({
    schemaVersion: 1 as const,
    sessionGeneration: String(++generation),
    mediaUrl,
    mediaHint: 'mpegts' as const,
    ...(alternates[generation - 1] ? { alternateAvailable: true as const } : {}),
  }));
  const owner = createAccountPlayer({
    player: { select, stop, suspend: stop },
    playback: {
      start,
      stop: vi.fn(async (sessionGeneration: string) => ({
        schemaVersion: 1 as const,
        stopped: true as const,
        sessionGeneration,
      })),
      retryCleanup: async () => undefined,
    },
  });
  return { owner, start, select };
}

it('the receipt may say another stored format exists, and nothing else', () => {
  const base = { schemaVersion: 1, sessionGeneration: '1', mediaUrl, mediaHint: 'mpegts' };
  expect(
    validateAccountPlaybackReceipt({ ...base, alternateAvailable: true }).alternateAvailable,
  ).toBe(true);
  expect(validateAccountPlaybackReceipt(base).alternateAvailable).toBeUndefined();
  expect(() => validateAccountPlaybackReceipt({ ...base, alternateAvailable: false })).toThrow();
  expect(() => validateAccountPlaybackReceipt({ ...base, alternateAvailable: 'yes' })).toThrow();
});

it('a failed start may try the provider’s other format once, then never again', async () => {
  const { owner, start } = harness([true, false]);
  await owner.selectAccount(channel, fence);
  expect(owner.alternateAvailable).toBe(true);
  expect(start.mock.calls[0][2]).toBeUndefined();
  expect(await owner.retryAlternate()).toBe(true);
  // The same channel and fence, asking native for its other stored format.
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls[1][0]).toEqual(start.mock.calls[0][0]);
  expect(start.mock.calls[1][2]).toEqual({ alternate: true });
  expect(owner.alternateAvailable).toBe(false);
  expect(await owner.retryAlternate()).toBe(false);
  expect(start).toHaveBeenCalledTimes(2);
  await owner.dispose();
});

it('without a stored second format nothing is retried', async () => {
  const { owner, start } = harness([false]);
  await owner.selectAccount(channel, fence);
  expect(owner.alternateAvailable).toBe(false);
  expect(await owner.retryAlternate()).toBe(false);
  expect(start).toHaveBeenCalledTimes(1);
  await owner.dispose();
});

it('a session already given its other format cannot loop, even if native says so again', async () => {
  const { owner, start } = harness([true, true, true]);
  await owner.selectAccount(channel, fence);
  expect(await owner.retryAlternate()).toBe(true);
  // Native would offer the first format again; the player does not bounce back.
  expect(await owner.retryAlternate()).toBe(false);
  expect(start).toHaveBeenCalledTimes(2);
  // A new choice of the channel starts fresh.
  await owner.selectAccount(channel, fence);
  expect(owner.alternateAvailable).toBe(true);
  await owner.dispose();
});
