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
