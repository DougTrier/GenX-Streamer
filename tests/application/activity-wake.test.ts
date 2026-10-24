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
import { createActivityWakePolicy } from '../../src/application/activity-wake';
it('keeps an active TV scan awake when idle playback releases its reason, then releases on completion', async () => {
  const states: boolean[] = [];
  const policy = createActivityWakePolicy(async (active) => {
    states.push(active);
  });
  await policy.setTelevision(true);
  await policy.setScan(true);
  await policy.setPlayback(false);
  expect(states.at(-1)).toBe(true);
  await policy.setPlayback(true);
  await policy.setScan(false);
  expect(states.at(-1)).toBe(true);
  await policy.setPlayback(false);
  expect(states.at(-1)).toBe(false);
  await policy.close();
  await policy.setScan(true);
  expect(states.at(-1)).toBe(false);
});
it('phone and desktop scans do not hold the display awake', async () => {
  const states: boolean[] = [];
  const policy = createActivityWakePolicy(async (active) => {
    states.push(active);
  });
  await policy.setScan(true);
  await policy.setPlayback(false);
  expect(states).toEqual([false, false]);
});
