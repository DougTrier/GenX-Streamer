import type {
  BackupRecord,
  LegacyMigrationOptions,
  PreparedLegacyTransfer,
  PreparedTransfer,
} from './index';
export type TransferRequest =
  | { kind: 'export'; record: BackupRecord }
  | { kind: 'backup'; text: string }
  | { kind: 'legacy'; text: string; options: LegacyMigrationOptions };
/** Offloads bounded preparation. Cancellation terminates the worker before any persistence can occur. */
export function prepareImportInWorker(
  request: TransferRequest,
  signal?: AbortSignal,
): Promise<PreparedTransfer | PreparedLegacyTransfer> {
  if (signal?.aborted) return Promise.reject(new DOMException('Import canceled.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./transfer-worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      operation();
    };
    const abort = () => finish(() => reject(new DOMException('Import canceled.', 'AbortError')));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event) => {
      const response = event.data as {
        ok: boolean;
        result?: PreparedTransfer | PreparedLegacyTransfer;
        error?: string;
      };
      if (response.ok && response.result) finish(() => resolve(response.result!));
      else finish(() => reject(new Error(response.error ?? 'Import preparation failed.')));
    };
    worker.onerror = () =>
      finish(() => reject(new Error('Import worker failed. No records were written.')));
    worker.onmessageerror = () =>
      finish(() => reject(new Error('Import worker returned invalid data.')));
    try {
      worker.postMessage(request);
    } catch {
      finish(() => reject(new Error('Import preparation could not start.')));
    }
    if (signal?.aborted) abort();
  });
}
