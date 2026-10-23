import { validateCatalog, type CatalogRecord } from '../catalog';
import { validatePreferences } from '../preferences';
import { validateHealthRecords } from '../catalog/health-record';
import { boundedJsonUtf8Bytes } from '../data-transfer/json-byte-admission';
import { MAX_PLAYLIST_BYTES } from '../catalog/parser';
import { normalizeSourceMime } from '../sources';
import { checkpointRevision } from './scan-checkpoint';
import type { Preferences } from '../preferences';
import type { ReconciliationScope } from '../catalog/parser';
import type { ScanSource, StagedScanSelection } from './scan';
import type { PreparedNativeScanBatch, ReviewedScanHealthContext } from './prepare-selection';
import {
  validateSelectionWindowRequest,
  validateSelectionWindowCounts,
  isSelectionWindowSizeError,
  selectionWindowSizeRefusal,
  validatePreparedSelectionWindow,
} from './selection-window';
export interface SelectionSessionBootstrap {
  catalog: CatalogRecord;
  catalogRevision: string;
  scope: ScanSource[];
  reconciliationScopes?: ReconciliationScope[];
}
export interface SelectionSessionRequest {
  selection: StagedScanSelection;
  preferences: Preferences;
  review?: ReviewedScanHealthContext;
  expectedCatalogRevision: string;
}
export interface PreparedSelectionSessionBatch extends PreparedNativeScanBatch {
  preparationId: string;
  expectedCatalogRevision: string;
}
export interface SelectionSessionAck {
  committed: true;
  catalogRevision: string;
  healthRevision: string;
}
export interface SelectionWindowRequest {
  schemaVersion: 1;
  expectedCatalogRevision: string;
  preferences: Preferences;
  chunks: readonly { selection: StagedScanSelection; review?: ReviewedScanHealthContext }[];
}
export interface PreparedSelectionSessionWindow {
  schemaVersion: 1;
  preparationId: string;
  expectedCatalogRevision: string;
  nextPreferences: Preferences;
  chunks: readonly Pick<PreparedNativeScanBatch, 'catalogPatch' | 'incomingHealth'>[];
  totalSelectionCount: number;
}
export type SelectionSessionCommand =
  | { kind: 'bootstrap'; requestId: number; bootstrap: SelectionSessionBootstrap }
  | { kind: 'prepare'; requestId: number; input: SelectionSessionRequest }
  | { kind: 'prepare-window'; requestId: number; input: SelectionWindowRequest }
  | { kind: 'ack'; requestId: number; preparationId: string; receipt: SelectionSessionAck }
  | { kind: 'ack-window'; requestId: number; preparationId: string; receipt: SelectionSessionAck }
  | { kind: 'cancel'; requestId: number; target: number }
  | { kind: 'quarantine'; requestId: number }
  | { kind: 'dispose'; requestId: number };
export interface SelectionSessionReply {
  requestId: number;
  ok: boolean;
  value?: unknown;
  code?: 'canceled' | 'selection-session-refused' | 'selection-window-size';
}
type Transport = Pick<
  Worker,
  'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'
>;
const refuse = () => new Error('Selection session is unavailable. Reopen the scan before saving.');
/** One worker/mirror per scan. Caller supplies only actual validated durable receipts to acknowledge. */
export function createSelectionSession(
  bootstrap: SelectionSessionBootstrap,
  factory: () => Transport = () =>
    new Worker(new URL('./selection-session-worker.ts', import.meta.url), { type: 'module' }),
) {
  const responseSources = structuredClone(bootstrap.scope.map(({ source }) => source));
  const worker = factory();
  let sequence = 0,
    closed = false,
    quarantined = false,
    active = false,
    stopped = false;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      cleanup(): void;
      signal?: AbortSignal;
      kind: string;
    }
  >();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  };
  const fail = () => {
    quarantined = true;
    for (const item of pending.values()) {
      item.cleanup();
      item.reject(refuse());
    }
    pending.clear();
    stop();
  };
  worker.onerror = fail;
  worker.onmessageerror = fail;
  worker.onmessage = (event: MessageEvent<SelectionSessionReply>) => {
    const reply = event.data,
      item = pending.get(reply?.requestId);
    if (!reply || !Number.isSafeInteger(reply.requestId) || typeof reply.ok !== 'boolean') {
      fail();
      return;
    }
    if (!item) return;
    pending.delete(reply.requestId);
    item.cleanup();
    if (item.signal?.aborted && reply.ok === true) {
      quarantined = true;
      try {
        worker.postMessage({ kind: 'quarantine', requestId: ++sequence });
      } catch {
        fail();
      }
      item.reject(new DOMException('Selection preparation canceled.', 'AbortError'));
    } else if (reply.ok === true) {
      if (
        (item.kind === 'prepare' || item.kind === 'prepare-window') &&
        (!reply.value ||
          typeof reply.value !== 'object' ||
          (reply.value as PreparedSelectionSessionBatch).schemaVersion !== 1 ||
          typeof (reply.value as PreparedSelectionSessionBatch).preparationId !== 'string')
      ) {
        item.reject(refuse());
        fail();
      } else if (
        item.kind !== 'prepare' &&
        item.kind !== 'prepare-window' &&
        reply.value !== undefined
      ) {
        item.reject(refuse());
        fail();
      } else {
        try {
          if (item.kind === 'prepare-window')
            validatePreparedSelectionWindow(reply.value, responseSources);
          if (item.kind === 'prepare') {
            const result = reply.value as PreparedSelectionSessionBatch;
            const patch = result.catalogPatch;
            if (
              Object.keys(result).sort().join(',') !==
                'catalogPatch,expectedCatalogRevision,incomingHealth,nextPreferences,preparationId,schemaVersion' ||
              !/^[a-zA-Z0-9-]{1,128}$/.test(result.preparationId) ||
              !patch ||
              patch.schemaVersion !== 1 ||
              Object.keys(patch).sort().join(',') !==
                'baseChannelCount,baseSourceCount,channels,finalChannelCount,finalSourceCount,schemaVersion,sources' ||
              !Array.isArray(patch.channels) ||
              patch.channels.length > 64 ||
              !Array.isArray(patch.sources) ||
              patch.sources.length > 100 ||
              patch.finalSourceCount > 100 ||
              patch.finalChannelCount > 100000 ||
              patch.finalSourceCount < patch.baseSourceCount ||
              patch.finalChannelCount < patch.baseChannelCount ||
              !Array.isArray(result.incomingHealth) ||
              result.incomingHealth.length > 64 ||
              ![
                patch.baseSourceCount,
                patch.finalSourceCount,
                patch.baseChannelCount,
                patch.finalChannelCount,
              ].every((n) => Number.isSafeInteger(n) && n >= 0)
            )
              throw refuse();
            boundedJsonUtf8Bytes(result, MAX_PLAYLIST_BYTES);
            checkpointRevision(result.expectedCatalogRevision);
            validatePreferences(result.nextPreferences);
            validateHealthRecords(result.incomingHealth);
            validateCatalog({
              schemaVersion: 1,
              sources: responseSources.map((source) => ({
                ...source,
                ...(source.mediaMime === undefined
                  ? {}
                  : { mediaMime: normalizeSourceMime(source.mediaMime) ?? source.mediaMime }),
              })),
              channels: patch.channels,
            });
          }
          item.resolve(reply.value);
        } catch (error) {
          item.reject(
            item.kind === 'prepare-window' && isSelectionWindowSizeError(error) ? error : refuse(),
          );
          fail();
        }
      }
    } else
      item.reject(
        reply.code === 'canceled'
          ? new DOMException('Selection preparation canceled.', 'AbortError')
          : item.kind === 'prepare-window' && reply.code === 'selection-window-size'
            ? item.signal?.aborted
              ? new DOMException('Selection preparation canceled.', 'AbortError')
              : selectionWindowSizeRefusal()
            : refuse(),
      );
  };
  const send = (
    command: Omit<SelectionSessionCommand, 'requestId'>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    signal?.throwIfAborted();
    if (stopped) return Promise.reject(refuse());
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const abort = () => {
        try {
          worker.postMessage({ kind: 'cancel', requestId: ++sequence, target: id });
        } catch {
          fail();
        }
      };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      pending.set(id, { resolve, reject, cleanup, signal, kind: command.kind });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        worker.postMessage({ ...command, requestId: id });
      } catch {
        fail();
      }
    });
  };
  const ready = send({ kind: 'bootstrap', bootstrap } as Omit<
    SelectionSessionCommand,
    'requestId'
  >).then(() => undefined);
  void ready.catch(() => undefined);
  let work: Promise<unknown> | null = null,
    disposal: Promise<void> | null = null;
  return {
    ready,
    async prepare(
      input: SelectionSessionRequest,
      signal: AbortSignal,
    ): Promise<PreparedSelectionSessionBatch> {
      if (closed || quarantined || active) throw refuse();
      signal.throwIfAborted();
      if (
        input.selection.sources.length > 100 ||
        input.selection.sources.reduce((n, s) => n + s.candidates.length, 0) > 64 ||
        (input.review &&
          (input.review.candidates.length > 64 || input.review.observations.length > 64))
      )
        throw refuse();
      const request = structuredClone({
        ...input,
        selection: {
          ...input.selection,
          sources: input.selection.sources.map(
            ({ reconciliationScope: _scope, ...source }) => source,
          ),
        },
      });
      active = true;
      const job = (async () => {
        await ready;
        signal.throwIfAborted();
        if (closed || quarantined) throw refuse();
        return (await send(
          { kind: 'prepare', input: request } as Omit<SelectionSessionCommand, 'requestId'>,
          signal,
        )) as PreparedSelectionSessionBatch;
      })();
      work = job;
      try {
        return await job;
      } finally {
        active = false;
        if (work === job) work = null;
      }
    },
    async acknowledge(preparationId: string, receipt: SelectionSessionAck): Promise<void> {
      if (closed || quarantined || active) throw refuse();
      active = true;
      const job = send({ kind: 'ack', preparationId, receipt } as Omit<
        SelectionSessionCommand,
        'requestId'
      >);
      work = job;
      try {
        await job;
      } catch (error) {
        quarantined = true;
        throw error;
      } finally {
        active = false;
        if (work === job) work = null;
      }
    },
    async prepareWindow(
      input: SelectionWindowRequest,
      signal: AbortSignal,
    ): Promise<PreparedSelectionSessionWindow> {
      if (closed || quarantined || active) throw refuse();
      signal.throwIfAborted();
      validateSelectionWindowCounts(input);
      const wire = {
        ...input,
        chunks: input.chunks.map((chunk) => ({
          ...chunk,
          selection: {
            ...chunk.selection,
            sources: chunk.selection.sources.map(
              ({ reconciliationScope: _scope, ...source }) => source,
            ),
          },
        })),
      };
      validateSelectionWindowRequest(wire);
      const request = structuredClone(wire);
      active = true;
      const job = (async () => {
        await ready;
        signal.throwIfAborted();
        if (closed || quarantined) throw refuse();
        return (await send(
          { kind: 'prepare-window', input: request } as Omit<SelectionSessionCommand, 'requestId'>,
          signal,
        )) as PreparedSelectionSessionWindow;
      })();
      work = job;
      try {
        return await job;
      } finally {
        active = false;
        if (work === job) work = null;
      }
    },
    async acknowledgeWindow(preparationId: string, receipt: SelectionSessionAck): Promise<void> {
      if (closed || quarantined || active) throw refuse();
      active = true;
      const job = send({ kind: 'ack-window', preparationId, receipt } as Omit<
        SelectionSessionCommand,
        'requestId'
      >);
      work = job;
      try {
        await job;
      } catch (error) {
        quarantined = true;
        throw error;
      } finally {
        active = false;
        if (work === job) work = null;
      }
    },
    async quarantine(): Promise<void> {
      if (closed || stopped) return;
      quarantined = true;
      await send({ kind: 'quarantine' });
      await Promise.allSettled([work]);
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      closed = true;
      const job = (async () => {
        try {
          await ready;
          if (stopped) return;
          const joined = send({ kind: 'dispose' });
          await Promise.allSettled([work]);
          await joined;
        } finally {
          fail();
        }
      })();
      disposal = job;
      return job;
    },
  };
}

export { isSelectionWindowSizeError } from './selection-window';
