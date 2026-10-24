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
import { createScanPace, timeLeftText } from '../../src/ui/scan-pace';

describe('scan pace', () => {
  it('needs 30 seconds of progress, then gives checks a minute and time left', () => {
    let t = 0;
    const pace = createScanPace(() => t);
    expect(pace.sample('a', 0, 1000)).toEqual({ perMinute: null, leftMs: null });
    t = 20_000;
    expect(pace.sample('a', 40, 1000).perMinute).toBeNull();
    t = 60_000;
    expect(pace.sample('a', 120, 1000)).toEqual({ perMinute: 120, leftMs: 440_000 });
  });
  it('slows down when nothing is checked for a while', () => {
    let t = 0;
    const pace = createScanPace(() => t);
    pace.sample('a', 0, 1000);
    t = 60_000;
    pace.sample('a', 120, 1000);
    t = 120_000;
    expect(pace.sample('a', 120, 1000).perMinute).toBe(60);
  });
  it('a new run starts over and only the last two minutes count', () => {
    let t = 0;
    const pace = createScanPace(() => t);
    pace.sample('a', 0, 1000);
    t = 60_000;
    pace.sample('a', 600, 1000);
    t = 61_000;
    expect(pace.sample('b', 5, 50).perMinute).toBeNull();
    let u = 0;
    const window = createScanPace(() => u, 120_000);
    window.sample('x', 0, 10_000);
    u = 60_000;
    window.sample('x', 600, 10_000);
    u = 180_000;
    window.sample('x', 660, 10_000);
    u = 240_000;
    // Measured from the last count known at or before two minutes ago (600 at
    // 60 s), not from the start: 120 checks in 3 minutes.
    expect(window.sample('x', 720, 10_000).perMinute).toBe(40);
  });
  it('reads the time left plainly', () => {
    expect(timeLeftText(20_000)).toBe('under a minute left');
    expect(timeLeftText(12 * 60_000)).toBe('about 12 min left');
    expect(timeLeftText(150 * 60_000)).toBe('about 2 h 30 min left');
    expect(timeLeftText(120 * 60_000)).toBe('about 2 h left');
  });
});
