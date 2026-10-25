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

import '../first-scan-hint.css';
import { queryCatalogPage } from '../../platform/catalog-query';

/**
 * Before the first Free TV scan the channel list is empty and it is not
 * obvious that the magnifier starts one. Until Free TV has channels, the
 * magnifier glows with a "Start here" callout (and takes the remote's focus
 * when nothing else has it); during that first scan the callout explains it
 * can take a long time. Once the scan is over and channels exist it never
 * shows again; the state comes from the saved catalog itself (all channels,
 * no filter), not a setting, and an unknown total never shows it.
 */
export function mountFirstScanHint(indexed: () => boolean, inMemory: () => number): void {
  const button = document.querySelector<HTMLButtonElement>('#search-programs');
  const app = document.querySelector<HTMLElement>('#app');
  if (!button || !app) return;
  const callout = document.createElement('p');
  callout.className = 'first-scan-callout';
  callout.hidden = true;
  callout.setAttribute('role', 'note');
  const title = document.createElement('strong');
  const text = document.createElement('span');
  callout.append(title, text);
  button.closest('.search-controls')?.after(callout);

  /** Saved Free TV channels, or null when unknown. */
  const total = (): Promise<number | null> =>
    indexed()
      ? queryCatalogPage(
          { schemaVersion: 1, query: '', filter: 'all', sort: 'source', pageSize: 1 },
          AbortSignal.timeout(5000),
        ).then(
          (page) => page.totalCount,
          () => null,
        )
      : Promise.resolve(inMemory());

  let retired = false;
  /** This session found Free TV empty, so an open scan panel is the first scan. */
  let sawEmpty = false;
  let shown: 'start' | 'scanning' | null = null;
  let checking = false;
  const show = (value: 'start' | 'scanning' | null) => {
    if (value === shown) return;
    shown = value;
    callout.hidden = !value;
    button.classList.toggle('first-scan', value === 'start');
    if (value === 'start') {
      title.textContent = 'Start here';
      text.textContent =
        'Press the magnifier to find free TV channels. The first scan checks thousands of channels and can take a long time.';
    } else if (value === 'scanning') {
      title.textContent = 'First scan';
      text.textContent =
        'This can take a long time. Channels appear in the list as they are confirmed, so you can start watching while it runs.';
    }
    const idle = !document.activeElement || document.activeElement === document.body;
    if (value === 'start' && idle && app.dataset.deviceKind === 'tv') button.focus();
  };
  const update = () => {
    const scanPanel = document.querySelector<HTMLElement>('#inline-source-scan');
    const eligible =
      !retired &&
      app.dataset.startup === 'completed' &&
      app.dataset.contentLibrary === 'live' &&
      document.querySelector('#paid-tv-button[aria-pressed="true"]') === null &&
      document.querySelector('#local-button[aria-pressed="true"]') === null;
    if (!eligible) return show(null);
    // While the first scan runs the note explains the wait. Running means the
    // panel's Stop button shows (inline-scan-panel.ts: hidden when not active):
    // a stopped or finished scan leaves the panel open with Finish scan and
    // Rescan, and the note goes (owner's report, October 24, 2026). It retires
    // once channels are saved.
    const running =
      scanPanel !== null &&
      !scanPanel.hidden &&
      document.querySelector<HTMLElement>('#inline-scan-stop')?.hidden === false;
    if (running) return show(sawEmpty ? 'scanning' : null);
    if (scanPanel && !scanPanel.hidden) return show(null);
    if (checking) return;
    checking = true;
    void total().then((count) => {
      checking = false;
      if (count !== null && count > 0) retired = true;
      if (count === 0) sawEmpty = true;
      show(!retired && count === 0 ? 'start' : null);
    });
  };
  let timer = 0;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(update, 500);
  }).observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-startup', 'data-content-library', 'aria-pressed', 'hidden'],
  });
  update();
}
