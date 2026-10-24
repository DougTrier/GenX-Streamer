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
 * The system share sheet and incoming links, as the native layer offers them
 * (src-tauri/src/sharing/share_links.rs, SharePlugin.kt; docs/share-links.md).
 * A shown share sheet is not proof that anything was sent.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const androidApp = () => isTauri() && /Android/i.test(navigator.userAgent);

/** A refusal's fixed code (share-…), never a platform error's text. */
export function shareFailureCode(error: unknown): string {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return /^share-[a-z-]{1,58}$/u.test(text) ? text : 'share-unavailable';
}

/** Opens the share sheet with a message. Outside the app, the browser's own share where it has one. */
export async function shareText(title: string, text: string): Promise<void> {
  if (isTauri()) {
    await invoke('share_text', { title, text });
    return;
  }
  if (typeof navigator.share !== 'function') throw new Error('share-unavailable');
  await navigator.share({ title, text });
}

/** Shares the installed app itself: the APK (Android) or GenX Streamer.exe (Windows). */
export async function shareAppFile(title: string, text: string): Promise<void> {
  if (!isTauri()) throw new Error('share-app-unavailable');
  await invoke('share_app_file', { title, text });
}

/** Puts text on the clipboard; false when the system refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Whether a shared stream's or logo's server is on the public internet (native DNS check). */
export async function checkSharedDestination(url: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('check_shared_destination', { url });
}

/** The link GenX was opened with, or the newest since; each is given out once. */
export async function takeIncomingLink(): Promise<string | null> {
  if (!isTauri()) return null;
  const link = await invoke<string | null>('take_incoming_link');
  return typeof link === 'string' ? link : null;
}

/** Calls back whenever a link arrives while GenX runs; returns the clean-up. */
export function onIncomingLink(callback: () => void): () => void {
  if (!isTauri()) return () => undefined;
  // Android tells the page with a window event; Windows with an app event.
  window.addEventListener('native-incoming-link', callback);
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void listen('incoming-link', callback).then((stop) => {
    if (disposed) stop();
    else unlisten = stop;
  });
  return () => {
    disposed = true;
    window.removeEventListener('native-incoming-link', callback);
    unlisten?.();
  };
}
