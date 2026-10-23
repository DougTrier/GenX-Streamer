import { boundedUtf8Text } from './bounded-text';

export type PublicArchiveProvider = 'loc' | 'nasa' | 'commons';
export interface ArchiveProviderDateClaims {
  schemaVersion: 1;
  providerCreated: {
    field: 'date_created';
    value: string;
    provenance: 'provider-search-record';
  };
}
export interface ArchiveProviderFacts {
  providerId: PublicArchiveProvider;
  sourceUrl: string;
  dateClaims?: ArchiveProviderDateClaims;
  mimeType: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  representationRole: string | null;
  contentRole: string | null;
  rights: string | null;
  licenseUrl: string | null;
  attribution: string | null;
  downloadAllowed: boolean | null;
  accessRestricted: boolean | null;
  playbackCandidate: boolean;
  downloadSupported: false;
  unsupportedReason: string | null;
}
export interface PublicArchiveDiscoverRequest {
  schemaVersion: 1;
  expectedRevision: string;
  query: string;
  decade: number | null;
  languageMode: 'all' | 'english-first' | 'english' | 'unlisted';
  contentType: 'all' | 'tv' | 'movie' | 'short' | 'unknown';
  curatedOnly: boolean;
  favoritesOnly: boolean;
  restart: boolean;
  explicitAction: true;
}
export interface PublicArchiveProviderOutcome {
  providerId: PublicArchiveProvider;
  state: 'complete' | 'partial' | 'waiting' | 'failed' | 'configuration-required';
  examined: number;
  admitted: number;
  retryAfterMs: number | null;
  reason: string | null;
}
export interface PublicArchiveDiscoverReceipt {
  schemaVersion: 1;
  committed: true;
  revision: string;
  examined: number;
  admitted: number;
  providers: PublicArchiveProviderOutcome[];
  more: boolean;
}
const invalid = () => new Error('The public archive metadata is invalid.');
export const publicArchiveProviderName = (provider: PublicArchiveProvider): string =>
  ({ loc: 'Library of Congress', nasa: 'NASA', commons: 'Wikimedia Commons' })[provider];
export function publicArchiveProvider(value: unknown): value is PublicArchiveProvider {
  return value === 'loc' || value === 'nasa' || value === 'commons';
}
export function providerPlainText(value: unknown, max: number): value is string {
  return boundedUtf8Text(value, max) && !/[\p{Cc}\p{Cf}]/u.test(value);
}
/** NASA IDs are literal provider data; path separators and escape syntax are not IDs. */
export function publicArchiveNasaItemId(value: unknown): value is string {
  return (
    providerPlainText(value, 512) &&
    value.trim() === value &&
    value !== '.' &&
    value !== '..' &&
    !/[\\/?#%]/u.test(value)
  );
}
function httpsUrl(value: unknown): URL | null {
  if (!providerPlainText(value, 4096)) return null;
  try {
    const u = new URL(value);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.hash ||
      (u.port && u.port !== '443') ||
      !u.hostname.includes('.') ||
      /[[\]:]/u.test(u.hostname) ||
      /^[0-9.]+$/u.test(u.hostname) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(u.hostname) ||
      /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(u.pathname)
    )
      return null;
    return u;
  } catch {
    return null;
  }
}
/** Display provenance only. Media authority never crosses this boundary. */
export function publicArchiveSource(
  value: unknown,
  provider: PublicArchiveProvider,
): value is string {
  const u = httpsUrl(value);
  if (!u) return false;
  if (provider === 'loc')
    return (
      u.hostname === 'www.loc.gov' &&
      !u.search &&
      /^\/item\/[A-Za-z0-9._-]{1,256}\/$/u.test(u.pathname)
    );
  if (provider === 'nasa') {
    if (u.hostname !== 'images-assets.nasa.gov' || u.search) return false;
    const match = /^\/video\/([^/]+)\/collection\.json$/u.exec(u.pathname);
    if (!match) return false;
    try {
      const id = decodeURIComponent(match[1]!);
      if (!publicArchiveNasaItemId(id)) return false;
      const canonical = new URL('https://images-assets.nasa.gov/');
      canonical.pathname = `/video/${id}/collection.json`;
      return canonical.pathname === u.pathname;
    } catch {
      return false;
    }
  }
  if (u.hostname !== 'commons.wikimedia.org') return false;
  return (
    (!u.search && /^\/wiki\/File:[^/]+$/u.test(u.pathname)) ||
    (['/', '/w/index.php'].includes(u.pathname) && /^\?curid=[1-9][0-9]{0,19}$/u.test(u.search))
  );
}
function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some((k) => !keys.includes(k) && !optional.includes(k)) ||
    keys.some((k) => !Object.hasOwn(row, k))
  )
    throw invalid();
  return row;
}
const integer = (v: unknown, max: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const revision = (v: unknown): v is string =>
  typeof v === 'string' && /^(?:0|[1-9][0-9]{0,18})$/u.test(v) && BigInt(v) <= 9223372036854775807n;
function providerCreatedDate(value: unknown): value is string {
  if (!providerPlainText(value, 64)) return false;
  const parts =
    /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):[0-5][0-9](?:\.[0-9]{1,9})?(?:Z|[+-]([0-9]{2}):([0-9]{2}))$/u.exec(
      value,
    );
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(parts[1]),
    month = Number(parts[2]),
    day = Number(parts[3]),
    hour = Number(parts[4]),
    minute = Number(parts[5]),
    offsetHour = Number(parts[6] ?? 0),
    offsetMinute = Number(parts[7] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]! &&
    hour <= 23 &&
    minute <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}
function validateDateClaims(value: unknown): ArchiveProviderDateClaims {
  const r = object(value, ['schemaVersion', 'providerCreated']);
  if (r.schemaVersion !== 1)
    throw new Error('The public archive metadata version is not supported.');
  const claim = object(r.providerCreated, ['field', 'value', 'provenance']);
  if (
    claim.field !== 'date_created' ||
    claim.provenance !== 'provider-search-record' ||
    !providerCreatedDate(claim.value)
  )
    throw invalid();
  return {
    schemaVersion: 1,
    providerCreated: {
      field: 'date_created',
      value: claim.value,
      provenance: 'provider-search-record',
    },
  };
}
export function validateArchiveProviderFacts(value: unknown): ArchiveProviderFacts {
  const r = object(
    value,
    [
      'providerId',
      'sourceUrl',
      'mimeType',
      'videoCodec',
      'audioCodec',
      'width',
      'height',
      'representationRole',
      'contentRole',
      'rights',
      'licenseUrl',
      'attribution',
      'downloadAllowed',
      'accessRestricted',
      'playbackCandidate',
      'downloadSupported',
      'unsupportedReason',
    ],
    ['dateClaims'],
  );
  const dateClaims = Object.hasOwn(r, 'dateClaims') ? validateDateClaims(r.dateClaims) : undefined;
  if (
    !publicArchiveProvider(r.providerId) ||
    (dateClaims !== undefined && r.providerId !== 'nasa') ||
    !publicArchiveSource(r.sourceUrl, r.providerId) ||
    ['mimeType', 'videoCodec', 'audioCodec', 'representationRole', 'contentRole'].some(
      (k) => r[k] !== null && !providerPlainText(r[k], 128),
    ) ||
    ['rights', 'attribution'].some((k) => r[k] !== null && !providerPlainText(r[k], 4096)) ||
    ['width', 'height'].some((k) => r[k] !== null && (!integer(r[k], 32768) || r[k] === 0)) ||
    (r.licenseUrl !== null && !httpsUrl(r.licenseUrl)) ||
    ['downloadAllowed', 'accessRestricted'].some(
      (k) => r[k] !== null && typeof r[k] !== 'boolean',
    ) ||
    typeof r.playbackCandidate !== 'boolean' ||
    r.downloadSupported !== false ||
    (r.unsupportedReason !== null && !providerPlainText(r.unsupportedReason, 512)) ||
    (!r.playbackCandidate && r.unsupportedReason === null) ||
    (r.playbackCandidate && (r.unsupportedReason !== null || r.accessRestricted === true))
  )
    throw invalid();
  return { ...r, ...(dateClaims ? { dateClaims } : {}) } as unknown as ArchiveProviderFacts;
}
export function validatePublicArchiveDiscoverRequest(
  value: PublicArchiveDiscoverRequest,
): PublicArchiveDiscoverRequest {
  const r = object(value, [
    'schemaVersion',
    'expectedRevision',
    'query',
    'decade',
    'languageMode',
    'contentType',
    'curatedOnly',
    'favoritesOnly',
    'restart',
    'explicitAction',
  ]);
  if (
    r.schemaVersion !== 1 ||
    !revision(r.expectedRevision) ||
    !boundedUtf8Text(r.query, 256, true) ||
    /[\p{Cc}\p{Cf}]/u.test(r.query) ||
    r.query.includes('://') ||
    (r.decade !== null &&
      ![1960, 1970, 1980, 1990, 2000, 2010, 2020].includes(r.decade as number)) ||
    !r.query.trim() ||
    !['all', 'english-first', 'english', 'unlisted'].includes(r.languageMode as string) ||
    !['all', 'tv', 'movie', 'short', 'unknown'].includes(r.contentType as string) ||
    typeof r.curatedOnly !== 'boolean' ||
    typeof r.favoritesOnly !== 'boolean' ||
    typeof r.restart !== 'boolean' ||
    r.explicitAction !== true
  )
    throw invalid();
  return { ...r } as unknown as PublicArchiveDiscoverRequest;
}
export function validatePublicArchiveDiscoverReceipt(
  value: unknown,
  request: PublicArchiveDiscoverRequest,
): PublicArchiveDiscoverReceipt {
  const q = validatePublicArchiveDiscoverRequest(request);
  const r = object(value, [
    'schemaVersion',
    'committed',
    'revision',
    'examined',
    'admitted',
    'providers',
    'more',
  ]);
  if (
    r.schemaVersion !== 1 ||
    r.committed !== true ||
    !revision(r.revision) ||
    BigInt(r.revision) < BigInt(q.expectedRevision) ||
    BigInt(r.revision) > BigInt(q.expectedRevision) + 1n ||
    !integer(r.examined, 12) ||
    !integer(r.admitted, 12) ||
    r.admitted > r.examined ||
    !Array.isArray(r.providers) ||
    r.providers.length !== 3 ||
    typeof r.more !== 'boolean'
  )
    throw invalid();
  const seen = new Set<string>();
  const providers = r.providers.map((value) => {
    const p = object(value, [
      'providerId',
      'state',
      'examined',
      'admitted',
      'retryAfterMs',
      'reason',
    ]);
    if (
      !publicArchiveProvider(p.providerId) ||
      seen.has(p.providerId) ||
      !['complete', 'partial', 'waiting', 'failed', 'configuration-required'].includes(
        p.state as string,
      ) ||
      !integer(p.examined, 4) ||
      !integer(p.admitted, 4) ||
      p.admitted > p.examined ||
      (p.retryAfterMs !== null && !integer(p.retryAfterMs, Number.MAX_SAFE_INTEGER)) ||
      (p.reason !== null &&
        (!providerPlainText(p.reason, 128) || !/^[a-z0-9-]+$/u.test(p.reason))) ||
      (['failed', 'configuration-required'].includes(p.state as string) && p.reason === null)
    )
      throw invalid();
    seen.add(p.providerId);
    return { ...p } as unknown as PublicArchiveProviderOutcome;
  });
  if (
    providers.reduce((n, p) => n + p.examined, 0) !== r.examined ||
    providers.reduce((n, p) => n + p.admitted, 0) !== r.admitted ||
    (r.admitted > 0 && r.revision === q.expectedRevision)
  )
    throw invalid();
  return { ...r, providers } as unknown as PublicArchiveDiscoverReceipt;
}
