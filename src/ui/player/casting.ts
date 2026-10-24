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

import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  CastingController,
  type CastAdapter,
  type CastDevice,
  type CastSnapshot,
  type CastState,
} from '../../casting/controller';
import { probeKnownReceiver } from '../../casting/known-receiver';
import { createNativeCastAdapter } from '../../casting/native-adapter';
import { createConfirmedReceiver } from '../../casting/confirmed-receiver';
import { readNetworkScope, validateReceiver } from '../../casting/receiver-validation';
import type { ReceiverDetails } from '../../casting/receiver-confirmation';
import type { ChannelSelection } from '../../playback/controller';

export interface CastingUiOptions {
  available?: () => boolean;
  receivers?: ReturnType<typeof createConfirmedReceiver>;
  createAdapter?: (
    authorize: (device: CastDevice, signal: AbortSignal) => Promise<string>,
  ) => CastAdapter;
  probe?: typeof probeKnownReceiver;
  warnings?: () => Promise<string[]>;
}
export function installCasting(
  selection: () => ChannelSelection | null,
  allowHttp: (selection: ChannelSelection) => boolean,
  options: CastingUiOptions = {},
): () => Promise<void> {
  const available = () => options.available?.() !== false;
  const receivers =
    options.receivers ?? createConfirmedReceiver({ readNetworkScope, validateReceiver });
  const authorize = async (device: CastDevice, signal: AbortSignal) => {
    const capturedRevision = revision;
    if (!dialog.open || disposed || !available()) throw new Error('Casting selection expired.');
    const handle = await receivers.authorize(device, signal);
    signal.throwIfAborted();
    if (!dialog.open || disposed || !available() || revision !== capturedRevision)
      throw new Error('Casting selection expired.');
    return handle;
  };
  const controller = new CastingController(
    options.createAdapter?.(authorize) ??
      createNativeCastAdapter(allowHttp, undefined, () => false, authorize),
  );
  const dialog = document.getElementById('cast-dialog') as HTMLDialogElement;
  const body = dialog.querySelector('.dialog-body')!;
  const status = document.getElementById('cast-status')!;
  const devices = document.getElementById('cast-devices')!;
  const discover = document.getElementById('cast-discover') as HTMLButtonElement;
  const stop = document.getElementById('cast-stop') as HTMLButtonElement;
  const check = document.getElementById('cast-known-check') as HTMLButtonElement;
  const known = document.getElementById('cast-known-form')!.closest('details')!;
  const methodLabel = document.createElement('label');
  methodLabel.textContent = 'Connection method';
  const method = document.createElement('select');
  method.id = 'cast-method';
  method.setAttribute('aria-label', 'Connection method');
  for (const [value, text] of [
    ['nearby', 'Nearby TV'],
    ['venue', 'Venue instructions'],
    ['known', 'Known receiver'],
  ]) {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = text;
    method.append(item);
  }
  methodLabel.append(method);
  body.prepend(methodLabel);
  const venue = document.createElement('p');
  venue.id = 'cast-venue-instructions';
  venue.textContent =
    'Follow the pairing instructions displayed on your room or presentation TV. Once paired, choose Nearby TV and refresh. Venue pairing depends on its system; GenX cannot create a room PIN. If the venue blocks device connections, ask its staff for the supported casting method.';
  body.append(venue);
  const confirmation = document.createElement('section');
  confirmation.id = 'cast-confirmation';
  confirmation.setAttribute('aria-label', 'Confirm your TV');
  const identity = document.createElement('p');
  identity.id = 'cast-identity';
  const guidance = document.createElement('p');
  guidance.textContent =
    'Compare these details with your TV settings or the venue pairing screen. Receiver details do not prove room ownership.';
  const unknownLabel = document.createElement('label');
  unknownLabel.className = 'check';
  const unknown = document.createElement('input');
  unknown.type = 'checkbox';
  unknown.id = 'cast-unverified';
  unknownLabel.append(
    unknown,
    ' I understand this receiver identity could not be rechecked and have confirmed the intended TV myself.',
  );
  const confirm = document.createElement('button');
  confirm.id = 'cast-confirm';
  confirm.textContent = 'Confirm TV and cast';
  const forget = document.createElement('button');
  forget.id = 'cast-forget';
  forget.textContent = 'Forget receiver';
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  actions.append(confirm, forget);
  confirmation.append(identity, guidance, unknownLabel, actions);
  devices.after(confirmation);
  confirmation.hidden = true;
  let discovery: AbortController | null = null;
  let discoveryCleanup: Promise<void> = Promise.resolve();
  let revision = 0;
  let disposed = false;
  let disposal: Promise<void> | null = null;
  let confirming = false;
  const listeners: Array<() => void> = [];
  const deviceListeners: Array<() => void> = [];
  const clearDevices = (): void => {
    for (const remove of deviceListeners.splice(0)) remove();
    rows.clear();
    devices.replaceChildren();
  };
  const on = (node: EventTarget, name: string, handler: EventListener): void => {
    node.addEventListener(name, handler);
    listeners.push(() => node.removeEventListener(name, handler));
  };
  const clearSelection = (): void => {
    discovery?.abort();
    discovery = null;
    discoveryCleanup = controller.cancelDiscovery();
    revision++;
    receivers.clear();
    confirming = false;
    confirmation.hidden = true;
    unknown.checked = false;
    confirm.disabled = true;
    check.disabled = discover.disabled = false;
  };
  const begin = (): { owned: AbortController; current: number } => {
    clearSelection();
    const owned = new AbortController();
    discovery = owned;
    return { owned, current: revision };
  };
  const live = (owned: AbortController, current: number): boolean =>
    dialog.open && !disposed && available() && !owned.signal.aborted && current === revision;
  const refreshConfirm = (): void => {
    const selected = receivers.snapshot;
    confirm.disabled =
      !available() ||
      confirming ||
      !selected ||
      (selected.requiresUnverifiedAcknowledgment && !unknown.checked);
  };
  // The TV being cast to is marked in the list, with its own Stop beside it
  // (owner request, October 24, 2026).
  const rows = new Map<
    ReceiverDetails,
    { button: HTMLButtonElement; badge: HTMLSpanElement; stopButton: HTMLButtonElement }
  >();
  const castingLabel: Partial<Record<CastState, string>> = {
    connecting: 'Connecting…',
    buffering: 'Buffering…',
    playing: 'Casting',
    paused: 'Paused',
    stopping: 'Stopping…',
  };
  const isCastingTo = (device: ReceiverDetails, snapshot: CastSnapshot): boolean => {
    const active = snapshot.device as (CastDevice & Partial<ReceiverDetails>) | null;
    return (
      !!active &&
      !!snapshot.sessionId &&
      !!castingLabel[snapshot.state] &&
      (active.id === device.id ||
        (!!device.protocolReceiverId && active.protocolReceiverId === device.protocolReceiverId))
    );
  };
  const markCasting = (snapshot: CastSnapshot): void => {
    for (const [device, row] of rows) {
      const casting = isCastingTo(device, snapshot);
      row.button.setAttribute('aria-current', String(casting));
      row.badge.hidden = !casting;
      row.badge.textContent = casting ? castingLabel[snapshot.state]! : '';
      row.stopButton.hidden = !casting;
      row.stopButton.disabled = !casting || snapshot.state === 'stopping';
    }
  };
  const stopCasting = (): void => {
    clearSelection();
    void controller.stop().catch(() => {
      if (!disposed)
        status.textContent = 'The receiver has not confirmed Stop. Retry Stop casting.';
    });
  };
  const unsubscribe = controller.subscribe((snapshot) => {
    const label = castingLabel[snapshot.state];
    status.textContent =
      snapshot.error ??
      (snapshot.state === 'idle'
        ? 'Choose a channel, then select your TV.'
        : snapshot.state === 'playing'
          ? `Casting to ${snapshot.device?.name ?? 'your TV'}.`
          : `${snapshot.device?.name ?? 'Receiver'} · ${label ?? snapshot.state}`);
    stop.disabled = !snapshot.sessionId || snapshot.state === 'idle';
    markCasting(snapshot);
  });
  const addDevice = (device: ReceiverDetails): void => {
    const row = document.createElement('div');
    row.className = 'cast-device-row';
    const button = document.createElement('button');
    button.className = 'cast-device';
    const badge = document.createElement('span');
    badge.className = 'cast-device-badge';
    badge.hidden = true;
    button.append(
      badge,
      `${device.name} · ${device.model ?? (device.protocol === 'dlna' ? 'DLNA' : 'Chromecast')}${device.protocolReceiverId ? ' · ' + device.protocolReceiverId : ' · Identity unverified'}`,
    );
    const stopButton = document.createElement('button');
    stopButton.className = 'cast-device-stop';
    stopButton.textContent = 'Stop';
    stopButton.setAttribute('aria-label', `Stop casting to ${device.name}`);
    stopButton.hidden = true;
    stopButton.addEventListener('click', stopCasting);
    deviceListeners.push(() => stopButton.removeEventListener('click', stopCasting));
    row.append(button, stopButton);
    rows.set(device, { button, badge, stopButton });
    const selectDevice = () => {
      void (async () => {
        const { owned, current } = begin();
        status.textContent = 'Checking the selected TV…';
        try {
          await receivers.select(device, owned.signal);
          if (!live(owned, current)) return;
          const selected = receivers.snapshot!;
          identity.textContent = `${selected.receiver.name} · ${selected.receiver.model ?? selected.receiver.protocol} · ${selected.receiver.protocolReceiverId ?? 'Identity unavailable'}${selected.requiresUnverifiedAcknowledgment ? ' · Fresh identity unavailable' : ''}`;
          if (!selected.requiresUnverifiedAcknowledgment) {
            refreshConfirm();
            castSelected();
            return;
          }
          unknownLabel.hidden = false;
          confirmation.hidden = false;
          refreshConfirm();
          status.textContent = 'Confirm this is your intended TV before sending video.';
        } catch {
          if (live(owned, current))
            status.textContent =
              'The selected receiver could not be validated. Refresh and confirm your TV again.';
        }
      })();
    };
    button.addEventListener('click', selectDevice);
    deviceListeners.push(() => button.removeEventListener('click', selectDevice));
    devices.append(row);
    markCasting(controller.snapshot);
  };
  // Full screen hides the header: its player row offers Cast too.
  on(document.getElementById('dock-cast')!, 'click', () =>
    document.getElementById('cast-button')!.click(),
  );
  on(document.getElementById('cast-button')!, 'click', () => {
    if (!available()) return;
    dialog.showModal();
    if (method.value === 'nearby') discover.click();
  });
  on(unknown, 'change', refreshConfirm);
  /** Start casting the current channel to the selected TV. */
  const castSelected = (): void => {
    if (!available()) return;
    void (async () => {
      const channel = selection();
      if (!channel) {
        status.textContent = 'Choose a channel before casting.';
        return;
      }
      const captured = { ...channel };
      const selected = receivers.snapshot;
      if (!selected || confirm.disabled) return;
      const owned = discovery!;
      const current = revision;
      confirming = true;
      confirm.disabled = true;
      try {
        await receivers.confirm(unknown.checked, owned.signal);
        if (!live(owned, current) || !available()) return;
        await controller.start(selected.receiver, captured);
      } catch {
        if (live(owned, current))
          status.textContent = 'Casting could not start. Select your TV again.';
      } finally {
        if (live(owned, current)) {
          confirming = false;
          refreshConfirm();
        }
      }
    })();
  };
  on(confirm, 'click', castSelected);
  on(forget, 'click', () => {
    clearSelection();
    clearDevices();
    status.textContent = 'Receiver forgotten. Stop any active cast before leaving this network.';
  });
  on(document.getElementById('cast-known-form')!, 'submit', (event) => {
    event.preventDefault();
    if (!available()) return;
    void (async () => {
      const { owned, current } = begin();
      check.disabled = discover.disabled = true;
      status.textContent = 'Checking your receiver…';
      try {
        const device = await (options.probe ?? probeKnownReceiver)(
          (document.getElementById('cast-known-address') as HTMLInputElement).value,
          (document.getElementById('cast-known-name') as HTMLInputElement).value,
          owned.signal,
        );
        if (!live(owned, current)) return;
        clearDevices();
        addDevice(device);
        status.textContent = 'Receiver found. Select it to review its identity.';
      } catch {
        if (live(owned, current))
          status.textContent = isTauri()
            ? 'Could not connect. Check the local IP address and that the TV supports Chromecast.'
            : 'Casting requires the installed application.';
      } finally {
        if (live(owned, current)) check.disabled = discover.disabled = false;
      }
    })();
  });
  on(discover, 'click', () => {
    if (!available()) return;
    void (async () => {
      const { owned, current } = begin();
      discover.disabled = check.disabled = true;
      clearDevices();
      status.textContent = 'Looking for Chromecast and DLNA devices…';
      try {
        await discoveryCleanup;
        if (!live(owned, current)) return;
        const found = await controller.listDevices(owned.signal);
        if (!live(owned, current)) return;
        for (const device of found) addDevice(device);
        status.textContent = found.length
          ? 'Select your TV to watch on it.'
          : 'No receivers found. Check the TV capabilities, venue pairing and whether this network allows device connections.';
        const warnings = await (
          options.warnings ?? (() => invoke<string[]>('cast_discovery_warnings'))
        )();
        if (live(owned, current) && warnings.length)
          status.textContent = found.length
            ? 'Some interfaces could not be searched. Select your TV below.'
            : 'Some interfaces could not be searched. A known address helps only when its control connection is permitted.';
      } catch {
        if (live(owned, current))
          status.textContent = isTauri()
            ? 'Discovery could not finish. Check the network or venue pairing and try again.'
            : 'Casting requires the installed application.';
      } finally {
        if (live(owned, current)) check.disabled = discover.disabled = false;
      }
    })();
  });
  on(stop, 'click', stopCasting);
  const showMethod = (): void => {
    clearSelection();
    clearDevices();
    known.hidden = method.value !== 'known';
    known.open = method.value === 'known';
    discover.hidden = method.value !== 'nearby';
    venue.hidden = method.value !== 'venue';
  };
  on(method, 'change', showMethod);
  showMethod();
  on(dialog, 'cancel', clearSelection);
  for (const button of dialog.querySelectorAll('[data-close="cast-dialog"]'))
    on(button, 'click', clearSelection);
  on(document, 'visibilitychange', () => {
    if (document.visibilityState !== 'visible') clearSelection();
  });
  on(dialog, 'close', () => {
    clearSelection();
    clearDevices();
  });
  return () => {
    if (disposal) return disposal;
    if (!disposed) {
      // Close UI admission permanently even if the remote owner needs a retry.
      disposed = true;
      clearDevices();
      clearSelection();
      unsubscribe();
      for (const remove of listeners) remove();
      listeners.length = 0;
      methodLabel.remove();
      venue.remove();
      confirmation.remove();
    }
    const attempt = Promise.resolve().then(async () => {
      await discoveryCleanup;
      await controller.dispose();
    });
    disposal = attempt;
    void attempt.catch(() => {
      if (disposal === attempt) disposal = null;
    });
    return attempt;
  };
}
