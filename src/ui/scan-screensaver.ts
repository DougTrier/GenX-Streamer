/**
 * Screensaver for long scans (owner design, October 22, 2026): a scan can run
 * for hours with the TV untouched, so its screen would show the same picture
 * all that time. Only while a scan runs, nothing is playing and there has been
 * no input for `idleMs`, the screen goes black with one dim progress line that
 * moves every `moveMs`. Never anywhere else. GenX stays in front underneath,
 * so the scan keeps going (sleeping the TV would pause it). Any key, touch or
 * pointer movement brings the app back; that first input only wakes it.
 */
export interface ScanScreensaverDeps {
  /** A scan (including the Slow list) is running. */
  scanActive(): boolean;
  /** Something is playing, starting or buffering. */
  viewing(): boolean;
  /** The scan panel's progress line. */
  status(): string;
  now?: () => number;
  random?: () => number;
  idleMs?: number;
  moveMs?: number;
  /** Whether to run its own one-second timer (tests drive tick() instead). */
  timer?: boolean;
}
const WAKE_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const;

export function mountScanScreensaver(doc: Document, deps: ScanScreensaverDeps) {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const idleMs = deps.idleMs ?? 5 * 60_000;
  const moveMs = deps.moveMs ?? 30_000;
  const overlay = doc.createElement('div');
  overlay.id = 'scan-screensaver';
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  const line = doc.createElement('p');
  line.className = 'scan-screensaver-line';
  overlay.append(line);
  doc.body.append(overlay);
  let lastInput = now();
  let eligibleSince: number | null = null;
  let movedAt = 0;
  const place = () => {
    line.style.left = `${Math.round(5 + random() * 55)}%`;
    line.style.top = `${Math.round(8 + random() * 76)}%`;
    movedAt = now();
  };
  const wake = (event: Event) => {
    lastInput = now();
    if (overlay.hidden) return;
    overlay.hidden = true;
    // The waking input only wakes the screen; it does not also act on the app.
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of WAKE_EVENTS) doc.addEventListener(type, wake, { capture: true });
  function tick(): void {
    const t = now();
    if (!deps.scanActive() || deps.viewing()) {
      eligibleSince = null;
      overlay.hidden = true;
      return;
    }
    eligibleSince ??= t;
    // Idle counts from the later of the last input and the scan becoming eligible.
    if (t - Math.max(lastInput, eligibleSince) < idleMs) return;
    if (overlay.hidden) {
      overlay.hidden = false;
      place();
    } else if (t - movedAt >= moveMs) place();
    line.textContent = deps.status();
  }
  const interval = deps.timer === false ? undefined : setInterval(tick, 1000);
  return {
    tick,
    get showing(): boolean {
      return !overlay.hidden;
    },
    dispose(): void {
      if (interval !== undefined) clearInterval(interval);
      for (const type of WAKE_EVENTS) doc.removeEventListener(type, wake, { capture: true });
      overlay.remove();
    },
  };
}
