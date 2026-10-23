import type { OnlineSourceScanResult } from '../discovery/online-source-scan';

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Explains an empty online discovery truthfully: refused for quota versus nothing found. */
export function emptyOnlineDiscoveryText(
  result: Pick<OnlineSourceScanResult, 'rateLimited'>,
  nowMs = Date.now(),
): string {
  const limited = result.rateLimited;
  if (limited)
    return limited.retryAtMs !== null && limited.retryAtMs > nowMs
      ? `Public source lists are temporarily rate-limited until ${clock(limited.retryAtMs)}. Your saved channels are retained. Try Rescan after that time.`
      : 'Public source lists are temporarily rate-limited. Your saved channels are retained. Try Rescan in about an hour.';
  return 'No public channel sources could be found. Your saved channels are retained. Select Rescan to try again.';
}
