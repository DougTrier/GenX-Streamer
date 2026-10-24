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
import { PlaybackController, type EngineEvent } from '../../src/playback/controller';
import {
  createPlaybackHealthCapture,
  type PlaybackHealthHost,
} from '../../src/application/playback/playback-health';
import { prepareDecodedHealth } from '../../src/application/health/prepare-decoded-health';
import { fingerprintHealthTarget, parseHealthPayload } from '../../src/catalog/health-record';

const evidence = {
  kind: 'decoded' as const,
  before: { mediaTime: 1, decodedFrames: 2, width: 320, height: 180 },
  after: { mediaTime: 2, decodedFrames: 4, width: 320, height: 180 },
  elapsedMilliseconds: 100,
};
function fixture() {
  const owners: ((event: EngineEvent) => void)[] = [];
  const player = new PlaybackController((emit) => {
    owners.push(emit);
    return {
      start: async () => {},
      pause() {},
      resume: async () => {},
      setMuted() {},
      setVolume() {},
      dispose() {},
    };
  });
  const channel = {
    id: 'c',
    sourceId: 's',
    name: 'Owned',
    category: 'Fixture',
    urls: ['https://fixture.invalid/first', 'https://fixture.invalid/alternate?signature=exact'],
  };
  const source = {
    id: 's',
    name: 'Owned source',
    kind: 'url' as const,
    location: 'https://fixture.invalid/catalog',
  };
  const writes: {
    health: string;
    expectedCatalogRevision: string;
    expectedHealthRevision: string;
  }[] = [];
  const host: PlaybackHealthHost = {
    player,
    resolve: () => ({ channel, source, catalogRevision: '1' }),
    context: () => ({
      platform: 'windows',
      observerProfile: 'decoder-v1/html-video-quality-presented-v1',
      scope: '0',
    }),
    isContextCurrent: () => true,
    readRecordPair: async () => ({ catalogRevision: '1', healthRevision: '2' }),
    writeHealth: async (input) => {
      writes.push(input);
      return { committed: true, catalogRevision: '1', healthRevision: '3' };
    },
    enqueue: async (work) => work(),
    prepare: prepareDecodedHealth,
    now: () => 1700000000000,
    notice: vi.fn(),
  };
  const observe = () => {
    owners.at(-1)!({ type: 'progress' });
    owners.at(-1)!({ type: 'decoded-progress', evidence });
  };
  const select = () => player.select({ id: channel.id, name: channel.name, url: channel.urls[1] });
  return { player, channel, source, host, writes, observe, select };
}
async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
describe('owned decoded health capture (controlled engine evidence, not hardware proof)', () => {
  it('rebases only confirmed health revision conflicts within three attempts and keeps the original observation time', async () => {
    const f = fixture();
    let revision = 2;
    let attempts = 0;
    let now = 1700000000000;
    f.host.now = () => now;
    f.host.readRecordPair = async () => {
      now += 1000;
      return { catalogRevision: '1', healthRevision: String(revision) };
    };
    f.host.isRevisionConflict = (error) => error === conflict;
    const conflict = new Error('Typed health revision conflict');
    f.host.writeHealth = async (input) => {
      attempts++;
      f.writes.push(input);
      if (attempts < 3) {
        revision++;
        throw conflict;
      }
      return { committed: true, catalogRevision: '1', healthRevision: String(++revision) };
    };
    const capture = createPlaybackHealthCapture(f.host);
    await f.select();
    f.observe();
    await capture.settled();
    expect(f.writes.map((write) => write.expectedHealthRevision)).toEqual(['2', '3', '4']);
    expect(
      f.writes.every(
        (write) => parseHealthPayload(write.health).records[0].observedAt === 1700000000000,
      ),
    ).toBe(true);
    expect(f.host.notice).not.toHaveBeenCalled();
    await capture.dispose();
    await f.player.dispose();
    const g = fixture();
    let tries = 0;
    g.host.isRevisionConflict = () => true;
    g.host.readRecordPair = async () => ({
      catalogRevision: '1',
      healthRevision: String(tries + 2),
    });
    g.host.writeHealth = async () => {
      tries++;
      throw conflict;
    };
    const bounded = createPlaybackHealthCapture(g.host);
    await g.select();
    g.observe();
    await bounded.settled();
    g.observe();
    await bounded.settled();
    expect(tries).toBe(3);
    expect(g.host.notice).toHaveBeenCalledTimes(1);
    await bounded.dispose();
    await g.player.dispose();
  });
  it('never retries a catalog change, unchanged revision, ordinary storage error or missing receipt', async () => {
    for (const mode of ['catalog', 'same', 'storage', 'receipt'] as const) {
      const f = fixture();
      let reads = 0;
      let writes = 0;
      const conflict = new Error('Typed conflict');
      f.host.isRevisionConflict = (error) => error === conflict;
      f.host.readRecordPair = async () => ({
        catalogRevision: ++reads > 1 && mode === 'catalog' ? '2' : '1',
        healthRevision: '2',
      });
      f.host.writeHealth = async () => {
        writes++;
        if (mode === 'receipt') return { committed: false } as never;
        if (mode === 'storage') throw new Error('Storage');
        throw conflict;
      };
      const capture = createPlaybackHealthCapture(f.host);
      await f.select();
      f.observe();
      await capture.settled();
      expect(writes).toBe(1);
      await capture.dispose();
      await f.player.dispose();
    }
  });
  it('fingerprints the exact alternative signed URL and writes only one additive delta per attempt with both revisions', async () => {
    const f = fixture();
    const capture = createPlaybackHealthCapture(f.host);
    await f.select();
    f.observe();
    await capture.settled();
    f.observe();
    await capture.settled();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({
      expectedCatalogRevision: '1',
      expectedHealthRevision: '2',
    });
    const record = parseHealthPayload(f.writes[0].health).records[0];
    expect(record).toMatchObject({
      channelId: 'c',
      sourceId: 's',
      checkedUrlOrdinal: 1,
      verdict: 'PlayedHere',
      origin: 'local',
      evidence,
    });
    expect(record.targetFingerprint).toBe(await fingerprintHealthTarget(f.source, f.channel, 1));
    const changed = structuredClone(f.channel);
    changed.urls[1] += 'changed';
    expect(record.targetFingerprint).not.toBe(await fingerprintHealthTarget(f.source, changed, 1));
    await capture.dispose();
    await f.player.dispose();
  });
  it('suppresses late hash work from a switched attempt and waits for it before handling the next owner', async () => {
    const f = fixture();
    let release!: () => void;
    let preparations = 0;
    f.host.prepare = async (input, signal) => {
      preparations++;
      if (preparations === 1) await new Promise<void>((resolve) => (release = resolve));
      return prepareDecodedHealth(input, signal);
    };
    const capture = createPlaybackHealthCapture(f.host);
    await f.select();
    f.observe();
    await flush();
    await f.select();
    f.observe();
    expect(preparations).toBe(1);
    release();
    await capture.settled();
    expect(preparations).toBe(2);
    expect(f.writes).toHaveLength(1);
    await capture.dispose();
    await f.player.dispose();
  });
  it('rejects changed source grants, URL slots and catalog revisions after preparation', async () => {
    for (const change of ['grant', 'url', 'revision'] as const) {
      const f = fixture();
      const resolve = f.host.resolve;
      f.host.prepare = async (input, signal) => {
        const prepared = await prepareDecodedHealth(input, signal);
        if (change === 'grant') Object.assign(f.source, { allowHttp: true });
        else if (change === 'url') f.channel.urls[1] += 'changed';
        else f.host.resolve = (selection) => ({ ...resolve(selection)!, catalogRevision: '2' });
        return prepared;
      };
      const capture = createPlaybackHealthCapture(f.host);
      await f.select();
      f.observe();
      await capture.settled();
      expect(f.writes).toHaveLength(0);
      await capture.dispose();
      await f.player.dispose();
    }
  });
  it('does not choose an arbitrary ordinal for duplicate URLs or write after unknown context', async () => {
    const f = fixture();
    f.channel.urls[0] = f.channel.urls[1];
    const prepare = vi.fn(prepareDecodedHealth);
    f.host.prepare = prepare;
    const capture = createPlaybackHealthCapture(f.host);
    await f.select();
    f.observe();
    await capture.settled();
    expect(prepare).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(0);
    await capture.dispose();
    await f.player.dispose();
  });
  it('waits for pending write cancellation and accepts a definite durable receipt after pause', async () => {
    const f = fixture();
    let release!: () => void;
    let signal: AbortSignal | undefined;
    f.host.writeHealth = async (input, ownedSignal) => {
      signal = ownedSignal;
      await new Promise<void>((resolve) => (release = resolve));
      f.writes.push(input);
      return { committed: true, catalogRevision: '1', healthRevision: '3' };
    };
    const capture = createPlaybackHealthCapture(f.host);
    await f.select();
    f.observe();
    await vi.waitFor(() => expect(signal).toBeDefined());
    f.player.pause();
    expect(signal!.aborted).toBe(true);
    let disposed = false;
    const disposal = capture.dispose().then(() => (disposed = true));
    await flush();
    expect(disposed).toBe(false);
    release();
    await disposal;
    expect(f.writes).toHaveLength(1);
    expect(f.host.notice).not.toHaveBeenCalled();
    await f.player.dispose();
  });
  it('cancels an uncommitted write and does not retry failed preparation on every frame', async () => {
    const f = fixture();
    f.host.prepare = vi.fn(async () => {
      throw new Error('Safe failure');
    });
    const capture = createPlaybackHealthCapture(f.host);
    await f.select();
    f.observe();
    await capture.settled();
    f.observe();
    await capture.settled();
    expect(f.host.prepare).toHaveBeenCalledTimes(1);
    expect(f.host.notice).toHaveBeenCalledTimes(1);
    expect(f.writes).toHaveLength(0);
    await capture.dispose();
    await f.player.dispose();
    const g = fixture();
    let canceled = false;
    g.host.writeHealth = async (_input, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            canceled = true;
            resolve();
          },
          { once: true },
        ),
      );
      signal.throwIfAborted();
      throw new Error('Unreachable');
    };
    const owner = createPlaybackHealthCapture(g.host);
    await g.select();
    g.observe();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await owner.dispose();
    expect(canceled).toBe(true);
    expect(g.writes).toHaveLength(0);
    expect(g.host.notice).not.toHaveBeenCalled();
    await g.player.dispose();
  });
  it('validates frame evidence and captures preparation inputs before asynchronous hashing', async () => {
    const f = fixture();
    const input = {
      channel: f.channel,
      source: f.source,
      checkedUrlOrdinal: 1,
      evidence: structuredClone(evidence),
      platform: 'windows',
      observerProfile: 'decoder-v1/html-video-quality-presented-v1',
      observedAt: 1700000000000,
    };
    const prepared = prepareDecodedHealth(input);
    input.channel.urls[1] += 'changed';
    input.evidence.after.decodedFrames = 999;
    const result = await prepared;
    expect(result.record.evidence).toEqual(evidence);
    const invalid = structuredClone(input);
    invalid.evidence.after.decodedFrames = invalid.evidence.before.decodedFrames;
    await expect(prepareDecodedHealth(invalid)).rejects.toThrow('Decoded progress');
    const abort = new AbortController();
    abort.abort();
    await expect(prepareDecodedHealth(input, abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
