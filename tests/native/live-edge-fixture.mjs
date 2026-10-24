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
import path from 'node:path';
import { buildLivePlaylist } from '../../scripts/fixture-server.mjs';

/** Four actual sliding two-second segments, no ENDLIST. Reused TS timestamps have explicit discontinuities. */
export async function startLiveEdgeFixture({ now = Date.now } = {}) {
  const segments = await Promise.all(
    [0, 1, 2, 3].map((index) =>
      readFile(path.resolve(`tests/fixtures/media/segment00${index}.ts`)),
    ),
  );
  if (segments.some((segment) => segment.length === 0 || segment.length > 1024 * 1024))
    throw new Error('Owned segment fixture must be nonempty and at most 1 MiB');
  const started = now();
  const requests = [];
  const sockets = new Set();
  const responses = new Set();
  const window = () => {
    const first = Math.floor(Math.max(0, now() - started) / 2000);
    return { first, latest: first + 3 };
  };
  const server = http.createServer((request, response) => {
    responses.add(response);
    response.once('close', () => responses.delete(response));
    response.once('finish', () => responses.delete(response));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(request.url, 'http://owned.invalid');
    const current = window();
    const sequence = url.searchParams.has('sequence')
      ? Number(url.searchParams.get('sequence'))
      : null;
    const entry = {
      path: url.pathname,
      sequence,
      first: current.first,
      latest: current.latest,
      at: now(),
    };
    if (requests.length >= 500) {
      response.writeHead(503);
      response.end('Owned fixture request limit');
      return;
    }
    requests.push(entry);
    if (url.pathname === '/hls/live.m3u8') {
      response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      response.end(buildLivePlaylist(now() - started));
      return;
    }
    const match = /^\/media\/segment00([0-3])\.ts$/.exec(url.pathname);
    // One segment of race grace accommodates a manifest obtained immediately
    // before its window advances. Old windows after the 25-second pause expire.
    if (
      match &&
      Number.isSafeInteger(sequence) &&
      sequence >= current.first - 1 &&
      sequence <= current.latest &&
      sequence % 4 === Number(match[1])
    ) {
      response.setHeader('Content-Type', 'video/mp2t');
      response.end(segments[Number(match[1])]);
      return;
    }
    response.writeHead(404);
    response.end('Segment expired or not admitted');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    window,
    stats: () => ({
      totalRequests: requests.length,
      activeSockets: sockets.size,
      activeResponses: responses.size,
      timers: 0,
      requests: requests.map((entry) => ({ ...entry })),
    }),
    close: async () => {
      const closed = [...sockets].map(
        (socket) => new Promise((resolve) => socket.once('close', resolve)),
      );
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await Promise.all(closed);
    },
  };
}
