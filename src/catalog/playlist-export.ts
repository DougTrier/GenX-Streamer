import { validateCatalog } from './codec';
import { MAX_CHANNELS, MAX_PLAYLIST_BYTES, type Channel, type Source } from './parser';
import { boundedUtf8Text } from '../platform/bounded-text';

export interface PlaylistExportInput {
  /** Caller supplies the exact admitted, nonremoved selection in saved order. */
  channels: readonly Channel[];
  sources: readonly Source[];
}
export interface PlaylistExportResult {
  schemaVersion: 1;
  text: string;
  mimeType: 'audio/x-mpegurl';
  filename: 'genx-channels.m3u';
  channelCount: number;
  /** M3U represents each alternate URL as its own entry; application IDs are not portable. */
  streamCount: number;
  byteLength: number;
}
export const playlistExportFailureCodes = [
  'playlist-export-catalog-invalid',
  'playlist-export-metadata-unrepresentable',
  'playlist-export-url-invalid',
  'playlist-export-line-limit',
  'playlist-export-size-limit',
  'playlist-export-entry-limit',
  'playlist-export-worker-failed',
  'playlist-export-worker-protocol',
] as const;
export type PlaylistExportFailureCode = (typeof playlistExportFailureCodes)[number];
export function isPlaylistExportFailureCode(value: unknown): value is PlaylistExportFailureCode {
  return typeof value === 'string' && playlistExportFailureCodes.some((code) => code === value);
}
function fail(code: PlaylistExportFailureCode): never {
  throw new Error(code);
}
const MAX_LINE_BYTES = 16_384;
function hasControls(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029)
      return true;
  }
  return false;
}
function metadata(value: string, attribute = false): string {
  if (hasControls(value) || value.trim() !== value || (attribute && value.includes('"')))
    fail('playlist-export-metadata-unrepresentable');
  return value;
}
/** CPU-only; production callers use the worker boundary for large saved catalogs. */
export function serializePlaylistExport(input: PlaylistExportInput): PlaylistExportResult {
  let catalog;
  try {
    catalog = validateCatalog({
      schemaVersion: 1,
      sources: input.sources,
      channels: input.channels,
    });
  } catch {
    fail('playlist-export-catalog-invalid');
  }
  const lines = ['#EXTM3U'];
  const encoder = new TextEncoder();
  let byteLength = encoder.encode('#EXTM3U\n').byteLength;
  let streamCount = 0;
  const append = (line: string) => {
    if (!boundedUtf8Text(line, MAX_LINE_BYTES)) fail('playlist-export-line-limit');
    byteLength += encoder.encode(line).byteLength + 1;
    if (byteLength > MAX_PLAYLIST_BYTES) fail('playlist-export-size-limit');
    lines.push(line);
  };
  for (const channel of catalog.channels) {
    const attributes: string[] = [];
    if (channel.providerId !== undefined)
      attributes.push(`tvg-id="${metadata(channel.providerId, true)}"`);
    attributes.push(`group-title="${metadata(channel.category, true)}"`);
    for (const field of ['country', 'region', 'state'] as const) {
      const value = channel.geography?.[field];
      if (value !== undefined) attributes.push(`tvg-${field}="${value}"`);
    }
    const line = `#EXTINF:-1 ${attributes.join(' ')},${metadata(channel.name)}`;
    for (const raw of channel.urls) {
      if (++streamCount > MAX_CHANNELS) fail('playlist-export-entry-limit');
      if (/\s|\\/u.test(raw) || /%(?![a-f0-9]{2})/iu.test(raw) || hasControls(raw))
        fail('playlist-export-url-invalid');
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        fail('playlist-export-url-invalid');
      }
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password
      )
        fail('playlist-export-url-invalid');
      append(line);
      append(url.href);
    }
  }
  return {
    schemaVersion: 1,
    text: `${lines.join('\n')}\n`,
    mimeType: 'audio/x-mpegurl',
    filename: 'genx-channels.m3u',
    channelCount: catalog.channels.length,
    streamCount,
    byteLength,
  };
}
