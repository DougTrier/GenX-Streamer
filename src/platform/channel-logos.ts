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
import { boundedUtf8Text } from './bounded-text';
export interface ChannelLogoImage {
  channelId: string;
  providerId: string;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  byteLength: number;
  dataUrl: string;
}
export interface ChannelLogoReply {
  schemaVersion: 1;
  catalogRevision: string;
  attemptedChannelIds: string[];
  images: ChannelLogoImage[];
}
export const logoRevision = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v);
const invalid = () => new Error('Channel artwork could not be verified.');
const text = (v: unknown, limit: number): v is string =>
  typeof v === 'string' && v.length > 0 && boundedUtf8Text(v, limit);
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).length !== keys.length ||
    keys.some((k) => !descriptors[k] || !Object.hasOwn(descriptors[k], 'value'))
  )
    throw invalid();
  return value as Record<string, unknown>;
}
export function validateChannelLogos(
  value: unknown,
  ids: readonly string[],
  revision: string,
): ChannelLogoReply {
  const reply = record(value, [
    'schemaVersion',
    'catalogRevision',
    'attemptedChannelIds',
    'images',
  ]);
  if (
    reply.schemaVersion !== 1 ||
    reply.catalogRevision !== revision ||
    !Array.isArray(reply.images) ||
    !Array.isArray(reply.attemptedChannelIds) ||
    reply.images.length > ids.length ||
    reply.attemptedChannelIds.length > ids.length ||
    new Set(reply.attemptedChannelIds).size !== reply.attemptedChannelIds.length ||
    reply.attemptedChannelIds.some((id) => !ids.includes(id))
  )
    throw invalid();
  let total = 0;
  const attempted = reply.attemptedChannelIds;
  const seen = new Set<string>();
  const images = reply.images.map((value) => {
    const r = record(value, [
      'channelId',
      'providerId',
      'mimeType',
      'width',
      'height',
      'byteLength',
      'dataUrl',
    ]);
    if (
      !text(r.channelId, 16384) ||
      !attempted.includes(r.channelId) ||
      seen.has(r.channelId) ||
      !text(r.providerId, 1024) ||
      !['image/png', 'image/jpeg'].includes(r.mimeType as string) ||
      !Number.isInteger(r.width) ||
      !Number.isInteger(r.height) ||
      (r.width as number) < 1 ||
      (r.height as number) < 1 ||
      (r.width as number) > 2048 ||
      (r.height as number) > 2048 ||
      (r.width as number) * (r.height as number) > 262144 ||
      !Number.isInteger(r.byteLength) ||
      (r.byteLength as number) < 1 ||
      (r.byteLength as number) > 262144 ||
      typeof r.dataUrl !== 'string'
    )
      throw invalid();
    const prefix = `data:${r.mimeType};base64,`;
    if (!r.dataUrl.startsWith(prefix)) throw invalid();
    const payload = r.dataUrl.slice(prefix.length);
    if (
      payload.length !== Math.ceil((r.byteLength as number) / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(payload) ||
      (payload.length / 4) * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0) !==
        r.byteLength
    )
      throw invalid();
    total += r.byteLength as number;
    if (total > 8 * 1024 * 1024) throw invalid();
    seen.add(r.channelId);
    return { ...r } as unknown as ChannelLogoImage;
  });
  return {
    schemaVersion: 1,
    catalogRevision: revision,
    attemptedChannelIds: [...reply.attemptedChannelIds],
    images,
  };
}
export function createChannelLogoAdapter(runtime?: OwnedNativeRuntime) {
  return {
    async read(
      ids: readonly string[],
      revision: string,
      signal: AbortSignal,
    ): Promise<ChannelLogoReply> {
      if (
        (!runtime && !isTauri()) ||
        !logoRevision(revision) ||
        ids.length < 1 ||
        ids.length > 32 ||
        ids.some((id) => !text(id, 16384)) ||
        new Set(ids).size !== ids.length
      )
        throw invalid();
      return invokeOwnedNative(
        runtime ?? { invoke },
        'channel_logos',
        {
          request: { schemaVersion: 1, channelIds: [...ids], expectedRevision: revision },
        },
        { signal, validate: (v) => validateChannelLogos(v, ids, revision) },
      );
    },
  };
}
