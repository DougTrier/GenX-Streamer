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
import { createSharingHost, type SharingActionContext } from '../../src/application/sharing-host';
import { PlaybackController, type EngineEvent } from '../../src/playback/controller';
import type { Channel } from '../../src/catalog';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function fixture() {
  const events: ((event: EngineEvent) => void)[] = [];
  let starts = 0;
  let releases = 0;
  let playbackAllowed = true;
  const player = new PlaybackController((emit) => {
    events.push(emit);
    return {
      start: async () => {
        starts++;
      },
      pause: () => {},
      resume: async () => {},
      setMuted: () => {},
      setVolume: () => {},
      dispose: () => {
        releases++;
      },
    };
  });
  let channels: Channel[] = ['a', 'b'].map((id) => ({
    id,
    sourceId: 'source',
    name: id.toUpperCase(),
    category: 'Sports',
    urls: [`https://example.invalid/${id}`],
  }));
  const settings = { muted: false, volume: 0.7, removedChannels: [] as string[] };
  const bridge = createSharingHost({
    player,
    playbackAllowed: () => playbackAllowed,
    channels: () => channels,
    settings: () => settings,
    saveAudio: async (patch) => {
      Object.assign(settings, patch);
    },
  });
  const invalidations: { generation: number; commandId?: string; preservePublication?: boolean }[] =
    [];
  bridge.bindBeforeSelection(async (generation, commandId, preservePublication) => {
    invalidations.push({ generation, commandId, preservePublication });
  });
  const selection = (id = 'a') => ({ id, name: id, url: `https://example.invalid/${id}` });
  return {
    player,
    bridge,
    events,
    settings,
    invalidations,
    selection,
    setChannels: (value: Channel[]) => {
      channels = value;
    },
    setPlaybackAllowed: (value: boolean) => {
      playbackAllowed = value;
    },
    starts: () => starts,
    releases: () => releases,
  };
}
function context(authorized = async () => true) {
  const abort = new AbortController();
  const context: SharingActionContext = { signal: abort.signal, commandId: 'phone-1', authorized };
  return { abort, context };
}
describe('sharing host ownership bridge', () => {
  it('an authorized phone Resume cannot allocate while foreground playback admission is closed', async () => {
    const f = fixture();
    try {
      await f.bridge.select(f.selection());
      await f.bridge.suspend();
      f.setPlaybackAllowed(false);
      await expect(
        f.bridge.host.apply({ kind: 'resume' }, context().context),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(f.player.snapshot.state).toBe('paused');
      expect(f.starts()).toBe(1);
      expect(f.releases()).toBe(1);
      f.setPlaybackAllowed(true);
      await f.bridge.resume();
      expect(f.starts()).toBe(2);
    } finally {
      await f.bridge.dispose();
    }
  });
  it('background joins the original publication gate and refuses its late decoder admission', async () => {
    const f = fixture();
    const gate = deferred();
    const entered = deferred();
    f.bridge.bindBeforeSelection(async (generation) => {
      if (generation === 1) {
        entered.resolve();
        await gate.promise;
      }
    });
    const selecting = f.bridge.select(f.selection());
    const selected = selecting.catch((error: unknown) => error);
    await entered.promise;
    let settled = false;
    const suspending = f.bridge.suspend().then(() => {
      settled = true;
    });
    try {
      await flush();
      expect(settled).toBe(false);
      expect(f.starts()).toBe(0);
      gate.resolve();
      await suspending;
      expect(await selected).toMatchObject({ name: 'AbortError' });
      expect(f.starts()).toBe(0);
    } finally {
      gate.resolve();
      await Promise.allSettled([selected, suspending]);
      await f.bridge.dispose();
    }
  });
  it('background propagates a real original publication cleanup failure after joining its gate', async () => {
    const f = fixture();
    const gate = deferred(),
      entered = deferred();
    f.bridge.bindBeforeSelection(async (generation) => {
      if (generation === 1) {
        entered.resolve();
        await gate.promise;
        throw new Error('controlled publication cleanup failed');
      }
    });
    const selecting = f.bridge.select(f.selection()).catch((error: unknown) => error);
    await entered.promise;
    const suspending = f.bridge.suspend();
    const rejected = expect(suspending).rejects.toThrow('controlled publication cleanup failed');
    gate.resolve();
    await rejected;
    expect(await selecting).toBeInstanceOf(Error);
    expect(f.starts()).toBe(0);
    await f.bridge.dispose();
  });
  it('without LAN sharing, background suspension aborts the decoder before yielding to lifecycle pause', async () => {
    let aborted = false;
    const player = new PlaybackController(() => ({
      start: async (_selection, signal) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
      },
      pause: () => {},
      resume: async () => {},
      setMuted: () => {},
      setVolume: () => {},
      dispose: () => {},
    }));
    const bridge = createSharingHost({
      player,
      channels: () => [
        { id: 'a', sourceId: 's', name: 'A', category: '', urls: ['https://example.invalid/a'] },
      ],
      settings: () => ({ muted: false, volume: 1, removedChannels: [] }),
      saveAudio: async () => {},
    });
    await bridge.select({ id: 'a', name: 'A', url: 'https://example.invalid/a' });
    const stopped = bridge.suspend();
    expect(aborted).toBe(true);
    expect(player.snapshot.state).toBe('paused');
    await stopped;
    await bridge.dispose();
  });
  it('revalidates removal immediately before the decoder mutation', async () => {
    const f = fixture();
    const wait = deferred();
    f.bridge.bindBeforeSelection(async () => wait.promise);
    const pending = f.bridge.select(f.selection());
    f.settings.removedChannels = ['a'];
    wait.resolve();
    await expect(pending).rejects.toThrow('no longer');
    expect(f.starts()).toBe(0);
    f.bridge.bindBeforeSelection(async () => {});
    await f.bridge.dispose();
  });
  it('concurrent disposal has one decoder cleanup owner', async () => {
    const f = fixture();
    await f.bridge.select(f.selection());
    await Promise.all([f.bridge.dispose(), f.bridge.dispose()]);
    expect(f.releases()).toBe(1);
    expect(f.player.snapshot.state).toBe('disposed');
    await expect(f.bridge.select(f.selection('b'))).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('invalidates before mutation and never shows the old decoder as PLAYING under a pending generation', async () => {
    const f = fixture();
    await f.bridge.select(f.selection());
    f.events[0]({ type: 'progress' });
    expect(f.bridge.host.snapshot().playback.state).toBe('playing');
    const wait = deferred();
    f.bridge.bindBeforeSelection(async (generation) => {
      f.invalidations.push({ generation });
      await wait.promise;
    });
    const pending = f.bridge.select(f.selection('b'));
    expect(f.bridge.host.snapshot()).toMatchObject({
      generation: 2,
      playback: { state: 'connecting', selection: { id: 'b' } },
    });
    expect(f.starts()).toBe(1);
    wait.resolve();
    await pending;
    expect(f.starts()).toBe(2);
    expect(f.bridge.host.snapshot().playback.state).toBe('connecting');
    await f.bridge.dispose();
  });
  it('capability identifies HLS without proving decode; only actual progress changes PLAYING', async () => {
    const f = fixture();
    await f.bridge.select(f.selection());
    f.events[0]({
      type: 'capability',
      mediaKind: 'hls',
      mediaMime: 'application/vnd.apple.mpegurl',
    });
    expect(f.bridge.host.snapshot().playback).toMatchObject({
      state: 'connecting',
      selection: { mediaKind: 'hls' },
    });
    f.events[0]({ type: 'progress' });
    expect(f.bridge.host.snapshot().playback.state).toBe('playing');
    await f.bridge.dispose();
  });
  it('rechecks authorization after invalidation before starting a decoder', async () => {
    const f = fixture();
    const gate = deferred();
    let allowed = true;
    f.bridge.bindBeforeSelection(async () => {
      await gate.promise;
    });
    const c = context(async () => allowed);
    const pending = f.bridge.host.apply({ kind: 'select', channelId: 'a' }, c.context);
    await flush();
    allowed = false;
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.starts()).toBe(0);
    f.bridge.bindBeforeSelection(async () => {});
    await f.bridge.dispose();
  });
  it('a local change supersedes a phone command waiting for admission', async () => {
    const f = fixture();
    const gate = deferred();
    const c = context(async () => {
      await gate.promise;
      return true;
    });
    const pending = f.bridge.host.apply({ kind: 'select', channelId: 'a' }, c.context);
    await f.bridge.select(f.selection('b'));
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.bridge.host.snapshot().playback.selection?.id).toBe('b');
    expect(f.starts()).toBe(1);
    await f.bridge.dispose();
  });
  it('canceling a connecting phone selection stops its current generation', async () => {
    const f = fixture();
    const c = context();
    await f.bridge.host.apply({ kind: 'select', channelId: 'a' }, c.context);
    expect(f.invalidations[0].commandId).toBe('phone-1');
    c.abort.abort();
    await flush();
    expect(f.player.snapshot.state).toBe('idle');
    expect(f.bridge.host.snapshot().generation).toBe(2);
    await f.bridge.dispose();
  });
  it('an old phone cancellation cannot stop a newer local selection', async () => {
    const f = fixture();
    const c = context();
    await f.bridge.host.apply({ kind: 'select', channelId: 'a' }, c.context);
    await f.bridge.select(f.selection('b'));
    c.abort.abort();
    await flush();
    expect(f.player.snapshot.selection?.id).toBe('b');
    expect(f.player.snapshot.state).toBe('connecting');
    await f.bridge.dispose();
  });
  it('decode-confirmed phone actions relinquish pending cancellation ownership', async () => {
    const f = fixture();
    const c = context();
    await f.bridge.host.apply({ kind: 'select', channelId: 'a' }, c.context);
    f.events[0]({ type: 'progress' });
    c.abort.abort();
    await flush();
    expect(f.player.snapshot.state).toBe('playing');
    await f.bridge.dispose();
  });
  it('rejects removed, unknown and unadmitted channel URLs without invalidating playback', async () => {
    const f = fixture();
    f.settings.removedChannels = ['a'];
    expect(f.bridge.host.channels()).toEqual([{ id: 'b', name: 'B' }]);
    await expect(f.bridge.select(f.selection('a'))).rejects.toThrow('no longer');
    await expect(
      f.bridge.select({ ...f.selection('b'), url: 'https://elsewhere.invalid' }),
    ).rejects.toThrow('admitted');
    expect(f.invalidations).toHaveLength(0);
    await f.bridge.dispose();
  });
  it('pause, background suspension and resume preserve publication while advancing action ownership', async () => {
    const f = fixture();
    await f.bridge.select(f.selection());
    f.events[0]({ type: 'progress' });
    await f.bridge.pause();
    expect(f.bridge.host.snapshot().playback.state).toBe('paused');
    await f.bridge.suspend();
    expect(f.releases()).toBe(1);
    await f.bridge.resume();
    expect(f.bridge.host.snapshot().playback.state).toBe('connecting');
    expect(f.invalidations.map((item) => item.generation)).toEqual([1, 2, 3, 4]);
    expect(f.invalidations.map((item) => item.preservePublication)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    await f.bridge.stop();
    expect(f.invalidations.at(-1)?.preservePublication).toBe(false);
    await f.bridge.dispose();
  });
  it('refuses resume when the same channel id now has a different canonical URL', async () => {
    const f = fixture();
    await f.bridge.select(f.selection());
    f.events[0]({ type: 'progress' });
    await f.bridge.pause();
    f.setChannels([
      {
        id: 'a',
        sourceId: 'source',
        name: 'A',
        category: '',
        urls: ['https://example.invalid/replaced'],
      },
    ]);
    await expect(f.bridge.resume()).rejects.toThrow('no longer admitted');
    expect(f.invalidations).toHaveLength(2);
    expect(f.player.snapshot.state).toBe('paused');
    await f.bridge.dispose();
  });
  it('rechecks the paused canonical URL after the publication-preserving gate settles', async () => {
    const f = fixture();
    await f.bridge.select(f.selection());
    f.events[0]({ type: 'progress' });
    await f.bridge.pause();
    const wait = deferred();
    f.bridge.bindBeforeSelection(async (_generation, _commandId, preserve) => {
      expect(preserve).toBe(true);
      await wait.promise;
    });
    const resume = f.bridge.resume();
    f.setChannels([
      {
        id: 'a',
        sourceId: 'source',
        name: 'A',
        category: '',
        urls: ['https://example.invalid/new'],
      },
    ]);
    wait.resolve();
    await expect(resume).rejects.toThrow('no longer admitted');
    expect(f.player.snapshot.state).toBe('paused');
    f.bridge.bindBeforeSelection(async () => {});
    await f.bridge.dispose();
  });
  it('saves bounded phone audio preferences and notifies local settings observers', async () => {
    const f = fixture();
    const c = context();
    let volume = 0;
    const unsubscribe = f.bridge.host.subscribe((value) => {
      volume = value.volume;
    });
    await f.bridge.host.apply({ kind: 'volume', volume: 0.3 }, c.context);
    expect(volume).toBe(0.3);
    await f.bridge.host.apply({ kind: 'mute', muted: true }, c.context);
    expect(f.bridge.host.snapshot().muted).toBe(true);
    await expect(f.bridge.host.apply({ kind: 'volume', volume: 2 }, c.context)).rejects.toThrow(
      'range',
    );
    f.settings.volume = 0.6;
    f.bridge.notifySettings();
    expect(volume).toBe(0.6);
    unsubscribe();
    await f.bridge.dispose();
  });
});
describe('sharing host extra channels', () => {
  it('admits a Local radio stream outside the catalog without listing it to the phone', async () => {
    let starts = 0;
    const player = new PlaybackController(() => ({
      start: async () => {
        starts++;
      },
      pause: () => {},
      resume: async () => {},
      setMuted: () => {},
      setVolume: () => {},
      dispose: () => {},
    }));
    const radio = {
      id: 'local-radio:r1',
      name: 'Fixture FM',
      urls: ['https://radio.invalid/live'],
    };
    const bridge = createSharingHost({
      player,
      channels: () => [],
      extraChannel: (id) => (id === radio.id ? radio : undefined),
      settings: () => ({ muted: false, volume: 1, removedChannels: [] }),
      saveAudio: async () => {},
    });
    expect(bridge.host.channels()).toEqual([]);
    await expect(
      bridge.select({ id: radio.id, name: radio.name, url: 'https://elsewhere.invalid/' }),
    ).rejects.toThrow('admitted');
    await expect(
      bridge.select({ id: 'local-radio:r2', name: 'Other', url: radio.urls[0] }),
    ).rejects.toThrow('no longer');
    await bridge.select({ id: radio.id, name: radio.name, url: radio.urls[0] });
    expect(starts).toBe(1);
    await bridge.dispose();
  });
});
