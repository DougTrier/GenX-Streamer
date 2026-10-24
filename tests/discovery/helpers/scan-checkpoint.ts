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

import researchProviders from '../../../docs/research-reviewed-providers.json';
export const checkpointProviders = researchProviders.reviewedChannelProviders;
import {
  fingerprintScanSource,
  fingerprintScanPolicy,
  type ScanCheckpoint,
} from '../../../src/discovery/scan-checkpoint';
export async function checkpointFixture(
  published = false,
  sourceId = 'source',
): Promise<ScanCheckpoint> {
  const providers = checkpointProviders;
  const source = {
    id: sourceId,
    name: 'Fixture public index',
    kind: 'url' as const,
    location: providers[0].location,
    allowHttp: false,
  };
  const sourceDefinitions = [
    { source, definitionFingerprint: await fingerprintScanSource(source) },
  ];
  const checkpoint: ScanCheckpoint = {
    schemaVersion: 1,
    jobId: 'fixture-job',
    createdAtMs: 1000,
    catalogRevision: '0',
    policyFingerprint: '',
    sourceDefinitions,
    budgetMs: 20000,
    platform: 'browser',
    observerProfile: 'fixture',
    review: {
      sessionRevision: 'runtime-capture',
      query: '',
      status: 'completed',
      sources: [
        {
          sourceId,
          fingerprint: 'captured-fingerprint',
          status: 'completed',
          inspected: 1,
          matched: 1,
          warnings: 0,
        },
      ],
      candidates: [
        {
          key: 'captured-key',
          sourceId,
          sourceFingerprint: 'captured-fingerprint',
          sessionRevision: 'runtime-capture',
          channel: {
            sourceId,
            name: 'Live',
            category: 'General',
            urls: ['https://fixture.invalid/live?public=1'],
          },
        },
      ],
      counts: { inspected: 1, matched: 1, failedSources: 0, canceledSources: 0 },
    },
    observations: [
      {
        channelId: 'captured-key',
        sourceId,
        fingerprint: 'captured-fingerprint',
        platform: 'browser',
        observedAt: 1000,
        verdict: 'Reachable',
        evidence: { kind: 'recognized-media-response' },
      },
    ],
    publishedKeys: published ? ['captured-key'] : [],
  };
  checkpoint.policyFingerprint = await fingerprintScanPolicy({
    providers,
    budgetMs: checkpoint.budgetMs,
    platform: checkpoint.platform,
    observerProfile: checkpoint.observerProfile,
    sourceDefinitions,
  });
  return checkpoint;
}
