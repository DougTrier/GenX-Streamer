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
 * Sound (heard at once, saved after) and saving settings. Moved out of main.ts. main.ts passes the shared
 * application context.
 */
import { type Preferences, type SerializedPreferencesStore } from '../../preferences';
import { type createScanController } from '../discovery/scan-controller';
import { type mountGuide } from '../../ui/guide';
import { type createDiagnostics } from '../../diagnostics/native';
import { type PlaybackController } from '../../playback/controller';

/** What this area reads from, and writes back to, the rest of the application. */
export interface SettingsEnvironment {
  settings: Preferences;
  readonly player: PlaybackController;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly transferBusy: boolean;
  readonly sourceScan: ReturnType<typeof createScanController>['sourceScan'];
  readonly preferences: SerializedPreferencesStore;
  catalogBrowseViewRevision: number;
  readonly applicationClosing: boolean;
  readonly guide: ReturnType<typeof mountGuide>;
  readonly applySettings: () => void;
  readonly diagnostics: ReturnType<typeof createDiagnostics>;
  readonly notice: (message: string) => void;
  readonly friendlyError: (error: unknown) => string;
}

export function createSettingsController(env: SettingsEnvironment) {
  /**
   * Sound changes are heard at once; saving them follows. Waiting for the save
   * delayed Mute by 4.4 s on the Galaxy S25 (owner report, October 19, 2026).
   * Only the newest change of each kind clears its pending value, so quick
   * repeated presses never flicker; a refused or failed save restores the saved
   * sound.
   */
  let pendingSound: { muted?: boolean; volume?: number } = {};
  function soundNow(): { muted: boolean; volume: number } {
    return {
      muted: pendingSound.muted ?? env.settings.muted,
      volume: pendingSound.volume ?? env.settings.volume,
    };
  }
  function presentSound(): void {
    const { muted, volume } = soundNow();
    env.player.setMuted(muted);
    env.player.setVolume(volume);
    env.element<HTMLInputElement>('volume').value = String(volume);
    env.element('mute-button').textContent = muted ? 'Unmute' : 'Mute';
    env.element('mute-button').setAttribute('aria-pressed', String(muted));
  }
  async function changeSound(change: { muted?: boolean; volume?: number }): Promise<boolean> {
    pendingSound = { ...pendingSound, ...change };
    presentSound();
    const saved = await saveSettings(
      (draft) => {
        if (change.muted !== undefined) draft.muted = change.muted;
        if (change.volume !== undefined) draft.volume = change.volume;
      },
      undefined,
      true,
    );
    if (!saved) pendingSound = {};
    else {
      if (change.muted !== undefined && pendingSound.muted === change.muted)
        delete pendingSound.muted;
      if (change.volume !== undefined && pendingSound.volume === change.volume)
        delete pendingSound.volume;
    }
    presentSound();
    return saved;
  }
  async function saveSettings(
    mutate: (draft: Preferences) => void,
    guard?: () => Promise<boolean>,
    allowDuringScan = false,
  ): Promise<boolean> {
    if (
      (env.transferBusy && !(allowDuringScan && env.sourceScan.snapshot().busy)) ||
      env.element('app').dataset.ready !== 'true'
    )
      return false;
    try {
      const previous = env.settings;
      env.settings = await env.preferences.update(mutate, guard);
      const sameIds = (left: readonly string[], right: readonly string[]) =>
        left.length === right.length && left.every((id, index) => id === right[index]);
      const previousCategories = previous.channelCategoryOverrides ?? [];
      const nextCategories = env.settings.channelCategoryOverrides ?? [];
      if (
        !sameIds(previous.favorites, env.settings.favorites) ||
        !sameIds(previous.removedChannels, env.settings.removedChannels) ||
        previousCategories.length !== nextCategories.length ||
        previousCategories.some(
          (entry, index) =>
            entry.channelId !== nextCategories[index]?.channelId ||
            entry.category !== nextCategories[index]?.category,
        )
      ) {
        env.catalogBrowseViewRevision++;
        // Saved viewing metadata is independent of the native catalog revision.
        // Invalidate open Guide snapshots only after the preference write acknowledges.
        if (!env.applicationClosing) env.guide.catalogChanged(true);
      }
      if (!env.applicationClosing) env.applySettings();
      return true;
    } catch (error) {
      void env.diagnostics.emit({ operation: 'storage', level: 'error', code: 'storage-failed' });
      env.notice(`Changes weren’t saved. ${env.friendlyError(error)}`);
      return false;
    }
  }
  return {
    saveSettings,
    changeSound,
    soundNow,
    presentSound,
  };
}
