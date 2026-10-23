import { expect, it, vi } from 'vitest';
import { parseM3u } from '../../src/catalog/parser';
import { CatalogRefreshService } from '../../src/catalog/service';

const entry = (url: string) => `#EXTINF:-1,Fixture\n${url}\n`;
const oversized = `https://example.invalid/${'界'.repeat(2000)}`;
const warning =
  'Skipped stream URLs exceeding the 16,384-byte limit after normalization: 2. Other supported channels were retained.';

it('isolates normalized Unicode URL overflow while retaining ordinary paths and fragments', () => {
  expect(new TextEncoder().encode(oversized).byteLength).toBeLessThan(16384);
  expect(new TextEncoder().encode(new URL(oversized).href).byteLength).toBeGreaterThan(16384);
  const valid = [
    'https://example.invalid/live/public/channel.m3u8#variant',
    'https://example.invalid/last',
  ];
  const parsed = parseM3u(
    '#EXTM3U\n' + entry(valid[0]!) + entry(oversized) + entry(oversized) + entry(valid[1]!),
    'source',
  );
  expect(parsed.channels.map((channel) => channel.urls[0])).toEqual(valid);
  expect(parsed.warnings).toEqual([warning]);
  expect(JSON.stringify(parsed.warnings)).not.toContain('界');
  expect(JSON.stringify(parsed.warnings)).not.toContain('example.invalid');
});

it('admits the exact normalized limit but preserves original line and structural refusals', () => {
  const prefix = 'https://example.invalid/';
  const exact = prefix + 'a'.repeat(16384 - prefix.length);
  expect(parseM3u('#EXTM3U\n' + entry(exact), 'source').channels[0]!.urls).toEqual([exact]);
  expect(() =>
    parseM3u('#EXTM3U\n' + entry(exact + 'a') + entry(prefix + 'good'), 'source'),
  ).toThrow('line size limit');
  expect(() =>
    parseM3u('#EXTM3U\n' + entry(oversized) + '#EXTINF:-1,Missing URL\n', 'source'),
  ).toThrow('no stream URL');
});

it('retains the last-good catalog when every normalized URL overflows', async () => {
  const previous = [
    {
      id: 'saved',
      sourceId: 'source',
      name: 'Saved',
      category: '',
      urls: ['https://example.invalid/saved'],
    },
  ];
  const commit = vi.fn();
  const service = new CatalogRefreshService(
    { read: async () => previous, commit },
    async () => '',
    async (text, id) => parseM3u(text, id),
  );
  const source = {
    id: 'source',
    name: 'Owned',
    kind: 'url' as const,
    location: 'https://example.invalid/catalog',
  };
  await expect(service.refresh(source, '#EXTM3U\n' + entry(oversized))).rejects.toThrow(
    'previous catalog was retained',
  );
  expect(commit).not.toHaveBeenCalled();
  expect(previous[0]!.urls).toEqual(['https://example.invalid/saved']);
  await service.dispose();
});
