import {
  createArchiveDownloadsAdapter,
  ArchiveDownloadError,
  type ArchiveDownloadEntry,
  type ArchiveDownloadProgress,
  type ArchiveDownloadReceipt,
  type ArchiveDownloadRemoveReceipt,
} from '../platform/archive-downloads';
export interface ArchiveDownloadsSnapshot {
  revision: string | null;
  entries: readonly Readonly<ArchiveDownloadEntry>[];
  activeFileRef: string | null;
  progress: Readonly<ArchiveDownloadProgress> | null;
  state:
    | 'idle'
    | 'reading'
    | 'preparing'
    | 'downloading'
    | 'verifying'
    | 'saving'
    | 'saved'
    | 'removing'
    | 'canceling'
    | 'canceled'
    | 'failed'
    | 'disposed';
  message: string | null;
  cleanupPending: boolean;
}
export interface ArchiveDownloadsHost {
  /** Stable storage/root authority, independent of browsing, query and playback. */
  readyScope(): string | null;
  /** Capture/stop only the matching saved decoder before native revocation. Actual work is joined. */
  beforeRemove?(downloadRef: string, signal: AbortSignal): Promise<void>;
  native?: Pick<
    ReturnType<typeof createArchiveDownloadsAdapter>,
    'list' | 'status' | 'start' | 'remove' | 'stop'
  > &
    Partial<Pick<ReturnType<typeof createArchiveDownloadsAdapter>, 'cleanupPending'>>;
}
export function createArchiveDownloads(host: ArchiveDownloadsHost) {
  const native = host.native ?? createArchiveDownloadsAdapter();
  let snapshot: ArchiveDownloadsSnapshot = {
    revision: null,
    entries: [],
    activeFileRef: null,
    progress: null,
    state: 'idle',
    message: null,
    cleanupPending: false,
  };
  const listeners = new Set<(value: Readonly<ArchiveDownloadsSnapshot>) => void>();
  let job: { abort: AbortController; work: Promise<unknown> } | null = null;
  const reads = new Map<AbortController, Promise<void>>();
  let loadedScope: string | null = null;
  let repairRequired = false;
  let playbackCleanupRef: string | null = null;
  let removalCleanup: { downloadRef: string; revision: string } | null = null;
  function scopeChanged(scope: string) {
    if (loadedScope !== scope) {
      loadedScope = scope;
      repairRequired = false;
      removalCleanup = null;
      playbackCleanupRef = null;
      emit({ revision: null, entries: [], message: null, cleanupPending: false });
    }
  }
  let closed = false,
    suspended = false;
  let cleanup: Promise<void> | null = null;
  const view = () =>
    Object.freeze({
      ...snapshot,
      entries: Object.freeze(snapshot.entries.map((e) => Object.freeze({ ...e }))),
      progress: snapshot.progress ? Object.freeze({ ...snapshot.progress }) : null,
    });
  const emit = (patch: Partial<ArchiveDownloadsSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) {
      try {
        listener(view());
      } catch {
        /* View observers do not own the task. */
      }
    }
  };
  const admission = (retryRemoval?: string) => {
    const scope = host.readyScope();
    if (closed || suspended || scope === null) throw new ArchiveDownloadError('unavailable');
    if (job || (snapshot.cleanupPending && retryRemoval !== removalCleanup?.downloadRef))
      throw new ArchiveDownloadError(snapshot.cleanupPending ? 'cleanup' : 'busy');
    if (loadedScope !== null && loadedScope !== scope) throw new ArchiveDownloadError('stale');
    scopeChanged(scope);
    return scope;
  };
  function failed(error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError')
      emit({ state: 'canceled', message: 'Download canceled. Saved videos are preserved.' });
    else {
      const safe = error instanceof ArchiveDownloadError ? error : new ArchiveDownloadError();
      if (safe.category === 'repair') repairRequired = true;
      emit({
        state: 'failed',
        message: safe.message,
        cleanupPending:
          safe.category === 'cleanup' || safe.category === 'repair' || snapshot.cleanupPending,
      });
    }
  }
  async function refresh(): Promise<void> {
    const scope = host.readyScope();
    if (closed || suspended || scope === null) return;
    if (loadedScope !== null && loadedScope !== scope) {
      await cancel();
      if (closed || suspended || scope !== host.readyScope()) return;
    }
    scopeChanged(scope);
    const owner = new AbortController();
    if (!job) emit({ state: 'reading' });
    const work = Promise.resolve().then(async () => {
      try {
        const list = await native.list(owner.signal);
        if (scope === host.readyScope()) repairRequired = false;
        if (
          !owner.signal.aborted &&
          scope === host.readyScope() &&
          !closed &&
          (snapshot.revision === null || BigInt(list.revision) >= BigInt(snapshot.revision))
        )
          emit({
            revision: list.revision,
            entries: list.entries,
            ...(!job ? { state: 'idle' as const } : {}),
          });
      } catch (error) {
        if (error instanceof ArchiveDownloadError && error.category === 'cleanup') {
          failed(error);
          throw error;
        }
        if (!owner.signal.aborted && !job && scope === host.readyScope()) failed(error);
      } finally {
        reads.delete(owner);
      }
    });
    reads.set(owner, work);
    await work;
  }
  function download(fileRef: string, expectedRevision: string): Promise<ArchiveDownloadReceipt> {
    let scope: string;
    try {
      scope = admission();
    } catch (error) {
      return Promise.reject(error);
    }
    const abort = new AbortController();
    emit({ state: 'preparing', activeFileRef: fileRef, progress: null, message: null });
    const work = Promise.resolve().then(async () => {
      try {
        const receipt = await native.start(fileRef, expectedRevision, abort.signal, (p) => {
          if (scope === host.readyScope() && !closed) emit({ progress: p, state: p.phase });
        });
        // Native durable completion wins a late cancellation. Never invent completion from bytes.
        if (scope === host.readyScope() && !closed)
          emit({
            revision: receipt.revision,
            entries: [
              ...snapshot.entries.filter((e) => e.fileRef !== receipt.entry.fileRef),
              receipt.entry,
            ],
            state: 'saved',
            message: native.cleanupPending
              ? 'Saved on this device. Download cleanup needs a retry.'
              : 'Saved on this device.',
            cleanupPending: native.cleanupPending ?? false,
          });
        return receipt;
      } catch (error) {
        if (scope === host.readyScope() && !closed) failed(error);
        throw error;
      } finally {
        if (job?.abort === abort) {
          job = null;
          if (scope === host.readyScope() && !closed) emit({ activeFileRef: null, progress: null });
        }
      }
    });
    job = { abort, work };
    return work;
  }
  function remove(
    downloadRef: string,
    expectedRevision: string,
  ): Promise<ArchiveDownloadRemoveReceipt> {
    let scope: string;
    try {
      scope = admission(downloadRef);
    } catch (error) {
      return Promise.reject(error);
    }
    const abort = new AbortController();
    emit({ state: 'removing', message: null });
    const work = Promise.resolve().then(async () => {
      try {
        abort.signal.throwIfAborted();
        try {
          await host.beforeRemove?.(downloadRef, abort.signal);
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          playbackCleanupRef = downloadRef;
          throw new ArchiveDownloadError('cleanup');
        }
        abort.signal.throwIfAborted();
        if (scope !== host.readyScope())
          throw new DOMException('Download root changed.', 'AbortError');
        const receipt = await native.remove(downloadRef, expectedRevision, abort.signal);
        removalCleanup = receipt.cleanupPending
          ? { downloadRef, revision: receipt.revision }
          : null;
        if (scope === host.readyScope() && !closed)
          emit({
            revision: receipt.revision,
            entries: receipt.cleanupPending
              ? snapshot.entries.map((e) =>
                  e.downloadRef === receipt.downloadRef
                    ? { ...e, available: false, cleanupPending: true as const }
                    : e,
                )
              : snapshot.entries.filter((e) => e.downloadRef !== receipt.downloadRef),
            state: receipt.cleanupPending ? 'failed' : 'idle',
            message: receipt.cleanupPending
              ? 'Download removed. File cleanup needs a retry.'
              : 'Download removed.',
            cleanupPending: receipt.cleanupPending,
          });
        return receipt;
      } catch (error) {
        if (scope === host.readyScope() && !closed) failed(error);
        throw error;
      } finally {
        if (job?.abort === abort) job = null;
      }
    });
    job = { abort, work };
    return work;
  }
  function cancel(): Promise<void> {
    if (cleanup) return cleanup;
    job?.abort.abort();
    for (const owner of reads.keys()) owner.abort();
    if (job) emit({ state: 'canceling', message: 'Canceling download…' });
    const original = job?.work;
    const work = Promise.resolve()
      .then(async () => {
        const results = await Promise.allSettled([
          native.stop(),
          ...(original ? [original] : []),
          ...reads.values(),
        ]);
        if (
          results[0]?.status === 'rejected' ||
          results
            .slice(1)
            .some(
              (r) =>
                r.status === 'rejected' &&
                r.reason instanceof ArchiveDownloadError &&
                r.reason.category === 'cleanup',
            )
        ) {
          emit({
            state: 'failed',
            cleanupPending: true,
            message: new ArchiveDownloadError('cleanup').message,
          });
          throw new ArchiveDownloadError('cleanup');
        }
        if (playbackCleanupRef && loadedScope === host.readyScope()) {
          await host.beforeRemove?.(playbackCleanupRef, new AbortController().signal);
          playbackCleanupRef = null;
        }
        if (removalCleanup && loadedScope === host.readyScope()) {
          const receipt = await native.remove(removalCleanup.downloadRef, removalCleanup.revision);
          if (receipt.cleanupPending) throw new ArchiveDownloadError('cleanup');
          const removedRef = removalCleanup.downloadRef;
          removalCleanup = null;
          emit({
            revision: receipt.revision,
            entries: snapshot.entries.filter((e) => e.downloadRef !== removedRef),
          });
        }
        if (repairRequired && loadedScope === host.readyScope()) {
          const list = await native.list();
          repairRequired = false;
          emit({ revision: list.revision, entries: list.entries });
        }
        emit({
          cleanupPending: false,
          ...(snapshot.state === 'canceling'
            ? {
                state: 'canceled' as const,
                message: 'Download canceled. Saved videos are preserved.',
              }
            : {}),
        });
      })
      .catch((error: unknown) => {
        failed(error);
        throw error;
      })
      .finally(() => {
        if (cleanup === work) cleanup = null;
      });
    cleanup = work;
    return work;
  }
  return {
    get snapshot() {
      return view();
    },
    subscribe(listener: (s: Readonly<ArchiveDownloadsSnapshot>) => void) {
      listeners.add(listener);
      listener(view());
      return () => listeners.delete(listener);
    },
    refresh,
    download,
    remove,
    cancel,
    async suspend() {
      suspended = true;
      await cancel();
    },
    async resume() {
      if (closed) return;
      suspended = false;
      await refresh();
    },
    async dispose() {
      if (closed) return;
      suspended = true;
      await cancel();
      closed = true;
      emit({ state: 'disposed' });
      listeners.clear();
    },
  };
}
export type ArchiveDownloads = ReturnType<typeof createArchiveDownloads>;
