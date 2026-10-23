import { parseM3u } from './parser';
import { exactCandidateDedup } from './collector';
self.onmessage = (event: MessageEvent<{ text: string; sourceId: string }>) => {
  try {
    const result = parseM3u(event.data.text, event.data.sourceId);
    result.channels = exactCandidateDedup(result.channels);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : 'Playlist parsing failed.',
    });
  }
};
