import { combineAbortSignals } from '../platform/abort';
export type SourceKind = 'catalog' | 'hls' | 'media' | 'unsupported';
export interface ConfiguredSource {
  kind: SourceKind;
  text?: string;
  mime?: string;
}
export class SourceRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfter: string | null,
  ) {
    super('The source request failed.');
  }
}
/** HTTP parameters are transport metadata, never part of the persisted MIME essence. */
export function normalizeSourceMime(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return undefined;
  const essence = value.split(';', 1)[0].trim().toLowerCase();
  return essence.length <= 128 && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(essence)
    ? essence
    : undefined;
}
const SNIFF_BYTES = 8192;
const TEXT_LIMIT = 20 * 1024 * 1024;
const text = (bytes: Uint8Array): string =>
  new TextDecoder()
    .decode(bytes)
    .replace(/^\uFEFF/, '')
    .trimStart();
const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));
export function inferMediaMime(bytes: Uint8Array): string | undefined {
  if (ascii(bytes, 4, 4) === 'ftyp') return 'video/mp4';
  if (ascii(bytes, 0, 4) === 'OggS') return 'video/ogg';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return 'video/webm';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'AVI ') return 'video/x-msvideo';
  if (bytes.length >= 189 && bytes[0] === 0x47 && bytes[188] === 0x47) return 'video/mp2t';
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
    return 'audio/mpeg';
  return undefined;
}
/** Trust body evidence before MIME. Never use a URL's filename as a format. */
export function inspectSourceResponse(sample: Uint8Array, contentType: string | null): SourceKind {
  const prefix = text(sample);
  if (/^#EXTM3U(?:\s|$)/i.test(prefix)) return /^#EXT-X-/im.test(prefix) ? 'hls' : 'catalog';
  if (inferMediaMime(sample)) return 'media';
  if (prefix.startsWith('#')) return 'unsupported'; // Partial or malformed playlist marker is not binary media.
  if (/^(?:<!doctype\s+html|<html|<\?xml|\{|\[)/i.test(prefix)) return 'unsupported';
  const mime = normalizeSourceMime(contentType) ?? '';
  if (/^(?:video|audio)\//.test(mime) && !/(?:mpegurl|m3u)/.test(mime)) return 'media';
  return 'unsupported';
}

/** Cancel direct media after a bounded sniff; only finite playlists are read fully. */
export async function readConfiguredSource(
  url: string,
  allowHTTP: boolean,
  signal: AbortSignal,
): Promise<ConfiguredSource> {
  const parsed = new URL(url);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (parsed.protocol === 'http:' && !allowHTTP)
  )
    throw new Error('Use HTTPS or explicitly allow HTTP for this source.');
  signal.throwIfAborted();
  const operation = combineAbortSignals([signal, AbortSignal.timeout(20_000)]);
  const response = await fetch(parsed.href, {
    signal: operation,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SourceRequestError(response.status, response.headers.get('Retry-After'));
  }
  if (!response.body) throw new Error('The source response is empty.');
  const reader = response.body.getReader();
  const mime = normalizeSourceMime(response.headers.get('Content-Type'));
  const sample = new Uint8Array(SNIFF_BYTES);
  const chunks: Uint8Array[] = [];
  let sampleBytes = 0;
  let totalBytes = 0;
  let kind: SourceKind;
  try {
    for (;;) {
      operation.throwIfAborted();
      const { value, done } = await reader.read();
      operation.throwIfAborted();
      if (done) break;
      const amount = Math.min(value.byteLength, SNIFF_BYTES - sampleBytes);
      if (amount) {
        sample.set(value.subarray(0, amount), sampleBytes);
        sampleBytes += amount;
      }
      kind = inspectSourceResponse(sample.subarray(0, sampleBytes), mime ?? null);
      if (kind === 'media')
        return { kind, mime: inferMediaMime(sample.subarray(0, sampleBytes)) ?? mime };
      if (kind === 'unsupported' && sampleBytes >= SNIFF_BYTES) return { kind };
      totalBytes += value.byteLength;
      if (totalBytes > TEXT_LIMIT) throw new Error('Source playlist exceeds the 20 MiB limit.');
      chunks.push(value);
    }
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    kind = inspectSourceResponse(body, mime ?? null);
    if (kind !== 'catalog' && kind !== 'hls') return { kind, mime };
    return { kind, text: new TextDecoder('utf-8', { fatal: true }).decode(body), mime };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
