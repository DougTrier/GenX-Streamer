/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  AUDIO_HEALTH_CHANGE,
  readAudioHealth,
  type AudioHealthSnapshot,
} from '../platform/browser-audio-health';
import type { DiagnosticInput } from '../diagnostics/events';

/** One fixed warning per attachment. Never trusts event payloads or interrupts playback. */
export function installAudioDiagnostics(
  video: HTMLVideoElement,
  host: {
    emit(event: DiagnosticInput): Promise<boolean>;
    read?(video: HTMLVideoElement): Readonly<AudioHealthSnapshot> | null;
  },
) {
  let closed = false,
    reported = false;
  const pending = new Set<Promise<unknown>>();
  const observe = () => {
    if (closed) return;
    const health = (host.read ?? readAudioHealth)(video);
    if (!health || health.faults.length === 0) {
      reported = false;
      return;
    }
    if (reported) return;
    reported = true;
    const work = Promise.resolve()
      .then(() =>
        host.emit({ operation: 'playback', level: 'warning', code: 'playback-audio-warning' }),
      )
      .catch(() => false);
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  video.addEventListener(AUDIO_HEALTH_CHANGE, observe);
  return {
    async dispose(): Promise<void> {
      if (!closed) {
        closed = true;
        video.removeEventListener(AUDIO_HEALTH_CHANGE, observe);
      }
      await Promise.all([...pending]);
    },
  };
}
