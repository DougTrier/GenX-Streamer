/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import {
  createMeasuredTransportRate,
  normalizeLiveBufferPreference,
  normalizeLiveBufferTelemetry,
} from '../../src/playback/live-buffer';

it.each([1, 7, 20])('accepts the bounded manual target %s without clamping', (targetSeconds) => {
  expect(normalizeLiveBufferPreference({ mode: 'manual', targetSeconds })).toEqual({
    mode: 'manual',
    targetSeconds,
  });
});
it.each([0, 21, -1, 1.5, NaN, Infinity, '8', null])('refuses invalid manual target %s', (value) => {
  expect(normalizeLiveBufferPreference({ mode: 'manual', targetSeconds: value })).toBeNull();
});
it('copies only a valid preference and refuses unknown or mixed modes', () => {
  const auto = { mode: 'auto' };
  expect(normalizeLiveBufferPreference(auto)).toEqual(auto);
  expect(normalizeLiveBufferPreference(auto)).not.toBe(auto);
  expect(normalizeLiveBufferPreference({ mode: 'auto', targetSeconds: 8 })).toBeNull();
  expect(
    normalizeLiveBufferPreference({ mode: 'manual', targetSeconds: 8, extra: true }),
  ).toBeNull();
  expect(normalizeLiveBufferPreference({ mode: 'other' })).toBeNull();
});
it('exports closed scalar telemetry, preserving unknown and actual measured zero distinctly', () => {
  const source = {
    incomingBitsPerSecond: 0,
    bufferedSeconds: null,
    targetSeconds: 8,
    mode: 'manual',
    capability: 'controlled',
    privateDetail: 'must stay inside the engine',
  };
  const result = normalizeLiveBufferTelemetry(source);
  expect(result).toEqual({
    incomingBitsPerSecond: 0,
    bufferedSeconds: null,
    targetSeconds: 8,
    mode: 'manual',
    capability: 'controlled',
  });
  expect(result).not.toBe(source);
  expect(JSON.stringify(result)).not.toContain('privateDetail');
  expect(normalizeLiveBufferTelemetry({ ...source, incomingBitsPerSecond: NaN })).toBeNull();
  expect(normalizeLiveBufferTelemetry({ ...source, targetSeconds: 21 })).toBeNull();
  expect(normalizeLiveBufferTelemetry({ ...source, targetSeconds: null })).toBeNull();
  expect(normalizeLiveBufferTelemetry({ ...source, targetSeconds: 2.5 })).toBeNull();
  expect(normalizeLiveBufferTelemetry({ ...source, capability: 'invented' })).toBeNull();
});
it('uses observed bytes and elapsed wall time instead of advertised or peak bitrate', () => {
  let now = 1000;
  const meter = createMeasuredTransportRate(() => now);
  expect(meter.readPayloadWindow()).toBeNull();
  meter.transfer(1000, 100);
  expect(meter.readPayloadWindow()).toBe(80_000);
  now = 2000;
  expect(meter.readPayloadWindow()).toBeCloseTo(8000 / 1.1);
  now = 3000;
  meter.transfer(2000, 200);
  expect(meter.readPayloadWindow()).toBeCloseTo(24000 / 2.1);
  expect(meter.read()).toBe(80_000); // Explicit transport-throughput view excludes idle gaps.
  now = 15_001;
  expect(meter.readPayloadWindow()).toBeNull();
});
it('unknown/idle rate and clock reset never become a fake poor zero', () => {
  let now = 1000;
  const meter = createMeasuredTransportRate(() => now);
  meter.rate(8192);
  expect(meter.read()).toBe(8192);
  meter.rate(0);
  expect(meter.read()).toBeNull();
  meter.transfer(1000, 0);
  meter.transfer(0, 1000);
  expect(meter.read()).toBeNull();
  meter.transfer(1000, 100);
  now = 500;
  expect(meter.read()).toBeNull();
  meter.transfer(1000, 100);
  meter.clear();
  expect(meter.read()).toBeNull();
});
