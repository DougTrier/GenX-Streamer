import type { PrepareDecodedHealthInput, PreparedDecodedHealth } from './prepare-decoded-health';
export function prepareDecodedHealthInWorker(
  input: PrepareDecodedHealthInput,
  signal: AbortSignal,
): Promise<PreparedDecodedHealth> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL('./decoded-health-worker.ts', import.meta.url), {
      type: 'module',
    });
    let settled = false;
    const cleanup = () => {
      settled = true;
      worker.terminate();
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      if (settled) return;
      cleanup();
      reject(new DOMException('Decoder observation canceled.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ ok: boolean; result: PreparedDecodedHealth }>) => {
      if (settled) return;
      cleanup();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error('Decoder observation could not be prepared.'));
    };
    worker.onerror = () => {
      if (settled) return;
      cleanup();
      reject(new Error('Decoder observation worker failed.'));
    };
    try {
      worker.postMessage(structuredClone(input));
    } catch {
      cleanup();
      reject(new Error('Decoder observation could not be transferred.'));
    }
  });
}
