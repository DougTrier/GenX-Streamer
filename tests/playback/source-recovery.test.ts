import { it, expect } from 'vitest';
import { createSourceRecoveryWindow } from '../../src/playback/source-recovery';
import type { PlaybackState } from '../../src/playback/controller-model';
function fixture() {
  let at = 0;
  const observe = createSourceRecoveryWindow(() => at);
  return {
    time(ms: number) {
      at = ms;
    },
    state(state: PlaybackState, eligible = true, id = 'one', finite = false) {
      return observe(
        {
          state,
          selection: {
            id,
            name: id,
            url: `https://example.invalid/${id}`,
            ...(finite ? { playMode: 'on-demand' as const } : {}),
          },
          error: null,
        },
        eligible,
      );
    },
  };
}
it('counts genuine mid-play transitions once and triggers on the second stall', () => {
  const f = fixture();
  expect(f.state('connecting')).toBe(false);
  expect(f.state('buffering')).toBe(false);
  f.state('playing');
  f.time(1000);
  expect(f.state('buffering')).toBe(false);
  expect(f.state('buffering')).toBe(false);
  f.state('playing');
  f.time(10000);
  expect(f.state('buffering')).toBe(true);
});
it('does not count pause, replay or on-demand buffering as a live failure', () => {
  const f = fixture();
  f.state('playing');
  f.state('buffering', false);
  f.state('playing', false);
  f.state('buffering', false);
  f.state('playing');
  expect(f.state('buffering')).toBe(false);
  f.state('paused');
  f.state('playing');
  expect(f.state('buffering')).toBe(false);
  f.state('playing', true, 'movie', true);
  expect(f.state('buffering', true, 'movie', true)).toBe(false);
});
it('does not combine different sources or old stalls outside one minute', () => {
  const f = fixture();
  f.state('playing');
  f.state('buffering');
  f.time(61000);
  f.state('playing');
  expect(f.state('buffering')).toBe(false);
  f.state('playing', true, 'two');
  expect(f.state('buffering', true, 'two')).toBe(false);
});
