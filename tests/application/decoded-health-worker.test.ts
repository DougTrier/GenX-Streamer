import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareDecodedHealthInWorker } from '../../src/application/decoded-health';
import type { PrepareDecodedHealthInput } from '../../src/application/prepare-decoded-health';
class WorkerFixture {
  static current: WorkerFixture;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  data: unknown;
  terminated = 0;
  constructor() {
    WorkerFixture.current = this;
  }
  postMessage(data: unknown) {
    this.data = data;
  }
  terminate() {
    this.terminated++;
  }
}
const input = (): PrepareDecodedHealthInput => ({
  source: { id: 's', name: 'Fixture', kind: 'url', location: 'https://fixture.invalid/catalog' },
  channel: {
    id: 'c',
    sourceId: 's',
    name: 'Fixture',
    category: 'Test',
    urls: ['https://fixture.invalid/media'],
  },
  checkedUrlOrdinal: 0,
  platform: 'windows',
  observerProfile: 'decoder-v1/html-video-quality-presented-v1',
  observedAt: 1700000000000,
  evidence: {
    kind: 'decoded',
    before: { mediaTime: 1, decodedFrames: 1, width: 320, height: 180 },
    after: { mediaTime: 2, decodedFrames: 2, width: 320, height: 180 },
    elapsedMilliseconds: 100,
  },
});
afterEach(() => vi.unstubAllGlobals());
describe('decoded evidence worker ownership', () => {
  it('transfers immutable selected-only metadata and returns its result while releasing worker', async () => {
    vi.stubGlobal('Worker', WorkerFixture);
    const captured = input();
    const pending = prepareDecodedHealthInWorker(captured, new AbortController().signal);
    captured.channel.urls[0] += 'changed';
    expect((WorkerFixture.current.data as PrepareDecodedHealthInput).channel.urls[0]).toBe(
      'https://fixture.invalid/media',
    );
    const result = { health: 'owned payload', record: {} };
    WorkerFixture.current.onmessage?.({ data: { ok: true, result } } as MessageEvent);
    expect(await pending).toEqual(result);
    expect(WorkerFixture.current.terminated).toBe(1);
  });
  it('terminates on cancellation and suppresses late success/failure callbacks', async () => {
    vi.stubGlobal('Worker', WorkerFixture);
    const controller = new AbortController();
    const pending = prepareDecodedHealthInWorker(input(), controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    WorkerFixture.current.onmessage?.({ data: { ok: true, result: {} } } as MessageEvent);
    WorkerFixture.current.onerror?.();
    await rejection;
    expect(WorkerFixture.current.terminated).toBe(1);
  });
  it('releases worker on serialization failure and refuses an already aborted owner', async () => {
    vi.stubGlobal('Worker', WorkerFixture);
    const invalid = { ...input(), extra: () => undefined };
    await expect(
      prepareDecodedHealthInWorker(invalid, new AbortController().signal),
    ).rejects.toThrow('transferred');
    expect(WorkerFixture.current.terminated).toBe(1);
    const controller = new AbortController();
    controller.abort();
    await expect(prepareDecodedHealthInWorker(input(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(WorkerFixture.current.terminated).toBe(1);
  });
});
