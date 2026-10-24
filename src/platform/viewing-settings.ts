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
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';

/** How much a paid account's live stream buffers before and while playing. */
export type PlaybackBuffer = 'fast' | 'balanced' | 'smooth';
export interface ViewingSettings {
  /** One choice for every library: hide channels explicitly labeled adult. */
  hideAdult: boolean;
  /** Accounts without an entry use the balanced buffer. */
  accountBuffers: Readonly<Record<string, PlaybackBuffer>>;
}
const BUFFERS: readonly PlaybackBuffer[] = ['fast', 'balanced', 'smooth'];
const invalid = () => new Error('Viewing settings could not be read.');

export function validateViewingSettings(value: unknown): ViewingSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (
    keys.length !== 3 ||
    row.schemaVersion !== 1 ||
    typeof row.hideAdult !== 'boolean' ||
    !row.accountBuffers ||
    typeof row.accountBuffers !== 'object' ||
    Array.isArray(row.accountBuffers)
  )
    throw invalid();
  const accountBuffers: Record<string, PlaybackBuffer> = {};
  for (const [id, buffer] of Object.entries(row.accountBuffers)) {
    if (!/^[a-f0-9]{32}$/u.test(id) || !BUFFERS.includes(buffer as PlaybackBuffer)) throw invalid();
    accountBuffers[id] = buffer as PlaybackBuffer;
  }
  return { hideAdult: row.hideAdult, accountBuffers };
}

/** Native viewing choices with change notification; defaults apply until loaded. */
export function createViewingSettings(runtime?: OwnedNativeRuntime) {
  const native = runtime ?? {
    invoke: (command: string, args?: Record<string, unknown>) => {
      if (!isTauri())
        return Promise.reject(new Error('Settings require the installed application.'));
      return invoke(command, args);
    },
  };
  let current: ViewingSettings = { hideAdult: true, accountBuffers: {} };
  const listeners = new Set<(settings: ViewingSettings) => void>();
  const publish = (next: ViewingSettings) => {
    current = next;
    for (const listener of listeners) listener(current);
    return current;
  };
  const failure = (): never => {
    throw new Error('This setting could not be saved. Try again.');
  };
  // Writes run one at a time in call order, so the latest choice is the one
  // stored even when the viewer toggles quickly.
  let queue: Promise<unknown> = Promise.resolve();
  const write = (request: Record<string, unknown>): Promise<ViewingSettings> => {
    const work = queue
      .catch(() => undefined)
      .then(() =>
        invokeOwnedNative(
          native,
          'write_viewing_settings',
          { request: { schemaVersion: 1, ...request } },
          { validate: validateViewingSettings, failure },
        ),
      )
      .then(publish);
    queue = work;
    return work;
  };
  return {
    get current(): ViewingSettings {
      return current;
    },
    bufferFor(accountId: string): PlaybackBuffer {
      return current.accountBuffers[accountId] ?? 'balanced';
    },
    /** Reads stored choices in the same queue as writes, so a choice made
     *  while the first read is pending is applied after it and wins. */
    load(signal?: AbortSignal): Promise<ViewingSettings> {
      const work = queue
        .catch(() => undefined)
        .then(() =>
          invokeOwnedNative(
            native,
            'read_viewing_settings',
            {},
            {
              signal,
              validate: validateViewingSettings,
            },
          ),
        )
        .then(publish);
      queue = work;
      return work;
    },
    setHideAdult(hideAdult: boolean): Promise<ViewingSettings> {
      return write({ hideAdult });
    },
    setBuffer(accountId: string, buffer: PlaybackBuffer): Promise<ViewingSettings> {
      if (!/^[a-f0-9]{32}$/u.test(accountId) || !BUFFERS.includes(buffer))
        return Promise.reject(invalid());
      return write({ accountId, buffer });
    },
    /** Called with every change; returns the unsubscribe function. */
    subscribe(listener: (settings: ViewingSettings) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
/** The application's single store (Settings, channel lists and the player share it). */
export const viewingSettings = createViewingSettings();
