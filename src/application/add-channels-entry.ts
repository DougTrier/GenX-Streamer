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
 * The Add channels dialog: online source discovery and the file playlist
 * target. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import { createSourceIndexService } from '../discovery/source-index-service';
import { readDirectoryJson } from '../platform/source-directory';
import { createOnlineSourceScan } from '../discovery/online-source-scan';
import knownSourceDirectories from '../discovery/known-directory-ids.json';
import { type CatalogRecord } from '../catalog';

/** What this area reads from, and writes back to, the rest of the application. */
export interface AddChannelsEntryEnvironment {
  readonly applicationClosing: boolean;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly catalog: CatalogRecord;
}

export function createAddChannelsEntry(env: AddChannelsEntryEnvironment) {
  let addChannelsEntryWork: Promise<void> | null = null;
  let addChannelsEntryController: AbortController | null = null;
  const sourceIndex = createSourceIndexService({ json: readDirectoryJson });
  const onlineSourceDiscovery = createOnlineSourceScan(
    sourceIndex,
    knownSourceDirectories.repositoryIds,
    Date.now,
    (progress) => {
      if (
        env.applicationClosing ||
        document.hidden ||
        addChannelsEntryController?.signal.aborted ||
        !addChannelsEntryWork
      )
        return;
      env.element('inline-scan-status').textContent =
        `Finding sources · ${progress.checkedDirectories} of ${progress.totalDirectories} sites checked · ${progress.channelSources} channel sources found · ${Math.floor(progress.elapsedMilliseconds / 1000)}s`;
    },
  );
  async function cancelOnlineSourceEntry(): Promise<void> {
    addChannelsEntryController?.abort();
    await onlineSourceDiscovery.cancel();
    await addChannelsEntryWork;
  }
  let addChannelsEntryGeneration = 0;
  let customImportIntent = 0;
  const importDialog = env.element<HTMLDialogElement>('import-dialog');
  const fileImportTargetLabel = document.createElement('label');
  fileImportTargetLabel.hidden = true;
  fileImportTargetLabel.textContent = 'File action';
  const fileImportTarget = document.createElement('select');
  fileImportTarget.setAttribute('aria-label', 'Add or update a file playlist');
  fileImportTargetLabel.append(fileImportTarget);
  env.element('source-file-area').prepend(fileImportTargetLabel);
  function refreshFileImportTargets(): void {
    const files = env.catalog.sources.filter((source) => source.kind === 'file');
    const fileIds = new Set(files.map((source) => source.id));
    const counts = new Map<string, number>();
    if (files.length)
      for (const channel of env.catalog.channels) {
        if (fileIds.has(channel.sourceId))
          counts.set(channel.sourceId, (counts.get(channel.sourceId) ?? 0) + 1);
      }
    fileImportTarget.replaceChildren(new Option('Add a separate playlist', ''));
    for (const [index, source] of files.entries()) {
      const count = counts.get(source.id) ?? 0;
      fileImportTarget.add(
        new Option(`Update ${source.name} (${count} channels, playlist ${index + 1})`, source.id),
      );
    }
    fileImportTarget.value = '';
    fileImportTargetLabel.hidden = files.length === 0;
  }
  return {
    get addChannelsEntryController() {
      return addChannelsEntryController;
    },
    set addChannelsEntryController(value: typeof addChannelsEntryController) {
      addChannelsEntryController = value;
    },
    get addChannelsEntryGeneration() {
      return addChannelsEntryGeneration;
    },
    set addChannelsEntryGeneration(value: typeof addChannelsEntryGeneration) {
      addChannelsEntryGeneration = value;
    },
    get addChannelsEntryWork() {
      return addChannelsEntryWork;
    },
    set addChannelsEntryWork(value: typeof addChannelsEntryWork) {
      addChannelsEntryWork = value;
    },
    cancelOnlineSourceEntry,
    get customImportIntent() {
      return customImportIntent;
    },
    set customImportIntent(value: typeof customImportIntent) {
      customImportIntent = value;
    },
    fileImportTarget,
    importDialog,
    onlineSourceDiscovery,
    refreshFileImportTargets,
    sourceIndex,
  };
}
