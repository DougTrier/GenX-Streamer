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

import type { RemoteCommand, SharingChannel, SharingSettings } from './contracts';
export function validateSettings(settings: SharingSettings): void {
  const octets = settings.bindAddress.split('.').map(Number);
  if (
    !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(settings.bindAddress) ||
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255) ||
    !(
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    )
  )
    throw new Error('Choose a private IPv4 interface address.');
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535)
    throw new Error('Choose a port from 1 to 65535.');
  for (const path of [settings.certPath, settings.keyPath])
    if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) || path.length > 4096)
      throw new Error('Choose absolute certificate and key file paths.');
}
export function scopedChannels(
  channels: ReadonlyArray<SharingChannel>,
  ids: ReadonlyArray<string>,
): SharingChannel[] {
  const unique = new Set(ids);
  if (!unique.size || unique.size > 100000 || unique.size !== ids.length)
    throw new Error('Choose a unique, nonempty channel scope.');
  const records = channels.filter((channel) => unique.has(channel.id));
  if (
    records.length !== unique.size ||
    new Set(records.map((channel) => channel.id)).size !== records.length
  )
    throw new Error('Some channels are no longer available.');
  const encoder = new TextEncoder();
  if (
    records.some(
      (channel) =>
        !channel.id.trim() ||
        channel.id.length > 256 ||
        !channel.name.trim() ||
        encoder.encode(channel.name).length > 160,
    ) ||
    records.reduce((sum, channel) => sum + encoder.encode(channel.id).length, 0) > 1048576 ||
    records.reduce((sum, channel) => sum + encoder.encode(channel.id + channel.name).length, 0) >
      4194304
  )
    throw new Error('This channel scope exceeds the supported limits.');
  return records.map((channel) => ({ ...channel }));
}
export function validCommand(command: RemoteCommand): boolean {
  if (
    !command ||
    typeof command.commandId !== 'string' ||
    !command.commandId ||
    !Number.isSafeInteger(command.sequence) ||
    command.sequence < 1 ||
    !Number.isSafeInteger(command.revision) ||
    command.revision < 0
  )
    return false;
  if (command.action === 'select')
    return (
      typeof command.channelId === 'string' &&
      !!command.channelId &&
      command.channelId.length <= 256
    );
  if (command.action === 'mute') return typeof command.muted === 'boolean';
  if (command.action === 'volume')
    return (
      typeof command.volume === 'number' &&
      Number.isFinite(command.volume) &&
      command.volume >= 0 &&
      command.volume <= 1
    );
  if (command.action === 'next' || command.action === 'previous')
    return (
      Array.isArray(command.allowedChannelIds) &&
      command.allowedChannelIds.length > 0 &&
      command.allowedChannelIds.length <= 100000
    );
  return command.action === 'pause' || command.action === 'resume';
}
