import { invoke, isTauri } from '@tauri-apps/api/core';
import { SourceRequestError } from '../sources';

/** Only permanent conditions; timeouts, rate limits and server errors are never recorded. */
export type UnavailableReason = 'http-404' | 'http-410' | 'dns-failure' | 'placeholder-host';

/** Reserved example/test hosts can never serve a playlist (RFC 2606/6761). */
export function isPlaceholderLocation(location: string): boolean {
  let host: string;
  try {
    host = new URL(location).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    ['example.com', 'example.org', 'example.net', 'localhost'].some(
      (name) => host === name || host.endsWith(`.${name}`),
    ) || ['.example', '.invalid', '.test', '.localhost'].some((suffix) => host.endsWith(suffix))
  );
}

/** Permanent reason for a failed source read, or null for anything possibly temporary. */
export function unavailableReason(error: unknown, location: string): UnavailableReason | null {
  if (isPlaceholderLocation(location)) return 'placeholder-host';
  for (let current: unknown = error, depth = 0; current && depth < 4; depth++) {
    if (current instanceof SourceRequestError) {
      if (current.status === 404) return 'http-404';
      if (current.status === 410) return 'http-410';
      return null;
    }
    if (
      current === 'dns-failure' ||
      (current instanceof Error && current.message === 'dns-failure')
    )
      return 'dns-failure';
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}

/** Best effort: an unreadable cache means no link is skipped. */
export async function readUnavailableSources(): Promise<ReadonlySet<string>> {
  if (!isTauri()) return new Set();
  try {
    const entries = await invoke<{ location: string }[]>('read_discovery_unavailable');
    return new Set(
      Array.isArray(entries)
        ? entries.map((e) => e?.location).filter((l) => typeof l === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

export async function recordUnavailableSources(
  entries: readonly { location: string; reason: UnavailableReason }[],
): Promise<void> {
  if (!isTauri() || !entries.length) return;
  try {
    await invoke('record_discovery_unavailable', {
      entries: entries.slice(0, 500).map(({ location, reason }) => ({ location, reason })),
    });
  } catch {
    /* A failed record only means the dead link is tried once more. */
  }
}
