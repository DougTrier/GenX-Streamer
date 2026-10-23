import { validateCatalog, validateSource, type CatalogRecord } from '../catalog';
import { reconcileChannels, MAX_PLAYLIST_BYTES } from '../catalog/parser';
import { boundedJsonUtf8Bytes } from '../data-transfer/json-byte-admission';
import { normalizeSourceMime } from '../sources';
import { checkpointRevision } from './scan-checkpoint';
import { applyCatalogPatch } from './catalog-patch';
import { prepareOwnedNativeScanBatch } from './prepare-selection';
import {
  validateSelectionWindowRequest,
  admitSelectionWindowBytes,
  isSelectionWindowSizeError,
  validatePreparedSelectionWindow,
} from './selection-window';
import type {
  PreparedSelectionSessionBatch,
  SelectionSessionBootstrap,
  SelectionSessionRequest,
  SelectionSessionAck,
  SelectionSessionCommand,
  SelectionSessionReply,
  SelectionWindowRequest,
  PreparedSelectionSessionWindow,
} from './selection-session';
const refused = () => new Error('Selection session refused.');
/** Owned worker input only; unit callers must provide an isolated bootstrap. */
export function createOwnedSelectionActor(
  seed: SelectionSessionBootstrap,
  prepare = prepareOwnedNativeScanBatch,
) {
  let mirror: CatalogRecord | null = validateCatalog(seed.catalog),
    revision = checkpointRevision(seed.catalogRevision),
    closed = false,
    quarantined = false;
  boundedJsonUtf8Bytes(mirror, MAX_PLAYLIST_BYTES);
  if (
    seed.scope.length > 100 ||
    new Set(seed.scope.map((s) => s.source.id)).size !== seed.scope.length
  )
    throw refused();
  const scope = seed.scope.map((entry) => ({
    ...entry,
    source: validateSource({
      ...entry.source,
      ...(entry.source.mediaMime === undefined
        ? {}
        : { mediaMime: normalizeSourceMime(entry.source.mediaMime) ?? entry.source.mediaMime }),
    }),
  }));
  const variants = new Map((seed.reconciliationScopes ?? []).map((v) => [v.sourceId, v]));
  if (variants.size !== (seed.reconciliationScopes?.length ?? 0) || variants.size > 100)
    throw refused();
  for (const variant of variants.values()) {
    if (!scope.some((s) => s.source.id === variant.sourceId)) throw refused();
    reconcileChannels([], [], undefined, variant);
  }
  boundedJsonUtf8Bytes(seed.reconciliationScopes ?? [], MAX_PLAYLIST_BYTES);
  let pending: PreparedSelectionSessionBatch | null = null,
    pendingWindow: { prepared: PreparedSelectionSessionWindow; catalog: CatalogRecord } | null =
      null,
    running: Promise<PreparedSelectionSessionBatch | PreparedSelectionSessionWindow> | null = null,
    controller: AbortController | null = null;
  return {
    async prepare(
      input: SelectionSessionRequest,
      signal?: AbortSignal,
    ): Promise<PreparedSelectionSessionBatch> {
      if (
        closed ||
        quarantined ||
        pending ||
        pendingWindow ||
        running ||
        !mirror ||
        input.expectedCatalogRevision !== revision
      )
        throw refused();
      signal?.throwIfAborted();
      const selection = {
        ...input.selection,
        sources: input.selection.sources.map((source) => {
          if (source.reconciliationScope) throw refused();
          const variant = variants.get(source.sourceId);
          return { ...source, ...(variant ? { reconciliationScope: variant } : {}) };
        }),
      };
      const owner = new AbortController();
      controller = owner;
      const abort = () => owner.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const base = mirror;
      const job = (async () => {
        const batch = await prepare(
          base,
          input.preferences,
          selection,
          scope,
          input.review,
          owner.signal,
        );
        owner.signal.throwIfAborted();
        if (closed || quarantined) throw refused();
        const result = {
          ...batch,
          preparationId: crypto.randomUUID(),
          expectedCatalogRevision: revision,
        };
        pending = result;
        return structuredClone(result);
      })();
      running = job;
      try {
        return await job;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (running === job) running = null;
        if (controller === owner) controller = null;
      }
    },
    async prepareWindow(
      input: SelectionWindowRequest,
      signal?: AbortSignal,
    ): Promise<PreparedSelectionSessionWindow> {
      if (
        closed ||
        quarantined ||
        pending ||
        pendingWindow ||
        running ||
        !mirror ||
        input.expectedCatalogRevision !== revision
      )
        throw refused();
      signal?.throwIfAborted();
      validateSelectionWindowRequest(input);
      const owner = new AbortController();
      controller = owner;
      const abort = () => owner.abort();
      signal?.addEventListener('abort', abort, { once: true });
      let provisional = mirror;
      let preferences = input.preferences;
      const job = (async () => {
        const chunks: PreparedSelectionSessionWindow['chunks'][number][] = [];
        let totalSelectionCount = 0;
        for (const chunk of input.chunks) {
          owner.signal.throwIfAborted();
          const selection = {
            ...chunk.selection,
            sources: chunk.selection.sources.map((source) => {
              if (source.reconciliationScope) throw refused();
              const variant = variants.get(source.sourceId);
              return { ...source, ...(variant ? { reconciliationScope: variant } : {}) };
            }),
          };
          const batch = await prepare(
            provisional,
            preferences,
            selection,
            scope,
            chunk.review,
            owner.signal,
          );
          owner.signal.throwIfAborted();
          if (closed || quarantined) throw refused();
          provisional = applyCatalogPatch(
            provisional,
            batch.catalogPatch,
            scope.map((s) => s.source),
          );
          preferences = batch.nextPreferences;
          totalSelectionCount += selection.sources.reduce(
            (count, source) => count + source.candidates.length,
            0,
          );
          chunks.push({ catalogPatch: batch.catalogPatch, incomingHealth: batch.incomingHealth });
          admitSelectionWindowBytes({ chunks, nextPreferences: preferences });
        }
        const result: PreparedSelectionSessionWindow = {
          schemaVersion: 1,
          preparationId: crypto.randomUUID(),
          expectedCatalogRevision: revision,
          nextPreferences: preferences,
          chunks,
          totalSelectionCount,
        };
        validatePreparedSelectionWindow(
          result,
          scope.map((s) => s.source),
        );
        pendingWindow = { prepared: result, catalog: provisional };
        return structuredClone(result);
      })();
      running = job;
      try {
        return await job;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (running === job) running = null;
        if (controller === owner) controller = null;
      }
    },
    acknowledgeWindow(id: string, receipt: SelectionSessionAck): void {
      try {
        if (
          closed ||
          quarantined ||
          running ||
          pending ||
          !pendingWindow ||
          !mirror ||
          pendingWindow.prepared.preparationId !== id ||
          receipt.committed !== true
        )
          throw refused();
        const actual = checkpointRevision(receipt.catalogRevision);
        checkpointRevision(receipt.healthRevision);
        if (actual !== revision && BigInt(actual) !== BigInt(revision) + 1n) throw refused();
        mirror = pendingWindow.catalog;
        revision = actual;
        pendingWindow = null;
      } catch (error) {
        quarantined = true;
        throw error;
      }
    },
    acknowledge(id: string, receipt: SelectionSessionAck): void {
      try {
        if (
          closed ||
          quarantined ||
          running ||
          pendingWindow ||
          !pending ||
          !mirror ||
          pending.preparationId !== id ||
          receipt.committed !== true
        )
          throw refused();
        const actual = checkpointRevision(receipt.catalogRevision);
        checkpointRevision(receipt.healthRevision);
        if (actual !== revision && BigInt(actual) !== BigInt(revision) + 1n) throw refused();
        mirror = applyCatalogPatch(
          mirror,
          pending.catalogPatch,
          scope.map((s) => s.source),
        );
        revision = actual;
        pending = null;
      } catch (error) {
        quarantined = true;
        throw error;
      }
    },
    cancel() {
      controller?.abort();
    },
    quarantine() {
      quarantined = true;
      controller?.abort();
    },
    async dispose() {
      closed = true;
      controller?.abort();
      await Promise.allSettled([running]);
      mirror = null;
      pending = null;
      pendingWindow = null;
      variants.clear();
    },
  };
}
if (typeof self !== 'undefined' && typeof document === 'undefined') {
  let actor: ReturnType<typeof createOwnedSelectionActor> | null = null,
    active: { id: number; work: Promise<unknown> } | null = null,
    closing = false;
  const reply = (
    requestId: number,
    ok: boolean,
    value?: unknown,
    code?: SelectionSessionReply['code'],
  ) =>
    self.postMessage({
      requestId,
      ok,
      ...(value === undefined ? {} : { value }),
      ...(code ? { code } : {}),
    });
  self.onmessage = (event: MessageEvent<SelectionSessionCommand>) => {
    const message = event.data;
    if (message.kind === 'cancel') {
      if (active?.id === message.target) actor?.cancel();
      return;
    }
    if (message.kind === 'dispose') {
      closing = true;
      const job = (async () => {
        await actor?.dispose();
        actor = null;
        reply(message.requestId, true);
      })();
      void job.catch(() => reply(message.requestId, false, undefined, 'selection-session-refused'));
      return;
    }
    if (message.kind === 'quarantine') {
      actor?.quarantine();
      reply(message.requestId, true);
      return;
    }
    const job = (async () => {
      if (closing) throw refused();
      if (message.kind === 'bootstrap') {
        if (actor) throw refused();
        actor = createOwnedSelectionActor(message.bootstrap);
        return;
      }
      if (!actor) throw refused();
      if (message.kind === 'ack') {
        actor.acknowledge(message.preparationId, message.receipt);
        return;
      }
      if (message.kind === 'ack-window') {
        actor.acknowledgeWindow(message.preparationId, message.receipt);
        return;
      }
      if (message.kind === 'prepare-window') return actor.prepareWindow(message.input);
      return actor.prepare(message.input);
    })();
    active = { id: message.requestId, work: job };
    void job
      .then(
        (value) => reply(message.requestId, true, value),
        (error) =>
          reply(
            message.requestId,
            false,
            undefined,
            error instanceof Error && error.name === 'AbortError'
              ? 'canceled'
              : message.kind === 'prepare-window' && isSelectionWindowSizeError(error)
                ? 'selection-window-size'
                : 'selection-session-refused',
          ),
      )
      .finally(() => {
        if (active?.work === job) active = null;
      });
  };
}
