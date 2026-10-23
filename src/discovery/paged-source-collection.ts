import { validateSource } from '../catalog/codec';
import { MAX_PLAYLIST_BYTES, type Source } from '../catalog/parser';
import { openPagedParser, type PagedParsedSource } from '../catalog/paged-parser-service';
import type { PagedParserInput } from '../catalog/paged-parser-protocol';
import type { ConfiguredSource } from '../sources';

export interface PagedSourceCollectionOptions {
  /** Existing owned native/browser fetch boundary; its promise must join cancellation cleanup. */
  inspectSource(url: string, allowHttp: boolean, signal: AbortSignal): Promise<ConfiguredSource>;
  geography?(source: Source, signal: AbortSignal): Promise<PagedParserInput['geography']>;
  workerFactory?: () => Worker;
}
export interface PagedCollectedSource extends PagedParsedSource { readonly source: Source }

/** Production collection fetches bounded input, then retains all parsed entries only in a worker. */
export function createPagedSourceCollection(options: PagedSourceCollectionOptions) {
  let closed = false;
  type Job = { controller: AbortController; done: Promise<unknown>; parsed?: PagedParsedSource; release?: () => Promise<void> };
  const jobs = new Set<Job>();
  function collect(sourceInput: Source, signal: AbortSignal): Promise<PagedCollectedSource> {
    signal.throwIfAborted();
    if (closed || jobs.size) return Promise.reject(new Error('Source collection is busy or closed.'));
    const source = validateSource(sourceInput);
    if (source.kind !== 'url') return Promise.reject(new Error('Choose the local playlist file again to collect it.'));
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const work = Promise.resolve().then(async (): Promise<PagedCollectedSource> => {
      try {
        controller.signal.throwIfAborted();
        let result: ConfiguredSource | undefined;
        try { result = await options.inspectSource(source.location, source.allowHttp === true, controller.signal); }
        catch (cause) {
          controller.signal.throwIfAborted();
          // The original fixed failure code is kept as the cause for dead-link classification.
          throw new Error('This source could not be read. Check its connection and access permission; saved channels were retained.', { cause });
        }
        controller.signal.throwIfAborted();
        if (!result || !['catalog', 'hls', 'media'].includes(result.kind))
          throw new Error('This source has no supported channel catalog or media. Saved channels were retained.');
        const captured = Object.freeze(validateSource({ ...source, contentKind: result.kind, mediaMime: result.mime }));
        let text: string | undefined = result.kind === 'catalog' ? result.text :
          `#EXTM3U\n#EXTINF:-1 tvg-id="direct" group-title="Custom",${source.name.replace(/[\r\n]/g, ' ')}\n${source.location}\n`;
        result = undefined;
        if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_PLAYLIST_BYTES)
          throw new Error('Source playlist is empty or exceeds the 20 MiB limit. Saved channels were retained.');
        const warnings: string[] = [];
        let geography: PagedParserInput['geography'];
        if (options.geography) {
          try { geography = await options.geography(captured, controller.signal); }
          catch {
            controller.signal.throwIfAborted();
            warnings.push('Regional metadata is unavailable. Existing channel geography is retained; channels without metadata remain Unknown.');
          }
        }
        controller.signal.throwIfAborted();
        // postMessage clones the bounded immutable input; the service never returns its graph.
        const pending = openPagedParser({ text, source: captured, geography, warnings }, controller.signal, options.workerFactory);
        text = undefined;
        const parsed = await pending;
        job.parsed = parsed;
        controller.signal.throwIfAborted();
        let disposeWork: Promise<void> | undefined;
        const dispose = () => disposeWork ??= (async () => {
          controller.abort();
          try { await parsed.dispose(); }
          finally { signal.removeEventListener('abort', abort); jobs.delete(job); }
        })();
        job.release = dispose;
        return Object.freeze({ ...parsed, source: captured, dispose });
      } catch (error) {
        controller.abort();
        try { await job.parsed?.dispose(); }
        finally { signal.removeEventListener('abort', abort); jobs.delete(job); }
        throw error;
      }
    });
    const job: Job = { controller, done: work };
    jobs.add(job);
    return work;
  }
  const cancel = async () => {
    const current = [...jobs];
    for (const job of current) job.controller.abort();
    const outcomes = await Promise.allSettled(current.map(async (job) => {
      await job.done.catch(() => undefined);
      if (job.release) await job.release();
      else await job.parsed?.dispose();
      jobs.delete(job);
    }));
    const failed = outcomes.find((value): value is PromiseRejectedResult => value.status === 'rejected');
    if (failed) throw failed.reason;
  };
  return { collect, cancel, dispose: async () => { closed = true; await cancel(); } };
}
