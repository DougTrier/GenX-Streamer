export interface SourceSnapshotPreparationProgress {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly rootGeneration: string;
  readonly preparedCandidates: number;
  readonly totalCandidates: number;
  readonly phase: 'preparing' | 'sealing';
}
/** A small closed event protocol. No source identities, URLs or channel metadata. */
export function validateSourceSnapshotPreparationProgress(
  raw: unknown,
): SourceSnapshotPreparationProgress {
  const keys = [
    'schemaVersion',
    'requestId',
    'rootGeneration',
    'preparedCandidates',
    'totalCandidates',
    'phase',
  ];
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    throw new Error('Invalid preparation progress.');
  const own = Reflect.ownKeys(raw);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw new Error('Invalid preparation progress.');
  const value: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
      throw new Error('Invalid preparation progress.');
    value[key] = descriptor.value;
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(value.requestId) ||
    typeof value.rootGeneration !== 'string' ||
    !/^(0|[1-9][0-9]{0,19})$/u.test(value.rootGeneration) ||
    BigInt(value.rootGeneration) > 18446744073709551615n ||
    !Number.isSafeInteger(value.preparedCandidates) ||
    !Number.isSafeInteger(value.totalCandidates) ||
    (value.preparedCandidates as number) < 0 ||
    (value.totalCandidates as number) > 100_000 ||
    (value.preparedCandidates as number) > (value.totalCandidates as number) ||
    !['preparing', 'sealing'].includes(value.phase as string) ||
    (value.phase === 'sealing' && value.preparedCandidates !== value.totalCandidates)
  )
    throw new Error('Invalid preparation progress.');
  return Object.freeze(value) as unknown as SourceSnapshotPreparationProgress;
}
