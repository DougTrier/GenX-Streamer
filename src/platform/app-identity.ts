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
 * Is this copy genuine? (src-tauri/src/platform/app_identity.rs;
 * docs/verify-a-download.md): version, platform, build, Android's signing
 * fingerprint and whether it is the official release certificate, and the
 * app file's checksum on request.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';

export interface AppIdentity {
  version: string;
  platform: 'Windows' | 'Android' | 'Other';
  architecture: string;
  build: 'release' | 'development';
  /** Android signing certificates, SHA-256, lowercase hex. */
  signers: string[];
  /** Signed with the owner's release certificate (never on Windows). */
  official: boolean;
  split: boolean;
}

const HEX64 = /^[a-f0-9]{64}$/u;

export async function appIdentity(): Promise<AppIdentity | null> {
  if (!isTauri()) return null;
  const r = (await invoke<unknown>('app_identity')) as Record<string, unknown>;
  if (
    !r ||
    typeof r.version !== 'string' ||
    !['Windows', 'Android', 'Other'].includes(String(r.platform)) ||
    typeof r.architecture !== 'string' ||
    !['release', 'development'].includes(String(r.build)) ||
    !Array.isArray(r.signers) ||
    !r.signers.every((s) => typeof s === 'string' && HEX64.test(s.toLowerCase()))
  )
    throw new Error('identity-unavailable');
  return {
    version: r.version.slice(0, 32),
    platform: r.platform as AppIdentity['platform'],
    architecture: r.architecture.slice(0, 32),
    build: r.build as AppIdentity['build'],
    signers: (r.signers as string[]).map((s) => s.toLowerCase()),
    official: r.official === true,
    split: r.split === true,
  };
}

/** This copy's own file checksum (computed only when asked). */
export async function appChecksum(): Promise<{ sha256: string; bytes: number }> {
  const r = (await invoke<unknown>('app_checksum')) as Record<string, unknown>;
  if (!r || typeof r.sha256 !== 'string' || !HEX64.test(r.sha256) || !Number.isSafeInteger(r.bytes))
    throw new Error('identity-file-unavailable');
  return { sha256: r.sha256, bytes: Number(r.bytes) };
}

/** May this copy send its own app file? Windows always; Android only as an official release in one APK. */
export const maySendAppFile = (identity: AppIdentity | null) =>
  !!identity && !identity.split && (identity.platform === 'Windows' || identity.official);
