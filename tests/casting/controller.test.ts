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

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CastingController,
  MAX_CASTS,
  type CastAdapter,
  type CastDevice,
  type CastEngine,
  type CastEvent,
} from '../../src/casting';
const device = { id: 'device', name: 'Living room', protocol: 'chromecast' as const };
const bedroom = { id: 'bedroom', name: 'Bedroom', protocol: 'chromecast' as const };
const selection = { id: 'channel', name: 'News', url: 'https://example.org/live' };
const sports = { id: 'sports', name: 'Sports', url: 'https://example.org/sports' };
interface Owned {
  id: string;
  device: CastDevice;
  emit: (event: CastEvent) => void;
  engine: CastEngine;
}
function fixture() {
  const sessions: Owned[] = [];
  let ids = 0;
  const adapter: CastAdapter = {
    discover: vi.fn(async () => [device]),
    create: (castDevice, id, emit) => {
      const engine: CastEngine = {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => ({ confirmed: true })),
        dispose: vi.fn(async () => undefined),
      };
      sessions.push({ id, device: castDevice, emit, engine });
      return engine;
    },
  };
  return {
    adapter,
    sessions,
    controller: new CastingController(adapter, () => `session-${++ids}`),
  };
}
const playing = (owned: Owned, selectionId: string) =>
  owned.emit({
    sessionId: owned.id,
    selectionId,
    state: 'playing',
    remoteSessionId: `remote-${owned.id}`,
  });
const casts = (controller: CastingController) =>
  controller.snapshot.casts.map((cast) => [cast.device.name, cast.selection.name, cast.state]);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('casting ownership and authoritative receiver state', () => {
  it('does not discover or cast until explicitly requested', async () => {
    const f = fixture();
    expect(f.adapter.discover).not.toHaveBeenCalled();
    expect(f.sessions).toHaveLength(0);
    expect(await f.controller.listDevices()).toEqual([device]);
    expect(f.adapter.discover).toHaveBeenCalledOnce();
    await f.controller.dispose();
  });
  it('LOAD completion does not imply playing; matched receiver status does', async () => {
    const f = fixture();
    await f.controller.start(device, selection);
    expect(casts(f.controller)).toEqual([['Living room', 'News', 'connecting']]);
    const session = f.sessions[0]!;
    session.emit({
      sessionId: session.id,
      selectionId: 'wrong',
      state: 'playing',
      remoteSessionId: 'remote',
    });
    session.emit({ sessionId: session.id, selectionId: selection.id, state: 'playing' });
    expect(casts(f.controller)).toEqual([['Living room', 'News', 'connecting']]);
    playing(session, selection.id);
    expect(casts(f.controller)).toEqual([['Living room', 'News', 'playing']]);
    await f.controller.dispose();
  });
  it('ignores stale callbacks after replacing a TV cast', async () => {
    const f = fixture();
    await f.controller.start(device, selection);
    await f.controller.start(device, { ...selection, id: 'second' });
    expect(f.sessions[0]!.engine.stop).toHaveBeenCalledOnce();
    expect(f.sessions[0]!.engine.dispose).toHaveBeenCalledOnce();
    playing(f.sessions[0]!, selection.id);
    f.sessions[0]!.emit({
      sessionId: f.sessions[0]!.id,
      selectionId: selection.id,
      state: 'ended',
    });
    expect(f.controller.snapshot.casts).toHaveLength(1);
    expect(f.controller.snapshot.casts[0]).toMatchObject({
      selection: { id: 'second' },
      state: 'connecting',
    });
    await f.controller.dispose();
  });
  // Owner request, October 24, 2026: several TVs at once, each its own channel.
  it('casts to several TVs at once, each its own channel, with events bound to each', async () => {
    const f = fixture();
    await f.controller.start(device, selection);
    await f.controller.start(bedroom, sports);
    expect(f.sessions).toHaveLength(2);
    for (const owned of f.sessions) expect(owned.engine.stop).not.toHaveBeenCalled();
    // The living room's status never moves the bedroom, nor the other way round.
    playing(f.sessions[0]!, selection.id);
    f.sessions[1]!.emit({ sessionId: f.sessions[0]!.id, selectionId: sports.id, state: 'paused' });
    f.sessions[0]!.emit({ sessionId: f.sessions[0]!.id, selectionId: sports.id, state: 'paused' });
    expect(casts(f.controller)).toEqual([
      ['Living room', 'News', 'playing'],
      ['Bedroom', 'Sports', 'connecting'],
    ]);
    playing(f.sessions[1]!, sports.id);
    expect(casts(f.controller)).toEqual([
      ['Living room', 'News', 'playing'],
      ['Bedroom', 'Sports', 'playing'],
    ]);
    await f.controller.dispose();
  });
  it('choosing a TV that is already casting replaces only that TV', async () => {
    const f = fixture();
    await f.controller.start(device, selection);
    await f.controller.start(bedroom, sports);
    playing(f.sessions[1]!, sports.id);
    await f.controller.start(device, sports);
    expect(f.sessions[0]!.engine.stop).toHaveBeenCalledOnce();
    expect(f.sessions[1]!.engine.stop).not.toHaveBeenCalled();
    expect(casts(f.controller)).toEqual([
      ['Bedroom', 'Sports', 'playing'],
      ['Living room', 'Sports', 'connecting'],
    ]);
    await f.controller.dispose();
  });
  it('knows a rediscovered TV by its own identity, whatever roster id it has now', async () => {
    const f = fixture();
    const first = { ...device, protocolReceiverId: 'tv-identity' };
    await f.controller.start(first, selection);
    await f.controller.start({ ...first, id: 'rediscovered' }, sports);
    expect(f.sessions[0]!.engine.stop).toHaveBeenCalledOnce();
    expect(f.controller.snapshot.casts).toHaveLength(1);
    await f.controller.stop({ ...first, id: 'third-discovery' });
    expect(f.sessions[1]!.engine.stop).toHaveBeenCalledOnce();
    expect(f.controller.snapshot.casts).toHaveLength(0);
    await f.controller.dispose();
  });
  it(`casts to ${MAX_CASTS} TVs at most and says so`, async () => {
    const f = fixture();
    for (let index = 0; index < MAX_CASTS; index++)
      await f.controller.start({ ...device, id: `tv-${index}`, name: `TV ${index}` }, selection);
    await f.controller.start({ ...device, id: 'one-more', name: 'Kitchen' }, selection);
    expect(f.sessions).toHaveLength(MAX_CASTS);
    expect(f.controller.snapshot.message).toContain('Stop one to cast to Kitchen');
    await f.controller.dispose();
  });
  it('stopping one TV leaves the others playing', async () => {
    const f = fixture();
    await f.controller.start(device, selection);
    await f.controller.start(bedroom, sports);
    playing(f.sessions[0]!, selection.id);
    playing(f.sessions[1]!, sports.id);
    await f.controller.stop(device);
    expect(f.sessions[0]!.engine.stop).toHaveBeenCalledOnce();
    expect(f.sessions[0]!.engine.dispose).toHaveBeenCalledOnce();
    expect(f.sessions[1]!.engine.stop).not.toHaveBeenCalled();
    expect(casts(f.controller)).toEqual([['Bedroom', 'Sports', 'playing']]);
    expect(f.controller.snapshot.message).toBeNull();
    await f.controller.dispose();
    expect(f.sessions[1]!.engine.stop).toHaveBeenCalledOnce();
  });
  it('Stop all asks every TV together: two silent TVs take five seconds, not ten', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start(device, selection);
    await f.controller.start(bedroom, sports);
    for (const owned of f.sessions)
      vi.mocked(owned.engine.stop).mockReturnValue(new Promise(() => undefined));
    let finished = false;
    const stopping = f.controller.stopAll().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    expect(finished).toBe(true);
    expect(f.controller.snapshot.casts).toEqual([]);
    expect(f.controller.snapshot.message).toContain('did not answer');
    await f.controller.dispose();
  });
  // Owner requirement, October 24, 2026: someone backing out on the TV, a TV
  // turned off or gone, or another phone taking over, releases that TV alone.
  for (const [reason, message] of [
    ['receiver', 'Living room stopped casting.'],
    ['unreachable', 'Living room stopped answering, so its cast ended.'],
  ] as const) {
    it(`a TV that ended the cast (${reason}) is released alone and the app keeps working`, async () => {
      const f = fixture();
      await f.controller.start(device, selection);
      await f.controller.start(bedroom, sports);
      playing(f.sessions[0]!, selection.id);
      playing(f.sessions[1]!, sports.id);
      f.sessions[0]!.emit({
        sessionId: f.sessions[0]!.id,
        selectionId: selection.id,
        state: 'ended',
        reason,
      });
      await vi.waitFor(() => expect(f.controller.snapshot.casts).toHaveLength(1));
      expect(f.sessions[0]!.engine.stop).toHaveBeenCalledOnce();
      expect(f.sessions[0]!.engine.dispose).toHaveBeenCalledOnce();
      expect(f.sessions[1]!.engine.stop).not.toHaveBeenCalled();
      expect(casts(f.controller)).toEqual([['Bedroom', 'Sports', 'playing']]);
      await vi.waitFor(() => expect(f.controller.snapshot.message).toBe(message));
      // A late status from the released session changes nothing.
      playing(f.sessions[0]!, selection.id);
      expect(f.controller.snapshot.casts).toHaveLength(1);
      // Casting to that TV again works at once.
      await f.controller.start(device, selection);
      expect(casts(f.controller)).toEqual([
        ['Bedroom', 'Sports', 'playing'],
        ['Living room', 'News', 'connecting'],
      ]);
      await f.controller.dispose();
    });
  }
  it('a TV that ended the cast and then refuses Stop is still let go', async () => {
    const f = fixture();
    await f.controller.start(device, selection);
    vi.mocked(f.sessions[0]!.engine.stop).mockRejectedValue(new Error('socket closed'));
    f.sessions[0]!.emit({
      sessionId: f.sessions[0]!.id,
      selectionId: selection.id,
      state: 'ended',
      reason: 'unreachable',
    });
    await vi.waitFor(() => expect(f.controller.snapshot.casts).toEqual([]));
    expect(f.sessions[0]!.engine.dispose).toHaveBeenCalledOnce();
    await f.controller.dispose();
  });
  it('casting to another TV never waits for one that does not answer its Stop', async () => {
    const f = fixture();
    await f.controller.start(device, selection);
    let answer!: (value: { confirmed: boolean }) => void;
    vi.mocked(f.sessions[0]!.engine.stop).mockReturnValue(
      new Promise((resolve) => (answer = resolve)),
    );
    const stopping = f.controller.stop(device);
    await f.controller.start(bedroom, selection);
    expect(f.sessions).toHaveLength(2);
    expect(casts(f.controller)).toEqual([
      ['Living room', 'News', 'stopping'],
      ['Bedroom', 'News', 'connecting'],
    ]);
    answer({ confirmed: false });
    await stopping;
    expect(casts(f.controller)).toEqual([['Bedroom', 'News', 'connecting']]);
    await f.controller.dispose();
  });
  it('a stop the TV never answers still ends that cast, within five seconds', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start(device, selection);
    vi.mocked(f.sessions[0]!.engine.stop).mockReturnValue(new Promise(() => undefined));
    const stopping = f.controller.stop(device);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    expect(f.sessions[0]!.engine.dispose).toHaveBeenCalledOnce();
    expect(f.controller.snapshot.casts).toEqual([]);
    expect(f.controller.snapshot.message).toContain('Living room did not answer');
    await f.controller.start(device, selection);
    expect(f.sessions).toHaveLength(2);
    expect(casts(f.controller)).toEqual([['Living room', 'News', 'connecting']]);
    await f.controller.dispose();
  });
  it('times out stalled LOAD and rejects its late status without leaking URL diagnostics', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.adapter.create = (castDevice, id, emit) => {
      const engine: CastEngine = {
        start: () => new Promise(() => undefined),
        stop: async () => ({ confirmed: true }),
        dispose: async () => undefined,
      };
      f.sessions.push({ id, device: castDevice, emit, engine });
      return engine;
    };
    const pending = f.controller.start(device, {
      ...selection,
      url: 'https://example.org/private?secret=token',
    });
    await vi.advanceTimersByTimeAsync(44_000);
    expect(casts(f.controller)).toEqual([['Living room', 'News', 'connecting']]);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(f.controller.snapshot.casts).toEqual([]);
    expect(f.controller.snapshot.message).toContain('45 seconds');
    expect(f.controller.snapshot.message).not.toContain('secret');
    playing(f.sessions[0]!, selection.id);
    expect(f.controller.snapshot.casts).toEqual([]);
    await f.controller.dispose();
  });
  it('rejects untrusted duplicate discovered device identities', async () => {
    const f = fixture();
    vi.mocked(f.adapter.discover).mockResolvedValue([device, device]);
    await expect(f.controller.listDevices()).rejects.toThrow('invalid devices');
    await f.controller.dispose();
  });
  it('idempotent concurrent disposal stops every TV and prevents new starts', async () => {
    const f = fixture();
    await f.controller.start(device, selection);
    await f.controller.start(bedroom, sports);
    const disposal = f.controller.dispose();
    await expect(f.controller.start(device, selection)).rejects.toThrow('closed');
    await Promise.all([disposal, f.controller.dispose()]);
    for (const owned of f.sessions) expect(owned.engine.dispose).toHaveBeenCalledOnce();
    expect(f.controller.snapshot).toMatchObject({ casts: [], disposed: true });
  });
  it('subscriber copies cannot mutate owned state', async () => {
    const f = fixture();
    const unsubscribe = f.controller.subscribe((snapshot) => {
      for (const cast of snapshot.casts) {
        cast.device.name = 'changed';
        cast.selection.name = 'changed';
      }
    });
    await f.controller.start(device, selection);
    expect(casts(f.controller)).toEqual([['Living room', 'News', 'connecting']]);
    unsubscribe();
    await f.controller.dispose();
  });
});
