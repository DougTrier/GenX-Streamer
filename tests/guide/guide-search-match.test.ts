import { expect, it } from 'vitest';
import { guideSearchMatches } from '../../src/ui/guide-timeline';

it('matches every search word at the start of a word, like the native Guide search', () => {
  expect(guideSearchMatches('nfl', 'NFL RedZone')).toBe(true);
  expect(guideSearchMatches('NFL live', 'SportsCenter (NFL) Live')).toBe(true);
  expect(guideSearchMatches('nfl', 'Conflict Zone')).toBe(false);
  expect(guideSearchMatches('nfl red', 'NFL Daily')).toBe(false);
  expect(guideSearchMatches('ｎｆｌ', 'nfl-game re-airs')).toBe(true);
  expect(guideSearchMatches('game', 'nfl-game re-airs')).toBe(true);
});
