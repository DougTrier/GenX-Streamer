import { classifySettledNativeWriteFailure } from './native-write-refusal';

export interface OwnedNativeRuntime {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  idFactory?: () => string;
}
/** Await the actual command AND cancellation command; abort never detaches work. */
export async function invokeOwnedNative<T>(
  runtime: OwnedNativeRuntime,
  command: string,
  args: Record<string, unknown>,
  options: {
    signal?: AbortSignal;
    validate(value: unknown): T;
    durable?: boolean;
    ignoreCancellationFailure?: boolean;
    failure?(error: unknown): never;
    abortMessage?: string;
  },
): Promise<T> {
  options.signal?.throwIfAborted();
  const requestId = (runtime.idFactory ?? (() => crypto.randomUUID()))();
  let cancellation: Promise<void> | undefined,
    cancellationFailed = false;
  const cancel = () => {
    cancellation ??= Promise.resolve()
      .then(() => runtime.invoke('cancel_playlist', { requestId }))
      .then(
        () => undefined,
        () => {
          cancellationFailed = true;
        },
      );
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  let result: unknown,
    failure: unknown,
    failed = false;
  try {
    result = await runtime.invoke(command, { ...args, requestId });
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    await cancellation;
  }
  if (failed) {
    if (cancellationFailed && !options.ignoreCancellationFailure)
      throw new Error('Native command cancellation could not be confirmed.');
    const refusal = options.durable ? classifySettledNativeWriteFailure(command, failure) : null;
    if (refusal) {
      if (options.failure) return options.failure(refusal);
      throw refusal;
    }
    if (options.signal?.aborted)
      throw new DOMException(options.abortMessage ?? 'Native command canceled.', 'AbortError');
    if (options.failure) return options.failure(failure);
    throw new Error('Native command could not finish.');
  }
  // A validator accepting durable:true must require an actual COMMIT receipt.
  // That receipt remains authoritative even when a late abort/cancel loses the race.
  const validated = options.validate(result);
  if (!options.durable) {
    if (cancellationFailed && !options.ignoreCancellationFailure)
      throw new Error('Native command cancellation could not be confirmed.');
    options.signal?.throwIfAborted();
  }
  return validated;
}
