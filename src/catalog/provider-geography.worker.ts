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
