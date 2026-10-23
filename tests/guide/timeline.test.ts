import { describe, expect, it } from 'vitest';
import type { MappedProgram } from '../../src/guide/native';
import { cellBounds, clusterListings, timelineProgramKey } from '../../src/ui/guide-timeline';
const p = (startMs: number, stopMs: number | null, ordinal = 0): MappedProgram => ({
  catalogSourceId: 's',
  appChannelId: 'c',
  guideSourceId: 'g',
  xmltvChannelId: 'x',
  startMs,
  stopMs,
  ordinal,
  title: 'Listing',
  description: null,
});
describe('timeline absolute windows and semantic identity', () => {
  it('clips known intervals and retains unknown stops as points only', () => {
    expect(cellBounds(0, 7_200_000, 1_800_000)).toEqual({ left: 0, width: 50, unknown: false });
    expect(cellBounds(1_800_000, null, 1_800_000)).toEqual({ left: 0, width: 0, unknown: true });
    expect(cellBounds(0, null, 1_800_000)).toBeNull();
    expect(() => cellBounds(2, 1, 0)).toThrow();
  });
  it('keeps repeated DST times distinct and includes provider category identity', () => {
    const first = Date.parse('2026-11-01T01:00:00-05:00'),
      second = Date.parse('2026-11-01T01:00:00-06:00');
    expect(cellBounds(second, second + 1_800_000, first)?.left).toBeCloseTo(100 / 3);
    expect(
      timelineProgramKey({ ...p(first, second), categories: [{ text: 'Sport', language: 'en' }] }),
    ).not.toBe(
      timelineProgramKey({ ...p(first, second), categories: [{ text: 'News', language: 'en' }] }),
    );
  });
  it('clusters actual overlap and short touch targets without losing an entry or inventing duration', () => {
    const programs = [
      p(0, 900_000),
      p(450_000, 1_800_000, 1),
      p(2_700_000, null, 2),
      p(2_800_000, 2_900_000, 3),
    ];
    const groups = clusterListings(programs, 0, 300);
    expect(groups.map((g) => g.length)).toEqual([2, 2]);
    expect(groups.flat()).toEqual(programs);
    expect(programs[2]?.stopMs).toBeNull();
    expect(
      clusterListings([p(0, 1_800_000), p(1_800_000, 3_600_000, 1)], 0, 1000).map((g) => g.length),
    ).toEqual([1, 1]);
  });
});
