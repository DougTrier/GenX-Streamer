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
 * The guide pages: the program guide, the Paid TV guide and their channel
 * logos. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import { createChannelLogos } from '../catalog/channel-logos';
import { isTauri } from '@tauri-apps/api/core';
import { mountPaidGuide } from '../../ui/paid-guide';
import { createAccountGuide } from '../../platform/account-guide';
import { mountGuide } from '../../ui/guide';
import { type createPageState } from '../shell/page-state';
import { type createAccountBrowser } from '../accounts/account-browser';
import { type createLibraryState } from '../genxtra/library-state';
import { type createPageController } from '../shell/page-controller';
import { type createAccountPlaybackSelection } from '../accounts/account-playback-selection';
import { type createGuideController } from './guide-controller';

/** What this area reads from, and writes back to, the rest of the application. */
export interface GuideViewsEnvironment {
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly applicationClosing: boolean;
  readonly pageState: ReturnType<typeof createPageState>;
  readonly nativeViewingForeground: boolean;
  readonly accountBrowser: ReturnType<typeof createAccountBrowser>;
  readonly library: ReturnType<typeof createLibraryState>;
  readonly persistedCatalogRevision: string;
  readonly primaryHost: ReturnType<typeof createPageController>['primaryHost'];
  readonly selectAccountPlayback: ReturnType<
    typeof createAccountPlaybackSelection
  >['selectAccountPlayback'];
  readonly playbackAction: (work: Promise<unknown>) => void;
  readonly switchPrimaryPage: ReturnType<typeof createPageController>['switchPrimaryPage'];
  readonly guideHost: ReturnType<typeof createGuideController>['guideHost'];
  readonly presentPrimaryPage: ReturnType<typeof createPageController>['presentPrimaryPage'];
  readonly guideController: ReturnType<typeof createGuideController>;
  readonly automaticGuides: ReturnType<typeof createGuideController>['automaticGuides'];
}

export function createGuideViews(env: GuideViewsEnvironment) {
  const guideChannelLogos = createChannelLogos({
    readyScope: () =>
      isTauri() &&
      env.element('app').dataset.ready === 'true' &&
      !env.applicationClosing &&
      env.pageState.primaryPage === 'guide' &&
      !document.hidden &&
      env.nativeViewingForeground &&
      !env.accountBrowser.selectedAccount
        ? {
            key: `${env.library.archiveStorageEpoch}:${env.persistedCatalogRevision}`,
            revision: env.persistedCatalogRevision,
          }
        : null,
    changed: () => guide.refreshArtwork(),
  });
  const paidGuide = mountPaidGuide(env.primaryHost, {
    guide: createAccountGuide(),
    async watch(row, signal) {
      signal.throwIfAborted();
      const scope = env.accountBrowser.preferenceScope();
      if (!scope || scope.accountId !== env.accountBrowser.selectedAccount?.id)
        throw new Error('This Paid TV account is no longer selected.');
      await env.selectAccountPlayback(
        {
          id: row.id,
          name: row.name,
          category: row.category,
          providerId: row.providerId,
          epgId: row.epgId,
          streamReference: row.streamReference,
        },
        {
          accountId: scope.accountId,
          accountRevision: scope.accountRevision,
          mediaRevision: scope.mediaRevision,
        },
      );
    },
    close: () => env.playbackAction(env.switchPrimaryPage('watch')),
    now: () => env.guideHost.now(),
    formatTime: (ms) => env.guideHost.formatTime(ms),
  });
  const guide = mountGuide(env.primaryHost, {
    ...env.guideHost,
    logos: guideChannelLogos,
    presentation: 'page',
    opened: async () => {
      env.presentPrimaryPage('guide');
      // The remote starts inside the guide: opened with OK, it had no focus at
      // all on the Streamer (October 19, 2026), so nothing showed where to go.
      requestAnimationFrame(() => {
        const page = env.primaryHost.querySelector<HTMLElement>('dialog[open]');
        const active = document.activeElement;
        if (!page || (active && active !== document.body && page.contains(active))) return;
        const entry = [
          ...page.querySelectorAll<HTMLElement>(
            '.gx-timeline-channel, .gx-agenda-channel, .gx-timeline-toolbar button',
          ),
        ].find(
          (control) => control.getClientRects().length && !control.closest('[hidden],[inert]'),
        );
        entry?.focus({ preventScroll: true });
      });
    },
    closed: async () => {
      if (env.pageState.primaryPage === 'guide') env.presentPrimaryPage('watch');
    },
    buildForChannels: (signal) => {
      // Explicit Find retries discovery; automatic requests keep the retry cooldown.
      if (
        env.guideController.automaticGuideDiscovery?.result.outcomes.some(
          (outcome) => outcome.status === 'failed',
        )
      )
        env.guideController.automaticGuideDiscovery = null;
      // The build belongs to the background guide owner. Leaving the Guide page stops
      // waiting for it; it neither cancels the build nor waits for it to settle.
      const build = env.automaticGuides.run();
      return new Promise<Awaited<typeof build>>((resolve, reject) => {
        const leave = () => reject(new DOMException('Guide page closed.', 'AbortError'));
        if (signal.aborted) return leave();
        signal.addEventListener('abort', leave, { once: true });
        build.then(resolve, reject).finally(() => signal.removeEventListener('abort', leave));
      });
    },
  });
  return {
    guide,
    guideChannelLogos,
    paidGuide,
  };
}
