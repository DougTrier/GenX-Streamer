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

import { describe, expect, it, vi } from 'vitest';
import {
  createAccountPlayer,
  PROVIDER_BUSY_MESSAGE,
} from '../../src/application/accounts/account-player';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const mediaUrl = `http://127.0.0.1:41234/account/${'c'.repeat(64)}/media/${'d'.repeat(64)}`;
const channel = (account: string) => ({
  id: `account-${account}-${'e'.repeat(64)}`,
  name: 'Fixture',
  category: 'News',
  providerId: null,
  epgId: null,
  streamReference: 'f'.repeat(32),
});
const fence = (account: string) => ({
  accountId: account,
  accountRevision: '1',
  mediaRevision: '1',
});

function player(buffers: Record<string, 'fast' | 'balanced' | 'smooth'>) {
  const select = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  let generation = 0;
  const owner = createAccountPlayer({
    player: { select, stop, suspend: stop },
    playback: {
      start: vi.fn(async () => ({
        schemaVersion: 1 as const,
        sessionGeneration: String(++generation),
        mediaUrl,
        mediaHint: 'mpegts' as const,
      })),
      stop: vi.fn(async (sessionGeneration: string) => ({
        schemaVersion: 1 as const,
        stopped: true as const,
        sessionGeneration,
      })),
      retryCleanup: async () => undefined,
    },
    bufferFor: (id) => buffers[id] ?? 'balanced',
  });
  return { owner, select };
}

it("each account's live channels start with that account's buffer", async () => {
  const buffers: Record<string, 'fast' | 'balanced' | 'smooth'> = { [A]: 'fast', [B]: 'smooth' };
  const { owner, select } = player(buffers);
  await owner.selectAccount(channel(A), fence(A));
  expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ buffer: 'fast' }));
  await owner.selectAccount(channel(B), fence(B));
  expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ buffer: 'smooth' }));
  await owner.selectAccount(channel(A), fence(A));
  expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ buffer: 'fast' }));
  await owner.dispose();
});

it('a balanced account between two fast starts inherits nothing', async () => {
  const { owner, select } = player({ [A]: 'fast', [B]: 'balanced' });
  await owner.selectAccount(channel(A), fence(A));
  await owner.selectAccount(channel(B), fence(B));
  // The middle session keeps the engine's own balanced defaults.
  expect((select.mock.lastCall as unknown[])[0]).not.toHaveProperty('buffer');
  await owner.selectAccount(channel(A), fence(A));
  expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ buffer: 'fast' }));
  await owner.dispose();
});

it('balanced adds nothing, and a changed choice applies only to the next start', async () => {
  const buffers: Record<string, 'fast' | 'balanced' | 'smooth'> = {};
  const { owner, select } = player(buffers);
  await owner.selectAccount(channel(A), fence(A));
  expect((select.mock.lastCall as unknown[])[0]).not.toHaveProperty('buffer');
  buffers[A] = 'smooth';
  // The running stream is not restarted by the change.
  expect(select).toHaveBeenCalledTimes(1);
  await owner.selectAccount(channel(A), fence(A));
  expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ buffer: 'smooth' }));
  await owner.dispose();
});

it('on-demand titles are not live streams and carry no live buffer', async () => {
  const { owner, select } = player({ [A]: 'fast' });
  await owner.selectVod(
    { kind: 'movie', itemId: '1', extension: 'mp4', name: 'Title' },
    { accountId: A, accountRevision: '1' },
  );
  expect((select.mock.lastCall as unknown[])[0]).not.toHaveProperty('buffer');
  await owner.dispose();
});

describe('provider busy while a paid channel starts', () => {
  function busyPlayer() {
    const select = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const note = vi.fn();
    let notify: ((generation: string) => void) | null = null;
    let generation = 0;
    const owner = createAccountPlayer({
      player: { select, stop, suspend: stop, note },
      playback: {
        start: vi.fn(async () => ({
          schemaVersion: 1 as const,
          sessionGeneration: String(++generation),
          mediaUrl,
          mediaHint: 'mpegts' as const,
        })),
        stop: vi.fn(async (sessionGeneration: string) => ({
          schemaVersion: 1 as const,
          stopped: true as const,
          sessionGeneration,
        })),
        retryCleanup: async () => undefined,
      },
      bufferFor: () => 'balanced',
      busy: async (callback) => {
        notify = callback;
        return () => {
          notify = null;
        };
      },
    });
    return { owner, select, note, emit: (generation: string) => notify?.(generation) };
  }
  it('explains the wait for the starting channel only, and gives live starts a longer window', async () => {
    const { owner, select, note, emit } = busyPlayer();
    await owner.selectAccount(channel(A), fence(A));
    expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ startupMs: 35_000 }));
    emit('99');
    expect(note).not.toHaveBeenCalled();
    emit('1');
    expect(note).toHaveBeenCalledWith(channel(A).id, PROVIDER_BUSY_MESSAGE);
    await owner.dispose();
  });
  it('on-demand titles neither get the live window nor the busy note', async () => {
    const { owner, select, note, emit } = busyPlayer();
    await owner.selectAccount(channel(A), fence(A));
    await owner.selectVod(
      { kind: 'movie', itemId: '1', extension: 'mp4', name: 'Title' },
      { accountId: A, accountRevision: '1' },
    );
    expect((select.mock.lastCall as unknown[])[0]).not.toHaveProperty('startupMs');
    emit('2');
    expect(note).not.toHaveBeenCalled();
    await owner.dispose();
  });
});
