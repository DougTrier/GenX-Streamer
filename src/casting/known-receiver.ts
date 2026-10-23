import { invoke, isTauri } from '@tauri-apps/api/core';
import type { CastDevice } from './controller';

/** Probe only. Selecting the returned receiver is a separate user action. */
export async function probeKnownReceiver(
  address: string,
  name: string,
  signal: AbortSignal,
): Promise<CastDevice> {
  signal.throwIfAborted();
  if (!isTauri()) throw new Error('Casting requires the installed application.');
  const result = await invoke<CastDevice>('cast_register_receiver', {
    address: address.trim(),
    name: name.trim() || 'My TV',
  });
  signal.throwIfAborted();
  return result;
}
