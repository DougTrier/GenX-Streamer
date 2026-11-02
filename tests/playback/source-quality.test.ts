import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { createSourceQuality, sourcePerformanceKey } from '../../src/playback/source-quality';
function fixture() {
  let at = 0;
  const q = createSourceQuality(() => at);
  return {
    q,
    advance(ms: number) {
      at += ms;
    },
    healthy(key: string, w = 1280, h = 720, audio = true) {
      const s = q.open(key);
      s.progress();
      for (let i = 0; i < 60; i++) {
        at += 1000;
        s.decoded(1000, w, h, 60, audio);
      }
      s.stop();
    },
  };
}
test('stable decoded video beats an unknown feed and a failing higher resolution', () => {
  const f = fixture();
  f.healthy('stable');
  f.healthy('unstable-4k', 3840, 2160);
  f.q.open('unstable-4k').failure();
  assert.deepEqual(f.q.rank(['unstable-4k', 'unknown', 'stable']), [
    'stable',
    'unknown',
    'unstable-4k',
  ]);
});
test('audio observation then measured resolution break stable ties', () => {
  const f = fixture();
  f.healthy('silent-4k', 3840, 2160, false);
  f.healthy('720p');
  f.healthy('1080p', 1920, 1080);
  assert.deepEqual(f.q.rank(['silent-4k', '720p', '1080p']), ['1080p', '720p', 'silent-4k']);
});
test('startup wait and intentional Stop do not count as a source failure', () => {
  const f = fixture(),
    s = f.q.open('one');
  s.buffering();
  f.advance(5000);
  s.progress();
  s.stop();
  s.failure();
  assert.equal(f.q.facts('one')!.stalls, 0);
  assert.equal(f.q.facts('one')!.failures, 0);
  assert.deepEqual(f.q.rank(['unknown', 'one']), ['unknown', 'one']);
});
test('one brief buffering interval is uncertain and does not promote an untested feed', () => {
  const f = fixture(),
    s = f.q.open('one');
  s.progress();
  s.buffering();
  s.buffering();
  f.advance(4000);
  s.progress();
  s.stop();
  assert.equal(f.q.facts('one')!.stalls, 1);
  assert.equal(f.q.facts('one')!.stalledMs, 4000);
  assert.deepEqual(f.q.rank(['one', 'unknown']), ['one', 'unknown']);
});
test('two distinct buffering intervals make an untested equivalent worth trying', () => {
  const f = fixture(),
    s = f.q.open('one');
  s.progress();
  for (let i = 0; i < 2; i++) {
    s.buffering();
    f.advance(2000);
    s.progress();
  }
  s.stop();
  assert.equal(f.q.facts('one')!.stalls, 2);
  assert.deepEqual(f.q.rank(['one', 'unknown']), ['unknown', 'one']);
});
test('evidence expires and a deliberate retest can clear an old failure', () => {
  const f = fixture();
  f.q.open('one').failure();
  f.q.forget('one');
  assert.equal(f.q.facts('one'), null);
  f.healthy('one');
  f.advance(900001);
  assert.equal(f.q.facts('one'), null);
});
test('one large or invalid sample cannot claim a minute of decoded health', () => {
  const f = fixture(),
    s = f.q.open('one');
  s.progress();
  s.decoded(60000, 1920, 1080, 3600, true);
  s.decoded(1000, NaN, 1080, 60, true);
  assert.equal(f.q.facts('one')!.decodedMs, 0);
});
test('a replaced attempt cannot penalize or stop the new owner', () => {
  const f = fixture(),
    old = f.q.open('one'),
    fresh = f.q.open('one');
  old.failure();
  old.stop();
  fresh.progress();
  f.advance(1000);
  fresh.decoded(1000, 1280, 720, 60, true);
  assert.equal(f.q.facts('one')!.failures, 0);
  assert.equal(f.q.facts('one')!.decodedMs, 1000);
});

test('duplicate labels for one endpoint share health but distinct paid formats retain owner identity', () => {
  assert.equal(
    sourcePerformanceKey({ id: 'a', url: 'https://one.invalid/live' }),
    sourcePerformanceKey({ id: 'b', url: 'https://one.invalid/live' }),
  );
  assert.notEqual(
    sourcePerformanceKey({
      id: 'a',
      url: 'http://127.0.0.1/transient',
      performanceKey: 'paid-default',
    }),
    sourcePerformanceKey({
      id: 'a',
      url: 'http://127.0.0.1/transient',
      performanceKey: 'paid-alternate',
    }),
  );
});
