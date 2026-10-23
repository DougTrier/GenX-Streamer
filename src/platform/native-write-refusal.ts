const confirmed = new WeakSet<object>();

/** Private brand: messages, names and arbitrary errors cannot assert a noncommit receipt. */
class NativeWriteNotCommittedError extends Error {
  constructor(readonly reason: 'application-closing' | 'canceled') {
    super('The settings write was refused before publication.');
    this.name = 'NativeWriteNotCommittedError';
    confirmed.add(this);
    Object.freeze(this);
  }
}

/** Internal seam; call only after the actual native RPC and cancellation work have joined. */
export function classifySettledNativeWriteFailure(command: string, error: unknown): Error | null {
  if (
    !['write_record_receipt', 'write_record_pair'].includes(command) ||
    (error !== 'application-closing' && error !== 'canceled')
  )
    return null;
  return new NativeWriteNotCommittedError(error);
}

export function isNativeWriteNotCommittedError(error: unknown): error is Error {
  return error instanceof NativeWriteNotCommittedError && confirmed.has(error);
}
