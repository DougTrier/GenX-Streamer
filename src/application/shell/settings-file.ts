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
 * Exporting settings to a file and importing them back. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import {
  exportPreferences,
  importPreferences,
  type Preferences,
  type SerializedPreferencesStore,
} from '../../preferences';
import { type createImportController } from '../discovery/import-controller';
import { type createCatalogView } from '../catalog/catalog-view';

/** What this area reads from, and writes back to, the rest of the application. */
export interface SettingsFileEnvironment {
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  settings: Preferences;
  readonly withPausedGuideUpdates: ReturnType<
    typeof createImportController
  >['withPausedGuideUpdates'];
  readonly preferences: SerializedPreferencesStore;
  readonly applySettings: ReturnType<typeof createCatalogView>['applySettings'];
  readonly notice: ReturnType<typeof createCatalogView>['notice'];
  readonly friendlyError: ReturnType<typeof createCatalogView>['friendlyError'];
}

export function installSettingsFile(env: SettingsFileEnvironment): void {
  env.element('export-button').addEventListener('click', () => {
    const url = URL.createObjectURL(
      new Blob([exportPreferences(env.settings)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'genx-streamer-settings.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  env.element('settings-file').addEventListener('change', async () => {
    const input = env.element<HTMLInputElement>('settings-file');
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Settings exceed the 20 MiB limit.');
      const imported = importPreferences(await file.text());
      await env.withPausedGuideUpdates(async () => {
        env.settings = await env.preferences.replace(imported);
        env.applySettings();
      });
      env.notice('Settings imported.');
    } catch (error) {
      env.notice(env.friendlyError(error));
    } finally {
      input.value = '';
    }
  });
}
