import { createBoundedScanResumeOwner, type BoundedScanResumeHost } from './bounded-scan-resume';
import {
  validateResumeWire,
  type ResumeCall,
  type ResumeWire,
} from './bounded-scan-resume-protocol';
export interface BoundedResumeWorkerPort {
  postMessage(message: ResumeWire): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
}
/** Actual Worker endpoint; host callbacks settle only after their UI/native owner joins. */
export function attachBoundedScanResumeWorker(port: BoundedResumeWorkerPort) {
  let generation = 0,
    sequence = 0,
    started = false;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; cleanup: () => void }
  >();
  const send = (message: ResumeWire) => port.postMessage(message);
  function call(operation: ResumeCall, args: unknown[], signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new DOMException('Scan stopped.', 'AbortError'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const abort = () => send({ kind: 'cancel', generation, sequence: id });
      pending.set(id, {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', abort),
      });
      signal?.addEventListener('abort', abort, { once: true });
      send({ kind: 'call', generation, sequence: id, operation, args });
    });
  }
  const host: BoundedScanResumeHost = {
    admit: async (s) =>
      (await call('admit', [], s)) as Awaited<ReturnType<BoundedScanResumeHost['admit']>>,
    take: async (id, r, s) =>
      (await call('take', [id, r], s)) as Awaited<ReturnType<BoundedScanResumeHost['take']>>,
    probe: async (c, s, b, p) =>
      (await call('probe', [c, b, p], s)) as Awaited<ReturnType<BoundedScanResumeHost['probe']>>,
    commit: async (id, r, s) =>
      (await call('commit', [id, r], s)) as Awaited<ReturnType<BoundedScanResumeHost['commit']>>,
    defer: async (id, ids, s) => {
      await call('defer', [id, ids], s);
    },
    release: async (id, ids, s) => {
      await call('release', [id, ids], s);
    },
    close: async (id) => {
      await call('close', [id]);
    },
  };
  const owner = createBoundedScanResumeOwner(host, {
    onChange: (value) => send({ kind: 'snapshot', generation, sequence: ++sequence, value }),
  });
  port.onmessage = (event) => {
    let message: ResumeWire;
    try {
      message = validateResumeWire(event.data);
    } catch {
      throw new Error('Bounded resume worker message refused.');
    }
    if (message.kind === 'control' && !started) {
      generation = message.generation;
      started = true;
    }
    if (message.generation !== generation) return;
    if (message.kind === 'reply') {
      const target = pending.get(message.sequence);
      if (!target) throw new Error('Bounded resume worker reply refused.');
      pending.delete(message.sequence);
      target.cleanup();
      if (message.ok) target.resolve(message.value);
      else
        target.reject(
          message.failure === 'canceled'
            ? new DOMException('Scan stopped.', 'AbortError')
            : message.failure === 'admission-closed'
              ? Object.assign(new Error('Scan admission closed.'), {
                  name: 'ScanAdmissionClosedError',
                })
              : message.failure === 'callback-failed'
                ? // The host call settled with a refusal; nothing of it is still running.
                  Object.assign(new Error('Bounded scan callback failed.'), {
                    name: 'BoundedCallbackSettled',
                  })
                : new Error('Bounded scan callback failed.'),
        );
      return;
    }
    if (message.kind !== 'control') throw new Error('Bounded resume worker command refused.');
    const execute = () =>
      message.operation === 'prepare'
        ? owner.prepare()
        : message.operation === 'start'
          ? owner.start()
          : message.operation === 'suspend'
            ? owner.suspend()
            : owner.dispose();
    void Promise.resolve()
      .then(async () => await execute())
      .then(
        (value) =>
          send({
            kind: 'done',
            generation,
            sequence: message.sequence,
            ok: true,
            ...(value === undefined ? {} : { value }),
          }),
        () =>
          send({
            kind: 'done',
            generation,
            sequence: message.sequence,
            ok: false,
            failure: 'owner-failed',
          }),
      );
  };
  return { snapshot: owner.snapshot };
}
if (typeof self !== 'undefined' && typeof document === 'undefined')
  attachBoundedScanResumeWorker(self as unknown as BoundedResumeWorkerPort);
