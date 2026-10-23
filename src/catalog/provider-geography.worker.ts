import {
  createProviderGeographyIndex,
  enrichProviderGeography,
  prepareProviderGeographyDocuments,
  type ProviderGeographyDocuments,
} from './provider-geography';
import type { ChannelCandidate, Source } from './parser';
self.onmessage = (
  event: MessageEvent<{
    documents: ProviderGeographyDocuments;
    source: Source;
    channels: ChannelCandidate[];
    rawCities?: string;
  }>,
) => {
  try {
    const { documents, source, channels, rawCities } = event.data;
    if (!Array.isArray(channels) || channels.length > 100000)
      throw new Error('Provider channel limit exceeded.');
    const compact = prepareProviderGeographyDocuments(documents, rawCities);
    const index = createProviderGeographyIndex(compact);
    const enriched = channels.map(
      (channel) =>
        enrichProviderGeography(channel, source, index, {
          allowedSourceLocations: [source.location],
        }).channel,
    );
    self.postMessage({ channels: enriched });
  } catch {
    self.postMessage({ error: true });
  }
};
