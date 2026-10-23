import { expect, it } from 'vitest';
import {
  canonicalProviderLocation,
  defaultProviderRegistry,
  parseProviderRegistry,
  serializeProviderRegistry,
  validateProviderRegistry,
  type ProviderRegistry,
} from '../../src/discovery/provider-registry';

const registry = (): ProviderRegistry => ({
  schemaVersion: 1,
  reviewedChannelProviders: [
    {
      id: 'one',
      name: 'Channel catalogs',
      location: 'https://example.invalid/catalog',
      provenance: 'https://publisher.invalid/docs',
    },
  ],
  reviewedGuideProviders: [
    {
      id: 'one',
      name: 'Guide schedules',
      location: 'https://example.invalid/guide',
      provenance: 'https://publisher.invalid/docs',
      limitations: 'Coverage requires review.',
    },
  ],
});
it.each([101, 1000])(
  'roundtrips %i guide descriptors while channel descriptor capacity stays 100',
  (count) => {
    const value = registry();
    value.reviewedGuideProviders = Array.from({ length: count }, (_, i) => ({
      ...value.reviewedGuideProviders[0]!,
      id: `g-${i}`,
      location: `https://example.invalid/${i}`,
    }));
    expect(
      parseProviderRegistry(serializeProviderRegistry(value)).reviewedGuideProviders,
    ).toHaveLength(count);
    value.reviewedGuideProviders.push({
      ...value.reviewedGuideProviders[0]!,
      id: 'extra',
      location: 'https://example.invalid/extra',
    });
    if (count === 1000) expect(() => validateProviderRegistry(value)).toThrow('1000');
  },
);

it('starts without configured channel or guide acquisitions and returns independent empty arrays', () => {
  const defaults = defaultProviderRegistry();
  expect(defaults).toEqual({
    schemaVersion: 1,
    reviewedChannelProviders: [],
    reviewedGuideProviders: [],
  });
  defaults.reviewedChannelProviders.push(registry().reviewedChannelProviders[0]!);
  expect(defaultProviderRegistry().reviewedChannelProviders).toEqual([]);
  expect(
    parseProviderRegistry(
      serializeProviderRegistry({
        schemaVersion: 1,
        reviewedChannelProviders: [],
        reviewedGuideProviders: [],
      }),
    ),
  ).toEqual({ schemaVersion: 1, reviewedChannelProviders: [], reviewedGuideProviders: [] });
});

it('canonicalizes URL identities, preserves signed query order, and drops unknown fields safely', () => {
  const value = registry();
  const result = validateProviderRegistry({
    ...value,
    ignored: true,
    reviewedChannelProviders: [
      {
        ...value.reviewedChannelProviders[0],
        location: 'https://EXAMPLE.invalid:443/catalog?sig=b%2Fa&x=2',
        enabled: true,
      },
    ],
  });
  expect(result.reviewedChannelProviders[0]).toEqual({
    id: 'one',
    name: 'Channel catalogs',
    location: 'https://example.invalid/catalog?sig=b%2Fa&x=2',
    provenance: 'https://publisher.invalid/docs',
    allowHttp: false,
  });
  expect(parseProviderRegistry(serializeProviderRegistry(result))).toEqual(result);
});

it('requires explicit channel HTTP permission and never stores a guide HTTP grant', () => {
  const value = registry();
  value.reviewedChannelProviders[0]!.location = 'http://example.invalid/catalog';
  expect(() => validateProviderRegistry(value)).toThrow('HTTP');
  value.reviewedChannelProviders[0]!.allowHttp = true;
  expect(validateProviderRegistry(value).reviewedChannelProviders[0]?.allowHttp).toBe(true);
  expect(() =>
    validateProviderRegistry({
      ...value,
      reviewedGuideProviders: [{ ...value.reviewedGuideProviders[0], allowHttp: true }],
    }),
  ).toThrow('cannot grant');
  expect(() => canonicalProviderLocation('http://example.invalid/guide')).toThrow('HTTP');
});

it('refuses unsafe URLs and malformed fields without disclosing URL values', () => {
  expect(() => canonicalProviderLocation('https://example.invalid/' + '界'.repeat(2000))).toThrow();
  const unicodeProvenance = registry();
  unicodeProvenance.reviewedChannelProviders[0]!.provenance =
    'https://publisher.invalid/' + '界'.repeat(400);
  expect(() => validateProviderRegistry(unicodeProvenance)).toThrow();
  for (const location of [
    'https://user:secret@example.invalid/a',
    'https://example.invalid/a#',
    'https://example.invalid/a#part',
    'file:///private',
    'https://example.invalid/a%QZ',
    'https://example.invalid/a b',
    'https://example.invalid\\secret',
    'https://example.invalid/a\n',
  ]) {
    expect(() => canonicalProviderLocation(location)).toThrow();
  }
  for (const change of [
    { id: '\u0000' },
    { name: ' ' },
    { provenance: 'http://publisher.invalid/docs' },
    { allowHttp: 'yes' },
    { location: 'x'.repeat(16385) },
  ]) {
    const value = registry();
    expect(() =>
      validateProviderRegistry({
        ...value,
        reviewedChannelProviders: [{ ...value.reviewedChannelProviders[0], ...change }],
      }),
    ).toThrow();
  }
});

it('refuses duplicate canonical URLs/IDs, invalid schema and count/byte overflow as whole records', () => {
  const value = registry();
  const first = value.reviewedChannelProviders[0]!;
  for (const second of [
    { ...first, location: 'https://other.invalid/a' },
    { ...first, id: 'two', location: 'https://EXAMPLE.invalid:443/catalog' },
  ]) {
    expect(() =>
      validateProviderRegistry({ ...value, reviewedChannelProviders: [first, second] }),
    ).toThrow('duplicate');
  }
  expect(() => validateProviderRegistry({ ...value, schemaVersion: 2 })).toThrow('schema');
  expect(() =>
    validateProviderRegistry({
      ...value,
      reviewedChannelProviders: Array.from({ length: 101 }, (_, i) => ({
        ...first,
        id: String(i),
        location: `https://example.invalid/${i}`,
      })),
    }),
  ).toThrow('100');
  expect(() => parseProviderRegistry(' '.repeat(1024 * 1024 + 1))).toThrow('1 MiB');
  expect(() => parseProviderRegistry('{broken')).toThrow('JSON');
});
