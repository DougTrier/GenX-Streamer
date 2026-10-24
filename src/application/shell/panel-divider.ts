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
 * The divider between the channel list and the picture: drag, keyboard
 * resizing and the saved width. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import { type createSettingsController } from './settings-controller';
import { type createCatalogView } from '../catalog/catalog-view';
import { type Preferences } from '../../preferences';

/** What this area reads from, and writes back to, the rest of the application. */
export interface PanelDividerEnvironment {
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly settings: Preferences;
  readonly saveSettings: ReturnType<typeof createSettingsController>['saveSettings'];
  readonly applySettings: ReturnType<typeof createCatalogView>['applySettings'];
}

export function installPanelDivider(env: PanelDividerEnvironment): void {
  const divider = env.element('divider');
  let dragWidth: number | null = null;
  divider.addEventListener('pointerdown', (event) => {
    divider.setPointerCapture(event.pointerId);
    dragWidth = env.settings.panelWidth;
  });
  divider.addEventListener('pointermove', (event) => {
    if (dragWidth === null) return;
    dragWidth = Math.min(600, Math.max(240, event.clientX));
    document.documentElement.style.setProperty('--sidebar', `${dragWidth}px`);
    divider.setAttribute('aria-valuenow', String(dragWidth));
  });
  divider.addEventListener('pointerup', (event) => {
    if (dragWidth === null) return;
    const width = dragWidth;
    dragWidth = null;
    divider.releasePointerCapture(event.pointerId);
    void env.saveSettings((draft) => {
      draft.panelWidth = width;
    });
  });
  divider.addEventListener('pointercancel', () => {
    dragWidth = null;
    env.applySettings();
  });
  divider.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const width =
      event.key === 'Home'
        ? 240
        : event.key === 'End'
          ? 600
          : Math.min(
              600,
              Math.max(240, env.settings.panelWidth + (event.key === 'ArrowRight' ? 20 : -20)),
            );
    void env.saveSettings((draft) => {
      draft.panelWidth = width;
    });
  });
}
