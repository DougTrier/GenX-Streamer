// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { createAccountPlayer } from '../../src/application/accounts/account-player';
import { createArchivePlayer } from '../../src/application/genxtra/archive-player';
import type { ChannelSelection } from '../../src/playback/controller';
import {
  archiveStreamBufferKey,
  paidStreamBufferKey,
} from '../../src/playback/stream-buffer-preferences';

afterEach(() => vi.unstubAllGlobals());
const ACCOUNT = 'a'.repeat(32);
const channel = {
  id: `account-${ACCOUNT}-${'b'.repeat(64)}`,
  name: 'Fixture feed',
  category: 'News',
  providerId: '17',
  epgId: null,
  streamReference: 'c'.repeat(32),
};
const fence = { accountId: ACCOUNT, accountRevision: '1', mediaRevision: '1' };
const mediaUrl = `http://127.0.0.1:41234/account/${'d'.repeat(64)}/media/${'e'.repeat(64)}`;
function accountFixture() {
  const select = vi.fn(async (_selection: ChannelSelection) => undefined);
  const stop = vi.fn(async () => undefined);
  let generation = 0;
  const start = vi.fn(async () => ({
    schemaVersion: 1 as const,
    sessionGeneration: String(++generation),
    mediaUrl,
    mediaHint: 'mpegts' as const,
    alternateAvailable: true as const,
  }));
  const owner = createAccountPlayer({
    player: { select, stop, suspend: stop },
    playback: {
      start,
      stop: async (sessionGeneration) => ({ schemaVersion: 1, stopped: true, sessionGeneration }),
      retryCleanup: async () => undefined,
    },
    busy: async () => () => {},
  });
  return { owner, select, start };
}
function holdDigest() {
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  const original = globalThis.crypto;
  const digest = vi.fn(async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
    await gate;
    return original.subtle.digest(algorithm, data);
  });
  vi.stubGlobal('crypto', { subtle: { digest }, randomUUID: original.randomUUID.bind(original) });
  return { release, digest };
}

it('actual Paid owner preserves key through refresh/capability replacement and separates alternate source', async () => {
  const f = accountFixture();
  try {
    await f.owner.selectAccount(channel, fence);
    const first = f.select.mock.lastCall![0];
    expect(first.liveBufferKey).toBe(await paidStreamBufferKey(ACCOUNT, channel.id, 'primary'));
    expect(first.liveBufferKey).not.toContain(channel.streamReference);
    await f.owner.selectAccount(
      { ...channel, streamReference: 'f'.repeat(32) },
      { ...fence, accountRevision: '3', mediaRevision: '12' },
    );
    expect(f.select.mock.lastCall![0].liveBufferKey).toBe(first.liveBufferKey);
    await expect(f.owner.retryAlternate()).resolves.toBe(true);
    expect(f.select.mock.lastCall![0].liveBufferKey).toBe(
      await paidStreamBufferKey(ACCOUNT, channel.id, 'alternate'),
    );
    expect(f.select.mock.lastCall![0].liveBufferKey).not.toBe(first.liveBufferKey);
  } finally {
    await f.owner.dispose();
  }
});

it('Paid owner joins delayed key derivation and rechecks cancellation before native session/decoder allocation', async () => {
  const held = holdDigest();
  const f = accountFixture();
  const abort = new AbortController();
  const starting = f.owner.selectAccount(channel, fence, abort.signal);
  const refused = expect(starting).rejects.toHaveProperty('name', 'AbortError');
  try {
    await vi.waitFor(() => expect(held.digest).toHaveBeenCalledTimes(1));
    expect(f.start).not.toHaveBeenCalled();
    abort.abort();
    held.release();
    await refused;
    expect(f.start).not.toHaveBeenCalled();
    expect(f.select).not.toHaveBeenCalled();
  } finally {
    held.release();
    await f.owner.dispose();
  }
});

it('Archive owner reuses stable file identity across relay sessions and refuses late key completion after cancellation', async () => {
  const select = vi.fn(async (_selection: ChannelSelection) => undefined);
  const stop = vi.fn(async () => undefined);
  let generation = 0;
  const start = vi.fn(async () => ({
    kind: 'started' as const,
    schemaVersion: 1 as const,
    sessionGeneration: String(++generation),
    mediaUrl: `http://127.0.0.1:41234/archive/${'c'.repeat(64)}/${'d'.repeat(64)}.mp4`,
    leaseMs: 60000 as const,
    cleanupPending: false as const,
  }));
  let revision = '1';
  const owner = createArchivePlayer({
    player: { select, stop },
    readyScope: () => 'owned-root',
    catalogRevision: () => revision,
    beforeStart: async () => undefined,
    playback: {
      start,
      stop: async (sessionGeneration) => ({
        schemaVersion: 1,
        stopped: true,
        sessionGeneration,
        cleanupPending: false,
      }),
      renew: async (sessionGeneration) => ({
        schemaVersion: 1,
        renewed: true,
        sessionGeneration,
        leaseMs: 60000,
      }),
      retryCleanup: async () => undefined,
    },
  });
  const file = {
    titleRef: 'a'.repeat(64),
    fileRef: 'b'.repeat(64),
    expectedRevision: '1',
    title: 'Fixture',
    fileTitle: 'Fixture episode',
  };
  try {
    await owner.select(file);
    const first = select.mock.lastCall![0].liveBufferKey;
    expect(first).toBe(await archiveStreamBufferKey(file.fileRef, 'remote'));
    await owner.stop();
    revision = '2';
    await owner.select({ ...file, expectedRevision: revision });
    expect(select.mock.lastCall![0].liveBufferKey).toBe(first);
    await owner.stop();
    const held = holdDigest();
    const abort = new AbortController();
    const starting = owner.select({ ...file, expectedRevision: revision }, abort.signal);
    const refused = expect(starting).rejects.toHaveProperty('name', 'AbortError');
    await vi.waitFor(() => expect(held.digest).toHaveBeenCalledTimes(1));
    const beforeStarts = start.mock.calls.length;
    const beforeDecoders = select.mock.calls.length;
    abort.abort();
    held.release();
    await refused;
    expect(start.mock.calls.length).toBe(beforeStarts);
    expect(select.mock.calls.length).toBe(beforeDecoders);
  } finally {
    await owner.dispose();
  }
});
