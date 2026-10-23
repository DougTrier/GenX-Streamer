import { describe, expect, it } from 'vitest';
import {
  validateArchiveFile,
  validateArchiveTitle,
  validateArchiveFilesPage,
  createArchiveCatalog,
} from '../../src/platform/archive-catalog';
import { validateArchivePlaybackReceipt } from '../../src/platform/archive-playback';
import {
  validateArchiveProviderFacts,
  validatePublicArchiveDiscoverRequest,
  validatePublicArchiveDiscoverReceipt,
  publicArchiveSource,
  publicArchiveNasaItemId,
  type ArchiveProviderFacts,
  type PublicArchiveDiscoverRequest,
} from '../../src/platform/archive-public-providers';

const facts = (): ArchiveProviderFacts => ({
  providerId: 'loc',
  sourceUrl: 'https://www.loc.gov/item/00694220/',
  mimeType: 'video/mp4',
  videoCodec: null,
  audioCodec: null,
  width: null,
  height: null,
  representationRole: 'derivative',
  contentRole: null,
  rights: 'Source rights: https://www.loc.gov/legal/',
  licenseUrl: null,
  attribution: 'Library of Congress',
  downloadAllowed: true,
  accessRestricted: false,
  playbackCandidate: true,
  downloadSupported: false,
  unsupportedReason: null,
});
const file = () => ({
  fileRef: 'a'.repeat(64),
  title: 'The great train robbery',
  fileName: '00000765.mp4',
  itemId: '00694220',
  format: 'video/mp4',
  sizeBytes: null,
  durationSeconds: null,
  availability: 'unverified',
  observedMs: 1,
  providerFacts: facts(),
});
const title = () => ({
  favorite: false,
  titleRef: 'b'.repeat(64),
  title: 'The great train robbery',
  kind: 'movie',
  releaseYear: 1903,
  curated: false,
  titleProvenance: 'provider-item',
  fileCount: 2,
  durationSeconds: null,
  rights: 'See https://www.loc.gov/legal/',
  rank: 1,
  quality: 'metadata-listed',
  observedMs: 1,
  providerId: 'loc',
  sourceUrl: 'https://www.loc.gov/item/00694220/',
});
const request: PublicArchiveDiscoverRequest = {
  schemaVersion: 1,
  expectedRevision: '4',
  query: 'moon',
  decade: null,
  languageMode: 'all',
  contentType: 'all',
  curatedOnly: false,
  favoritesOnly: false,
  restart: false,
  explicitAction: true,
};
const receipt = () => ({
  schemaVersion: 1,
  committed: true,
  revision: '5',
  examined: 2,
  admitted: 1,
  more: true,
  providers: [
    {
      providerId: 'loc',
      state: 'partial',
      examined: 1,
      admitted: 1,
      retryAfterMs: null,
      reason: null,
    },
    {
      providerId: 'nasa',
      state: 'complete',
      examined: 1,
      admitted: 0,
      retryAfterMs: null,
      reason: null,
    },
    {
      providerId: 'commons',
      state: 'configuration-required',
      examined: 0,
      admitted: 0,
      retryAfterMs: null,
      reason: 'public-contact-required',
    },
  ],
});
describe('provider-qualified archive facts', () => {
  it('retains a versioned NASA created-date claim without making it a release date', () => {
    const dateClaims = {
      schemaVersion: 1,
      providerCreated: {
        field: 'date_created',
        value: '2021-01-30T00:00:00Z',
        provenance: 'provider-search-record',
      },
    };
    const result = validateArchiveProviderFacts({
      ...facts(),
      providerId: 'nasa',
      sourceUrl: 'https://images-assets.nasa.gov/video/Apollo/collection.json',
      dateClaims,
    });
    expect(result).toMatchObject({ dateClaims });
    expect(validateArchiveProviderFacts(facts())).not.toHaveProperty('dateClaims');
  });
  it.each([
    {
      schemaVersion: 2,
      providerCreated: {
        field: 'date_created',
        value: '2021-01-30T00:00:00Z',
        provenance: 'provider-search-record',
      },
    },
    {
      schemaVersion: 1,
      providerCreated: {
        field: 'release_date',
        value: '2021-01-30T00:00:00Z',
        provenance: 'provider-search-record',
      },
    },
    {
      schemaVersion: 1,
      providerCreated: {
        field: 'date_created',
        value: '2021-02-30T00:00:00Z',
        provenance: 'provider-search-record',
      },
    },
    ...[
      '2021-01-30T24:00:00Z',
      '2021-01-30T00:60:00Z',
      '2021-01-30T00:00:00+24:00',
      '2021-01-30T00:00:00+00:60',
    ].map((value) => ({
      schemaVersion: 1,
      providerCreated: { field: 'date_created', value, provenance: 'provider-search-record' },
    })),
    {
      schemaVersion: 1,
      providerCreated: {
        field: 'date_created',
        value: '2021-01-30T00:00:00Z',
        provenance: 'original-release',
      },
    },
  ])('refuses malformed or unsupported NASA date claims %#', (dateClaims) => {
    expect(() =>
      validateArchiveProviderFacts({
        ...facts(),
        providerId: 'nasa',
        sourceUrl: 'https://images-assets.nasa.gov/video/Apollo/collection.json',
        dateClaims,
      }),
    ).toThrow();
  });
  it.each([
    ['Apollo 14 Launch Coverage', 'Apollo%2014%20Launch%20Coverage'],
    [
      'Apollo 14 ‘A Wild Place Up Here’',
      'Apollo%2014%20%E2%80%98A%20Wild%20Place%20Up%20Here%E2%80%99',
    ],
  ])(
    'retains literal NASA ID %s through source, title and file DTO validation',
    (itemId, segment) => {
      const sourceUrl = `https://images-assets.nasa.gov/video/${segment}/collection.json`;
      expect(publicArchiveNasaItemId(itemId)).toBe(true);
      expect(publicArchiveSource(sourceUrl, 'nasa')).toBe(true);
      const f = file();
      f.itemId = itemId;
      f.providerFacts = { ...facts(), providerId: 'nasa', sourceUrl };
      expect(validateArchiveFile(f).itemId).toBe(itemId);
      expect(validateArchiveTitle({ ...title(), providerId: 'nasa', sourceUrl }).sourceUrl).toBe(
        sourceUrl,
      );
    },
  );
  it('keeps NASA identity and encoded provenance bounded without accepting path or query syntax', () => {
    for (const itemId of [
      '',
      '.',
      '..',
      ' lead',
      'trail ',
      'a/b',
      'a\\b',
      'a?b',
      'a#b',
      'a%2fb',
      'a\nvalue',
      'a\u200bvalue',
      'é'.repeat(257),
    ]) {
      expect(publicArchiveNasaItemId(itemId), itemId).toBe(false);
      const f = file();
      f.itemId = itemId;
      f.providerFacts = {
        ...facts(),
        providerId: 'nasa',
        sourceUrl: 'https://images-assets.nasa.gov/video/Apollo/collection.json',
      };
      expect(() => validateArchiveFile(f), itemId).toThrow();
    }
    for (const sourceUrl of [
      'https://images-assets.nasa.gov.evil.invalid/video/Apollo/collection.json',
      'https://user@images-assets.nasa.gov/video/Apollo/collection.json',
      'https://images-assets.nasa.gov/video/a%2Fb/collection.json',
      'https://images-assets.nasa.gov/video/a%5Cb/collection.json',
      'https://images-assets.nasa.gov/video/%2E%2E/collection.json',
      'https://images-assets.nasa.gov/video/a%3Fb/collection.json',
      'https://images-assets.nasa.gov/video/a%23b/collection.json',
      'https://images-assets.nasa.gov/video/a%252Fb/collection.json',
      'https://images-assets.nasa.gov/video/a%E2%80%8Bb/collection.json',
      'https://images-assets.nasa.gov/video/%41pollo/collection.json',
      'https://images-assets.nasa.gov/video/Apollo/collection.json?x=1',
      'https://images-assets.nasa.gov/video/Apollo/collection.json#x',
    ])
      expect(publicArchiveSource(sourceUrl, 'nasa'), sourceUrl).toBe(false);
  });
  it('keeps separate provider variants with the same filename and refuses repeated file references', () => {
    const query = {
      schemaVersion: 1 as const,
      titleRef: 'b'.repeat(64),
      expectedRevision: '4',
      offset: 0,
      pageSize: 20,
    };
    const first = file(),
      second = { ...file(), fileRef: 'c'.repeat(64) };
    const page = {
      schemaVersion: 1,
      revision: '4',
      titleRef: query.titleRef,
      totalCount: 2,
      offset: 0,
      files: [first, second],
      more: false,
    };
    expect(validateArchiveFilesPage(page, query).files).toHaveLength(2);
    expect(() => validateArchiveFilesPage({ ...page, files: [first, first] }, query)).toThrow();
  });
  it('retains unknown derivative size and codecs without borrowing an original claim', () => {
    expect(validateArchiveFile(file())).toMatchObject({
      sizeBytes: null,
      providerFacts: { videoCodec: null, downloadSupported: false },
    });
    expect(validateArchiveTitle(title())).toMatchObject({
      quality: 'metadata-listed',
      providerId: 'loc',
    });
  });
  it('retains unsupported disc inventory with an explicit non-playable reason', () => {
    const f = file();
    f.fileName = 'original.iso';
    f.format = 'ISO';
    f.providerFacts.playbackCandidate = false;
    f.providerFacts.unsupportedReason = 'This disc image cannot be played by this app.';
    expect(validateArchiveFile(f).providerFacts?.playbackCandidate).toBe(false);
    f.providerFacts.unsupportedReason = null;
    expect(() => validateArchiveFile(f)).toThrow();
  });
  it.each([
    'https://www.loc.gov.evil.example/item/00694220/',
    'http://www.loc.gov/item/00694220/',
    'https://www.loc.gov/item/00694220/?media=1',
    'https://user:pass@www.loc.gov/item/00694220/',
    'https://www.loc.gov/item/00694220/#x',
  ])('refuses ungrounded source provenance %s', (sourceUrl) =>
    expect(() => validateArchiveProviderFacts({ ...facts(), sourceUrl })).toThrow(),
  );
  it('rejects an arbitrary media locator or unknown authority field in the DTO', () => {
    expect(() =>
      validateArchiveProviderFacts({ ...facts(), targetUrl: 'https://tile.loc.gov/file.mp4' }),
    ).toThrow();
    expect(() => validateArchiveProviderFacts({ ...facts(), downloadSupported: true })).toThrow();
    expect(() => validateArchiveProviderFacts({ ...facts(), accessRestricted: true })).toThrow();
  });
  it('does not relax IA file integrity metadata or invent provider quality', () => {
    const legacy = { ...file() };
    delete (legacy as Partial<typeof legacy>).providerFacts;
    expect(() => validateArchiveFile(legacy)).toThrow();
    expect(() => validateArchiveFile({ ...legacy, format: 'h.264', sizeBytes: '0' })).toThrow();
    expect(() => validateArchiveTitle({ ...title(), quality: 'metadata-h264' })).toThrow();
  });
  it('validates provider-native identity independently of labels', () => {
    const f = file();
    f.itemId = '91010657';
    f.providerFacts = {
      ...facts(),
      providerId: 'commons',
      sourceUrl: 'https://commons.wikimedia.org/?curid=91010657',
    };
    expect(validateArchiveFile(f).itemId).toBe('91010657');
    expect(() => validateArchiveFile({ ...f, itemId: 'File:private' })).toThrow();
  });
});
describe('bounded public discovery receipts', () => {
  it('does not claim public year-curation or acquire an unnamed broad query', () => {
    expect(() =>
      validatePublicArchiveDiscoverRequest({ ...request, query: '', decade: 1970 }),
    ).toThrow();
  });
  it('keeps partial and app-configuration outcomes truthful', () => {
    expect(validatePublicArchiveDiscoverReceipt(receipt(), request).providers[2].state).toBe(
      'configuration-required',
    );
  });
  it.each(['duplicate', 'count', 'revision', 'bound', 'authority'] as const)(
    'refuses malformed %s receipts',
    (mode) => {
      const r = receipt();
      if (mode === 'duplicate') r.providers[2].providerId = 'loc';
      if (mode === 'count') r.examined = 3;
      if (mode === 'revision') r.revision = '4';
      if (mode === 'bound') {
        r.providers[0].examined = 5;
        r.examined = 6;
      }
      if (mode === 'authority') r.providers[2].reason = 'https://secret.example/';
      expect(() => validatePublicArchiveDiscoverReceipt(r, request)).toThrow();
    },
  );
  it('uses the existing owned native command and preserves nested request identity', async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const catalog = createArchiveCatalog({
      idFactory: () => 'owned-public-request',
      invoke: async (command, args) => {
        calls.push({ command, args });
        return receipt();
      },
    });
    await expect(catalog.publicDiscoverStep(request)).resolves.toMatchObject({ revision: '5' });
    expect(calls).toEqual([
      {
        command: 'public_archive_discover_step',
        args: { request: { ...request, requestId: 'owned-public-request' } },
      },
    ]);
  });
});
describe('actual media MIME capabilities', () => {
  const base = {
    kind: 'started',
    schemaVersion: 1,
    sessionGeneration: '1',
    mediaUrl: `http://127.0.0.1:12345/archive/${'a'.repeat(64)}/${'b'.repeat(64)}.mp4`,
    leaseMs: 60000,
    cleanupPending: false,
  };
  it('retains legacy MP4 and admits only an explicitly typed WebM capability', () => {
    expect(validateArchivePlaybackReceipt(base).mediaUrl).toBe(base.mediaUrl);
    const webm = {
      ...base,
      mediaUrl: base.mediaUrl.replace('.mp4', '.webm'),
      mimeType: 'video/webm',
    };
    expect(validateArchivePlaybackReceipt(webm).mimeType).toBe('video/webm');
    expect(() => validateArchivePlaybackReceipt({ ...webm, mimeType: 'video/mp4' })).toThrow();
    expect(() => validateArchivePlaybackReceipt({ ...base, mimeType: 'video/webm' })).toThrow();
    expect(() => validateArchivePlaybackReceipt({ ...webm, mimeType: undefined })).toThrow();
  });
});
