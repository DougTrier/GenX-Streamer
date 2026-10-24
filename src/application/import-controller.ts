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
 * Adding and refreshing channels: the Add channels dialog and its file and
 * online-source entries, the first scan from the channel list, playlist
 * import and export, Refresh, the daily source refresh and the daily guide
 * refresh. Moved out of main.ts; main.ts passes the shared state it owns
 * through the environment.
 */
import { installConfiguredImportEntry } from '../ui/import-entry';
import { emptyOnlineDiscoveryText } from '../ui/online-discovery-text';
import { readUnavailableSources } from '../discovery/unavailable-sources';
import { prepareDiscoveredSources } from './discovered-source-configuration';
import { BoundedScanEntryRefusal, type createScanController } from './scan-controller';
import { installGuideGrabberExport } from '../ui/guide-grabber-settings';
import { exportPlaylistInWorker } from '../catalog/playlist-export-service';
import { savePlaylistExport } from '../platform/playlist-file';
import { type ScanSource } from '../discovery/scan';
import { validateSource, type CatalogRecord, type Source } from '../catalog';
import { createFileImportSource } from './file-import-identity';
import { collectSources } from '../catalog/collector';
import { DailyRefreshAttemptNotStartedError, createDailyRefresh } from '../catalog/daily-refresh';
import { migrateRefreshCadence } from '../catalog/refresh-cadence';
import { createDailyGuideRefresh } from '../guide/daily-refresh';
import { isTauri } from '@tauri-apps/api/core';
import { readDailyGuidePlan, refreshDailyGuide } from '../guide/native';
import { mountAutomaticGuideUpdates } from '../ui/automatic-guide-updates';
import { joinGuideWork } from './join-guide-work';
import { type createRendererRecoveryPolicy } from './renderer-recovery-policy';
import { type createOnlineSourceScan } from '../discovery/online-source-scan';
import { type createChannelHealthController } from './channel-health-controller';
import { type createGuideController } from './guide-controller';
import { type mountGuide } from '../ui/guide';
import { type createBootstrapBoundary } from './bootstrap-boundary';
import { type createDiagnostics } from '../diagnostics/native';
import { type ContentLibrary } from './content-library';
import { type Preferences, type SerializedPreferencesStore } from '../preferences';
import { type createVisibleGuideOwner } from './visible-guide';

import type { RefreshResult } from '../catalog';
import type { PrimaryPage } from './primary-page';

/** What this area reads from, and writes back to, the rest of the application. */
export interface ImportEnvironment {
  readonly fileImportTarget: HTMLSelectElement;
  readonly catalog: CatalogRecord;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly importDialog: HTMLDialogElement;
  addChannelsEntryGeneration: number;
  readonly applicationClosing: boolean;
  readonly importRunning: boolean;
  readonly transferBusy: boolean;
  readonly scanController: ReturnType<typeof createScanController>;
  addChannelsEntryWork: Promise<void> | null;
  readonly backgroundSuspension: Promise<void> | null;
  readonly nativeViewingForeground: boolean;
  readonly foregroundGeneration: number;
  readonly scanProviderSources: ReturnType<typeof createScanController>['scanProviderSources'];
  readonly supportsBoundedResume: ReturnType<typeof createScanController>['supportsBoundedResume'];
  readonly ownImport: (work: Promise<void>) => Promise<void>;
  readonly playbackAction: (work: Promise<unknown>) => void;
  readonly refreshFileImportTargets: () => void;
  readonly rendererRecoveryPolicy: ReturnType<typeof createRendererRecoveryPolicy>;
  readonly sourceScan: ReturnType<typeof createScanController>['sourceScan'];
  readonly contentLibrary: ContentLibrary;
  readonly primaryPage: PrimaryPage;
  addChannelsEntryController: AbortController | null;
  settings: Preferences;
  readonly prepareInlineScanEntry: ReturnType<
    typeof createScanController
  >['prepareInlineScanEntry'];
  readonly inlineScanPanel: ReturnType<typeof createScanController>['inlineScanPanel'];
  readonly onlineSourceDiscovery: ReturnType<typeof createOnlineSourceScan>;
  readonly notice: (message: string) => void;
  readonly saveSettings: (
    mutate: (draft: Preferences) => void,
    guard?: () => Promise<boolean>,
    allowDuringScan?: boolean,
  ) => Promise<boolean>;
  readonly updateImportActions: () => void;
  readonly cancelOnlineSourceEntry: () => Promise<void>;
  readonly refreshFreeTv: ReturnType<typeof createChannelHealthController>['refreshFreeTv'];
  readonly catalogWrites: Promise<unknown>;
  customImportIntent: number;
  readonly friendlyError: (error: unknown) => string;
  collectionAbort: AbortController | null;
  readonly setImportBusy: (busy: boolean) => void;
  readonly refreshSource: (
    source: Source,
    text?: string,
    signal?: AbortSignal,
  ) => Promise<RefreshResult>;
  readonly preferences: SerializedPreferencesStore;
  readonly applySettings: () => void;
  readonly renderCatalog: () => void;
  readonly guideController: ReturnType<typeof createGuideController>;
  readonly visibleGuide: ReturnType<typeof createVisibleGuideOwner> | null;
  readonly guide: ReturnType<typeof mountGuide>;
  readonly bootstrapBoundary: ReturnType<typeof createBootstrapBoundary>;
  readonly automaticGuides: ReturnType<typeof createGuideController>['automaticGuides'];
  readonly diagnostics: ReturnType<typeof createDiagnostics>;
}

export function createImportController(env: ImportEnvironment) {
  env.fileImportTarget.addEventListener('change', () => {
    const selected = env.catalog.sources.find(
      (source) => source.id === env.fileImportTarget.value && source.kind === 'file',
    );
    env.element<HTMLInputElement>('allow-http').checked = selected?.allowHttp === true;
  });
  env.importDialog.addEventListener('close', () => {
    env.addChannelsEntryGeneration++;
  });
  const configuredImportEntry = installConfiguredImportEntry({
    root: document,
    allowed: () =>
      !env.applicationClosing &&
      !env.importRunning &&
      !env.transferBusy &&
      !env.scanController.automaticScanActive &&
      !env.addChannelsEntryWork &&
      !env.backgroundSuspension &&
      env.nativeViewingForeground,
    foreground: () => env.foregroundGeneration,
    configured: () =>
      env.scanController.indexedFreshAvailable && !!env.scanProviderSources().length,
    capability: () => env.supportsBoundedResume(new AbortController().signal),
    own: env.ownImport,
    run: env.playbackAction,
    refreshFiles: env.refreshFileImportTargets,
    start: () => {
      env.rendererRecoveryPolicy.authorize('scan');
      env.sourceScan.startAutomatic(undefined, {
        presentation:
          env.contentLibrary === 'live' &&
          env.primaryPage === 'watch' &&
          !env.element('app').classList.contains('keyboard-open') &&
          env.element('channel-list').getClientRects().length > 0
            ? 'inline'
            : 'dialog',
      });
    },
  });
  function startInlineDiscovery(rescan = false): void {
    if (
      env.applicationClosing ||
      env.contentLibrary !== 'live' ||
      document.hidden ||
      !env.nativeViewingForeground ||
      env.addChannelsEntryWork ||
      ((env.importRunning || env.transferBusy) && !env.scanController.automaticScanActive)
    )
      return;
    env.rendererRecoveryPolicy.authorize('scan');
    const capturedQuery = env
      .element<HTMLInputElement>('search')
      .value.normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' ');
    const generation = ++env.addChannelsEntryGeneration;
    const controller = new AbortController();
    env.addChannelsEntryController = controller;
    const capturedRegion = env.settings.preferredRegion
      ? structuredClone(env.settings.preferredRegion)
      : undefined;
    const configuredSourceIdentity = () =>
      JSON.stringify([
        env.catalog.sources,
        env.settings.reviewedChannelProviders,
        env.settings.preferredRegion,
      ]);
    const capturedSourceIdentity = configuredSourceIdentity();
    const admitted = () =>
      env.contentLibrary === 'live' &&
      !env.applicationClosing &&
      !document.hidden &&
      env.nativeViewingForeground &&
      !controller.signal.aborted &&
      generation === env.addChannelsEntryGeneration;
    const searchAction = env.element<HTMLButtonElement>('search-programs');
    searchAction.disabled = true;
    const pending = env
      .prepareInlineScanEntry(controller.signal)
      .then(async (state) => {
        if (!admitted()) return;
        const options = { query: capturedQuery, presentation: 'inline' as const };
        if (env.scanController.indexedFreshAvailable) {
          if (state === 'unavailable')
            throw new Error('Saved scan ownership must be recovered before refreshing sources.');
          if (state === 'unfinished' && !rescan) {
            // A different query is refused with Continue/Rescan, never silently continued.
            env.sourceScan.startAutomatic(undefined, {
              ...(capturedQuery ? { query: capturedQuery } : {}),
              presentation: 'inline',
              intent: 'continue',
            });
            return;
          }
          if (state === 'running') {
            env.sourceScan.startAutomatic(undefined, { presentation: 'inline' });
            return;
          }
          // This explicit online search uses the same discovered-source permission
          // pipeline below before native indexing. Refresh uses configured sources.
        }
        if (!rescan && state === 'running')
          env.sourceScan.startAutomatic(undefined, { presentation: 'inline' });
        else if (
          !env.scanController.indexedFreshAvailable &&
          !rescan &&
          (state === 'unavailable' ||
            (!capturedQuery &&
              (state === 'completed' || (state === 'fresh' && env.catalog.channels.length > 0))))
        ) {
          // Revealing saved channels is not authorization to replace a finished/lost scan.
          env.inlineScanPanel.reveal();
          env.element('inline-scan-status').textContent =
            state === 'completed'
              ? 'Your previous scan is finished. Select Refresh to look for new channels and remove dead ones, or Rescan to check everything again.'
              : state === 'unavailable'
                ? 'Your saved channels are retained. Previous scan progress cannot resume. Select Rescan to check all sources again.'
                : 'Saved channels are ready. Select Rescan to check all sources again.';
          env.element('inline-scan-error').textContent = '';
          env.element('inline-scan-error').hidden = true;
          env.element('inline-scan-stop').hidden = true;
          env.element('inline-scan-continue').hidden = true;
          const rescanAction = env.element<HTMLButtonElement>('inline-scan-rescan');
          rescanAction.hidden = false;
          rescanAction.disabled = false;
        } else if (!rescan && state === 'unfinished') {
          // Offer Finish scan / Rescan / Close rather than resuming on its own.
          if (!capturedQuery && env.inlineScanPanel.reopen()) return;
          env.sourceScan.startAutomatic(undefined, {
            ...(capturedQuery ? { query: capturedQuery } : {}),
            presentation: 'inline',
            intent: 'continue',
          });
        } else {
          env.inlineScanPanel.reveal(true);
          env.element('inline-scan-status').textContent = capturedQuery
            ? `Finding “${capturedQuery}” online…`
            : 'Finding public channel sources online…';
          env.element('inline-scan-error').hidden = true;
          env.element('inline-scan-stop').hidden = false;
          env.element<HTMLButtonElement>('inline-scan-stop').disabled = false;
          env.element('inline-scan-continue').hidden = true;
          env.element('inline-scan-rescan').hidden = true;
          const discovered = await env.onlineSourceDiscovery.start(
            { query: capturedQuery, ...(capturedRegion ? { region: capturedRegion } : {}) },
            controller.signal,
          );
          if (!admitted()) return;
          if (configuredSourceIdentity() !== capturedSourceIdentity)
            throw new Error('Configured sources changed during discovery.');
          if (!discovered.channels.length) {
            if (env.scanProviderSources().length > 0) {
              env.notice('No new online sources were found. Checking your configured sources.');
              if (rescan || (!env.scanController.indexedFreshAvailable && state === 'completed'))
                env.sourceScan.rescanAutomatic(undefined, options);
              else env.sourceScan.startAutomatic(undefined, options);
              return;
            }
            env.element('inline-scan-status').textContent = emptyOnlineDiscoveryText(discovered);
            env.element('inline-scan-stop').hidden = true;
            env.element('inline-scan-rescan').hidden = false;
            return;
          }
          // Known-dead links are skipped and pruned; saved catalog sources are never pruned.
          const dead = {
            unavailable: await readUnavailableSources(),
            keep: new Set(env.catalog.sources.map((source) => source.location)),
          };
          const preparedRegistry = prepareDiscoveredSources(
            env.settings,
            discovered,
            () => crypto.randomUUID(),
            dead,
          );
          const registryUnchanged =
            JSON.stringify([
              env.settings.reviewedChannelProviders,
              env.settings.reviewedGuideProviders,
            ]) ===
            JSON.stringify([
              preparedRegistry.preferences.reviewedChannelProviders,
              preparedRegistry.preferences.reviewedGuideProviders,
            ]);
          const saved =
            registryUnchanged ||
            (await env.saveSettings(
              (draft) => {
                const prepared = prepareDiscoveredSources(
                  draft,
                  discovered,
                  () => crypto.randomUUID(),
                  dead,
                );
                draft.reviewedChannelProviders = prepared.preferences.reviewedChannelProviders;
                draft.reviewedGuideProviders = prepared.preferences.reviewedGuideProviders;
              },
              async () =>
                admitted() &&
                configuredSourceIdentity() === capturedSourceIdentity &&
                JSON.stringify(env.settings.preferredRegion) === JSON.stringify(capturedRegion),
            ));
          if (!saved || !admitted()) {
            if (!saved && admitted()) throw new Error('Discovered sources could not be saved.');
            return;
          }
          if (rescan || (!env.scanController.indexedFreshAvailable && state === 'completed'))
            env.sourceScan.rescanAutomatic(undefined, options);
          else env.sourceScan.startAutomatic(undefined, options);
        }
      })
      .catch((failure: unknown) => {
        if (admitted()) {
          env.inlineScanPanel.reveal();
          env.element('inline-scan-status').textContent =
            failure instanceof BoundedScanEntryRefusal
              ? 'Saved scan progress could not be checked. Your saved channels are retained. Select Rescan to try again.'
              : 'Online source discovery could not finish. Your saved channels are retained. Select Rescan to try again.';
          if (failure instanceof BoundedScanEntryRefusal) {
            env.element('inline-scan-error').textContent =
              'Saved scan admission is unavailable. No channels were changed.';
            env.element('inline-scan-error').hidden = false;
          }
          env.element('inline-scan-stop').hidden = true;
          env.element('inline-scan-continue').hidden = true;
          env.element('inline-scan-rescan').hidden = false;
        } else if (
          !env.applicationClosing &&
          !document.hidden &&
          generation === env.addChannelsEntryGeneration
        ) {
          env.element('inline-scan-status').textContent =
            'Online discovery stopped. Your saved channels are retained.';
          env.element('inline-scan-stop').hidden = true;
          env.element('inline-scan-rescan').hidden = false;
        }
      })
      .finally(() => {
        if (env.addChannelsEntryWork === pending) env.addChannelsEntryWork = null;
        if (env.addChannelsEntryController === controller) env.addChannelsEntryController = null;
        searchAction.disabled = env.applicationClosing;
        env.updateImportActions();
      });
    env.addChannelsEntryWork = pending;
    env.updateImportActions();
  }
  env.element('inline-scan-stop').addEventListener('click', () => {
    if (env.applicationClosing) return;
    const button = env.element<HTMLButtonElement>('inline-scan-stop');
    button.disabled = true;
    env.playbackAction(
      Promise.all([env.cancelOnlineSourceEntry(), env.sourceScan.stopAutomatic()]).finally(() => {
        button.disabled = env.applicationClosing;
      }),
    );
  });
  env.element('inline-scan-continue').addEventListener('click', () => {
    if (env.applicationClosing || env.addChannelsEntryWork) return;
    env.playbackAction(env.sourceScan.continueAutomatic({ presentation: 'inline' }));
  });
  env.element('inline-scan-rescan').addEventListener('click', () => startInlineDiscovery(true));
  env
    .element('inline-scan-refresh')
    .addEventListener('click', () => env.playbackAction(env.refreshFreeTv()));
  installGuideGrabberExport(document);
  let playlistExportWork: Promise<void> | null = null;
  let playlistExportController: AbortController | null = null;
  env.element('export-channels-button').addEventListener('click', () => {
    if (
      env.applicationClosing ||
      playlistExportWork ||
      env.importRunning ||
      env.transferBusy ||
      env.scanController.automaticScanActive ||
      env.addChannelsEntryWork
    )
      return;
    const controller = new AbortController();
    playlistExportController = controller;
    const button = env.element<HTMLButtonElement>('export-channels-button');
    const status = env.element('channel-transfer-status');
    button.disabled = true;
    status.textContent = 'Preparing your channel list…';
    const work = (async () => {
      try {
        await env.catalogWrites;
        controller.signal.throwIfAborted();
        const removed = new Set(env.settings.removedChannels);
        const result = await exportPlaylistInWorker(
          {
            channels: env.catalog.channels.filter((channel) => !removed.has(channel.id)),
            sources: env.catalog.sources,
          },
          controller.signal,
        );
        controller.signal.throwIfAborted();
        if (!env.applicationClosing) status.textContent = 'Choose where to save your playlist.';
        const receipt = await savePlaylistExport(result, controller.signal);
        if (!env.applicationClosing)
          status.textContent =
            receipt.status === 'saved'
              ? `${result.channelCount} channels exported to ${receipt.filename}.`
              : receipt.status === 'download-started'
                ? `${result.channelCount} channels prepared. Your browser started the download.`
                : 'Export canceled. Your saved channels are unchanged.';
      } catch {
        if (!env.applicationClosing && !controller.signal.aborted)
          status.textContent =
            'The channel list could not be exported. Your saved channels are unchanged.';
      } finally {
        if (playlistExportController === controller) playlistExportController = null;

        button.disabled =
          env.applicationClosing ||
          env.importRunning ||
          env.transferBusy ||
          env.scanController.automaticScanActive;
      }
    })().finally(() => {
      if (playlistExportWork === work) playlistExportWork = null;
    });
    playlistExportWork = work;
  });
  env.element('rescan-automatic-button').addEventListener('click', () => {
    if (env.applicationClosing || env.importRunning || env.transferBusy || env.addChannelsEntryWork)
      return;
    env.importDialog.close();
    env.playbackAction(
      (async () => {
        await env.supportsBoundedResume(new AbortController().signal);
        if (!env.applicationClosing && !env.backgroundSuspension) {
          env.rendererRecoveryPolicy.authorize('scan');
          env.sourceScan.rescanAutomatic();
        }
      })(),
    );
  });
  env
    .element('settings-button')
    .addEventListener('click', () => env.element<HTMLDialogElement>('settings-dialog').showModal());
  env.element('import-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (env.importRunning || env.transferBusy || env.applicationClosing) return;
    const location = env.element<HTMLInputElement>('playlist-url').value.trim();
    const allowHttp = env.element<HTMLInputElement>('allow-http').checked;
    const generation = env.addChannelsEntryGeneration;
    const intent = ++env.customImportIntent;
    env.playbackAction(
      env.ownImport(
        (async () => {
          try {
            await env.addChannelsEntryWork;
            if (
              !env.importDialog.open ||
              generation !== env.addChannelsEntryGeneration ||
              intent !== env.customImportIntent ||
              env.importRunning ||
              env.transferBusy ||
              env.applicationClosing ||
              env.backgroundSuspension
            )
              return;
            let drafts: ScanSource[] | undefined;
            if (location) {
              const url = new URL(location);
              const existing = env.catalog.sources.find(
                (source) => source.kind === 'url' && source.location === url.href,
              );
              const source = validateSource({
                id: existing?.id ?? crypto.randomUUID(),
                name: url.hostname,
                location: url.href,
                kind: 'url',
                allowHttp,
              });
              drafts = [{ source, fingerprint: crypto.randomUUID() }];
            }
            env.element<HTMLDialogElement>('import-dialog').close();
            env.sourceScan.start(drafts);
          } catch {
            if (
              !env.importDialog.open ||
              generation !== env.addChannelsEntryGeneration ||
              intent !== env.customImportIntent
            )
              return;
            env.element('import-status').textContent =
              'Enter a complete HTTP or HTTPS source URL and allow HTTP if needed.';
          }
        })(),
      ),
    );
  });
  async function importPlaylistFile(): Promise<void> {
    const file = env.element<HTMLInputElement>('playlist-file').files?.[0];
    if (!file) return;
    const allowHttp = env.element<HTMLInputElement>('allow-http').checked;
    const generation = env.addChannelsEntryGeneration;
    const intent = ++env.customImportIntent;
    const targetId = env.fileImportTarget.value;
    try {
      await env.addChannelsEntryWork;
      if (
        !env.importDialog.open ||
        generation !== env.addChannelsEntryGeneration ||
        intent !== env.customImportIntent
      )
        return;
      if (
        env.importRunning ||
        env.transferBusy ||
        env.applicationClosing ||
        env.backgroundSuspension
      )
        return;
      const existing = targetId
        ? env.catalog.sources.find((source) => source.id === targetId && source.kind === 'file')
        : undefined;
      if (targetId && !existing)
        throw new Error('The selected playlist was removed. Choose it again.');
      env.element<HTMLDialogElement>('import-dialog').close();
      await env.sourceScan.reviewFile(createFileImportSource(file.name, allowHttp, existing), file);
    } catch (error) {
      if (
        env.importDialog.open &&
        generation === env.addChannelsEntryGeneration &&
        intent === env.customImportIntent
      )
        env.element('import-status').textContent = env.friendlyError(error);
    } finally {
      if (intent === env.customImportIntent)
        env.element<HTMLInputElement>('playlist-file').value = '';
    }
  }
  env.element('playlist-file').addEventListener('change', () => {
    env.playbackAction(env.ownImport(importPlaylistFile()));
  });
  env.element('cancel-import').addEventListener('click', () => {
    if (env.collectionAbort) env.collectionAbort.abort();
    env.element('import-status').textContent = 'Canceling…';
  });
  async function refreshAllSources(quiet = false, signal?: AbortSignal): Promise<void> {
    if (env.importRunning || env.transferBusy || env.applicationClosing) return;
    signal?.throwIfAborted();
    if (await env.supportsBoundedResume(signal ?? new AbortController().signal)) {
      const cancel = () => {
        void env.sourceScan.stopAutomatic().catch(() => undefined);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        signal?.throwIfAborted();
        const state = await env.prepareInlineScanEntry(signal ?? new AbortController().signal);
        if (state === 'unavailable')
          throw new Error('Saved scan ownership must be recovered before refreshing sources.');
        if (state === 'unfinished')
          await env.sourceScan.continueAutomatic({ presentation: 'inline' });
        else
          await env.sourceScan.refreshAutomatic(undefined, { query: '', presentation: 'inline' });
      } finally {
        signal?.removeEventListener('abort', cancel);
        if (signal?.aborted) await env.sourceScan.stopAutomatic();
      }
      return;
    }
    if (!quiet) env.element<HTMLDialogElement>('import-dialog').showModal();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const warnings: string[] = [];
    env.collectionAbort = controller;
    env.setImportBusy(true);
    try {
      const outcomes = await collectSources(
        [...env.catalog.sources].filter((item) => item.kind === 'url'),
        async (source, signal) => {
          const result = await env.refreshSource(source, undefined, signal);
          warnings.push(...(result.warnings ?? []));
          return result.status === 'completed'
            ? { status: 'completed', value: result.channels?.length ?? 0, published: true }
            : { status: 'canceled' };
        },
        controller.signal,
        (progress) => {
          env.element(quiet ? 'source-refresh-status' : 'import-status').textContent =
            `Collected ${progress.settled} of ${progress.total} sources…`;
        },
      );
      env.settings = await env.preferences.update((draft) => {
        draft.sources = [...env.catalog.sources];
      });
      env.applySettings();
      const completed = outcomes.filter((item) => item.status === 'completed').length;
      const failed = outcomes.filter((item) => item.status === 'failed').length;
      const summary = `${completed} sources refreshed${failed ? `; ${failed} failed and retained their saved channels` : ''}${controller.signal.aborted ? '; remaining collection canceled' : ''}.`;
      const message = [summary, ...warnings].join(' ');
      env.element('source-refresh-status').textContent = message;
      if (!quiet) {
        env.element('import-status').textContent = message;
        if (!failed && !controller.signal.aborted) {
          env.element<HTMLDialogElement>('import-dialog').close();
          env.notice(message);
        }
      }
    } catch (error) {
      env.element(quiet ? 'source-refresh-status' : 'import-status').textContent =
        env.friendlyError(error);
    } finally {
      signal?.removeEventListener('abort', cancel);
      env.collectionAbort = null;
      env.setImportBusy(false);
      env.renderCatalog();
    }
  }
  const dailyRefresh = createDailyRefresh({
    cadence: () =>
      migrateRefreshCadence(env.settings.sourceRefreshCadence, env.settings.automaticSourceRefresh),
    canRun: () =>
      env.rendererRecoveryPolicy.allowAutomaticWork() &&
      env.settings.automaticSourceRefresh &&
      env.element('app').dataset.ready === 'true' &&
      !document.hidden &&
      env.nativeViewingForeground &&
      !env.backgroundSuspension &&
      !env.applicationClosing &&
      !env.importRunning &&
      !env.transferBusy &&
      !env.scanController.automaticScanActive &&
      // A refresh would invalidate a paused scan's saved checks.
      !env.scanController.pausedScanResumable &&
      !document.querySelector('dialog[open]') &&
      env.catalog.sources.some((source) => source.kind === 'url'),
    lastAttemptAt: () => env.settings.sourceRefreshAttemptAt,
    persistAttempt: async (time, signal) => {
      env.settings = await env.preferences.update(
        (draft) => {
          draft.sourceRefreshAttemptAt = time;
        },
        async () => {
          if (signal.aborted || env.applicationClosing)
            throw new DailyRefreshAttemptNotStartedError();
          return true;
        },
      );
    },
    run: (signal) => env.ownImport(refreshAllSources(true, signal)),
    onError: () => {
      env.element('source-refresh-status').textContent =
        'Automatic update could not finish. Your saved channels remain available. Use Refresh to retry.';
    },
  });
  const dailyGuideRefresh = createDailyGuideRefresh({
    canRun: () =>
      env.rendererRecoveryPolicy.allowAutomaticWork() &&
      isTauri() &&
      env.settings.automaticGuideUpdates !== false &&
      !env.guideController.automaticGuideControlPending &&
      env.element('app').dataset.ready === 'true' &&
      !document.hidden &&
      env.nativeViewingForeground &&
      !env.backgroundSuspension &&
      !env.applicationClosing &&
      !env.importRunning &&
      !env.transferBusy &&
      !document.querySelector('dialog[open]'),
    plan: async (signal) => {
      const result = await readDailyGuidePlan(signal);
      const localNow = Date.now();
      return result.sources.map((entry) => ({
        ...entry,
        nextDueMs: localNow + Math.max(0, entry.nextDueMs - result.nowMs),
      }));
    },
    refresh: refreshDailyGuide,
    onChanged: () => {
      void env.visibleGuide?.refresh().catch(() => undefined);
      env.guide.catalogChanged(true);
      requestCachedGuideConnection();
    },
    onError: () => {
      env.element('source-refresh-status').textContent =
        'A program guide could not update. Its previous schedule remains available. Retry from Guide.';
    },
  });
  const automaticGuideUpdates = env.bootstrapBoundary.run('settings', () =>
    mountAutomaticGuideUpdates(env.element<HTMLDialogElement>('settings-dialog'), {
      automaticGuideUpdates: env.settings.automaticGuideUpdates,
      save: (value) =>
        withPausedGuideUpdates(async () => {
          if (
            !(await env.saveSettings((draft) => {
              draft.automaticGuideUpdates = value;
            }))
          )
            throw new Error('Program guide settings could not be saved.');
          if (value) env.rendererRecoveryPolicy.authorize('update-settings');
        }),
    }),
  );
  async function withPausedGuideUpdates<T>(operation: () => Promise<T>): Promise<T> {
    env.guideController.automaticGuideControlPending++;
    try {
      await joinGuideWork([env.automaticGuides, dailyGuideRefresh]);
      return await operation();
    } finally {
      env.guideController.automaticGuideControlPending--;
      if (!env.guideController.automaticGuideControlPending && !env.applicationClosing)
        wakeDailyRefresh();
    }
  }
  function requestCachedGuideConnection(): void {
    void env.automaticGuides.requestCached().catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      void env.diagnostics.emit({ operation: 'guide', level: 'warning', code: 'guide-failed' });
    });
  }
  function wakeDailyRefresh(): void {
    void dailyGuideRefresh.wake().catch(() => {
      env.element('source-refresh-status').textContent =
        'The program guide update could not finish. Retry from Guide.';
    });
    void dailyRefresh.wake().catch(() => {
      env.element('source-refresh-status').textContent =
        'Automatic update could not finish. Your saved channels remain available. Use Refresh to retry.';
    });
  }
  return {
    withPausedGuideUpdates,
    wakeDailyRefresh,
    get playlistExportWork() {
      return playlistExportWork;
    },
    automaticGuideUpdates,
    startInlineDiscovery,
    dailyRefresh,
    dailyGuideRefresh,
    refreshAllSources,
    get playlistExportController() {
      return playlistExportController;
    },
    configuredImportEntry,
    requestCachedGuideConnection,
  };
}
