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
 * The channel list as shown: rendering the catalog, removing a source,
 * applying settings to the screen, and short notices. Moved out of main.ts. main.ts passes the shared
 * application context.
 */
import {
  createChannelCategoryResolver,
  exportPreferences,
  type Preferences,
  type SerializedPreferencesStore,
} from '../../preferences';
import { restoreRemoteFocus } from '../../ui/shell/remote-navigation';
import { writeRecordPair } from '../../platform/records';
import { serializeCatalog, type CatalogRecord } from '../../catalog';
import { serializeProviderRegistry } from '../../discovery/provider-registry';
import { migrateRefreshCadence } from '../../catalog/refresh-cadence';
import { type mountGuide } from '../../ui/guide/guide';
import { type createLibraryState } from '../genxtra/library-state';
import { type mountGeographyControls } from '../../ui/channels/geography-controls';
import { type createChannelHealthController } from '../health/channel-health-controller';
import { type createAccountBrowser } from '../accounts/account-browser';
import { type createImportController } from '../discovery/import-controller';
import { type createSharingHost } from '../sharing/sharing-host';
import { type mountProviderManagement } from '../../ui/channels/provider-management';
import { type mountRegionPreference } from '../../ui/channels/region-preference';
import { type createSettingsController } from '../shell/settings-controller';
import { type createPlayerView } from '../playback/player-view';
import { type ChannelBrowser } from '../../ui/channels/channel-browser';
import { type PlaybackController } from '../../playback/controller';
import { type installInAppSelects } from '../../ui/shell/in-app-select';

/** What this area reads from, and writes back to, the rest of the application. */
export interface CatalogViewEnvironment {
  noticeTimer: ReturnType<typeof setTimeout> | undefined;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly updateVisibleGuide: () => void;
  readonly guide: ReturnType<typeof mountGuide>;
  settings: Preferences;
  readonly library: ReturnType<typeof createLibraryState>;
  readonly browser: ChannelBrowser;
  catalog: CatalogRecord;
  readonly player: PlaybackController;
  readonly geographyControls: ReturnType<typeof mountGeographyControls>;
  readonly presentNotResponding: ReturnType<
    typeof createChannelHealthController
  >['presentNotResponding'];
  readonly importRunning: boolean;
  readonly accountBrowser: ReturnType<typeof createAccountBrowser>;
  transferBusy: boolean;
  readonly addChannelsEntryWork: Promise<void> | null;
  readonly importController: ReturnType<typeof createImportController>;
  readonly applicationClosing: boolean;
  readonly setImportBusy: (busy: boolean) => void;
  catalogWrites: Promise<unknown>;
  readonly preferences: SerializedPreferencesStore;
  persistedCatalogRevision: string;
  catalogRevision: number;
  readonly sharingBridge: ReturnType<typeof createSharingHost>;
  readonly automaticGuideUpdates: ReturnType<
    typeof createImportController
  >['automaticGuideUpdates'];
  readonly providerManagement: ReturnType<typeof mountProviderManagement>;
  readonly regionPreference: ReturnType<typeof mountRegionPreference>;
  readonly presentSound: ReturnType<typeof createSettingsController>['presentSound'];
  readonly renderPlayer: ReturnType<typeof createPlayerView>['renderPlayer'];
  readonly televisionSelects: ReturnType<typeof installInAppSelects> | undefined;
}

export function createCatalogView(env: CatalogViewEnvironment) {
  function notice(message: string): void {
    clearTimeout(env.noticeTimer);
    env.element('notice').textContent = message;
    env.element('notice').hidden = false;
    env.noticeTimer = setTimeout(() => {
      env.element('notice').hidden = true;
    }, 6000);
  }
  // External errors never include provider URLs or raw native payloads in exported diagnostics.
  function friendlyError(error: unknown): string {
    if (error instanceof Error && !/https?:\/\//i.test(error.message)) return error.message;
    return 'The operation could not finish. Check the source, connection, or available storage.';
  }
  function renderCatalog(): void {
    env.updateVisibleGuide();
    env.guide.catalogChanged();
    const removed = new Set(env.settings.removedChannels);
    const category = createChannelCategoryResolver(env.settings);
    if (env.library.contentLibrary === 'live')
      env.browser.update(
        env.catalog.channels
          .filter((channel) => !removed.has(channel.id))
          .map((channel) =>
            category(channel) === channel.category
              ? channel
              : { ...channel, category: category(channel) },
          ),
        env.settings.favorites,
        env.player.snapshot.selection?.id ?? null,
        env.catalog.sources.length === 0
          ? 'no-sources'
          : env.catalog.channels.length === 0
            ? 'empty-sources'
            : 'removed-channels',
      );
    env.geographyControls.update();
    env.presentNotResponding();
    env.element<HTMLButtonElement>('refresh-button').disabled =
      env.importRunning || !env.catalog.sources.some((source) => source.kind === 'url');
    env.element('source-status').textContent =
      `${env.catalog.sources.length} ${env.catalog.sources.length === 1 ? 'playlist' : 'playlists'} saved`;
    env.element<HTMLButtonElement>('restore-channels').disabled = env.accountBrowser.selectedAccount
      ? !env.accountBrowser.preferenceScope()
      : env.settings.removedChannels.length === 0;
    const sourceList = env.element('source-list');
    const sourceButtons = [...sourceList.querySelectorAll<HTMLButtonElement>('button')];
    const sourceFocusIndex = sourceButtons.findIndex((button) => button === document.activeElement);
    const rows = document.createDocumentFragment();
    for (const source of env.catalog.sources) {
      const row = document.createElement('div');
      row.className = 'source-row';
      const name = document.createElement('span');
      name.textContent = source.name;
      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove source ${source.name}`);
      remove.disabled = env.importRunning;
      remove.addEventListener('click', () => {
        void removeSource(source.id);
      });
      row.append(name, remove);
      rows.append(row);
    }
    sourceList.replaceChildren(rows);
    if (sourceFocusIndex >= 0) {
      const nextButtons = [...sourceList.querySelectorAll<HTMLButtonElement>('button')];
      restoreRemoteFocus(
        nextButtons[Math.min(sourceFocusIndex, nextButtons.length - 1)] ?? null,
        env.element('settings-dialog').querySelector<HTMLElement>('[data-close]'),
      );
    }
  }
  async function removeSource(id: string): Promise<void> {
    if (
      env.importRunning ||
      env.transferBusy ||
      env.addChannelsEntryWork ||
      env.importController.playlistExportWork
    ) {
      notice('Finish or cancel the import before removing a source.');
      return;
    }
    const removedIds = new Set(
      env.catalog.channels
        .filter((channel) => channel.sourceId === id)
        .map((channel) => channel.id),
    );
    const source = env.catalog.sources.find((entry) => entry.id === id);
    if (!source || env.applicationClosing) return;
    env.transferBusy = true;
    env.setImportBusy(true);
    try {
      const work = env.catalogWrites.then(async () => {
        const next = {
          ...env.catalog,
          sources: env.catalog.sources.filter((entry) => entry.id !== id),
          channels: env.catalog.channels.filter((channel) => channel.sourceId !== id),
        };
        const nextPreferences = await env.preferences.settledSnapshot();
        nextPreferences.sources = [...next.sources];
        if (source.kind === 'url') {
          const location = new URL(source.location).href;
          nextPreferences.reviewedChannelProviders = (
            nextPreferences.reviewedChannelProviders ?? []
          ).filter((provider) => new URL(provider.location).href !== location);
        }
        env.settings = await env.preferences.replaceAtomically(nextPreferences, async () => {
          const receipt = await writeRecordPair({
            catalog: serializeCatalog(next),
            preferences: exportPreferences(nextPreferences),
            expectedCatalogRevision: env.persistedCatalogRevision,
          });
          env.persistedCatalogRevision = receipt.catalogRevision;
        });
        env.catalog = next;
        env.catalogRevision++;
      });
      env.catalogWrites = work.catch(() => undefined);
      await work;
      if (removedIds.has(env.player.snapshot.selection?.id ?? '')) await env.sharingBridge.stop();
      if (!env.applicationClosing) {
        applySettings();
        notice(
          'Source removed from saved channels and discovery. Other sources and favorites are preserved.',
        );
      }
    } catch (error) {
      notice(friendlyError(error));
    } finally {
      env.transferBusy = false;
      if (!env.applicationClosing) env.setImportBusy(false);
    }
  }
  function applySettings(): void {
    env.automaticGuideUpdates.update(env.settings.automaticGuideUpdates);
    env.providerManagement.update();
    env.element<HTMLInputElement>('voice-search-consent').checked =
      env.settings.voiceSearchConsent === true;
    env.regionPreference.update();
    if (document.activeElement !== env.element('provider-configuration'))
      env.element<HTMLTextAreaElement>('provider-configuration').value = serializeProviderRegistry({
        schemaVersion: 1,
        reviewedChannelProviders: env.settings.reviewedChannelProviders ?? [],
        reviewedGuideProviders: env.settings.reviewedGuideProviders ?? [],
      });
    env.element<HTMLSelectElement>('daily-source-refresh').value = migrateRefreshCadence(
      env.settings.sourceRefreshCadence,
      env.settings.automaticSourceRefresh,
    );
    document.documentElement.style.setProperty('--sidebar', `${env.settings.panelWidth}px`);
    env.presentSound();
    env.element('divider').setAttribute('aria-valuenow', String(env.settings.panelWidth));
    renderCatalog();
    env.renderPlayer(env.player.snapshot);
    env.sharingBridge.notifySettings();
    env.televisionSelects?.refresh();
  }
  return {
    applySettings,
    friendlyError,
    notice,
    renderCatalog,
  };
}
