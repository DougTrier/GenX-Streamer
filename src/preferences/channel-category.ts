import type { Channel } from '../catalog/parser';
import type { Preferences } from './index';
import { boundedUtf8Text } from '../platform/bounded-text';
export interface ChannelCategoryOverride {
  channelId: string;
  category: string;
}
const validText = (value: unknown, limit: number): value is string =>
  boundedUtf8Text(value, limit) &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
/** Optional user intent; never changes provider category or matches by display name. */
export function validateChannelCategoryOverrides(raw: unknown): ChannelCategoryOverride[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100000)
    throw new Error('Invalid channel category overrides.');
  const ids = new Set<string>();
  let bytes = 2;
  const encoder = new TextEncoder();
  return raw.map((entry: unknown, index: number) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(entry)) ||
      Object.keys(entry).some((key) => !['channelId', 'category'].includes(key))
    )
      throw new Error('Invalid channel category overrides.');
    const value = entry as Record<string, unknown>;
    if (
      !validText(value.channelId, 16384) ||
      !validText(value.category, 512) ||
      value.category.trim() !== value.category ||
      ids.has(value.channelId)
    )
      throw new Error('Invalid channel category overrides.');
    ids.add(value.channelId);
    const result = { channelId: value.channelId, category: value.category };
    bytes += encoder.encode(JSON.stringify(result)).byteLength + (index === 0 ? 0 : 1);
    if (bytes > 20 * 1024 * 1024) throw new Error('Channel category overrides exceed 20 MiB.');
    return result;
  });
}
export function createChannelCategoryResolver(
  preferences: Pick<Preferences, 'channelCategoryOverrides'>,
): (channel: Pick<Channel, 'id' | 'category'>) => string {
  const overrides = new Map(
    validateChannelCategoryOverrides(preferences.channelCategoryOverrides).map((entry) => [
      entry.channelId,
      entry.category,
    ]),
  );
  return (channel) => overrides.get(channel.id) ?? channel.category;
}
export function effectiveChannelCategory(
  channel: Pick<Channel, 'id' | 'category'>,
  preferences: Pick<Preferences, 'channelCategoryOverrides'>,
): string {
  return createChannelCategoryResolver(preferences)(channel);
}
