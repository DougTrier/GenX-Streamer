export const SOURCE_INDEX_MAX_BYTES = 2 * 1024 * 1024;
export interface SourceRepository {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly branch: string;
  readonly provenance: string;
}
export interface SourceOption {
  readonly label: string;
  readonly provenance: string;
  readonly location: string;
  readonly format: 'm3u' | 'm3u8' | 'xmltv';
  readonly reason: string;
  readonly rights: 'unknown';
  readonly treeSha: string;
  readonly blobSha: string;
}
export interface PublishedSourceOption {
  readonly label: string;
  readonly provenance: string;
  readonly location: string;
  readonly format: 'm3u' | 'm3u8' | 'xmltv';
  readonly reason: string;
  readonly rights: 'unknown';
  readonly documentSha: string;
}
class SourceIndexError extends Error {}
export function sourceIndexErrorMessage(error: unknown): string {
  return error instanceof SourceIndexError
    ? error.message
    : 'Source discovery could not finish. Try again when the service is available.';
}
function refuse(message = 'The source index returned an invalid response.'): never {
  throw new SourceIndexError(message);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > max ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    refuse();
  return value;
}
const component = (value: unknown): string => {
  const result = text(value, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(result) || result === '.' || result === '..') refuse();
  return result;
};
function branch(value: unknown): string {
  const result = text(value, 256);
  if (
    result.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\\?#%]/u.test(result)
  )
    refuse();
  return result;
}
function sha(value: unknown): string {
  const result = text(value, 40);
  if (!/^[a-f0-9]{40}$/u.test(result)) refuse();
  return result;
}
export function validateSourceRepository(value: unknown): SourceRepository {
  const input = record(value);
  const owner = component(input.owner),
    name = component(input.name);
  if (!Number.isSafeInteger(input.id) || (input.id as number) <= 0) refuse();
  const provenance = `https://github.com/${owner}/${name}`;
  if (input.provenance !== provenance) refuse();
  return Object.freeze({
    id: input.id as number,
    owner,
    name,
    branch: branch(input.branch),
    provenance,
  });
}
export function sourceRepositoryIdUrl(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) refuse();
  return `https://api.github.com/repositories/${id}`;
}
export function parseSourceRepository(value: unknown, expectedId: number): SourceRepository {
  sourceRepositoryIdUrl(expectedId);
  const row = record(value),
    owner = record(row.owner);
  const repo = validateSourceRepository({
    id: row.id,
    owner: owner.login,
    name: row.name,
    branch: row.default_branch,
    provenance: row.html_url,
  });
  if (
    repo.id !== expectedId ||
    row.private !== false ||
    row.full_name !== `${repo.owner}/${repo.name}`
  )
    refuse();
  return repo;
}
function documentPath(value: string): string {
  if (!/^(?:README(?:\.md)?|PLAYLISTS\.md|epglist\.txt)$/iu.test(value)) refuse();
  return value;
}
export function sourceDocumentUrl(repository: SourceRepository, path: string): string {
  const repo = validateSourceRepository(repository);
  return `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(documentPath(path))}?ref=${encodeURIComponent(repo.branch)}`;
}
/** Plain Markdown URLs only. No DOM/script evaluation and no destination acquisition. */
export function parsePublishedSourceLinks(
  value: unknown,
  repository: SourceRepository,
  path: string,
): readonly PublishedSourceOption[] {
  const repo = validateSourceRepository(repository),
    requested = documentPath(path),
    row = record(value);
  if (
    row.type !== 'file' ||
    row.path !== requested ||
    row.name !== requested ||
    row.encoding !== 'base64' ||
    row.url !== sourceDocumentUrl(repo, requested)
  )
    refuse();
  const documentSha = sha(row.sha);
  if (
    !Number.isSafeInteger(row.size) ||
    (row.size as number) < 0 ||
    (row.size as number) > SOURCE_INDEX_MAX_BYTES ||
    typeof row.content !== 'string'
  )
    refuse();
  const encoded = row.content.replace(/[\r\n]/gu, '');
  if (
    encoded.length > Math.ceil(SOURCE_INDEX_MAX_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  )
    refuse();
  let decoded: string;
  try {
    const binary = atob(encoded);
    if (btoa(binary) !== encoded || binary.length !== row.size) refuse();
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
  } catch {
    refuse();
  }
  const provenance = `${repo.provenance}/blob/${encodeURIComponent(repo.branch)}/${encodeURIComponent(requested)}`;
  const guideIndex = /^epglist\.txt$/iu.test(requested);
  // Published guide indexes are data, not Markdown: every nonblank line must
  // be one admissible guide URL. Refuse the whole document rather than hide
  // malformed/credential-bearing entries among valid links.
  if (
    guideIndex &&
    decoded.split(/\r?\n/u).some((line) => {
      const value = line.trim();
      return value !== '' && !/^https:\/\/[^\s<>"'`[\]()]+$/iu.test(value);
    })
  )
    refuse();
  const seen = new Set<string>(),
    options: PublishedSourceOption[] = [];
  // Finite URL token matching handles Markdown autolinks/code/plain text; HTML anchors
  // also expose their URL token without evaluating markup or loading any resources.
  for (const match of decoded.matchAll(/https?:\/\/[^\s<>"'`[\]()]+/giu)) {
    const raw = match[0].replace(/[.,;]+$/u, '');
    if (guideIndex && raw !== match[0]) refuse();
    if (raw.length > 16384) refuse();
    let url: URL;
    try {
      url = new URL(raw.replace(/&amp;/giu, '&'));
    } catch {
      if (guideIndex) refuse();
      continue;
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.port ||
      url.hostname === 'localhost' ||
      url.hostname.endsWith('.localhost') ||
      /^[\d.]+$/u.test(url.hostname) ||
      url.hostname.includes(':')
    ) {
      if (guideIndex) refuse();
      continue;
    }
    // Repository HTML blob links are not playlist payloads; admit only explicit
    // published destinations. GitHub raw links remain links, never API redirects.
    if (url.hostname === 'github.com' && !url.pathname.includes('/raw/')) {
      if (guideIndex) refuse();
      continue;
    }
    const suffix = /\.(m3u8?|xml(?:tv)?(?:\.gz)?)$/iu.exec(url.pathname)?.[1]?.toLowerCase();
    if (guideIndex && (!suffix || suffix === 'm3u' || suffix === 'm3u8')) refuse();
    if (!suffix || seen.has(url.href)) continue;
    if (options.length >= 1000) refuse('This document has too many source links to list safely.');
    seen.add(url.href);
    const format = suffix === 'm3u' || suffix === 'm3u8' ? suffix : 'xmltv';
    options.push(
      Object.freeze({
        label: url.pathname.split('/').at(-1) ?? requested,
        provenance,
        location: url.href,
        format,
        reason:
          'Published document link; contents, rights, coverage and playback have not been checked.',
        rights: 'unknown',
        documentSha,
      }),
    );
  }
  return Object.freeze(options);
}
export function sourceSearchUrl(query: string): string {
  const normalized = query.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > 128 || !/^[\p{L}\p{N} _.-]+$/u.test(normalized))
    refuse('Enter simple words describing the sources you want to find.');
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(`${normalized} in:name,description,readme`)}&per_page=10&page=1`;
}
export function sourceTreeUrl(repository: SourceRepository): string {
  const repo = validateSourceRepository(repository);
  return `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${encodeURIComponent(repo.branch)}?recursive=1`;
}
export function parseSourceRepositories(value: unknown): {
  repositories: readonly SourceRepository[];
  incomplete: boolean;
  moreAvailable: boolean;
} {
  const input = record(value);
  if (
    !Array.isArray(input.items) ||
    input.items.length > 10 ||
    typeof input.incomplete_results !== 'boolean' ||
    !Number.isSafeInteger(input.total_count) ||
    (input.total_count as number) < input.items.length
  )
    refuse();
  const seen = new Set<number>();
  const repositories = input.items.map((item) => {
    const row = record(item),
      owner = record(row.owner);
    const repo = validateSourceRepository({
      id: row.id,
      owner: owner.login,
      name: row.name,
      branch: row.default_branch,
      provenance: row.html_url,
    });
    if (
      row.full_name !== `${repo.owner}/${repo.name}` ||
      row.private !== false ||
      seen.has(repo.id)
    )
      refuse();
    seen.add(repo.id);
    return repo;
  });
  return Object.freeze({
    repositories: Object.freeze(repositories),
    incomplete: input.incomplete_results,
    moreAvailable: (input.total_count as number) > repositories.length,
  });
}
export function parseSourceTree(
  value: unknown,
  repository: SourceRepository,
): readonly SourceOption[] {
  const repo = validateSourceRepository(repository),
    input = record(value),
    treeSha = sha(input.sha);
  if (input.truncated === true)
    refuse('This repository is too large to list completely. Choose a smaller repository.');
  if (
    input.truncated !== false ||
    !Array.isArray(input.tree) ||
    input.tree.length > 20000 ||
    input.url !== `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${treeSha}`
  )
    refuse();
  const seen = new Set<string>(),
    options: SourceOption[] = [];
  for (const item of input.tree) {
    const row = record(item),
      path = text(row.path, 1024),
      blobSha = sha(row.sha);
    if (
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      /[\\]/u.test(path) ||
      seen.has(path)
    )
      refuse();
    seen.add(path);
    if (!['blob', 'tree', 'commit'].includes(row.type as string)) refuse();
    // Symlinks and submodules are never downloadable source candidates.
    if (row.type !== 'blob' || row.mode !== '100644') continue;
    if (!Number.isSafeInteger(row.size) || (row.size as number) < 0) refuse();
    const suffix = /\.(m3u8?|xml(?:tv)?(?:\.gz)?)$/iu.exec(path)?.[1]?.toLowerCase();
    if (!suffix) continue;
    const format = suffix === 'm3u' || suffix === 'm3u8' ? suffix : 'xmltv';
    options.push(
      Object.freeze({
        label: path,
        provenance: `${repo.provenance}/blob/${encodeURIComponent(repo.branch)}/${path.split('/').map(encodeURIComponent).join('/')}`,
        location: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${encodeURIComponent(repo.branch)}/${path.split('/').map(encodeURIComponent).join('/')}`,
        format,
        reason:
          format === 'xmltv'
            ? 'Possible program guide; contents and coverage have not been checked.'
            : 'Possible channel playlist or HLS manifest; contents and playback have not been checked.',
        rights: 'unknown',
        treeSha,
        blobSha,
      }),
    );
  }
  return Object.freeze(options);
}
