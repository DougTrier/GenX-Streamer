import { nativeGuide } from '../guide/native';
import { maintainGuideStorage } from '../guide/maintenance';

/** Quiescent full-Guide maintenance; startup cache-only work never calls this host. */
export function createGuideMaintenance(host: {
  scanning(): boolean;
  scopeCurrent(): boolean;
  changed(): void;
}) {
  return async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (host.scanning()) return 'deferred' as const;
    const sources = await nativeGuide.sources();
    signal.throwIfAborted();
    if (!sources.length) return undefined;
    const coverage = await nativeGuide.coverage(sources[0].id);
    signal.throwIfAborted();
    // Older installed hosts have no projection/maintenance capability.
    if (typeof coverage.projectionCompatible !== 'boolean') return undefined;
    if (host.scanning()) return 'deferred' as const;
    if (!host.scopeCurrent()) throw new DOMException('Guide configuration changed.', 'AbortError');
    const state = await maintainGuideStorage(signal);
    if (state !== 'reopen-required') {
      // Retention may commit even if later physical optimization is deferred.
      try {
        host.changed();
      } catch {
        // A presentation observer cannot erase a durable maintenance receipt.
      }
    }
    return state;
  };
}
