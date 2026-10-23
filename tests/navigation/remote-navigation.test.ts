import { describe, expect, it } from 'vitest';
import {
  createRemoteEditMode,
  createRemoteInputOrigin,
  directionalIndex,
} from '../../src/ui/remote-navigation';

describe('remote activation autofocus provenance', () => {
  it('marks a new modal field only after directional navigation and OK', () => {
    const origin = createRemoteInputOrigin();
    origin.activate();
    expect(origin.autofocus(false, true)).toBe(false);
    origin.directional();
    expect(origin.autofocus(false, true)).toBe(false);
    origin.activate();
    expect(origin.autofocus(false, true)).toBe(true);
    expect(origin.autofocus(true, true)).toBe(false);
    expect(origin.autofocus(false, false)).toBe(false);
  });
  it('pointer, Tab and intentional typing reset provenance instead of relabeling editors', () => {
    const origin = createRemoteInputOrigin();
    origin.directional();
    origin.activate();
    origin.clear();
    expect(origin.autofocus(false, true)).toBe(false);
    origin.activate();
    expect(origin.autofocus(false, true)).toBe(false);
  });
});

const box = (x: number, y: number) => ({ x, y, width: 10, height: 10 });
describe('directional focus geometry', () => {
  it('chooses the closest aligned control in the requested direction without activation', () => {
    const origin = box(50, 50);
    const choices = [box(5, 50), box(100, 50), box(55, 120), box(50, 0)];
    expect(directionalIndex(origin, choices, 'ArrowLeft')).toBe(0);
    expect(directionalIndex(origin, choices, 'ArrowRight')).toBe(1);
    expect(directionalIndex(origin, choices, 'ArrowDown')).toBe(2);
    expect(directionalIndex(origin, choices, 'ArrowUp')).toBe(3);
  });
  it('retains stable DOM order on ties and does not wrap across an absent boundary', () => {
    expect(directionalIndex(box(0, 0), [box(20, 0), box(20, 0)], 'ArrowRight')).toBe(0);
    expect(directionalIndex(box(0, 0), [box(20, 0)], 'ArrowLeft')).toBe(-1);
  });
});
describe('explicit remote editing ownership', () => {
  it('keeps ordinary pointer/Tab fields native and consumes Back only for the focused remote editor', () => {
    const field = {} as HTMLElement;
    let active: Element | null = field;
    const mode = createRemoteEditMode(() => active);
    expect(mode.isEditing(field)).toBe(true);
    expect(mode.exit()).toBe(false);
    mode.navigate(field);
    expect(mode.isNavigation(field)).toBe(true);
    mode.begin(field);
    expect(mode.isEditing(field)).toBe(true);
    expect(mode.exit()).toBe(true);
    expect(mode.isNavigation(field)).toBe(true);
    expect(mode.exit()).toBe(false);
    mode.begin(field);
    active = null;
    expect(mode.exit()).toBe(false);
    expect(mode.isEditing(field)).toBe(true);
  });
  it('typing begins only the owned field and clearing returns native semantics', () => {
    const field = {} as HTMLElement,
      other = {} as HTMLElement;
    const mode = createRemoteEditMode(() => field);
    mode.navigate(field);
    mode.begin(other);
    expect(mode.isNavigation(field)).toBe(true);
    mode.begin(field);
    expect(mode.isNavigation(field)).toBe(false);
    mode.clear();
    expect(mode.isEditing(field)).toBe(true);
    expect(mode.exit()).toBe(false);
  });
});

it('vertical movement reaches nearby full-width choices before distant aligned actions', () => {
  const close = { x: 658, y: 12, width: 44, height: 44 };
  const section = { x: 260, y: 80, width: 440, height: 44 };
  const exportAction = { x: 620, y: 190, width: 80, height: 44 };
  expect(directionalIndex(close, [section, exportAction], 'ArrowDown')).toBe(0);
  expect(
    directionalIndex(section, [close, { x: 260, y: 155, width: 100, height: 44 }], 'ArrowDown'),
  ).toBe(1);
});

it('unequal-height same-row search controls cannot capture vertical navigation', () => {
  const search = { x: 60, y: 93, width: 300, height: 48 };
  const magnifier = { x: 16, y: 93, width: 34, height: 34 };
  const header = { x: 16, y: 12, width: 120, height: 44 };
  const location = { x: 60, y: 160, width: 300, height: 44 };
  expect(directionalIndex(search, [magnifier, header], 'ArrowUp')).toBe(1);
  expect(directionalIndex(magnifier, [search, location], 'ArrowDown')).toBe(1);
  expect(directionalIndex(search, [magnifier], 'ArrowLeft')).toBe(0);
  expect(directionalIndex(magnifier, [search], 'ArrowRight')).toBe(0);
  expect(directionalIndex(search, [magnifier], 'ArrowUp')).toBe(-1);
});
