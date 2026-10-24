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
import type { ArchiveDiscoverySnapshot } from '../../src/application/genxtra/archive-discovery';
import { archiveDiscoveryStatus } from '../../src/ui/genxtra/archive-discovery-status';

const nowEpochMs = 100_000;
function snapshot(change: Partial<ArchiveDiscoverySnapshot> = {}): ArchiveDiscoverySnapshot {
  return {
    state: 'idle',
    generation: 1,
    query: 'Search',
    decade: null,
    year: null,
    page: null,
    revision: '1',
    examined: 0,
    admitted: 0,
    excludedUnknownYear: 0,
    unavailable: 0,
    transientFailures: 0,
    confirmedDead: 0,
    titleCount: 0,
    yearsChecked: 0,
    yearsTotal: 0,
    yearsComplete: 0,
    yearsPending: 0,
    capacityReached: false,
    retryAfterMs: null,
    message: null,
    pendingFilePages: [],
    ...change,
  };
}
const present = (change: Partial<ArchiveDiscoverySnapshot>, resultCount?: number) =>
  archiveDiscoveryStatus(snapshot(change), { nowEpochMs, resultCount });

describe('compact Archive discovery status', () => {
  it.each(['idle', 'disposed'] as const)('hides %s without claiming activity', (state) => {
    expect(present({ state })).toMatchObject({ hidden: true, text: '', action: null });
  });
  it('uses only completed examined counts during active acquisition', () => {
    expect(present({ state: 'reading' }).text).toBe('Preparing search…');
    expect(present({ state: 'discovering' }).text).toBe('Checking items…');
    expect(present({ state: 'discovering', examined: 40, admitted: 20 }).text).toBe(
      'Checking… 40 items checked.',
    );
  });
  it('does not infer query matches or distinct new titles from admitted/library counts', () => {
    expect(present({ state: 'complete', admitted: 0, titleCount: 0 }).text).toBe(
      'Search finished. Browse the results.',
    );
    expect(present({ state: 'complete', admitted: 20, titleCount: 1400 }, 0).text).toBe(
      'No matching saved videos. Try another search.',
    );
    expect(present({ state: 'complete', admitted: 0, titleCount: 1400 }, 3).text).toBe(
      'Search finished. Browse the results.',
    );
  });
  it('keeps zero-admission partial pages resumable without exhaustive absence claims', () => {
    const value = present({ state: 'partial', examined: 60, admitted: 0 });
    expect(value).toMatchObject({
      text: 'Checked 60 items. Search again to continue.',
      action: 'find-more',
      actionReady: true,
    });
    expect(value.text).not.toMatch(/none|all sources|no matches|gone/);
  });
  it('uses Continue for bounded year curation without promising all sources completed', () => {
    const value = present({
      state: 'partial',
      query: '',
      yearsTotal: 40,
      yearsChecked: 40,
      yearsComplete: 5,
      yearsPending: 35,
    });
    expect(value).toMatchObject({
      text: 'More checks remain. Search again to continue.',
      action: 'continue',
      actionReady: true,
    });
    expect(value.text).not.toContain('complete');
  });
  it('keeps outage inconclusive and never treats unavailable checks as confirmed absence', () => {
    const value = present({
      state: 'partial',
      examined: 20,
      transientFailures: 5,
      unavailable: 5,
      confirmedDead: 0,
    });
    expect(value.text).toBe('Some checks couldn’t finish. Search to try again.');
    expect(value.details).toContain('Confirmed unavailable: 0.');
    expect(value.text).not.toMatch(/removed|dead|gone|no matching/);
  });
  it('keeps confirmed absence counts separate from outage counts', () => {
    const value = present(
      { state: 'complete', confirmedDead: 3, unavailable: 6, transientFailures: 2 },
      0,
    );
    expect(value.details).toContain('Confirmed unavailable: 3.');
    expect(value.details).toContain('Unavailable checks: 6.');
    expect(value.text).toBe('No matching saved videos. Try another search.');
  });
  it('shows cancellation without erasing committed counters or claiming a rollback', () => {
    const source = snapshot({ state: 'canceled', examined: 20, admitted: 4, revision: '9' });
    const copy = structuredClone(source);
    const value = archiveDiscoveryStatus(source, { nowEpochMs });
    expect(value.text).toBe('Search canceled. Search when ready.');
    expect(source).toEqual(copy);
    expect(value.details).toContain('Admitted candidates: 4.');
    expect(value.text).not.toMatch(/discard|rollback/);
  });
  it('uses fixed failure copy without exposing provider/query/message text', () => {
    const value = present({
      state: 'failed',
      query: 'private provider title',
      message: 'https://private.invalid/token',
    });
    expect(value.text).toBe('Search couldn’t finish. Search to try again.');
    expect(JSON.stringify(value)).not.toMatch(/private|https:|token|provider title/);
  });
  it('respects the absolute retry deadline without starting a timer or automatic retry', () => {
    const source = snapshot({ state: 'waiting', retryAfterMs: nowEpochMs + 1501 });
    expect(archiveDiscoveryStatus(source, { nowEpochMs })).toMatchObject({
      text: 'Search paused. Search in 2 seconds.',
      actionReady: false,
      retryDelayMs: 1501,
    });
    expect(archiveDiscoveryStatus(source, { nowEpochMs: nowEpochMs + 1501 })).toMatchObject({
      text: 'Search paused. Search to try again.',
      actionReady: true,
      retryDelayMs: null,
    });
    expect(source.retryAfterMs).toBe(nowEpochMs + 1501);
  });
  it('does not offer futile continuation beyond a capacity checkpoint', () => {
    expect(present({ state: 'capacity', capacityReached: true })).toMatchObject({
      text: 'This search reached its limit. Try another search.',
      action: null,
    });
    expect(
      present({
        state: 'partial',
        query: '',
        capacityReached: true,
        yearsTotal: 10,
        yearsPending: 0,
      }).action,
    ).toBeNull();
  });
  it('retains every counter as optional details with honest labels', () => {
    const value = present({
      state: 'partial',
      examined: 40,
      admitted: 7,
      excludedUnknownYear: 8,
      unavailable: 3,
      transientFailures: 2,
      confirmedDead: 1,
      titleCount: 400,
      yearsChecked: 9,
      yearsTotal: 10,
      yearsComplete: 4,
      yearsPending: 5,
    });
    expect(value.details).toBe(
      'Checked: 40. Admitted candidates: 7. Unknown years skipped: 8. Unavailable checks: 3. Temporary failures: 2. Confirmed unavailable: 1. Library titles: 400. Years checked: 9/10. Years complete: 4. Years pending: 5. Pending video pages: 0. Capacity reached: no.',
    );
    expect(value.text).not.toMatch(/admitted|temporary failures|unknown years|400/);
    expect(Object.isFrozen(value)).toBe(true);
  });
});

it('does not report an empty search when an item still has unchecked file pages', () => {
  const value = present(
    {
      state: 'complete',
      pendingFilePages: [
        {
          titleRef: 'a'.repeat(64),
          title: 'Metadata only',
          kind: 'tv',
          originalYear: null,
          providerFileCount: 200,
          nextOffset: 64,
          availableFileCount: 0,
          complete: false,
          capacityReached: false,
        },
      ],
    },
    0,
  );
  expect(value.text).toBe('More items remain to check.');
  expect(value.text).not.toMatch(/no matching|ready|playable|episodes/);
});
it('rounds a future deadline up and uses a singular second', () => {
  expect(present({ state: 'waiting', retryAfterMs: nowEpochMs + 1 }).text).toBe(
    'Search paused. Search in 1 second.',
  );
});
