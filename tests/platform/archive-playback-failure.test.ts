import { expect, it } from 'vitest';
import {
  createArchivePlayback,
  ArchivePlaybackFailureError,
  ArchivePlaybackCleanupError,
  archivePlaybackFailureGuidance,
} from '../../src/platform/archive-playback';
const request = { schemaVersion: 1 as const, fileRef: 'a'.repeat(64), expectedRevision: '1' };
const cases = [
  ['archive-proxy-url-refused', 'destination'],
  ['archive-proxy-host-unverified', 'destination'],
  ['archive-proxy-path-unverified', 'path'],
  ['archive-file-route-unverified', 'path'],
  ['archive-proxy-dns-private', 'dns'],
  ['archive-proxy-dns-address-limit', 'dns'],
  ['archive-proxy-dns', 'dns'],
  ['archive-proxy-response-encoding-unverified', 'encoding'],
  ['archive-media-format-unverified', 'format'],
  ['archive-media-container-unverified', 'format'],
  ['archive-media-range-unverified', 'range'],
  ['archive-media-access-refused', 'access'],
  ['archive-media-rate-limited', 'rate-limit'],
  ['archive-proxy-timeout', 'network'],
  ['archive-media-unavailable', 'network'],
  ['archive-file-changed', 'stale'],
  ['archive-revision-stale', 'stale'],
  ['archive-file-unavailable', 'unavailable'],
  ['archive-proxy-work-join-failed', 'cleanup'],
  ['public-archive-audio-codec-unsupported', 'codec'],
  ['public-archive-inspection-limit', 'inspection'],
  ['public-archive-contact-required', 'configuration'],
  ['public-archive-range-unverified', 'range'],
  ['public-archive-access-refused', 'access'],
  ['public-archive-file-changed', 'stale'],
  ['public-archive-container-changed', 'stale'],
  ['public-archive-server-unavailable', 'network'],
] as const;
it.each(cases)(
  'exact native %s maps to sanitized %s without private causes',
  async (code, category) => {
    const playback = createArchivePlayback({
      invoke: async () => {
        throw code;
      },
    });
    const error = await playback.start(request).catch((error) => error);
    expect(error).toBeInstanceOf(ArchivePlaybackFailureError);
    expect(error.category).toBe(category);
    expect(error.code).toBe(code);
    expect(error.cause).toBeUndefined();
    expect(archivePlaybackFailureGuidance(error)).not.toContain('://');
    expect(archivePlaybackFailureGuidance(error)).not.toContain('removed');
  },
);
it.each([
  'archive-proxy-url-refused https://fixture.invalid/private',
  ' archive-media-access-refused',
  { code: 'archive-media-access-refused', message: 'private' },
  Error('archive-media-access-refused'),
])('unknown or forged native payload stays generic', async (raw) => {
  const playback = createArchivePlayback({
    invoke: async () => {
      throw raw;
    },
  });
  const error = await playback.start(request).catch((error) => error);
  expect(error.category).toBe('unknown');
  expect(error.code).toBe('unknown');
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain('private');
  expect(archivePlaybackFailureGuidance(Object.create(ArchivePlaybackFailureError.prototype))).toBe(
    'This Archive file could not open. Choose another file or retry.',
  );
});
it('cancellation joins original and exact cancel, with cleanup failure taking priority', async () => {
  let reject!: (value: unknown) => void;
  let releaseCancel!: () => void;
  const original = new Promise((_resolve, no) => (reject = no)),
    cancel = new Promise<void>((yes) => (releaseCancel = yes));
  const calls: string[] = [];
  const playback = createArchivePlayback({
    idFactory: () => 'exact-request',
    invoke: async (command, args) => {
      calls.push(command);
      if (command === 'cancel_playlist') {
        expect(args?.requestId).toBe('exact-request');
        await cancel;
        throw Error('private cancellation details');
      }
      return original;
    },
  });
  const controller = new AbortController();
  let settled = false;
  const pending = playback.start(request, controller.signal).catch((error) => {
    settled = true;
    return error;
  });
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await Promise.resolve();
  reject('archive-media-access-refused');
  await Promise.resolve();
  expect(settled).toBe(false);
  releaseCancel();
  expect(await pending).toBeInstanceOf(ArchivePlaybackCleanupError);
  expect(calls).toEqual(['start_archive_playback', 'cancel_playlist']);
});
