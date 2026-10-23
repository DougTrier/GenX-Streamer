import type { CatalogPage, CatalogQuery, CatalogRow } from '../platform/catalog-query';

export type BrowseQuery = Pick<
  CatalogQuery,
  'query' | 'filter' | 'geography' | 'sort' | 'hideAdult'
>;
export type CatalogWindowState = 'uninitialized' | 'pending' | 'ready' | 'error' | 'closed';
export interface CatalogWindowHost {
  revision(): string;
  query(input: Omit<CatalogQuery, 'requestId'>, signal: AbortSignal): Promise<CatalogPage>;
  changed(): void;
}
const PAGE_SIZE = 50;
/** One joined query owner, three metadata pages, and no whole-catalog JS search. */
export class CatalogWindow {
  private generation = 0;
  private controller = new AbortController();
  private work: Promise<void> = Promise.resolve();
  private pages = new Map<number, CatalogRow[]>();
  private requests = new Set<number>();
  private input: BrowseQuery = { query: '', filter: 'all', geography: {}, sort: 'source' };
  private revision = '';
  private viewRevision: string | undefined;
  private key = '';
  private identity = '';
  /** Quiet re-reads after the catalog moved on, since the last page accepted. */
  private staleRereads = 0;
  private closed = false;
  private count = 0;
  private counted = false;
  private failure = false;
  /** Why the last read failed, when the source says (e.g. an account not yet imported). */
  private failureCode: string | null = null;
  constructor(private host: CatalogWindowHost) {}
  get total(): number {
    return this.count;
  }
  /** Zero is authoritative only after the current generation accepted a page. */
  get countKnown(): boolean {
    return !this.closed && !this.failure && this.counted;
  }
  get state(): CatalogWindowState {
    if (this.closed) return 'closed';
    if (this.failure) return 'error';
    if (this.counted) return 'ready';
    return this.requests.size ? 'pending' : 'uninitialized';
  }
  get pending(): boolean {
    return !this.closed && !this.failure && this.requests.size > 0;
  }
  get loading(): boolean {
    return this.pending && !this.counted;
  }
  get failedBecause(): string | null {
    return this.failure ? this.failureCode : null;
  }
  get failed(): boolean {
    return this.failure;
  }
  get loadedRows(): number {
    return [...this.pages.values()].reduce((n, rows) => n + rows.length, 0);
  }
  row(index: number): CatalogRow | undefined {
    for (const [start, rows] of this.pages) {
      if (index >= start && index < start + rows.length) {
        this.pages.delete(start);
        this.pages.set(start, rows);
        return rows[index - start];
      }
    }
    return undefined;
  }
  indexOf(id: string | null): number {
    if (!id) return -1;
    for (const [start, rows] of this.pages) {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) return start + index;
    }
    return -1;
  }
  reset(input: BrowseQuery, identity: string): void {
    if (this.closed) return;
    this.identity = identity;
    const revision = this.host.revision();
    const key = JSON.stringify([input, identity, revision]);
    if (key === this.key) return;
    this.key = key;
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    this.input = structuredClone(input);
    this.revision = revision;
    this.viewRevision = undefined;
    this.pages.clear();
    this.requests.clear();
    this.count = 0;
    this.counted = false;
    this.failure = false;
    this.ensure(0);
  }
  ensure(index: number): void {
    if (this.closed || this.failure || index < 0 || (this.counted && index >= this.count)) return;
    if (this.row(index) || this.requests.size >= 3) return;
    let start = Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
    if (this.pages.has(start)) start = index;
    if (this.requests.has(start)) return;
    this.requests.add(start);
    const generation = this.generation;
    const signal = this.controller.signal;
    const input = structuredClone(this.input);
    const revision = this.revision;
    this.work = this.work.then(async () => {
      if (signal.aborted || generation !== this.generation) return;
      try {
        const page = await this.host.query(
          {
            schemaVersion: 1,
            ...input,
            expectedCatalogRevision: revision,
            ...(this.viewRevision ? { expectedViewRevision: this.viewRevision } : {}),
            startIndex: start,
            pageSize: PAGE_SIZE,
          },
          signal,
        );
        if (signal.aborted || generation !== this.generation || this.closed) return;
        if (page.startIndex !== start) throw new Error('Catalog window mismatch.');
        this.accept(page, start);
        this.staleRereads = 0;
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (
          !signal.aborted &&
          generation === this.generation &&
          !this.closed &&
          (code === 'catalog-stale' || code === 'view-stale') &&
          this.staleRereads < 2
        ) {
          // The catalog moved on (a scan saved more channels): read this view
          // again at its new revision instead of showing an error.
          this.staleRereads++;
          queueMicrotask(() => {
            if (this.closed || generation !== this.generation) return;
            this.key = '';
            this.reset(this.input, this.identity);
          });
          return;
        }
        if (!signal.aborted && generation === this.generation && !this.closed) {
          this.failure = true;
          const code = (error as { code?: unknown } | null)?.code;
          this.failureCode = typeof code === 'string' ? code : null;
          this.pages.clear();
          this.count = 0;
        }
      } finally {
        if (generation === this.generation && !this.closed) {
          this.requests.delete(start);
          this.notify();
        }
      }
    });
  }
  private notify(): void {
    try {
      this.host.changed();
    } catch {
      // Rendering failure is explicit, but must not poison later joined queries.
      this.failure = true;
    }
  }
  private accept(page: CatalogPage, start?: number): void {
    if (
      page.catalogRevision !== this.revision ||
      (this.viewRevision !== undefined && page.viewRevision !== this.viewRevision)
    )
      throw new Error('Catalog window revision mismatch.');
    this.viewRevision = page.viewRevision;
    this.count = page.totalCount;
    this.counted = true;
    if (start !== undefined) {
      this.pages.delete(start);
      this.pages.set(start, page.rows);
      while (this.pages.size > 3) this.pages.delete(this.pages.keys().next().value!);
    }
  }
  /** Locate off-screen selections in SQL, preserving filtered wrap-around. */
  adjacent(
    selection: () => string | null,
    direction: -1 | 1,
    select: (row: CatalogRow, index: number) => void,
  ): void {
    const generation = this.generation;
    const signal = this.controller.signal;
    const input = structuredClone(this.input);
    const revision = this.revision;
    this.work = this.work.then(async () => {
      if (signal.aborted || generation !== this.generation || this.closed) return;
      try {
        const id = selection();
        const scope = {
          schemaVersion: 1 as const,
          ...input,
          expectedCatalogRevision: revision,
          ...(this.viewRevision ? { expectedViewRevision: this.viewRevision } : {}),
          pageSize: PAGE_SIZE,
        };
        let page = await this.host.query(
          { ...scope, ...(id ? { anchorId: id } : { startIndex: 0 }) },
          signal,
        );
        if (signal.aborted || generation !== this.generation || this.closed) return;
        this.accept(page);
        if (!page.totalCount) return;
        const anchor = page.anchorIndex;
        const next =
          anchor === null
            ? direction === 1
              ? 0
              : page.totalCount - 1
            : (anchor + direction + page.totalCount) % page.totalCount;
        if (next < page.startIndex || next >= page.startIndex + page.rows.length) {
          page = await this.host.query(
            {
              ...scope,
              expectedViewRevision: page.viewRevision,
              startIndex: Math.floor(next / PAGE_SIZE) * PAGE_SIZE,
            },
            signal,
          );
          if (signal.aborted || generation !== this.generation || this.closed) return;
          this.accept(page, page.startIndex);
        }
        const row = page.rows[next - page.startIndex];
        if (!row) throw new Error('Catalog adjacency mismatch.');
        if (row.id !== id) select(row, next);
      } catch {
        if (!signal.aborted && generation === this.generation && !this.closed) this.failure = true;
      } finally {
        if (generation === this.generation && !this.closed) this.notify();
      }
    });
  }
  async settled(): Promise<void> {
    await this.work;
  }
  async dispose(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.generation++;
      this.controller.abort();
      this.pages.clear();
      this.requests.clear();
    }
    await this.work;
  }
}
