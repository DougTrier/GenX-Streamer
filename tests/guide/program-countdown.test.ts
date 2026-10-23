import { describe, expect, it } from 'vitest';
import { programCountdown } from '../../src/guide/program-countdown';

describe('programme schedule countdown', () => {
  it('uses UTC instants across a local daylight-saving transition', () => {
    const start = Date.parse('2026-11-01T01:30:00-06:00');
    const now = Date.parse('2026-11-01T01:30:00-05:00');
    expect(programCountdown(start, start + 3600000, now).text).toBe('Starts in 1h 0m');
  });
  it('crosses start and known end without claiming decoded playback', () => {
    expect(programCountdown(1000, 2000, 999)).toEqual({ kind: 'starts-in', text: 'Starts in 1s' });
    expect(programCountdown(1000, 2000, 1000)).toEqual({
      kind: 'scheduled-now',
      text: 'Scheduled now',
    });
    expect(programCountdown(1000, 2000, 2000)).toEqual({ kind: 'ended', text: 'Ended' });
  });
  it('recomputes from the clock after backward and forward jumps', () => {
    expect(programCountdown(60000, 120000, 59000).text).toBe('Starts in 1s');
    expect(programCountdown(60000, 120000, 0).text).toBe('Starts in 1m');
    expect(programCountdown(60000, 120000, 180000).kind).toBe('ended');
  });
  it('does not invent an end for an open-ended listing', () => {
    expect(programCountdown(1000, null, 100000).text).toBe('Scheduled start passed · End unknown');
  });
  it('refuses absent, malformed and invalid-range schedule times', () => {
    for (const [start, stop, now] of [
      [null, null, 100],
      [NaN, null, 100],
      [100, 100, 100],
      [100, 99, 100],
      [100, null, Infinity],
      [Number.MAX_SAFE_INTEGER, null, 100],
    ])
      expect(programCountdown(start, stop, now!)).toEqual({
        kind: 'unknown',
        text: 'Schedule time unavailable.',
      });
  });
});
