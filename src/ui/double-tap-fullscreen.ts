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

/**
 * Touch screens: a double tap on the playing picture enters full screen, and
 * another double tap returns to the normal view (owner request, October 19,
 * 2026: "that would stop the need to find a button if they are distracted").
 * Single taps are never delayed or swallowed, so everything a tap already does
 * keeps working; only fingers count (a mouse keeps its own controls).
 */

/** Two taps this close in time (ms) and space (CSS px) are a double tap. */
export const DOUBLE_TAP_MS = 320;
export const DOUBLE_TAP_SLOP = 40;

export interface Tap {
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

/** Recognizes double taps; a third quick tap starts a new pair rather than toggling twice. */
export function createDoubleTap(): (tap: Tap) => boolean {
  let last: Tap | null = null;
  return (tap) => {
    const pair =
      last !== null &&
      tap.at - last.at >= 0 &&
      tap.at - last.at <= DOUBLE_TAP_MS &&
      Math.hypot(tap.x - last.x, tap.y - last.y) <= DOUBLE_TAP_SLOP;
    last = pair ? null : tap;
    return pair;
  };
}

export interface DoubleTapHost {
  /** Something is playing (an idle picture has nothing to enlarge). */
  readonly playing: () => boolean;
  /** Full screen on or off, through GenX's own Full screen control. */
  readonly toggle: () => void;
}

/** Taps on these keep their own meaning. */
const CONTROLS = 'button, a, input, select, textarea, [role="slider"], [role="button"], dialog';

export function installDoubleTapFullscreen(screen: HTMLElement, host: DoubleTapHost): () => void {
  const recognize = createDoubleTap();
  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    const target = event.target as Element | null;
    // The Guide's preview is itself a button (one tap already opens full screen).
    if (target?.closest(CONTROLS) || screen.getAttribute('role') === 'button') return;
    if (!host.playing()) return;
    if (recognize({ x: event.clientX, y: event.clientY, at: event.timeStamp })) {
      event.preventDefault();
      host.toggle();
    }
  };
  // A double tap must not also zoom or select text on the picture.
  const onDoubleClick = (event: MouseEvent) => {
    if (!(event.target as Element | null)?.closest(CONTROLS)) event.preventDefault();
  };
  screen.addEventListener('pointerup', onPointerUp);
  screen.addEventListener('dblclick', onDoubleClick);
  return () => {
    screen.removeEventListener('pointerup', onPointerUp);
    screen.removeEventListener('dblclick', onDoubleClick);
  };
}
