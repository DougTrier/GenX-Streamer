import type { CatalogRecord } from '../catalog';
import type { Preferences } from '../preferences';
import type {
  PreparedScanCommit,
  PreparedNativeScanBatch,
  ReviewedScanHealthContext,
  PreparedCompactScanCommit,
  ScanPreparationHealthOptions,
} from './prepare-selection';
import type { ScanSource, StagedScanSelection } from './scan';
import { isScanPreparationFailureCode } from './selection-failure';
export function prepareScanInWorker(
  catalog: CatalogRecord,
  preferences: Preferences,
  selection: StagedScanSelection,
  scope: ScanSource[],
  signal: AbortSignal,
  health?: ScanPreparationHealthOptions,
): Promise<PreparedScanCommit> {
  return prepareInWorker(catalog, preferences, selection, scope, signal, health);
}
export function prepareCompactScanInWorker(
  catalog: CatalogRecord,
  preferences: Preferences,
  selection: StagedScanSelection,
  scope: ScanSource[],
  signal: AbortSignal,
  health?: ScanPreparationHealthOptions,
): Promise<PreparedCompactScanCommit> {
  return prepareInWorker(catalog, preferences, selection, scope, signal, health, 'compact');
}
export function prepareNativeScanBatchInWorker(
  catalog: CatalogRecord,
  preferences: Preferences,
  selection: StagedScanSelection,
  scope: ScanSource[],
  signal: AbortSignal,
  review?: ReviewedScanHealthContext,
): Promise<PreparedNativeScanBatch> {
  return prepareInWorker(
    catalog,
    preferences,
    selection,
    scope,
    signal,
    undefined,
    'native-batch',
    review,
  );
}
function prepareInWorker<
  T extends PreparedScanCommit | PreparedCompactScanCommit | PreparedNativeScanBatch,
>(
  catalog: CatalogRecord,
  preferences: Preferences,
  selection: StagedScanSelection,
  scope: ScanSource[],
  signal: AbortSignal,
  health?: ScanPreparationHealthOptions,
  operation?: 'compact' | 'native-batch',
  review?: ReviewedScanHealthContext,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Scan canceled.', 'AbortError'));
      return;
    }
    const worker = new Worker(new URL('./selection-worker.ts', import.meta.url), {
      type: 'module',
    });
    let settled = false;
    const cleanup = () => {
      settled = true;
      signal.removeEventListener('abort', abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('Scan canceled.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => {
      if (settled) return;
      cleanup();
      reject(new Error('prepare-worker-runtime'));
    };
    worker.onmessageerror = () => {
      if (settled) return;
      cleanup();
      reject(new Error('prepare-worker-protocol'));
    };
    worker.onmessage = (event: MessageEvent<{ ok: boolean; result: T; code?: unknown }>) => {
      if (settled || signal.aborted) return;
      cleanup();
      if (event.data?.ok === true) resolve(event.data.result);
      else
        reject(
          new Error(
            isScanPreparationFailureCode(event.data?.code)
              ? event.data.code
              : 'prepare-worker-protocol',
          ),
        );
    };
    try {
      // postMessage synchronously captures its own structured clone before returning.
      worker.postMessage({
        catalog,
        preferences,
        selection,
        scope,
        ...(health ? { health } : {}),
        ...(review ? { review } : {}),
        ...(operation ? { operation } : {}),
      });
    } catch {
      cleanup();
      reject(new Error('prepare-worker-clone'));
    }
  });
}
