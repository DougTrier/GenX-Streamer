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
  createDoubleTap,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP,
} from '../../src/ui/double-tap-fullscreen';

describe('double tap on the picture', () => {
  it('two quick taps in one place are a double tap', () => {
    const tap = createDoubleTap();
    expect(tap({ x: 100, y: 100, at: 1000 })).toBe(false);
    expect(tap({ x: 110, y: 105, at: 1000 + DOUBLE_TAP_MS })).toBe(true);
  });

  it('slow taps, distant taps and a third quick tap do not toggle', () => {
    const slow = createDoubleTap();
    slow({ x: 100, y: 100, at: 0 });
    expect(slow({ x: 100, y: 100, at: DOUBLE_TAP_MS + 1 })).toBe(false);

    const far = createDoubleTap();
    far({ x: 100, y: 100, at: 0 });
    expect(far({ x: 100 + DOUBLE_TAP_SLOP + 1, y: 100, at: 100 })).toBe(false);

    // Tap, tap (toggle), tap: the third starts a new pair, so full screen
    // doesn't flip straight back.
    const triple = createDoubleTap();
    triple({ x: 50, y: 50, at: 0 });
    expect(triple({ x: 50, y: 50, at: 100 })).toBe(true);
    expect(triple({ x: 50, y: 50, at: 200 })).toBe(false);
    expect(triple({ x: 50, y: 50, at: 300 })).toBe(true);
  });

  it('a clock that runs backward is not a double tap', () => {
    const tap = createDoubleTap();
    tap({ x: 0, y: 0, at: 500 });
    expect(tap({ x: 0, y: 0, at: 400 })).toBe(false);
  });
});
