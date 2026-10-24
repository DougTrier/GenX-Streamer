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
 * Keeping the screen awake while something plays, and the foreground
 * admission. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import { createWakeTransportAdmission } from '../../playback/viewing-wake-startup';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  createViewingForegroundAdmission,
  createViewingWakeOwner,
} from '../../playback/viewing-wake-owner';
import { createActivityWakePolicy } from './activity-wake';
import { type createCatalogView } from '../catalog/catalog-view';

/** What this area reads from, and writes back to, the rest of the application. */
export interface ViewingWakeSetupEnvironment {
  readonly applicationClosing: boolean;
  readonly notice: ReturnType<typeof createCatalogView>['notice'];
}

export function createViewingWakeSetup(env: ViewingWakeSetupEnvironment) {
  const wakeTransportAdmission = createWakeTransportAdmission();
  const viewingWake = isTauri()
    ? createViewingWakeOwner({
        send: async (active) => {
          await wakeTransportAdmission.wait();
          return invoke('set_viewing_active', { active });
        },
        onError: () => {
          if (!env.applicationClosing)
            env.notice('Screen sleep preference could not be applied. Playback remains available.');
        },
      })
    : null;
  Object.defineProperty(window, '__GENX_WAKE__', {
    get: () => viewingWake?.snapshot() ?? null,
    enumerable: false,
    configurable: false,
  });
  const viewingForeground = viewingWake
    ? createViewingForegroundAdmission((active) => viewingWake.setForeground(active))
    : null;
  const activityWake = createActivityWakePolicy(
    (active) => viewingWake?.setActive(active) ?? Promise.resolve(),
  );
  void viewingForeground?.setDocumentVisible(!document.hidden).catch(() => undefined);
  // Initial idle is an explicit owned disable, not an assumed native state.
  void viewingWake?.setActive(false).catch(() => undefined);
  return {
    activityWake,
    viewingForeground,
    viewingWake,
    wakeTransportAdmission,
  };
}
