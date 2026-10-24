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
 * The guide rows beside the channel list: which channels they cover, loading
 * them for the visible rows, and keeping them in step with the catalog and
 * the foreground. Moved out of main.ts.
 */
import { createVisibleGuideOwner, type VisibleGuideScope } from './visible-guide';
import { readVisibleGuide } from '../guide/visible-native';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { type mountGuide } from '../ui/guide';
import { type createVisibleGuideState } from './visible-guide-state';
import { type ChannelBrowser } from '../ui/channel-browser';
import { type CatalogRecord } from '../catalog';
import { type Preferences } from '../preferences';

/** What this area reads from, and writes back to, the rest of the application. */
export interface VisibleGuideEnvironment {
  readonly nativeViewingForeground: boolean;
  readonly applicationClosing: boolean;
  readonly browser: ChannelBrowser;
  readonly guide: ReturnType<typeof mountGuide>;
  readonly visibleGuideState: ReturnType<typeof createVisibleGuideState>;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly persistedCatalogRevision: string;
  readonly catalog: CatalogRecord;
  readonly settings: Preferences;
}

export function createVisibleGuideController(env: VisibleGuideEnvironment) {
  function updateGuideForeground(): void {
    const foreground = env.nativeViewingForeground && !document.hidden && !env.applicationClosing;
    env.browser.setGuideForeground(foreground);
    void env.guide.setForeground(foreground).catch(() => undefined);
    void env.visibleGuideState.visibleGuide?.setForeground(foreground).catch(() => undefined);
  }
  env.visibleGuideState.visibleGuide = createVisibleGuideOwner({
    fetch: readVisibleGuide,
    cancel: (requestId) => invoke('cancel_playlist', { requestId }),
    available: () =>
      isTauri() && env.element('app').dataset.ready === 'true' && !env.applicationClosing,
    isCurrent: (scope) =>
      scope.generation === env.visibleGuideState.visibleGuideGeneration &&
      scope.catalogRevision === env.persistedCatalogRevision &&
      !env.applicationClosing &&
      env.element('app').dataset.ready === 'true',
  });
  env.visibleGuideState.visibleGuide.subscribe((snapshot) => {
    if (snapshot.status === 'idle') {
      env.browser.setGuideRows([]);
      return;
    }
    const summary = snapshot.summary;
    const status = snapshot.status;
    env.browser.setGuideRows(
      env.visibleGuideState.visibleGuideRequestedRows.map((row, index) => ({
        ...row,
        status,
        summary: summary?.rows[index] ?? null,
      })),
    );
  });
  function updateVisibleGuide(): void {
    if (!env.visibleGuideState.visibleGuide) return;
    const ready =
      env.element('app').dataset.ready === 'true' &&
      !env.applicationClosing &&
      env.element('channel-list').getClientRects().length > 0;
    if (
      env.visibleGuideState.visibleGuideCatalog !== env.catalog ||
      env.visibleGuideState.visibleGuideRemoved !== env.settings.removedChannels
    ) {
      env.visibleGuideState.visibleGuideCatalog = env.catalog;
      env.visibleGuideState.visibleGuideRemoved = env.settings.removedChannels;
      const removed = new Set(env.settings.removedChannels);
      env.visibleGuideState.visibleGuideIdentities = new Set(
        env.catalog.channels
          .filter((channel) => !removed.has(channel.id))
          .map((channel) => JSON.stringify([channel.sourceId, channel.id])),
      );
    }
    const rows = ready
      ? env.visibleGuideState.visibleGuideRows.filter((row) =>
          env.visibleGuideState.visibleGuideIdentities.has(
            JSON.stringify([row.catalogSourceId, row.appChannelId]),
          ),
        )
      : [];
    const key = rows.length ? JSON.stringify([env.persistedCatalogRevision, rows]) : null;
    if (key === env.visibleGuideState.visibleGuideKey) return;
    env.visibleGuideState.visibleGuideKey = key;
    env.visibleGuideState.visibleGuideGeneration++;
    env.visibleGuideState.visibleGuideRequestedRows = rows;
    const scope: VisibleGuideScope | null =
      rows.length > 0 && rows.length <= 64
        ? {
            channels: rows,
            catalogRevision: env.persistedCatalogRevision,
            generation: env.visibleGuideState.visibleGuideGeneration,
          }
        : null;
    void env.visibleGuideState.visibleGuide.setScope(scope).catch(() => undefined);
    if (rows.length > 64)
      env.browser.setGuideRows(rows.map((row) => ({ ...row, status: 'capacity', summary: null })));
  }
  return {
    updateVisibleGuide,
    updateGuideForeground,
  };
}
