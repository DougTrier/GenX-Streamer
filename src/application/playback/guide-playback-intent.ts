/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */

/** An intent remains busy through Guide quiescence and actual media admission. */
export interface GuidePlaybackIntent {
  prepare(): Promise<void>;
  release(): void;
}

export function createGuidePlaybackIntents(host: {
  prepare(): Promise<void>;
  wake(): void | Promise<void>;
  wakeFailed?(error: unknown): void;
}) {
  let pending = 0;
  let failure: { error: unknown } | null = null;
  return {
    get pending(): number {
      return pending;
    },
    begin(): GuidePlaybackIntent {
      pending++;
      let released = false;
      let work: Promise<void> | undefined;
      return {
        prepare() {
          if (released) return Promise.reject(new DOMException('Playback canceled.', 'AbortError'));
          if (failure) return Promise.reject(failure.error);
          return (work ??= Promise.resolve().then(async () => {
            if (failure) throw failure.error;
            try {
              await host.prepare();
            } catch (error) {
              failure ??= { error };
            }
            // Concurrent admissions cannot override an unconfirmed cleanup result.
            if (failure) throw failure.error;
          }));
        },
        release() {
          if (released) return;
          released = true;
          pending--;
          void Promise.resolve()
            .then(() => {
              if (failure) throw failure.error;
              return host.wake();
            })
            .catch((error: unknown) => {
              failure ??= { error };
              try {
                host.wakeFailed?.(failure.error);
              } catch {
                // Guide ownership retains the original failure; a failed notice cannot detach it.
              }
            });
        },
      };
    },
  };
}
