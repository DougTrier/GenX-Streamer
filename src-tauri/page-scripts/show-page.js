(() => {
  window.__genxVideo = false;
  if (window.__genxWatch) { window.__genxWatch.disconnect(); window.__genxWatch = null; }
  if (window.__genxRestore) window.__genxRestore();
  // YouTube chooses its own quality again outside full screen.
  try { document.getElementById('movie_player')?.setPlaybackQualityRange?.('auto', 'auto'); } catch { /* site's player */ }
  return 'page';
})()
