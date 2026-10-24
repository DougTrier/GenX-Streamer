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
 * Switching the main screen between watching and the program guide, with the
 * transition diagnostics exposed for tests. Moved out of main.ts.
 */
import {
  type PrimaryTransitionReason,
  type PrimaryTransitionStage,
  type createPageState,
} from './page-state';
import { type PrimaryPage } from './primary-page';
import { type createLibraryState } from '../genxtra/library-state';
import { type mountGuide } from '../../ui/guide/guide';
import { type mountPaidGuide } from '../../ui/guide/paid-guide';
import { type createLibraryController } from '../genxtra/library-controller';
import { type createAccountBrowser } from '../accounts/account-browser';
import { type mountLibrarySwitcher } from '../../ui/genxtra/library-switcher';
import { type mountArchiveSearch } from '../../ui/genxtra/archive-search';
import { type ContentLibrary } from '../genxtra/content-library';

/** What this area reads from, and writes back to, the rest of the application. */
export interface PageEnvironment {
  readonly pageState: ReturnType<typeof createPageState>;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly libraries: ReturnType<typeof mountLibrarySwitcher> | undefined;
  readonly library: ReturnType<typeof createLibraryState>;
  readonly applicationClosing: boolean;
  readonly guide: ReturnType<typeof mountGuide>;
  readonly paidGuide: ReturnType<typeof mountPaidGuide>;
  readonly archiveSearch: ReturnType<typeof mountArchiveSearch> | undefined;
  readonly archiveDiscovery: ReturnType<typeof createLibraryController>['archiveDiscovery'];
  readonly nativeViewingForeground: boolean;
  readonly accountBrowser: ReturnType<typeof createAccountBrowser>;
  readonly libraryQueries: Record<ContentLibrary, string>;
}

export function createPageController(env: PageEnvironment) {
  function observePrimaryTransition(
    stage: PrimaryTransitionStage,
    reason: PrimaryTransitionReason = 'none',
  ): void {
    env.pageState.primaryTransitionStage = stage;
    env.pageState.primaryTransitionReason = reason;
    env.pageState.primaryTransitionRevision = Math.min(
      Number.MAX_SAFE_INTEGER,
      env.pageState.primaryTransitionRevision + 1,
    );
  }
  const primaryHost = env.element('primary-view-host');
  /** While the Guide is open and something plays, the preview is a control:
   * OK, Enter or a click opens full screen; leaving full screen returns to the
   * Guide, and only Close guide returns to the normal view. */
  function updatePreviewControl(): void {
    const screen = env.element('screen');
    const app = env.element('app');
    const selectable =
      app.dataset.guidePanel === 'open' &&
      app.dataset.playerIdle !== 'true' &&
      !app.classList.contains('viewing-fullscreen');
    if (selectable) {
      screen.tabIndex = 0;
      screen.setAttribute('role', 'button');
      screen.setAttribute('aria-label', 'Watch full screen');
      screen.title = 'Watch full screen';
    } else {
      if (document.activeElement === screen) screen.blur();
      screen.removeAttribute('tabindex');
      screen.removeAttribute('role');
      screen.removeAttribute('aria-label');
      screen.removeAttribute('title');
    }
  }
  function selectPreview(event: Event): void {
    if (env.element('screen').getAttribute('role') !== 'button') return;
    event.preventDefault();
    env.element('fullscreen-button').click();
  }
  env.element('screen').addEventListener('click', selectPreview);
  env.element('screen').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') selectPreview(event);
  });
  function presentPrimaryPage(page: PrimaryPage): void {
    env.pageState.primaryPage = page;
    // The guide opens in the right panel under a small playing picture; the
    // channel list and the library tabs stay as they are.
    primaryHost.hidden = page === 'watch';
    const app = env.element('app');
    const wasOpen = app.dataset.guidePanel === 'open';
    app.dataset.guidePanel = page === 'guide' ? 'open' : 'closed';
    // Phones show one panel: the guide takes it, and closing returns to the
    // panel it was opened from (the channel row holds the Guide button).
    // Outside the phone's separate screens the Guide always opens from the channel row.
    if (page === 'guide' && !wasOpen)
      env.pageState.guideOpenedFrom = app.classList.contains('compact-content')
        ? (app.dataset.compactView ?? 'watch')
        : 'channels';
    const compact = page === 'guide' ? 'watch' : wasOpen ? env.pageState.guideOpenedFrom : null;
    if (compact) {
      app.dataset.compactView = compact;
      env.element<HTMLSelectElement>('compact-view').value = compact;
    }
    env.libraries?.present(env.library.contentLibrary === 'live');
    updatePreviewControl();
    env
      .element('genxtra-button')
      .setAttribute(
        'aria-pressed',
        String(page === 'watch' && env.library.contentLibrary === 'genxtra'),
      );
    env.element('guide-button').setAttribute('aria-pressed', String(page === 'guide'));
    env.element<HTMLButtonElement>('guide-button').disabled =
      env.library.contentLibrary === 'genxtra';
  }
  function switchPrimaryPage(page: PrimaryPage, query = ''): Promise<void> {
    const intent = ++env.pageState.primaryIntent;
    env.pageState.primaryTransitionRequestedIntent = intent;
    env.pageState.primaryTransitionPending++;
    if (!env.pageState.primaryTransitionActiveIntent) observePrimaryTransition('queued');
    const work = env.pageState.primaryTransitions.then(async () => {
      env.pageState.primaryTransitionActiveIntent = intent;
      try {
        if (env.applicationClosing) {
          observePrimaryTransition('refused', 'application-closing');
          return;
        }
        observePrimaryTransition('closing-guide');
        await env.guide.close();
        await env.paidGuide.hide();
        observePrimaryTransition('closing-search');
        if (page !== 'watch') {
          await env.archiveSearch?.suspend({ preserveSelection: true });
          await env.archiveDiscovery.suspend();
        }
        const reason: PrimaryTransitionReason =
          intent !== env.pageState.primaryIntent
            ? 'superseded'
            : env.applicationClosing
              ? 'application-closing'
              : document.hidden
                ? 'document-hidden'
                : !env.nativeViewingForeground
                  ? 'native-background'
                  : 'none';
        if (reason !== 'none') {
          observePrimaryTransition('refused', reason);
          return;
        }
        observePrimaryTransition('opening');
        const paidAccount = page === 'guide' ? env.accountBrowser.selectedAccount : null;
        if (paidAccount) {
          // Paid TV: the provider's own guide. Its download continues in the
          // panel; the transition queue never waits for the network.
          presentPrimaryPage('guide');
          void env.paidGuide.show({ ...paidAccount });
          env.paidGuide.focus();
        } else if (page === 'guide') await env.guide.open(query);
        else {
          presentPrimaryPage('watch');
          env.element('guide-button').focus({ preventScroll: true });
          if (env.library.contentLibrary === 'genxtra')
            await env.archiveSearch?.resume(env.libraryQueries.genxtra);
        }
        observePrimaryTransition('completed');
      } catch (error) {
        env.pageState.primaryTransitionErrorCount = Math.min(
          Number.MAX_SAFE_INTEGER,
          env.pageState.primaryTransitionErrorCount + 1,
        );
        observePrimaryTransition('failed', 'operation-failed');
        throw error;
      } finally {
        env.pageState.primaryTransitionPending--;
        env.pageState.primaryTransitionActiveIntent = 0;
      }
    });
    env.pageState.primaryTransitions = work.catch(() => undefined);
    return work;
  }
  return {
    primaryHost,
    switchPrimaryPage,
    presentPrimaryPage,
    updatePreviewControl,
  };
}
