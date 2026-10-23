import https from 'node:https';
import tls from 'node:tls';

/** Only authenticated server-issued relative resources are accepted by this fixture client. */
const admitted = (resource) => /^\/media\/\d+\/[A-Za-z0-9_-]+$/.test(resource);
export async function rawConsumerPressure({ address, ca, secret, observeHealthy }) {
  const base = new URL(address);
  const sockets = new Set();
  let cookie = '';
  const request = (resource, body, headersOnly = false) =>
    new Promise((resolve, reject) => {
      const owner = https.request(
        new URL(resource, base),
        {
          method: body === undefined ? 'GET' : 'POST',
          ca,
          rejectUnauthorized: true,
          agent: false,
          headers: {
            Cookie: cookie,
            Origin: base.origin,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
        },
        (response) => {
          if (response.headers['set-cookie'])
            cookie = response.headers['set-cookie'][0].split(';')[0];
          const result = {
            status: response.statusCode,
            retryAfter: response.headers['retry-after'],
            body: '',
          };
          if (headersOnly) {
            resolve(result);
            response.destroy();
            return;
          }
          let length = 0;
          const parts = [];
          response.on('data', (chunk) => {
            length += chunk.length;
            if (length > 4 * 1024 * 1024) {
              response.destroy(new Error('Fixture response bound exceeded'));
              return;
            }
            parts.push(chunk);
          });
          response.once('end', () => {
            result.body = Buffer.concat(parts).toString('utf8');
            resolve(result);
          });
          response.once('error', reject);
        },
      );
      owner.once('error', reject);
      owner.setTimeout(10000, () => owner.destroy(new Error('Fixture HTTPS request timeout')));
      owner.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const heartbeat = async (paused) => request('/state', { paused });
  const result = {
    status: 'UNEXERCISED',
    scope:
      'Authenticated issued-resource slow TLS sockets; external admission/closure observations, not upstream/native owner counts',
  };
  try {
    if ((await request('/pair', { secret })).status !== 200)
      throw new Error('Raw pressure fixture pairing refused.');
    const published = JSON.parse((await heartbeat(false)).body);
    let resource = published.mediaPath;
    for (let depth = 0; depth < 8; depth++) {
      if (!admitted(resource)) throw new Error('Fixture resource was not issued by this server.');
      const reply = await request(resource);
      if (reply.status !== 200) {
        result.reason = 'Public manifest unavailable';
        return result;
      }
      const lines = reply.body.split(/\r?\n/).map((line) => line.trim());
      if (!reply.body.startsWith('#EXTM3U')) {
        result.reason = 'No inspectable HLS manifest';
        return result;
      }
      const variants = [];
      for (let i = 0; i < lines.length; i++)
        if (lines[i].startsWith('#EXT-X-STREAM-INF:') && admitted(lines[i + 1]))
          variants.push({
            resource: lines[i + 1],
            bandwidth: Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(lines[i].slice(18))?.[1] ?? 0),
          });
      if (variants.length) {
        variants.sort((a, b) => b.bandwidth - a.bandwidth);
        resource = variants[0].resource;
        continue;
      }
      resource = lines.find((line) => admitted(line));
      break;
    }
    if (!admitted(resource)) {
      result.reason = 'No admitted segment';
      return result;
    }
    await heartbeat(false);
    const opened = [];
    for (let index = 0; index < 4; index++) {
      const response = await new Promise((resolve, reject) => {
        const socket = tls.connect({
          host: base.hostname,
          port: Number(base.port),
          ca,
          rejectUnauthorized: true,
        });
        sockets.add(socket);
        let headers = Buffer.alloc(0);
        const observation = {
          status: null,
          bodyBytes: 0,
          finished: false,
          chunkedTerminator: false,
        };
        const deadline = setTimeout(() => {
          socket.destroy();
          reject(new Error('Slow fixture header timeout'));
        }, 10000);
        socket.once('secureConnect', () =>
          socket.write(
            `GET ${resource} HTTP/1.1\r\nHost: ${base.host}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`,
          ),
        );
        socket.on('data', (chunk) => {
          if (observation.status === null) {
            headers = Buffer.concat([headers, chunk]);
            const end = headers.indexOf('\r\n\r\n');
            if (end < 0) {
              if (headers.length > 8192) socket.destroy();
              return;
            }
            observation.status = Number(/^HTTP\/1\.1 (\d+)/.exec(headers.toString('ascii'))?.[1]);
            observation.bodyBytes = headers.length - end - 4;
            clearTimeout(deadline);
            socket.pause();
            resolve({ socket, observation });
          } else {
            observation.bodyBytes += chunk.length;
            observation.chunkedTerminator = chunk.subarray(-5).equals(Buffer.from('0\r\n\r\n'));
          }
        });
        socket.once('error', (error) => {
          clearTimeout(deadline);
          if (observation.status === null) reject(error);
        });
        socket.once('close', () => {
          sockets.delete(socket);
          observation.finished = true;
          clearTimeout(deadline);
        });
      });
      opened.push(response);
    }
    result.initialStatuses = opened.map((entry) => entry.observation.status);
    const fifth = await request(resource, undefined, true);
    result.fifthStatus = fifth.status;
    result.fifthRetryAfter = fifth.retryAfter ?? null;
    result.healthyWhileReadersPaused = await observeHealthy();
    if (!opened.every((entry) => entry.observation.status === 200) || fifth.status !== 429) {
      result.reason =
        'Four active media permits were not demonstrated; buffering may have completed.';
      return result;
    }
    if (fifth.retryAfter !== '1')
      throw new Error('Active per-consumer refusal omitted retry hint.');
    opened[0].socket.destroy();
    const releasedAt = Date.now();
    let replacement;
    do {
      replacement = await request(resource, undefined, true);
      if (replacement.status === 429) await new Promise((resolve) => setTimeout(resolve, 100));
    } while (replacement.status === 429 && Date.now() - releasedAt < 3000);
    result.replacementStatus = replacement.status;
    result.slotReleaseObservedMilliseconds = Date.now() - releasedAt;
    if (replacement.status !== 200) throw new Error('Abandoned socket admission did not recover.');
    const pausedAt = Date.now();
    if ((await heartbeat(true)).status !== 200)
      throw new Error('Consumer pause heartbeat refused.');
    for (const entry of opened.slice(1)) entry.socket.resume();
    while (sockets.size && Date.now() - pausedAt < 3000)
      await new Promise((resolve) => setTimeout(resolve, 20));
    result.pauseCloseObservedMilliseconds = Date.now() - pausedAt;
    result.socketObservations = opened.map((entry) => entry.observation);
    if (sockets.size) throw new Error('Paused consumer sockets did not close.');
    result.healthyAfterConsumerPause = await observeHealthy();
    result.status = 'PASS_EXPLORATORY';
    return result;
  } finally {
    const closing = [...sockets].map(
      (socket) =>
        new Promise((resolve) => {
          socket.once('close', resolve);
          socket.destroy();
        }),
    );
    await Promise.all(closing);
    // Explicit bounded cleanup of the fixture-only consumer, independent of the other viewers.
    await heartbeat(true).catch(() => {});
    result.ownedSocketsRemaining = sockets.size;
  }
}
