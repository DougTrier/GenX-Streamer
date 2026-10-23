import { MAX_DISCOVERY_BYTES, type DiscoveryPage, type DiscoveryResult } from './candidates';

class PageInputError extends Error {}
/** Only messages created by this boundary are safe to display; raw provider/network errors are discarded. */
export function pageInputErrorMessage(error: unknown): string {
  return error instanceof PageInputError
    ? error.message
    : 'The website could not be scanned safely. Check the URL, HTTP permission or page access; an explicit source URL may be needed.';
}

export interface NativePageInput {
  inspect(url: string, allowHttp: boolean, requestId: string): Promise<DiscoveryPage>;
  cancel(requestId: string): Promise<void>;
}
export interface PageInputOptions {
  native?: NativePageInput;
  fetch?: typeof fetch;
  workerFactory?: () => Worker;
}
export function validatePageUrl(value: string, allowHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PageInputError('Enter a complete website URL.');
  }
  if (
    value.length > 16_384 ||
    url.username ||
    url.password ||
    !['https:', 'http:'].includes(url.protocol)
  )
    throw new PageInputError('Choose an HTTP or HTTPS URL without embedded credentials.');
  if (url.protocol === 'http:' && !allowHttp)
    throw new PageInputError('Allow unencrypted HTTP explicitly for this website first.');
  url.hash = '';
  return url.href;
}
function validatePage(
  page: DiscoveryPage,
  requestedUrl: string,
  allowHttp: boolean,
): DiscoveryPage {
  if (
    !page ||
    typeof page.html !== 'string' ||
    new TextEncoder().encode(page.html).byteLength > MAX_DISCOVERY_BYTES
  )
    throw new PageInputError('The website exceeds the 2 MiB page limit.');
  const pageUrl = validatePageUrl(page.pageUrl, allowHttp);
  if (pageUrl !== requestedUrl)
    throw new PageInputError('The website response belongs to another request.');
  const responseUrl = validatePageUrl(page.responseUrl ?? pageUrl, allowHttp);
  return { pageUrl, responseUrl, html: page.html };
}
async function fetchPage(
  fetcher: typeof fetch,
  url: string,
  allowHttp: boolean,
  signal: AbortSignal,
): Promise<DiscoveryPage> {
  let target = url;
  for (let redirect = 0; redirect <= 5; redirect++) {
    const response = await fetcher(target, {
      signal,
      redirect: 'manual',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'text/html, application/xhtml+xml' },
    });
    if (signal.aborted) {
      await response.body?.cancel();
      throw new PageInputError('Website scan canceled.');
    }
    if (response.type === 'opaqueredirect') {
      await response.body?.cancel();
      throw new PageInputError(
        'This browser cannot inspect the redirect safely. Enter the final website URL or use the native app.',
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirect === 5)
        throw new PageInputError('The website redirect limit was reached. Enter its final URL.');
      target = validatePageUrl(new URL(location, target).href, allowHttp);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PageInputError(`The website returned HTTP ${response.status}.`);
    }
    const finalUrl = validatePageUrl(response.url || target, allowHttp);
    const contentLength = response.headers.get('content-length');
    if (
      contentLength &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_DISCOVERY_BYTES)
    ) {
      await response.body?.cancel();
      throw new PageInputError('The website exceeds the 2 MiB page limit.');
    }
    if (!response.body) throw new PageInputError('The website response is empty.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (signal.aborted) throw new PageInputError('Website scan canceled.');
        if (part.done) break;
        length += part.value.byteLength;
        if (length > MAX_DISCOVERY_BYTES)
          throw new PageInputError('The website exceeds the 2 MiB page limit.');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let html: string;
    try {
      html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new PageInputError(
        'This website uses an unsupported text encoding. Choose an explicit source URL.',
      );
    }
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const prefix = html
      .replace(/^\uFEFF/u, '')
      .trimStart()
      .slice(0, 512)
      .toLowerCase();
    if (!(
      prefix.startsWith('<!doctype html') ||
      prefix.startsWith('<html') ||
      (['text/html', 'application/xhtml+xml'].includes(mime) && prefix.startsWith('<'))
    ))
      throw new PageInputError(
        'This response is not an HTML page. Review an explicit playlist source instead.',
      );
    return { pageUrl: url, responseUrl: finalUrl, html };
  }
  throw new PageInputError('The website redirect limit was reached.');
}
/** A single owned input job. Cancel joins native input cleanup and terminates parsing workers. */
export function createPageInput(options: PageInputOptions = {}): {
  inspect(url: string, allowHttp: boolean, signal?: AbortSignal): Promise<DiscoveryResult>;
  cancel(): Promise<void>;
} {
  let active: { controller: AbortController; done: Promise<DiscoveryResult> } | null = null;
  let serial = 0;
  let ownedJobs = 0;
  function parse(page: DiscoveryPage, signal: AbortSignal): Promise<DiscoveryResult> {
    const worker = (
      options.workerFactory ??
      (() => new Worker(new URL('./page-worker.ts', import.meta.url), { type: 'module' }))
    )();
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', cancel);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
      };
      const cancel = () => {
        cleanup();
        reject(new PageInputError('Website scan canceled.'));
      };
      worker.onmessage = (
        event: MessageEvent<{ ok: boolean; result?: DiscoveryResult; error?: string }>,
      ) => {
        if (finished) return;
        cleanup();
        if (signal.aborted) reject(new PageInputError('Website scan canceled.'));
        else if (event.data.ok && event.data.result) resolve(event.data.result);
        else
          reject(
            new PageInputError(event.data.error ?? 'The page references could not be read safely.'),
          );
      };
      worker.onerror = () => {
        cleanup();
        reject(new PageInputError('The page references could not be read safely.'));
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      else {
        try {
          worker.postMessage({ page });
        } catch {
          cleanup();
          reject(new PageInputError('The page references could not be read safely.'));
        }
      }
    });
  }
  return {
    async inspect(raw, allowHttp, signal) {
      const url = validatePageUrl(raw, allowHttp);
      if (ownedJobs >= 2)
        throw new PageInputError('A website scan is already restarting. Wait for its cleanup.');
      ownedJobs++;
      const previous = active;
      previous?.controller.abort();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const requestId = `website-${crypto.randomUUID()}-${++serial}`;
      let resolveDone!: (v: DiscoveryResult) => void;
      let rejectDone!: (reason: unknown) => void;
      const done = new Promise<DiscoveryResult>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      const job = { controller, done };
      active = job;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, 20_000);
      let cancelWork = Promise.resolve();
      let nativeStarted = false;
      const cancelNative = () => {
        if (nativeStarted && options.native)
          cancelWork = Promise.resolve()
            .then(() => options.native?.cancel(requestId))
            .then(() => undefined)
            .catch(() => undefined);
      };
      controller.signal.addEventListener('abort', cancelNative, { once: true });
      void (async () => {
        let outcome: DiscoveryResult | undefined;
        let failure: Error | undefined;
        try {
          if (previous) await previous.done.catch(() => undefined);
          if (controller.signal.aborted) throw new PageInputError('Website scan canceled.');
          let page: DiscoveryPage;
          if (options.native) {
            nativeStarted = true;
            try {
              page = await options.native.inspect(url, allowHttp, requestId);
            } catch {
              throw new PageInputError(
                'The website could not be inspected. Check its URL, access restrictions and connection.',
              );
            }
          } else {
            try {
              page = await fetchPage(options.fetch ?? fetch, url, allowHttp, controller.signal);
            } catch (error) {
              // Only errors created by our finite input boundary are shown; fetch diagnostics may contain signed URLs.
              if (error instanceof PageInputError) throw error;
              throw new PageInputError(
                'The website could not be read. Check browser cross-origin access or use the native app.',
              );
            }
          }
          if (controller.signal.aborted) throw new PageInputError('Website scan canceled.');
          const result = await parse(validatePage(page, url, allowHttp), controller.signal);
          if (controller.signal.aborted || active !== job)
            throw new PageInputError('Website scan canceled.');
          outcome = result;
        } catch (error) {
          failure = new PageInputError(
            timedOut
              ? 'The website scan reached its 20 second deadline.'
              : controller.signal.aborted
                ? 'Website scan canceled.'
                : error instanceof PageInputError
                  ? error.message
                  : 'The website could not be inspected.',
          );
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          controller.signal.removeEventListener('abort', cancelNative);
          await cancelWork;
          ownedJobs--;
          if (active === job) active = null;
        }
        if (failure) rejectDone(failure);
        else if (outcome) resolveDone(outcome);
        else rejectDone(new PageInputError('The website could not be inspected.'));
      })();
      return done;
    },
    async cancel() {
      const job = active;
      if (job) {
        job.controller.abort();
        await job.done.catch(() => undefined);
      }
    },
  };
}
