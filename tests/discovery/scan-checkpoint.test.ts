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

import { checkpointProviders } from './helpers/scan-checkpoint';
import { expect, it } from 'vitest';
import { checkpointFixture } from './helpers/scan-checkpoint';
import {
  parseScanCheckpoint,
  prepareScanCheckpoint,
  serializeScanCheckpoint,
  validateScanCheckpoint,
  fingerprintScanSource,
  fingerprintScanPolicy,
  canResumeScanCheckpoint,
  validateCheckpointPublishedTargets,
  validateCheckpointSourceAdmission,
} from '../../src/discovery/scan-checkpoint';
// Same immutable inputs as the native shared-vector fixture; editable defaults are separate.
const originalProviders = [
  {
    id: 'iptv-org-global',
    name: 'IPTV.org global channels',
    location: 'https://iptv-org.github.io/iptv/index.m3u',
    provenance: 'https://github.com/iptv-org/iptv',
    allowHttp: false,
  },
  {
    id: 'free-tv-public',
    name: 'Free-TV public channels',
    location: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8',
    provenance: 'https://github.com/Free-TV/IPTV',
    allowHttp: false,
  },
];
it('roundtrips exact captured identities, source SHA and public stream queries without mutation', async () => {
  const checkpoint = await checkpointFixture();
  checkpoint.policyFingerprint = await fingerprintScanPolicy({
    providers: originalProviders,
    budgetMs: checkpoint.budgetMs,
    platform: checkpoint.platform,
    observerProfile: checkpoint.observerProfile,
    sourceDefinitions: checkpoint.sourceDefinitions,
  });
  const before = structuredClone(checkpoint);
  expect(await parseScanCheckpoint(await serializeScanCheckpoint(checkpoint))).toEqual(checkpoint);
  expect(checkpoint).toEqual(before);
  expect(checkpoint.sourceDefinitions[0].definitionFingerprint).toBe(
    '7180d692189df916a2c430928b7b7ac4442b2512151a5f7b106ba667cc738a0b',
  );
  expect(checkpoint.policyFingerprint).toBe(
    'b59abac492a7017a0044bc08bbf63a585ca5d9155d46384f8b179595b6afb842',
  );
  expect(checkpoint.sourceDefinitions[0].definitionFingerprint).toBe(
    await fingerprintScanSource(checkpoint.sourceDefinitions[0].source),
  );
});
it.each([
  'source-query',
  'custom-source',
  'source-sha',
  'stream-userinfo',
  'account-path',
  'observation-key',
  'fingerprint',
  'platform',
  'verdict',
  'canceled',
  'published-key',
  'duplicate-key',
  'raw-error',
])('refuses unsafe or mismatched %s data as a whole', async (kind) => {
  const c = await checkpointFixture();
  if (kind === 'source-query') c.sourceDefinitions[0].source.location += '?token=sentinel';
  if (kind === 'custom-source')
    c.sourceDefinitions[0].source.location = 'https://custom.invalid/feed';
  if (kind === 'source-sha') c.sourceDefinitions[0].definitionFingerprint = '0'.repeat(64);
  if (kind === 'stream-userinfo')
    c.review.candidates[0].channel.urls[0] = 'https://user:sentinel@fixture.invalid/feed';
  if (kind === 'account-path')
    c.review.candidates[0].channel.urls[0] = 'https://fixture.invalid/live/user/sentinel/1.ts';
  if (kind === 'observation-key') c.observations[0].channelId = 'other';
  if (kind === 'fingerprint') c.observations[0].fingerprint = 'other';
  if (kind === 'platform') c.observations[0].platform = 'android';
  if (kind === 'verdict') c.observations[0].verdict = 'PlayedHere';
  if (kind === 'canceled') {
    c.observations[0].verdict = 'Canceled';
    c.observations[0].evidence = { kind: 'canceled' };
  }
  if (kind === 'published-key') c.publishedKeys = ['other'];
  if (kind === 'duplicate-key') c.review.candidates.push(c.review.candidates[0]);
  if (kind === 'raw-error') Reflect.set(c.review.sources[0], 'error', 'sentinel');
  await expect(validateScanCheckpoint(c)).rejects.toThrow();
});
it('requires fresh exact revision and configuration to resume, with a 24-hour expiry', async () => {
  const c = await checkpointFixture();
  expect(canResumeScanCheckpoint(c, 1000, '0', c.policyFingerprint)).toBe(true);
  expect(canResumeScanCheckpoint(c, 999, '0', c.policyFingerprint)).toBe(false);
  expect(canResumeScanCheckpoint(c, 1000 + 86400000, '0', c.policyFingerprint)).toBe(false);
  expect(canResumeScanCheckpoint(c, 1000, '1', c.policyFingerprint)).toBe(false);
  expect(canResumeScanCheckpoint(c, 1000, '0', 'other')).toBe(false);
  expect(
    await fingerprintScanPolicy({
      providers: null,
      budgetMs: 20000,
      platform: 'browser',
      observerProfile: 'fixture',
      sourceDefinitions: c.sourceDefinitions,
    }),
  ).not.toBe(c.policyFingerprint);
});
it('matches ACK targets with retained alternates but refuses absent or different saved stream', async () => {
  const c = await checkpointFixture(true),
    candidate = c.review.candidates[0].channel;
  const catalog = {
    schemaVersion: 1 as const,
    sources: [c.sourceDefinitions[0].source],
    channels: [
      { ...candidate, id: 'canonical', urls: ['https://alternate.invalid', ...candidate.urls] },
    ],
  };
  expect(() => validateCheckpointPublishedTargets(c, catalog)).not.toThrow();
  catalog.channels[0].urls = ['https://different.invalid'];
  expect(() => validateCheckpointPublishedTargets(c, catalog)).toThrow();
});
it('refuses oversized serialized scope and excess candidates without truncation', async () => {
  await expect(parseScanCheckpoint(' '.repeat(20 * 1024 * 1024 + 1))).rejects.toThrow();
  const c = await checkpointFixture();
  c.review.candidates.length = 100001;
  await expect(validateScanCheckpoint(c)).rejects.toThrow();
});

it('retains pending HTTP candidates without inventing an HTTP permission grant', async () => {
  const c = await checkpointFixture();
  c.review.candidates[0].channel.urls = ['http://public.fixture.invalid/feed'];
  c.observations = [];
  c.publishedKeys = [];
  const parsed = await validateScanCheckpoint(c);
  expect(parsed.sourceDefinitions[0].source.allowHttp).toBe(false);
  expect(parsed.review.candidates[0].channel.urls[0]).toMatch(/^http:/);
});

it('preparation omits provider diagnostics but retains source identity and warning counts', async () => {
  const c = await checkpointFixture();
  const providers = checkpointProviders;
  c.review.sources[0].error = 'private-sentinel';
  c.review.sources[0].warningMessages = ['private-sentinel'];
  const { sourceDefinitions, policyFingerprint: _policy, schemaVersion: _schema, ...state } = c;
  const prepared = await prepareScanCheckpoint({
    ...state,
    sources: sourceDefinitions.map((item) => item.source),
    providers,
  });
  expect(JSON.stringify(prepared)).not.toContain('private-sentinel');
  expect(prepared.review.sources[0].warnings).toBe(0);
  expect(prepared.sourceDefinitions).toEqual(sourceDefinitions);
});

it('allows exactly one million indexed target comparisons and refuses the next without truncation', async () => {
  const c = await checkpointFixture(true);
  const original = c.review.candidates[0];
  c.review.candidates = Array.from({ length: 1001 }, (_, index) => ({
    ...original,
    key: `ack-${index}`,
  }));
  c.publishedKeys = c.review.candidates.slice(0, 1000).map((candidate) => candidate.key);
  const catalog = {
    schemaVersion: 1 as const,
    sources: [c.sourceDefinitions[0].source],
    channels: Array.from({ length: 1000 }, (_, index) => ({
      ...original.channel,
      id: `canonical-${index}`,
      urls: index === 999 ? [...original.channel.urls] : [`https://different.invalid/${index}`],
    })),
  };
  const before = structuredClone(catalog);
  expect(() => validateCheckpointPublishedTargets(c, catalog)).not.toThrow();
  c.publishedKeys.push('ack-1000');
  expect(() => validateCheckpointPublishedTargets(c, catalog)).toThrow(
    'Scan checkpoint target validation limit exceeded.',
  );
  expect(catalog).toEqual(before);
  expect(c.publishedKeys).toHaveLength(1001);
});

it('matches declared geography fields with retained extras but requires exact declared provenance', async () => {
  const c = await checkpointFixture(true);
  const candidate = c.review.candidates[0].channel;
  candidate.geography = { country: 'US' };
  const catalog = {
    schemaVersion: 1 as const,
    sources: [c.sourceDefinitions[0].source],
    channels: [{ ...candidate, id: 'canonical', geography: { country: 'US', state: 'US-IL' } }],
  };
  expect(() => validateCheckpointPublishedTargets(c, catalog)).not.toThrow();
  candidate.geographyProvenance = [
    { field: 'country', value: 'US', kind: 'm3u', sourceId: 'source', scope: 'channel-origin' },
  ];
  expect(() => validateCheckpointPublishedTargets(c, catalog)).toThrow();
  catalog.channels[0].geographyProvenance = structuredClone(candidate.geographyProvenance);
  expect(() => validateCheckpointPublishedTargets(c, catalog)).not.toThrow();
});

it('requires authoritative canonical admission for structurally valid custom/file checkpoints', async () => {
  for (const kind of ['url', 'file'] as const) {
    const value = await checkpointFixture();
    const source = {
      ...value.sourceDefinitions[0].source,
      kind,
      location: kind === 'file' ? 'owned.m3u' : 'https://custom.invalid/feed',
    };
    value.sourceDefinitions = [
      { source, definitionFingerprint: await fingerprintScanSource(source) },
    ];
    const decoded = await parseScanCheckpoint(await serializeScanCheckpoint(value));
    await validateCheckpointSourceAdmission(decoded, [source], []);
    await expect(validateCheckpointSourceAdmission(decoded, [], null)).rejects.toThrow();
    await expect(
      validateCheckpointSourceAdmission(decoded, [{ ...source, id: 'foreign' }], null),
    ).rejects.toThrow();
    await expect(
      validateCheckpointSourceAdmission(decoded, [{ ...source, allowHttp: true }], null),
    ).rejects.toThrow();
  }
});

it('the historical user-configured registry has a deterministic distinct policy without changing the fixed vector', async () => {
  const checkpoint = await checkpointFixture();
  const providers = checkpointProviders;
  expect(providers).toHaveLength(22);
  const scope = {
    budgetMs: checkpoint.budgetMs,
    platform: checkpoint.platform,
    observerProfile: checkpoint.observerProfile,
    sourceDefinitions: checkpoint.sourceDefinitions,
  };
  const current = await fingerprintScanPolicy({ ...scope, providers });
  expect(current).toBe(checkpoint.policyFingerprint);
  expect(await fingerprintScanPolicy({ ...scope, providers: structuredClone(providers) })).toBe(
    current,
  );
  const historical = await fingerprintScanPolicy({ ...scope, providers: originalProviders });
  expect(historical).toBe('b59abac492a7017a0044bc08bbf63a585ca5d9155d46384f8b179595b6afb842');
  expect(current).not.toBe(historical);
  expect(canResumeScanCheckpoint(checkpoint, 1000, '0', historical)).toBe(false);
});

it('unpublished checkpoint authority comes from current exact user choices, including HTTP grant', async () => {
  const c = await checkpointFixture();
  const source = {
    ...c.sourceDefinitions[0]!.source,
    location: 'https://user.fixture.invalid/catalog',
  };
  c.sourceDefinitions = [{ source, definitionFingerprint: await fingerprintScanSource(source) }];
  const providers = [
    {
      id: 'selected',
      name: 'Selected online directory',
      location: source.location,
      provenance: 'https://publisher.fixture.invalid/about',
      allowHttp: false,
    },
  ];
  await validateCheckpointSourceAdmission(c, [], providers);
  await expect(validateCheckpointSourceAdmission(c, [], [])).rejects.toThrow();
  await expect(validateCheckpointSourceAdmission(c, [], null)).rejects.toThrow();
  await expect(
    validateCheckpointSourceAdmission(c, [], [{ ...providers[0]!, allowHttp: true }]),
  ).rejects.toThrow();
  await validateCheckpointSourceAdmission(c, [source], []);
});
