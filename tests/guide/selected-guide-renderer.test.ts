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
import { mountSelectedGuide } from '../../src/ui/guide/selected-guide';
import type { SelectedGuideSummary } from '../../src/guide/native';
class Element {
  children: Element[] = [];
  hidden = false;
  textContent = '';
  className = '';
  title = '';
  removed = false;
  listeners = new Map<string, () => void>();
  addEventListener(name: string, callback: () => void) {
    this.listeners.set(name, callback);
  }
  click() {
    this.listeners.get('click')?.();
  }
  ownerDocument = { createElement: () => new Element() };
  append(...children: Element[]) {
    this.children.push(...children);
  }
  setAttribute() {}
  remove() {
    this.removed = true;
  }
  set innerHTML(_value: string) {
    throw new Error('Markup assignment forbidden');
  }
}
it('renders literal titles and explicit uncertain/missing states, clearing old selected-channel data', () => {
  const container = new Element();
  const renderer = mountSelectedGuide(container as unknown as HTMLElement, {
    formatTime: (ms) => String(ms),
  });
  const region = container.children[0];
  const summary = {
    mappingStatus: 'mapped',
    currentStatus: 'current',
    nextStatus: 'next',
    cacheStatus: 'current',
    updatedMs: 1,
    current: { title: '<img src=x>', startMs: 0, stopMs: 10 },
    next: { title: 'Next title', startMs: 10, stopMs: 20 },
  } as SelectedGuideSummary;
  renderer.render({ status: 'ready', summary });
  expect(region.children[0].textContent).toBe('Now: <img src=x>');
  expect(region.children[1].textContent).toBe('Next: 10 · Next title');
  renderer.render({ status: 'loading', summary: null });
  expect(region.children[1].textContent).toBe('');
  expect(region.title).toBe('');
  renderer.render({
    status: 'ready',
    summary: {
      ...summary,
      current: null,
      currentStatus: 'unknown-end',
      next: null,
      nextStatus: 'overlap',
      cacheStatus: 'stale',
    },
  });
  expect(region.children.map((c) => c.textContent)).toEqual([
    'Current program end is unknown.',
    'Next listings overlap; review Guide.',
    'Saved guide may be out of date.',
  ]);
  renderer.render({ status: 'ready', summary: { ...summary, currentStatus: 'unknown-end' } });
  expect(region.children[0].textContent).toBe('Last listing: <img src=x> · end unknown');
  renderer.render({
    status: 'ready',
    summary: { ...summary, mappingStatus: 'unmapped', mapping: null, current: null, next: null },
  });
  expect(region.children[0].textContent).toContain('No program guide is connected yet');
  expect(region.children[1].textContent).toBe('');
  renderer.render({ status: 'idle', summary: null });
  expect(region.hidden).toBe(true);
  renderer.dispose();
  renderer.render({ status: 'ready', summary });
  expect(region.removed).toBe(true);
});
const splitSummary = {
  mappingStatus: 'mapped',
  currentStatus: 'current',
  nextStatus: 'next',
  cacheStatus: 'current',
  updatedMs: 1,
  current: { title: '<img src=x>', startMs: 100, stopMs: 200 },
  next: { title: 'Next title', startMs: 200, stopMs: 300 },
} as SelectedGuideSummary;
function splitFixture() {
  const container = new Element(),
    statusContainer = new Element();
  let mapped = 0;
  const renderer = mountSelectedGuide(container as unknown as HTMLElement, {
    formatTime: (ms) => String(ms),
    statusContainer: statusContainer as unknown as HTMLElement,
    mapGuide: () => {
      mapped++;
    },
  });
  return { container, statusContainer, renderer, mapped: () => mapped };
}
it('split mode places real titles and exact ranges in details and freshness in the separate status slot', () => {
  const f = splitFixture();
  f.renderer.render({ status: 'ready', summary: splitSummary });
  const details = f.container.children[0]!,
    status = f.statusContainer.children[0]!;
  expect(details.className).toBe('selected-guide selected-guide-details');
  expect(details.children[0]!.className).toBe('selected-guide-current');
  expect(details.children[0]!.children.map((c) => c.textContent)).toEqual([
    'Now',
    '<img src=x>',
    '100–200',
  ]);
  expect(details.children[1]!.children.map((c) => c.textContent)).toEqual([
    'Up Next',
    'Next title',
    '200–300',
  ]);
  expect(status.children[0]!.textContent).toBe('');
  expect(status.children[1]!.textContent).toBe('Guide updated 1.');
  expect(status.children[2]!.hidden).toBe(true);
});
it('split uncertainty clears old details and never presents unknown-end or overlapping listings as confirmed programs', () => {
  const f = splitFixture();
  f.renderer.render({ status: 'ready', summary: splitSummary });
  f.renderer.render({
    status: 'ready',
    summary: {
      ...splitSummary,
      currentStatus: 'unknown-end',
      nextStatus: 'overlap',
      next: null,
      cacheStatus: 'stale',
    },
  });
  const details = f.container.children[0]!,
    status = f.statusContainer.children[0]!;
  expect(details.hidden).toBe(true);
  expect(details.children[0]!.children[1]!.textContent).toBe('');
  expect(status.children[0]!.textContent).toBe(
    'Current program end is unknown. Next listings overlap; review Guide.',
  );
  expect(status.children[1]!.textContent).toBe('Saved guide may be out of date.');
  f.renderer.render({
    status: 'ready',
    summary: {
      ...splitSummary,
      current: null,
      currentStatus: 'gap',
      next: { ...splitSummary.next!, stopMs: null },
    },
  });
  expect(details.children[1]!.children[2]!.textContent).toBe('200 · end unknown');
  expect(status.children[0]!.textContent).toBe('No current listing.');
});
it('split mapping actions preserve exact missing-state semantics and cannot activate after hide or dispose', () => {
  const f = splitFixture(),
    status = f.statusContainer.children[0]!,
    map = status.children[2]!;
  for (const mappingStatus of ['unmapped', 'source-unavailable'] as const) {
    f.renderer.render({
      status: 'ready',
      summary: { ...splitSummary, mappingStatus, current: null, next: null },
    });
    expect(map.hidden).toBe(false);
    map.click();
    expect(f.container.children[0]!.hidden).toBe(true);
  }
  expect(f.mapped()).toBe(2);
  f.renderer.render({
    status: 'ready',
    summary: { ...splitSummary, mappingStatus: 'channel-unavailable', current: null, next: null },
  });
  expect(map.hidden).toBe(true);
  map.click();
  expect(f.mapped()).toBe(2);
  expect(status.children[0]!.textContent).toBe('This channel is no longer in the saved catalog.');
  f.renderer.render({ status: 'loading', summary: null });
  expect(status.children[0]!.textContent).toBe('Checking program guide…');
  f.renderer.render({ status: 'error', summary: null });
  expect(status.children[0]!.textContent).toContain('could not refresh');
  f.renderer.render({ status: 'idle', summary: null });
  expect(status.hidden).toBe(true);
  f.renderer.dispose();
  f.renderer.dispose();
  expect(status.removed).toBe(true);
  expect(f.container.children[0]!.removed).toBe(true);
  f.renderer.render({ status: 'ready', summary: splitSummary });
  map.click();
  expect(f.mapped()).toBe(2);
});
