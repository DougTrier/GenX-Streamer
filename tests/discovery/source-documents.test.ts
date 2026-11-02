import { expect, it } from 'vitest';
import {
  distinctSourceDocuments,
  publishedSourceTemplate,
} from '../../src/discovery/source-documents';
const base = 'https://dearbulut.github.io/iptv/playlists/';
const s = (name: string, allowHttp = false) => ({ location: base + name + '.m3u', allowHttp });
it('scans the complete documented list once instead of its redundant curated subsets', () => {
  const input = [s('best'), s('online'), s('index')];
  expect(distinctSourceDocuments(input)).toEqual([input[2]]);
  expect(input).toHaveLength(3);
});
it('keeps curated choices without the complete list and respects distinct permissions', () => {
  expect(distinctSourceDocuments([s('best'), s('online')])).toHaveLength(2);
  expect(distinctSourceDocuments([s('best', true), s('index')])).toHaveLength(2);
});
it('never folds queries, unrelated hosts or merely similar names', () => {
  expect(
    distinctSourceDocuments([
      s('index'),
      { location: base + 'best.m3u?revision=one' },
      { location: 'https://other.invalid/iptv/playlists/online.m3u' },
    ]),
  ).toHaveLength(3);
});
it('deduplicates only identical document requests, including the HTTP permission', () => {
  expect(distinctSourceDocuments([s('best'), s('best'), s('best', true)])).toHaveLength(2);
});
it('identifies published placeholders without rejecting ordinary list names', () => {
  expect(publishedSourceTemplate('https://example.com/channels.m3u')).toBe(true);
  expect(
    publishedSourceTemplate('https://raw.githubusercontent.com/fixture/repo/main/FILENAME.m3u'),
  ).toBe(true);
  expect(publishedSourceTemplate('https://feed.invalid/filename.m3u')).toBe(false);
});
