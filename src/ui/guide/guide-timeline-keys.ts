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

import { prepareRemoteFocus } from '../shell/remote-navigation';
import { channelKey, type TimelineChannel } from './guide-timeline-model';

/** What this part reads from, and writes back to, mountGuideTimeline. */
export interface TimelineKeysEnvironment {
  readonly searchBox: HTMLInputElement;
  readonly toolbar: HTMLElement;
  readonly agendaMode: boolean;
  readonly viewport: HTMLDivElement;
  readonly content: HTMLDivElement;
  readonly renderedStart: number;
  readonly active: Promise<void> | null;
  readonly browseChannel: HTMLButtonElement;
  rowFocus: { key: string; column: number } | null;
  readonly visibleChannels: () => readonly TimelineChannel[];
  readonly rowHeight: number;
  readonly renderedCovers: () => boolean;
  readonly refresh: () => Promise<void>;
  readonly report: () => void;
  readonly closeDetails: () => boolean;
  readonly root: HTMLElement;
  readonly clock: () => void;
  readonly closed: boolean;
  readonly foreground: boolean;
  readonly measuredRowHeight: () => number;
  readonly agendaLimit: () => number;
  readonly details: HTMLElement;
  readonly status: HTMLParagraphElement;
  readonly renderedViewportHeight: number;
  readonly doc: Document;
}

/**
 * The timeline guide's remote keys and its response to resizing. Part of
 * mountGuideTimeline.
 */
export function createTimelineKeys(env: TimelineKeysEnvironment) {
  const key = (event: KeyboardEvent) => {
    // The toolbar is one ordered row for a remote: disabled buttons and the
    // date label must not send Left/Right down into the grid.
    // From the search field, Left/Right leave only at the edge of the text.
    const searchEdge =
      event.target === env.searchBox &&
      (event.key === 'ArrowLeft'
        ? env.searchBox.selectionStart === 0 && env.searchBox.selectionEnd === 0
        : env.searchBox.selectionStart === env.searchBox.value.length);
    if (
      !event.defaultPrevented &&
      (event.target instanceof HTMLButtonElement || searchEdge) &&
      env.toolbar.contains(event.target as Node) &&
      ['ArrowLeft', 'ArrowRight'].includes(event.key)
    ) {
      const controls = [
        ...env.toolbar.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input'),
      ].filter((control) => !control.disabled && control.getClientRects().length > 0);
      const index = controls.indexOf(event.target as HTMLButtonElement);
      const next = controls[index + (event.key === 'ArrowRight' ? 1 : -1)];
      if (index >= 0 && next) {
        event.preventDefault();
        event.stopPropagation();
        // The search field arrives in navigation mode (keyboard waits for OK).
        prepareRemoteFocus(next);
        next.focus({ preventScroll: true });
        return;
      }
    }
    if (!env.agendaMode && !event.defaultPrevented) {
      const target = event.target;
      const row =
        target instanceof HTMLElement ? target.closest<HTMLElement>('.gx-timeline-row') : null;
      if (target === env.viewport && ['ArrowDown', 'ArrowRight', 'Enter'].includes(event.key)) {
        const first = env.content.querySelector<HTMLButtonElement>('.gx-timeline-channel');
        if (first) {
          event.preventDefault();
          event.stopPropagation();
          first.focus({ preventScroll: true });
          return;
        }
      }
      if (row && env.content.contains(row) && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        const controls = [...row.querySelectorAll<HTMLButtonElement>('button')];
        const index = controls.indexOf(target as HTMLButtonElement);
        const next = controls[index + (event.key === 'ArrowRight' ? 1 : -1)];
        event.preventDefault();
        event.stopPropagation();
        next?.focus({ preventScroll: true });
        return;
      }
      if (
        env.renderedStart === 0 &&
        row === env.content.querySelector('.gx-timeline-row') &&
        target instanceof HTMLElement &&
        event.key === 'ArrowUp'
      ) {
        const origin = target.getBoundingClientRect();
        const header =
          [...env.toolbar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
            .filter((button) => button.getClientRects().length > 0)
            .sort((a, b) => {
              const centre = (r: DOMRect) =>
                Math.abs(r.x + r.width / 2 - (origin.x + origin.width / 2));
              return centre(a.getBoundingClientRect()) - centre(b.getBoundingClientRect());
            })[0] ?? null;
        if (header) {
          event.preventDefault();
          event.stopPropagation();
          header.focus({ preventScroll: true });
          return;
        }
      }
    }

    if (
      env.agendaMode &&
      env.active &&
      event.target === env.viewport &&
      ['ArrowDown', 'ArrowUp'].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      env.agendaMode &&
      !event.defaultPrevented &&
      ['ArrowDown', 'ArrowUp'].includes(event.key) &&
      event.target instanceof HTMLElement &&
      env.content.contains(event.target)
    ) {
      const controls = [...env.content.querySelectorAll<HTMLButtonElement>('button')],
        index = controls.indexOf(event.target as HTMLButtonElement);
      if (index >= 0) {
        event.preventDefault();
        event.stopPropagation();
        const next = controls[index + (event.key === 'ArrowDown' ? 1 : -1)];
        const target = next ?? (event.key === 'ArrowUp' ? env.browseChannel : controls[index]);
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        return;
      }
    }

    if (!event.defaultPrevented && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const target = event.target;
      const row =
        target instanceof HTMLElement ? target.closest<HTMLElement>('.gx-timeline-row') : null;
      const pendingFocus = target === env.viewport && env.active ? env.rowFocus : null;
      if ((row && env.content.contains(row)) || pendingFocus) {
        const channels = env.visibleChannels();
        const index = channels.findIndex(
          (c) => channelKey(c) === (row?.dataset.channelKey ?? pendingFocus!.key),
        );
        const nextIndex = index + (event.key === 'ArrowDown' ? 1 : -1);
        if (index >= 0 && nextIndex >= 0 && nextIndex < channels.length) {
          event.preventDefault();
          event.stopPropagation();
          const column = row
            ? [...row.querySelectorAll('button')].indexOf(target as HTMLButtonElement)
            : pendingFocus!.column;
          const desired = { key: channelKey(channels[nextIndex]!), column };
          const nextRow = [...env.content.querySelectorAll<HTMLElement>('.gx-timeline-row')].find(
            (r) => r.dataset.channelKey === desired.key,
          );
          const controls = nextRow?.querySelectorAll<HTMLButtonElement>('button');
          if (controls?.length) {
            controls[Math.min(Math.max(0, column), controls.length - 1)]!.focus({
              preventScroll: true,
            });
          }
          const top = nextIndex * env.rowHeight;
          if (top < env.viewport.scrollTop) env.viewport.scrollTop = top;
          else if (top + env.rowHeight > env.viewport.scrollTop + env.viewport.clientHeight)
            env.viewport.scrollTop = top + env.rowHeight - env.viewport.clientHeight;
          env.rowFocus = desired;
          if (!nextRow || !env.renderedCovers()) {
            // Capture explicitly requested identity after invalidate captures the old row.
            const pending = env.refresh();
            env.rowFocus = desired;
            void pending.catch(env.report);
          }
          return;
        }
      }
    }
    if (event.key === 'Escape' && env.closeDetails()) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  env.root.addEventListener('keydown', key);
  const resize = new ResizeObserver(() => {
    env.clock();
    if (
      !env.closed &&
      env.foreground &&
      (env.measuredRowHeight() !== env.rowHeight ||
        env.root.clientWidth <= env.agendaLimit() !== env.agendaMode ||
        (!env.agendaMode &&
          env.details.hidden &&
          env.status.dataset.state === 'ready' &&
          env.viewport.clientHeight > 0 &&
          env.viewport.clientHeight !== env.renderedViewportHeight))
    ) {
      const focused = env.doc.activeElement;
      const row =
        focused instanceof HTMLElement ? focused.closest<HTMLElement>('.gx-timeline-row') : null;
      if (row && env.content.contains(row) && env.viewport.clientHeight > 0) {
        const index = env
          .visibleChannels()
          .findIndex((channel) => channelKey(channel) === row.dataset.channelKey);
        if (index >= 0) {
          const top = index * env.measuredRowHeight();
          if (top < env.viewport.scrollTop) env.viewport.scrollTop = top;
          else if (
            top + env.measuredRowHeight() >
            env.viewport.scrollTop + env.viewport.clientHeight
          )
            env.viewport.scrollTop = top + env.measuredRowHeight() - env.viewport.clientHeight;
        }
      }
      void env.refresh().catch(env.report);
    }
  });
  return {
    resize,
    key,
  };
}
