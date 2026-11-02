// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0

/** Playwright1.64.0's public on('filechooser') starts interception without
 * awaiting its protocol ACK. A fast trusted Enter can beat that setup. Await
 * the pinned test driver's owned subscription before the first listener; a
 * duplicate update after on() can resolve before the original setup finishes.
 * No product code, chooser action or activation deadline is replaced here.
 */
export async function prepareFileChooser(page: unknown): Promise<void> {
  if (!page || typeof page !== 'object') throw new Error('Unsupported file chooser driver.');
  const channel: unknown = Reflect.get(page, '_channel');
  if (!channel || typeof channel !== 'object') throw new Error('Unsupported file chooser driver.');
  const update: unknown = Reflect.get(channel, 'updateSubscription');
  if (typeof update !== 'function') throw new Error('Unsupported file chooser driver.');
  const acknowledged: unknown = Reflect.apply(update, channel, [
    { event: 'fileChooser', enabled: true },
  ]);
  if (
    !acknowledged ||
    (typeof acknowledged !== 'object' && typeof acknowledged !== 'function') ||
    typeof Reflect.get(acknowledged, 'then') !== 'function'
  )
    throw new Error('Unsupported file chooser driver.');
  await acknowledged;
}
