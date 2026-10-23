import {
  SOURCE_INDEX_MAX_BYTES,
  parseSourceRepositories,
  parseSourceTree,
  sourceSearchUrl,
  sourceTreeUrl,
  validateSourceRepository,
  type SourceRepository,
  parseSourceRepository,
  sourceRepositoryIdUrl,
  sourceDocumentUrl,
  parsePublishedSourceLinks,
} from './source-index';

export interface SourceIndexTransport {
  /** Enforce HTTPS api.github.com, redirect confinement and streamed/decoded byte limits.
   * Abort must settle actual native work before this promise settles. Never return raw errors to UI. */
  json(url: string, signal: AbortSignal, maxBytes: number): Promise<unknown>;
}
export function createSourceIndexService(transport: SourceIndexTransport) {
  let disposed = false;
  const jobs = new Map<AbortController, Promise<unknown>>();
  const admitted = new Map<number, SourceRepository>();
  function admittedRepository(repository: SourceRepository): SourceRepository {
    const repo = validateSourceRepository(repository),
      captured = admitted.get(repo.id);
    if (!captured || JSON.stringify(repo) !== JSON.stringify(captured))
      throw new Error('Choose a repository from the current source discovery.');
    return repo;
  }
  function perform<T>(signal: AbortSignal, url: string, parse: (value: unknown) => T): Promise<T> {
    if (disposed) return Promise.reject(new Error('Source discovery is closed.'));
    if (signal.aborted) return Promise.reject(new DOMException('Canceled', 'AbortError'));
    if (jobs.size) return Promise.reject(new Error('Source discovery is already running.'));
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const work = Promise.resolve()
      .then(async () => {
        if (controller.signal.aborted) throw new DOMException('Canceled', 'AbortError');
        const value = await transport.json(url, controller.signal, SOURCE_INDEX_MAX_BYTES);
        if (controller.signal.aborted || disposed) throw new DOMException('Canceled', 'AbortError');
        // Transport applies the wire bound; this independently bounds malformed injected JSON.
        if (new TextEncoder().encode(JSON.stringify(value)).byteLength > SOURCE_INDEX_MAX_BYTES)
          throw new Error('Source index response exceeded its limit.');
        return parse(value);
      })
      .finally(() => {
        signal.removeEventListener('abort', cancel);
        jobs.delete(controller);
      });
    jobs.set(controller, work);
    return work;
  }
  return {
    repository(id: number, signal: AbortSignal) {
      return perform(signal, sourceRepositoryIdUrl(id), (value) => {
        const repo = parseSourceRepository(value, id);
        // Bounded knowledge lookups cannot grow admission indefinitely.
        if (!admitted.has(id) && admitted.size >= 100)
          throw new Error('Too many repositories are open in this discovery.');
        admitted.set(id, repo);
        return repo;
      });
    },
    search(query: string, signal: AbortSignal) {
      return perform(signal, sourceSearchUrl(query), (value) => {
        const result = parseSourceRepositories(value);
        admitted.clear();
        for (const repo of result.repositories) admitted.set(repo.id, repo);
        return result;
      });
    },
    openRepository(repository: SourceRepository, signal: AbortSignal) {
      let repo: SourceRepository;
      try {
        repo = admittedRepository(repository);
      } catch (error) {
        return Promise.reject(error);
      }
      return perform(signal, sourceTreeUrl(repo), (value) => parseSourceTree(value, repo));
    },
    publishedLinks(repository: SourceRepository, path: string, signal: AbortSignal) {
      let repo: SourceRepository;
      try {
        repo = admittedRepository(repository);
      } catch (error) {
        return Promise.reject(error);
      }
      return perform(signal, sourceDocumentUrl(repo, path), (value) =>
        parsePublishedSourceLinks(value, repo, path),
      );
    },
    async dispose(): Promise<void> {
      disposed = true;
      admitted.clear();
      for (const controller of jobs.keys()) controller.abort();
      await Promise.allSettled([...jobs.values()]);
    },
  };
}
