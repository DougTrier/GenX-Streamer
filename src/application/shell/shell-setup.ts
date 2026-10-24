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
 * The application shell's parts: diagnostics, viewing controls (captions,
 * quality, audio tracks, VOD dock), Settings navigation, the viewport and
 * remote navigation. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import { createDiagnostics } from '../../diagnostics/native';
import { installAudioDiagnostics } from '../playback/audio-diagnostics';
import { mountEventHistory } from '../../ui/event-history';
import { installFullscreenPresentation } from '../../ui/fullscreen-presentation';
import { installCaptions } from '../../ui/captions';
import { installVideoQuality } from '../../ui/video-quality';
import { installAudioTracks } from '../../ui/audio-tracks';
import { installVODDock } from '../../ui/vod-dock';
import { mountLocationDialog, mountSettingsNavigation } from '../../ui/settings-navigation';
import { mountAbout } from '../../ui/about';
import { installCategoryMenu } from '../../ui/category-menu';
import { type mountStorageRecovery } from '../../ui/storage-recovery';
import { installViewport } from '../../ui/viewport';
import { createRemoteEditMode, installRemoteNavigation } from '../../ui/remote-navigation';
import { type createBootstrapBoundary } from './bootstrap-boundary';

/** What this area reads from, and writes back to, the rest of the application. */
export interface ShellSetupEnvironment {
  readonly bootstrapBoundary: ReturnType<typeof createBootstrapBoundary>;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly applicationClosing: boolean;
  readonly nativeViewingForeground: boolean;
  readonly backgroundSuspension: Promise<void> | null;
  readonly updateVisibleGuide: () => void;
}

export function createShellSetup(env: ShellSetupEnvironment) {
  const diagnostics = env.bootstrapBoundary.run('shell', () => createDiagnostics());
  const audioDiagnostics = env.bootstrapBoundary.run('shell', () =>
    installAudioDiagnostics(env.element<HTMLVideoElement>('video'), { emit: diagnostics.emit }),
  );
  const eventHistory = env.bootstrapBoundary.run('shell', () =>
    mountEventHistory(env.element('app'), {
      read: diagnostics.read,
      clear: diagnostics.clear,
      formatTime: (timestampMs) => new Date(timestampMs).toLocaleString(),
    }),
  );
  env.bootstrapBoundary.run('shell', () =>
    env.element('event-history-button').addEventListener('click', () => eventHistory.open()),
  );
  const fullscreenPresentation = env.bootstrapBoundary.run('viewing-controls', () =>
    installFullscreenPresentation(env.element('app')),
  );
  const removeCaptions = env.bootstrapBoundary.run('viewing-controls', () =>
    installCaptions(
      env.element<HTMLVideoElement>('video'),
      env.element<HTMLButtonElement>('captions-button'),
    ),
  );
  const removeVideoQuality = env.bootstrapBoundary.run('viewing-controls', () =>
    installVideoQuality(env.element<HTMLVideoElement>('video'), env.element('video-quality')),
  );
  const removeAudioTracks = env.bootstrapBoundary.run('viewing-controls', () =>
    installAudioTracks(env.element<HTMLVideoElement>('video'), env.element('audio-tracks')),
  );
  const vodDock = env.bootstrapBoundary.run('viewing-controls', () =>
    installVODDock(
      env.element('app'),
      () => !env.applicationClosing && env.nativeViewingForeground && !env.backgroundSuspension,
    ),
  );
  env.element('app').dataset.compactView = 'watch';
  env.element('compact-view').addEventListener('change', () => {
    env.element('app').dataset.compactView = env.element<HTMLSelectElement>('compact-view').value;
    env.updateVisibleGuide();
  });
  const removeSettingsNavigation = env.bootstrapBoundary.run('settings', () =>
    mountSettingsNavigation(env.element<HTMLDialogElement>('settings-dialog')),
  );
  const removeLocationDialog = env.bootstrapBoundary.run('region', () =>
    mountLocationDialog(env.element('geography-controls')),
  );
  const removeAbout = env.bootstrapBoundary.run('settings', () =>
    mountAbout(env.element('app'), env.element<HTMLButtonElement>('about-button')),
  );
  env.element('app').inert = true;
  // TV and Windows: All | Movies | News | Sports fold into one button in the channel row.
  const categoryMenu = env.bootstrapBoundary.run('viewport', () =>
    installCategoryMenu(env.element('app')),
  );
  let storageRecovery: ReturnType<typeof mountStorageRecovery> | undefined;
  const removeViewport = env.bootstrapBoundary.run('viewport', () =>
    installViewport(env.element('app')),
  );
  const remoteEditMode = env.bootstrapBoundary.run('viewport', () => createRemoteEditMode());
  const removeRemoteNavigation = env.bootstrapBoundary.run('viewport', () =>
    installRemoteNavigation({ editMode: remoteEditMode }),
  );
  return {
    audioDiagnostics,
    categoryMenu,
    diagnostics,
    eventHistory,
    fullscreenPresentation,
    remoteEditMode,
    removeAbout,
    removeAudioTracks,
    removeCaptions,
    removeLocationDialog,
    removeRemoteNavigation,
    removeSettingsNavigation,
    removeVideoQuality,
    removeViewport,
    get storageRecovery() {
      return storageRecovery;
    },
    set storageRecovery(value: typeof storageRecovery) {
      storageRecovery = value;
    },
    vodDock,
  };
}
