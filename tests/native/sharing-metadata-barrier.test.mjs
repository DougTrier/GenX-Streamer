import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armMetadataBarrier } from './sharing-metadata-barrier.mjs';

test('previous47s metadata cannot establish new0s sampling barrier', async () => {
  const video = new globalThis.EventTarget();
  video.currentSrc = 'old';
  video.currentTime = 47;
  assert.equal(armMetadataBarrier(video, 100), true);
  let observed = false;
  video.fixtureMetadataBarrier.result.then(() => {
    observed = true;
  });
  video.dispatchEvent(new globalThis.Event('loadedmetadata'));
  video.dispatchEvent(new globalThis.Event('loadstart'));
  video.dispatchEvent(new globalThis.Event('loadedmetadata'));
  await Promise.resolve();
  assert.equal(observed, false);
  video.currentSrc = 'new';
  video.currentTime = 0;
  video.dispatchEvent(new globalThis.Event('loadedmetadata'));
  assert.equal(await video.fixtureMetadataBarrier.result, true);
  const baseline = video.currentTime;
  video.currentTime = 0.8;
  assert.ok(video.currentTime > baseline + 0.5);
  assert.ok(video.currentTime < 47);
});
test('deadline and explicit cancel reject absent new metadata and remove listeners', async () => {
  const video = new globalThis.EventTarget();
  video.currentSrc = 'old';
  armMetadataBarrier(video, 5);
  assert.equal(await video.fixtureMetadataBarrier.result, false);
  armMetadataBarrier(video, 100);
  video.fixtureMetadataBarrier.cancel();
  assert.equal(await video.fixtureMetadataBarrier.result, false);
  video.currentSrc = 'late';
  video.dispatchEvent(new globalThis.Event('loadstart'));
  video.dispatchEvent(new globalThis.Event('loadedmetadata'));
  assert.equal(await video.fixtureMetadataBarrier.result, false);
});
