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
import {
  createAdaptiveBuffer,
  ADAPTIVE_MAX_SECONDS,
  learnedLiveBuffer,
  liveBufferIdentity,
} from '../../src/playback/adaptive-buffer';

it('starts at the chosen profile and asks for that much video before resuming', () => {
  expect(createAdaptiveBuffer('fast').target).toBe(1);
  expect(createAdaptiveBuffer('smooth').target).toBe(6);
  const balanced = createAdaptiveBuffer('balanced');
  expect(balanced.target).toBe(3);
  expect(balanced.ready(2.9)).toBe(false);
  expect(balanced.ready(3)).toBe(true);
});

it('each stall raises the goal, up to a bounded maximum', () => {
  const buffer = createAdaptiveBuffer('balanced');
  const goals = [1, 2, 3, 4, 5, 6].map(() => buffer.stalled());
  expect(goals).toEqual([5, 8, 12.8, 20, 20, 20]);
  expect(ADAPTIVE_MAX_SECONDS).toBe(20);
});

it('once it plays smoothly it stays there: the goal never steps back down', () => {
  const buffer = createAdaptiveBuffer('balanced');
  buffer.stalled();
  buffer.stalled();
  expect(buffer.target).toBe(8);
  // Nothing but a stall changes the goal, however long it plays.
  for (let i = 0; i < 1000; i++) expect(buffer.ready(8)).toBe(true);
  expect(buffer.target).toBe(8);
  expect(Object.keys(buffer)).not.toContain('steady');
});

it('a hold never outlasts its own cap, so the player is never left waiting', () => {
  const buffer = createAdaptiveBuffer('smooth');
  expect(buffer.holdLimitMs).toBeLessThan(20_000); // inside the player's buffering deadline
  expect(buffer.holdLimitMs).toBeGreaterThan(0);
});

it('a reconnect keeps the level the channel reached, never below the profile', () => {
  expect(createAdaptiveBuffer('balanced', 8).target).toBe(8);
  expect(createAdaptiveBuffer('smooth', 2).target).toBe(6);
  expect(createAdaptiveBuffer('fast', 99).target).toBe(ADAPTIVE_MAX_SECONDS);
  learnedLiveBuffer.set('game', 12.8);
  expect(learnedLiveBuffer.get('game')).toBe(12.8);
  expect(learnedLiveBuffer.get('other')).toBe(0);
  for (let i = 0; i < 100; i++) learnedLiveBuffer.set(`channel-${i}`, 5);
  expect(learnedLiveBuffer.get('game')).toBe(0); // bounded: oldest forgotten
  expect(learnedLiveBuffer.get('channel-99')).toBe(5);
});

it('learns each source independently while retaining the same source across reconnects', () => {
  const a = { id: 'same-programme', url: 'https://one.invalid/live' },
    b = { ...a, url: 'https://two.invalid/live' };
  learnedLiveBuffer.set(liveBufferIdentity(a), 12.8);
  expect(learnedLiveBuffer.get(liveBufferIdentity({ ...a }))).toBe(12.8);
  expect(learnedLiveBuffer.get(liveBufferIdentity(b))).toBe(0);
  expect(learnedLiveBuffer.get(liveBufferIdentity({ ...a, id: 'different-channel' }))).toBe(0);
});

it('a manual target stays exact through stalls and Auto restores profile plus learned level', () => {
  const buffer = createAdaptiveBuffer('smooth', 8, { mode: 'manual', targetSeconds: 2 });
  expect(buffer.target).toBe(2);
  expect(buffer.stalled()).toBe(2);
  expect(buffer.ready(1.9)).toBe(false);
  expect(buffer.ready(2)).toBe(true);
  buffer.setPreference({ mode: 'manual', targetSeconds: 19 });
  expect(buffer.stalled()).toBe(19);
  buffer.setPreference({ mode: 'auto' });
  expect(buffer.target).toBe(8);
  expect(buffer.stalled()).toBe(12.8);
  expect(buffer.setPreference({ mode: 'manual', targetSeconds: 99 })).toBe(false);
  expect(buffer.target).toBe(12.8);
});

it('reclassifies only the most recent provisional starvation raise as a transport transition', () => {
  const buffer = createAdaptiveBuffer('balanced');
  const first = buffer.beginStall();
  expect(first.target).toBe(5);
  expect(first.reclassifyAsTransition()).toBe(true);
  expect(buffer.target).toBe(3);
  expect(first.reclassifyAsTransition()).toBe(false);
  const earlier = buffer.beginStall();
  const later = buffer.beginStall();
  expect(earlier.reclassifyAsTransition()).toBe(false);
  expect(buffer.target).toBe(8);
  expect(later.reclassifyAsTransition()).toBe(true);
  expect(buffer.target).toBe(5);
});
it('never rolls back a manual target or a newer explicit manual/Auto choice', () => {
  const manual = createAdaptiveBuffer('smooth', 8, { mode: 'manual', targetSeconds: 2 });
  expect(manual.beginStall().reclassifyAsTransition()).toBe(false);
  expect(manual.target).toBe(2);
  const buffer = createAdaptiveBuffer('balanced');
  const prior = buffer.beginStall();
  buffer.setPreference({ mode: 'manual', targetSeconds: 12 });
  buffer.setPreference({ mode: 'auto' });
  expect(prior.reclassifyAsTransition()).toBe(false);
  expect(buffer.target).toBe(5);
});
