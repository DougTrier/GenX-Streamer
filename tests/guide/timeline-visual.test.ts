import { describe, expect, it } from 'vitest';
import {
  timelineCategoryMatches,
  timelineWindowStart,
  type TimelineChannel,
} from '../../src/ui/guide-timeline';
const channel: TimelineChannel = {
  id: 'c',
  sourceId: 's',
  name: 'Sports News station',
  guideSourceId: null,
  xmltvChannelId: null,
};
describe('guide visual control data boundaries', () => {
  it('filters declared categories without inferring from channel name or mapping', () => {
    expect(timelineCategoryMatches(channel, 'all')).toBe(true);
    expect(timelineCategoryMatches(channel, 'news')).toBe(false);
    expect(timelineCategoryMatches({ ...channel, category: 'US | Sports' }, 'sports')).toBe(true);
    expect(timelineCategoryMatches({ ...channel, category: 'Ｎｅｗｓ' }, 'news')).toBe(true);
  });
  it('keeps date and time movement within the existing seven-day query bound', () => {
    const now = Date.UTC(2026, 9, 11, 12, 10),
      first = Date.UTC(2026, 9, 11, 12);
    expect(timelineWindowStart(first, now, -10800000)).toBeNull();
    expect(timelineWindowStart(first, now, 86400000)).toBe(first + 86400000);
    expect(timelineWindowStart(first + 6 * 86400000, now, 86400000)).toBeNull();
    expect(timelineWindowStart(first, now, 7 * 86400000 - 10800000)).toBe(
      first + 7 * 86400000 - 10800000,
    );
    expect(() => timelineWindowStart(first, now, NaN)).toThrow();
  });
});
