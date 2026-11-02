// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { invoke, isTauri } from '@tauri-apps/api/core';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';

export interface SourceCleanupRound {
  readonly schemaVersion: 1;
  readonly roundId: string;
  readonly sourceCount: number;
}
export interface SourceCleanupReceipt {
  readonly schemaVersion: 1;
  readonly committed: true;
  readonly status: 'completed' | 'coverage-incomplete' | 'budget-exhausted';
  readonly archivedCount: number;
  readonly checkedTargets: number;
  readonly deferredCount: number;
  readonly catalogRevision: string;
  readonly healthRevision: string;
  readonly viewRevision: string;
}
export interface SourceCleanupTransport {
  begin(expectedCatalogRevision: string, signal: AbortSignal): Promise<SourceCleanupRound>;
  finish(roundId: string, signal: AbortSignal): Promise<SourceCleanupReceipt>;
  /** Revocation joins its actual native write and cannot itself be aborted. */
  cancel(roundId: string): Promise<void>;
}
const refused = () => new Error('Automatic source cleanup could not be confirmed.');
const noncommits = new WeakSet<object>();
class CleanupNotCommittedError extends Error {
  constructor() {
    super('Automatic source cleanup was canceled before publication.');
    noncommits.add(this);
  }
}
export const isSourceCleanupNotCommitted = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && noncommits.has(error);
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refused();
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 ||
    Object.keys(row).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(row, key))
  )
    throw refused();
  return row;
}
function revision(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw refused();
  return value;
}
function roundId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw refused();
  return value;
}
function count(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    throw refused();
  return value as number;
}
export function validateSourceCleanupReceipt(value: unknown): SourceCleanupReceipt {
  const row = fields(value, [
    'schemaVersion',
    'committed',
    'status',
    'archivedCount',
    'checkedTargets',
    'deferredCount',
    'catalogRevision',
    'healthRevision',
    'viewRevision',
  ]);
  if (
    row.committed !== true ||
    !['completed', 'coverage-incomplete', 'budget-exhausted'].includes(String(row.status))
  )
    throw refused();
  const archivedCount = count(row.archivedCount, 100000);
  if (row.status === 'coverage-incomplete' && archivedCount !== 0) throw refused();
  return Object.freeze({
    schemaVersion: 1,
    committed: true,
    status: row.status as SourceCleanupReceipt['status'],
    archivedCount,
    checkedTargets: count(row.checkedTargets, 256),
    deferredCount: count(row.deferredCount, 1600000),
    catalogRevision: revision(row.catalogRevision),
    healthRevision: revision(row.healthRevision),
    viewRevision: revision(row.viewRevision),
  });
}

export function createSourceCleanupTransport(
  options: {
    runtime?: OwnedNativeRuntime;
    native?: () => boolean;
  } = {},
): SourceCleanupTransport {
  const runtime = options.runtime ?? { invoke };
  const native = options.native ?? isTauri;
  const rounds = new Map<string, string>();
  const cancellations = new Map<string, Promise<void>>();
  const available = () => {
    if (!native()) throw refused();
  };
  const cancel = (id: string): Promise<void> => {
    available();
    roundId(id);
    const pending = cancellations.get(id);
    if (pending) return pending;
    if (!rounds.has(id)) return Promise.resolve();
    const work = invokeOwnedNative(
      runtime,
      'cancel_source_cleanup',
      { request: { schemaVersion: 1, roundId: id } },
      {
        validate: (raw) => {
          const result = fields(raw, ['schemaVersion', 'canceled']);
          if (result.canceled !== true) throw refused();
        },
      },
    ).then(() => {
      rounds.delete(id);
    });
    cancellations.set(id, work);
    void work
      .finally(() => {
        if (cancellations.get(id) === work) cancellations.delete(id);
      })
      .catch(() => undefined);
    return work;
  };
  return {
    async begin(expectedCatalogRevision, signal) {
      available();
      signal.throwIfAborted();
      revision(expectedCatalogRevision);
      if (rounds.size) throw refused();
      let issued: SourceCleanupRound | undefined;
      try {
        return await invokeOwnedNative(
          runtime,
          'begin_source_cleanup',
          { request: { schemaVersion: 1, expectedCatalogRevision } },
          {
            signal,
            validate: (raw) => {
              const row = fields(raw, ['schemaVersion', 'roundId', 'sourceCount']);
              issued = Object.freeze({
                schemaVersion: 1,
                roundId: roundId(row.roundId),
                sourceCount: count(row.sourceCount, 100),
              });
              rounds.set(issued.roundId, expectedCatalogRevision);
              return issued;
            },
          },
        );
      } catch (error) {
        // Native begin may have committed operational proof just before abort.
        // Retain its identity during validation and revoke it before returning.
        if (issued && signal.aborted) await cancel(issued.roundId);
        throw error;
      }
    },
    async finish(id, signal) {
      available();
      signal.throwIfAborted();
      roundId(id);
      const expected = rounds.get(id);
      if (expected === undefined) throw refused();
      let confirmedNoncommit = false;
      const observedRuntime: OwnedNativeRuntime = {
        ...runtime,
        invoke: async (command, args) => {
          try {
            return await runtime.invoke(command, args);
          } catch (error) {
            if (
              command === 'finish_source_cleanup' &&
              (error === 'canceled' || error === 'application-closing')
            )
              confirmedNoncommit = true;
            throw error;
          }
        },
      };
      let receipt: SourceCleanupReceipt;
      try {
        receipt = await invokeOwnedNative(
          observedRuntime,
          'finish_source_cleanup',
          { request: { schemaVersion: 1, roundId: id } },
          {
            signal,
            durable: true,
            validate: (raw) => {
              const result = validateSourceCleanupReceipt(raw);
              if (result.catalogRevision !== expected) throw refused();
              return result;
            },
          },
        );
      } catch (error) {
        // These exact native refusals are guaranteed to precede COMMIT. The
        // original RPC and cancel request have both joined before branding.
        if (confirmedNoncommit) throw new CleanupNotCommittedError();
        throw error;
      }
      rounds.delete(id);
      return receipt;
    },
    cancel,
  };
}
