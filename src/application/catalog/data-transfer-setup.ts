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
 * Moving saved data between devices, and writing catalog changes. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import { installDataTransfer } from '../../ui/data-transfer';
import { readRecordPair, writeRecord, writeRecordPair } from '../../platform/records';
import { decodeSavedHealthInWorker } from '../health/health-history-read';
import { serializeCatalog, type CatalogRecord } from '../../catalog';
import { type createCatalogRefresh } from '../discovery/catalog-refresh';
import { type createImportController } from '../discovery/import-controller';
import { type createSharingHost } from '../sharing/sharing-host';
import { type createCatalogView } from './catalog-view';
import { type Preferences, type SerializedPreferencesStore } from '../../preferences';

/** What this area reads from, and writes back to, the rest of the application. */
export interface DataTransferSetupEnvironment {
  readonly importRunning: boolean;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  transferBusy: boolean;
  readonly setImportBusy: ReturnType<typeof createCatalogRefresh>['setImportBusy'];
  catalogWrites: Promise<unknown>;
  persistedCatalogRevision: string;
  catalog: CatalogRecord;
  readonly preferences: SerializedPreferencesStore;
  readonly withPausedGuideUpdates: ReturnType<
    typeof createImportController
  >['withPausedGuideUpdates'];
  settings: Preferences;
  catalogRevision: number;
  readonly sharingBridge: ReturnType<typeof createSharingHost>;
  readonly notice: ReturnType<typeof createCatalogView>['notice'];
  readonly applySettings: ReturnType<typeof createCatalogView>['applySettings'];
}

export function createDataTransferSetup(env: DataTransferSetupEnvironment) {
  const removeDataTransfer = installDataTransfer({
    available: () => !env.importRunning && env.element('app').dataset.ready === 'true',
    busy: (value) => {
      env.transferBusy = value;
      env.setImportBusy(value);
      for (const id of ['settings-file', 'export-button'])
        env.element<HTMLButtonElement | HTMLInputElement>(id).disabled = value;
    },
    capture: async () => {
      await env.catalogWrites;
      const saved = await readRecordPair();
      if (saved.catalogRevision !== env.persistedCatalogRevision)
        throw new Error('Saved channels changed. Reopen the app before exporting.');
      const health = (await decodeSavedHealthInWorker(saved)).health;
      return {
        format: 'genx-tv-backup',
        schemaVersion: 1,
        catalog: env.catalog,
        preferences: await env.preferences.settledSnapshot(),
        health,
      };
    },
    commit: (prepared) =>
      env.withPausedGuideUpdates(async () => {
        const work = env.catalogWrites.then(async () => {
          const healthRevision =
            prepared.healthText === undefined ? undefined : (await readRecordPair()).healthRevision;
          env.settings = await env.preferences.replaceAtomically(
            prepared.record.preferences,
            async () => {
              const receipt = await writeRecordPair({
                catalog: prepared.catalogText,
                preferences: prepared.preferencesText,
                expectedCatalogRevision: env.persistedCatalogRevision,
                ...(prepared.healthText === undefined
                  ? {}
                  : { health: prepared.healthText, expectedHealthRevision: healthRevision }),
              });
              env.persistedCatalogRevision = receipt.catalogRevision;
            },
          );
          env.catalog = prepared.record.catalog;
          env.catalogRevision++;
          await env.sharingBridge
            .stop()
            .catch(() =>
              env.notice(
                'Import saved. Playback cleanup needs attention before selecting a channel.',
              ),
            );
          env.applySettings();
        });
        env.catalogWrites = work.catch(() => undefined);
        await work;
      }),
    notice: env.notice,
  });
  function mutateCatalog(
    mutate: (previous: CatalogRecord) => CatalogRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const work = env.catalogWrites.then(async () => {
      signal?.throwIfAborted();
      const next = mutate(env.catalog);
      const contents = serializeCatalog(next);
      signal?.throwIfAborted();
      const receipt = await writeRecord('catalog', contents, signal, env.persistedCatalogRevision);
      env.persistedCatalogRevision = receipt.catalogRevision;
      env.catalog = next;
      env.catalogRevision++;
    });
    env.catalogWrites = work.catch(() => undefined);
    return work;
  }
  return {
    mutateCatalog,
    removeDataTransfer,
  };
}
