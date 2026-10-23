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
