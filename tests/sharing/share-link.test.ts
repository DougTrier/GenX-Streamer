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
import {
  buildShareMessage,
  cleanName,
  parseShareLink,
  privateHost,
  shareableLogo,
  shareableStream,
  shareRefusalMessage,
  ShareLinkError,
  SHARE_PAGE,
  type SharedItem,
} from '../../src/sharing/share-link';
import { streamCheckMessage } from '../../src/application/sharing/shared-incoming';

const channel: SharedItem = {
  kind: 'channel',
  name: 'News 24',
  stream: 'https://cdn.news24.example.com/live/master.m3u8',
  logo: 'https://logos.example.com/news24.png',
};
const code = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    if (error instanceof ShareLinkError) return error.code;
    throw error;
  }
  return 'accepted';
};

describe('share links', () => {
  it('builds the page link with only the name, logo and public stream, and reads it back', () => {
    const message = buildShareMessage(channel);
    expect(message.link.startsWith(`${SHARE_PAGE}#v=1&c=ch&n=News+24&s=`)).toBe(true);
    expect(message.text).toBe(`Watch News 24 on GenX Streamer: ${message.link}`);
    expect(message.title).toBe('News 24');
    // Details ride in the fragment, which a browser never sends to the page's server.
    expect(new URL(message.link).search).toBe('');
    expect([...new URLSearchParams(new URL(message.link).hash.slice(1)).keys()]).toEqual([
      'v',
      'c',
      'n',
      's',
      'l',
    ]);
    expect(parseShareLink(message.link)).toEqual(channel);
    expect(parseShareLink(message.appLink)).toEqual(channel);
    expect(message.appLink.startsWith('genx://watch?v=1&c=ch')).toBe(true);
  });

  it('shares GenXtra titles by their archive reference', () => {
    const titleRef = 'a'.repeat(64);
    const message = buildShareMessage({ kind: 'title', name: 'His Girl Friday', titleRef });
    expect(parseShareLink(message.link)).toEqual({
      kind: 'title',
      name: 'His Girl Friday',
      titleRef,
    });
    expect(
      code(() => buildShareMessage({ kind: 'title', name: 'X', titleRef: 'A'.repeat(64) })),
    ).toBe('share-title-invalid');
  });

  it('refuses account (Paid TV) addresses when building and when reading', () => {
    for (const stream of [
      'http://provider.example.com:8080/live/alice/s3cret/12345.ts',
      'http://provider.example.com/movie/alice/s3cret/9.mp4',
      'http://provider.example.com/series/alice/s3cret/9.mkv',
      'http://provider.example.com/timeshift/alice/s3cret/60/2026-10-24:10-00/1.ts',
      'http://alice:s3cret@provider.example.com/stream.m3u8',
      'http://provider.example.com/get.php?username=alice&password=s3cret',
      'http://provider.example.com/play.m3u8?token=abc',
      'https://cdn.example.com/live.m3u8?hdnts=exp=1~acl=*',
      'http://portal.example.com/play/live.php?mac=00:1A:79:00:00:01&stream=1',
    ]) {
      expect(
        code(() => buildShareMessage({ ...channel, stream })),
        stream,
      ).toBe('share-stream-account');
      const crafted = `${SHARE_PAGE}#${new URLSearchParams({ v: '1', c: 'ch', n: 'x', s: stream })}`;
      expect(
        code(() => parseShareLink(crafted)),
        stream,
      ).toBe('share-stream-account');
    }
    expect(shareRefusalMessage('share-stream-account')).toContain('Paid TV');
  });

  it('refuses private, local and reserved destinations', () => {
    for (const host of [
      'localhost',
      'tv',
      'router.lan',
      'nas.local',
      'box.home.arpa',
      'printer.internal',
      '10.1.2.3',
      '127.0.0.1',
      '192.168.0.10',
      '172.20.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '[::1]',
      '[fe80::1]',
      '[fd00::5]',
      '[::ffff:7f00:1]',
      '[2001:db8::1]',
    ])
      expect(privateHost(host), host).toBe(true);
    for (const host of ['cdn.example.com', '8.8.8.8', '[2606:4700::1111]', 'tv.example.org'])
      expect(privateHost(host), host).toBe(false);
    expect(code(() => shareableStream('http://192.168.1.5:8000/live.ts'))).toBe(
      'share-stream-private',
    );
    // The URL parser turns other spellings of loopback into 127.0.0.1 first.
    expect(code(() => shareableStream('http://0x7f.1/live.ts'))).toBe('share-stream-private');
    expect(code(() => shareableStream('http://2130706433/live.ts'))).toBe('share-stream-private');
  });

  it('accepts only http(s) stream addresses of bounded length and stream formats', () => {
    expect(shareableStream('https://cdn.example.com/a/b/index.m3u8#frag')).toBe(
      'https://cdn.example.com/a/b/index.m3u8',
    );
    expect(shareableStream('http://radio.example.com:8000/stream')).toBe(
      'http://radio.example.com:8000/stream',
    );
    for (const bad of [
      'ftp://cdn.example.com/a.ts',
      'javascript:alert(1)',
      'file:///C:/x.ts',
      'data:text/plain,hi',
      'https://cdn.example.com/page.html',
      'https://cdn.example.com/setup.exe',
      'https://cdn.example.com/a b.m3u8',
      `https://cdn.example.com/${'a'.repeat(2048)}.m3u8`,
      42,
      null,
    ])
      expect(
        code(() => shareableStream(bad)),
        String(bad),
      ).toBe('share-stream-invalid');
    expect(shareableLogo('http://logos.example.com/a.png')).toBeNull();
    expect(shareableLogo('https://10.0.0.2/a.png')).toBeNull();
    expect(shareableLogo('https://u:p@logos.example.com/a.png')).toBeNull();
    expect(shareableLogo('https://logos.example.com:8443/a.png')).toBeNull();
  });

  it('cleans names to visible text and refuses empty or oversized ones', () => {
    expect(cleanName('  News\u202e 24\u0000\n HD ')).toBe('News 24 HD');
    expect(cleanName('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
    for (const bad of ['', '   ', '\u200b\u200b', 'a'.repeat(121), 7])
      expect(code(() => cleanName(bad))).toBe('share-name-invalid');
  });

  it('reads only its own page or scheme, version 1, with known and unrepeated fields', () => {
    const fields = 'v=1&c=ch&n=News&s=https%3A%2F%2Fcdn.example.com%2Fa.m3u8';
    for (const accepted of [
      `${SHARE_PAGE}#${fields}`,
      `https://dougtrier.github.io/GenX-Streamer/watch#${fields}`,
      `https://dougtrier.github.io/GenX-Streamer/watch/index.html#${fields}`,
      `https://dougtrier.github.io/GenX-Streamer/watch/?${fields}`,
      `genx://watch?${fields}`,
      `genx://watch/#${fields}`,
    ])
      expect(parseShareLink(accepted).name, accepted).toBe('News');
    for (const refused of [
      `https://example.com/GenX-Streamer/watch/#${fields}`,
      `http://dougtrier.github.io/GenX-Streamer/watch/#${fields}`,
      `https://dougtrier.github.io/GenX-Streamer/other/#${fields}`,
      `https://dougtrier.github.io:444/GenX-Streamer/watch/#${fields}`,
      `https://user@dougtrier.github.io/GenX-Streamer/watch/#${fields}`,
      `genx://settings?${fields}`,
      `genx://watch?${fields}&x=1`,
      `genx://watch?${fields}&n=Other`,
      `genx://watch?${fields}&t=${'a'.repeat(64)}`,
      'genx://watch?v=1&c=gx&n=Title&t=xyz',
      'genx://watch?v=1&c=zz&n=Title',
      'not a link',
      `genx://watch?${fields}&l=${'a'.repeat(6000)}`,
    ])
      expect(
        code(() => parseShareLink(refused)),
        refused,
      ).not.toBe('accepted');
    expect(code(() => parseShareLink(`genx://watch?v=2&c=ch&n=x`))).toBe('share-link-version');
  });

  it('explains expired, moved, region-locked and unreachable streams plainly', () => {
    expect(streamCheckMessage('News 24', { status: 404 })).toContain(
      'no longer at the shared address',
    );
    expect(streamCheckMessage('News 24', { status: 410 })).toContain('moved or ended');
    expect(streamCheckMessage('News 24', { status: 403 })).toContain('certain countries');
    expect(streamCheckMessage('News 24', { status: 451 })).toContain('certain countries');
    expect(streamCheckMessage('News 24', { status: 503 })).toContain('not answering');
    expect(streamCheckMessage('News 24', { error: 'dns-failure' })).toContain('could not be found');
    expect(streamCheckMessage('News 24', { error: 'share-destination-private' })).toContain(
      'private or local network',
    );
    expect(streamCheckMessage('News 24', { error: 'timeout' })).toContain('did not answer');
    expect(streamCheckMessage('News 24', {})).toBeNull();
    expect(streamCheckMessage('News 24', { status: 200 })).toBeNull();
  });
});
