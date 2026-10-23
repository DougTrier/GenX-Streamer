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
