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
 * Preferences: loading them, the region, and saving or restoring the
 * provider configuration. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import {
  SerializedPreferencesStore,
  defaultPanelWidthForViewport,
  type Preferences,
} from '../../preferences';
import { readRecord, writeRecord } from '../../platform/records';
import { mountRegionPreference } from '../../ui/channels/region-preference';
import { fetchAuxiliaryText } from '../../location/fetch';
import {
  defaultProviderRegistry,
  parseProviderRegistry,
  serializeProviderRegistry,
} from '../../discovery/provider-registry';
import { type createBootstrapBoundary } from './bootstrap-boundary';
import { type createSettingsController } from './settings-controller';

/** What this area reads from, and writes back to, the rest of the application. */
export interface PreferencesSetupEnvironment {
  readonly bootstrapBoundary: ReturnType<typeof createBootstrapBoundary>;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly saveSettings: ReturnType<typeof createSettingsController>['saveSettings'];
  catalogRevision: number;
}

export function createPreferencesSetup(env: PreferencesSetupEnvironment) {
  // WebView can report zero before its first measured layout; this is a DOM
  // initialization fallback, not validation or normalization of saved data.
  function initialPanelWidth(): number {
    const width = window.innerWidth;
    return Number.isFinite(width) && width > 0 ? defaultPanelWidthForViewport(width) : 360;
  }
  const preferences = env.bootstrapBoundary.run(
    'preferences',
    () =>
      new SerializedPreferencesStore(
        {
          read: async () => {
            const text = await readRecord('preferences');
            return text === null ? null : JSON.parse(text);
          },
          write: async (value) => {
            await writeRecord('preferences', JSON.stringify(value));
          },
        },
        initialPanelWidth(),
      ),
  );
  let settings: Preferences = preferences.snapshot();
  const regionPreference = env.bootstrapBoundary.run('region', () =>
    mountRegionPreference(env.element('region-settings'), {
      read: () => settings.preferredRegion,
      save: async (region, signal) => {
        signal.throwIfAborted();
        const saved = await env.saveSettings(
          (draft) => {
            draft.preferredRegion = region;
          },
          async () => !signal.aborted,
        );
        if (saved) env.catalogRevision++;
        return saved;
      },
      fetch: fetchAuxiliaryText,
    }),
  );
  env.element('save-provider-configuration').addEventListener('click', () => {
    void (async () => {
      try {
        const parsed = parseProviderRegistry(
          env.element<HTMLTextAreaElement>('provider-configuration').value,
        );
        // Owner decision, October 17, 2026: included channel sources always allow
        // plain HTTP (allowIncludedHttp grants it again at every start). Keep it on
        // here and say so, rather than save "off" and silently undo it later.
        const withdrawn = parsed.reviewedChannelProviders.some(
          (provider) => provider.allowHttp !== true,
        );
        const registry = {
          ...parsed,
          reviewedChannelProviders: parsed.reviewedChannelProviders.map((provider) => ({
            ...provider,
            allowHttp: true,
          })),
        };
        const saved = await env.saveSettings((draft) => {
          draft.reviewedChannelProviders = registry.reviewedChannelProviders;
          draft.reviewedGuideProviders = registry.reviewedGuideProviders;
        });
        if (!saved) return;
        env.catalogRevision++;
        if (withdrawn)
          env.element<HTMLTextAreaElement>('provider-configuration').value =
            serializeProviderRegistry(registry);
        env.element('provider-configuration-status').textContent = withdrawn
          ? 'Discovery providers saved. Included channel sources always allow plain HTTP, so that stays on. Your existing channels are preserved.'
          : 'Discovery providers saved. Your existing channels are preserved.';
      } catch {
        env.element('provider-configuration-status').textContent =
          'Check the provider configuration. No changes were saved.';
      }
    })();
  });
  env.element('restore-provider-configuration').addEventListener('click', () => {
    void (async () => {
      try {
        const registry = defaultProviderRegistry();
        const saved = await env.saveSettings((draft) => {
          draft.reviewedChannelProviders = registry.reviewedChannelProviders;
          draft.reviewedGuideProviders = registry.reviewedGuideProviders;
        });
        if (!saved) return;
        env.catalogRevision++;
        env.element<HTMLTextAreaElement>('provider-configuration').value =
          serializeProviderRegistry(registry);
        env.element('provider-configuration-status').textContent =
          'Suggested sources restored. Scan channels or find program guides when you are ready.';
      } catch {
        env.element('provider-configuration-status').textContent =
          'Suggested sources could not be saved.';
      }
    })();
  });
  return {
    preferences,
    regionPreference,
    get settings() {
      return settings;
    },
    set settings(value: typeof settings) {
      settings = value;
    },
  };
}
