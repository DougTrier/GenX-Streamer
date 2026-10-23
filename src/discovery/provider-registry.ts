import defaults from './providers.json';
import { GUIDE_SOURCE_LIMIT } from '../guide/limits';
import type { ReviewedGuideProvider } from '../guide/discovery';
import { validateSource } from '../catalog/codec';
import { boundedUtf8Text } from '../platform/bounded-text';

export interface ReviewedChannelProvider {
  id: string;
  name: string;
  location: string;
  provenance: string;
  allowHttp?: boolean;
}
export interface ProviderRegistry {
  schemaVersion: 1;
  reviewedChannelProviders: ReviewedChannelProvider[];
  reviewedGuideProviders: ReviewedGuideProvider[];
}
export const MAX_PROVIDER_REGISTRY_BYTES = 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function field(value: unknown, limit: number): asserts value is string {
  if (
    !boundedUtf8Text(value, limit) ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('Provider metadata is invalid or exceeds its limit.');
}

/** URL identity only. Network admission/DNS/redirect checks remain with the acquisition owner. */
export function canonicalProviderLocation(location: string, allowHttp = false): string {
  field(location, 16_384);
  if (
    !/^https?:\/\//iu.test(location) ||
    /[\s\\]/u.test(location) ||
    /%(?![a-f\d]{2})/iu.test(location)
  )
    throw new Error('Provider URL is invalid.');
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new Error('Provider URL is invalid.');
  }
  if (url.username || url.password || url.hash || location.includes('#'))
    throw new Error('Provider URLs cannot contain credentials or fragments.');
  // Share catalog scheme and explicit HTTP permission validation.
  validateSource({ id: 'provider', name: 'provider', kind: 'url', location, allowHttp });
  field(url.href, 16_384);
  return url.href;
}
function descriptor(value: unknown): ReviewedChannelProvider {
  if (!object(value)) throw new Error('Provider descriptor is invalid.');
  field(value.id, 256);
  field(value.name, 512);
  field(value.provenance, 2048);
  if (value.allowHttp !== undefined && typeof value.allowHttp !== 'boolean')
    throw new Error('Provider HTTP permission is invalid.');
  const allowHttp = value.allowHttp === true;
  const location = canonicalProviderLocation(value.location as string, allowHttp);
  const provenance = canonicalProviderLocation(value.provenance);
  field(provenance, 2048);
  return { id: value.id, name: value.name, location, provenance, allowHttp };
}
function entries<T>(input: unknown, validate: (entry: unknown) => T, limit = 100): T[] {
  if (!Array.isArray(input) || input.length > limit)
    throw new Error(`Provider registry supports at most ${limit} providers of this type.`);
  const ids = new Set<string>();
  const locations = new Set<string>();
  return input.map((entry) => {
    const value = validate(entry);
    const identity = value as ReviewedChannelProvider;
    if (ids.has(identity.id) || locations.has(identity.location))
      throw new Error('Provider registry contains duplicate identities or URLs.');
    ids.add(identity.id);
    locations.add(identity.location);
    return value;
  });
}
export function validateChannelProviders(input: unknown): ReviewedChannelProvider[] {
  return entries(input, descriptor);
}
export function validateGuideProviders(input: unknown): ReviewedGuideProvider[] {
  return entries(
    input,
    (value) => {
      if (!object(value)) throw new Error('Guide provider descriptor is invalid.');
      if (value.allowHttp !== undefined)
        throw new Error('Guide discovery cannot grant HTTP source permission.');
      const base = descriptor(value);
      field(value.limitations, 2048);
      return {
        id: base.id,
        name: base.name,
        location: base.location,
        provenance: base.provenance,
        limitations: value.limitations,
      };
    },
    GUIDE_SOURCE_LIMIT,
  );
}
export function validateProviderRegistry(input: unknown): ProviderRegistry {
  if (!object(input) || input.schemaVersion !== 1)
    throw new Error('Unsupported provider registry schema.');
  return {
    schemaVersion: 1,
    reviewedChannelProviders: validateChannelProviders(input.reviewedChannelProviders),
    reviewedGuideProviders: validateGuideProviders(input.reviewedGuideProviders),
  };
}
/** Fresh editable configuration, never network work or engine defaults. Empty user arrays stay empty. */
/** A fresh profile contains no configured channel or guide acquisitions. */
export const defaultProviderRegistry = (): ProviderRegistry => validateProviderRegistry(defaults);
export function parseProviderRegistry(text: string): ProviderRegistry {
  if (!boundedUtf8Text(text, MAX_PROVIDER_REGISTRY_BYTES))
    throw new Error('Provider registry exceeds 1 MiB.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Provider registry is invalid JSON.');
  }
  return validateProviderRegistry(value);
}
export function serializeProviderRegistry(value: ProviderRegistry): string {
  const text = JSON.stringify(validateProviderRegistry(value), null, 2);
  if (!boundedUtf8Text(text, MAX_PROVIDER_REGISTRY_BYTES))
    throw new Error('Provider registry exceeds 1 MiB.');
  return text;
}
