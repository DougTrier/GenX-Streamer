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

import { invoke } from '@tauri-apps/api/core';

/** Whether a VPN connection is up on this device (read-only; GenX never controls a VPN). */
export interface VpnStatus {
  connected: boolean;
  /** The VPN adapter's name where the system tells (Windows). */
  name?: string;
}

const invalid = () => new Error('VPN status reply is invalid.');
export function validateVpnStatus(value: unknown): VpnStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => key !== 'connected' && key !== 'name')) throw invalid();
  if (typeof row.connected !== 'boolean') throw invalid();
  if (row.name === undefined) return { connected: row.connected };
  if (
    typeof row.name !== 'string' ||
    !row.name.trim() ||
    row.name.length > 64 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(row.name)
  )
    throw invalid();
  return { connected: row.connected, name: row.name };
}

export function createVpnStatus(
  native: { invoke(command: string): Promise<unknown> } = { invoke },
) {
  return {
    async read(): Promise<VpnStatus> {
      return validateVpnStatus(await native.invoke('vpn_status'));
    },
  };
}
export type VpnStatusSource = ReturnType<typeof createVpnStatus>;
