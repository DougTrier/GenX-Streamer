import { exactCandidateDedup } from './collector';
import { MAX_CHANNELS, type ParsedPlaylist } from './parser';

const receipts = new WeakMap<object, number>();

/** Explicit transfer: freezes caller data and performs the existing post-enrichment dedup once. */
export async function ownCollectedPlaylist(
  parsed: ParsedPlaylist,
  signal: AbortSignal,
): Promise<ParsedPlaylist> {
  signal.throwIfAborted();
  const refuse = () => new Error('Owned collection requires bounded plain playlist data.');
  const channels = Object.getOwnPropertyDescriptor(parsed, 'channels');
  const warnings = Object.getOwnPropertyDescriptor(parsed, 'warnings');
  if (
    !channels ||
    !('value' in channels) ||
    !Array.isArray(channels.value) ||
    channels.value.length > MAX_CHANNELS ||
    !warnings ||
    !('value' in warnings) ||
    !Array.isArray(warnings.value)
  )
    throw refuse();
  // Same graph-work limits as the owned checker; no lasting verification cache.
  const complete = new WeakSet<object>(),
    active = new WeakSet<object>();
  type Frame = { value: object; keys: (string | symbol)[]; at: number; depth: number };
  const stack: Frame[] = [];
  let nodes = 0,
    edges = 0,
    lastYield = 0;
  const enter = (value: unknown, depth: number) => {
    if (value === null || ['undefined', 'string', 'number', 'boolean'].includes(typeof value))
      return;
    if (typeof value !== 'object' || depth > 32 || active.has(value)) throw refuse();
    if (complete.has(value)) return;
    if (++nodes > 1000000) throw refuse();
    const proto = Object.getPrototypeOf(value),
      keys = Reflect.ownKeys(value);
    if (
      Array.isArray(value)
        ? proto !== Array.prototype ||
          value.length > MAX_CHANNELS ||
          keys.length !== value.length + 1
        : ![Object.prototype, null].includes(proto) || keys.length > 32
    )
      throw refuse();
    active.add(value);
    stack.push({ value, keys, at: 0, depth });
  };
  enter(parsed, 0);
  while (stack.length) {
    const frame = stack.at(-1)!;
    if (frame.at === frame.keys.length) {
      Object.freeze(frame.value);
      active.delete(frame.value);
      complete.add(frame.value);
      stack.pop();
      continue;
    }
    if (++edges > 8000000) throw refuse();
    if (edges % 128 === 0) signal.throwIfAborted();
    if (edges - lastYield >= 16384) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      lastYield = edges;
    }
    const key = frame.keys[frame.at++]!;
    if (typeof key !== 'string') throw refuse();
    const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
    if (!descriptor || !('value' in descriptor)) throw refuse();
    enter(descriptor.value, frame.depth + 1);
  }
  signal.throwIfAborted();
  const result = Object.freeze({
    ...parsed,
    channels: Object.freeze(exactCandidateDedup(parsed.channels)),
  }) as unknown as ParsedPlaylist;
  signal.throwIfAborted();
  receipts.set(result, parsed.channels.length);
  return result;
}

/** One-use receipt; arbitrary frozen objects are not an ownership assertion. */
export function consumeOwnedCollection(parsed: ParsedPlaylist): number | null {
  const count = receipts.get(parsed);
  if (count === undefined) return null;
  receipts.delete(parsed);
  return count;
}
