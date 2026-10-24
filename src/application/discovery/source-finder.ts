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
 * Page input and the website source finder. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import { createPageInput } from '../../discovery/page-input';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { mountWebsiteDiscovery } from '../../ui/website-discovery';
import { validateSource, type CatalogRecord } from '../../catalog';
import { type createScanController } from './scan-controller';

/** What this area reads from, and writes back to, the rest of the application. */
export interface SourceFinderEnvironment {
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly importRunning: boolean;
  readonly transferBusy: boolean;
  readonly catalog: CatalogRecord;
  readonly sourceScan: ReturnType<typeof createScanController>['sourceScan'];
}

export function createSourceFinder(env: SourceFinderEnvironment) {
  const pageInput = createPageInput(
    isTauri()
      ? {
          native: {
            inspect: (url, allowHttp, requestId) =>
              invoke('inspect_discovery_page', { url, allowHttp, requestId }),
            cancel: (requestId) => invoke('cancel_playlist', { requestId }),
          },
        }
      : {},
  );
  const websiteDiscovery = mountWebsiteDiscovery(env.element('source-scan-settings'), {
    inspect: (url, allowHttp, signal) => pageInput.inspect(url, allowHttp, signal),
    reviewSource: (url, label, allowHttp, signal) => {
      signal?.throwIfAborted();
      if (env.importRunning || env.transferBusy)
        throw new Error('Wait for the current import to finish.');
      const existing = env.catalog.sources.find(
        (source) => source.kind === 'url' && source.location === url,
      );
      const source = validateSource({
        id: existing?.id ?? crypto.randomUUID(),
        name: label.trim().slice(0, 512) || new URL(url).hostname,
        location: url,
        kind: 'url',
        allowHttp,
      });
      env.sourceScan.open([{ source, fingerprint: crypto.randomUUID() }]);
    },
  });
  env.element('find-sources-button').addEventListener('click', () => {
    if (env.importRunning || env.transferBusy) return;
    const initialUrl = env.element<HTMLInputElement>('playlist-url').value.trim();
    env.element<HTMLDialogElement>('import-dialog').close();
    env.element('settings-button').focus();
    websiteDiscovery.open(initialUrl);
  });
  return {
    pageInput,
    websiteDiscovery,
  };
}
