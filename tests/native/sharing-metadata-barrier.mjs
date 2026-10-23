// Serialized directly into the isolated fixture page; no application globals.
export function armMetadataBarrier(video, timeoutMs = 20000) {
  video.fixtureMetadataBarrier?.cancel();
  const previousSource = video.currentSrc;
  let reset = false;
  let finish;
  let settled = false;
  const result = new Promise((resolve) => {
    finish = resolve;
  });
  const cleanup = (observed) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    video.removeEventListener('emptied', onReset);
    video.removeEventListener('loadstart', onReset);
    video.removeEventListener('loadedmetadata', onMetadata);
    finish(observed);
  };
  const onReset = () => {
    reset = true;
  };
  const onMetadata = () => {
    if (reset && video.currentSrc !== previousSource && video.currentSrc !== '') cleanup(true);
  };
  const timer = setTimeout(() => cleanup(false), timeoutMs);
  video.addEventListener('emptied', onReset);
  video.addEventListener('loadstart', onReset);
  video.addEventListener('loadedmetadata', onMetadata);
  video.fixtureMetadataBarrier = { result, cancel: () => cleanup(false) };
  return true;
}
