// Read-only admission. The caller owns the subsequent atomic write and its receipt.
export class ScanFixtureRestorationRefusal extends Error {
  constructor(code) {
    super('Scan fixture restoration refused.');
    this.name = 'ScanFixtureRestorationRefusal';
    this.code = code;
  }
}
const refuse = (code) => {
  throw new ScanFixtureRestorationRefusal(code);
};
export function restorationFailureCode(error) {
  return error instanceof ScanFixtureRestorationRefusal ? error.code : null;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const equal = (left, right) => canonical(left) === canonical(right);
function parse(text, code) {
  if (typeof text !== 'string' || text.length > 64 * 1024 * 1024) refuse(code);
  try {
    return JSON.parse(text);
  } catch {
    return refuse(code);
  }
}
function revision(value) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    refuse('invalid-revision');
  return value;
}
function rows(value, key) {
  if (!value || !Array.isArray(value[key]) || value[key].length > 100000) refuse('invalid-catalog');
  const ids = new Set();
  for (const row of value[key]) {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id))
      refuse('duplicate-or-invalid-row');
    ids.add(row.id);
  }
  return ids;
}
const tuple = (channel) => JSON.stringify([channel.providerId, channel.name, channel.urls]);
function health(text) {
  const value = text === null ? { schemaVersion: 1, records: [] } : parse(text, 'invalid-health');
  if (!value || !Array.isArray(value.records) || value.records.length > 100000)
    refuse('invalid-health');
  if (
    value.records.some(
      (record) =>
        !record ||
        typeof record !== 'object' ||
        typeof record.channelId !== 'string' ||
        typeof record.sourceId !== 'string',
    )
  )
    refuse('invalid-health');
  return value;
}

/** fixture: exact URL source name/location/allowHttp and expected providerId/name/url tuples.
 * Only added rows are removable. Original rows, including their order, are immutable.
 */
export function admitScanFixtureRestoration(original, current, fixture, isolatedPreferences) {
  const expectedCatalogRevision = revision(current.catalogRevision);
  const expectedHealthRevision = revision(current.healthRevision);
  if (
    BigInt(expectedCatalogRevision) < BigInt(revision(original.catalogRevision)) ||
    BigInt(expectedHealthRevision) < BigInt(revision(original.healthRevision))
  )
    refuse('revision-regressed');
  const before = parse(original.catalog, 'invalid-catalog'),
    after = parse(current.catalog, 'invalid-catalog');
  const oldChannels = rows(before, 'channels'),
    oldSources = rows(before, 'sources');
  rows(after, 'channels');
  rows(after, 'sources');
  if (
    !equal(
      after.channels.filter((c) => oldChannels.has(c.id)),
      before.channels,
    ) ||
    !equal(
      after.sources.filter((s) => oldSources.has(s.id)),
      before.sources,
    )
  )
    refuse('original-rows-changed');
  const metadata = (value) =>
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== 'channels' && key !== 'sources'),
    );
  if (!equal(metadata(before), metadata(after))) refuse('catalog-metadata-changed');
  const channels = after.channels.filter((c) => !oldChannels.has(c.id));
  const sources = after.sources.filter((s) => !oldSources.has(s.id));
  if (sources.length > 1 || (channels.length && sources.length !== 1))
    refuse('fixture-source-mismatch');
  if (sources.length) {
    const source = sources[0];
    if (
      !fixture ||
      source.kind !== 'url' ||
      source.name !== fixture.name ||
      source.location !== fixture.location ||
      source.allowHttp !== true ||
      fixture.allowHttp !== true ||
      (fixture.sourceId !== undefined && source.id !== fixture.sourceId)
    )
      refuse('fixture-source-mismatch');
    if (!Array.isArray(fixture.channels) || fixture.channels.length > 100000)
      refuse('invalid-fixture');
    const expected = new Set();
    for (const candidate of fixture.channels) {
      if (
        typeof candidate.providerId !== 'string' ||
        !candidate.providerId ||
        typeof candidate.name !== 'string' ||
        typeof candidate.url !== 'string'
      )
        refuse('invalid-fixture');
      const key = tuple({ ...candidate, urls: [candidate.url] });
      if (expected.has(key)) refuse('duplicate-fixture-descriptor');
      expected.add(key);
    }
    const matched = new Set();
    for (const channel of channels) {
      const key = tuple(channel);
      if (
        !expected.has(key) ||
        matched.has(key) ||
        channel.sourceId !== source.id ||
        channel.category !== 'Fixture'
      )
        refuse('fixture-channel-mismatch');
      matched.add(key);
    }
  }
  const prefs = parse(current.preferences, 'invalid-preferences');
  const originalPrefs = parse(original.preferences, 'invalid-preferences');
  const isolated = parse(isolatedPreferences ?? original.preferences, 'invalid-preferences');
  const expectedPrefs = { ...isolated, sources: after.sources };
  if (!equal(prefs, expectedPrefs) && !equal(prefs, originalPrefs)) refuse('preferences-changed');
  const oldHealth = health(original.health),
    newHealth = health(current.health);
  const ids = new Set(channels.map((c) => c.id));
  const fixtureHealthKeys = new Set();
  for (const record of newHealth.records.filter((r) => ids.has(r.channelId))) {
    const key = JSON.stringify([record.sourceId, record.channelId, record.platform]);
    if (record.sourceId !== sources[0]?.id || fixtureHealthKeys.has(key))
      refuse('fixture-health-mismatch');
    fixtureHealthKeys.add(key);
  }
  if (
    !equal(
      { ...newHealth, records: newHealth.records.filter((r) => !ids.has(r.channelId)) },
      oldHealth,
    )
  )
    refuse('health-changed');
  return Object.freeze({
    sourceId: sources[0]?.id ?? null,
    channelIds: Object.freeze([...ids]),
    expectedCatalogRevision,
    expectedHealthRevision,
    ...(current.checkpointRevision === undefined
      ? {}
      : { expectedCheckpointRevision: revision(current.checkpointRevision) }),
  });
}
