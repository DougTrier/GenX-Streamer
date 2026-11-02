/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { expect, it, vi } from 'vitest';
import { PlaybackController, type ChannelSelection } from '../../src/playback/controller';
import { createSharingAndCasting } from '../../src/application/sharing/sharing-and-casting';
import { createGuidePlaybackIntents } from '../../src/application/playback/guide-playback-intent';
import type { createArchivePlayer } from '../../src/application/genxtra/archive-player';

const startup = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock('../../src/diagnostics/archive-startup', () => ({
  recordArchiveStartupFailure: startup.record,
}));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
function fixture(withIntent = true) {
  const barrier = gate();
  const state = { allowed: true, closing: false };
  const starts = vi.fn(async () => {});
  const player = new PlaybackController(() => ({
    start: starts,
    pause() {},
    resume: async () => {},
    setMuted() {},
    setVolume() {},
    dispose() {},
  }));
  const intents = createGuidePlaybackIntents({ prepare: () => barrier.promise, wake() {} });
  const selectPublic = vi.fn((...args: Parameters<PlaybackController['select']>) =>
    player.select(...args),
  );
  const elements = new Map<string, object>();
  const env = {
    bootstrapBoundary: {
      run: (name: string, create: () => unknown) => (name === 'sharing' ? create() : undefined),
    },
    player,
    foregroundPlaybackAllowed: () => state.allowed,
    admitForegroundPlayback() {
      if (!state.allowed || state.closing)
        throw new DOMException('Playback is unavailable.', 'AbortError');
    },
    beginPlaybackIntent: withIntent ? () => intents.begin() : undefined,
    pendingAccountPlayback: null,
    pendingPublicPlayback: null,
    backgroundLiveChoice: null,
    clearArchiveResume() {},
    accountPlayer: { selection: null, selectPublic, stop: () => player.stop() },
    archivePlayer: undefined,
    privatePlayback: () => false,
    catalog: {
      schemaVersion: 1,
      sources: [
        { id: 'source', name: 'Fixture', kind: 'url', location: 'https://fixture.invalid/list' },
      ],
      channels: ['a', 'b'].map((id) => ({
        id,
        sourceId: 'source',
        name: id.toUpperCase(),
        category: 'Sports',
        urls: [`https://fixture.invalid/${id}`],
      })),
    },
    persistedCatalogRevision: '1',
    localStreams: undefined,
    shareLinks: undefined,
    settings: { muted: false, volume: 0.7, removedChannels: [] },
    saveSettings: async () => true,
    get applicationClosing() {
      return state.closing;
    },
    notice: vi.fn(),
    archiveRuntimeScope: () => 'fixture-root',
    library: { archiveIndexRevision: '1' },
    recordArchiveRevision() {},
    archiveActiveScope: () => null,
    archiveSearch: undefined,
    libraryQueries: { live: '', genxtra: '' },
    friendlyError: () => 'Fixture failure',
    element: (id: string) => {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    },
    renderPlayer() {},
  };
  const app = createSharingAndCasting(
    env as unknown as Parameters<typeof createSharingAndCasting>[0],
  );
  const selection = (id: string): ChannelSelection => ({
    id,
    name: id,
    url: `https://fixture.invalid/${id}`,
  });
  return {
    app,
    env,
    state,
    barrier,
    intents,
    selectPublic,
    starts,
    selection,
    async dispose() {
      barrier.resolve();
      await app.sharingBridge.dispose();
      await (env.archivePlayer as unknown as { dispose(): Promise<void> }).dispose();
    },
  };
}

it('actual SharingHost Stop wins a browser selection waiting for Guide quiescence', async () => {
  const f = fixture();
  const work = f.app.sharingBridge.select(f.selection('a'));
  const outcome = work.catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(f.intents.pending).toBe(1));
    await f.app.sharingBridge.stop();
    f.barrier.resolve();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(f.selectPublic).not.toHaveBeenCalled();
    expect(f.starts).not.toHaveBeenCalled();
    expect(f.intents.pending).toBe(0);
  } finally {
    f.barrier.resolve();
    await outcome;
    await f.dispose();
  }
});

it('only the latest actual SharingHost selection acquires after a shared delayed barrier', async () => {
  const f = fixture();
  const first = f.app.sharingBridge.select(f.selection('a')).catch((error: unknown) => error);
  const second = f.app.sharingBridge.select(f.selection('b'));
  try {
    await vi.waitFor(() => expect(f.intents.pending).toBe(2));
    f.barrier.resolve();
    expect(await first).toMatchObject({ name: 'AbortError' });
    await second;
    expect(f.selectPublic).toHaveBeenCalledOnce();
    expect(f.selectPublic.mock.calls[0][0].id).toBe('b');
    expect(f.starts).toHaveBeenCalledOnce();
    expect(f.intents.pending).toBe(0);
  } finally {
    f.barrier.resolve();
    await Promise.allSettled([first, second]);
    await f.dispose();
  }
});

it.each(['background', 'closing'] as const)(
  'refuses a browser selection after %s wins the barrier',
  async (reason) => {
    const f = fixture();
    const work = f.app.sharingBridge.select(f.selection('a')).catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(f.intents.pending).toBe(1));
      if (reason === 'background') f.state.allowed = false;
      else f.state.closing = true;
      f.barrier.resolve();
      expect(await work).toMatchObject({ name: 'AbortError' });
      expect(f.selectPublic).not.toHaveBeenCalled();
      expect(f.starts).not.toHaveBeenCalled();
      expect(f.intents.pending).toBe(0);
    } finally {
      f.barrier.resolve();
      await work;
      await f.dispose();
    }
  },
);

it('preserves direct browser playback for a legacy host without a Guide intent hook', async () => {
  const f = fixture(false);
  try {
    await f.app.sharingBridge.select(f.selection('a'));
    expect(f.selectPublic).toHaveBeenCalledOnce();
    expect(f.starts).toHaveBeenCalledOnce();
    expect(f.intents.pending).toBe(0);
  } finally {
    await f.dispose();
  }
});

it('wires the actual Archive actor failure to the closed startup recorder before decoder admission', async () => {
  const f = fixture(false);
  try {
    const archive = f.env.archivePlayer as unknown as ReturnType<typeof createArchivePlayer>;
    await expect(
      archive.select({
        titleRef: 'a'.repeat(64),
        fileRef: 'b'.repeat(64),
        expectedRevision: '1',
        title: 'Offline fixture',
        fileTitle: 'Offline video',
      }),
    ).rejects.toThrow('requires the installed application');
    expect(startup.record).toHaveBeenCalledOnce();
    expect(startup.record.mock.calls[0][0]).toBe('allocate');
    expect(f.starts).not.toHaveBeenCalled();
  } finally {
    await f.dispose();
  }
});
