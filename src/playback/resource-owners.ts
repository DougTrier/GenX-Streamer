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

export const resourceKinds = [
  'controllerEngines',
  'controllerTimers',
  'controllerListeners',
  'decodedObservers',
  'browserEngines',
  'videoListeners',
  'abortListeners',
  'hlsInstances',
  'hlsListeners',
  'initializationWaits',
  'nativeLoaders',
  'nativeLoads',
  'nativeCancels',
  'loaderTimers',
  'drainTimers',
] as const;
export type ResourceKind = (typeof resourceKinds)[number];
export type ResourceDomain = 'controller' | 'browser-engine' | 'native-loader' | 'abort-signals';
type Counts = Readonly<Record<ResourceKind, number>>;
export interface ResourceOwnerSnapshot {
  schemaVersion: 1;
  coveredDomains: readonly ResourceDomain[];
  counts: Counts;
  highWater: Counts;
  acquired: Counts;
  released: Counts;
}
export interface ResourceOwners {
  acquire(kind: ResourceKind): () => void;
  cover(domain: ResourceDomain): void;
  snapshot(): ResourceOwnerSnapshot;
}
const counts = (): Record<ResourceKind, number> =>
  Object.fromEntries(resourceKinds.map((kind) => [kind, 0])) as Record<ResourceKind, number>;

/** Only application handle ownership. No IDs, media data or browser-internal resource claims. */
export function createResourceOwners(): ResourceOwners {
  const current = counts(),
    highWater = counts(),
    acquired = counts(),
    released = counts();
  const coverage = new Set<ResourceDomain>();
  return {
    acquire(kind) {
      current[kind]++;
      acquired[kind]++;
      highWater[kind] = Math.max(highWater[kind], current[kind]);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        current[kind]--;
        released[kind]++;
      };
    },
    cover: (domain) => {
      coverage.add(domain);
    },
    snapshot: () =>
      Object.freeze({
        schemaVersion: 1 as const,
        coveredDomains: Object.freeze([...coverage].sort()),
        counts: Object.freeze({ ...current }),
        highWater: Object.freeze({ ...highWater }),
        acquired: Object.freeze({ ...acquired }),
        released: Object.freeze({ ...released }),
      }),
  };
}
export const playbackResourceOwners = createResourceOwners();

/** Joins actual promises; a failed wait removes its timer/waiter, never the pending work. */
export function createOwnedWork(owners: ResourceOwners) {
  const pending = new Set<object>();
  const waiters = new Set<() => void>();
  return {
    pending: () => pending.size,
    run<T>(kind: ResourceKind, operation: () => Promise<T>): Promise<T> {
      const release = owners.acquire(kind);
      const token = {};
      pending.add(token);
      let result: Promise<T>;
      try {
        result = operation();
      } catch (error) {
        result = Promise.reject(error);
      }
      return Promise.resolve(result).finally(() => {
        pending.delete(token);
        release();
        for (const check of [...waiters]) check();
      });
    },
    settled(timeoutMs = 5000): Promise<void> {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000)
        return Promise.reject(new Error('Playback cleanup deadline is invalid.'));
      if (!pending.size) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const releaseTimer = owners.acquire('drainTimers');
        const finish = () => {
          clearTimeout(timer);
          releaseTimer();
          waiters.delete(check);
        };
        const check = () => {
          if (!pending.size) {
            finish();
            resolve();
          }
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error('Playback transport cleanup did not settle in time.'));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
  };
}
