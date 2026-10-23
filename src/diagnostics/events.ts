export const EVENT_OPERATIONS = ['scan', 'playback', 'guide', 'storage', 'application'] as const;
export type EventOperation = (typeof EVENT_OPERATIONS)[number];
export type EventLevel = 'info' | 'warning' | 'error';
export const EVENT_CODES = {
  'scan-started': 'scan',
  'scan-paused': 'scan',
  'scan-completed': 'scan',
  'scan-catalog-changed': 'scan',
  'scan-configuration-changed': 'scan',
  'scan-cancel-unconfirmed': 'scan',
  'scan-capacity': 'scan',
  'scan-save-failed': 'scan',
  'scan-failed': 'scan',
  'playback-failed': 'playback',
  'playback-audio-warning': 'playback',
  'application-archive-loc-unavailable': 'application',
  'application-archive-nasa-unavailable': 'application',
  'application-archive-commons-unavailable': 'application',
  'application-archive-commons-identification-required': 'application',
  'guide-failed': 'guide',
  'guide-identity-unavailable': 'guide',
  'storage-failed': 'storage',
} as const;
export type EventCode = keyof typeof EVENT_CODES;
export interface DiagnosticInput {
  operation: EventOperation;
  level: EventLevel;
  code: EventCode;
  /** Bounded internal error code (lowercase token), never free text. */
  reason?: string;
  checked?: number;
  total?: number;
  published?: number;
}
export interface DiagnosticEvent extends DiagnosticInput {
  id: string;
  timestampMs: number;
}
export interface DiagnosticPage {
  schemaVersion: 1;
  events: DiagnosticEvent[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Event history response is invalid.');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Event history response is invalid.');
}
export function validateDiagnosticInput(value: unknown): DiagnosticInput {
  const input = object(value);
  exactKeys(input, ['operation', 'level', 'code', 'reason', 'checked', 'total', 'published']);
  if (
    typeof input.code !== 'string' ||
    !Object.hasOwn(EVENT_CODES, input.code) ||
    EVENT_CODES[input.code as EventCode] !== input.operation ||
    typeof input.level !== 'string' ||
    !['info', 'warning', 'error'].includes(input.level)
  )
    throw new Error('Event history entry is invalid.');
  const counts: Partial<Pick<DiagnosticInput, 'checked' | 'total' | 'published'>> = {};
  for (const key of ['checked', 'total', 'published'] as const) {
    if (Object.hasOwn(input, key)) {
      const count = input[key];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 100000)
        throw new Error('Event history count is invalid.');
      counts[key] = count;
    }
  }
  if (input.operation !== 'scan' && Object.keys(counts).length)
    throw new Error('Event history count is invalid.');
  if (
    Object.hasOwn(input, 'reason') &&
    (typeof input.reason !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(input.reason))
  )
    throw new Error('Event history entry is invalid.');
  if (
    counts.total !== undefined &&
    ((counts.checked ?? 0) > counts.total || (counts.published ?? 0) > counts.total)
  )
    throw new Error('Event history count is invalid.');
  return {
    operation: input.operation as EventOperation,
    level: input.level as EventLevel,
    code: input.code as EventCode,
    ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
    ...counts,
  };
}
export function validateDiagnosticEvent(value: unknown): DiagnosticEvent {
  const entry = object(value);
  exactKeys(entry, [
    'id',
    'timestampMs',
    'operation',
    'level',
    'code',
    'reason',
    'checked',
    'total',
    'published',
  ]);
  const { id, timestampMs, ...input } = entry;
  if (
    typeof id !== 'string' ||
    !/^[1-9]\d{0,19}$/u.test(id) ||
    typeof timestampMs !== 'number' ||
    !Number.isSafeInteger(timestampMs) ||
    timestampMs < 0 ||
    timestampMs > 8640000000000000
  )
    throw new Error('Event history identity is invalid.');
  if (BigInt(id) > 9007199254740991n) throw new Error('Event history identity is invalid.');
  return { ...validateDiagnosticInput(input), id, timestampMs };
}
export function validateDiagnosticPage(value: unknown): DiagnosticPage {
  const page = object(value);
  exactKeys(page, ['schemaVersion', 'events']);
  if (page.schemaVersion !== 1 || !Array.isArray(page.events) || page.events.length > 300)
    throw new Error('Event history page is invalid.');
  const events = page.events.map(validateDiagnosticEvent);
  for (let i = 1; i < events.length; i++)
    if (BigInt(events[i].id) <= BigInt(events[i - 1].id))
      throw new Error('Event history order is invalid.');
  return { schemaVersion: 1, events };
}
const descriptions: Record<EventCode, string> = {
  'scan-started': 'Channel scan started.',
  'scan-paused': 'Channel scan paused. Resume it from Add channels.',
  'scan-completed': 'Channel scan finished.',
  'scan-catalog-changed':
    'Your channel library changed during the scan. Select Rescan to start a fresh scan.',
  'scan-configuration-changed': 'Your source settings changed. Start a fresh scan when ready.',
  'scan-cancel-unconfirmed':
    'The channel scan could not finish stopping. Retry Stop before closing.',
  'scan-capacity': 'Channel checks reached a resource limit. Retry the scan when ready.',
  'scan-save-failed': 'Responding channels could not be saved. Retry the scan when ready.',
  'scan-failed': 'The channel scan could not finish. Open Scan and retry when ready.',
  'playback-failed': 'Playback could not continue. Retry this channel or choose another.',
  'playback-audio-warning':
    'The player reported an audio-stream warning. Video may continue while audio recovers. This does not identify the cause or confirm audible sound.',
  'application-archive-loc-unavailable':
    'Library of Congress could not finish this search. Previously saved results are retained.',
  'application-archive-nasa-unavailable':
    'NASA could not finish this search. Previously saved results are retained.',
  'application-archive-commons-unavailable':
    'Wikimedia Commons could not finish this search. Previously saved results are retained.',
  'application-archive-commons-identification-required':
    'Wikimedia Commons needs the app’s public contact configuration before online searching can be enabled. No user account is required.',
  'guide-failed': 'The program guide could not refresh. Open Guide and retry when ready.',
  'guide-identity-unavailable':
    'Some channel guide connections could not be verified online. Cached schedules and existing connections are retained.',
  'storage-failed': 'Your changes could not be saved. Retry before closing the application.',
};
export function describeDiagnosticEvent(event: DiagnosticEvent): string {
  const valid = validateDiagnosticEvent(event);
  const counts = [
    valid.checked === undefined ? '' : `${valid.checked} checked`,
    valid.total === undefined ? '' : `${valid.total} total`,
    valid.published === undefined ? '' : `${valid.published} saved responses`,
  ].filter(Boolean);
  return descriptions[valid.code] + (counts.length ? ` ${counts.join('; ')}.` : '');
}
