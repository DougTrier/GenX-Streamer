'use strict';

for (const controls of document.querySelectorAll('[data-video-speed]')) {
  const video = controls.closest('figure')?.querySelector('video');
  const speed = controls.querySelector('select');
  if (!video || !speed) continue;

  speed.addEventListener('change', () => {
    const rate = Number(speed.value);
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
  });
  video.addEventListener('ratechange', () => {
    const option = [...speed.options].find(({ value }) => Number(value) === video.playbackRate);
    speed.selectedIndex = option ? option.index : -1;
  });
  controls.hidden = false;
}
