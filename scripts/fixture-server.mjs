import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const defaultMedia = fileURLToPath(new URL('../tests/fixtures/media/', import.meta.url));
const protocolMedia = fileURLToPath(new URL('../tests/fixtures/media/protocol/', import.meta.url));
const playlist =
  '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\n/media/segment000.ts\n#EXT-X-ENDLIST\n';

/** Four-segment sliding live window; original timestamps restart each 8 seconds. */
export function buildLivePlaylist(elapsedMs) {
  const latest = 3 + Math.floor(Math.max(0, elapsedMs) / 2000);
  const first = latest - 3;
  const removedDiscontinuities = Math.max(0, Math.floor((first - 1) / 4));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${removedDiscontinuities}`,
  ];
  for (let sequence = first; sequence <= latest; sequence++) {
    if (sequence > 0 && sequence % 4 === 0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push('#EXTINF:2.000000,', `/media/segment00${sequence % 4}.ts?sequence=${sequence}`);
  }
  return lines.join('\n') + '\n';
}

/** Loopback-only reproducible faults. Never used as the product LAN relay. */
export async function startFixtureServer({
  port = 0,
  delayMs = 150,
  mediaDirectory = defaultMedia,
  now = Date.now,
} = {}) {
  const timers = new Set();
  const sockets = new Set();
  const responses = new Set();
  const requests = [];
  const protocolRequests = [];
  const allowedMedia = new Set(
    (await readdir(mediaDirectory).catch(() => [])).filter((name) =>
      /^[\w.-]+\.(?:m3u8|ts|mp4|m4s|key)$/.test(name),
    ),
  );
  let closing;
  const openPaths = new Map();
  let totalRequests = 0;
  let liveManifests = 0;
  const liveStart = now();
  const server = http.createServer(async (request, response) => {
    totalRequests++;
    responses.add(response);
    // The raw path, so a harness can tell its own stream's open responses apart.
    openPaths.set(response, (request.url ?? '/').split('?')[0]);
    const finished = () => {
      responses.delete(response);
      openPaths.delete(response);
    };
    response.once('finish', finished);
    response.once('close', finished);
    const raw = request.url ?? '/';
    let pathname;
    try {
      const decoded = decodeURIComponent(raw.split('?')[0]);
      if (decoded.includes('\\') || decoded.split('/').includes('..'))
        throw new Error('unsafe path');
      pathname = new URL(raw, 'http://fixture.invalid').pathname;
    } catch {
      response.writeHead(400);
      response.end('Invalid fixture path');
      return;
    }
    if (requests.length < 1000)
      requests.push({
        method: request.method ?? 'GET',
        path: pathname,
        range: request.headers.range ?? null,
        at: Date.now(),
      });
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Expose-Headers', 'Retry-After,Content-Range,Accept-Ranges');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Headers', 'Range');
      response.writeHead(204);
      response.end();
      return;
    }
    const send = (status, body, contentType = 'text/plain') => {
      response.writeHead(status, { 'Content-Type': contentType });
      response.end(body);
    };
    if (pathname.startsWith('/protocol/')) {
      const names = {
        '/protocol/aes/master.m3u8': 'master.m3u8',
        '/protocol/aes/index.m3u8': 'aes.m3u8',
        '/protocol/range/index.m3u8': 'range.m3u8',
        '/protocol/resources/aes.key': 'aes.key',
        '/protocol/resources/ranges.mp4': 'ranges.mp4',
        ...Object.fromEntries(
          [0, 1, 2, 3].map((n) => [`/protocol/resources/aes00${n}.ts`, `aes00${n}.ts`]),
        ),
      };
      if (!Object.hasOwn(names, pathname)) {
        send(404, 'Missing protocol fixture');
        return;
      }
      try {
        const bytes = await readFile(path.join(protocolMedia, names[pathname]));
        const type = pathname.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : pathname.endsWith('.ts')
            ? 'video/mp2t'
            : pathname.endsWith('.key')
              ? 'application/octet-stream'
              : 'video/mp4';
        response.setHeader('Accept-Ranges', 'bytes');
        let body = bytes;
        let status = 200;
        let contentRange = null;
        const range = request.headers.range;
        if (range) {
          const match = /^bytes=(\d+)-(\d+)$/.exec(range);
          const start = match ? Number(match[1]) : -1;
          const end = match ? Number(match[2]) : -1;
          if (!match || start < 0 || start > end || end >= bytes.length) {
            response.setHeader('Content-Range', `bytes */${bytes.length}`);
            send(416, 'Invalid range');
            return;
          }
          body = bytes.subarray(start, end + 1);
          status = 206;
          contentRange = `bytes ${start}-${end}/${bytes.length}`;
          response.setHeader('Content-Range', contentRange);
        }
        if (protocolRequests.length < 1000)
          protocolRequests.push({
            path: pathname,
            query: new URL(raw, 'http://fixture.invalid').search,
            range: range ?? null,
            status,
            bytes: body.length,
            contentRange,
          });
        send(status, body, type);
      } catch {
        send(404, 'Protocol fixtures must be generated first');
      }
      return;
    }
    if (pathname === '/fault/headers-stall' || pathname === '/fault/headers-stall.ts') return;
    if (pathname === '/fault/body-stall') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      response.write('#EXTM3U\n');
      return;
    }
    if (pathname === '/fault/403') {
      send(403, 'Access refused');
      return;
    }
    if (pathname === '/fault/429') {
      response.setHeader('Retry-After', '30');
      send(429, 'Retry later');
      return;
    }
    if (pathname === '/fault/503') {
      response.setHeader('Retry-After', '1');
      send(503, 'Busy');
      return;
    }
    if (pathname === '/fault/disconnect') {
      request.socket.destroy();
      return;
    }
    if (pathname === '/fault/malformed.m3u8') {
      send(200, 'This is not a playlist', 'application/vnd.apple.mpegurl');
      return;
    }
    if (pathname === '/fault/segment-stall.m3u8') {
      send(
        200,
        playlist.replace('/media/segment000.ts', '/fault/headers-stall.ts'),
        'application/vnd.apple.mpegurl',
      );
      return;
    }
    if (pathname === '/fault/delayed.m3u8') {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!response.destroyed) send(200, playlist, 'application/vnd.apple.mpegurl');
      }, delayMs);
      timers.add(timer);
      response.once('close', () => {
        clearTimeout(timer);
        timers.delete(timer);
      });
      return;
    }
    if (pathname === '/hls/master.m3u8') {
      send(
        200,
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="avc1.42c01e,mp4a.40.2"\n/media/index.m3u8\n',
        'application/vnd.apple.mpegurl',
      );
      return;
    }
    if (pathname === '/hls/live.m3u8') {
      liveManifests++;
      send(200, buildLivePlaylist(now() - liveStart), 'application/vnd.apple.mpegurl');
      return;
    }
    if (pathname === '/hls/extensionless') {
      response.writeHead(302, { Location: '/media/index.m3u8' });
      response.end();
      return;
    }
    if (pathname === '/hls/key-map.m3u8') {
      send(
        200,
        '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="/hls/key"\n#EXT-X-MAP:URI="/hls/map"\n#EXTINF:2,\n/media/segment000.ts\n#EXT-X-ENDLIST\n',
        'application/vnd.apple.mpegurl',
      );
      return;
    }
    // Key/map are syntax/resource fixtures only; this playlist is not a decoded-media acceptance fixture.
    if (pathname === '/hls/key') {
      send(200, Buffer.alloc(16, 7), 'application/octet-stream');
      return;
    }
    if (pathname === '/hls/map') {
      send(200, Buffer.from('fixture-map'), 'application/octet-stream');
      return;
    }
    if (pathname.startsWith('/media/')) {
      const name = pathname.slice('/media/'.length);
      if (!allowedMedia.has(name)) {
        send(404, 'Missing fixture');
        return;
      }
      try {
        const bytes = await readFile(path.join(mediaDirectory, name));
        const type = name.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : name.endsWith('.ts')
            ? 'video/mp2t'
            : 'video/mp4';
        response.setHeader('Accept-Ranges', 'bytes');
        const range = request.headers.range;
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);
          const start = match ? Number(match[1]) : -1;
          const end = match?.[2] ? Number(match[2]) : bytes.length - 1;
          if (!match || start < 0 || start > end || start >= bytes.length || end >= bytes.length) {
            response.setHeader('Content-Range', `bytes */${bytes.length}`);
            send(416, 'Invalid range');
            return;
          }
          response.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
          send(206, bytes.subarray(start, end + 1), type);
          return;
        }
        send(200, bytes, type);
        return;
      } catch {
        if (!response.destroyed) send(500, 'Fixture read failed');
        return;
      }
    }
    if (pathname === '/catalog/bom.m3u') {
      send(
        200,
        '\uFEFF#EXTM3U\n#EXTINF:-1 tvg-id="fixture" group-title="Sports",Fixture Sports\n/hls/master.m3u8\n',
        'application/x-mpegurl',
      );
      return;
    }
    send(404, 'Missing fixture');
  });
  server.on('connection', (socket) => {
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
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    stats: () => ({
      totalRequests,
      liveManifests,
      activeResponses: responses.size,
      activePaths: [...openPaths.values()],
      activeSockets: sockets.size,
      timers: timers.size,
      requests: requests.map((item) => ({ ...item })),
      protocolRequests: protocolRequests.map((item) => ({ ...item })),
    }),
    close: () => {
      if (closing) return closing;
      closing = (async () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        const closedResources = [...responses, ...sockets].map(
          (resource) => new Promise((resolve) => resource.once('close', resolve)),
        );
        const stopped = new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        for (const response of responses) response.destroy();
        for (const socket of sockets) socket.destroy();
        await Promise.all([stopped, ...closedResources]);
      })();
      return closing;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startFixtureServer({ port: Number(process.env.TMG_FIXTURE_PORT ?? 17840) });
  console.log(`Fixture server: ${fixture.url}`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      void fixture.close().then(() => process.exit(0));
    });
}
