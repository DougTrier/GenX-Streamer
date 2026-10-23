import { expect, it } from 'vitest';
import {
  createAdaptiveBuffer,
  ADAPTIVE_MAX_SECONDS,
  learnedLiveBuffer,
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
