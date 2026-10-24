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

import { invoke } from '@tauri-apps/api/core';
import {
  MappedGuideCleanupError,
  type MappedGuideHydrationHost,
  type MappedGuideIdentity,
  type MappedGuideReceipt,
} from './mapped-guide-schedule';

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).length === names.length && names.every((n) => Object.hasOwn(v, n));
const text = (v: unknown, bytes: number): v is string =>
  typeof v === 'string' &&
  !!v.trim() &&
  new TextEncoder().encode(v).length <= bytes &&
  !/[\p{Cc}\p{Cf}]/u.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const decimal = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
const sameMapping = (v: unknown, expected: MappedGuideIdentity): boolean =>
  object(v) &&
  fields(v, ['catalogSourceId', 'appChannelId', 'guideSourceId', 'xmltvChannelId']) &&
  Object.entries(expected).every(
    ([k, value]) => v[k] === value && text(value, k.endsWith('SourceId') ? 256 : 16384),
  );
function receipt(v: unknown, mapping: MappedGuideIdentity): MappedGuideReceipt {
  if (
    !object(v) ||
    !fields(v, [
      'schemaVersion',
      'mapping',
      'rootGeneration',
      'catalogRevision',
      'guideRevision',
      'sourceRevision',
      'sourceFingerprint',
    ]) ||
    v.schemaVersion !== 1 ||
    !sameMapping(v.mapping, mapping) ||
    !decimal(v.rootGeneration) ||
    v.rootGeneration === '0' ||
    !decimal(v.catalogRevision) ||
    BigInt(v.catalogRevision) > 9223372036854775807n ||
    !Number.isSafeInteger(v.guideRevision) ||
    (v.guideRevision as number) < 0 ||
    !positive(v.sourceRevision) ||
    typeof v.sourceFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.sourceFingerprint)
  )
    throw new Error('Guide mapping receipt invalid.');
  return Object.freeze({
    ...(v as unknown as MappedGuideReceipt),
    mapping: Object.freeze({ ...mapping }),
  });
}
/** All invokes and cleanup stay with the originating operation. No timeout races. */
export function createMappedGuideNativeHost(
  changed: () => void,
  call: (command: string, args: Record<string, unknown>) => Promise<unknown> = invoke,
): MappedGuideHydrationHost & { settle(): Promise<void> } {
  const tickets = new Map<string, string>();
  let discardFailed = false;
  const pendingCancels = new Set<string>();
  const notify = () => {
    try {
      changed();
    } catch {
      /* Durable receipt remains authoritative. */
    }
  };
  const discard = async (ticket: string) => {
    try {
      await call('guide_discard', { ticket });
      tickets.delete(ticket);
      if (!tickets.size) discardFailed = false;
    } catch {
      discardFailed = true;
      throw new MappedGuideCleanupError();
    }
  };
  const owned = async <T>(
    command: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    consume: (value: unknown, requestId: string) => T,
    requestId: string = crypto.randomUUID(),
  ): Promise<T> => {
    signal.throwIfAborted();
    if (discardFailed || pendingCancels.size) throw new MappedGuideCleanupError();
    let cancellation: Promise<unknown> | null = null;
    let cancelFailed = false;
    const cancel = () => {
      cancellation ??= call('cancel_playlist', { requestId }).catch(() => {
        cancelFailed = true;
      });
    };
    signal.addEventListener('abort', cancel, { once: true });
    let result: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      const raw = await call(command, { ...args, requestId });
      // Adopt durable receipts and tickets before joining late-abort cleanup.
      result = { ok: true, value: consume(raw, requestId) };
    } catch (error) {
      result = { ok: false, error };
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    await cancellation;
    if (cancelFailed) {
      pendingCancels.add(requestId);
      throw new MappedGuideCleanupError();
    }
    if (!result.ok) throw result.error;
    return result.value;
  };
  return {
    save: (mapping, signal, committed) =>
      owned('guide_save_mapping_receipt', { mapping }, signal, (raw) => {
        const saved = receipt(raw, mapping);
        committed(saved);
        notify();
        return saved;
      }),
    status: (saved, revision, signal) =>
      owned(
        'guide_mapped_schedule_status',
        { receipt: saved, expectedSourceRevision: revision },
        signal,
        (raw) => {
          if (
            !object(raw) ||
            !fields(raw, ['kind', 'listed']) ||
            !['url', 'file'].includes(raw.kind as string) ||
            typeof raw.listed !== 'boolean'
          )
            throw new Error('Guide schedule status invalid.');
          return { kind: raw.kind as 'url' | 'file', listed: raw.listed };
        },
      ),
    preview: async (saved, signal) => {
      let adopted: string | null = null;
      try {
        return await owned('guide_preview_mapped', { receipt: saved }, signal, (raw, requestId) => {
          if (object(raw) && typeof raw.ticket === 'string' && /^[a-f0-9]{32}$/.test(raw.ticket)) {
            adopted = raw.ticket;
            tickets.set(adopted, requestId);
          }
          if (
            !object(raw) ||
            !adopted ||
            raw.sourceId !== saved.mapping.guideSourceId ||
            raw.sourceRevision !== saved.sourceRevision ||
            !Number.isSafeInteger(raw.channels) ||
            (raw.channels as number) < 1 ||
            (raw.channels as number) > 100000 ||
            !Number.isSafeInteger(raw.programs) ||
            (raw.programs as number) < 0 ||
            (raw.programs as number) > 500000
          )
            throw new Error('Guide schedule preview invalid.');
          return {
            ticket: adopted,
            sourceId: raw.sourceId as string,
            sourceRevision: raw.sourceRevision as number,
          };
        });
      } catch (error) {
        if (adopted) await discard(adopted);
        throw error;
      }
    },
    publish: (preview, signal, committed) => {
      const requestId = tickets.get(preview.ticket);
      if (!requestId) throw new Error('Guide preview ownership missing.');
      return owned(
        'guide_commit',
        {
          ticket: preview.ticket,
          expectedRevision: preview.sourceRevision,
          allowEmpty: false,
        },
        signal,
        (raw) => {
          if (!positive(raw) || raw <= preview.sourceRevision)
            throw new Error('Guide publication receipt invalid.');
          tickets.delete(preview.ticket);
          committed(raw);
          notify();
          return raw;
        },
        requestId,
      );
    },
    discard,
    async settle() {
      // Caller first joins its actionWork; never discard a ticket while commit is running.
      for (const ticket of tickets.keys()) await discard(ticket);
      for (const requestId of pendingCancels) {
        await call('cancel_playlist', { requestId });
        pendingCancels.delete(requestId);
      }
    },
  };
}
