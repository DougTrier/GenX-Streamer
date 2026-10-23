import { invoke, isTauri } from '@tauri-apps/api/core';
import { validateAccountMetadata, type AccountMetadata } from './account-vault';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';

/** Provider data availability only. It does not establish stream playback. */
export interface AccountInspection {
  schemaVersion: 1;
  accountId: string;
  revision: string;
  channels: number;
  suppliedGuide: boolean;
  maxConnections: number | null;
  playbackVerified: false;
}

export function createAccountAcquisition(runtime?: OwnedNativeRuntime) {
  const native = runtime ?? {
    invoke: (command: string, args?: Record<string, unknown>) => {
      if (!isTauri())
        return Promise.reject(new Error('Account acquisition requires the installed application.'));
      return invoke(command, args);
    },
  };
  return {
    async inspect(account: AccountMetadata, signal?: AbortSignal): Promise<AccountInspection> {
      const admitted = validateAccountMetadata(account);
      return invokeOwnedNative(
        native,
        'inspect_iptv_account',
        {
          request: {
            schemaVersion: 1,
            accountId: admitted.id,
            expectedRevision: admitted.revision,
          },
        },
        {
          signal,
          validate(value: unknown): AccountInspection {
            const invalid = () => new Error('The provider check returned an invalid response.');
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
            const row = value as Record<string, unknown>;
            const keys = [
              'schemaVersion',
              'accountId',
              'revision',
              'channels',
              'suppliedGuide',
              'maxConnections',
              'playbackVerified',
            ];
            if (
              Object.keys(row).length !== keys.length ||
              keys.some((key) => !Object.hasOwn(row, key)) ||
              row.schemaVersion !== 1 ||
              row.accountId !== admitted.id ||
              row.revision !== admitted.revision ||
              !Number.isSafeInteger(row.channels) ||
              (row.channels as number) < 0 ||
              (row.channels as number) > 100_000 ||
              typeof row.suppliedGuide !== 'boolean' ||
              row.playbackVerified !== false ||
              (row.maxConnections !== null &&
                (!Number.isSafeInteger(row.maxConnections) ||
                  (row.maxConnections as number) < 0 ||
                  (row.maxConnections as number) > 4_294_967_295))
            )
              throw invalid();
            return {
              schemaVersion: 1,
              accountId: admitted.id,
              revision: admitted.revision,
              channels: row.channels as number,
              suppliedGuide: row.suppliedGuide,
              maxConnections: row.maxConnections as number | null,
              playbackVerified: false,
            };
          },
        },
      );
    },
  };
}
