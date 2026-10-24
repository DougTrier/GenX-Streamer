/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from 'vitest';
import {
  timelineCategoryMatches,
  timelineWindowStart,
  type TimelineChannel,
} from '../../src/ui/guide/guide-timeline-model';
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
