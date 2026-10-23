import { expect, it } from 'vitest';
import { BUDGETS, growthPerHour, judge } from '../../scripts/tv-endurance.mjs';

const sample = (minute: number, mib: number, playing = false) => ({
  elapsedMs: minute * 60_000,
  totalPssMiB: mib,
  playing,
});

it('measures memory growth per hour as a least-squares slope', () => {
  expect(
    growthPerHour([
      [0, 100],
      [1_800_000, 110],
      [3_600_000, 120],
    ]),
  ).toBeCloseTo(20);
  expect(
    growthPerHour([
      [0, 100],
      [60_000, 100],
    ]),
  ).toBeNull();
});

it('passes steady memory within budget and fails growth, peaks and failed starts', () => {
  const steady = Array.from({ length: 10 }, (_, i) => sample(i * 5, 220 + (i % 2), i % 3 === 0));
  const steps = [
    { kind: 'browse', frames: { count: 100, long: 3 } },
    { kind: 'play', ok: true },
  ];
  expect(judge(steady, steps).verdict).toBe('PASS');

  const leaking = Array.from({ length: 10 }, (_, i) => sample(i * 6, 200 + i * 5));
  const leak = judge(leaking, steps);
  expect(leak.verdict).toBe('FAIL');
  expect(leak.checks.find((c) => c.name.startsWith('memory growth'))?.ok).toBe(false);

  const heavy = steady.map((s) => ({
    ...s,
    totalPssMiB: s.playing ? BUDGETS.playbackPssMiB + 1 : s.totalPssMiB,
  }));
  expect(judge(heavy, steps).checks.find((c) => c.name.startsWith('peak playback'))?.ok).toBe(
    false,
  );

  expect(judge(steady, [...steps, { kind: 'play', ok: false }]).verdict).toBe('FAIL');
  expect(judge(steady, [{ kind: 'browse', frames: { count: 100, long: 30 } }]).verdict).toBe(
    'FAIL',
  );
});

it('reports missing measurements as incomplete, never as a pass', () => {
  const gaps = Array.from({ length: 10 }, (_, i) => ({
    ...sample(i, 200),
    totalPssMiB: i < 5 ? null : 200,
  }));
  expect(judge(gaps, []).verdict).toBe('INCOMPLETE');
  expect(judge([], []).verdict).toBe('INCOMPLETE');
});
