import { validateCatalog } from './codec';
import { boundedJsonUtf8Bytes } from '../data-transfer/json-byte-admission';
import type { CollectedSourceEntries, SourceSnapshotEntry } from '../discovery/incremental-refresh';
import {
  PAGED_SOURCE_PAGE_BYTES, type PagedParserInput, type PagedParserRequest,
  type PagedParserResponse, type PagedParserSummary,
} from './paged-parser-protocol';

export interface PagedParsedSource extends CollectedSourceEntries, PagedParserSummary {}
const refused = () => new Error('The source parser response could not be admitted.');
const aborted = () => new DOMException('Source collection canceled.', 'AbortError');
const publicError = (code: unknown) => new Error(
  code === 'size' ? 'Source input or parsed metadata exceeds the 20 MiB capture limit. Saved channels were retained.' :
  code === 'entries' ? 'Source exceeds the 100,000 channel limit. Saved channels were retained.' :
  code === 'header' ? 'This source is not an extended M3U playlist. Saved channels were retained.' :
  code === 'empty' ? 'This source has no supported channels. Saved channels were retained.' :
  'The source contains invalid or unsupported playlist metadata. Saved channels were retained.',
);

/** Pull-only worker bridge. At most one page crosses the UI boundary per native append. */
export async function openPagedParser(
  input: PagedParserInput,
  signal: AbortSignal,
  workerFactory: () => Worker = () => new Worker(new URL('./paged-parser-worker.ts', import.meta.url), { type: 'module' }),
): Promise<PagedParsedSource> {
  signal.throwIfAborted();
  const source = input.source;
  let worker: Worker;
  try { worker = workerFactory(); }
  catch { throw new Error('The source parser could not start. Saved channels were retained.'); }
  let serial = 0;
  let disposed = false;
  let failure: Error | undefined;
  let pending: { id: number; resolve: (value: PagedParserResponse) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  let disposeWork: Promise<void> | undefined;
  const terminate = (reason?: Error) => {
    if (disposed) return;
    disposed = true;
    failure = reason;
    const wait = pending;
    pending = undefined;
    if (wait) { clearTimeout(wait.timer); wait.reject(reason ?? refused()); }
    signal.removeEventListener('abort', abort);
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  };
  const abort = () => terminate(aborted());
  worker.onerror = () => terminate(new Error('The source parser stopped unexpectedly. Saved channels were retained.'));
  worker.onmessageerror = () => terminate(refused());
  worker.onmessage = (event: MessageEvent<PagedParserResponse>) => {
    const wait = pending;
    try {
      boundedJsonUtf8Bytes(event.data, 1024 * 1024);
      if (!wait || !event.data || event.data.schemaVersion !== 1 || event.data.requestId !== wait.id)
        throw refused();
      pending = undefined;
      clearTimeout(wait.timer);
      if (event.data.kind === 'error') {
        // Display only fixed messages, even when a malformed worker returns private diagnostics.
        const error = publicError(event.data.code);
        wait.reject(error);
        terminate(error);
      } else wait.resolve(event.data);
    } catch {
      // Retain the waiter until termination can reject it, including malformed error envelopes.
      if (wait && !pending) pending = wait;
      terminate(refused());
    }
  };
  signal.addEventListener('abort', abort, { once: true });
  const request = (value: Omit<Extract<PagedParserRequest, { kind: 'open' }>, 'schemaVersion' | 'requestId'> |
    Omit<Extract<PagedParserRequest, { kind: 'next' }>, 'schemaVersion' | 'requestId'> |
    { kind: 'close' }): Promise<PagedParserResponse> => {
    if (disposed) return Promise.reject(failure ?? refused());
    if (pending) return Promise.reject(refused());
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => terminate(new Error('Source parsing reached its deadline. Saved channels were retained.')), 20_000);
      pending = { id, resolve, reject, timer };
      try { worker.postMessage({ ...value, schemaVersion: 1, requestId: id }); }
      catch { terminate(refused()); }
    });
  };
  const dispose = (): Promise<void> => {
    if (disposeWork) return disposeWork;
    disposeWork = (async () => {
      if (!disposed) {
        // A pending parse/page has no asynchronous worker resource beyond this Worker owner.
        if (pending) terminate(aborted());
        else {
          try {
            const receipt = await request({ kind: 'close' });
            if (receipt.kind !== 'closed') throw refused();
          } finally { terminate(); }
        }
      }
    })();
    return disposeWork;
  };
  try {
    if (signal.aborted) abort();
    const opening = request({ kind: 'open', input });
    // postMessage has completed the clone. Do not retain body/documents in this closure.
    input = { text: '', source };
    const ready = await opening;
    if (ready.kind !== 'ready') throw refused();
    const summary = ready.summary;
    if (!summary || !Number.isSafeInteger(summary.entryCount) || summary.entryCount < 1 || summary.entryCount > 100_000 ||
      !Number.isSafeInteger(summary.warningCount) || summary.warningCount < 0 ||
      !Array.isArray(summary.warnings) || summary.warnings.length > 32 || summary.warnings.length > summary.warningCount ||
      summary.warnings.some((warning) => typeof warning !== 'string')) throw refused();
    boundedJsonUtf8Bytes(summary.warnings, 16384);
    let started = false;
    const pages = {
      async *[Symbol.asyncIterator](): AsyncGenerator<readonly SourceSnapshotEntry[]> {
        if (started) throw new Error('Source pages can be consumed only once.');
        started = true;
        let cursor = 0;
        try {
          while (cursor < summary.entryCount) {
            signal.throwIfAborted();
            const page = await request({ kind: 'next', expectedIndex: cursor });
            if (page.kind !== 'page' || page.startIndex !== cursor || !Array.isArray(page.entries) ||
              !page.entries.length || page.entries.length > 64 || cursor + page.entries.length > summary.entryCount ||
              page.exhausted !== (cursor + page.entries.length === summary.entryCount)) throw refused();
            boundedJsonUtf8Bytes(page.entries, PAGED_SOURCE_PAGE_BYTES);
            const entries = page.entries.map((entry, offset) => {
              if (!entry || entry.entryId !== `source-raw-${cursor + offset}`) throw refused();
              const valid = validateCatalog({ schemaVersion: 1, sources: [{ ...source, allowHttp: true }],
                channels: [{ ...entry.channel, id: 'staging-admission' }] }).channels[0]!;
              const { id, ...channel } = valid;
              void id;
              return Object.freeze({ entryId: entry.entryId, channel });
            });
            cursor += entries.length;
            yield Object.freeze(entries);
          }
        } finally { await dispose(); }
      },
    };
    return Object.freeze({ entryCount: summary.entryCount, warningCount: summary.warningCount,
      warnings: Object.freeze([...summary.warnings]), pages, dispose });
  } catch (error) {
    terminate(error instanceof Error ? error : refused());
    throw error;
  }
}
