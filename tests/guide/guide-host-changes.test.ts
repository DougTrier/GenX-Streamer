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

import { beforeEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({
  sources: vi.fn(),
  saveSource: vi.fn(),
  commitAndMatch: vi.fn(),
  removeSource: vi.fn(),
  saveMapping: vi.fn(),
  preview: vi.fn(),
  discard: vi.fn(),
  summary: vi.fn(),
  channelCoverage: vi.fn(),
}));
const cancel = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: cancel }));
vi.mock('../../src/guide/native', () => ({
  nativeGuide: { ...calls },
  previewNativeGuide: calls.preview,
  readSelectedGuide: calls.summary,
  readChannelGuideCoverage: calls.channelCoverage,
}));
import { createGuideHost } from '../../src/application/guide/guide-host';
const source = {
  id: 'g',
  name: 'Guide',
  location: 'https://fixture.invalid/guide',
  kind: 'url' as const,
  allowHttp: false,
  revision: 1,
  updatedMs: null,
};
const preview = { ticket: 'owned', sourceId: 'g', sourceRevision: 1 };
beforeEach(() => {
  for (const call of Object.values(calls)) call.mockReset();
  cancel.mockReset();
  calls.sources.mockResolvedValue([source]);
  calls.saveSource.mockResolvedValue(source);
  calls.preview.mockResolvedValue(preview);
  calls.commitAndMatch.mockResolvedValue({
    sourceRevision: 2,
    matched: 1,
    unmatched: 0,
    preservedMappings: 0,
  });
  calls.removeSource.mockResolvedValue(undefined);
  calls.saveMapping.mockResolvedValue(undefined);
});
it('routes complete summary requests and native cancellation through the same request identity', async () => {
  const { host, signal } = setup();
  const query = { catalogSourceId: 's', appChannelId: 'c', atMs: 1000, requestId: 'owned' };
  calls.summary.mockRejectedValue(new DOMException('Canceled', 'AbortError'));
  await expect(host.summary!(query, signal)).rejects.toThrow('Canceled');
  expect(calls.summary).toHaveBeenCalledWith(query, signal);
  cancel.mockResolvedValue(undefined);
  await host.cancelSummary!('owned');
  expect(cancel).toHaveBeenCalledWith('cancel_playlist', { requestId: 'owned' });
});
it('routes channel coverage with the exact source/channel/window fences and owned signal', async () => {
  const { host, signal, changed } = setup();
  const query = {
    schemaVersion: 1 as const,
    sourceId: 'g',
    xmltvChannelId: 'channel',
    startMs: 1000,
    endMs: 2000,
    expectedSourceRevision: 1,
    expectedPublishedRevision: 1,
  };
  calls.channelCoverage.mockRejectedValue(new Error('Coverage unavailable'));
  await expect(host.channelCoverage!(query, signal)).rejects.toThrow('Coverage unavailable');
  expect(calls.channelCoverage).toHaveBeenCalledExactlyOnceWith(query, signal);
  expect(changed).not.toHaveBeenCalled();
});
const setup = () => {
  const changed = vi.fn();
  const host = createGuideHost({
    channels: () => [],
    selectedChannel: () => null,
    watch: async () => {},
    onChanged: changed,
  });
  return { host, changed, signal: new AbortController().signal };
};
it('notifies persisted configuration even when acquisition fails, without claiming schedule publication', async () => {
  const { host, changed, signal } = setup();
  calls.sources.mockResolvedValue([]);
  calls.preview.mockRejectedValue(new Error('Fixture download failed'));
  await expect(
    host.preview(
      { name: 'New guide', location: source.location, kind: 'url', allowHttp: false },
      signal,
    ),
  ).rejects.toThrow('Fixture download failed');
  expect(changed).toHaveBeenCalledTimes(1);
  expect(calls.commitAndMatch).not.toHaveBeenCalled();
  calls.saveSource.mockRejectedValue(new Error('Fixture configuration failed'));
  await expect(
    host.preview(
      { name: 'New guide', location: source.location, kind: 'url', allowHttp: false },
      signal,
    ),
  ).rejects.toThrow('Fixture configuration failed');
  expect(changed).toHaveBeenCalledTimes(1);
});
it('notifies only acknowledged schedule, mapping and removal writes', async () => {
  const { host, changed, signal } = setup();
  await host.preview({ sourceId: 'g' }, signal);
  expect(changed).not.toHaveBeenCalled();
  calls.commitAndMatch.mockRejectedValueOnce(new Error('Fixture commit failed'));
  await expect(host.commitPreview('owned', signal)).rejects.toThrow('Fixture commit failed');
  expect(changed).not.toHaveBeenCalled();
  await expect(host.commitPreview('owned', signal)).resolves.toEqual({
    committed: true,
    matched: 1,
    unmatched: 0,
  });
  expect(changed).toHaveBeenCalledTimes(1);
  const mapping = {
    catalogSourceId: 's',
    appChannelId: 'c',
    guideSourceId: 'g',
    xmltvChannelId: 'x',
  };
  calls.saveMapping.mockRejectedValueOnce(new Error('Fixture mapping failed'));
  await expect(host.setMapping(mapping, signal)).rejects.toThrow();
  expect(changed).toHaveBeenCalledTimes(1);
  await host.setMapping(mapping, signal);
  await host.removeSource('g', signal);
  expect(changed).toHaveBeenCalledTimes(3);
});

it('rejects an invalid save receipt without announcing a completed guide installation', async () => {
  const { host, changed, signal } = setup();
  await host.preview({ sourceId: 'g' }, signal);
  calls.commitAndMatch.mockResolvedValueOnce({
    sourceRevision: 1,
    matched: -1,
    unmatched: 0,
    preservedMappings: 0,
  });
  await expect(host.commitPreview('owned', signal)).rejects.toThrow('receipt is invalid');
  expect(changed).not.toHaveBeenCalled();
});
