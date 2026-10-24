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

import { invoke, isTauri } from '@tauri-apps/api/core';
export interface StorageRecoveryStatus {
  platform: 'windows' | 'android' | 'browser';
  available: boolean;
  state: 'healthy' | 'failed' | 'choosing';
  errorCategory?:
    'busy' | 'read-only' | 'unavailable' | 'invalid-data' | 'invalid-location' | 'internal';
  explicitEnvironment: boolean;
}
export interface StorageRecoveryOptions {
  retry(): Promise<void>;
  status?: () => Promise<StorageRecoveryStatus>;
  choose?: (path: string) => Promise<{ dataMode: 'explicit-directory'; restartPersistent: true }>;
  exit?: () => Promise<void>;
}
/** Startup recovery stays outside the inert viewing shell and never moves existing data. */
export function mountStorageRecovery(options: StorageRecoveryOptions): { dispose(): void } {
  const dialog = document.createElement('dialog');
  dialog.className = 'storage-recovery-dialog';
  dialog.setAttribute('aria-label', 'Saved data needs attention');
  const title = document.createElement('h2');
  title.textContent = 'Saved data needs attention';
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  message.textContent = 'Checking storage recovery options…';
  const explanation = document.createElement('p');
  explanation.textContent =
    'Your existing data is preserved. Choosing another folder uses its saved data or creates an empty library; it does not move or overwrite your previous library. This external storage choice is remembered for this executable location and is not fully portable.';
  const form = document.createElement('form');
  form.hidden = true;
  const label = document.createElement('label');
  label.textContent = 'Writable data folder';
  const path = document.createElement('input');
  path.type = 'text';
  path.required = true;
  path.maxLength = 4096;
  path.autocomplete = 'off';
  label.append(path);
  const choose = document.createElement('button');
  choose.type = 'submit';
  choose.textContent = 'Use this folder';
  form.append(label, explanation, choose);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Retry saved data';
  const exit = document.createElement('button');
  exit.type = 'button';
  exit.textContent = 'Exit app';
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  actions.append(retry, exit);
  const body = document.createElement('div');
  body.className = 'dialog-body';
  body.append(message, form);
  dialog.append(title, body, actions);
  document.body.append(dialog);
  dialog.showModal();
  let disposed = false;
  let busy = false;
  let libraryInUse = false;
  let epoch = 0;
  const setBusy = (value: boolean): void => {
    busy = value;
    choose.disabled = retry.disabled = value;
  };
  const current = (id: number): boolean => !disposed && epoch === id;
  const cancel = (event: Event): void => event.preventDefault();
  dialog.addEventListener('cancel', cancel);
  const readStatus: () => Promise<StorageRecoveryStatus> =
    options.status ??
    (async () =>
      isTauri()
        ? invoke<StorageRecoveryStatus>('storage_recovery_status')
        : ({
            platform: 'browser',
            available: false,
            state: 'failed',
            explicitEnvironment: false,
          } as const));
  const load = async (): Promise<void> => {
    const id = ++epoch;
    try {
      const status = await readStatus();
      if (!current(id)) return;
      if (
        !status ||
        !['windows', 'android', 'browser'].includes(status.platform) ||
        typeof status.available !== 'boolean' ||
        typeof status.explicitEnvironment !== 'boolean' ||
        !['healthy', 'failed', 'choosing'].includes(status.state)
      )
        throw new Error('Invalid recovery status');
      libraryInUse = status.errorCategory === 'busy';
      form.hidden = !(
        status.platform === 'windows' &&
        status.available &&
        !status.explicitEnvironment &&
        status.state === 'failed' &&
        !libraryInUse
      );
      exit.hidden = status.platform === 'browser';
      message.textContent = libraryInUse
        ? 'Saved data is in use. Close other apps using this library, then choose Retry saved data. Your library has not been replaced.'
        : status.explicitEnvironment
          ? 'The explicit TMG_DATA_DIR location could not open. Correct that location and restart; the app will not silently use another folder.'
          : status.platform === 'android'
            ? 'The app’s private storage could not open. Retry or restart the app. Do not clear its data to troubleshoot without a backup.'
            : status.platform === 'browser'
              ? 'Browser storage could not open. Retry, or close other GenX Streamer tabs before trying again.'
              : form.hidden
                ? 'Saved data could not open. Retry or restart the app.'
                : 'The chosen storage location could not open. Retry it or explicitly choose a writable folder.';
    } catch {
      if (current(id))
        message.textContent =
          'Storage recovery status is unavailable. Retry or restart the app; existing data has not been moved.';
    }
  };
  const apply = (event: Event): void => {
    event.preventDefault();
    if (busy || disposed || form.hidden) return;
    const selectedPath = path.value.trim();
    if (!selectedPath) return;
    const id = ++epoch;
    setBusy(true);
    message.textContent = 'Checking your selected data folder…';
    void (async () => {
      try {
        const result = await (
          options.choose ?? ((value) => invoke('choose_storage_directory', { path: value }))
        )(selectedPath);
        if (!current(id)) return;
        if (result?.dataMode !== 'explicit-directory' || result.restartPersistent !== true)
          throw new Error('Storage choice was not committed');
        message.textContent = 'Storage choice saved. Opening its library…';
        await options.retry();
        if (current(id)) {
          dialog.close();
          dialog.remove();
          disposed = true;
        }
      } catch {
        if (current(id))
          message.textContent =
            'That folder could not be used. Choose a writable local folder or retry your existing data. Previous data remains intact.';
      } finally {
        if (current(id)) setBusy(false);
      }
    })();
  };
  const tryAgain = (): void => {
    if (busy || disposed) return;
    const id = ++epoch;
    setBusy(true);
    void options
      .retry()
      .catch(() => {
        if (current(id))
          message.textContent = libraryInUse
            ? 'Saved data still could not open. Close other apps using this library, then retry.'
            : form.hidden
              ? 'Saved data still could not open. Retry or restart the app.'
              : 'Saved data still could not open. Retry or choose another writable folder.';
      })
      .finally(() => {
        if (current(id)) setBusy(false);
      });
  };
  const leave = (): void => {
    if (disposed) return;
    ++epoch;
    setBusy(true);
    void (options.exit ?? (() => invoke<void>('request_exit')))().catch(() => {
      if (!disposed) {
        setBusy(false);
        message.textContent = 'The app could not close yet. Retry Exit app.';
      }
    });
  };
  form.addEventListener('submit', apply);
  retry.addEventListener('click', tryAgain);
  exit.addEventListener('click', leave);
  void load();
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      ++epoch;
      form.removeEventListener('submit', apply);
      retry.removeEventListener('click', tryAgain);
      exit.removeEventListener('click', leave);
      dialog.removeEventListener('cancel', cancel);
      dialog.close();
      dialog.remove();
    },
  };
}
