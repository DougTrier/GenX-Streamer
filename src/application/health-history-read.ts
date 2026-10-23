import type {
  decodeSavedHealth,
  decodeSavedHealthOnly,
  SavedHealthOnlySnapshot,
  SavedHealthSnapshot,
  SavedHealthQuery,
  SavedHealthContext,
  SavedHealthPage,
} from './health-history';

type HistoryRequest =
  | { kind: 'decode'; snapshot: SavedHealthSnapshot }
  | { kind: 'decode-health'; snapshot: SavedHealthOnlySnapshot }
  | {
      kind: 'page';
      snapshot: SavedHealthSnapshot;
      query: SavedHealthQuery;
      context: SavedHealthContext;
    };
function inWorker<T>(request: HistoryRequest, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./health-history-worker.ts', import.meta.url), {
      type: 'module',
    });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      action();
    };
    const cancel = () =>
      finish(() => reject(new DOMException('Saved check read canceled.', 'AbortError')));
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (event: MessageEvent<{ ok: boolean; value: T; error: string }>) =>
      finish(() =>
        event.data.ok ? resolve(event.data.value) : reject(new Error(event.data.error)),
      );
    worker.onerror = () => finish(() => reject(new Error('Saved check data could not be read.')));
    worker.onmessageerror = () =>
      finish(() => reject(new Error('Saved check worker returned invalid data.')));
    try {
      worker.postMessage(request);
    } catch {
      finish(() => reject(new Error('Saved check read could not start.')));
    }
    if (signal?.aborted) cancel();
  });
}
export const decodeSavedHealthInWorker = (snapshot: SavedHealthSnapshot, signal?: AbortSignal) =>
  inWorker<ReturnType<typeof decodeSavedHealth>>({ kind: 'decode', snapshot }, signal);
export const decodeSavedHealthOnlyInWorker = (
  snapshot: SavedHealthOnlySnapshot,
  signal?: AbortSignal,
) =>
  inWorker<ReturnType<typeof decodeSavedHealthOnly>>(
    { kind: 'decode-health', snapshot: { health: snapshot.health } },
    signal,
  );
export const healthHistoryInWorker = (
  snapshot: SavedHealthSnapshot,
  query: SavedHealthQuery,
  context: SavedHealthContext,
  signal?: AbortSignal,
) => inWorker<SavedHealthPage>({ kind: 'page', snapshot, query, context }, signal);
export type { HistoryRequest };
