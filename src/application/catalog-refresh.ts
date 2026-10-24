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
 * Refreshing saved sources: the refresh service and the import buttons'
 * busy state. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import {
  CatalogRefreshService,
  mergeInspectedSource,
  type CatalogRecord,
  type Source,
} from '../catalog';
import { inspectSource } from '../platform/records';
import { type createCatalogView } from './catalog-view';
import { type createImportController } from './import-controller';
import { type createScanController } from './scan-controller';
import { type createAddChannelsEntry } from './add-channels-entry';

/** What this area reads from, and writes back to, the rest of the application. */
export interface CatalogRefreshEnvironment {
  readonly catalog: CatalogRecord;
  readonly activeSources: Map<string, Source>;
  readonly mutateCatalog: (
    mutate: (previous: CatalogRecord) => CatalogRecord,
    signal?: AbortSignal,
  ) => Promise<void>;
  importRunning: boolean;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly renderCatalog: ReturnType<typeof createCatalogView>['renderCatalog'];
  readonly wakeDailyRefresh: ReturnType<typeof createImportController>['wakeDailyRefresh'];
  readonly scanController: ReturnType<typeof createScanController>;
  readonly transferBusy: boolean;
  readonly addChannelsEntry: ReturnType<typeof createAddChannelsEntry>;
}

export function createCatalogRefresh(env: CatalogRefreshEnvironment) {
  const refresh = new CatalogRefreshService(
    {
      read: async (sourceId) =>
        env.catalog.channels.filter((channel) => channel.sourceId === sourceId),
      commit: async (sourceId, channels, signal, stagedSource) => {
        const source = env.activeSources.get(sourceId);
        if (!source || source.id !== sourceId || stagedSource.id !== sourceId)
          throw new Error('Import source changed. Try again.');
        await env.mutateCatalog((previous) => {
          const currentSource = previous.sources.find((item) => item.id === sourceId);
          const publishedSource = mergeInspectedSource(currentSource, stagedSource);
          return {
            schemaVersion: 1,
            sources: [...previous.sources.filter((item) => item.id !== sourceId), publishedSource],
            channels: [
              ...previous.channels.filter((item) => item.sourceId !== sourceId),
              ...channels,
            ],
          };
        }, signal);
      },
    },
    async (source, signal) => {
      const result = await inspectSource(source.location, source.allowHttp ?? false, signal);
      if (result.kind === 'unsupported')
        throw new Error(
          'This source format is not supported. Choose a channel catalog or supported media source.',
        );
      source.contentKind = result.kind;
      source.mediaMime = result.mime;
      if (result.kind === 'catalog' && result.text !== undefined) return result.text;
      return `#EXTM3U\n#EXTINF:-1 tvg-id="direct" group-title="Custom",${source.name.replace(/[\r\n]/g, ' ')}\n${source.location}\n`;
    },
  );
  function setImportBusy(busy: boolean): void {
    env.importRunning = busy;
    for (const id of ['load-button', 'find-sources-button'])
      env.element<HTMLButtonElement>(id).disabled = busy;
    updateImportActions();
    env.element<HTMLInputElement>('playlist-file').disabled = busy;
    env.element('cancel-import').hidden = !busy;
    env.renderCatalog();
    if (!busy) queueMicrotask(env.wakeDailyRefresh);
  }
  function updateImportActions(): void {
    // Reopening the existing scan does not admit another import or writer.
    const disabled = env.importRunning && !env.scanController.automaticScanActive;
    env.element<HTMLButtonElement>('import-button').disabled =
      env.importRunning ||
      env.transferBusy ||
      env.scanController.automaticScanActive ||
      !!env.addChannelsEntry.addChannelsEntryWork;
    env.element<HTMLButtonElement>('export-channels-button').disabled =
      env.importRunning ||
      env.transferBusy ||
      env.scanController.automaticScanActive ||
      !!env.addChannelsEntry.addChannelsEntryWork;
    env.element<HTMLButtonElement>('automatic-scan-button').disabled = disabled;
    env.element<HTMLButtonElement>('rescan-automatic-button').disabled = disabled;
  }
  async function refreshSource(source: Source, text?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    env.activeSources.set(source.id, source);
    const cancel = () => refresh.cancel(source.id);
    const work = refresh.refresh(source, text);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await work;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (env.activeSources.get(source.id) === source) env.activeSources.delete(source.id);
    }
  }
  return {
    refresh,
    refreshSource,
    setImportBusy,
    updateImportActions,
  };
}
