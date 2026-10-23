import { describe, expect, it } from 'vitest';
import { queryGuide, type GuideProgram, type GuideQuery } from '../../src/guide/query';
const program = (
  startMs: number,
  stopMs: number | null,
  title = 'Fixture',
  patch: Partial<GuideProgram> = {},
): GuideProgram => ({
  guideSourceId: 'guide',
  channelId: 'channel',
  startMs,
  stopMs,
  title,
  ...patch,
});
const query = (nowMs: number, patch: Partial<GuideQuery> = {}): GuideQuery => ({
  guideSourceId: 'guide',
  channelId: 'channel',
  nowMs,
  windowStartMs: 0,
  windowEndMs: 1000,
  ...patch,
});
describe('source scoped deterministic guide queries', () => {
  it('uses half-open start/end boundaries with injected clocks', () => {
    const rows = [program(100, 200, 'A'), program(200, 300, 'B')];
    expect(queryGuide(rows, query(99))).toMatchObject({
      current: null,
      currentStatus: 'gap',
      next: { title: 'A' },
    });
    expect(queryGuide(rows, query(100)).current?.title).toBe('A');
    expect(queryGuide(rows, query(199)).current?.title).toBe('A');
    expect(queryGuide(rows, query(200)).current?.title).toBe('B');
    expect(queryGuide(rows, query(300)).currentStatus).toBe('gap');
  });
  it('deduplicates exact metadata only and orders independently of input order without mutation', () => {
    const rows = [
      program(300, 400, 'C'),
      program(100, 200, 'A'),
      program(100, 200, 'A'),
      program(200, 300, 'B'),
    ];
    const copy = structuredClone(rows);
    const result = queryGuide(rows, query(50));
    expect(result.upcoming.map((p) => p.title)).toEqual(['A', 'B', 'C']);
    expect(queryGuide([...rows].reverse(), query(50))).toEqual(result);
    expect(rows).toEqual(copy);
    result.upcoming[0].title = 'changed';
    expect(rows[1].title).toBe('A');
  });
  it('never merges source/channel identities by a shared title or channel ID', () => {
    const rows = [
      program(100, 200, 'Same'),
      program(100, 200, 'Other guide', { guideSourceId: 'other' }),
      program(100, 200, 'Other channel', { channelId: 'other' }),
    ];
    expect(queryGuide(rows, query(150)).current?.title).toBe('Same');
    expect(queryGuide(rows, query(150, { guideSourceId: 'missing' }))).toMatchObject({
      currentStatus: 'empty',
      nextStatus: 'none',
    });
  });
  it('preserves gaps and unknown end times without extending the last program forever', () => {
    const rows = [program(100, null, 'Unknown'), program(300, 400, 'Later')];
    expect(queryGuide(rows, query(200))).toMatchObject({
      current: null,
      currentStatus: 'unknown-end',
      next: { title: 'Later' },
    });
    expect(queryGuide(rows, query(350)).current?.title).toBe('Later');
    expect(queryGuide(rows, query(500))).toMatchObject({ current: null, currentStatus: 'gap' });
    expect(queryGuide([program(100, null)], query(900))).toMatchObject({
      current: null,
      currentStatus: 'unknown-end',
    });
  });
  it('exposes current overlaps and uncertain latest stop conflicts instead of choosing arbitrarily', () => {
    const result = queryGuide([program(100, 400, 'A'), program(200, 300, 'B')], query(250));
    expect(result.currentStatus).toBe('overlap');
    expect(result.current).toBeNull();
    expect(result.conflicts.map((p) => p.title)).toEqual(['A', 'B']);
    const uncertain = queryGuide(
      [program(100, 400, 'A'), program(200, null, 'Unknown')],
      query(250),
    );
    expect(uncertain.currentStatus).toBe('overlap');
    expect(uncertain.current).toBeNull();
  });
  it('exposes simultaneous next listings with different metadata and future interval conflicts', () => {
    const result = queryGuide(
      [
        program(200, 300, 'A'),
        program(200, 300, 'A', { description: 'different' }),
        program(250, 400, 'B'),
      ],
      query(100),
    );
    expect(result.nextStatus).toBe('overlap');
    expect(result.next).toBeNull();
    expect(result.upcoming).toHaveLength(3);
    expect(result.conflicts).toHaveLength(3);
  });
  it('filters the requested upcoming time window without losing current truth', () => {
    const result = queryGuide(
      [
        program(100, 200, 'Current'),
        program(200, 300, 'Outside'),
        program(300, 400, 'Visible'),
        program(400, null, 'Boundary'),
      ],
      query(150, { windowStartMs: 300, windowEndMs: 400 }),
    );
    expect(result.current?.title).toBe('Current');
    expect(result.next?.title).toBe('Outside');
    expect(result.upcoming.map((p) => p.title)).toEqual(['Visible']);
    expect(result.unknownEnds).toEqual([]);
  });
  it('refuses invalid program input in full instead of silently treating it as a schedule gap', () => {
    for (const bad of [
      program(NaN, 300),
      program(100, 99),
      program(100, Infinity),
      program(100, 200, ''),
      program(100, 200, 'Title', { guideSourceId: '' }),
    ])
      expect(() => queryGuide([program(100, 200), bad], query(150))).toThrow('program');
    expect(() =>
      queryGuide([program(100, 99, 'Other', { guideSourceId: 'other' })], query(150)),
    ).toThrow('program');
    expect(() => queryGuide([], query(NaN))).toThrow('scope');
    expect(() => queryGuide([], query(100, { windowEndMs: 0 }))).toThrow('window');
  });
});
