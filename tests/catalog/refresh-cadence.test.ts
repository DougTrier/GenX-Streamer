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
  migrateRefreshCadence,
  nextRefreshAt,
  refreshDueIn,
  REFRESH_CADENCES,
} from '../../src/catalog/refresh-cadence';

describe('canonical refresh cadence', () => {
  it('migrates legacy booleans and makes an explicit choice authoritative', () => {
    expect(migrateRefreshCadence(undefined, true)).toBe('daily');
    expect(migrateRefreshCadence(undefined, false)).toBe('off');
    expect(migrateRefreshCadence(undefined, undefined)).toBe('off');
    expect(migrateRefreshCadence('hourly', false)).toBe('hourly');
    expect(migrateRefreshCadence('off', true)).toBe('off');
    expect(() => migrateRefreshCadence('biweekly', true)).toThrow();
    expect(() => migrateRefreshCadence(undefined, 'true')).toThrow();
  });
  it('has exact elapsed intervals and zero initial timestamps are immediately due', () => {
    for (const [cadence, period] of [
      ['hourly', 3_600_000],
      ['every6hours', 21_600_000],
      ['daily', 86_400_000],
      ['weekly', 604_800_000],
      ['every2weeks', 1_209_600_000],
    ] as const) {
      expect(nextRefreshAt(1000, cadence)).toBe(1000 + period);
      expect(refreshDueIn(1000, cadence, 1000 + period - 1)).toBe(1);
      expect(refreshDueIn(1000, cadence, 1000 + period)).toBe(0);
    }
    for (const cadence of REFRESH_CADENCES.filter((value) => value !== 'off'))
      expect(nextRefreshAt(0, cadence)).toBe(0);
    expect(nextRefreshAt(0, 'off')).toBe(Infinity);
  });
  it('clamps UTC month days with leap years, year rollover and retained sub-day precision', () => {
    const t = (year: number, month: number, day: number) =>
      Date.UTC(year, month, day, 23, 59, 58, 123);
    expect(nextRefreshAt(t(2023, 0, 31), 'monthly')).toBe(t(2023, 1, 28));
    expect(nextRefreshAt(t(2024, 0, 31), 'monthly')).toBe(t(2024, 1, 29));
    expect(nextRefreshAt(t(2024, 1, 29), 'monthly')).toBe(t(2024, 2, 29));
    expect(nextRefreshAt(t(2024, 11, 31), 'monthly')).toBe(t(2025, 0, 31));
    expect(nextRefreshAt(t(2024, 2, 31), 'monthly')).toBe(t(2024, 3, 30));
  });
  it('rejects malformed clocks and never guesses a new schedule for invalid preferences', () => {
    for (const last of [-1, NaN, Infinity, 1.5, 8_640_000_000_000_001])
      expect(() => nextRefreshAt(last, 'daily')).toThrow();
    expect(() => refreshDueIn(1000, 'daily', NaN)).toThrow();
  });
});
