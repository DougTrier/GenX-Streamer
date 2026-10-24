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
