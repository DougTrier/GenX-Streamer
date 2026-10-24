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

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const MAX_PLAYLIST_BYTES = 20 * 1024 * 1024;
const mediaFile = new URL('../tests/fixtures/media/segment000.ts', import.meta.url);
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;

/** Controlled loopback acquisition fixture, never a product relay or public server. */
export async function startLargeScanFixtureServer({
  deviceOrigins,
  count = 13256,
  seed = 'large-scan-v1',
  port = 0,
  responseDelayMs = 0,
  historyLimit = 64,
  indexedSegments = false,
  unavailableIndices = [],
} = {}) {
  if (
    !integer(count, 1, 100000) ||
    !integer(port, 0, 65535) ||
    !integer(responseDelayMs, 0, 1000) ||
    !integer(historyLimit, 0, 64) ||
    typeof indexedSegments !== 'boolean' ||
    !Array.isArray(unavailableIndices) ||
    unavailableIndices.length > count ||
    Object.getOwnPropertySymbols(unavailableIndices).length > 0 ||
    Object.keys(unavailableIndices).length !== unavailableIndices.length ||
    typeof seed !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(seed) ||
    !Array.isArray(deviceOrigins) ||
    deviceOrigins.length < 1 ||
    deviceOrigins.length > 16
  )
    throw new Error('Invalid large scan fixture configuration.');
  // Snapshot only dense own data entries; never evaluate an index accessor.
  const unavailable = new Set();
  for (let i = 0; i < unavailableIndices.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(unavailableIndices, String(i));
    if (
      !entry ||
      !Object.hasOwn(entry, 'value') ||
      !integer(entry.value, 0, count - 1) ||
      unavailable.has(entry.value)
    )
      throw new Error('Invalid unavailable fixture indices.');
    unavailable.add(entry.value);
  }
  const origins = deviceOrigins.map((raw) => {
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new Error('Invalid fixture origin.');
    }
    if (
      u.protocol !== 'http:' ||
      u.hostname !== '127.0.0.1' ||
      !u.port ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/' ||
      raw !== u.origin ||
      !integer(Number(u.port), 1024, 65535)
    )
      throw new Error('Invalid fixture origin.');
    return u.origin;
  });
  if (new Set(origins).size !== origins.length) throw new Error('Duplicate fixture origin.');
  const descriptor = (index) => ({
    providerId: `gx-fixture-${seed}-${index}`,
    name: `Large scan ${seed} ${String(index).padStart(6, '0')}`,
    category: 'Fixture',
    url: `${origins[index % origins.length]}/channel/${index}/index.m3u8`,
  });
  const parts = ['#EXTM3U\n'];
  let playlistBytes = Buffer.byteLength(parts[0]);
  for (let i = 0; i < count; i++) {
    const d = descriptor(i);
    const line = `#EXTINF:-1 tvg-id="${d.providerId}" group-title="Fixture",${d.name}\n${d.url}\n`;
    playlistBytes += Buffer.byteLength(line);
    if (playlistBytes > MAX_PLAYLIST_BYTES) throw new Error('Fixture playlist exceeds 20 MiB.');
    parts.push(line);
  }
  const playlist = Buffer.from(parts.join(''));
  parts.length = 0;
  const media = await readFile(mediaFile);
  if (!media.length || media.length > 2 * 1024 * 1024 || media[0] !== 0x47)
    throw new Error('Controlled MPEG-TS fixture unavailable.');
  const sockets = new Set(),
    responses = new Set(),
    timers = new Set(),
    history = [];
  // Fixed admitted-count storage; never retain request objects or source URLs.
  const manifestCounts = new Uint32Array(count);
  const segmentCounts = new Uint32Array(count);
  const overflow = new Uint8Array(count);
  const counters = {
    requests: 0,
    catalog: 0,
    manifests: 0,
    segments: 0,
    rejected: 0,
    finished: 0,
    aborted: 0,
    peakResponses: 0,
    counterOverflowIndices: 0,
  };
  const increment = (counts, index) => {
    if (counts[index] === 0xffffffff) {
      if (!overflow[index]) counters.counterOverflowIndices++;
      overflow[index] = 1;
    } else counts[index]++;
  };
  let closing = null,
    stopped = false;
  const record = (kind, index = null) => {
    if (!historyLimit) return;
    if (history.length === historyLimit) history.shift();
    history.push({ kind, index });
  };
  const server = http.createServer((request, response) => {
    counters.requests++;
    if (stopped || responses.size >= 64) {
      counters.rejected++;
      response.writeHead(503).end();
      return;
    }
    responses.add(response);
    counters.peakResponses = Math.max(counters.peakResponses, responses.size);
    let timer = null,
      finished = false;
    response.once('finish', () => {
      finished = true;
      counters.finished++;
    });
    response.once('close', () => {
      responses.delete(response);
      if (!finished) counters.aborted++;
      if (timer !== null) {
        clearTimeout(timer);
        timers.delete(timer);
      }
    });
    const send = (status, body, type, extra = {}) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, {
        'Content-Type': type,
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        ...extra,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    let body,
      type,
      kind,
      index = null,
      status = 200,
      extra = {};
    const channel = /^\/channel\/(0|[1-9][0-9]{0,5})\/index\.m3u8$/u.exec(request.url ?? '');
    const indexedSegment = /^\/channel\/(0|[1-9][0-9]{0,5})\/segment000\.ts$/u.exec(
      request.url ?? '',
    );
    if (!['GET', 'HEAD'].includes(request.method)) {
      counters.rejected++;
      record('rejected');
      send(405, Buffer.alloc(0), 'text/plain');
      return;
    }
    if (request.url === '/catalog.m3u') {
      counters.catalog++;
      kind = 'catalog';
      body = playlist;
      type = 'application/x-mpegurl';
    } else if (channel && Number(channel[1]) < count) {
      index = Number(channel[1]);
      counters.manifests++;
      increment(manifestCounts, index);
      kind = 'manifest';
      if (unavailable.has(index)) {
        counters.rejected++;
        status = 404;
        body = Buffer.from('Fixture channel unavailable.\n');
        type = 'text/plain';
      } else {
        body = Buffer.from(
          `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.000000,\n${origins[index % origins.length]}${indexedSegments ? `/channel/${index}/segment000.ts` : '/media/segment000.ts'}\n#EXT-X-ENDLIST\n`,
        );
        type = 'application/vnd.apple.mpegurl';
      }
    } else if (
      request.url === '/media/segment000.ts' ||
      (indexedSegments && indexedSegment && Number(indexedSegment[1]) < count)
    ) {
      if (indexedSegment) {
        index = Number(indexedSegment[1]);
        increment(segmentCounts, index);
      }
      counters.segments++;
      kind = 'segment';
      body = media;
      type = 'video/mp2t';
      extra = { 'Accept-Ranges': 'bytes' };
      if (request.headers.range !== undefined) {
        const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range);
        const start = range ? Number(range[1]) : NaN;
        const end = range?.[2] ? Number(range[2]) : media.length - 1;
        if (!integer(start, 0, media.length - 1) || !integer(end, start, media.length - 1)) {
          counters.rejected++;
          record('rejected');
          send(416, Buffer.alloc(0), 'text/plain', { 'Content-Range': `bytes */${media.length}` });
          return;
        }
        status = 206;
        body = media.subarray(start, end + 1);
        extra['Content-Range'] = `bytes ${start}-${end}/${media.length}`;
      }
    } else {
      counters.rejected++;
      record('rejected');
      send(404, Buffer.alloc(0), 'text/plain');
      return;
    }
    record(kind, index);
    if (responseDelayMs) {
      timer = setTimeout(() => {
        timers.delete(timer);
        timer = null;
        send(status, body, type, extra);
      }, responseDelayMs);
      timers.add(timer);
    } else send(status, body, type, extra);
  });
  server.on('connection', (socket) => {
    if (stopped || sockets.size >= 64) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    count,
    seed,
    playlistBytes,
    playlistSha256: createHash('sha256').update(playlist).digest('hex'),
    indexedSegments,
    reachableCount: count - unavailable.size,
    unavailableCount: unavailable.size,
    descriptors: () => Array.from({ length: count }, (_, i) => descriptor(i)),
    expectedReachableDescriptors: () => {
      const result = [];
      for (let i = 0; i < count; i++) if (!unavailable.has(i)) result.push(descriptor(i));
      return result;
    },
    countsFor: (indices) => {
      if (
        !Array.isArray(indices) ||
        indices.length > count ||
        Object.getOwnPropertySymbols(indices).length ||
        Object.keys(indices).length !== indices.length
      )
        throw new Error('Invalid fixture counter indices.');
      const checked = [];
      const unique = new Set();
      for (let offset = 0; offset < indices.length; offset++) {
        const descriptor = Object.getOwnPropertyDescriptor(indices, offset);
        if (
          !descriptor ||
          !('value' in descriptor) ||
          !integer(descriptor.value, 0, count - 1) ||
          unique.has(descriptor.value)
        )
          throw new Error('Invalid fixture counter indices.');
        unique.add(descriptor.value);
        checked.push(descriptor.value);
      }
      return Object.freeze(
        checked.map((index) =>
          Object.freeze({
            index,
            manifests: manifestCounts[index],
            segments: segmentCounts[index],
            overflow: overflow[index] !== 0,
          }),
        ),
      );
    },
    stats: () => ({
      ...counters,
      activeResponses: responses.size,
      activeSockets: sockets.size,
      timers: timers.size,
      history: history.map((v) => ({ ...v })),
    }),
    close: () => {
      if (closing) return closing;
      stopped = true;
      closing = (async () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        const joins = [...responses, ...sockets].map(
          (resource) => new Promise((resolve) => resource.once('close', resolve)),
        );
        const listener = new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        for (const response of responses) response.destroy();
        for (const socket of sockets) socket.destroy();
        await Promise.all([listener, ...joins]);
      })();
      return closing;
    },
  };
}
