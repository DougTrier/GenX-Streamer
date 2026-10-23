import { describe, expect, it, vi } from 'vitest';
import { defaultPreferences } from '../../src/preferences';
import {
  prepareSelectedScanWithHealth,
  type ReviewedScanHealthContext,
} from '../../src/discovery/prepare-selection';
import {
  fingerprintHealthTarget,
  parseHealthPayload,
  type PersistedHealthRecord,
} from '../../src/catalog/health-record';
import { createHealthObservation } from '../../src/discovery/health';
import type { CatalogRecord, Channel, Source } from '../../src/catalog';
import type { ReviewCandidate, StagedScanSelection } from '../../src/discovery/scan';

const source: Source = {
  id: 'source',
  name: 'Owned',
  kind: 'url',
  location: 'https://fixture.invalid/catalog',
};
const channel: Channel = {
  id: 'stable',
  sourceId: source.id,
  providerId: 'provider',
  name: 'Same name',
  category: 'News',
  urls: ['https://fixture.invalid/a?token=one'],
};
const untouched: Channel = {
  ...channel,
  id: 'untouched',
  providerId: 'other',
  urls: ['https://fixture.invalid/b'],
};
const catalog: CatalogRecord = {
  schemaVersion: 1,
  sources: [source],
  channels: [channel, untouched],
};
const { id: _id, ...metadata } = channel;
const candidate: ReviewCandidate = {
  key: 'ephemeral',
  sourceId: source.id,
  sourceFingerprint: 'job',
  sessionRevision: 'revision',
  channel: metadata,
};
const selection: StagedScanSelection = {
  sessionRevision: 'revision',
  failedSourceIds: [],
  sources: [{ sourceId: source.id, fingerprint: 'job', candidates: [metadata] }],
};
const scope = [{ source, fingerprint: 'job' }];
const review = (): ReviewedScanHealthContext => ({
  candidates: [structuredClone(candidate)],
  observations: [
    createHealthObservation(
      { channelId: candidate.key, sourceId: source.id, fingerprint: 'job' },
      { platform: 'windows', observedAt: 100 },
      { kind: 'http', status: 200, contentRecognized: true },
    ),
  ],
  platform: 'windows',
  observerProfile: 'inspection-v1',
});
async function saved(target: Channel): Promise<PersistedHealthRecord> {
  return {
    schemaVersion: 1,
    channelId: target.id,
    sourceId: source.id,
    checkedUrlOrdinal: 0,
    targetFingerprint: await fingerprintHealthTarget(source, target, 0),
    platform: 'windows',
    observerProfile: 'inspection-v1',
    observedAt: 50,
    verdict: 'Reachable',
    evidence: { kind: 'recognized-media-response' },
    origin: 'local',
  };
}
describe('worker reviewed health preparation', () => {
  it('prepares 2,001 selected channels and remaps every responsive observation for one atomic save', async () => {
    const candidates: ReviewCandidate[] = Array.from({ length: 2001 }, (_, index) => ({
      ...candidate,
      key: `review-${index}`,
      channel: {
        ...metadata,
        providerId: `provider-${index}`,
        name: `Channel ${index}`,
        urls: [`https://fixture.invalid/${index}`],
      },
    }));
    const observations = candidates.map((entry) =>
      createHealthObservation(
        { channelId: entry.key, sourceId: source.id, fingerprint: 'job' },
        { platform: 'windows', observedAt: 100 },
        { kind: 'http', status: 200, contentRecognized: true },
      ),
    );
    const selected: StagedScanSelection = {
      ...selection,
      sources: [
        {
          sourceId: source.id,
          fingerprint: 'job',
          candidates: candidates.map((entry) => entry.channel),
        },
      ],
    };
    const result = await prepareSelectedScanWithHealth(
      { schemaVersion: 1, sources: [], channels: [] },
      defaultPreferences(),
      selected,
      scope,
      {
        previousHealth: [],
        review: { candidates, observations, platform: 'windows', observerProfile: 'inspection-v1' },
      },
    );
    expect(result.record.catalog.channels).toHaveLength(2001);
    expect(result.healthRecords).toHaveLength(2001);
    const saved = parseHealthPayload(result.healthText!).records;
    expect(saved).toHaveLength(2001);
    expect(
      saved.every((record) => record.verdict === 'Reachable' && record.checkedUrlOrdinal === 0),
    ).toBe(true);
    expect(new Set(saved.map((record) => record.channelId))).toEqual(
      new Set(result.record.catalog.channels.map((entry) => entry.id)),
    );
    expect(JSON.parse(result.catalogText).channels).toHaveLength(2001);
    expect(new TextEncoder().encode(result.healthText!).length).toBeLessThanOrEqual(
      20 * 1024 * 1024,
    );
  });

  it('refuses 100,001 reviewed candidates or observations before hashing/publication', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try {
      for (const field of ['candidates', 'observations'] as const) {
        const context = review();
        if (field === 'candidates') context.candidates = new Array<ReviewCandidate>(100001);
        else context.observations = new Array<ReturnType<typeof createHealthObservation>>(100001);
        await expect(
          prepareSelectedScanWithHealth(catalog, defaultPreferences(), selection, scope, {
            previousHealth: [],
            review: context,
          }),
        ).rejects.toThrow('selected check bound');
      }
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });
  it('maps the exact selected tuple alongside reconciliation and keeps same-name unselected health', async () => {
    const previous = await saved(untouched);
    const result = await prepareSelectedScanWithHealth(
      catalog,
      defaultPreferences(),
      selection,
      scope,
      { previousHealth: [previous], review: review() },
    );
    expect(result.healthRecords?.map((record) => record.channelId).sort()).toEqual([
      'stable',
      'untouched',
    ]);
    expect(result.record.catalog.channels.find((value) => value.id === 'untouched')).toEqual(
      untouched,
    );
    expect(parseHealthPayload(result.healthText!).records).toEqual(result.healthRecords);
    expect(result.healthRecords?.find((record) => record.channelId === 'stable')?.verdict).toBe(
      'Reachable',
    );
  });
  it('invalidates changed signed URLs without hashing every unobserved catalog channel', async () => {
    const prior = await saved(channel);
    const changed = structuredClone(selection);
    changed.sources[0]!.candidates[0]!.urls[0] = 'https://fixture.invalid/a?token=two';
    const spy = vi.spyOn(crypto.subtle, 'digest');
    try {
      const result = await prepareSelectedScanWithHealth(
        catalog,
        defaultPreferences(),
        changed,
        scope,
        { previousHealth: [prior] },
      );
      expect(result.healthRecords).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('retains old health when a new observation was canceled or locally offline', async () => {
    for (const kind of ['canceled', 'local-network-unavailable', 'not-checked'] as const) {
      const prior = await saved(channel);
      const context = review();
      context.observations = [
        createHealthObservation(
          { channelId: candidate.key, sourceId: source.id, fingerprint: 'job' },
          { platform: 'windows', observedAt: 100 },
          { kind },
        ),
      ];
      const result = await prepareSelectedScanWithHealth(
        catalog,
        defaultPreferences(),
        selection,
        scope,
        { previousHealth: [prior], review: context },
      );
      expect(result.healthRecords).toEqual([prior]);
    }
  });
  it('refuses unselected, changed or wrong-platform reviewed health before publication', async () => {
    for (const change of ['unselected', 'url', 'platform'] as const) {
      const context = structuredClone(review());
      if (change === 'unselected') context.candidates[0]!.channel.providerId = 'not-selected';
      if (change === 'url') context.candidates[0]!.channel.urls[0] += '-changed';
      if (change === 'platform') context.platform = 'android';
      await expect(
        prepareSelectedScanWithHealth(catalog, defaultPreferences(), selection, scope, {
          previousHealth: [],
          review: context,
        }),
      ).rejects.toThrow();
    }
  });
  it('does not promote fabricated PlayedHere or persist unselected observations', async () => {
    const context = review();
    context.observations[0]!.verdict = 'PlayedHere';
    await expect(
      prepareSelectedScanWithHealth(catalog, defaultPreferences(), selection, scope, {
        previousHealth: [],
        review: context,
      }),
    ).rejects.toThrow(/verdict/);
    const valid = review();
    valid.observations = [{ ...valid.observations[0]!, channelId: 'unselected-review-key' }];
    const result = await prepareSelectedScanWithHealth(
      catalog,
      defaultPreferences(),
      selection,
      scope,
      { previousHealth: [], review: valid },
    );
    expect(result.healthRecords).toEqual([]);
  });
  it('captures inputs before asynchronous hashing and respects canceled completion', async () => {
    const context = review();
    const pending = prepareSelectedScanWithHealth(catalog, defaultPreferences(), selection, scope, {
      previousHealth: [],
      review: context,
    });
    context.candidates[0]!.channel.urls[0] = 'https://fixture.invalid/late';
    context.observations[0]!.platform = 'android';
    expect((await pending).healthRecords?.[0]?.platform).toBe('windows');
    const abort = new AbortController();
    abort.abort();
    await expect(
      prepareSelectedScanWithHealth(
        catalog,
        defaultPreferences(),
        selection,
        scope,
        { previousHealth: [], review: review() },
        abort.signal,
      ),
    ).rejects.toThrow();
  });
  it('bounds hashing at four and awaits every owned digest on cancellation', async () => {
    const channels = Array.from({ length: 6 }, (_, index) => ({
      ...channel,
      id: `slot-${index}`,
      providerId: `provider-${index}`,
    }));
    const previous = await Promise.all(channels.map(saved));
    const releases: Array<() => void> = [];
    const spy = vi
      .spyOn(crypto.subtle, 'digest')
      .mockImplementation(
        () =>
          new Promise<ArrayBuffer>((resolve) => releases.push(() => resolve(new ArrayBuffer(32)))),
      );
    const abort = new AbortController();
    let settled = false;
    try {
      const pending = prepareSelectedScanWithHealth(
        { ...catalog, channels },
        defaultPreferences(),
        { ...selection, sources: [] },
        scope,
        { previousHealth: previous },
        abort.signal,
      ).finally(() => {
        settled = true;
      });
      const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(releases).toHaveLength(4));
      abort.abort();
      releases[0]!();
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      releases.slice(1).forEach((release) => release());
      await rejected;
      expect(spy).toHaveBeenCalledTimes(4);
    } finally {
      spy.mockRestore();
    }
  });
});

it('canonicalizes retained raw source MIME on a copy without changing review identity', async () => {
  const retained = [
    {
      source: {
        ...source,
        contentKind: 'catalog' as const,
        mediaMime: 'TEXT/PLAIN; charset=utf-8',
      },
      fingerprint: 'job',
    },
  ];
  const original = structuredClone(retained);
  const health = review();
  const result = await prepareSelectedScanWithHealth(
    catalog,
    defaultPreferences(),
    selection,
    retained,
    { previousHealth: [], review: health },
  );
  const canonical = result.record.catalog.sources.find((entry) => entry.id === source.id)!;
  expect(canonical.mediaMime).toBe('text/plain');
  expect(retained).toEqual(original);
  expect(health).toEqual(review());
  const records = parseHealthPayload(result.healthText!).records;
  expect(records).toHaveLength(1);
  expect(records[0]!.targetFingerprint).toBe(
    await fingerprintHealthTarget(
      canonical,
      result.record.catalog.channels.find((entry) => entry.id === records[0]!.channelId)!,
      0,
    ),
  );
});
it('still rejects malformed retained MIME instead of weakening persisted source admission', async () => {
  await expect(
    prepareSelectedScanWithHealth(
      catalog,
      defaultPreferences(),
      selection,
      [{ source: { ...source, mediaMime: 'not a media type' }, fingerprint: 'job' }],
      { previousHealth: [], review: review() },
    ),
  ).rejects.toThrow('Invalid media MIME type.');
});
