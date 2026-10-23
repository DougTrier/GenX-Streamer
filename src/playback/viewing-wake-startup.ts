/** Holds wake transport until the actual native listener acknowledgments arrive. */
export function createWakeTransportAdmission() {
  let state: 'pending' | 'released' | 'failed' = 'pending';
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const create = () => {
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Admission can fail before a wake caller attaches; the same promise remains rejected.
    void promise.catch(() => undefined);
    return promise;
  };
  let admission = create();
  return {
    wait(): Promise<void> {
      return admission;
    },
    release(): void {
      if (state !== 'pending') return;
      state = 'released';
      resolve();
    },
    fail(): void {
      if (state !== 'pending') return;
      state = 'failed';
      reject(new Error('Native wake transport admission failed.'));
    },
    retry(): void {
      if (state !== 'failed') return;
      state = 'pending';
      admission = create();
    },
  };
}
