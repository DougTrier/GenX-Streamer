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

import type { AutomaticScanProgress } from './source-scan-model';
import { createScanPace, timeLeftText } from './scan-pace';

const KIND: Record<NonNullable<AutomaticScanProgress['scanKind']>, string> = {
  refresh: 'Refresh',
  rescan: 'Rescan',
  slow: 'Slow channels, in the background',
  continue: 'Finishing scan',
};
const count = (n: number) => n.toLocaleString('en-US');

/**
 * The scan panel above the channel list. A finished saved scan has nothing to
 * do, so it is not shown at startup; Close hides the panel until the user asks
 * again with the magnifier (Finish scan / Refresh / Rescan / Close) or a scan
 * runs. Refresh looks only for new channels and removes confirmed-dead ones;
 * Rescan checks everything again from scratch.
 */
export function mountInlineScanPanel(
  doc: Document,
  closing: () => boolean,
  now: () => number = Date.now,
) {
  const get = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;
  const panel = get('inline-source-scan');
  const close = doc.createElement('button');
  close.id = 'inline-scan-close';
  close.type = 'button';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close scan panel');
  close.hidden = true;
  panel.querySelector('.inline-scan-actions')!.append(close);
  // Shown in place of "Continue": it finishes the remaining checks.
  get('inline-scan-continue').textContent = 'Finish scan';
  // Refresh (new channels, dead ones removed) is offered with Rescan
  // (everything from scratch) only after a finished scan: it builds on that
  // scan's checks. An unfinished scan offers Finish scan instead, and one that
  // cannot continue only Rescan (seen on the Sansui, October 21, 2026).
  let refreshable = false;
  const refresh = get<HTMLButtonElement>('inline-scan-refresh');
  const rescanButton = get<HTMLButtonElement>('inline-scan-rescan');
  const finish = get<HTMLButtonElement>('inline-scan-continue');
  const follow = () => {
    const hidden = rescanButton.hidden || !finish.hidden || !refreshable;
    if (refresh.hidden !== hidden) refresh.hidden = hidden;
    if (refresh.disabled !== rescanButton.disabled) refresh.disabled = rescanButton.disabled;
  };
  const watch = new MutationObserver(follow);
  for (const button of [rescanButton, finish])
    watch.observe(button, { attributes: true, attributeFilter: ['hidden', 'disabled'] });
  follow();
  const pace = createScanPace(now);
  let dismissed = false,
    revealed = false,
    last: Readonly<AutomaticScanProgress> | null = null;
  close.addEventListener('click', () => {
    dismissed = true;
    revealed = false;
    panel.hidden = true;
  });
  function render(progress: Readonly<AutomaticScanProgress>): void {
    last = progress;
    refreshable =
      progress.phase === 'completed' &&
      progress.savedSummary !== 'invalid' &&
      progress.resumeRefusal === undefined &&
      !progress.error;
    follow();
    const active = progress.busy || progress.pendingPublications > 0;
    if (active) dismissed = false;
    const finishedSaved = !active && progress.savedSummary === 'completed' && !revealed;
    panel.hidden =
      dismissed ||
      finishedSaved ||
      progress.presentation !== 'inline' ||
      (progress.phase === 'idle' && !active && !progress.error && !progress.total);
    if (panel.hidden) return;
    const subject = progress.slowPass
      ? 'Slow channels, in the background'
      : progress.query
        ? `“${progress.query}”`
        : 'all channels';
    // Owner request (October 21, 2026): say which kind of scan this is, how
    // many it saved, its pace and the time left, so a slow or wrong scan shows.
    const kind = progress.scanKind ? KIND[progress.scanKind] : undefined;
    const lead =
      kind === undefined
        ? subject
        : progress.query && progress.scanKind !== 'slow'
          ? `${kind} · ${subject}`
          : kind;
    const running = () => {
      const saved = progress.checked
        ? ` (${Math.round((progress.published / progress.checked) * 100)}%)`
        : '';
      const measured = pace.sample(
        `${progress.generation}:${progress.total}:${progress.scanKind ?? ''}`,
        progress.checked,
        progress.total,
      );
      const speed =
        measured.perMinute === null || measured.leftMs === null
          ? ' · measuring pace…'
          : ` · ${count(measured.perMinute)} a minute · ${timeLeftText(measured.leftMs)}`;
      return `${lead} · ${count(progress.checked)} of ${count(progress.total)} checked · ${count(progress.published)} saved${saved}${speed}`;
    };
    get('inline-scan-status').textContent =
      progress.savedSummary ||
      progress.resumeRefusal ||
      ['completed', 'failed'].includes(progress.phase) ||
      (!active && progress.phase === 'paused')
        ? progress.status
        : active && progress.phase === 'paused'
          ? `Saving scan progress… · ${progress.checked} checked · ${progress.published} saved`
          : progress.phase === 'collecting' || (active && progress.total === 0)
            ? kind && progress.scanKind !== 'slow'
              ? `${kind} · finding ${subject}…`
              : `Finding ${subject}…`
            : running();
    const message = get('inline-scan-error');
    message.textContent = progress.error;
    message.hidden = !progress.error;
    const stop = get<HTMLButtonElement>('inline-scan-stop');
    stop.hidden = !active;
    stop.disabled = closing();
    const resume = get<HTMLButtonElement>('inline-scan-continue');
    resume.hidden =
      active ||
      !progress.canContinue ||
      progress.savedSummary === 'invalid' ||
      progress.resumeRefusal !== undefined ||
      !['paused', 'failed'].includes(progress.phase);
    resume.disabled = closing();
    const rescan = get<HTMLButtonElement>('inline-scan-rescan');
    rescan.hidden = active || (progress.phase === 'idle' && !progress.error && !progress.total);
    rescan.disabled = closing();
    close.hidden = active;
  }
  return {
    render,
    /** The magnifier asked for the panel: show it again, with Close unless work is running. */
    reveal(running = false): void {
      dismissed = false;
      revealed = true;
      panel.hidden = false;
      close.hidden = running;
    },
    /** A saved, unfinished scan reopened by the magnifier, offering its choices. */
    reopen(): boolean {
      if (!last || !last.canContinue || !['paused', 'failed'].includes(last.phase)) return false;
      dismissed = false;
      revealed = true;
      render(last);
      return !panel.hidden;
    },
  };
}
