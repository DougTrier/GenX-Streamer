import {
  discoveryMetadata,
  type CompactDiscoveryMetadata,
  type DiscoveryMetadata,
} from './discovery-metadata';

/** Off-thread parse of published channel metadata; the worker is always terminated. */
export function buildDiscoveryMetadataInWorker(
  channels: string,
  blocklist: string | undefined,
  signal: AbortSignal,
): Promise<DiscoveryMetadata> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./discovery-metadata.worker.ts', import.meta.url), {
      type: 'module',
    });
    let settled = false;
    const finish = (result?: DiscoveryMetadata, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () =>
      finish(undefined, new DOMException('Discovery metadata canceled.', 'AbortError'));
    const timer = setTimeout(
      () => finish(undefined, new Error('Channel discovery metadata timed out.')),
      20_000,
    );
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ metadata?: CompactDiscoveryMetadata }>) => {
      try {
        if (!event.data.metadata) throw new Error('Channel discovery metadata is unavailable.');
        finish(discoveryMetadata(event.data.metadata));
      } catch (error) {
        finish(undefined, error instanceof Error ? error : new Error('Metadata failed.'));
      }
    };
    worker.onerror = () => finish(undefined, new Error('Channel discovery metadata failed.'));
    try {
      worker.postMessage({ channels, blocklist });
    } catch {
      finish(undefined, new Error('Channel discovery metadata failed.'));
    }
  });
}
