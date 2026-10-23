import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  validateDiagnosticEvent,
  validateDiagnosticInput,
  validateDiagnosticPage,
  type DiagnosticInput,
  type DiagnosticPage,
} from './events';
export interface DiagnosticsTransport {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}
export function createDiagnostics(
  transport: DiagnosticsTransport = {
    invoke: (command, args) =>
      isTauri()
        ? invoke(command, args)
        : Promise.reject(new Error('Event history requires the installed application.')),
  },
) {
  let tail: Promise<void> = Promise.resolve(),
    outstanding = 0,
    closing = false;
  function admit<T>(work: () => Promise<T>): Promise<T> {
    if (closing || outstanding >= 32)
      return Promise.reject(new Error('Event history is unavailable. Retry when ready.'));
    outstanding++;
    const operation = tail.then(work);
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    void operation.then(
      () => outstanding--,
      () => outstanding--,
    );
    return operation;
  }
  return {
    async emit(input: DiagnosticInput): Promise<boolean> {
      try {
        const event = validateDiagnosticInput(input);
        await admit(async () => {
          const {
            id: _id,
            timestampMs: _time,
            ...receipt
          } = validateDiagnosticEvent(await transport.invoke('append_diagnostic_event', { event }));
          if (JSON.stringify(receipt) !== JSON.stringify(event))
            throw new Error('Event history receipt is invalid.');
        });
        return true;
      } catch {
        return false;
      }
    },
    read(signal: AbortSignal): Promise<DiagnosticPage> {
      return admit(async () => {
        signal.throwIfAborted();
        const result = await transport.invoke('read_diagnostic_events');
        signal.throwIfAborted();
        return validateDiagnosticPage(result);
      });
    },
    clear(signal: AbortSignal): Promise<void> {
      return admit(async () => {
        signal.throwIfAborted();
        const result = await transport.invoke('clear_diagnostic_events');
        signal.throwIfAborted();
        if (
          !result ||
          typeof result !== 'object' ||
          Array.isArray(result) ||
          Object.keys(result).length !== 1 ||
          Reflect.get(result, 'cleared') !== true
        )
          throw new Error('Event history could not be cleared. Retry when ready.');
      });
    },
    async dispose(): Promise<void> {
      closing = true;
      await tail;
    },
  };
}
