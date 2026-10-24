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
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { boundedUtf8Text } from './bounded-text';

export interface GrabberExport {
  readonly xml: string;
  readonly channels: number;
  readonly unmatched: number;
  readonly sites: readonly { readonly site: string; readonly channels: number }[];
  readonly source: string;
}
const SOURCE = 'https://iptv-org.github.io/api/guides.json';
export const GRABBER_FILENAME = 'genx-guide-channels.xml';

export function validateGrabberExport(value: unknown): GrabberExport {
  if (!value || typeof value !== 'object') throw new Error('Guide channel list is invalid.');
  const reply = value as Record<string, unknown>;
  const count = (n: unknown) =>
    Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 100_000;
  if (
    !boundedUtf8Text(reply.xml, 8 * 1024 * 1024) ||
    !reply.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n') ||
    !reply.xml.endsWith('</channels>\n') ||
    !count(reply.channels) ||
    !count(reply.unmatched) ||
    reply.source !== SOURCE ||
    !Array.isArray(reply.sites) ||
    reply.sites.length > 1000 ||
    !reply.sites.every(
      (s) =>
        !!s &&
        typeof s === 'object' &&
        boundedUtf8Text((s as Record<string, unknown>).site, 128) &&
        count((s as Record<string, unknown>).channels),
    )
  )
    throw new Error('Guide channel list is invalid.');
  return Object.freeze({
    xml: reply.xml,
    channels: reply.channels as number,
    unmatched: reply.unmatched as number,
    sites: Object.freeze((reply.sites as GrabberExport['sites']).map((s) => ({ ...s }))),
    source: SOURCE,
  });
}

export function grabberSummary(result: GrabberExport, saved: boolean): string {
  if (!result.channels)
    return 'None of your saved channels has a published grabber listing. Nothing was saved.';
  const top = result.sites
    .slice(0, 3)
    .map((s) => `${s.site} (${s.channels})`)
    .join(', ');
  return `${saved ? 'Saved' : 'Prepared'} ${result.channels} channels for the iptv-org grabber using ${top}${
    result.sites.length > 3 ? ' and others' : ''
  }. ${result.unmatched} saved channels have no listing. Run the grabber with --days=7, then add its guide.xml address under Program guide settings.`;
}

/** Explicit Settings action: build, then save only to a user-picked file. */
export async function exportGrabberChannels(
  signal: AbortSignal,
): Promise<{ result: GrabberExport; saved: boolean }> {
  signal.throwIfAborted();
  if (!isTauri()) throw new Error('The guide channel list needs the installed app.');
  const requestId = `grabber-${crypto.randomUUID()}`;
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => {
    cancellation ??= invoke('cancel_playlist', { requestId }).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  let result: GrabberExport;
  try {
    result = validateGrabberExport(await invoke<unknown>('guide_grabber_channels', { requestId }));
  } finally {
    signal.removeEventListener('abort', cancel);
    if (cancellation) await cancellation;
  }
  signal.throwIfAborted();
  if (!result.channels) return { result, saved: false };
  const destination = await save({
    title: 'Save guide grabber channel list',
    defaultPath: GRABBER_FILENAME,
    filters: [{ name: 'iptv-org grabber channels', extensions: ['xml'] }],
  });
  if (destination === null || signal.aborted) return { result, saved: false };
  if (!boundedUtf8Text(destination, 16_384) || /[\r\n]/u.test(destination))
    throw new Error('The chosen file location is invalid.');
  await writeTextFile(destination, result.xml);
  return { result, saved: true };
}
