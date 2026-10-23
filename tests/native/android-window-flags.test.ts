import { expect, it } from 'vitest';
// @ts-expect-error The owned Node diagnostic parser is a JavaScript-only test helper.
import { parseRequestedBars } from './android-window-flags.mjs';

it('recognizes the exact owned Android 13 diagnostic hidden and visible flag lines', () => {
  expect(
    parseRequestedBars(
      'Requested visibilities: ITYPE_STATUS_BAR: invisible, ITYPE_NAVIGATION_BAR: invisible, ITYPE_CLIMATE_BAR: invisible, ITYPE_EXTRA_NAVIGATION_BAR: invisible',
    ),
  ).toEqual({ statusVisible: false, navigationVisible: false });
  expect(
    parseRequestedBars(
      'Requested visibilities: ITYPE_STATUS_BAR: visible, ITYPE_NAVIGATION_BAR: visible, ITYPE_CLIMATE_BAR: visible, ITYPE_EXTRA_NAVIGATION_BAR: visible',
    ),
  ).toEqual({ statusVisible: true, navigationVisible: true });
});
it('preserves explicit boolean and numeric representations', () => {
  expect(
    parseRequestedBars('mRequestedVisibilities: statusBars=false, navigationBars=true'),
  ).toEqual({ statusVisible: false, navigationVisible: true });
  expect(parseRequestedBars('mRequestedVisibleTypes=0x3')).toEqual({
    statusVisible: true,
    navigationVisible: true,
  });
  expect(parseRequestedBars('mRequestedVisibleTypes=0')).toEqual({
    statusVisible: false,
    navigationVisible: false,
  });
});
it('refuses omitted baseline, malformed, ambiguous or unknown values', () => {
  for (const line of [
    undefined,
    '',
    'mViewVisibility=0x0',
    'Requested visibilities: ITYPE_STATUS_BAR: invisible',
    'Requested visibilities: ITYPE_STATUS_BAR: invisibility, ITYPE_NAVIGATION_BAR: visible',
    'Requested visibilities: statusBars=true, statusBars=false, navigationBars=true',
    'mRequestedVisibleTypes=0xZZ',
    'mRequestedVisibleTypes=999999999999999999999999',
    'x'.repeat(1025),
  ])
    expect(parseRequestedBars(line)).toBeNull();
});
it('refuses duplicate or mixed requested visibility representations', () => {
  for (const line of [
    'mRequestedVisibleTypes=3 mRequestedVisibleTypes=0',
    'mRequestedVisibleTypes=3 mRequestedVisibleTypes=3',
    'mRequestedVisibleTypes=3 mRequestedVisibleTypes=invalid',
    'mRequestedVisibleTypes=0 Requested visibilities: statusBars=true, navigationBars=true',
    'mRequestedVisibleTypes=3 mRequestedVisibilities: statusBars=true, navigationBars=true',
    'Requested visibilities: statusBars=true, navigationBars=true Requested visibilities:',
  ])
    expect(parseRequestedBars(line)).toBeNull();
});
