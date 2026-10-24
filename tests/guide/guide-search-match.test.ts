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
import { guideSearchMatches } from '../../src/ui/guide-timeline-model';

it('matches every search word at the start of a word, like the native Guide search', () => {
  expect(guideSearchMatches('nfl', 'NFL RedZone')).toBe(true);
  expect(guideSearchMatches('NFL live', 'SportsCenter (NFL) Live')).toBe(true);
  expect(guideSearchMatches('nfl', 'Conflict Zone')).toBe(false);
  expect(guideSearchMatches('nfl red', 'NFL Daily')).toBe(false);
  expect(guideSearchMatches('ｎｆｌ', 'nfl-game re-airs')).toBe(true);
  expect(guideSearchMatches('game', 'nfl-game re-airs')).toBe(true);
});
