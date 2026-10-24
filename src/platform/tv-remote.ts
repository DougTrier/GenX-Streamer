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
 * Install on TV, as the native layer offers it (src-tauri/src/sharing/send_to_tv.rs,
 * TvRemotePlugin.kt; docs/send-to-tv.md). Android only.
 */
import { invoke } from '@tauri-apps/api/core';

export interface FoundTv {
  name: string;
  host: string;
}

export interface TvStatus {
  connected: boolean;
  model: string;
  /** The package name of the app in front of the TV ('' until the TV says). */
  frontApp: string;
  changes: number;
}

const text = (value: unknown, max: number) =>
  typeof value === 'string' ? value.slice(0, max) : '';

function tvStatus(raw: unknown): TvStatus {
  const r = (raw ?? {}) as Record<string, unknown>;
  const front = text(r.frontApp, 200);
  return {
    connected: r.connected === true,
    model: text(r.model, 80),
    frontApp: /^[A-Za-z0-9_.]*$/u.test(front) ? front : '',
    changes: Number.isSafeInteger(r.changes) ? Number(r.changes) : 0,
  };
}

/** A refusal's fixed code (tv-…, or the nearby share's own), never a platform error's text. */
export function tvFailureCode(error: unknown): string {
  const code = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return /^(?:tv|nearby|share)-[a-z-]{1,40}$/u.test(code) ? code : 'tv-unavailable';
}

export async function findTvs(): Promise<FoundTv[]> {
  const raw = (await invoke('tv_find')) as { tvs?: unknown };
  const tvs = Array.isArray(raw?.tvs) ? raw.tvs : [];
  return tvs
    .map((tv) => ({ name: text(tv?.name, 80) || 'TV', host: text(tv?.host, 15) }))
    .filter((tv) => /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(tv.host))
    .slice(0, 16);
}

export const startPairing = (tv: FoundTv) =>
  invoke<void>('tv_pair_start', { host: tv.host, name: tv.name });
export const finishPairing = (code: string) => invoke<void>('tv_pair_finish', { code });
export const connectTv = async (tv: FoundTv) => tvStatus(await invoke('tv_connect', { host: tv.host }));
export const sendGenX = async () => tvStatus(await invoke('tv_send_genx'));
export const openHelperStore = async () => tvStatus(await invoke('tv_get_helper'));
export const openGenXOnTv = async () => tvStatus(await invoke('tv_open_genx'));
export const readTvStatus = async () => tvStatus(await invoke('tv_status'));
export const disconnectTv = () => invoke<void>('tv_disconnect');
export const forgetTvs = () => invoke<void>('tv_forget');
