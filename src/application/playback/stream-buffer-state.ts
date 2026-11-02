/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import type { ChannelSelection } from '../../playback/controller-model';
import type { LiveBufferPreference } from '../../playback/live-buffer';
import {
  freeStreamBufferKey,
  getStreamBufferPreferences,
} from '../../playback/stream-buffer-preferences';

/** Private relay URLs and scan-row IDs never become durable tuning identities. */
export async function streamBufferKey(
  selection: Readonly<ChannelSelection>,
): Promise<string | null> {
  if (selection.liveBufferKey !== undefined)
    return /^[a-f0-9]{64}$/.test(selection.liveBufferKey) ? selection.liveBufferKey : null;
  if (
    selection.playMode === 'on-demand' ||
    selection.id.startsWith('account-') ||
    selection.id.startsWith('archive-')
  )
    return null;
  try {
    return await freeStreamBufferKey(selection.url);
  } catch {
    return null;
  }
}

export async function savedStreamBufferPreference(
  selection: Readonly<ChannelSelection>,
): Promise<LiveBufferPreference> {
  try {
    const key = await streamBufferKey(selection);
    if (!key) return { mode: 'auto' };
    const preferences = getStreamBufferPreferences();
    await preferences.load();
    return preferences.get(key);
  } catch {
    // Unavailable device storage must not prevent playback.
    return { mode: 'auto' };
  }
}

export async function saveStreamBufferPreference(
  key: string,
  preference: LiveBufferPreference,
): Promise<void> {
  const preferences = getStreamBufferPreferences();
  await preferences.load();
  await preferences.set(key, preference);
}
