export interface FullscreenHost {
  apply(enabled: boolean): Promise<void>;
  changed(active: boolean): void;
}

/** Owns acknowledged presentation transitions, independently of playback. */
export function createFullscreenOwner(host: FullscreenHost) {
  let active = false;
  let closing = false;
  let disposed = false;
  let generation = 0;
  let pending = 0;
  let needsDisable = false;
  let queue: Promise<void> = Promise.resolve();
  let toggling: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  const publish = (next: boolean): void => {
    if (disposed || next === active) return;
    active = next;
    host.changed(next);
  };
  const enqueue = (enabled: boolean, force = false): Promise<void> => {
    if (disposed || (closing && enabled))
      return Promise.reject(new Error('Full screen changes are closed.'));
    pending++;
    const work = queue.then(async () => {
      if (disposed || (closing && enabled)) throw new Error('Full screen changes are closed.');
      if (!force && active === enabled && !(needsDisable && !enabled)) return;
      const epoch = generation;
      if (enabled) needsDisable = true;
      await host.apply(enabled);
      if (!enabled) needsDisable = false;
      if (epoch === generation) publish(enabled);
    });
    const settled = work.finally(() => {
      pending--;
    });
    queue = settled.catch(() => undefined);
    return settled;
  };
  return {
    get active() {
      return active;
    },
    get busy() {
      return pending > 0;
    },
    set(enabled: boolean): Promise<void> {
      return enqueue(enabled);
    },
    toggle(): Promise<void> {
      if (toggling) return toggling;
      const work = enqueue(!active);
      toggling = work.finally(() => {
        if (toggling === settled) toggling = null;
      });
      const settled = toggling;
      return settled;
    },
    nativeExited(): void {
      if (disposed) return;
      generation++;
      publish(false);
    },
    close(): Promise<void> {
      closing = true;
      if (closePromise) return closePromise;
      if (disposed)
        return Promise.reject(new Error('Full screen owner was disposed before cleanup.'));
      // Always confirm false, including an entry whose acknowledgment was fenced.
      const work = enqueue(false, true);
      const settled = work.catch((error: unknown) => {
        if (closePromise === settled) closePromise = null;
        throw error;
      });
      closePromise = settled;
      return settled;
    },
    dispose(): void {
      disposed = closing = true;
      generation++;
    },
  };
}
