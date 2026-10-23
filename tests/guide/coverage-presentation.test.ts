import { describe, expect, it } from 'vitest';
import { describeChannelCoverage } from '../../src/guide/coverage-presentation';
import {
  validateChannelCoverageReply,
  type ChannelCoverageRequest,
} from '../../src/guide/channel-coverage';

const DAY = 86400000;
const query: ChannelCoverageRequest = {
  schemaVersion: 1,
  sourceId: 'g',
  xmltvChannelId: 'x',
  startMs: 0,
  endMs: 7 * DAY,
  expectedSourceRevision: 1,
  expectedPublishedRevision: 1,
};
const assessed = (coveredMs: number, unknownEndCount = 0) =>
  validateChannelCoverageReply(
    {
      schemaVersion: 1,
      startMs: 0,
      endMs: query.endMs,
      status: 'assessed',
      reason: null,
      sourceRevision: 1,
      publishedRevision: 1,
      coveredMs,
      gapCount: coveredMs === query.endMs ? 0 : 1,
      unknownEndCount,
      gaps: coveredMs === query.endMs ? [] : [{ startMs: coveredMs, endMs: query.endMs }],
      gapsComplete: true,
    },
    query,
  );
describe('selected-channel schedule evidence', () => {
  it('one day is explicitly available only until that day, with the remaining gap', () => {
    const text = describeChannelCoverage(assessed(DAY), String, 'the next seven days');
    expect(text).toContain(`Schedule available through ${DAY}.`);
    expect(text).toContain(`First gap: ${DAY} – ${7 * DAY}.`);
    expect(text).not.toContain('No schedule gaps');
    expect(text).not.toContain('programme accuracy');
  });
  it('empty and unknown-end intervals cannot imply seven-day coverage', () => {
    const text = describeChannelCoverage(assessed(0, 1), String, 'the next seven days');
    expect(text).toContain('No listings available');
    expect(text).toContain('1 program end time unknown');
    expect(text).not.toContain('Schedule available through');
  });
  it.each(['source-stale', 'source-missing', 'channel-missing', 'work-limit'] as const)(
    'retains native %s reason without invented interval totals',
    (reason) => {
      const reply = validateChannelCoverageReply(
        {
          schemaVersion: 1,
          startMs: 0,
          endMs: query.endMs,
          status: 'not-assessed',
          reason,
          sourceRevision: reason === 'source-missing' ? null : reason === 'source-stale' ? 2 : 1,
          publishedRevision: reason === 'source-missing' ? null : 1,
          coveredMs: null,
          gapCount: null,
          unknownEndCount: null,
          gaps: [],
          gapsComplete: false,
        },
        query,
      );
      const text = describeChannelCoverage(reply, String);
      expect(text).not.toContain('Schedule available');
      expect(text).not.toContain('No schedule gaps');
      expect(text).toContain(
        reason === 'source-stale'
          ? 'Guide changed'
          : reason === 'source-missing'
            ? 'source is unavailable'
            : reason === 'channel-missing'
              ? 'absent from'
              : "Couldn't check this period",
      );
    },
  );
});
