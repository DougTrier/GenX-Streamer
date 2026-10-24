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
 * Share with everyone nearby: the temporary local download of GenX Streamer
 * (src-tauri/src/sharing/nearby_download.rs; docs/share-links.md).
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface NearbyStatus {
  active: boolean;
  /** http://<this device on the local network>:<port>/<secret>/ */
  url: string | null;
  expiresInMs: number;
  /** Devices that opened the page. */
  visitors: number;
  downloads: number;
  completed: number;
}

const count = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;

function status(raw: unknown): NearbyStatus {
  const r = (raw ?? {}) as Record<string, unknown>;
  const url =
    typeof r.url === 'string' && /^http:\/\/[0-9.]{7,15}:\d{1,5}\/[A-Za-z0-9_-]{22}\/$/u.test(r.url)
      ? r.url
      : null;
  return {
    active: r.active === true && url !== null,
    url,
    expiresInMs: count(r.expiresInMs),
    visitors: count(r.visitors),
    downloads: count(r.downloads),
    completed: count(r.completed),
  };
}

export const nearbyAvailable = () => isTauri();
export const startNearby = async () => status(await invoke('nearby_start'));
export const nearbyStatus = async () => status(await invoke('nearby_status'));
export const stopNearby = () => invoke<void>('nearby_stop');

/** Calls back when someone opens the page or downloads, and when the session ends. */
export function onNearbyChanged(callback: () => void): () => void {
  let stop: (() => void) | null = null;
  let disposed = false;
  void listen('nearby-share-changed', callback).then((unlisten) => {
    if (disposed) unlisten();
    else stop = unlisten;
  });
  return () => {
    disposed = true;
    stop?.();
  };
}
