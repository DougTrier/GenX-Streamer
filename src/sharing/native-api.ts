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
import type { SharingApi } from './contracts';
export function createNativeSharingApi(): SharingApi {
  const call = <T>(command: string, arguments_?: Record<string, unknown>): Promise<T> => {
    if (!isTauri())
      return Promise.reject(new Error('Sharing requires the native Windows application.'));
    return invoke<T>(command, arguments_);
  };
  return {
    start: (settings) => call('start_server', { ...settings }),
    stop: () => call('stop_server'),
    selectionChanged: (generation, commandId, preservePublication = false) =>
      call('sharing_selection_changed', {
        generation,
        ...(commandId ? { commandId } : {}),
        ...(preservePublication ? { preservePublication: true } : {}),
      }),
    publish: (url, generation) => call('sharing_publish', { url, generation }),
    invite: (controller, channels) =>
      call('sharing_invite', {
        controller,
        channelIds: channels.map((channel) => channel.id),
        channelLabels: channels,
      }),
    viewers: () => call('sharing_viewers'),
    revoke: (viewerId) => call('sharing_revoke', { viewerId }),
    nextCommand: () => call('next_remote_control'),
    active: (commandId) => call('remote_control_active', { commandId }),
    allows: (commandId, channelId) => call('remote_control_allows', { commandId, channelId }),
    acknowledge: (commandId, applied) => call('acknowledge_remote_control', { commandId, applied }),
  };
}
