import http from 'node:http';
export const MAP_HEADER = 'owned-map-header';
export const MAP_CHANNEL = 'Owned hydration station';
export const MAP_SOURCE = 'Owned hydration guide';
export const CURRENT_TITLE = 'Owned hydration current';
export const NEXT_TITLE = 'Owned hydration next';
const stamp = (value) =>
  new Date(value)
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14) + ' +0000';
export function guideMapXml(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('Invalid controlled guide clock.');
  return `<tv><channel id="${MAP_HEADER}"><display-name>Owned independent guide target</display-name></channel><programme channel="${MAP_HEADER}" start="${stamp(seed - 600000)}" stop="${stamp(seed + 3000000)}"><title>${CURRENT_TITLE}</title></programme><programme channel="${MAP_HEADER}" start="${stamp(seed + 3000000)}" stop="${stamp(seed + 6600000)}"><title>${NEXT_TITLE}</title></programme></tv>`;
}
export async function startGuideMapFixture(
  mediaOrigin,
  seed = Math.floor(Date.now() / 60000) * 60000,
) {
  const media = new URL(mediaOrigin);
  if (
    media.protocol !== 'http:' ||
    media.hostname !== '127.0.0.1' ||
    media.username ||
    media.password ||
    media.pathname !== '/'
  )
    throw new Error('Owned loopback media origin required.');
  const xml = guideMapXml(seed),
    sockets = new Set();
  let closing;
  let failure = false,
    closed = false,
    catalogRequests = 0,
    guideRequests = 0,
    failedGuideRequests = 0,
    activeResponses = 0;
  const server = http.createServer((request, response) => {
    activeResponses++;
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        activeResponses--;
      }
    };
    response.once('finish', settle);
    response.once('close', settle);
    if (request.url === '/catalog.m3u') {
      catalogRequests++;
      response.writeHead(200, { 'Content-Type': 'application/x-mpegurl' });
      response.end(
        `#EXTM3U\n#EXTINF:-1 group-title="News",${MAP_CHANNEL}\n${media.origin}/hls/live.m3u8\n`,
      );
    } else if (request.url === '/guide.xml') {
      guideRequests++;
      if (failure) {
        failedGuideRequests++;
        response.writeHead(403);
        response.end('Controlled access refusal');
      } else {
        response.writeHead(200, { 'Content-Type': 'application/xml', 'Cache-Control': 'no-store' });
        response.end(xml);
      }
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const stats = () => ({
    catalogRequests,
    guideRequests,
    failedGuideRequests,
    activeResponses,
    activeSockets: sockets.size,
    closed,
  });
  return {
    origin,
    seed,
    failGuide(value) {
      if (typeof value !== 'boolean') throw new Error('Boolean fault control required');
      failure = value;
    },
    stats,
    close() {
      if (closing) return closing;
      closing = (async () => {
        const closedSockets = [...sockets].map(
          (socket) => new Promise((resolve) => socket.once('close', resolve)),
        );
        const joined = new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeIdleConnections();
        server.closeAllConnections();
        await Promise.all([joined, ...closedSockets]);
        closed = true;
        if (activeResponses || sockets.size)
          throw new Error('Owned fixture resource cleanup unconfirmed');
      })();
      return closing;
    },
  };
}
