import { describe, expect, it, vi } from 'vitest';
import { isPlaceholderLocation, unavailableReason } from '../../src/discovery/unavailable-sources';
import { SourceRequestError } from '../../src/sources';
import { prepareDiscoveredSources } from '../../src/application/discovered-source-configuration';
import { defaultPreferences } from '../../src/preferences';
import type { OnlineSourceScanResult } from '../../src/discovery/online-source-scan';
import {
  createIncrementalRefreshCoordinator,
  type IncrementalRefreshHost,
} from '../../src/discovery/incremental-refresh';

const wrapped = (cause: unknown) =>
  new Error(
    'This source could not be read. Check its connection and access permission; saved channels were retained.',
    { cause },
  );

describe('permanent failure classification', () => {
  it('recognizes placeholder hosts', () => {
    for (const url of [
      'https://example.com/a.m3u',
      'https://cdn.example.org/a.m3u',
      'https://x.invalid/a.m3u',
      'http://localhost/a.m3u',
      'https://a.test/x',
    ])
      expect(isPlaceholderLocation(url)).toBe(true);
    for (const url of [
      'https://iptv-org.github.io/iptv/index.m3u',
      'https://example.community/a',
      'nope',
    ])
      expect(isPlaceholderLocation(url)).toBe(false);
  });
  it('treats only 404, 410, nonexistent domains and placeholders as permanent', () => {
    const real = 'https://raw.githubusercontent.com/o/r/main/a.m3u';
    expect(unavailableReason(wrapped(new SourceRequestError(404, null)), real)).toBe('http-404');
    expect(unavailableReason(new SourceRequestError(410, null), real)).toBe('http-410');
    expect(unavailableReason(wrapped('dns-failure'), real)).toBe('dns-failure');
    for (const temporary of [
      new SourceRequestError(403, null),
      new SourceRequestError(429, '60'),
      new SourceRequestError(503, null),
      'timeout',
      'connectivity-failure',
      'tls-failure',
      new Error('This source has no supported channel catalog or media.'),
      undefined,
    ])
      expect(unavailableReason(wrapped(temporary), real)).toBeNull();
    expect(unavailableReason('timeout', 'https://example.com/a.m3u')).toBe('placeholder-host');
  });
});

const discovered = (...locations: string[]): OnlineSourceScanResult => ({
  query: '',
  startedAtMs: 1,
  channels: locations.map((location) => ({
    label: location.split('/').at(-1)!,
    location,
    provenance: 'https://github.com/fixture/directory',
    format: 'm3u' as const,
    reason:
      'Published document link; contents, rights, coverage and playback have not been checked.',
    rights: 'unknown' as const,
    documentSha: 'a'.repeat(40),
    directoryIds: [1],
    provenances: ['https://github.com/fixture/directory'],
    allowHttp: false as const,
  })),
  guides: [],
  outcomes: [],
});
describe('discovered suggestion pruning', () => {
  it('skips and prunes dead links but never a saved catalog source', () => {
    let id = 0;
    const next = () => `id-${++id}`;
    const live = 'https://live.fixture.org/live.m3u';
    const dead = 'https://dead.fixture.org/gone.m3u';
    const saved = 'https://saved.fixture.org/saved.m3u';
    const first = prepareDiscoveredSources(
      defaultPreferences(),
      discovered(live, dead, saved, 'https://example.com/placeholder.m3u'),
      next,
      { unavailable: new Set() },
    );
    // Placeholders are pruned only after their failure is recorded.
    expect(first.preferences.reviewedChannelProviders!.map((p) => p.location)).toEqual([
      live,
      dead,
      saved,
      'https://example.com/placeholder.m3u',
    ]);
    const second = prepareDiscoveredSources(
      first.preferences,
      discovered(live, dead, saved),
      next,
      {
        unavailable: new Set([dead, saved, 'https://example.com/placeholder.m3u']),
        keep: new Set([saved]),
      },
    );
    expect(second.preferences.reviewedChannelProviders!.map((p) => p.location)).toEqual([
      live,
      saved,
    ]);
    expect(second.pruned).toEqual([dead, 'https://example.com/placeholder.m3u']);
    // Without options the established behavior is unchanged.
    expect(prepareDiscoveredSources(first.preferences, discovered(live), next).pruned).toEqual([]);
  });
});

describe('coordinator recording', () => {
  const source = (id: string) => ({
    id,
    name: id,
    kind: 'url' as const,
    location: `https://${id}.fixture.org/p.m3u`,
  });
  const host = (
    failures: Record<string, unknown>,
  ): IncrementalRefreshHost & { recorded: unknown[] } => {
    const recorded: unknown[] = [];
    return {
      recorded,
      current: () => true,
      collect: vi.fn(async (s) => {
        if (s.id in failures) throw wrapped(failures[s.id]);
        return {
          entryCount: 1,
          pages: (async function* () {
            yield [
              {
                entryId: `${s.id}-0`,
                channel: {
                  sourceId: s.id,
                  name: 'A',
                  category: '',
                  urls: [`https://${s.id}.fixture.org/a.m3u8`],
                },
              },
            ];
          })(),
          dispose: vi.fn(async () => undefined),
        };
      }),
      snapshots: {
        begin: vi.fn(async (input) => ({
          schemaVersion: 1 as const,
          snapshotId: input.source.id,
          sourceId: input.source.id,
          sourceRevision: input.expectedSourceRevision,
          nextIndex: 0,
          entryCount: input.entryCount,
        })),
        append: vi.fn(async (input) => ({
          schemaVersion: 1 as const,
          snapshotId: input.snapshotId,
          sourceId: input.snapshotId,
          sourceRevision: '0',
          nextIndex: input.expectedNextIndex + input.entries.length,
          entryCount: 1,
        })),
        promote: vi.fn(async (input) => ({
          schemaVersion: 1 as const,
          committed: true as const,
          sourceId: input.snapshotId,
          sourceRevision: '1',
          added: 1,
          changed: 0,
          unchanged: 0,
          removed: 0,
          duplicates: 0,
          total: 1,
        })),
      },
      activateChecks: vi.fn(async () => undefined),
      continueChecks: vi.fn(async () => undefined),
      stopChecks: vi.fn(async () => undefined),
      unavailable: vi.fn(async (entries) => {
        recorded.push(...entries);
      }),
    };
  };
  const scope = (...ids: string[]) => ({
    scopeId: 'owned',
    sources: ids.map((id) => ({ source: source(id), sourceRevision: '0' })),
    platform: 'windows',
    observerProfile: 'fixture',
    query: '',
    intent: 'refresh' as const,
  });
  it('records 404 and DNS failures when another source succeeded', async () => {
    const h = host({
      gone: new SourceRequestError(404, null),
      nodomain: 'dns-failure',
      slow: 'timeout',
    });
    await createIncrementalRefreshCoordinator(h).start(scope('ok', 'gone', 'nodomain', 'slow'));
    expect(h.recorded).toEqual([
      { location: 'https://gone.fixture.org/p.m3u', reason: 'http-404' },
      { location: 'https://nodomain.fixture.org/p.m3u', reason: 'dns-failure' },
    ]);
  });
  it('never records DNS failures when nothing succeeded (possibly offline)', async () => {
    const h = host({ a: 'dns-failure', b: 'dns-failure', gone: new SourceRequestError(404, null) });
    await createIncrementalRefreshCoordinator(h)
      .start(scope('a', 'b', 'gone'))
      .catch(() => undefined);
    expect(h.recorded).toEqual([
      { location: 'https://gone.fixture.org/p.m3u', reason: 'http-404' },
    ]);
  });
});
