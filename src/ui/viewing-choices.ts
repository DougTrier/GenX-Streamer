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

import { viewingSettings, type ViewingSettings } from '../platform/viewing-settings';
import type { GeographySummary } from './geography-controls';

/**
 * Settings → "Hide adult channels" (one choice for Free TV and Paid TV), and
 * the selected paid account's country summary for the Location panel. The
 * summary follows only the account and the adult choice, never the current
 * country, search or category, so every country stays reachable.
 */
export interface ViewingChoicesHost {
  /** Both channel lists apply the adult choice immediately. */
  channels: { setHideAdult(hide: boolean): void };
  accounts: {
    readonly selectedAccount: { id: string; revision: string } | null;
    countries(hideAdult: boolean, signal: AbortSignal): Promise<GeographySummary | null>;
  };
  /** The Location panel re-reads the summary. */
  changed(): void;
  notice(message: string): void;
}
export function mountViewingChoices(host: ViewingChoicesHost) {
  const toggle = document.getElementById('hide-adult-channels') as HTMLInputElement | null;
  let summary: GeographySummary | null = null;
  let owner: AbortController | null = null;
  function refresh(): void {
    owner?.abort();
    const account = host.accounts.selectedAccount;
    if (!account) {
      owner = null;
      if (summary) {
        summary = null;
        host.changed();
      }
      return;
    }
    const owned = new AbortController();
    owner = owned;
    // Until counts arrive, the panel shows no stale account's countries.
    summary = { total: 0, countries: [] };
    host.changed();
    host.accounts.countries(viewingSettings.current.hideAdult, owned.signal).then(
      (next) => {
        if (owner !== owned || owned.signal.aborted) return;
        summary = next;
        host.changed();
      },
      () => {
        // Canceled or failed: the list itself still works; country choices
        // reappear on the next account or setting change.
      },
    );
  }
  const apply = (settings: ViewingSettings) => {
    if (toggle) toggle.checked = settings.hideAdult;
    host.channels.setHideAdult(settings.hideAdult);
    refresh();
  };
  const unsubscribe = viewingSettings.subscribe(apply);
  const changed = () => {
    if (!toggle) return;
    const wanted = toggle.checked;
    viewingSettings.setHideAdult(wanted).catch((error: unknown) => {
      if (toggle) toggle.checked = viewingSettings.current.hideAdult;
      host.notice(error instanceof Error ? error.message : 'This setting could not be saved.');
    });
  };
  toggle?.addEventListener('change', changed);
  apply(viewingSettings.current);
  viewingSettings.load().catch(() => {
    // Defaults (adult hidden) stay in effect if storage cannot be read yet.
  });
  return {
    get summary(): GeographySummary | null {
      return summary;
    },
    /** Call after the paid account selection changes. */
    refresh,
    dispose(): void {
      owner?.abort();
      unsubscribe();
      toggle?.removeEventListener('change', changed);
    },
  };
}
