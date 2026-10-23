import type { ProviderGeographyDocuments } from './provider-geography';
import type { ChannelCandidate, Source } from './parser';

export function enrichGeographyInWorker(
  documents: ProviderGeographyDocuments,
  source: Source,
  channels: ChannelCandidate[],
  signal: AbortSignal,
  rawCities?: string,
): Promise<ChannelCandidate[]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./provider-geography.worker.ts', import.meta.url), {
      type: 'module',
    });
    let settled = false;
    const finish = (result?: ChannelCandidate[], error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () =>
      finish(undefined, new DOMException('Geography preparation canceled.', 'AbortError'));
    const timer = setTimeout(
      () => finish(undefined, new Error('Channel geography preparation timed out.')),
      10000,
    );
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ channels?: ChannelCandidate[] }>) => {
      const result = event.data.channels;
      if (!Array.isArray(result) || result.length !== channels.length)
        finish(undefined, new Error('Channel geography metadata is unavailable.'));
      else finish(result);
    };
    worker.onerror = () => finish(undefined, new Error('Channel geography preparation failed.'));
    try {
      worker.postMessage({ documents, source, channels, rawCities });
    } catch {
      finish(undefined, new Error('Channel geography preparation failed.'));
    }
  });
}
