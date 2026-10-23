import { readFile } from 'node:fs/promises';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { createServer, get } from 'node:https';
import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';

it('real TLS fixture accepts its explicit CA but ordinary Chromium refuses untrusted identity', async () => {
  const path = 'src-tauri/src/lan/fixtures/';
  const [cert, key, root] = await Promise.all(
    ['loopback-cert.der', 'loopback-key.der', 'loopback-root.der'].map((name) =>
      readFile(path + name),
    ),
  );
  const server = createServer(
    {
      cert: new X509Certificate(cert).toString(),
      key: createPrivateKey({ key, format: 'der', type: 'pkcs8' }).export({
        format: 'pem',
        type: 'pkcs8',
      }),
    },
    (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<title>Encrypted sharing fixture</title>');
    },
  );
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  const url = `https://127.0.0.1:${address.port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = get(url, { ca: new X509Certificate(root).toString() }, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', reject);
    });
    expect(status).toBe(200);
    browser = await chromium.launch({
      headless: true,
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    const page = await browser.newPage();
    await expect(page.goto(url, { timeout: 5000 })).rejects.toThrow(/CERT_AUTHORITY_INVALID/);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 10000);
