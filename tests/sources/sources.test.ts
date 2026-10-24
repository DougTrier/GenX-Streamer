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

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectSourceResponse,
  inferMediaMime,
  readConfiguredSource,
  SourceRequestError,
} from '../../src/sources';
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('source formats depend on response evidence, never filename', () => {
  it('uses BOM/markers before an incorrect MIME header', () => {
    expect(
      inspectSourceResponse(
        bytes('\uFEFF#EXTM3U\n#EXTINF:-1,Channel\nopaque-address\n'),
        'video/mp4',
      ),
    ).toBe('catalog');
    expect(inspectSourceResponse(bytes('#EXTM3U\n#EXT-X-TARGETDURATION:2\n'), 'text/plain')).toBe(
      'hls',
    );
    expect(
      inspectSourceResponse(
        bytes('<!doctype html><html>error</html>'),
        'application/vnd.apple.mpegurl',
      ),
    ).toBe('unsupported');
    expect(inspectSourceResponse(bytes('#EXTM'), 'video/mp4')).toBe('unsupported');
  });
  it('recognizes MP4, MPEG-TS, Ogg, WebM and RIFF signatures with wrong MIME', () => {
    expect(
      inspectSourceResponse(new Uint8Array([0, 0, 0, 20, ...bytes('ftypisom')]), 'text/plain'),
    ).toBe('media');
    const transport = new Uint8Array(376);
    transport[0] = transport[188] = 0x47;
    expect(inspectSourceResponse(transport, 'application/octet-stream')).toBe('media');
    for (const content of [
      bytes('OggSmore'),
      new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
      bytes('RIFF0000WAVE'),
      bytes('RIFF0000AVI '),
    ])
      expect(inspectSourceResponse(content, null)).toBe('media');
    expect(inspectSourceResponse(bytes('unrecognized bytes'), 'video/custom')).toBe('media');
    expect(inferMediaMime(new Uint8Array([0xff, 0xf1, 0x50]))).toBe('audio/aac');
    expect(inferMediaMime(new Uint8Array([0xff, 0xfb, 0x50]))).toBe('audio/mpeg');
  });
  it('reads arbitrary filename and extensionless catalogs identically', async () => {
    const body = '#EXTM3U\n#EXTINF:-1,Fixture\nopaque\n';
    const fetcher = vi.fn(
      async () => new Response(body, { headers: { 'Content-Type': 'text/plain' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    for (const url of ['https://source.test/channel-data.bin', 'https://source.test/entry'])
      expect(await readConfiguredSource(url, false, new AbortController().signal)).toMatchObject({
        kind: 'catalog',
        text: body,
      });
  });
  it('cancels a direct continuous media body immediately after a bounded sample', async () => {
    let reads = 0;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          const chunk = new Uint8Array(64 * 1024);
          chunk.set(bytes('ftyp'), 4);
          controller.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(stream, { headers: { 'Content-Type': 'application/octet-stream' } }),
      ),
    );
    expect(
      await readConfiguredSource(
        'https://source.test/continuous',
        false,
        new AbortController().signal,
      ),
    ).toEqual({ kind: 'media', mime: 'video/mp4' });
    expect(reads).toBe(1);
    expect(canceled).toBe(true);
  });
  it('bounds unknown response inspection and refuses oversized finite text', async () => {
    let reads = 0;
    let canceled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  reads++;
                  controller.enqueue(bytes('x'.repeat(8192)));
                },
                cancel() {
                  canceled = true;
                },
              },
              { highWaterMark: 0 },
            ),
          ),
      ),
    );
    expect(
      (
        await readConfiguredSource(
          'https://source.test/unknown',
          false,
          new AbortController().signal,
        )
      ).kind,
    ).toBe('unsupported');
    expect(reads).toBe(1);
    expect(canceled).toBe(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('#EXTM3U\n' + 'x'.repeat(20 * 1024 * 1024))),
    );
    await expect(
      readConfiguredSource('https://source.test/large', false, new AbortController().signal),
    ).rejects.toThrow('20 MiB');
  });
  it('cancels superseded inspection before publishing a source result', async () => {
    const abort = new AbortController();
    let canceled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                abort.abort();
                controller.enqueue(bytes('#EXTM3U\n'));
              },
              cancel() {
                canceled = true;
              },
            }),
          ),
      ),
    );
    await expect(
      readConfiguredSource('https://source.test/canceled', false, abort.signal),
    ).rejects.toThrow();
    expect(canceled).toBe(true);
  });
  it('retains HTTP refusal metadata and prevents HTTP without explicit opt in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '30' } })),
    );
    await expect(
      readConfiguredSource('https://source.test/busy', false, new AbortController().signal),
    ).rejects.toMatchObject({
      status: 429,
      retryAfter: '30',
    } satisfies Partial<SourceRequestError>);
    await expect(
      readConfiguredSource('http://source.test/entry', false, new AbortController().signal),
    ).rejects.toThrow('explicitly allow HTTP');
  });
});
