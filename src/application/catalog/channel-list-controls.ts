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
 * The channel list's controls: channel actions, provider management,
 * region and viewing choices. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import { mountChannelActions } from '../../ui/channels/channel-actions';
import { createChannelCategoryResolver, type Preferences } from '../../preferences';
import { isTauri } from '@tauri-apps/api/core';
import { mountProviderManagement } from '../../ui/channels/provider-management';
import { mountViewingChoices } from '../../ui/channels/viewing-choices';
import { mountGeographyControls } from '../../ui/channels/geography-controls';
import { type createAccountBrowser } from '../accounts/account-browser';
import { type createChannelEdits } from './channel-edits';
import { type createSettingsController } from '../shell/settings-controller';
import { type createChannelHealthController } from '../health/channel-health-controller';
import { type createCatalogView } from './catalog-view';
import { type createAddChannelsEntry } from '../discovery/add-channels-entry';
import { type CatalogRecord } from '../../catalog';
import {
  type AccountPreferencesMutation,
  type AccountPreferencesReceipt,
} from '../../platform/account-preferences';
import { type ChannelBrowser } from '../../ui/channels/channel-browser';

/** What this area reads from, and writes back to, the rest of the application. */
export interface ChannelListControlsEnvironment {
  readonly accountBrowser: ReturnType<typeof createAccountBrowser>;
  readonly catalog: CatalogRecord;
  readonly settings: Preferences;
  readonly writeAccountPreference: (
    mutation: AccountPreferencesMutation,
  ) => Promise<AccountPreferencesReceipt>;
  readonly applicationClosing: boolean;
  readonly editPublicChannelGroup: ReturnType<typeof createChannelEdits>['editPublicChannelGroup'];
  readonly saveSettings: ReturnType<typeof createSettingsController>['saveSettings'];
  readonly removeSavedChannel: ReturnType<
    typeof createChannelHealthController
  >['removeSavedChannel'];
  readonly notice: ReturnType<typeof createCatalogView>['notice'];
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly importRunning: boolean;
  readonly transferBusy: boolean;
  readonly addChannelsEntry: ReturnType<typeof createAddChannelsEntry>;
  readonly browser: ChannelBrowser;
}

export function createChannelListControls(env: ChannelListControlsEnvironment) {
  const channelActions = mountChannelActions({
    category: (id) => {
      const account = env.accountBrowser.selectionFor(id);
      if (account)
        return {
          name: account.channel.name,
          original: account.originalCategory,
          current: account.channel.category,
        };
      const channel = env.catalog.channels.find((entry) => entry.id === id);
      return channel
        ? {
            name: channel.name,
            original: channel.category,
            current: createChannelCategoryResolver(env.settings)(channel),
          }
        : null;
    },
    saveCategory: async (id, category) => {
      if (env.accountBrowser.selectionFor(id)) {
        await env.writeAccountPreference({ kind: 'category', channelId: id, category });
        return;
      }
      if (env.applicationClosing || !env.catalog.channels.some((channel) => channel.id === id))
        throw new Error('Channel unavailable.');
      if (isTauri()) {
        await env.editPublicChannelGroup(id, { kind: 'category', value: category });
        return;
      }
      const saved = await env.saveSettings((draft) => {
        const overrides = (draft.channelCategoryOverrides ?? []).filter(
          (entry) => entry.channelId !== id,
        );
        if (category !== null) overrides.push({ channelId: id, category });
        draft.channelCategoryOverrides = overrides;
      });
      if (!saved) throw new Error('Category was not saved.');
    },
    removeChannel: (id) => env.removeSavedChannel(id),
    notice: env.notice,
  });
  const providerManagement = mountProviderManagement(env.element('provider-management'), {
    read: () => ({
      schemaVersion: 1,
      reviewedChannelProviders: env.settings.reviewedChannelProviders ?? [],
      reviewedGuideProviders: env.settings.reviewedGuideProviders ?? [],
    }),
    remove: async (kind, id, signal) => {
      if (
        env.applicationClosing ||
        env.importRunning ||
        env.transferBusy ||
        env.addChannelsEntry.addChannelsEntryWork
      )
        return false;
      return env.saveSettings(
        (draft) => {
          if (kind === 'channel')
            draft.reviewedChannelProviders = (draft.reviewedChannelProviders ?? []).filter(
              (provider) => provider.id !== id,
            );
          else
            draft.reviewedGuideProviders = (draft.reviewedGuideProviders ?? []).filter(
              (provider) => provider.id !== id,
            );
        },
        async () => !signal.aborted && !env.applicationClosing,
      );
    },
  });
  // eslint-disable-next-line prefer-const -- assigned after the panel it serves
  let viewingChoices: ReturnType<typeof mountViewingChoices> | undefined;
  const geographyControls = mountGeographyControls(env.element('geography-controls'), {
    preferredCountry: () => env.settings.preferredRegion?.country,
    channels: () =>
      env.catalog.channels.filter((channel) => !env.settings.removedChannels.includes(channel.id)),
    summary: () => (env.accountBrowser.selectedAccount ? (viewingChoices?.summary ?? null) : null),
    apply: ({ filter, sort, registry }) => env.browser.setGeography(filter, sort, registry),
  });
  viewingChoices = mountViewingChoices({
    channels: env.browser,
    accounts: env.accountBrowser,
    changed: () => geographyControls.update(),
    notice: env.notice,
  });
  return {
    channelActions,
    geographyControls,
    providerManagement,
    get viewingChoices() {
      return viewingChoices;
    },
  };
}
