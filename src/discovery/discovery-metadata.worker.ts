import { compactDiscoveryMetadata } from './discovery-metadata';

self.onmessage = (event: MessageEvent<{ channels: string; blocklist?: string }>) => {
  try {
    self.postMessage({
      metadata: compactDiscoveryMetadata(event.data.channels, event.data.blocklist),
    });
  } catch {
    self.postMessage({ error: true });
  }
};
