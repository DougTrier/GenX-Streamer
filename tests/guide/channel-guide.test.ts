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

import { expect, it } from 'vitest';
import { channelGuideText, type ChannelGuideRow } from '../../src/ui/channel-guide';
import type { SelectedGuideSummary } from '../../src/guide/native';
import { formatLocalGuideTime } from '../../src/guide/time';
const summary = (changes: Partial<SelectedGuideSummary> = {}): SelectedGuideSummary => ({
  requestId: 'r',
  catalogSourceId: 's',
  appChannelId: 'c',
  atMs: 1000,
  catalogRevision: '1',
  databaseRevision: 1,
  mappingStatus: 'mapped',
  mapping: { catalogSourceId: 's', appChannelId: 'c', guideSourceId: 'g', xmltvChannelId: 'x' },
  sourceRevision: 1,
  publishedRevision: 1,
  updatedMs: 900,
  coverage: { startMs: 0, endMs: 3000 },
  cacheStatus: 'current',
  currentStatus: 'current',
  nextStatus: 'next',
  current: { title: '<img src=x> Current', startMs: 0, stopMs: 2000 },
  next: { title: 'Next', startMs: 2000, stopMs: 3000 },
  ...changes,
});
const row = (value: SelectedGuideSummary): ChannelGuideRow => ({
  catalogSourceId: 's',
  appChannelId: 'c',
  status: 'ready',
  summary: value,
});
it('keeps literal titles and explicit cache freshness without playback claims', () => {
  expect(channelGuideText(row(summary()), () => 'Local time')).toEqual({
    current: 'Now: <img src=x> Current',
    next: 'Next: Local time · Next',
  });
  expect(channelGuideText(row(summary({ cacheStatus: 'stale' })), () => 'Time').current).toBe(
    'Cached · Now: <img src=x> Current',
  );
});
it('never presents unknown end or overlap as a confirmed current title', () => {
  expect(
    channelGuideText(row(summary({ currentStatus: 'unknown-end', current: null }))).current,
  ).toBe('Current program end unknown');
  expect(
    channelGuideText(
      row(summary({ currentStatus: 'overlap', current: null, nextStatus: 'overlap', next: null })),
    ),
  ).toEqual({ current: 'Current listings overlap', next: 'Next listings overlap' });
});
it('distinguishes unmapped, missing schedule, unavailable and capacity without fabricated listings', () => {
  expect(channelGuideText(undefined).current).toBe('Guide not loaded');
  expect(channelGuideText({ ...row(summary()), status: 'idle', summary: null }).current).toBe(
    'Guide not loaded',
  );
  expect(channelGuideText(row(summary({ mappingStatus: 'unmapped' }))).current).toBe(
    'No program guide connected yet',
  );
  expect(channelGuideText(row(summary({ cacheStatus: 'unavailable' }))).current).toBe(
    'No cached schedule',
  );
  expect(
    channelGuideText({ ...row(summary()), status: 'unavailable', summary: null }).current,
  ).toBe('Guide unavailable');
  expect(channelGuideText({ ...row(summary()), status: 'capacity', summary: null }).current).toBe(
    'Guide view too large; reduce window height.',
  );
});

it('includes the future date and distinguishes both repeated Chicago DST hours', () => {
  const format = (time: number) =>
    formatLocalGuideTime(time, { timeZone: 'America/Chicago', locale: 'en-US' });
  const first = Date.parse('2026-11-01T06:30:00Z');
  const second = Date.parse('2026-11-01T07:30:00Z');
  const firstText = channelGuideText(
    row(summary({ next: { title: 'First', startMs: first, stopMs: second } })),
    format,
  ).next;
  const secondText = channelGuideText(
    row(summary({ next: { title: 'Second', startMs: second, stopMs: second + 3600000 } })),
    format,
  ).next;
  expect(firstText).toContain('11/01/2026 01:30 GMT-05:00');
  expect(secondText).toContain('11/01/2026 01:30 GMT-06:00');
  expect(format(second + 86400000)).toContain('11/02/2026');
});
