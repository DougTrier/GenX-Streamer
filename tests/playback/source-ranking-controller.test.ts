import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { harness, channel, flush } from './controller.fixture';
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it('uses measured decoded stability before resolution and starts the best admitted endpoint next time', async () => {
  const { controller, owners } = harness();
  const primary = { ...channel('game'), mediaKind: 'hls' as const };
  const alternative = { ...primary, url: 'https://other.invalid/game.m3u8' };
  await controller.select(primary);
  owners[0].emit({ type: 'progress' });
  owners[0].emit({
    type: 'error',
    failure: { code: 'decode', message: 'Failed', retryable: false },
  });
  await flush();
  await controller.select(alternative);
  const good = owners.at(-1)!;
  good.emit({ type: 'progress' });
  for (let i = 0; i < 60; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    good.emit({ type: 'progress' });
    good.emit({
      type: 'decoded-progress',
      evidence: {
        kind: 'decoded',
        elapsedMilliseconds: 1000,
        before: { mediaTime: i, decodedFrames: i * 60, width: 1280, height: 720 },
        after: {
          mediaTime: i + 1,
          decodedFrames: (i + 1) * 60,
          width: 1280,
          height: 720,
          audioObserved: true,
        },
      },
    });
  }
  const count = owners.length;
  expect(controller.rankSources([primary, alternative])[0].url).toBe(alternative.url);
  expect(owners).toHaveLength(count);
  await controller.stop();
  await controller.select(primary, { urls: [primary.url, alternative.url] });
  expect(controller.snapshot.selection?.url).toBe(alternative.url);
  expect(controller.snapshot.selection?.mediaKind).toBeUndefined();
  await controller.dispose();
});
it('a hidden native recovery disqualifies a feed without forcing an unrelated controller restart', async () => {
  const { controller, owners } = harness();
  const selected = channel('game');
  await controller.select(selected);
  owners[0].emit({ type: 'progress' });
  owners[0].emit({ type: 'source-recovery', cause: 'live-window' });
  expect(controller.snapshot.state).toBe('playing');
  expect(owners).toHaveLength(1);
  const unknown = { ...selected, url: 'https://other.invalid/game' };
  expect(controller.rankSources([selected, unknown])[0].url).toBe(unknown.url);
  await controller.dispose();
});
