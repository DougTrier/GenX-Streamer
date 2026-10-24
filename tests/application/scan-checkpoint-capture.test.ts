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

import { checkpointProviders } from '../discovery/helpers/scan-checkpoint';
import { expect, it } from 'vitest';
import {
  captureScanCheckpoint,
  parseCapturedScanCheckpoint,
  type ScanCheckpointCaptureInput,
} from '../../src/application/scan-checkpoint-capture';
import { checkpointFixture } from '../discovery/helpers/scan-checkpoint';

async function input(): Promise<ScanCheckpointCaptureInput> {
  const {
    schemaVersion: _schema,
    sourceDefinitions,
    policyFingerprint: _policy,
    ...state
  } = await checkpointFixture();
  return {
    ...state,
    sources: sourceDefinitions.map((definition) => definition.source),
    providers: checkpointProviders,
  };
}
it('prepares and parses immutable captured identities and public stream queries off UI', async () => {
  const value = await input(),
    before = structuredClone(value);
  const serialized = await captureScanCheckpoint(value);
  expect(serialized).not.toBeNull();
  const parsed = await parseCapturedScanCheckpoint(serialized!);
  expect(parsed.review.sessionRevision).toBe('runtime-capture');
  expect(parsed.observations).toEqual(value.observations);
  expect(parsed.sourceDefinitions[0].definitionFingerprint).toBe(
    '7180d692189df916a2c430928b7b7ac4442b2512151a5f7b106ba667cc738a0b',
  );
  expect(value).toEqual(before);
});
it('returns deliberate unsupported scope for custom URL and file sources', async () => {
  const value = await input();
  value.sources = [{ ...value.sources[0], location: 'https://custom.invalid/feed' }];
  expect(await captureScanCheckpoint(value)).toBeNull();
  value.sources = [{ ...value.sources[0], kind: 'file', location: 'fixture.m3u' }];
  expect(await captureScanCheckpoint(value)).toBeNull();
});
it('returns deliberate whole-size refusal rather than truncating a review', async () => {
  const value = await input();
  value.review.query = 'x'.repeat(20 * 1024 * 1024);
  expect(await captureScanCheckpoint(value)).toBeNull();
});
it('corrupt supported captures and saved bodies reject instead of silently becoming unsupported', async () => {
  const value = await input();
  value.catalogRevision = '9223372036854775808';
  await expect(captureScanCheckpoint(value)).rejects.toThrow();
  await expect(parseCapturedScanCheckpoint('{"secret":"sentinel"}')).rejects.toThrow();
});

it.each([
  'https://fixture.invalid/live/user/password/channel',
  'https://fixture.invalid/player_api.php',
  'https://fixture.invalid/bad%path',
])(
  'refuses the complete checkpoint for excluded candidate URL %s without dropping candidates',
  async (url) => {
    const value = await input();
    value.review.candidates[0].channel.urls = [url];
    const original = structuredClone(value);
    expect(await captureScanCheckpoint(value)).toBeNull();
    expect(value).toEqual(original);
    value.review.candidates[0].sourceId = 'foreign';
    await expect(captureScanCheckpoint(value)).rejects.toThrow();
  },
);

it('excluded URLs do not conceal invalid health or published ownership', async () => {
  const value = await input();
  value.review.candidates[0].channel.urls = ['https://fixture.invalid/live/user/password/channel'];
  value.observations[0].sourceId = 'foreign';
  await expect(captureScanCheckpoint(value)).rejects.toThrow();
  value.observations[0].sourceId = value.sources[0].id;
  value.publishedKeys = ['foreign'];
  await expect(captureScanCheckpoint(value)).rejects.toThrow();
});

it.each(['url', 'file'] as const)(
  'roundtrips canonical %s captured review without acquisition',
  async (kind) => {
    const value = await input();
    value.sources = [
      {
        ...value.sources[0],
        kind,
        location: kind === 'file' ? 'owned.m3u' : 'https://custom.invalid/feed',
      },
    ];
    value.canonicalSources = structuredClone(value.sources);
    const saved = await captureScanCheckpoint(value);
    expect(saved).not.toBeNull();
    const parsed = await parseCapturedScanCheckpoint(saved!);
    expect(parsed.sourceDefinitions[0].source).toEqual(value.sources[0]);
    expect(parsed.review.candidates).toEqual(value.review.candidates);
    expect(saved).not.toContain('canonicalSources');
    value.sources = [{ ...value.sources[0], allowHttp: true }];
    expect(await captureScanCheckpoint(value)).toBeNull();
  },
);
it('keeps mixed default/custom scopes whole and refuses foreign identities or changed configuration', async () => {
  const value = await input();
  const custom = { ...value.sources[0], id: 'custom', location: 'https://custom.invalid/feed' };
  value.sources = [...value.sources, custom];
  value.canonicalSources = [structuredClone(custom)];
  value.review.sources.push({
    sourceId: custom.id,
    fingerprint: 'custom-fingerprint',
    status: 'failed',
    inspected: 0,
    matched: 0,
    warnings: 0,
  });
  value.review.counts.failedSources = 1;
  const serialized = await captureScanCheckpoint(value);
  expect((await parseCapturedScanCheckpoint(serialized!)).sourceDefinitions).toHaveLength(2);
  value.canonicalSources = [{ ...custom, id: 'foreign' }];
  expect(await captureScanCheckpoint(value)).toBeNull();
  value.canonicalSources = [custom];
  value.providers = [];
  expect(await captureScanCheckpoint(value)).toBeNull();
});

it('canonical authorization never admits secret query/account source locations', async () => {
  for (const location of [
    'https://custom.invalid/feed?token=sentinel',
    'https://custom.invalid/live/user/secret/catalog',
  ]) {
    const value = await input();
    value.sources = [{ ...value.sources[0], location }];
    value.canonicalSources = structuredClone(value.sources);
    expect(await captureScanCheckpoint(value)).toBeNull();
  }
});

it('requires an exact explicit user provider for unpublished sources, never a factory directory', async () => {
  const value = await input();
  value.sources = [
    {
      ...value.sources[0]!,
      name: 'User chosen directory',
      location: 'https://user.fixture.invalid/catalog',
    },
  ];
  value.providers = [
    {
      id: 'user-selected',
      name: 'User selected',
      location: value.sources[0]!.location,
      provenance: 'https://publisher.fixture.invalid/about',
      allowHttp: false,
    },
  ];
  const serialized = await captureScanCheckpoint(value);
  expect(serialized).not.toBeNull();
  const saved = await parseCapturedScanCheckpoint(serialized!);
  expect(saved.sourceDefinitions[0]!.source).toEqual(value.sources[0]);
  value.providers = [];
  expect(await captureScanCheckpoint(value)).toBeNull();
  value.providers = null;
  expect(await captureScanCheckpoint(value)).toBeNull();
  value.providers = [
    {
      id: 'other',
      name: 'Other',
      location: 'https://other.fixture.invalid/catalog',
      provenance: 'https://publisher.fixture.invalid/about',
      allowHttp: false,
    },
  ];
  expect(await captureScanCheckpoint(value)).toBeNull();
  value.providers = [
    {
      id: 'user-selected',
      name: 'User selected',
      location: value.sources[0]!.location,
      provenance: 'https://publisher.fixture.invalid/about',
      allowHttp: true,
    },
  ];
  expect(await captureScanCheckpoint(value)).toBeNull();
  value.canonicalSources = structuredClone(value.sources);
  value.providers = [];
  expect(await captureScanCheckpoint(value)).not.toBeNull();
});
