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

import {
  REPLAY_BEHIND_LIMIT_SECONDS,
  REPLAY_REACH_SECONDS,
  replayAvailable,
  type LiveReplayEngine,
  type ReplayWindow,
} from '../../playback/controller';

/** Instant replay on live TV (docs/instant-replay.md, REPLAY01). */
export interface LiveReplayHost {
  /** The playing live channel's replay, or null (PlaybackController.liveReplay). */
  replay(): LiveReplayEngine | null;
  /** A live channel is on screen in the foreground and its dock can be used. */
  usable(): boolean;
  notice(message: string): void;
  /** Focus somewhere sensible when the focused replay control disappears. */
  focusFallback(): void;
  setInterval?(callback: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
  /** Milliseconds of a monotonic clock (performance.now by default). */
  now?(): number;
}
export interface LiveReplayControls {
  /** Re-read availability; ends a replay whose channel is gone. */
  render(): void;
  active(): boolean;
  /** Replay button and Rewind key: start, or 10 s further back while running. */
  rewind(): Promise<void>;
  /** Dock Pause/Play and the remote's play keys while a replay runs. */
  togglePause(): void;
  setPaused(paused: boolean): void;
  /** Back: leaves the replay for live; false when none runs. */
  back(): boolean;
  dispose(): void;
}

/** First jump back and slow speed. */
export const REPLAY_JUMP_SECONDS = 10;
export const REPLAY_START_RATE = 0.25;
/** The speed button's order, from the start speed. */
export const REPLAY_SPEED_CYCLE = [0.25, 0.5, 1, 0.125] as const;
const SPEED_TEXT: Record<number, [string, string]> = {
  0.125: ['⅛×', 'an eighth'],
  0.25: ['¼×', 'a quarter'],
  0.5: ['½×', 'half'],
  1: ['1×', 'normal'],
};
const POLL_MS = 250;
const AVAILABILITY_MS = 1_000;

export function installLiveReplay(root: ParentNode, host: LiveReplayHost): LiveReplayControls {
  const get = <T extends HTMLElement>(id: string) => {
    const found = root.querySelector<T>(`#${id}`);
    if (!found) throw new Error(`Missing replay control: ${id}`);
    return found;
  };
  const button = get<HTMLButtonElement>('replay-button');
  // Phones show Replay as an icon on the picture instead of in the dock.
  const overlay = get<HTMLButtonElement>('replay-overlay');
  const starts = [button, overlay];
  const shown = (element: HTMLElement) =>
    !element.hidden && !element.closest('[hidden]') && element.getClientRects().length > 0;
  const row = get<HTMLElement>('replay-transport');
  const status = get<HTMLElement>('playback-status');
  const back10 = get<HTMLButtonElement>('replay-back');
  const frameBack = get<HTMLButtonElement>('replay-frame-back');
  const pause = get<HTMLButtonElement>('replay-pause');
  const frameForward = get<HTMLButtonElement>('replay-frame-forward');
  const speed = get<HTMLButtonElement>('replay-speed');
  const position = get<HTMLOutputElement>('replay-position');
  const live = get<HTMLButtonElement>('replay-live');
  const every = host.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const stopEvery =
    host.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  // One replay at a time, tied to the handle it started with: a newer
  // channel's handle is never driven by an older replay's controls.
  const clock = host.now ?? (() => performance.now());
  let session: {
    handle: LiveReplayEngine;
    /** Where the viewer pressed Replay: playback returns to live here. */
    pressedAt: number;
    /** When it was pressed: the live picture keeps moving from there. */
    pressedClock: number;
    rate: number;
    paused: boolean;
    seeking: AbortController | null;
  } | null = null;
  let poll: unknown = null;
  let availability: unknown = null;
  let disposed = false;

  const set = (element: HTMLElement, name: string, value: string) => {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  };
  const text = (element: HTMLElement, value: string) => {
    if (element.textContent !== value) element.textContent = value;
  };
  const hide = (element: HTMLElement, value: boolean) => {
    if (element.hidden !== value) element.hidden = value;
  };
  const stopPoll = () => {
    if (poll !== null) stopEvery(poll);
    poll = null;
  };
  const showSession = () => {
    const running = session !== null;
    hide(row, !running);
    hide(status, running);
    for (const start of starts) set(start, 'aria-pressed', String(running));
    if (!session) return;
    text(pause, session.paused ? 'Play' : 'Pause');
    set(pause, 'aria-label', session.paused ? 'Play the replay' : 'Pause the replay');
    const [shown, spoken] = SPEED_TEXT[session.rate] ?? SPEED_TEXT[1]!;
    text(speed, shown);
    set(speed, 'aria-label', `Replay speed: ${spoken}`);
    // Busy, never disabled: a disabled button loses the remote's focus (the
    // Sansui dropped it to the page after each step, October 21, 2026).
    // Presses during a seek are ignored by seek() itself.
    const busy = String(session.seeking !== null);
    for (const control of [back10, frameBack, frameForward]) {
      set(control, 'aria-busy', busy);
      set(control, 'aria-disabled', busy);
    }
  };
  /** Where the live picture is now, on the player's timeline. */
  const livePoint = (current: NonNullable<typeof session>) =>
    current.pressedAt + (clock() - current.pressedClock) / 1000;
  /** The oldest moment a jump back may reach: kept, and within reach of
   *  live. A jump never moves forward: slow speeds can leave the replay
   *  further behind than the reach (the minute limit still applies). */
  const reach = (current: NonNullable<typeof session>, window: ReplayWindow) =>
    Math.min(window.position, Math.max(window.start, livePoint(current) - REPLAY_REACH_SECONDS));
  const showPosition = (window: ReplayWindow | null) => {
    const behind = window && session ? Math.max(0, livePoint(session) - window.position) : null;
    text(position, behind === null ? '—' : `−${behind.toFixed(1)} s`);
    set(
      position,
      'aria-label',
      behind === null ? 'Behind live' : `${behind.toFixed(1)} seconds behind live`,
    );
  };
  /** Ends the replay. `leave` returns the player to live at normal speed. */
  const end = (leave: boolean, message?: string) => {
    const ending = session;
    if (!ending) return;
    session = null;
    ending.seeking?.abort();
    stopPoll();
    const hadFocus = row.contains(document.activeElement);
    if (leave) ending.handle.leave();
    showSession();
    showPosition(null);
    if (hadFocus) {
      const start = starts.find((element) => shown(element) && !element.disabled);
      if (start) start.focus({ preventScroll: true });
      else host.focusFallback();
    }
    if (message) host.notice(message);
    render();
  };
  /** A seek inside the replay; one at a time, ended by the replay's end.
   *  Jumps stay within reach of live; one-picture steps only within what is
   *  kept, so a step back is never turned into a step forward. */
  const seek = async (
    target: (window: ReplayWindow) => number,
    kind: 'jump' | 'step' = 'jump',
  ): Promise<void> => {
    const current = session;
    if (!current || current.seeking) return;
    const window = current.handle.window();
    if (!window) return end(true, 'Back to live: this channel no longer holds that part.');
    const request = new AbortController();
    current.seeking = request;
    showSession();
    const oldest = kind === 'step' ? window.start : reach(current, window);
    const goal = Math.min(window.end, Math.max(oldest, target(window)));
    const shown = await current.handle.seek(goal, request.signal).catch(() => false);
    if (session !== current) return;
    current.seeking = null;
    showSession();
    if (!shown && !request.signal.aborted)
      end(true, 'Back to live: the replay could not show that moment.');
    else tick();
  };
  const tick = () => {
    const current = session;
    if (!current) return;
    if (!host.usable()) return end(true);
    const window = current.handle.window();
    if (!window) {
      // The handle goes quiet when its channel changes, stops or fails.
      if (!host.replay()) return end(false);
      return end(true, 'Back to live: the replay reached the end of what is kept.');
    }
    showPosition(window);
    if (!current.paused && !current.seeking && window.position >= current.pressedAt - 0.05)
      return end(true, 'Back to live.');
    if (livePoint(current) - window.position > REPLAY_BEHIND_LIMIT_SECONDS)
      end(true, 'Back to live: the replay fell a minute behind.');
  };
  const start = async (): Promise<void> => {
    if (session || disposed || !host.usable()) return;
    const handle = host.replay();
    const window = handle?.window() ?? null;
    if (!handle || !replayAvailable(window)) {
      host.notice('Instant replay is ready after a few seconds of this channel.');
      return;
    }
    session = {
      handle,
      pressedAt: window.position,
      pressedClock: clock(),
      rate: REPLAY_START_RATE,
      paused: false,
      seeking: null,
    };
    handle.setRate(REPLAY_START_RATE);
    showSession();
    showPosition(window);
    poll = every(tick, POLL_MS);
    if (
      starts.includes(document.activeElement as HTMLButtonElement) ||
      !row.contains(document.activeElement)
    )
      pause.focus({ preventScroll: true });
    await seek((now) => now.position - REPLAY_JUMP_SECONDS);
  };
  const setPaused = (paused: boolean) => {
    if (!session) return;
    session.paused = paused;
    session.handle.setPaused(paused);
    showSession();
  };
  const step = (direction: -1 | 1) => {
    if (!session) return;
    setPaused(true);
    void seek((now) => now.position + direction * now.frameSeconds, 'step');
  };
  function render(): void {
    if (disposed) return;
    const usable = host.usable();
    if (session && !usable) end(true);
    for (const start of starts) hide(start, !usable);
    if (usable && availability === null) availability = every(render, AVAILABILITY_MS);
    if (!usable && availability !== null) {
      stopEvery(availability);
      availability = null;
    }
    if (session) {
      for (const start of starts) if (start.disabled) start.disabled = false;
      return;
    }
    const ready = usable && replayAvailable(host.replay()?.window() ?? null);
    for (const start of starts) {
      if (start.disabled === ready) start.disabled = !ready;
      set(
        start,
        'title',
        ready
          ? 'Replay the last 10 seconds at a quarter speed'
          : 'Instant replay is ready after a few seconds of this channel',
      );
    }
  }

  const handlers: Array<[HTMLElement, () => void]> = [
    [button, () => void controls.rewind()],
    [overlay, () => void controls.rewind()],
    [back10, () => void seek((now) => now.position - REPLAY_JUMP_SECONDS)],
    [frameBack, () => step(-1)],
    [frameForward, () => step(1)],
    [pause, () => controls.togglePause()],
    [
      speed,
      () => {
        if (!session) return;
        const at = REPLAY_SPEED_CYCLE.indexOf(session.rate as (typeof REPLAY_SPEED_CYCLE)[number]);
        session.rate = REPLAY_SPEED_CYCLE[(at + 1) % REPLAY_SPEED_CYCLE.length]!;
        session.handle.setRate(session.rate);
        showSession();
      },
    ],
    [live, () => end(true)],
  ];
  for (const [element, handler] of handlers) element.addEventListener('click', handler);

  const controls: LiveReplayControls = {
    render,
    active: () => session !== null,
    async rewind() {
      if (session) await seek((now) => now.position - REPLAY_JUMP_SECONDS);
      else await start();
    },
    togglePause() {
      if (session) setPaused(!session.paused);
    },
    setPaused,
    back() {
      if (!session) return false;
      end(true);
      return true;
    },
    dispose() {
      if (disposed) return;
      end(true);
      disposed = true;
      if (availability !== null) stopEvery(availability);
      availability = null;
      for (const [element, handler] of handlers) element.removeEventListener('click', handler);
    },
  };
  render();
  return controls;
}
