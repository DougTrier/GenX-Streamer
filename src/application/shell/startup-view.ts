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

import { createStartupObserver as observe, type StartupAttempt } from './startup-observer';
import { createStartupStatus, type StartupStatusView } from '../../ui/startup-status';
export type { StartupAttempt } from './startup-observer';

interface StartupViewOptions {
  view?: () => StartupStatusView;
  lifecycle?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/** Presentation only: the original observer remains the sole stage/outcome authority. */
export function createStartupObserver(clock?: () => number, options: StartupViewOptions = {}) {
  const observer = observe(clock);
  const lifecycle = options.lifecycle ?? (typeof window === 'undefined' ? undefined : window);
  const makeView = options.view ?? (() => createStartupStatus(document));
  let view: StartupStatusView | undefined;
  let listening = false;
  let closed = false;
  const release = () => {
    // A presentation failure must never replace an operation's result or error.
    try {
      view?.dispose();
    } catch {
      /* Keep the saved-data owner authoritative. */
    }
    view = undefined;
    if (listening) lifecycle?.removeEventListener('pagehide', pagehide);
    listening = false;
  };
  const pagehide = () => {
    closed = true;
    release();
  };
  const render = (generation: number) => {
    const snapshot = observer.snapshot();
    if (!closed && snapshot.generation === generation) {
      try {
        view?.render(snapshot);
      } catch {
        /* No raw presentation errors enter startup metadata. */
      }
    }
  };
  return {
    begin(): StartupAttempt {
      release();
      const attempt = observer.begin();
      const generation = observer.snapshot().generation;
      if (!closed) {
        try {
          view = makeView();
        } catch {
          /* Readiness still comes from the checked startup. */
        }
        lifecycle?.addEventListener('pagehide', pagehide);
        listening = !!lifecycle;
        render(generation);
      }
      return {
        async run(stage, operation) {
          try {
            return await attempt.run(stage, () => {
              render(generation);
              return operation();
            });
          } finally {
            render(generation);
          }
        },
        finish(state) {
          attempt.finish(state);
          render(generation);
          if (observer.snapshot().generation === generation && state !== 'failed') release();
        },
      };
    },
    snapshot: observer.snapshot,
  };
}
