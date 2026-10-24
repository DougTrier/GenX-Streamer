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
/**
 * Install on TV (Pass It Along; docs/send-to-tv.md): one card, one screen
 * (TV-005). Three short steps until it starts, then only the current action
 * and one button. GenX finds the TV, pairs with the code the TV shows, sends
 * the right file and opens it on the TV; the person approves on the TV.
 */
import {
  connectTv,
  disconnectTv,
  findTvs,
  finishPairing,
  forgetTvs,
  openGenXOnTv,
  openHelperStore,
  readTvStatus,
  sendGenX,
  startPairing,
  tvFailureCode,
  type FoundTv,
} from '../../platform/tv-remote';
import { nearbyStatus, stopNearby } from '../../platform/nearby-share';
import {
  finishedSteps,
  observe,
  sent,
  stepText,
  tvFailure,
  type TvWatch,
} from '../../sharing/tv-install';

const POLL_MS = 1000;

export function mountSendToTv(card: HTMLElement): {
  activate: (allowed: Promise<boolean>) => void;
  dispose: () => void;
} {
  card.hidden = true;
  card.innerHTML = `
    <h3>Install on TV</h3>
    <ol class="tv-steps">
      <li>Pick your TV.</li>
      <li>Enter the code shown on your TV.</li>
      <li>Approve on your TV.</li>
    </ol>
    <p class="tv-now" role="status" aria-live="polite" hidden></p>
    <div class="tv-list" hidden></div>
    <form class="tv-code" hidden>
      <input type="text" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false"
        maxlength="6" aria-label="Code shown on your TV" />
      <button type="submit" class="primary">Pair</button>
    </form>
    <div class="tv-buttons">
      <button type="button" class="tv-go primary">Install on TV</button>
      <button type="button" class="tv-stop" hidden>Stop</button>
    </div>
    <button type="button" class="tv-forget">Forget paired TVs</button>`;
  const steps = card.querySelector<HTMLElement>('.tv-steps')!;
  const now = card.querySelector<HTMLElement>('.tv-now')!;
  const list = card.querySelector<HTMLElement>('.tv-list')!;
  const form = card.querySelector<HTMLFormElement>('.tv-code')!;
  const code = form.querySelector<HTMLInputElement>('input')!;
  const go = card.querySelector<HTMLButtonElement>('.tv-go')!;
  const stop = card.querySelector<HTMLButtonElement>('.tv-stop')!;
  const forget = card.querySelector<HTMLButtonElement>('.tv-forget')!;
  let disposed = false;
  let run = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startedNearby = false;
  let connected = false;

  /** Shows one line in place of the steps; `button` is the one action offered. */
  function say(line: string, button: 'none' | 'stop' | 'retry' | 'done'): void {
    if (disposed) return;
    steps.hidden = true;
    forget.hidden = true;
    now.hidden = false;
    now.textContent = line;
    go.hidden = button !== 'retry' && button !== 'done';
    go.textContent = button === 'done' ? 'Done' : 'Try Again';
    stop.hidden = button !== 'stop';
  }

  function idle(): void {
    steps.hidden = false;
    forget.hidden = false;
    now.hidden = true;
    list.hidden = true;
    form.hidden = true;
    go.hidden = false;
    go.textContent = 'Install on TV';
    stop.hidden = true;
  }

  /** Ends the connection and the nearby share GenX started for this. */
  async function finish(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    if (connected) await disconnectTv().catch(() => undefined);
    connected = false;
    if (startedNearby) await stopNearby().catch(() => undefined);
    startedNearby = false;
  }

  async function fail(error: unknown, mine: number): Promise<void> {
    if (mine !== run) return;
    await finish();
    list.hidden = true;
    form.hidden = true;
    say(tvFailure(tvFailureCode(error)), 'retry');
  }

  async function watch(mine: number, state: TvWatch): Promise<void> {
    if (mine !== run || disposed) return;
    try {
      const status = await readTvStatus();
      const nearby = await nearbyStatus();
      const next = observe(state, status.connected, status.frontApp, nearby.checkIn, Date.now());
      if (next.action === 'get-helper') await openHelperStore();
      if (next.action === 'send') await sendGenX();
      if (next.action === 'open-genx') await openGenXOnTv();
      const step = next.watch.step;
      const ended = finishedSteps.includes(step);
      const downloaded = nearby.completed > 0;
      if (mine !== run) return;
      say(stepText(step, downloaded), step === 'done' ? 'done' : ended ? 'retry' : 'stop');
      if (ended) {
        await finish();
        return;
      }
      timer = setTimeout(() => void watch(mine, next.watch), POLL_MS);
    } catch (error) {
      await fail(error, mine);
    }
  }

  async function send(mine: number): Promise<void> {
    say('Sending GenX Streamer…', 'stop');
    startedNearby = !(await nearbyStatus()).active;
    const before = await readTvStatus();
    await sendGenX();
    void watch(mine, sent(before.frontApp, Date.now()));
  }

  async function pick(tv: FoundTv, mine: number): Promise<void> {
    list.hidden = true;
    say('Finding your TV…', 'stop');
    try {
      await connectTv(tv);
      connected = true;
    } catch (error) {
      if (tvFailureCode(error) !== 'tv-not-paired') throw error;
      await startPairing(tv);
      if (mine !== run) return;
      say('Enter the code shown on your TV.', 'stop');
      form.hidden = false;
      code.value = '';
      code.focus();
      form.onsubmit = (event) => {
        event.preventDefault();
        void (async () => {
          try {
            await finishPairing(code.value);
            form.hidden = true;
            say('Finding your TV…', 'stop');
            await connectTv(tv);
            connected = true;
            await send(mine);
          } catch (failure) {
            // A mistyped code can be typed again while the TV still shows it.
            if (tvFailureCode(failure) === 'tv-pair-wrong-code' && mine === run) {
              now.textContent = "That code didn't match. Enter the code shown on your TV.";
              code.select();
              return;
            }
            await fail(failure, mine);
          }
        })();
      };
      return;
    }
    await send(mine);
  }

  async function start(): Promise<void> {
    const mine = ++run;
    await finish();
    form.hidden = true;
    say('Finding your TV…', 'stop');
    try {
      const tvs = await findTvs();
      if (mine !== run) return;
      if (tvs.length === 0) {
        say("Couldn't find a TV on this Wi-Fi.", 'retry');
        return;
      }
      if (tvs.length === 1) {
        await pick(tvs[0], mine);
        return;
      }
      now.textContent = 'Pick your TV.';
      list.replaceChildren(
        ...tvs.map((tv) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = tv.name;
          button.addEventListener('click', () => void pick(tv, mine).catch((e) => fail(e, mine)));
          return button;
        }),
      );
      list.hidden = false;
    } catch (error) {
      await fail(error, mine);
    }
  }

  go.addEventListener('click', () => {
    if (go.textContent === 'Done') {
      run += 1;
      idle();
      return;
    }
    void start();
  });
  stop.addEventListener('click', () => {
    run += 1;
    void finish().then(idle);
  });
  forget.addEventListener('click', () => {
    void forgetTvs().then(
      () => {
        forget.textContent = 'Paired TVs forgotten';
        forget.disabled = true;
      },
      () => undefined,
    );
  });

  return {
    activate(allowed) {
      void allowed.then((yes) => {
        if (!disposed) card.hidden = !yes;
      });
    },
    dispose() {
      disposed = true;
      run += 1;
      void finish();
    },
  };
}
