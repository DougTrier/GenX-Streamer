export interface FixtureServer {
  url: string;
  stats(): { totalRequests: number; liveManifests: number; activeResponses: number; activeSockets: number; timers: number; requests: Array<{ method: string; path: string; range: string | null }> };
  close(): Promise<void>;
}
export function startFixtureServer(options?: { port?: number; delayMs?: number; mediaDirectory?: string; now?: () => number }): Promise<FixtureServer>;
export function buildLivePlaylist(elapsedMs: number): string;
