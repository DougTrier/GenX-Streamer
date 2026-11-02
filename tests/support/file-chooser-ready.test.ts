// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { prepareFileChooser } from './file-chooser-ready';

it('admits keyboard activation only after the first owned interception ACK', async () => {
  let release!: () => void;
  const held = new Promise<void>((yes) => (release = yes));
  const events: string[] = [];
  const update = vi.fn(() => {
    events.push('setup-start');
    return held.then(() => events.push('setup-ack'));
  });
  const setup = (async () => {
    await prepareFileChooser({ _channel: { updateSubscription: update } });
    events.push('listener-register', 'trusted-enter');
  })();
  await Promise.resolve();
  expect(events).toEqual(['setup-start']);
  expect(update).toHaveBeenCalledExactlyOnceWith({ event: 'fileChooser', enabled: true });
  release();
  await setup;
  expect(events).toEqual(['setup-start', 'setup-ack', 'listener-register', 'trusted-enter']);
});

it('does not activate or hide a failed interception setup', async () => {
  const denied = new Error('Controlled chooser setup refusal');
  const activate = vi.fn();
  const setup = (async () => {
    await prepareFileChooser({
      _channel: { updateSubscription: () => Promise.reject(denied) },
    });
    activate();
  })();
  await expect(setup).rejects.toBe(denied);
  expect(activate).not.toHaveBeenCalled();
});

it('fails closed when the pinned driver subscription seam is unavailable', async () => {
  for (const page of [
    undefined,
    {},
    { _channel: {} },
    { _channel: { updateSubscription: 1 } },
    { _channel: { updateSubscription: () => undefined } },
  ])
    await expect(prepareFileChooser(page)).rejects.toThrow('Unsupported file chooser driver.');
});
