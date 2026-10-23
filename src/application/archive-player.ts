import {
  validateArchiveDownloadEntry,
  downloadRevision,
  type ArchiveDownloadEntry,
} from '../platform/archive-downloads';
import type {
  PlaybackController,
  SeekOutcome,
  VODReleaseObservation,
} from '../playback/controller';
import {
  createArchiveBookmarks,
  type ArchiveBookmarkPosition,
} from '../platform/archive-bookmarks';
import { createOwnedAbortSignals } from '../platform/abort';
import { boundedUtf8Text } from '../platform/bounded-text';
import { createJoinedWorkTimings } from './joined-work-timings';
import { archiveRevision, type ArchiveSelection } from '../platform/archive-catalog';
import {
  createArchivePlayback,
  validateArchivePlaybackReceipt,
  validateArchivePlaybackStopReceipt,
  validateArchivePlaybackRenewReceipt,
  type ArchivePlaybackReceipt,
  type ArchivePlaybackConfirmedDeadReceipt,
  ArchivePlaybackCleanupError,
  ArchivePlaybackUnavailableError,
  ArchivePlaybackFailureError,
  isArchivePlaybackFailure,
  archivePlaybackFailureGuidance,
} from '../platform/archive-playback';

export interface ArchivePlayerClock {
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export interface ArchivePlayerHost {
  player: Pick<PlaybackController, 'select' | 'stop'> &
    Partial<
      Pick<
        PlaybackController,
        | 'subscribe'
        | 'joinFailedCleanup'
        | 'currentVODposition'
        | 'checkpointVODposition'
        | 'currentVODduration'
        | 'subscribeVODRelease'
      >
    > & { seekWhenReady?(seconds: number, signal: AbortSignal): Promise<SeekOutcome> };
  bookmarks?: Pick<ReturnType<typeof createArchiveBookmarks>, 'read' | 'save'>;
  chooseResume?(
    selection: Readonly<ArchiveSelection>,
    position: Readonly<ArchiveBookmarkPosition>,
    signal: AbortSignal,
  ): Promise<'resume' | 'restart' | 'cancel'>;
  bookmarkFailed?(message: string): void;
  playback?: Pick<
    ReturnType<typeof createArchivePlayback>,
    'start' | 'stop' | 'renew' | 'retryCleanup'
  > &
    Partial<Pick<ReturnType<typeof createArchivePlayback>, 'startSaved'>>;
  readyScope(): string | null;
  catalogRevision(): string | null;
  /** Join sharing/public/account release only after this queued intent is still current. */
  beforeStart(signal: AbortSignal): Promise<void>;
  confirmedDead?(receipt: ArchivePlaybackConfirmedDeadReceipt): Promise<void> | void;
  failed?(message: string): void;
  clock?: ArchivePlayerClock;
  timingNow?(): number;
}
interface Session {
  selection: ArchiveSelection;
  receipt: ArchivePlaybackReceipt;
  scope: string;
  generation: number;
  abort: AbortController;
  bookmarkRevision: string | null;
  captureEnabled: boolean;
  decoderSelected: boolean;
  completed: boolean;
  saveBlocked: boolean;
  pendingSave: BookmarkPatch | null;
  lastSave: BookmarkPatch | null;
  saveWork: Promise<void> | null;
}
interface BookmarkPatch {
  positionMs: number;
  durationMs: number | null;
  completed: boolean;
}
const canceled = () => new DOMException('Archive selection was canceled.', 'AbortError');
export class ArchivePlayerCleanupError extends Error {
  constructor() {
    super('Archive playback could not stop. Retry Stop before choosing another item.');
  }
}
export class ArchiveFileRemovedError extends Error {
  constructor(readonly receipt: ArchivePlaybackConfirmedDeadReceipt) {
    super('This Archive file is no longer available and was removed from the playable list.');
  }
}
/** Returns fixed guidance only for branded native failures or known local owner errors. */
export function archivePlayerFailureGuidance(error: unknown): string {
  if (error instanceof ArchivePlayerCleanupError)
    return archivePlaybackFailureGuidance(new ArchivePlaybackCleanupError());
  const removed =
    error instanceof ArchiveFileRemovedError ||
    (error instanceof Error && error.cause instanceof ArchiveFileRemovedError);
  if (removed)
    return 'Archive confirmed this video is unavailable and removed it from saved results. Choose another video.';
  return archivePlaybackFailureGuidance(error);
}
function metadata(value: ArchiveSelection): ArchiveSelection {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![5, 7].includes(Object.keys(value).length) ||
    Object.keys(value).some(
      (key) =>
        ![
          'titleRef',
          'fileRef',
          'expectedRevision',
          'title',
          'fileTitle',
          'downloadRef',
          'downloadRevision',
        ].includes(key),
    ) ||
    ((Object.hasOwn(value, 'downloadRef') || Object.hasOwn(value, 'downloadRevision')) &&
      (!downloadRevision(value.downloadRevision) ||
        !/^[a-f0-9]{64}$/u.test(value.downloadRef ?? '') ||
        value.downloadRevision !== value.expectedRevision)) ||
    !['titleRef', 'fileRef', 'expectedRevision', 'title', 'fileTitle'].every((key) =>
      Object.hasOwn(value, key),
    ) ||
    !/^[a-f0-9]{64}$/u.test(value.titleRef) ||
    !/^[a-f0-9]{64}$/u.test(value.fileRef) ||
    !archiveRevision(value.expectedRevision) ||
    [value.title, value.fileTitle].some(
      (text) => !boundedUtf8Text(text, 512) || /[\p{Cc}\p{Cf}]/u.test(text) || text.includes('://'),
    )
  ) {
    throw new Error('The saved Archive selection is invalid. Reload its titles.');
  }
  return { ...value };
}
/** Owns a transient Archive capability and hands it to the application's existing decoder. */
export function createArchivePlayer(host: ArchivePlayerHost) {
  const timings = createJoinedWorkTimings(host.timingNow);
  const playback = host.playback ?? createArchivePlayback();
  const clock: ArchivePlayerClock = host.clock ?? {
    setTimeout: (fn, delay) => setTimeout(fn, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  };
  let session: Session | null = null;
  let failedChoice: { selection: Readonly<ArchiveSelection>; scope: string } | null = null;
  let grantedUrl: string | null = null;
  let generation = 0;
  let owner: AbortController | null = null;
  let queue: Promise<void> = Promise.resolve();
  let renewal: Promise<void> | null = null;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false,
    closing = false;
  let disposal: Promise<void> | null = null;
  let decoderStops = 0;
  const failedSignals = new Set<() => void>();
  const failedSessions = new WeakSet<Session>();
  const disposeSignals = (dispose: () => void) => {
    try {
      dispose();
      failedSignals.delete(dispose);
    } catch {
      failedSignals.add(dispose);
      throw new ArchivePlayerCleanupError();
    }
  };
  const revoke = () => {
    grantedUrl = null;
  };
  const clearRenewal = () => {
    if (renewalTimer !== undefined) clock.clearTimeout(renewalTimer);
    renewalTimer = undefined;
  };
  const enqueue = (operation: () => Promise<void>) => {
    const admitted = timings.begin('archive-queue-wait', generation);
    const work = queue.then(() => {
      admitted('fulfilled');
      return operation();
    });
    queue = work.catch(() => undefined);
    return work;
  };
  const bookmarkNotice = () => {
    try {
      host.bookmarkFailed?.(
        'Your playback position could not be saved. Your previous saved position is preserved.',
      );
    } catch {
      /* A notice cannot detach the retained native save or session cleanup. */
    }
  };
  const savePatch = (active: Session, patch: BookmarkPatch) => {
    if (!host.bookmarks || active.bookmarkRevision === null || active.saveBlocked) return;
    active.pendingSave = { ...patch };
    if (active.saveWork) return;
    const work = Promise.resolve().then(async () => {
      while (active.pendingSave && !active.saveBlocked) {
        const pending = active.pendingSave;
        active.pendingSave = null;
        if (active.lastSave && JSON.stringify(active.lastSave) === JSON.stringify(pending))
          continue;
        try {
          // Independent from session cancellation: native proof is retained until this original settles.
          const receipt = await timings.run('archive-bookmark-save', active.generation, () =>
            host.bookmarks!.save({
              schemaVersion: 1,
              sessionGeneration: active.receipt.sessionGeneration,
              expectedRevision: active.bookmarkRevision!,
              ...pending,
            }),
          );
          active.bookmarkRevision = receipt.revision;
          active.lastSave = pending;
        } catch {
          active.saveBlocked = true;
          active.pendingSave = pending;
          bookmarkNotice();
        }
      }
    });
    active.saveWork = work;
    void work.finally(() => {
      if (active.saveWork === work) active.saveWork = null;
    });
  };
  // Save the last observed lifecycle position; lease renewal never schedules storage writes.
  // This intentionally does not promise recovery of the latest frame after a process crash.
  const capture = (active: Session, observation?: VODReleaseObservation) => {
    if (
      !active.captureEnabled ||
      !active.decoderSelected ||
      active.completed ||
      !host.bookmarks ||
      host.readyScope() !== active.scope
    )
      return;
    const position = observation
      ? observation.positionSeconds
      : host.player.checkpointVODposition
        ? host.player.checkpointVODposition()
        : host.player.currentVODposition?.();
    const duration = observation ? observation.durationSeconds : host.player.currentVODduration?.();
    if (
      typeof position !== 'number' ||
      !Number.isFinite(position) ||
      position < 0 ||
      position > 604800
    )
      return;
    const durationMs =
      typeof duration === 'number' &&
      Number.isFinite(duration) &&
      duration > 0 &&
      duration <= 604800
        ? Math.floor(duration * 1000)
        : null;
    const positionMs = Math.floor(position * 1000);
    if (durationMs !== null && positionMs > durationMs) return;
    active.completed = observation?.reason === 'completed';
    savePatch(active, { positionMs, durationMs, completed: active.completed });
  };
  const stopDecoder = () => {
    decoderStops++;
    const observed = timings.begin('archive-decoder-stop', generation);
    try {
      return Promise.resolve(host.player.stop())
        .then(
          () => {
            observed('fulfilled');
          },
          (error) => {
            observed('rejected');
            throw error;
          },
        )
        .finally(() => {
          decoderStops--;
        });
    } catch {
      observed('rejected');
      decoderStops--;
      return Promise.reject(new ArchivePlayerCleanupError());
    }
  };
  const release = async (stopped?: Promise<void>, observedGeneration = generation) => {
    clearRenewal();
    revoke();
    session?.abort.abort();
    try {
      // This owner shares the application's decoder with Live TV. An idle
      // Archive cleanup must still join native cleanup, but has no authority
      // to stop a public/account decoder (including a background pause).
      await timings.run(
        'archive-decoder-join',
        observedGeneration,
        () => stopped ?? (session?.decoderSelected ? stopDecoder() : undefined),
      );
      if (session)
        await timings.run('archive-bookmark-join', observedGeneration, () => session!.saveWork);
      // Native renewal cannot outlive the actual decoder/proxy release.
      await timings.run('archive-renewal-join', observedGeneration, () =>
        renewal?.catch(() => undefined),
      );
      for (const dispose of [...failedSignals]) disposeSignals(dispose);
      const previous = session;
      if (previous) {
        const receipt = await timings.run('archive-native-stop', observedGeneration, () =>
          playback.stop(previous.receipt.sessionGeneration),
        );
        validateArchivePlaybackStopReceipt(receipt, previous.receipt.sessionGeneration);
        if (session === previous) session = null;
      }
      await timings.run('archive-native-retry', observedGeneration, () => playback.retryCleanup());
    } catch {
      throw new ArchivePlayerCleanupError();
    }
  };
  const begin = (allowClosing = false) => {
    if (closed || (closing && !allowClosing)) throw new Error('The Archive player is closed.');
    if (session) capture(session);
    const captured = ++generation;
    failedChoice = null;
    owner?.abort();
    session?.abort.abort();
    clearRenewal();
    revoke();
    const owned = new AbortController();
    owner = owned;
    // Interrupt an Archive decoder immediately, without mutating a public/account decoder before handoff admission.
    const stopped = session?.decoderSelected ? stopDecoder() : undefined;
    void stopped?.catch(() => undefined);
    return { captured, owned, stopped };
  };
  const current = (captured: number, owned: AbortController, signal: AbortSignal, scope: string) =>
    !closed &&
    !closing &&
    generation === captured &&
    owner === owned &&
    !signal.aborted &&
    host.readyScope() === scope;
  const sessionCurrent = (active: Session) =>
    session === active &&
    !closed &&
    !closing &&
    generation === active.generation &&
    !active.abort.signal.aborted &&
    host.readyScope() === active.scope;
  function armRenewal(active: Session): void {
    clearRenewal();
    if (!sessionCurrent(active)) return;
    renewalTimer = clock.setTimeout(() => {
      renewalTimer = undefined;
      if (!sessionCurrent(active)) {
        void stop().catch(() => {
          host.failed?.('Archive playback cleanup could not finish. Retry Stop.');
        });
        return;
      }
      const work = Promise.resolve().then(async () => {
        if (!sessionCurrent(active)) return;
        try {
          const receipt = await playback.renew(
            active.receipt.sessionGeneration,
            active.abort.signal,
          );
          validateArchivePlaybackRenewReceipt(receipt, active.receipt.sessionGeneration);
          if (sessionCurrent(active)) armRenewal(active);
        } catch (error) {
          if (session !== active || active.abort.signal.aborted || generation !== active.generation)
            return;
          revoke();
          active.abort.abort();
          // Enqueue after this renewal operation; never deadlock release by joining itself.
          void stop().catch(() => {
            host.failed?.('Archive playback cleanup could not finish. Retry Stop.');
          });
          host.failed?.(archivePlayerFailureGuidance(error));
        }
      });
      renewal = work;
      void work
        .finally(() => {
          if (renewal === work) renewal = null;
        })
        .catch(() => undefined);
    }, 20_000);
  }
  async function stop(): Promise<void> {
    if (closed) return;
    await timings.run('archive-stop-total', generation + 1, async () => {
      const { captured, owned, stopped } = begin(true);
      await enqueue(async () => {
        try {
          await release(stopped, captured);
        } finally {
          if (owner === owned) owner = null;
        }
      });
    });
  }
  const unsubscribeRelease = host.player.subscribeVODRelease?.((observation) => {
    const active = session;
    if (
      active &&
      observation.selectionId === `archive-${active.selection.fileRef}` &&
      active.generation === generation
    )
      capture(active, observation);
  });
  const unsubscribe = host.player.subscribe?.((snapshot) => {
    if (!session || decoderStops || !['idle', 'failed', 'disposed'].includes(snapshot.state))
      return;
    if (snapshot.selection && snapshot.selection.id !== `archive-${session.selection.fileRef}`)
      return;
    if (snapshot.state === 'failed') {
      const failedSession = session;
      if (failedSessions.has(failedSession)) return;
      failedSessions.add(failedSession);
      failedChoice = {
        selection: Object.freeze({ ...failedSession.selection }),
        scope: failedSession.scope,
      };
      clearRenewal();
      revoke();
      failedSession.abort.abort();
      const joined = host.player.joinFailedCleanup
        ? host.player.joinFailedCleanup(`archive-${failedSession.selection.fileRef}`)
        : Promise.reject(new ArchivePlayerCleanupError());
      void joined.catch(() => undefined);
      void enqueue(async () => {
        // Always join the captured original, even if selection changed while
        // it settled. Never call Stop on a replacement decoder from this lane.
        await joined;
        if (session !== failedSession || generation !== failedSession.generation) return;
        await release(joined, failedSession.generation);
      }).catch(() => {
        if (
          session === failedSession &&
          generation === failedSession.generation &&
          host.readyScope() === failedSession.scope &&
          !closed &&
          !closing
        )
          host.failed?.('Archive playback cleanup could not finish. Retry Stop.');
      });
      return;
    }
    void stop().catch(() => {
      host.failed?.('Archive playback cleanup could not finish. Retry Stop.');
    });
  });
  async function select(input: ArchiveSelection, signal?: AbortSignal): Promise<void> {
    const selection = metadata(input);
    const saved =
      selection.downloadRef && selection.downloadRevision
        ? { downloadRef: selection.downloadRef, revision: selection.downloadRevision }
        : undefined;
    signal?.throwIfAborted();
    const scope = host.readyScope();
    if (scope === null || (!saved && host.catalogRevision() !== selection.expectedRevision))
      throw new ArchivePlaybackFailureError('archive-revision-stale');
    const { captured, owned, stopped } = begin();
    const combined = createOwnedAbortSignals(signal ? [owned.signal, signal] : [owned.signal]);
    let interrupted: Promise<void> | undefined;
    const interrupt = () => {
      if (generation !== captured || owner !== owned) return;
      clearRenewal();
      revoke();
      if (session?.decoderSelected) {
        session.abort.abort();
        interrupted ??= stopDecoder();
        void interrupted.catch(() => undefined);
      }
    };
    combined.signal.addEventListener('abort', interrupt, { once: true });
    await enqueue(async () => {
      let issued: Session | null = null;
      const check = () => {
        if (!current(captured, owned, combined.signal, scope)) throw canceled();
      };
      const checkCatalog = () => {
        check();
        if (!saved && host.catalogRevision() !== selection.expectedRevision) throw canceled();
      };
      try {
        await release(stopped, captured);
        checkCatalog();
        await host.beforeStart(combined.signal);
        checkCatalog();
        const result = saved
          ? await (playback.startSaved
              ? playback.startSaved(
                  {
                    schemaVersion: 1,
                    downloadRef: saved.downloadRef,
                    expectedRevision: saved.revision,
                  },
                  combined.signal,
                )
              : Promise.reject(new ArchivePlaybackUnavailableError()))
          : await playback.start(
              {
                schemaVersion: 1,
                fileRef: selection.fileRef,
                expectedRevision: selection.expectedRevision,
              },
              combined.signal,
            );
        if (result.kind === 'confirmedDead') {
          // Actual COMMIT cannot be hidden by a late cancellation; the host
          // reconciles authoritative metadata under its own UI ready scope.
          try {
            await host.confirmedDead?.(result);
          } catch {
            // Reconciliation can fail after native COMMIT. Its arbitrary host
            // error may contain private URLs, so retain the validated durable
            // receipt for the caller to reconcile, without exporting that error.
          }
          throw new ArchiveFileRemovedError(result);
        }
        const receipt = validateArchivePlaybackReceipt(result);
        issued = {
          selection,
          receipt,
          scope,
          generation: captured,
          abort: new AbortController(),
          bookmarkRevision: null,
          captureEnabled: false,
          decoderSelected: false,
          completed: false,
          saveBlocked: false,
          pendingSave: null,
          lastSave: null,
          saveWork: null,
        };
        session = issued;
        check();
        // Renewal owns its own lane while read/choice can keep the selection queue occupied.
        armRenewal(issued);
        let resume: number | null = null;
        if (host.bookmarks) {
          const bookmark = await host.bookmarks.read(receipt.sessionGeneration, combined.signal);
          check();
          if (bookmark.supported) {
            issued.bookmarkRevision = bookmark.revision;
            if (
              bookmark.position &&
              (bookmark.position.positionMs > 0 || bookmark.position.completed)
            ) {
              const decision = host.chooseResume
                ? await host.chooseResume(
                    Object.freeze({ ...selection }),
                    Object.freeze({ ...bookmark.position }),
                    combined.signal,
                  )
                : 'cancel';
              check();
              if (decision === 'cancel') throw canceled();
              if (decision === 'resume' && !bookmark.position.completed)
                resume = bookmark.position.positionMs / 1000;
              else if (decision === 'restart') {
                savePatch(issued, { positionMs: 0, durationMs: null, completed: false });
                await issued.saveWork;
                check();
                if (issued.saveBlocked)
                  throw new Error('The playback position could not be reset.');
              } else throw canceled();
            }
          }
        }
        check();
        issued.captureEnabled = resume === null;
        issued.decoderSelected = true;
        grantedUrl = receipt.mediaUrl;
        await host.player.select({
          id: `archive-${selection.fileRef}`,
          name: selection.fileTitle,
          url: receipt.mediaUrl,
          playMode: 'on-demand',
          mediaKind: 'media',
          mediaMime: receipt.mimeType ?? 'video/mp4',
          crossOrigin: 'anonymous',
        });
        check();
        if (resume !== null) {
          const sought = await host.player.seekWhenReady?.(resume, combined.signal);
          check();
          // A slow or unconfirmed resume seek never stops a video that is playing.
          // Progress saving starts only once playback has reached the saved
          // position, so the previous bookmark is never replaced by a lower one.
          const reached = () => {
            const position = host.player.currentVODposition?.();
            return typeof position === 'number' && position >= resume! - 2;
          };
          if (sought?.ok || reached()) issued.captureEnabled = true;
          else {
            try {
              host.bookmarkFailed?.(
                'Playing now, but your saved spot could not be restored. Your saved position is kept.',
              );
            } catch {
              /* A notice cannot stop playback. */
            }
            const watch = () => {
              if (!sessionCurrent(issued!) || issued!.captureEnabled) return;
              if (reached()) issued!.captureEnabled = true;
              else clock.setTimeout(watch, 5_000);
            };
            clock.setTimeout(watch, 5_000);
          }
        }
      } catch (error) {
        if (issued && session === issued) await release(interrupted);
        else if (interrupted) {
          try {
            await interrupted;
          } catch {
            throw new ArchivePlayerCleanupError();
          }
        }
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (error instanceof ArchivePlayerCleanupError) throw error;
        if (error instanceof ArchivePlaybackCleanupError) throw new ArchivePlayerCleanupError();
        if (error instanceof ArchiveFileRemovedError) throw error;
        if (isArchivePlaybackFailure(error) && error.category === 'cleanup')
          throw new ArchivePlayerCleanupError();
        if (!current(captured, owned, combined.signal, scope)) throw canceled();
        if (error instanceof ArchivePlaybackUnavailableError) throw error;
        if (isArchivePlaybackFailure(error)) throw error;
        // Host/native failures can contain private provider or issued capability URLs.
        // eslint-disable-next-line preserve-caught-error -- Do not attach unvalidated private errors to the public symptom.
        throw new Error('This Archive file could not start. Reload its files or select another.');
      } finally {
        combined.signal.removeEventListener('abort', interrupt);
        disposeSignals(combined.dispose);
        if (owner === owned) owner = null;
      }
    });
  }
  return {
    releaseTimings: () => timings.snapshot(),
    get selection(): ArchiveSelection | null {
      return session
        ? { ...session.selection }
        : failedChoice && failedChoice.scope === host.readyScope()
          ? { ...failedChoice.selection }
          : null;
    },
    allowsHttp(url: string): boolean {
      return (
        session !== null && grantedUrl !== null && url === grantedUrl && sessionCurrent(session)
      );
    },
    allowsRequest(url: string): boolean {
      // MP4 and Range requests reuse the exact one issued file capability.
      return (
        session !== null && grantedUrl !== null && url === grantedUrl && sessionCurrent(session)
      );
    },
    select,
    async selectSaved(
      value: ArchiveDownloadEntry,
      expectedRevision: string,
      signal?: AbortSignal,
    ): Promise<void> {
      const entry = validateArchiveDownloadEntry(value);
      if (!downloadRevision(expectedRevision) || !entry.available)
        throw new ArchivePlaybackUnavailableError();
      // Labels are presentation only; native allocation binds the exact opaque local record.
      await select(
        {
          titleRef: entry.titleRef,
          fileRef: entry.fileRef,
          expectedRevision,
          title: boundedUtf8Text(entry.title, 512) ? entry.title : 'Saved video',
          fileTitle: boundedUtf8Text(entry.fileTitle, 512) ? entry.fileTitle : 'Saved video',
          downloadRef: entry.downloadRef,
          downloadRevision: expectedRevision,
        },
        signal,
      );
    },
    async handoff(
      task: (signal: AbortSignal) => Promise<void>,
      signal?: AbortSignal,
    ): Promise<void> {
      signal?.throwIfAborted();
      const scope = host.readyScope();
      if (scope === null) throw new Error('Playback is waiting for local storage.');
      const { captured, owned, stopped } = begin();
      const combined = createOwnedAbortSignals(signal ? [owned.signal, signal] : [owned.signal]);
      await enqueue(async () => {
        try {
          await release(stopped, captured);
          if (!current(captured, owned, combined.signal, scope)) throw canceled();
          await task(combined.signal);
          if (!current(captured, owned, combined.signal, scope)) throw canceled();
        } finally {
          disposeSignals(combined.dispose);
          if (owner === owned) owner = null;
        }
      });
    },
    stop,
    retryCleanup: stop,
    dispose(): Promise<void> {
      if (closed) return Promise.resolve();
      if (disposal) return disposal;
      closing = true;
      const work = stop().then(() => {
        closed = true;
        unsubscribe?.();
        unsubscribeRelease?.();
        revoke();
      });
      disposal = work;
      void work.catch(() => {
        if (disposal === work) disposal = null;
      });
      return work;
    },
  };
}
