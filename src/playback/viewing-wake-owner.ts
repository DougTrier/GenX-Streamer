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

export interface ViewingWakeReceipt {
  schemaVersion: 1;
  adapterVersion: 'viewing-wake-v1';
  requestedActive: boolean;
  foreground: boolean;
  windowKeepScreenOn: boolean | null;
  webViewKeepScreenOn: boolean | null;
  decorKeepScreenOn: boolean | null;
  platform: 'android' | 'windows' | 'unsupported';
}
export interface ViewingWakeSnapshot {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly wanted: boolean;
  readonly foreground: boolean;
  readonly closing: boolean;
  readonly acknowledged: boolean | null;
  readonly pending: boolean;
  readonly closingPending: boolean;
  readonly failed: boolean;
  readonly currentAttempt: number;
  readonly stage: 'idle' | 'dispatching' | 'receipt' | 'failed';
  readonly receipt: Readonly<ViewingWakeReceipt> | null;
}
export function validateViewingWakeReceipt(value: unknown, requested: boolean): ViewingWakeReceipt {
  const receipt = value as ViewingWakeReceipt | null;
  const bit = (value: unknown) => value === null || typeof value === 'boolean';
  if (
    !receipt ||
    receipt.schemaVersion !== 1 ||
    receipt.adapterVersion !== 'viewing-wake-v1' ||
    receipt.requestedActive !== requested ||
    typeof receipt.foreground !== 'boolean' ||
    !['android', 'windows', 'unsupported'].includes(receipt.platform) ||
    !bit(receipt.windowKeepScreenOn) ||
    !bit(receipt.webViewKeepScreenOn) ||
    !bit(receipt.decorKeepScreenOn) ||
    (receipt.platform === 'android' && typeof receipt.windowKeepScreenOn !== 'boolean')
  )
    throw new Error('Screen wake acknowledgement was invalid.');
  return Object.freeze({
    schemaVersion: 1,
    adapterVersion: 'viewing-wake-v1',
    requestedActive: receipt.requestedActive,
    foreground: receipt.foreground,
    windowKeepScreenOn: receipt.windowKeepScreenOn,
    webViewKeepScreenOn: receipt.webViewKeepScreenOn,
    decorKeepScreenOn: receipt.decorKeepScreenOn,
    platform: receipt.platform,
  });
}
export function createViewingWakeOwner(options: {
  send(active: boolean): Promise<unknown>;
  onError?(message: string): void;
}) {
  let wanted = false,
    foreground = true,
    closing = false,
    revision = 0;
  let acknowledged: boolean | null = null;
  let failed: Error | null = null;
  let pending: Promise<void> | null = null;
  let closingPromise: Promise<void> | null = null;
  let receipt: ViewingWakeReceipt | null = null;
  let currentAttempt = 0;
  let stage: ViewingWakeSnapshot['stage'] = 'idle';
  const pump = (): Promise<void> => {
    if (pending) return pending;
    if (failed) return Promise.reject(failed);
    if (acknowledged === wanted) return Promise.resolve();
    // A requested initial disable cannot be coalesced away before its first call.
    let firstDisable = acknowledged === null && !wanted;
    const firstVersion = revision;
    const work = Promise.resolve().then(async () => {
      while (firstDisable || acknowledged !== wanted) {
        const active = firstDisable ? false : wanted,
          version = firstDisable ? firstVersion : revision;
        firstDisable = false;
        try {
          currentAttempt++;
          stage = 'dispatching';
          const observed = validateViewingWakeReceipt(await options.send(active), active);
          receipt = observed;
          stage = 'receipt';
          if (
            observed.platform === 'android' &&
            (!active || !observed.foreground) &&
            [
              observed.windowKeepScreenOn,
              observed.webViewKeepScreenOn,
              observed.decorKeepScreenOn,
            ].includes(true)
          )
            throw new Error('Screen wake disable could not be confirmed.');
          if (
            active &&
            observed.platform === 'android' &&
            (!observed.foreground || !observed.windowKeepScreenOn)
          )
            throw new Error('Screen wake enable could not be confirmed.');
          // A lifecycle barrier requires a receipt issued for that barrier,
          // even if an older in-flight disable settles after the edge.
          acknowledged = version === revision ? active : null;
        } catch {
          acknowledged = null;
          if (version !== revision) continue;
          failed = new Error('Screen wake policy could not be confirmed. Retry the action.');
          stage = 'failed';
          options.onError?.(failed.message);
          throw failed;
        }
      }
    });
    pending = work;
    void work.then(
      () => {
        if (pending === work) pending = null;
      },
      () => {
        if (pending === work) pending = null;
      },
    );
    return work;
  };
  const setActive = (active: boolean): Promise<void> => {
    if (active && closing) return Promise.reject(new Error('Screen wake owner is closing.'));
    const next = active && foreground && !closing;
    if (wanted !== next) {
      wanted = next;
      revision++;
      failed = null;
    }
    return pump();
  };
  const freeze = () => {
    if (closing) return;
    closing = true;
    wanted = false;
    revision++;
    acknowledged = null;
    failed = null;
  };
  return {
    snapshot(): ViewingWakeSnapshot {
      return Object.freeze({
        schemaVersion: 1,
        revision,
        wanted,
        foreground,
        closing,
        acknowledged,
        pending: pending !== null,
        closingPending: closingPromise !== null && pending !== null,
        failed: failed !== null,
        currentAttempt,
        stage,
        receipt,
      });
    },
    setActive,
    setForeground(active: boolean): Promise<void> {
      if (closing || foreground === active) return pump();
      foreground = active;
      wanted = false;
      revision++;
      acknowledged = null;
      failed = null;
      // Each genuine lifecycle edge rechecks disable; return never restores true.
      return pump();
    },
    retry(): Promise<void> {
      failed = null;
      revision++;
      return pump();
    },
    freeze,
    close(): Promise<void> {
      if (closingPromise) return closingPromise;
      freeze();
      failed = null;
      const work = pump();
      closingPromise = work;
      void work.catch(() => {
        if (closingPromise === work) closingPromise = null;
      });
      return work;
    },
    get receipt(): ViewingWakeReceipt | null {
      return receipt;
    },
  };
}

/** Independent lifecycle signals must both permit foreground work. */
export function createViewingForegroundAdmission(apply: (foreground: boolean) => Promise<void>) {
  let nativeForeground = true;
  let documentVisible = true;
  return {
    setNativeForeground(active: boolean): Promise<void> {
      nativeForeground = active;
      return apply(nativeForeground && documentVisible);
    },
    setDocumentVisible(active: boolean): Promise<void> {
      documentVisible = active;
      return apply(nativeForeground && documentVisible);
    },
    get admitted(): boolean {
      return nativeForeground && documentVisible;
    },
  };
}
