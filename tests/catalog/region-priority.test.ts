import { describe, expect, it } from 'vitest';
import {
  postalServiceCountry,
  prioritizeRegion,
  regionFromIpResponse,
  regionFromPostalResponse,
} from '../../src/location/region';

describe('per-installation region priority', () => {
  it('prioritizes declared state then country and keeps every unknown channel', () => {
    const channels = [
      { id: 'unknown' },
      { id: 'gb', country: 'GB' },
      { id: 'us', country: 'US' },
      { id: 'il', country: 'US', state: 'US-IL' },
      { id: 'il2', country: 'US', state: 'US-IL' },
    ];
    expect(
      prioritizeRegion(
        channels,
        { country: 'US', state: 'US-IL', origin: 'manual' },
        (item) => item,
      ).map((item) => item.id),
    ).toEqual(['il', 'il2', 'us', 'gb', 'unknown']);
    expect(prioritizeRegion(channels, undefined, (item) => item)).toEqual(channels);
  });
  it('stores only suggested country and state, never the public IP or precise location', () => {
    expect(
      regionFromIpResponse(
        JSON.stringify({
          country_code: 'gb',
          region_code: 'ENG',
          ip: '203.0.113.4',
          postal: 'secret',
          latitude: 1,
        }),
      ),
    ).toEqual({ country: 'UK', state: 'UK-ENG', origin: 'ip' });
  });
  it('translates the UK provider code only at the postal service boundary', () => {
    expect(postalServiceCountry('UK')).toBe('gb');
    expect(postalServiceCountry('US')).toBe('us');
    expect(
      regionFromPostalResponse('{"country abbreviation":"GB","places":[{}]}', 'UK', 'SW1A'),
    ).toEqual({ country: 'UK', postal: 'SW1A', origin: 'manual' });
  });
  it('refuses errors, malformed codes and oversized responses instead of a default ZIP', () => {
    for (const text of [
      '{}',
      '[]',
      '{"error":true,"country_code":"US"}',
      '{"country_code":"USA"}',
      ' '.repeat(32_769),
    ])
      expect(() => regionFromIpResponse(text)).toThrow();
  });
});
