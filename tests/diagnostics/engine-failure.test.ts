// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { createEngineWarningTrace, engineFailureFacts } from '../../src/diagnostics/engine-failure';
it('distinguishes timeout, early EOF, HTTP and MSE evidence without exporting library messages', () => {
  expect(engineFailureFacts('mpegts', 'UnrecoverableEarlyEof').code).toBe('upstream-eof');
  expect(engineFailureFacts('mpegts', 'ConnectingTimeout').code).toBe('timeout');
  expect(
    engineFailureFacts('mpegts', 'HttpStatusCodeInvalid', {
      code: 503,
      msg: 'https://user:secret@provider.invalid/token',
    }),
  ).toEqual({ transport: 'mpegts', detail: 'http-status', code: 'network', httpStatus: 503 });
  expect(engineFailureFacts('mpegts', 'MediaMSEError').detail).toBe('mse-error');
  expect(engineFailureFacts('html5', 3).mediaErrorCode).toBe(3);
  const report = JSON.stringify(
    engineFailureFacts('mpegts', 'https://secret.invalid', { code: 999999, msg: 'password' }),
  );
  expect(report).not.toMatch(/secret|password|999999/);
});

it('retains bounded nonfatal recovery evidence before a watchdog failure', () => {
  let at = 100;
  const trace = createEngineWarningTrace(() => at);
  expect(trace('bufferSeekOverHole')?.detail).toBe('buffer-gap');
  expect(trace('bufferSeekOverHole')).toBeNull();
  expect(trace('bufferNudgeOnStall')?.detail).toBe('buffer-nudge');
  for (let i = 0; i < 100; i++) {
    const facts = trace(`https://secret.invalid/${i}`, { msg: 'password' });
    if (facts) expect(facts.detail).toBe('unknown');
  }
  at += 10_000;
  expect(trace('bufferSeekOverHole')?.detail).toBe('buffer-gap');
});

it('separates frozen appends from unchanged upstream playlists without assigning generic faults to the network', () => {
  expect(engineFailureFacts('hls', 'bufferAppendNoProgress')).toMatchObject({
    detail: 'mse-no-progress',
    code: 'decode',
  });
  expect(engineFailureFacts('hls', 'playlistUnchangedError').detail).toBe('playlist-unchanged');
  expect(engineFailureFacts('hls', 'internalException').code).toBe('unknown');
  expect(engineFailureFacts('hls', 'unrecognized').code).toBe('unknown');
});
