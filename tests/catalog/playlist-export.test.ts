/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from 'vitest';
import { serializePlaylistExport } from '../../src/catalog/playlist-export';
import {
  parseM3u,
  reconcileChannels,
  MAX_PLAYLIST_BYTES,
  type Channel,
} from '../../src/catalog/parser';
const source = { id: 'source', name: 'Fixture', kind: 'file' as const, location: 'fixture.m3u' };
const channel = (id = 'one'): Channel => ({
  id,
  sourceId: source.id,
  providerId: id,
  name: 'Evening "News", Live',
  category: 'News & Reports',
  urls: ['https://example.invalid/live.m3u8'],
});
describe('bounded deterministic M3U export', () => {
  it('round-trips declared metadata and alternates without overwriting duplicate names', () => {
    const first = {
      ...channel(),
      geography: { country: 'US', state: 'US-IL', region: 'AMER' },
      urls: ['https://example.invalid/a?public=1&quality=2', 'https://example.invalid/b'],
    };
    const second = channel('different');
    const result = serializePlaylistExport({ sources: [source], channels: [first, second] });
    expect(serializePlaylistExport({ sources: [source], channels: [first, second] })).toEqual(
      result,
    );
    expect(result).toMatchObject({
      channelCount: 2,
      streamCount: 3,
      mimeType: 'audio/x-mpegurl',
      filename: 'genx-channels.m3u',
    });
    expect(new TextEncoder().encode(result.text).byteLength).toBe(result.byteLength);
    const parsed = parseM3u(result.text, 'imported');
    expect(parsed.warnings).toEqual([]);
    expect(
      parsed.channels.map((entry) => [entry.providerId, entry.name, entry.category, entry.urls]),
    ).toEqual([
      ['one', first.name, first.category, [first.urls[0]]],
      ['one', first.name, first.category, [first.urls[1]]],
      ['different', second.name, second.category, second.urls],
    ]);
    expect(parsed.channels[0]!.geography).toEqual(first.geography);
    let next = 0;
    const reconciled = reconcileChannels(parsed.channels, [], () => String(++next));
    expect(new Set(reconciled.map((entry) => entry.id)).size).toBe(3);
    expect(result.text).not.toContain(source.location);
  });
  it.each(['\n#EXTINF:-1,Injected', '\r', '\u0000', '\u007f', '\u0085', '\u2028'])(
    'refuses control injection %j without partial output',
    (suffix) => {
      expect(() =>
        serializePlaylistExport({
          sources: [source],
          channels: [{ ...channel(), name: `Name${suffix}` }],
        }),
      ).toThrow('metadata-unrepresentable');
    },
  );
  it('refuses unrepresentable attribute quotes or trimmed metadata rather than changing identity', () => {
    for (const patch of [
      { providerId: 'quoted"id' },
      { category: 'A "quote"' },
      { name: ' leading' },
      { category: 'trailing ' },
    ])
      expect(() =>
        serializePlaylistExport({ sources: [source], channels: [{ ...channel(), ...patch }] }),
      ).toThrow('metadata-unrepresentable');
  });
  it('requires the actual source HTTP grant and refuses credentials, opaque targets and malformed URLs', () => {
    const input = {
      sources: [source],
      channels: [{ ...channel(), urls: ['http://example.invalid/live'] }],
    };
    expect(() => serializePlaylistExport(input)).toThrow('catalog-invalid');
    expect(
      serializePlaylistExport({ ...input, sources: [{ ...source, allowHttp: true }] }).text,
    ).toContain('http://');
    for (const url of [
      'vault:resource',
      'javascript:alert(1)',
      'https://user:secret@example.invalid/live',
      'not-a-url',
    ])
      expect(() =>
        serializePlaylistExport({ sources: [source], channels: [{ ...channel(), urls: [url] }] }),
      ).toThrow('catalog-invalid');
    for (const url of [
      'https://example.invalid/%zz',
      'https://example.invalid/a\n#EXTM3U',
      'https://example.invalid\\live',
    ])
      expect(() =>
        serializePlaylistExport({ sources: [source], channels: [{ ...channel(), urls: [url] }] }),
      ).toThrow('url-invalid');
  });
  it('preserves supplied order and does not mutate the catalog snapshot', () => {
    const input = { sources: [source], channels: [channel('second'), channel('first')] };
    const before = structuredClone(input);
    const result = serializePlaylistExport(input);
    expect(parseM3u(result.text, 'imported').channels.map((entry) => entry.providerId)).toEqual([
      'second',
      'first',
    ]);
    expect(input).toEqual(before);
  });
  it('enforces exact metadata-line and whole-file UTF8 limits', () => {
    const prefix = '#EXTINF:-1 tvg-id="one" group-title="",';
    const exact = { ...channel(), category: '', name: 'n'.repeat(16384 - prefix.length) };
    expect(
      serializePlaylistExport({ sources: [source], channels: [exact] }).text.split('\n')[1]!.length,
    ).toBe(16384);
    expect(() =>
      serializePlaylistExport({
        sources: [source],
        channels: [{ ...exact, name: exact.name + 'n' }],
      }),
    ).toThrow('line-limit');
    const large = Array.from({ length: 1900 }, (_, i) => ({
      ...channel(String(i)),
      name: '界'.repeat(4000),
    }));
    expect(() => serializePlaylistExport({ sources: [source], channels: large })).toThrow(
      'size-limit',
    );
    expect(MAX_PLAYLIST_BYTES).toBe(20 * 1024 * 1024);
  });
  it('admits 100000 entries and refuses excess channels or alternate-entry count', () => {
    const channels = Array.from({ length: 100000 }, (_, i) => ({
      ...channel(String(i)),
      name: 'Fixture',
      category: '',
    }));
    expect(serializePlaylistExport({ sources: [source], channels }).streamCount).toBe(100000);
    expect(() =>
      serializePlaylistExport({ sources: [source], channels: [...channels, channel('extra')] }),
    ).toThrow('catalog-invalid');
    const alternates = Array.from({ length: 6251 }, (_, i) => ({
      ...channel(String(i)),
      urls: Array.from({ length: 16 }, (_, j) => `https://example.invalid/${j}`),
    }));
    expect(() => serializePlaylistExport({ sources: [source], channels: alternates })).toThrow(
      'entry-limit',
    );
  });
});
