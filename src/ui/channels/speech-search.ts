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

import type { OneShotRecognizer, SpeechResult } from '../../search/speech';

export interface SpeechSearchHost {
  recognizer: OneShotRecognizer & { finish?(): Promise<void> };
  notice(message: string): void;
  language?(): string;
  cloudConsent?(): boolean;
  saveCloudConsent?(accepted: boolean, signal?: AbortSignal): Promise<void>;
  now?(): number;
  timer?: {
    set(callback: () => void, milliseconds: number): unknown;
    clear(handle: unknown): void;
  };
}
interface Capture {
  generation: number;
  abort: AbortController;
  work: Promise<void>;
  started: boolean;
  expired: boolean;
}
/** Deliberate final transcript capture; online services require explicit consent on this device. */
export function mountSpeechSearch(
  container: HTMLElement,
  input: HTMLInputElement,
  host: SpeechSearchHost,
): {
  retarget(container: HTMLElement, input: HTMLInputElement): Promise<void>;
  revokeConsent(): Promise<void>;
  dispose(): Promise<void>;
} {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'speech-search-button';
  const microphone = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  microphone.setAttribute('viewBox', '0 0 24 24');
  microphone.setAttribute('aria-hidden', 'true');
  microphone.setAttribute('focusable', 'false');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute(
    'd',
    'M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3Zm-7-4v1a7 7 0 0 0 14 0v-1M12 19v3m-4 0h8',
  );
  microphone.append(shape);
  container.append(button);
  const now = host.now ?? Date.now;
  const timer = host.timer ?? {
    set: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let active: Capture | null = null;
  let generation = 0;
  let disposed = false;
  let disposal: Promise<void> | null = null;
  let retargetQueue: Promise<void> = Promise.resolve();
  let pendingRetargets = 0;
  let ending = false;
  let writing = false;
  let cloudConsent = false;
  let consentRevoked = false;
  const storedConsent = () => {
    try {
      return host.cloudConsent?.() === true;
    } catch {
      return false;
    }
  };
  const consent = (capture: Capture): Promise<boolean> =>
    new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-label', 'Use TV speech service');
      const heading = document.createElement('h2');
      heading.textContent = 'Use TV speech service?';
      const explanation = document.createElement('p');
      explanation.textContent =
        'Your TV speech service may send audio online. Allow it for voice searches on this device?';
      const accept = document.createElement('button');
      accept.type = 'button';
      accept.textContent = 'Use speech service';
      const refuse = document.createElement('button');
      refuse.type = 'button';
      refuse.textContent = 'Cancel';
      dialog.append(heading, explanation, accept, refuse);
      let settled = false;
      const finish = (allowed: boolean): void => {
        if (settled) return;
        settled = true;
        capture.abort.signal.removeEventListener('abort', aborted);
        accept.removeEventListener('click', accepted);
        refuse.removeEventListener('click', refused);
        dialog.removeEventListener('cancel', canceled);
        dialog.close();
        dialog.remove();
        resolve(allowed && current(capture));
      };
      const accepted = () => finish(true);
      const refused = () => finish(false);
      const aborted = () => finish(false);
      const canceled = (event: Event) => {
        event.preventDefault();
        finish(false);
      };
      accept.addEventListener('click', accepted);
      refuse.addEventListener('click', refused);
      dialog.addEventListener('cancel', canceled);
      capture.abort.signal.addEventListener('abort', aborted, { once: true });
      document.body.append(dialog);
      if (!current(capture)) finish(false);
      else {
        dialog.showModal();
        refuse.focus();
      }
    });
  function render(): void {
    const label = active
      ? ending
        ? 'Finishing voice input…'
        : 'Stop voice input'
      : 'Voice search';
    button.replaceChildren(microphone.cloneNode(true));
    button.setAttribute('aria-label', label);
    button.title = label;
    button.disabled = disposed || ending || pendingRetargets > 0;
    button.setAttribute('aria-pressed', String(active !== null));
    button.setAttribute('aria-busy', String(active !== null));
    button.dataset.state = disposed
      ? 'disposed'
      : ending
        ? 'ending'
        : active
          ? 'listening'
          : 'idle';
  }
  const current = (capture: Capture) =>
    !disposed &&
    active === capture &&
    generation === capture.generation &&
    !capture.abort.signal.aborted &&
    !document.hidden;
  function message(result: SpeechResult): string {
    if (result.status === 'no-match')
      return 'No speech was recognized. Type your search or try again.';
    if (result.status !== 'failed') return '';
    if (result.reason === 'permission-denied')
      return 'Microphone permission was declined. Type your search instead.';
    if (result.reason === 'language-unavailable')
      return 'On-device recognition for this language is unavailable. Type your search instead.';
    if (result.reason === 'timeout') return 'Voice input timed out. Type your search or try again.';
    return 'Voice input is unavailable. Type your search instead.';
  }
  async function run(capture: Capture): Promise<void> {
    let handle: unknown = null;
    try {
      if (host.cloudConsent) cloudConsent = !consentRevoked && storedConsent();
      let capability = await host.recognizer.capability();
      if (!current(capture)) return;
      if (capability.available && capability.mode === 'cloud' && !cloudConsent) {
        if (!(await consent(capture)) || !current(capture)) return;
        try {
          await host.saveCloudConsent?.(true, capture.abort.signal);
        } catch {
          if (current(capture))
            host.notice(
              'Voice search consent could not be saved. Retry voice search or type your search.',
            );
          return;
        }
        if (!current(capture)) return;
        cloudConsent = true;
        consentRevoked = false;
        capability = await host.recognizer.capability();
        if (!current(capture)) return;
      }
      if (
        !capability.available ||
        (capability.mode !== 'on-device' && capability.mode !== 'cloud')
      ) {
        host.notice('Voice search is unavailable. Type your search instead.');
        return;
      }
      const allowCloud = capability.mode === 'cloud' && cloudConsent;
      if (capability.mode === 'cloud' && !allowCloud) return;
      const deadlineMs = now() + 15000;
      handle = timer.set(() => {
        capture.expired = true;
        capture.abort.abort();
        ending = true;
        render();
        void host.recognizer
          .cancel()
          .catch(() => host.notice('Voice input cancellation could not be confirmed.'));
      }, 15000);
      if (now() >= deadlineMs) {
        capture.expired = true;
        capture.abort.abort();
        return;
      }
      capture.started = true;
      const result = await host.recognizer.recognize({
        language:
          (host.language?.() ?? document.documentElement.lang) || navigator.language || 'en-US',
        signal: capture.abort.signal,
        deadlineMs,
        allowCloud,
      });
      if (now() >= deadlineMs) {
        capture.expired = true;
        capture.abort.abort();
      }
      if (!current(capture)) return;
      if (result.status === 'final') {
        const text = result.transcript.trim();
        const bound = input.maxLength > 0 ? Math.min(512, input.maxLength) : 512;
        if (
          !text ||
          text.length > bound ||
          [...text].some((value) => value.charCodeAt(0) < 32 || value.charCodeAt(0) === 127)
        ) {
          host.notice('Voice result could not be used. Type a shorter search instead.');
          return;
        }
        input.value = text;
        writing = true;
        try {
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('speech-search-final', { bubbles: true }));
        } finally {
          writing = false;
        }
        input.focus();
        input.setSelectionRange(text.length, text.length);
      } else {
        const notice = message(result);
        if (notice) host.notice(notice);
      }
    } catch {
      if (current(capture)) host.notice('Voice input is unavailable. Type your search instead.');
    } finally {
      if (handle !== null) timer.clear(handle);
      let confirmed = true;
      {
        try {
          await host.recognizer.cancel();
        } catch {
          confirmed = false;
          host.notice('Voice input cancellation could not be confirmed.');
        }
      }
      if (active === capture && confirmed) {
        active = null;
        ending = false;
        render();
      }
      if (active === capture && !confirmed) {
        ending = true;
        render();
      }
      if (capture.expired && !disposed)
        host.notice('Voice input timed out. Type your search or try again.');
    }
  }
  async function cancel(): Promise<void> {
    const capture = active;
    if (!capture) return;
    ending = true;
    capture.abort.abort();
    render();
    let failed = false;
    try {
      await host.recognizer.cancel();
    } catch {
      failed = true;
    }
    await capture.work;
    if (failed) throw new Error('Voice input cancellation could not be confirmed.');
    // A previous failed cancellation may have left the settled capture retained.
    if (active === capture) {
      active = null;
      ending = false;
      render();
    }
  }
  const requestCancel = () => {
    void cancel().catch(() => host.notice('Voice input cancellation could not be confirmed.'));
  };
  function click(): void {
    if (disposed || ending || pendingRetargets > 0) return;
    if (active) {
      const capture = active;
      ending = true;
      render();
      if (capture.started && host.recognizer.finish)
        void host.recognizer.finish().catch(requestCancel);
      else requestCancel();
      return;
    }
    if (document.hidden) {
      host.notice('Open the app to use voice search.');
      return;
    }
    const capture: Capture = {
      generation: ++generation,
      abort: new AbortController(),
      work: Promise.resolve(),
      started: false,
      expired: false,
    };
    active = capture;
    render();
    capture.work = run(capture);
  }
  const background = () => {
    if (document.hidden) requestCancel();
  };
  const pageHide = () => {
    requestCancel();
  };
  const typed = () => {
    if (!writing) requestCancel();
  };
  button.addEventListener('click', click);
  document.addEventListener('visibilitychange', background);
  window.addEventListener('pagehide', pageHide);
  input.addEventListener('input', typed);
  render();
  return {
    retarget(nextContainer, nextInput): Promise<void> {
      if (disposed) return Promise.reject(new Error('Voice search is disposed.'));
      generation++;
      pendingRetargets++;
      active?.abort.abort();
      render();
      const work = retargetQueue.then(async () => {
        if (disposed) throw new Error('Voice search is disposed.');
        await cancel();
        if (disposed) throw new Error('Voice search is disposed.');
        // Move the existing owner only after actual recognition/cancel settlement.
        nextContainer.append(button);
        input.removeEventListener('input', typed);
        input = nextInput;
        input.addEventListener('input', typed);
      });
      const result = work.finally(() => {
        pendingRetargets--;
        render();
      });
      retargetQueue = result.catch(() => undefined);
      return result;
    },
    revokeConsent(): Promise<void> {
      cloudConsent = false;
      consentRevoked = true;
      generation++;
      return cancel();
    },
    dispose(): Promise<void> {
      if (!disposal) {
        if (!disposed) generation++;
        disposed = true;
        render();
        button.removeEventListener('click', click);
        document.removeEventListener('visibilitychange', background);
        window.removeEventListener('pagehide', pageHide);
        input.removeEventListener('input', typed);
        disposal = (async () => {
          await retargetQueue;
          await cancel();
          await host.recognizer.dispose();
          button.remove();
        })();
        const attempt = disposal;
        void attempt.catch(() => {
          if (disposal === attempt) disposal = null;
        });
      }
      return disposal;
    },
  };
}
