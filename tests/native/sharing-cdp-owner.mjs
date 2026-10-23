export class OwnedCdp {
  constructor(pid, terminate) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned CDP process.');
    if (typeof terminate !== 'function') throw new Error('Explicit owned terminator required.');
    this.pid = pid;
    this.terminate = terminate;
    this.dead = false;
  }
  stop() {
    this.dead = true;
    this.cancellation ??= Promise.resolve()
      .then(this.terminate)
      .then(
        () => {
          this.terminationConfirmed = true;
          return { confirmed: true };
        },
        () => {
          this.terminationConfirmed = false;
          return { confirmed: false };
        },
      );
    return this.cancellation;
  }
  async run(label, operation, milliseconds = 10000) {
    if (this.dead) throw new Error('INCOMPLETE_HARNESS_CDP: owner already disconnected');
    let timer;
    let expired = false;
    const pending = Promise.resolve()
      .then(operation)
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        this.timedOut = true;
        // The explicit terminator owns a bounded exact-child transport closure.
        // Observe its result even if transport rejection wins the race below.
        this.stop();
        resolve({ expired: true });
      }, milliseconds);
    });
    try {
      const result = await Promise.race([pending, deadline]);
      if (expired) {
        const cleanup = await this.cancellation;
        throw new Error(
          `INCOMPLETE_HARNESS_CDP: ${label} deadline; ${
            cleanup.confirmed ? 'owned transport closed' : 'cleanup unconfirmed'
          }`,
        );
      }
      if ('error' in result) throw result.error;
      return result.value;
    } finally {
      clearTimeout(timer);
    }
  }
  async kill() {
    const cleanup = await this.stop();
    if (!cleanup.confirmed) throw new Error('INCOMPLETE_HARNESS_CDP: cleanup unconfirmed');
  }
}
