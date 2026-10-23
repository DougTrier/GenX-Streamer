import { expect, it } from 'vitest';
import { prioritizeGuideProviders } from '../../src/guide/provider-order';

const p = (name: string, path = `/epgshare01/epg_ripper_${name}.xml.gz`) =>
  Object.freeze({ name, location: 'https://epgshare01.online' + path, allowHttp: false });

it('uses playlist references and the users region before unrelated countries without dropping permissions or URLs', () => {
  const providers = [p('AL1'), p('ALL_SOURCES1'), p('GB1'), p('US1'), p('US2'), p('direct')];
  const ordered = prioritizeGuideProviders(providers, 'US', new Set([providers[5]!.location]));
  expect(ordered.map((x) => x.name)).toEqual([
    'direct',
    'US1',
    'US2',
    'AL1',
    'GB1',
    'ALL_SOURCES1',
  ]);
  expect(ordered).toHaveLength(providers.length);
  expect(new Set(ordered)).toEqual(new Set(providers));
  expect(providers.map((x) => x.name)).toEqual([
    'AL1',
    'ALL_SOURCES1',
    'GB1',
    'US1',
    'US2',
    'direct',
  ]);
});

it('is not hardcoded to US and leaves unknown regional claims in stable original order', () => {
  const providers = [p('US1'), p('GB1'), p('US2'), p('GB2'), p('name-US')];
  expect(prioritizeGuideProviders(providers, 'GB', new Set()).map((x) => x.name)).toEqual([
    'GB1',
    'GB2',
    'US1',
    'US2',
    'name-US',
  ]);
  expect(prioritizeGuideProviders(providers, undefined, new Set())).toEqual(providers);
  expect(prioritizeGuideProviders(providers, 'invalid', new Set())).toEqual(providers);
});

it('does not infer a country from arbitrary query text or partial filenames', () => {
  const providers = [p('unknown', '/feed.xml?country=US'), p('x', '/epg_ripper_US_foo.xml.gz')];
  expect(prioritizeGuideProviders(providers, 'US', new Set())).toEqual(providers);
});
it('prioritizes the actual regional local and sports feed descriptors too', () => {
  const providers = [p('AL1'), p('US_LOCALS2'), p('DE1'), p('US_SPORTS1')];
  expect(prioritizeGuideProviders(providers, 'US', new Set()).map((p) => p.name)).toEqual([
    'US_LOCALS2',
    'US_SPORTS1',
    'AL1',
    'DE1',
  ]);
});
