import { extractPageCandidates, DiscoveryInputError, type DiscoveryPage } from './candidates';

self.onmessage = (event: MessageEvent<{ page: DiscoveryPage }>) => {
  try {
    self.postMessage({ ok: true, result: extractPageCandidates(event.data.page) });
  } catch (error) {
    self.postMessage({
      ok: false,
      error:
        error instanceof DiscoveryInputError
          ? error.message
          : 'The page references could not be read safely.',
    });
  }
};
