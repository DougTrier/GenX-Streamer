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

import { createBootstrapRecoveryView } from './bootstrap-recovery-view';

export const bootstrapStages = [
  'module',
  'shell',
  'viewing-controls',
  'settings',
  'viewport',
  'playback',
  'preferences',
  'region',
  'sharing',
  'casting',
  'initialization',
] as const;
export type BootstrapStage = (typeof bootstrapStages)[number];
export type BootstrapReason =
  'none' | 'mount-failed' | 'startup-failed' | 'retry-failed' | 'close-failed';
export interface BootstrapSnapshot {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly stage: BootstrapStage;
  readonly phase:
    | 'loading'
    | 'mounted'
    | 'failed'
    | 'retrying'
    | 'closing'
    | 'ready'
    | 'closed'
    | 'disposing'
    | 'disposed';
  readonly reason: BootstrapReason;
  readonly pending: boolean;
  readonly errorCount: number;
  readonly canRetry: boolean;
  readonly canClose: boolean;
}
export interface BootstrapRecoveryActions {
  retry(): Promise<boolean>;
  close(): Promise<boolean>;
}
export interface BootstrapRecoveryView {
  render(snapshot: BootstrapSnapshot, actions: BootstrapRecoveryActions): void;
  dispose(): void;
}
export interface BootstrapBoundaryOptions {
  /** Only supply after owned partial mounts can be joined/disposed safely.
   * Resolution must mean the new bootstrap is actually ready, not just started. */
  retry?(): Promise<void>;
  /** Only supply a real joined close protocol; no fabricated ACK or force exit. */
  close?(): Promise<void>;
  view?: BootstrapRecoveryView;
  document?: Document;
}
export class BootstrapFailureError extends Error {
  constructor() {
    super('GenX Streamer could not finish opening.');
    this.name = 'BootstrapFailureError';
  }
}

/** No timers, global error listeners, automatic reloads or retained raw errors. */
export function createBootstrapBoundary(options: BootstrapBoundaryOptions = {}) {
  let stage: BootstrapStage = 'module';
  let phase: BootstrapSnapshot['phase'] = 'loading';
  let reason: BootstrapReason = 'none';
  let revision = 0,
    errorCount = 0;
  let action: 'retry' | 'close' | null = null;
  let pending: Promise<boolean> | null = null;
  let disposing = false;
  let disposal: Promise<void> | null = null;
  let view = options.view;
  const snapshot = (): BootstrapSnapshot =>
    Object.freeze({
      schemaVersion: 1,
      revision,
      stage,
      phase,
      reason,
      pending: pending !== null,
      errorCount,
      canRetry: !disposing && !pending && phase === 'failed' && !!options.retry,
      canClose: !disposing && !pending && phase === 'failed' && !!options.close,
    });
  const render = () => {
    if (
      phase === 'loading' ||
      phase === 'mounted' ||
      phase === 'ready' ||
      phase === 'closed' ||
      phase === 'disposed'
    )
      return;
    view ??= createBootstrapRecoveryView(options.document ?? document);
    view.render(snapshot(), { retry, close });
  };
  const checkStage = (value: BootstrapStage) => {
    if (!bootstrapStages.includes(value)) throw new BootstrapFailureError();
  };
  const fail = (
    value: BootstrapStage,
    failure: 'mount-failed' | 'startup-failed' = 'startup-failed',
  ) => {
    checkStage(value);
    if (failure !== 'mount-failed' && failure !== 'startup-failed')
      throw new BootstrapFailureError();
    if (disposing || phase === 'closed' || phase === 'disposed') return;
    stage = value;
    reason = failure;
    phase = 'failed';
    errorCount = Math.min(1000, errorCount + 1);
    revision++;
    render();
  };
  const ready = () => {
    if (disposing || phase === 'closed' || phase === 'disposed') return;
    phase = 'ready';
    reason = 'none';
    revision++;
    view?.dispose();
    view = undefined;
  };
  function operate(kind: 'retry' | 'close'): Promise<boolean> {
    if (pending) return action === kind ? pending : Promise.resolve(false);
    const hook = options[kind];
    if (disposing || phase !== 'failed' || !hook) return Promise.resolve(false);
    action = kind;
    phase = kind === 'retry' ? 'retrying' : 'closing';
    revision++;
    // Reserve before invoking a hook that can synchronously request another action.
    const work = Promise.resolve()
      .then(hook)
      .then(
        () => {
          if (!disposing) {
            phase = kind === 'retry' ? 'ready' : 'closed';
            reason = 'none';
            revision++;
            view?.dispose();
            view = undefined;
          }
          return true;
        },
        () => {
          if (!disposing) {
            phase = 'failed';
            reason = kind === 'retry' ? 'retry-failed' : 'close-failed';
            errorCount = Math.min(1000, errorCount + 1);
            revision++;
          }
          return false;
        },
      )
      .finally(() => {
        if (pending === work) {
          pending = null;
          action = null;
          revision++;
        }
        render();
      });
    pending = work;
    render();
    return work;
  }
  function retry() {
    return operate('retry');
  }
  function close() {
    return operate('close');
  }
  return {
    snapshot,
    fail,
    ready,
    /** Synchronous mounts finished. This does not assert storage/native readiness. */
    mounted() {
      if (disposing || phase !== 'loading') return;
      phase = 'mounted';
      revision++;
    },
    run<T>(value: BootstrapStage, mount: () => T): T {
      checkStage(value);
      if (disposing || phase !== 'loading') throw new BootstrapFailureError();
      stage = value;
      revision++;
      try {
        return mount();
      } catch (error) {
        try {
          fail(value, 'mount-failed');
        } catch {
          // Recovery presentation cannot replace the actual failing mount.
        }
        throw error;
      }
    },
    retry,
    close,
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposing = true;
      phase = 'disposing';
      revision++;
      const actual = pending;
      // The explicit host promise is joined, never raced against a deadline.
      disposal = Promise.resolve().then(async () => {
        await actual;
        view?.dispose();
        view = undefined;
        phase = 'disposed';
        revision++;
      });
      if (view) render();
      return disposal;
    },
  };
}
