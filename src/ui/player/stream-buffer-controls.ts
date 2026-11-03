/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import type { ChannelSelection } from '../../playback/controller-model';
import {
  LIVE_BUFFER_MAX_SECONDS,
  LIVE_BUFFER_MIN_SECONDS,
  type LiveBufferPreference,
  type LiveBufferTelemetry,
} from '../../playback/live-buffer';

export interface StreamBufferControlsHost {
  current(): {
    selection: Readonly<ChannelSelection> | null;
    state: string;
    generation: number;
    telemetry: Readonly<LiveBufferTelemetry> | null;
    external?: boolean;
  };
  key(selection: Readonly<ChannelSelection>): Promise<string | null>;
  save(key: string, preference: LiveBufferPreference): Promise<unknown>;
  apply(preference: LiveBufferPreference): Promise<boolean>;
  notice(message: string): void;
  trace?(telemetry: Readonly<LiveBufferTelemetry> | null): void;
}

export function formatStreamRate(bitsPerSecond: number | null): string {
  return bitsPerSecond === null || !Number.isFinite(bitsPerSecond) || bitsPerSecond < 0
    ? '— kbps'
    : `${Math.round(bitsPerSecond / 1000).toLocaleString('en-US')} kbps`;
}

/** Two presentations of one active player's tuning; neither owns playback. */
export function mountStreamBufferControls(root: HTMLElement, host: StreamBufferControlsHost) {
  const footer = root.querySelector<HTMLElement>('#stream-buffer-footer');
  const dock = root.querySelector<HTMLElement>('.dock');
  const panels: HTMLElement[] = [];
  let disposed = false;
  let pending = false;
  let activeChange: Promise<void> | null = null;
  let lastSelection: string | null = null;
  let samples: number[] = [];
  const baseline = (value: Readonly<LiveBufferTelemetry> | null) =>
    Math.max(
      LIVE_BUFFER_MIN_SECONDS,
      Math.min(
        LIVE_BUFFER_MAX_SECONDS,
        Math.round(value?.targetSeconds ?? value?.bufferedSeconds ?? 3),
      ),
    );
  const same = (selection: Readonly<ChannelSelection>, generation: number) => {
    const current = host.current();
    return (
      !disposed &&
      current.generation === generation &&
      current.selection?.id === selection.id &&
      current.selection?.url === selection.url &&
      current.selection?.liveBufferKey === selection.liveBufferKey
    );
  };
  const change = async (direction: -1 | 1 | 'auto') => {
    const before = host.current();
    if (
      disposed ||
      pending ||
      before.external ||
      !before.selection ||
      before.telemetry?.capability !== 'controlled' ||
      !['playing', 'paused', 'buffering'].includes(before.state)
    )
      return;
    const selection = before.selection;
    const generation = before.generation;
    const preference: LiveBufferPreference =
      direction === 'auto'
        ? { mode: 'auto' }
        : {
            mode: 'manual',
            targetSeconds: Math.max(
              LIVE_BUFFER_MIN_SECONDS,
              Math.min(LIVE_BUFFER_MAX_SECONDS, baseline(before.telemetry) + direction),
            ),
          };
    const previous: LiveBufferPreference =
      before.telemetry.mode === 'manual' && before.telemetry.targetSeconds !== null
        ? { mode: 'manual', targetSeconds: before.telemetry.targetSeconds }
        : { mode: 'auto' };
    pending = true;
    render();
    try {
      const key = await host.key(selection);
      if (!same(selection, generation)) return;
      if (!key) {
        host.notice('This stream has no stable identity for saved buffer tuning.');
        return;
      }
      const applied = await host.apply(preference);
      if (!same(selection, generation)) return;
      if (!applied) {
        host.notice('This player could not apply the buffer change.');
        return;
      }
      try {
        await host.save(key, preference);
      } catch {
        if (!same(selection, generation)) return;
        const restored = await host.apply(previous);
        if (same(selection, generation))
          host.notice(
            restored
              ? 'The saved buffer change could not be confirmed. The current player was restored.'
              : 'The buffer setting could not be saved or restored. Retry the change when playback is ready.',
          );
        return;
      }
      if (same(selection, generation))
        host.notice(
          preference.mode === 'auto'
            ? 'Automatic buffering restored for this stream.'
            : `Buffer target saved for this stream: ${preference.targetSeconds} seconds.`,
        );
    } catch {
      if (same(selection, generation)) host.notice('The buffer change could not be confirmed.');
    } finally {
      pending = false;
      if (!disposed) render();
    }
  };
  const requestChange = (direction: -1 | 1 | 'auto'): Promise<void> => {
    if (disposed || pending) return Promise.resolve();
    const work = change(direction);
    activeChange = work;
    const done = () => {
      if (activeChange === work) activeChange = null;
    };
    void work.then(done, done);
    return work;
  };
  const click = (event: Event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-buffer-action]')
      ?.dataset.bufferAction;
    if (action === 'less' || action === 'more' || action === 'auto')
      void requestChange(action === 'less' ? -1 : action === 'more' ? 1 : 'auto').catch(() => {
        if (!disposed) host.notice('The buffer setting could not be changed.');
      });
  };
  const keys = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
    )
      return;
    const panel = event.currentTarget as HTMLElement;
    const choices = [
      ...panel.querySelectorAll<HTMLElement>(':scope > button, :scope > .stream-buffer-meter'),
    ].filter((element) => {
      const rect = element.getBoundingClientRect();
      return (
        element.tabIndex >= 0 &&
        !(element instanceof HTMLButtonElement && element.disabled) &&
        element.getAttribute('aria-disabled') !== 'true' &&
        !element.closest('[hidden],[inert]') &&
        getComputedStyle(element).visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    const index = choices.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    const next = choices[index + (event.key === 'ArrowLeft' ? -1 : 1)];
    // Only neighbours in this panel are owned here; edges and vertical keys
    // continue to the app's spatial navigator without changing buffering.
    if (!next) return;
    event.preventDefault();
    next.focus({ preventScroll: true });
  };
  for (const [parent, presentation] of [
    [footer, 'footer'],
    [dock, 'fullscreen'],
  ] as const) {
    if (!parent) continue;
    const panel = document.createElement('div');
    panel.className = `stream-buffer-controls stream-buffer-${presentation}`;
    panel.innerHTML = `<span class="stream-buffer-channel"></span><button type="button" data-buffer-action="less" aria-label="Decrease this stream's buffer target">◀</button><div class="stream-buffer-meter" tabindex="0" role="group" aria-label="Stream buffer. Use the arrow buttons to adjust the target."><span class="stream-buffer-fill" aria-hidden="true"></span><span class="stream-buffer-readout"></span></div><button type="button" data-buffer-action="more" aria-label="Increase this stream's buffer target">▶</button><button type="button" data-buffer-action="auto" title="Restore automatic buffering for this stream">Auto</button><span class="stream-buffer-target"></span>`;
    panel.addEventListener('click', click);
    panel.addEventListener('keydown', keys);
    parent.append(panel);
    panels.push(panel);
  }
  if (!panels.length) return { render() {}, dispose() {} };
  function render() {
    if (disposed) return;
    const current = host.current();
    const identity = current.selection
      ? JSON.stringify([
          current.generation,
          current.selection.id,
          current.selection.url,
          current.selection.liveBufferKey,
        ])
      : null;
    if (identity !== lastSelection) {
      host.trace?.(null);
      lastSelection = identity;
      samples = [];
    }
    const active =
      !!current.selection &&
      ['playing', 'paused', 'buffering'].includes(current.state) &&
      !current.external;
    const value = active ? current.telemetry : null;
    host.trace?.(value);
    const controlled = active && value?.capability === 'controlled';
    const seconds = value?.bufferedSeconds;
    const target = baseline(value);
    const ahead = seconds === null || seconds === undefined ? null : seconds;
    const health =
      !active || ahead === null || current.state === 'paused'
        ? 'unknown'
        : ahead >= (value?.targetSeconds ?? 3)
          ? 'healthy'
          : ahead >= (value?.targetSeconds ?? 3) * 0.5
            ? 'low'
            : 'empty';
    const trend =
      samples.length > 1 && ahead !== null
        ? ahead < samples[0] - 0.5
          ? ' ↓'
          : ahead > samples[0] + 0.5
            ? ' ↑'
            : ''
        : '';
    for (const panel of panels) {
      panel.dataset.bufferHealth = health;
      panel.dataset.bufferCapability = value?.capability ?? 'unavailable';
      const channel = panel.querySelector<HTMLElement>('.stream-buffer-channel')!;
      channel.textContent = current.external
        ? 'External player'
        : (current.selection?.name ?? 'Stream buffer');
      channel.title = channel.textContent;
      panel.querySelector<HTMLElement>('.stream-buffer-readout')!.textContent = !active
        ? current.external
          ? 'Buffer managed by the external player'
          : 'Choose a channel'
        : `${formatStreamRate(value?.incomingBitsPerSecond ?? null)} ${ahead === null ? 'Buffer unavailable' : `${ahead.toFixed(1)}s${value?.mode === 'manual' ? ` / Target ${value.targetSeconds}s` : ' buffered'}${trend}`}`;
      panel.querySelector<HTMLElement>('.stream-buffer-fill')!.style.width =
        `${ahead === null ? 0 : Math.min(100, (ahead / target) * 100)}%`;
      panel.querySelector<HTMLElement>('.stream-buffer-target')!.textContent =
        value?.mode === 'manual' ? `Target ${value.targetSeconds}s` : active ? 'Auto' : '';
      const focused = document.activeElement;
      for (const button of panel.querySelectorAll<HTMLButtonElement>('button')) {
        const action = button.dataset.bufferAction;
        button.disabled =
          !controlled ||
          (action === 'auto' && value?.mode === 'auto') ||
          (action === 'less' && target <= LIVE_BUFFER_MIN_SECONDS) ||
          (action === 'more' && target >= LIVE_BUFFER_MAX_SECONDS);
      }
      const meter = panel.querySelector<HTMLElement>('.stream-buffer-meter')!;
      meter.tabIndex = controlled ? 0 : -1;
      meter.setAttribute('aria-disabled', String(!controlled));
      panel.setAttribute('aria-busy', String(pending));
      if (
        controlled &&
        focused instanceof HTMLButtonElement &&
        panel.contains(focused) &&
        focused.disabled &&
        !panel.closest('[inert]') &&
        panel.getBoundingClientRect().width > 0
      )
        meter.focus({ preventScroll: true });
      meter.title = controlled
        ? 'Measured media download rate and buffered video. More buffer can add live delay; reducing the target does not seek or discard video.'
        : 'This player does not expose manual buffer control.';
    }
  }
  render();
  const timer = setInterval(() => {
    const current = host.current();
    const identity = current.selection
      ? JSON.stringify([
          current.generation,
          current.selection.id,
          current.selection.url,
          current.selection.liveBufferKey,
        ])
      : null;
    if (
      identity === lastSelection &&
      current.telemetry?.bufferedSeconds !== null &&
      current.telemetry?.bufferedSeconds !== undefined
    ) {
      samples.push(current.telemetry.bufferedSeconds);
      samples = samples.slice(-5);
    }
    render();
  }, 1000);
  return {
    render,
    async dispose() {
      disposed = true;
      clearInterval(timer);
      for (const panel of panels) {
        panel.removeEventListener('click', click);
        panel.removeEventListener('keydown', keys);
        panel.remove();
      }
      if (activeChange) await Promise.allSettled([activeChange]);
    },
  };
}
