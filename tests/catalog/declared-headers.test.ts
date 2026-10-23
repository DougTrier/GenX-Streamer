import { expect, it } from 'vitest';
import { parseM3u } from '../../src/catalog/parser';

it('counts publisher-declared request headers without forwarding or dropping channels', () => {
  const parsed = parseM3u(
    [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="A.us",A',
      '#EXTVLCOPT:http-user-agent=Custom/1.0',
      'https://a.invalid/live.m3u8',
      '#EXTINF:-1 tvg-id="B.us",B',
      '#EXTVLCOPT:http-referrer=https://b.invalid/',
      '#EXTVLCOPT:http-user-agent=Custom/1.0',
      'https://b.invalid/live.m3u8',
      '#EXTINF:-1 tvg-id="C.us" http-referrer="https://c.invalid/",C',
      'https://c.invalid/live.m3u8',
      '#EXTINF:-1 tvg-id="D.us",D',
      '#EXTVLCOPT:network-caching=1000',
      'https://d.invalid/live.m3u8',
    ].join('\n'),
    'source',
  );
  expect(parsed.channels.map((c) => c.name)).toEqual(['A', 'B', 'C', 'D']);
  expect(parsed.channels.every((c) => c.urls.length === 1)).toBe(true);
  expect(parsed.warnings).toEqual([
    '3 channels declare a required User-Agent or Referrer header, which GenX does not send. They may fail checks or playback here even when the stream works elsewhere.',
  ]);
  expect(JSON.stringify(parsed.channels)).not.toContain('Custom/1.0');
});

it('adds no warning when no entry declares headers', () => {
  expect(parseM3u('#EXTM3U\n#EXTINF:-1,A\nhttps://a.invalid/x\n', 'source').warnings).toEqual([]);
});
