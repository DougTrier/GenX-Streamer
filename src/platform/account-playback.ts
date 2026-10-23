import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { boundedUtf8Text } from './bounded-text';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';

export interface AccountPlaybackRequest {
  schemaVersion: 1;
  accountId: string;
  expectedAccountRevision: string;
  expectedMediaRevision: string;
  streamReference: string;
}
/** The URL is a temporary local capability. Never persist, log, export or share it. */
export interface AccountPlaybackReceipt {
  schemaVersion: 1;
  sessionGeneration: string;
  mediaUrl: string;
  /** Stream format from the upstream extension, so the player skips a format check. */
  mediaHint?: 'hls' | 'mpegts' | 'file';
  /** The provider's other advertised format is stored for this channel (try once). */
  alternateAvailable?: true;
}
/** A provider movie or series episode (numeric provider id and file extension). */
export interface AccountVodPlayRequest {
  schemaVersion: 1;
  accountId: string;
  expectedRevision: string;
  kind: 'movie' | 'episode';
  itemId: string;
  extension: string;
}
export interface AccountPlaybackStopReceipt {
  schemaVersion: 1;
  stopped: true;
  sessionGeneration: string;
}

const invalid = () => new Error('The account playback request or response is invalid.');
const cleanupFailed = () =>
  new Error('Account playback cleanup could not finish. Retry stopping playback.');
const canceled = () => new DOMException('Account playback was canceled.', 'AbortError');
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    throw invalid();
  return row;
}
function opaque(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value);
}
function revision(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
function generation(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,19}$/u.test(value) &&
    BigInt(value) <= 18446744073709551615n
  );
}
function request(value: AccountPlaybackRequest): AccountPlaybackRequest {
  const row = record(value, [
    'schemaVersion',
    'accountId',
    'expectedAccountRevision',
    'expectedMediaRevision',
    'streamReference',
  ]);
  if (
    row.schemaVersion !== 1 ||
    !opaque(row.accountId) ||
    !revision(row.expectedAccountRevision) ||
    !revision(row.expectedMediaRevision) ||
    !opaque(row.streamReference)
  )
    throw invalid();
  return {
    schemaVersion: 1,
    accountId: row.accountId,
    expectedAccountRevision: row.expectedAccountRevision,
    expectedMediaRevision: row.expectedMediaRevision,
    streamReference: row.streamReference,
  };
}
function capability(value: unknown): value is string {
  if (!boundedUtf8Text(value, 1024) || /[\p{Cc}\p{White_Space}?#]/u.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    /^[1-9][0-9]{0,4}$/u.test(url.port) &&
    Number(url.port) <= 65535 &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.href === value &&
    /^\/account\/[a-f0-9]{64}\/media\/[a-f0-9]{64}$/u.test(url.pathname)
  );
}
export function validateAccountPlaybackReceipt(value: unknown): AccountPlaybackReceipt {
  const has = (key: string) =>
    !!value && typeof value === 'object' && Object.hasOwn(value as object, key);
  const hinted = has('mediaHint');
  const alternate = has('alternateAvailable');
  const row = record(value, [
    'schemaVersion',
    'sessionGeneration',
    'mediaUrl',
    ...(hinted ? ['mediaHint'] : []),
    ...(alternate ? ['alternateAvailable'] : []),
  ]);
  if (
    row.schemaVersion !== 1 ||
    !generation(row.sessionGeneration) ||
    !capability(row.mediaUrl) ||
    (hinted && !['hls', 'mpegts', 'file'].includes(row.mediaHint as string)) ||
    (alternate && row.alternateAvailable !== true)
  )
    throw invalid();
  return {
    schemaVersion: 1,
    sessionGeneration: row.sessionGeneration,
    mediaUrl: row.mediaUrl,
    ...(hinted ? { mediaHint: row.mediaHint as 'hls' | 'mpegts' | 'file' } : {}),
    ...(alternate ? { alternateAvailable: true as const } : {}),
  };
}
export function validateAccountPlaybackStopReceipt(
  value: unknown,
  expectedGeneration: string,
): AccountPlaybackStopReceipt {
  if (!generation(expectedGeneration)) throw invalid();
  const row = record(value, ['schemaVersion', 'stopped', 'sessionGeneration']);
  if (
    row.schemaVersion !== 1 ||
    row.stopped !== true ||
    row.sessionGeneration !== expectedGeneration
  )
    throw invalid();
  return { schemaVersion: 1, stopped: true, sessionGeneration: expectedGeneration };
}

/** Subscribe to native "provider busy" notices; each carries only a session number. */
export type AccountPlaybackBusyListen = (
  callback: (sessionGeneration: string) => void,
) => Promise<() => void>;
export const listenAccountPlaybackBusy: AccountPlaybackBusyListen = async (callback) => {
  if (!isTauri()) return () => undefined;
  return listen<unknown>('account-playback-busy', (event) => {
    if (generation(event.payload)) callback(event.payload);
  });
};
export function createAccountPlayback(runtime?: OwnedNativeRuntime) {
  const native = runtime ?? {
    invoke: (command: string, args?: Record<string, unknown>) => {
      if (!isTauri())
        return Promise.reject(new Error('Account playback requires the installed application.'));
      return invoke(command, args);
    },
  };
  // Retain only cleanup identities. A failed stop must remain retryable even if
  // its startup was canceled before a media URL could reach the player owner.
  const pendingCleanup = new Set<string>();
  const stops = new Map<string, Promise<AccountPlaybackStopReceipt>>();
  function stop(
    sessionGeneration: string,
    signal?: AbortSignal,
  ): Promise<AccountPlaybackStopReceipt> {
    // Cleanup has already been authorized by the owning session; abort cannot detach it.
    void signal;
    if (!generation(sessionGeneration)) return Promise.reject(invalid());
    const existing = stops.get(sessionGeneration);
    if (existing) return existing;
    pendingCleanup.add(sessionGeneration);
    const work = Promise.resolve()
      .then(() => native.invoke('stop_iptv_playback', { sessionGeneration }))
      .then((value) => {
        const receipt = validateAccountPlaybackStopReceipt(value, sessionGeneration);
        pendingCleanup.delete(sessionGeneration);
        return receipt;
      })
      .catch(() => {
        throw cleanupFailed();
      })
      .finally(() => {
        if (stops.get(sessionGeneration) === work) stops.delete(sessionGeneration);
      });
    stops.set(sessionGeneration, work);
    return work;
  }
  async function retryCleanup(): Promise<void> {
    const outcomes = await Promise.allSettled([...pendingCleanup].map((id) => stop(id)));
    if (outcomes.some((outcome) => outcome.status === 'rejected')) throw cleanupFailed();
  }
  function vodRequest(value: AccountVodPlayRequest): AccountVodPlayRequest {
    if (
      value?.schemaVersion !== 1 ||
      !opaque(value.accountId) ||
      !revision(value.expectedRevision) ||
      (value.kind !== 'movie' && value.kind !== 'episode') ||
      !/^[0-9]{1,32}$/u.test(value.itemId) ||
      // Empty: the provider listed no container; native resolves it or refuses.
      !/^(?:[a-z0-9]{2,5})?$/u.test(value.extension)
    )
      throw invalid();
    return {
      schemaVersion: 1,
      accountId: value.accountId,
      expectedRevision: value.expectedRevision,
      kind: value.kind,
      itemId: value.itemId,
      extension: value.extension,
    };
  }
  return {
    stop,
    retryCleanup,
    async start(
      input: AccountPlaybackRequest | { vod: AccountVodPlayRequest },
      signal?: AbortSignal,
      options?: { alternate?: boolean },
    ): Promise<AccountPlaybackReceipt> {
      const vod = 'vod' in input;
      const admitted = vod ? vodRequest(input.vod) : request(input);
      if (signal?.aborted) throw canceled();
      await retryCleanup();
      if (signal?.aborted) throw canceled();
      let startedGeneration: string | null = null;
      try {
        return await invokeOwnedNative(
          native,
          vod ? 'start_iptv_vod_playback' : 'start_iptv_playback',
          // Live only: the provider's other stored format, asked for once by the player.
          { request: admitted, ...(!vod && options?.alternate ? { alternate: true } : {}) },
          {
            signal,
            validate: (value) => {
              // Capture allocation identity before URL validation and before the
              // owned helper checks a late abort. Either failure must stop this allocation.
              if (value && typeof value === 'object' && !Array.isArray(value)) {
                const prototype = Object.getPrototypeOf(value);
                const row = value as Record<string, unknown>;
                if (
                  (prototype === Object.prototype || prototype === null) &&
                  Object.hasOwn(row, 'schemaVersion') &&
                  Object.hasOwn(row, 'sessionGeneration') &&
                  row.schemaVersion === 1 &&
                  generation(row.sessionGeneration)
                )
                  startedGeneration = row.sessionGeneration;
              }
              return validateAccountPlaybackReceipt(value);
            },
          },
        );
      } catch (error) {
        if (startedGeneration !== null) await stop(startedGeneration);
        if (signal?.aborted) throw canceled();
        // Native command errors are already redacted by invokeOwnedNative.
        throw error;
      }
    },
  };
}
