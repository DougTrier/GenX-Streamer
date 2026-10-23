import { expect, it, vi } from 'vitest';
import { MAX_CHANNELS, parseM3u } from '../../src/catalog/parser';
import { CatalogRefreshService } from '../../src/catalog/service';
const entry = (url: string) => `#EXTINF:-1,Fixture\n${url}\n`;

it('collects every supported entry when an older WebView exposes opaque unsupported URLs', () => {
  const NativeURL = URL;
  class OpaqueURL extends NativeURL {
    constructor(input: string | URL, base?: string | URL) {
      super(input, base);
      if (/^(srt|rtmp|mmsh|rtsp):/i.test(String(input)))
        Object.defineProperty(this, 'hostname', { value: '' });
    }
  }
  vi.stubGlobal('URL', OpaqueURL);
  try {
    const parsed = parseM3u(
      '#EXTM3U\n' +
        entry('https://example.invalid/first') +
        entry('srt://example.invalid:9000?streamid=public') +
        entry('rtmp://example.invalid/live') +
        entry('mmsh://example.invalid/live') +
        entry('RTSP://[2001:db8::1]:554/live') +
        entry('https://example.invalid/last'),
      'source',
    );
    expect(parsed.channels.map((channel) => channel.urls[0])).toEqual([
      'https://example.invalid/first',
      'https://example.invalid/last',
    ]);
    expect(parsed.warnings).toEqual([
      'Skipped unsupported stream protocols: srt 1, rtmp 1, mmsh 1, rtsp 1. Only HTTP and HTTPS streams were collected.',
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  'rtsp://user:secret@example.invalid/live',
  'rtsp://user%40example.invalid/live',
  'srt:///missing-authority',
  'rtmp://example.invalid:',
  'rtmp://example.invalid:99999/live',
  'mmsh://example.invalid\\other/live',
  'rtsp://[invalid]:554/live',
  'srt://example.invalid:abc/live',
])('refuses malformed or credential-bearing inert transport authority (%#)', (url) => {
  expect(() =>
    parseM3u('#EXTM3U\n' + entry(url) + entry('https://example.invalid/live'), 'source'),
  ).toThrow();
});

it('reports recognized unsupported protocols while collecting supported entries', () => {
  const parsed = parseM3u(
    '#EXTM3U\n' +
      entry('srt://example.invalid:9000') +
      entry('rtmp://example.invalid/live') +
      entry('mmsh://example.invalid/live') +
      entry('rtmp://example.invalid/other') +
      entry('https://example.invalid/live'),
    'source',
  );
  expect(parsed.channels).toHaveLength(1);
  expect(parsed.warnings).toEqual([
    'Skipped unsupported stream protocols: srt 1, rtmp 2, mmsh 1. Only HTTP and HTTPS streams were collected.',
  ]);
});

it('skips only the exact reviewed no-public-stream marker and keeps all supported channels', () => {
  const parsed = parseM3u(
    '#EXTM3U\n' +
      entry('https://example.invalid/first') +
      entry('[NO PUBLIC STREAM]') +
      entry('rtsp://example.invalid/live') +
      entry('[NO PUBLIC STREAM]') +
      entry('http://example.invalid/last'),
    'source',
  );
  expect(parsed.channels.map((channel) => channel.urls[0])).toEqual([
    'https://example.invalid/first',
    'http://example.invalid/last',
  ]);
  expect(parsed.warnings).toEqual([
    'Skipped unsupported stream protocols: rtsp 1. Only HTTP and HTTPS streams were collected.',
    'Skipped unavailable stream placeholders: 2. No stream URLs were invented.',
  ]);
  for (const invalid of ['[no public stream]', '[NO PUBLIC STREAM]suffix', 'relative/live.m3u8'])
    expect(() =>
      parseM3u('#EXTM3U\n' + entry(invalid) + entry('https://example.invalid/live'), 'source'),
    ).toThrow('invalid stream URL');
  expect(() => parseM3u('#EXTM3U\n' + entry('[NO PUBLIC STREAM]'), 'source')).toThrow(
    'previous catalog was retained',
  );
  expect(() =>
    parseM3u(
      '#EXTM3U\n' +
        entry('[NO PUBLIC STREAM]').repeat(MAX_CHANNELS) +
        entry('https://example.invalid/live'),
      'source',
    ),
  ).toThrow('100,000');
});

it('counts skipped attempts toward the limit and refuses unsafe or malformed schemes', () => {
  expect(() =>
    parseM3u(
      '#EXTM3U\n' +
        entry('rtmp://example.invalid/live').repeat(MAX_CHANNELS) +
        entry('https://example.invalid/live'),
      'source',
    ),
  ).toThrow('100,000');
  for (const url of [
    'javascript:alert(1)',
    'file:///x',
    'srt:missing-host',
    'rtmp://user:secret@example.invalid/live',
  ])
    expect(() =>
      parseM3u('#EXTM3U\n' + entry(url) + entry('https://example.invalid/live'), 'source'),
    ).toThrow('Only HTTP and HTTPS');
});

it('retains previous data on unsupported-only input and returns warnings only after commit', async () => {
  const commit = vi.fn().mockResolvedValue(undefined);
  const service = new CatalogRefreshService(
    { read: async () => [], commit },
    async () => '',
    async (text, id) => parseM3u(text, id),
  );
  const source = {
    id: 'source',
    name: 'Owned',
    kind: 'url' as const,
    location: 'https://example.invalid/catalog',
  };
  await expect(
    service.refresh(source, '#EXTM3U\n' + entry('rtmp://example.invalid/live')),
  ).rejects.toThrow('previous catalog was retained');
  expect(commit).not.toHaveBeenCalled();
  await expect(service.refresh(source, '#EXTM3U\n' + entry('[NO PUBLIC STREAM]'))).rejects.toThrow(
    'previous catalog was retained',
  );
  expect(commit).not.toHaveBeenCalled();
  const result = await service.refresh(
    source,
    '#EXTM3U\n' + entry('rtmp://example.invalid/live') + entry('https://example.invalid/live'),
  );
  expect(commit).toHaveBeenCalledOnce();
  expect(result.warnings).toEqual([
    'Skipped unsupported stream protocols: rtmp 1. Only HTTP and HTTPS streams were collected.',
  ]);
  await service.dispose();
});
