import { playbackResourceOwners, type ResourceOwners } from '../playback/resource-owners';
/** Owned signal composition for WebViews without AbortSignal.any. */
export function createOwnedAbortSignals(
  signals: readonly AbortSignal[],
  owners: ResourceOwners = playbackResourceOwners,
): { signal: AbortSignal; dispose: () => void } {
  owners.cover('abort-signals');
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, { listener: () => void; release: () => void }>();
  const dispose = (): void => {
    let failed = false;
    for (const [signal, { listener, release }] of listeners) {
      try {
        signal.removeEventListener('abort', listener);
        release();
        listeners.delete(signal);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error('Signal cleanup did not finish. Retry releasing the player.');
  };
  const abort = (source: AbortSignal): void => {
    try {
      dispose();
    } catch {
      // Explicit disposal retries retained leases; event callbacks must not throw.
    } finally {
      controller.abort(source.reason);
    }
  };
  for (const signal of new Set(signals)) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    const listener = () => abort(signal);
    signal.addEventListener('abort', listener, { once: true });
    listeners.set(signal, { listener, release: owners.acquire('abortListeners') });
  }
  return { signal: controller.signal, dispose };
}

export function combineAbortSignals(
  signals: readonly AbortSignal[],
  owners: ResourceOwners = playbackResourceOwners,
): AbortSignal {
  return createOwnedAbortSignals(signals, owners).signal;
}
