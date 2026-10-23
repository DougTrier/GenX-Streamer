import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Controlled generation gates; no product relay or arbitrary-path file server. */
export async function startSwitchFixtureServer({ count = 500 } = {}) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 500)
    throw new Error('Switch count must be1..500');
  const media = await readFile(new URL('../tests/fixtures/media/segment000.ts', import.meta.url));
  const sockets = new Set();
  const records = [];
  const gates = new Map();
  const released = new Set();
  let url;
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, 'http://fixture.invalid').pathname;
    if (route === '/catalog') {
      response.writeHead(200, { 'Content-Type': 'application/x-mpegurl' });
      response.end(
        '#EXTM3U\n' +
          Array.from(
            { length: count + 1 },
            (_, generation) =>
              `#EXTINF:-1,Switch ${String(generation).padStart(3, '0')}\n${url}/g/${generation}/manifest\n`,
          ).join(''),
      );
      return;
    }
    const match = /^\/g\/(\d+)\/(manifest|segment)$/.exec(route);
    if (!match || Number(match[1]) > count) {
      response.writeHead(404).end();
      return;
    }
    const generation = Number(match[1]);
    const record = {
      generation,
      kind: match[2],
      opened: Date.now(),
      closed: null,
      finished: false,
      released: false,
    };
    records.push(record);
    response.once('finish', () => {
      record.finished = true;
    });
    response.once('close', () => {
      record.closed = Date.now();
    });
    const send = () => {
      if (response.destroyed || response.writableEnded) return;
      record.released = true;
      if (record.kind === 'manifest') {
        response.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
        });
        response.end(
          `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.000000,\n/g/${generation}/segment\n#EXT-X-ENDLIST\n`,
        );
      } else {
        response.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
        response.end(media);
      }
    };
    if (record.kind === 'segment' || released.has(generation)) send();
    else {
      const group = gates.get(generation) ?? [];
      group.push(send);
      gates.set(generation, group);
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    mediaSha256: createHash('sha256').update(media).digest('hex'),
    release(generation) {
      released.add(generation);
      for (const send of gates.get(generation) ?? []) send();
      gates.delete(generation);
    },
    stats() {
      return {
        sockets: sockets.size,
        active: records.filter((record) => record.closed === null).length,
        records: records.map((record) => ({ ...record })),
      };
    },
    async close() {
      gates.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      const deadline = Date.now() + 1000;
      while (
        (sockets.size || records.some((record) => record.closed === null)) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        sockets: sockets.size,
        active: records.filter((record) => record.closed === null).length,
      };
    },
  };
}
