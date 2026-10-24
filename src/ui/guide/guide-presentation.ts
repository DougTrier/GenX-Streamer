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

import {
  type AutomaticGuideBuildProgress,
  type AutomaticGuideBuildResult,
} from '../../guide/automatic-build';
import { GUIDE_SOURCE_LIMIT } from '../../guide/limits';
import { type createSelectedGuideOwner } from '../../application/guide/selected-guide';
import { type GuideHost } from './guide-model';

/** What this part reads from, and writes back to, mountGuide. */
export interface GuidePresentationEnvironment {
  automaticPending: boolean;
  readonly automaticStatus: HTMLElement;
  readonly controls: () => void;
  readonly disposed: boolean;
  suspending: boolean;
  foreground: boolean;
  busy: boolean;
  committing: boolean;
  readonly error: HTMLElement;
  actionController: AbortController | null;
  actionWork: Promise<void>;
  suspension: Promise<void> | null;
  summaryKey: string;
  summaryGeneration: number;
  readonly summaryOwner: ReturnType<typeof createSelectedGuideOwner>;
  viewEpoch: number;
  lookupEpoch: number;
  readonly viewController: AbortController | null;
  readonly lookupController: AbortController | null;
  readonly viewWork: Promise<void>;
  readonly lookupWork: Promise<void>;
  readonly timeline: {
    refresh(): Promise<void>;
    refreshArtwork: () => void;
    closeDetails: () => boolean;
    setForeground(value: boolean): Promise<void>;
    suspend: () => Promise<void>;
    dispose(): Promise<void>;
  } | null;
  readonly host: GuideHost;
  readonly status: HTMLElement;
  closing: Promise<void> | null;
  presentationEpoch: number;
  opening: Promise<void> | null;
  readonly discard: () => Promise<void>;
  readonly dialog: HTMLDialogElement;
  pagePresented: boolean;
  readonly returnFocus: HTMLElement | null;
  readonly container: HTMLElement;
  readonly reload: (continuation?: boolean) => void;
}

/**
 * Opening, suspending and closing the guide, and its automatic update
 * progress. Part of mountGuide.
 */
export function createGuidePresentation(env: GuidePresentationEnvironment) {
  function automaticMessage(message: string, pending = false): void {
    env.automaticPending = pending;
    env.automaticStatus.textContent = message;
    env.automaticStatus.hidden = !message;
    env.controls();
  }
  function automaticResult(result: Readonly<AutomaticGuideBuildResult>): void {
    const maintenance =
      result.maintenance === 'reopen-required'
        ? ' Storage verification failed. Close and reopen the app before continuing.'
        : result.maintenance === 'failed' || result.maintenance === 'deferred'
          ? ' Storage optimization is pending; saved guide results remain available.'
          : '';
    automaticMessage(
      `Guide check finished${result.failed ? ` · ${result.failed} could not be checked` : ''}${result.discoveryFailed ? ` · ${result.discoveryFailed} playlists could not be checked` : ''}${result.skipped ? ` · ${result.skipped} skipped` : ''}.${result.failed || result.discoveryFailed || result.skipped ? ' Previous schedules retained; try Find again.' : ' Schedule availability is shown per channel.'}${maintenance}`,
    );
  }
  function presentAutomaticProgress(progress: Readonly<AutomaticGuideBuildProgress>): void {
    if (env.disposed || env.suspending || !env.foreground) return;
    if (
      ![progress.total, progress.attempted].every(
        (count) => Number.isSafeInteger(count) && count >= 0 && count <= GUIDE_SOURCE_LIMIT,
      ) ||
      progress.attempted > progress.total ||
      ![progress.failed, progress.skipped, progress.discoveryFailed ?? 0].every(
        (count) => Number.isSafeInteger(count) && count >= 0 && count <= 100_000,
      )
    )
      return;
    const phases: Record<AutomaticGuideBuildProgress['phase'], string> = {
      capturing: 'Preparing guide check',
      'reading-playlists': 'Reading playlist guide links',
      'checking-cache': 'Checking saved schedules',
      fetching: 'Fetching schedules',
      publishing: 'Saving checked schedules',
      connecting: 'Linking channel guides',
      optimizing: 'Optimizing saved guides',
      completed: 'Guide check finished',
    };
    if (!phases[progress.phase]) return;
    if (progress.phase === 'completed') {
      automaticResult(progress);
      return;
    }
    automaticMessage(
      `${phases[progress.phase]}${progress.total ? ` · ${progress.attempted} of ${progress.total} feeds settled` : ''}${progress.failed ? ` · ${progress.failed} could not be checked` : ''}${progress.discoveryFailed ? ` · ${progress.discoveryFailed} playlists could not be checked` : ''}${progress.skipped ? ` · ${progress.skipped} skipped` : ''}`,
      true,
    );
  }
  function run(
    operation: (signal: AbortSignal) => Promise<void>,
    commit = false,
    closeAfter = false,
  ): void {
    if (env.disposed || env.suspending || !env.foreground || env.busy) return;
    env.busy = true;
    env.committing = commit;
    env.error.textContent = '';
    const controller = new AbortController();
    env.actionController = controller;
    env.controls();
    env.actionWork = (async () => {
      try {
        await operation(controller.signal);
        if (closeAfter && !env.disposed && !controller.signal.aborted) await closeGuide(true);
      } catch {
        if (env.automaticPending) automaticMessage('');
        if (!env.disposed)
          env.error.textContent = controller.signal.aborted
            ? 'Operation canceled. Saved source configuration and previous schedule are retained.'
            : 'Guide action failed. Previous schedule retained; retry or review the source and mapping.';
      } finally {
        env.busy = false;
        env.committing = false;
        env.actionController = null;
        if (!env.disposed) env.controls();
      }
    })();
  }
  function suspend(): Promise<void> {
    // A second background signal must revoke a foreground intent even while
    // the first suspension is still joining the same actual operations.
    env.foreground = false;
    if (env.suspension) return env.suspension;
    if (env.disposed) return Promise.resolve();
    env.suspending = true;
    env.summaryKey = '';
    ++env.summaryGeneration;
    const summaryDrain = env.summaryOwner.suspend();
    const publication = env.committing;
    ++env.viewEpoch;
    ++env.lookupEpoch;
    env.viewController?.abort();
    env.lookupController?.abort();
    if (!publication) env.actionController?.abort();
    // A publication that already crossed its atomic boundary wins cancellation.
    // Keep the suspension gate until every owned promise settles so its reload
    // cannot silently restart activity in the background.
    env.suspension = Promise.allSettled([
      env.viewWork,
      env.lookupWork,
      env.actionWork,
      summaryDrain,
      env.timeline?.suspend(),
    ])
      .then(async (settled) => {
        await env.host.settleMappingHydration?.();
        const failures = settled.filter((result) => result.status === 'rejected');
        if (failures.length) throw new Error('Guide activity cleanup could not be confirmed.');
        if (!env.disposed && !publication && !env.foreground) {
          if (env.automaticPending) automaticMessage('');
          env.error.textContent = '';
          env.status.textContent = 'Guide activity paused in the background. Retry when ready.';
          env.controls();
        }
      })
      .finally(() => {
        env.suspending = false;
        env.suspension = null;
      });
    return env.suspension;
  }
  function closeGuide(skipAction = false): Promise<void> {
    if (!skipAction && env.closing) return env.closing;
    if (env.committing) return Promise.reject(new Error('Guide publication is still settling.'));
    ++env.presentationEpoch;
    const attempt = drainAndHide(skipAction);
    if (!skipAction) {
      env.closing = attempt;
      const settled = () => {
        if (env.closing === attempt) env.closing = null;
      };
      void attempt.then(settled, settled);
    }
    return attempt;
  }
  async function drainAndHide(skipAction: boolean, skipOpening = false): Promise<void> {
    if (!skipOpening) await env.opening;

    env.viewController?.abort();
    env.lookupController?.abort();
    if (!skipAction) env.actionController?.abort();
    env.summaryKey = '';
    ++env.summaryGeneration;
    const settled = await Promise.allSettled([
      env.viewWork,
      env.lookupWork,
      skipAction ? Promise.resolve() : env.actionWork,
      env.summaryOwner.setSelection(null),
      env.timeline?.suspend(),
    ]);
    if (settled.some((result) => result.status === 'rejected'))
      throw new Error('Guide activity cleanup could not be confirmed.');
    await env.host.settleMappingHydration?.();
    await env.discard();
    if (!env.disposed) {
      const wasOpen = env.dialog.open;
      env.dialog.close();
      env.dialog.removeAttribute('data-primary-page');
      if (env.pagePresented) {
        await env.host.closed?.();
        env.pagePresented = false;
      }
      if (wasOpen) env.returnFocus?.focus();
    }
  }
  function openPresentation(page: boolean, configure: () => void): Promise<void> {
    if (env.disposed) return Promise.resolve();
    const epoch = ++env.presentationEpoch;
    const prior = env.opening;
    const drain = env.closing;
    const attempt = (async () => {
      if (prior) await prior;
      if (drain) await drain;
      if (env.disposed || epoch !== env.presentationEpoch) return;
      if (
        (env.dialog.open && env.pagePresented !== page) ||
        (!env.dialog.open && env.pagePresented)
      ) {
        await drainAndHide(false, true);
        if (env.disposed || epoch !== env.presentationEpoch) return;
      }
      configure();
      if (!env.dialog.open) {
        if (page) {
          env.container.append(env.dialog);
          env.dialog.dataset.primaryPage = 'guide';
          env.dialog.show();
          env.pagePresented = true;
          await env.host.opened?.();
        } else {
          if (env.host.presentation === 'page') env.container.ownerDocument.body.append(env.dialog);
          env.dialog.removeAttribute('data-primary-page');
          env.dialog.showModal();
        }
      }
      if (!env.disposed && epoch === env.presentationEpoch && !env.closing && env.dialog.open)
        env.reload();
    })();
    env.opening = attempt;
    const settled = () => {
      if (env.opening === attempt) env.opening = null;
    };
    void attempt.then(settled, settled);
    return attempt;
  }
  return {
    closeGuide,
    run,
    automaticMessage,
    automaticResult,
    suspend,
    openPresentation,
    presentAutomaticProgress,
  };
}
