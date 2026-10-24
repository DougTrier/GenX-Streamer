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
 * Voluntary updates, as the native layer offers them
 * (src-tauri/src/platform/app_update.rs, AppUpdatePlugin.kt; docs/updates.md).
 * Each call is one choice the viewer made: check, download, install, restart.
 * The native layer chooses the release file and its address; nothing here
 * can name another.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface AvailableRelease {
  version: string;
  title: string;
  /** Plain text; shown as text, never as markup. */
  notes: string;
  published: string | null;
  releasePage: string | null;
  bytes: number;
}
export interface UpdateCheck {
  installed: string;
  latest: AvailableRelease | null;
  newer: boolean;
}
export interface InstallReceipt {
  installerOpened: boolean;
  restartRequired: boolean;
}

const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/u;

/** A refusal's fixed code (update-…), never a platform error's text. */
export function updateFailureCode(error: unknown): string {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return /^(?:update-[a-z-]{1,58}|application-closing)$/u.test(text) ? text : 'update-unavailable';
}

function release(value: unknown): AvailableRelease | null {
  if (value === null) return null;
  const r = value as Record<string, unknown>;
  if (
    !r ||
    typeof r.version !== 'string' ||
    !VERSION.test(r.version) ||
    typeof r.title !== 'string' ||
    typeof r.notes !== 'string' ||
    (r.published !== null && typeof r.published !== 'string') ||
    (r.releasePage !== null &&
      (typeof r.releasePage !== 'string' ||
        !r.releasePage.startsWith('https://github.com/DougTrier/GenX-Streamer/releases/'))) ||
    !Number.isSafeInteger(r.bytes) ||
    Number(r.bytes) < 0
  )
    throw new Error('update-release-invalid');
  return {
    version: r.version,
    title: r.title.slice(0, 200),
    notes: r.notes.slice(0, 4000),
    published: (r.published as string | null) ?? null,
    releasePage: (r.releasePage as string | null) ?? null,
    bytes: Number(r.bytes),
  };
}

export const updatesAvailable = () => isTauri();

/** Asks GitHub for the latest official release (only when the viewer chooses Check). */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const raw = (await invoke<unknown>('update_check')) as Record<string, unknown>;
  if (!raw || typeof raw.installed !== 'string' || typeof raw.newer !== 'boolean')
    throw new Error('update-release-invalid');
  return { installed: raw.installed, latest: release(raw.latest ?? null), newer: raw.newer };
}

/** Downloads the checked release's file for this device and verifies its digest. */
export async function downloadUpdate(
  version: string,
  progress: (received: number, total: number) => void,
): Promise<void> {
  const stop = await listen<{ received: number; total: number }>('update-progress', (event) => {
    const { received, total } = event.payload ?? {};
    if (Number.isSafeInteger(received) && Number.isSafeInteger(total) && total > 0)
      progress(received, total);
  });
  try {
    await invoke('update_download', { version });
  } finally {
    stop();
  }
}

export const cancelUpdateDownload = () => invoke<void>('update_cancel');

/** Windows: puts the new exe in place. Android: opens Android's installer. */
export async function installUpdate(version: string): Promise<InstallReceipt> {
  const raw = (await invoke<unknown>('update_install', { version })) as Record<string, unknown>;
  return {
    installerOpened: raw?.installerOpened === true,
    restartRequired: raw?.restartRequired === true,
  };
}

/** Windows: the new version starts once GenX has closed the ordinary way. */
export const requestUpdateRestart = () => invoke<void>('update_restart');
