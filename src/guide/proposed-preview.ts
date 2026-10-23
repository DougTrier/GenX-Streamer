import { invoke, isTauri } from '@tauri-apps/api/core';
import { boundedUtf8Text } from '../platform/bounded-text';
import type { GuidePreview } from './native';

/** This API alone admits a memory-only revision-zero preview. */
export interface ProposedGuidePreview extends GuidePreview {
  proposed: true;
  sourceRevision: 0;
}
const invalid = () => new Error('The proposed program guide preview is invalid.');
const opaque = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v);
const instant = (v: unknown) =>
  v === null ||
  (Number.isSafeInteger(v) &&
    (v as number) >= -62_135_647_200_000 &&
    (v as number) <= 253_402_351_200_000);
export function validateProposedGuidePreview(
  value: unknown,
  sourceId: string,
): ProposedGuidePreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const keys = [
    'ticket',
    'sourceId',
    'sourceRevision',
    'channels',
    'programs',
    'firstStartMs',
    'lastStartMs',
    'lastKnownStopMs',
    'proposed',
  ];
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((k) => {
      const field = Object.getOwnPropertyDescriptor(value, k);
      return !field || !('value' in field);
    })
  )
    throw invalid();
  const row = value as Record<string, unknown>;
  if (
    !opaque(row.ticket) ||
    row.sourceId !== sourceId ||
    row.sourceRevision !== 0 ||
    row.proposed !== true ||
    !Number.isSafeInteger(row.channels) ||
    (row.channels as number) < 0 ||
    (row.channels as number) > 100000 ||
    !Number.isSafeInteger(row.programs) ||
    (row.programs as number) < 0 ||
    (row.programs as number) > 500000 ||
    ![row.firstStartMs, row.lastStartMs, row.lastKnownStopMs].every(instant) ||
    (row.programs === 0
      ? row.firstStartMs !== null || row.lastStartMs !== null || row.lastKnownStopMs !== null
      : row.channels === 0 ||
        row.firstStartMs === null ||
        row.lastStartMs === null ||
        (row.firstStartMs as number) > (row.lastStartMs as number)) ||
    (row.lastKnownStopMs !== null &&
      row.firstStartMs !== null &&
      (row.lastKnownStopMs as number) <= (row.firstStartMs as number))
  )
    throw invalid();
  return { ...row } as unknown as ProposedGuidePreview;
}

export async function previewProposedNativeGuide(
  location: string,
  name: string,
  signal: AbortSignal,
  adoptTicket: (ticket: string) => void,
): Promise<ProposedGuidePreview> {
  signal.throwIfAborted();
  if (!isTauri()) throw new Error('Program guide storage requires the installed app.');
  if (
    !boundedUtf8Text(location, 16384) ||
    !boundedUtf8Text(name, 512) ||
    !name.trim() ||
    /[\p{Cc}]/u.test(name) ||
    /[\s\\\p{Cc}]/u.test(location)
  )
    throw invalid();
  const url = new URL(location);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw invalid();
  const sourceId = crypto.randomUUID(),
    requestId = crypto.randomUUID();
  let cancellation: Promise<unknown> | null = null;
  const cancel = () => {
    cancellation = invoke('cancel_playlist', { requestId });
    void cancellation.catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const raw = await invoke<unknown>('guide_preview_proposed_source', {
      source: {
        id: sourceId,
        name,
        location,
        kind: 'url',
        allowHttp: false,
        revision: 0,
        updatedMs: null,
      },
      requestId,
    });
    if (raw && typeof raw === 'object') {
      const field = Object.getOwnPropertyDescriptor(raw, 'ticket');
      if (field && 'value' in field && opaque(field.value)) adoptTicket(field.value);
    }
    const result = validateProposedGuidePreview(raw, sourceId);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    let cleanupError: unknown = null;
    if (!cancellation) cancel();
    try {
      await cancellation;
    } catch (failure) {
      cleanupError ??= failure;
    }
    if (cleanupError !== null) throw cleanupError;
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
