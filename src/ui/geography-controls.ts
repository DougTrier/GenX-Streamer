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
  createGeographyRegistry,
  geographyLabel,
  matchesGeography,
  type ChannelGeography,
  type GeographyFilter,
  type GeographyRegistry,
} from '../catalog/geography';
import type { BrowserChannel } from './channel-browser';
import { compareCountryCodes, englishTier } from '../location/country-order';
import { MAX_FILTER_COUNTRIES } from '../catalog/geography';
import officialCountries from '../location/countries.json';
import officialSubdivisions from '../search/subdivisions.json';
const countryLabels = new Map(officialCountries.map((country) => [country.code, country.name]));
const subdivisionLabels: Readonly<Record<string, string>> = officialSubdivisions.labels;
export function hasOfficialGeographyLabels(registry: GeographyRegistry): boolean {
  return (
    [...registry.countries].every(([code, name]) => name === (countryLabels.get(code) ?? code)) &&
    [...registry.states].every(
      ([code, value]) => value.name === (subdivisionLabels[code] ?? code),
    ) &&
    [...registry.regions].every(([code, value]) => value.name === code)
  );
}
type Field = keyof ChannelGeography;
/** Channel counts per country computed elsewhere (code null: country unknown). */
export interface GeographySummary {
  total: number;
  countries: readonly { code: string | null; count: number }[];
}
export interface GeographyControlsHost {
  channels(): readonly BrowserChannel[];
  /** When present (paid accounts), countries come from this summary; no region/state. */
  summary?(): GeographySummary | null;
  preferredCountry?(): string | undefined;
  apply(value: {
    filter: GeographyFilter;
    sort: 'source' | 'geography' | 'name';
    registry: GeographyRegistry;
  }): void;
}
export interface GeographyControlsOptions {
  label?(field: Field, code: string): string;
  countryLocale?: string;
}
/** Labels describe admitted codes, not inferred geographic relationships or network locations. */
export function registryForChannels(
  channels: readonly BrowserChannel[],
  options: GeographyControlsOptions = {},
): GeographyRegistry {
  const countries = new Set<string>();
  const regions = new Map<string, Set<string>>();
  const states = new Map<string, string>();
  for (const channel of channels) {
    const geo = channel.geography;
    if (!geo) continue;
    if (geo.country) countries.add(geo.country);
    if (geo.region) {
      const members = regions.get(geo.region) ?? new Set<string>();
      if (geo.country) members.add(geo.country);
      regions.set(geo.region, members);
    }
    if (geo.state && geo.country) states.set(geo.state, geo.country);
  }
  let countryNames: Intl.DisplayNames | undefined;
  try {
    countryNames = new Intl.DisplayNames([options.countryLocale ?? 'en'], { type: 'region' });
  } catch {
    /* Codes remain usable on platforms without labels. */
  }
  const label = (field: Field, value: string) =>
    options.label?.(field, value) ??
    (options.countryLocale && field === 'country' ? countryNames?.of(value) : undefined) ??
    (field === 'country'
      ? countryLabels.get(value)
      : field === 'state'
        ? subdivisionLabels[value]
        : undefined) ??
    value;
  return createGeographyRegistry({
    countries: [...countries].map((code) => ({ code, name: label('country', code) })),
    regions: [...regions].map(([code, members]) => ({
      code,
      name: label('region', code),
      countries: [...members],
    })),
    states: [...states].map(([code, country]) => ({ code, country, name: label('state', code) })),
  });
}
export function mountGeographyControls(
  container: HTMLElement,
  host: GeographyControlsHost,
  options: GeographyControlsOptions = {},
): { update(): void; reset(): void; dispose(): void } {
  const wrapper = document.createElement('div');
  wrapper.className = 'geography-controls';
  const fields = ['region', 'state'] as const;
  const selects = new Map<Field, HTMLSelectElement>();
  /** Region and state, under exactly one chosen country. */
  let filter: GeographyFilter = {};
  /** Chosen countries ('?' = country unknown, chosen alone). Empty = all countries. */
  let chosen: string[] = [];
  let disposed = false;
  const allCountries = document.createElement('button');
  allCountries.type = 'button';
  allCountries.textContent = 'All countries';
  const resetCountries = () => {
    if (disposed) return;
    filter = {};
    chosen = [];
    update();
  };
  // Countries are a checklist: choose one or several (owner request, October
  // 19, 2026: "USA, Canada and UK"), English-speaking countries first. A
  // native multiple select can't be used with a TV remote, so each country is
  // a toggle.
  const countryLabel = document.createElement('p');
  countryLabel.className = 'geography-countries-label';
  countryLabel.id = 'geography-countries-label';
  countryLabel.textContent = 'Countries · choose one or more';
  const countryList = document.createElement('div');
  countryList.className = 'geography-countries';
  countryList.setAttribute('role', 'group');
  countryList.setAttribute('aria-labelledby', countryLabel.id);
  const toggleCountry = (event: Event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
      'button[data-code]',
    );
    if (!button || disposed) return;
    const code = button.dataset.code!;
    if (chosen.includes(code)) chosen = chosen.filter((c) => c !== code);
    // Unknown is a choice of its own; it does not combine with named countries.
    else if (code === '?') chosen = ['?'];
    else if (chosen.length < MAX_FILTER_COUNTRIES)
      chosen = [...chosen.filter((c) => c !== '?'), code];
    filter = {};
    update();
  };
  countryList.addEventListener('click', toggleCountry);
  allCountries.addEventListener('click', resetCountries);
  const sort = document.createElement('select');
  sort.setAttribute('aria-label', 'Channel sort');
  for (const [value, label] of [
    ['source', 'Source order'],
    ['geography', 'Country, region, state'],
    ['name', 'Channel name'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    sort.append(option);
  }
  for (const field of fields) {
    const label = document.createElement('label');
    label.textContent = field === 'region' ? 'Region' : 'State / subdivision';
    const select = document.createElement('select');
    select.setAttribute('aria-label', label.textContent);
    selects.set(field, select);
    label.append(select);
    wrapper.append(label);
    select.addEventListener('change', () => {
      if (select.value === '') delete filter[field];
      else filter = { ...filter, [field]: select.value === '?' ? null : select.value };
      if (field === 'region') delete filter.state;
      update();
    });
  }
  const sortLabel = document.createElement('label');
  sortLabel.textContent = 'Sort';
  sortLabel.append(sort);
  // Short controls first, the long country checklist last: with 250
  // countries the remote reached Sort only after about 125 presses
  // (Streamer, October 19). Region and state follow a single chosen country.
  const regionLabels = [...wrapper.querySelectorAll('label')];
  wrapper.replaceChildren(sortLabel, allCountries, ...regionLabels, countryLabel, countryList);
  // A scrolling list must not take focus itself (Chromium makes scrollers focusable).
  countryList.tabIndex = -1;
  sort.addEventListener('change', () => update());
  container.append(wrapper);
  function update(): void {
    if (disposed) return;
    const summary = host.summary?.() ?? null;
    const channels = summary ? [] : host.channels();
    const registry = registryForChannels(
      summary
        ? summary.countries.flatMap((row) =>
            row.code ? [{ geography: { country: row.code } } as BrowserChannel] : [],
          )
        : channels,
      options,
    );
    const preferredCountry = host.preferredCountry?.();
    const countryCounts = summary
      ? new Map(summary.countries.map((row) => [row.code ?? '?', row.count]))
      : (() => {
          const counts = new Map<string, number>();
          for (const channel of channels) {
            const value = channel.geography?.country ?? '?';
            counts.set(value, (counts.get(value) ?? 0) + 1);
          }
          return counts;
        })();
    chosen = chosen.filter((code) => countryCounts.has(code));
    renderCountries(
      countryCounts,
      summary ? summary.total : channels.length,
      registry,
      preferredCountry,
    );
    // Region and state narrow one chosen country (free channels only).
    const single = chosen.length === 1 && chosen[0] !== '?' ? chosen[0] : undefined;
    for (const field of fields) {
      const label = selects.get(field)!.closest('label');
      if (label) label.hidden = !!summary || single === undefined;
      if (summary || single === undefined) {
        delete filter[field];
        continue;
      }
      const parent: GeographyFilter =
        field === 'region' ? { country: single } : { country: single, region: filter.region };
      const eligible = channels.filter((channel) =>
        matchesGeography({ ...channel, sourceId: channel.sourceId ?? '' }, parent),
      );
      const counts = new Map<string, number>();
      for (const channel of eligible) {
        const value = channel.geography?.[field] ?? '?';
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      render(field, counts, eligible.length, registry, preferredCountry);
    }
    host.apply({
      filter:
        chosen.length === 0
          ? {}
          : chosen.length === 1
            ? { ...filter, country: chosen[0] === '?' ? null : chosen[0] }
            : { countries: [...chosen] },
      sort: sort.value === 'name' ? 'name' : sort.value === 'geography' ? 'geography' : 'source',
      registry,
    });
  }
  function renderCountries(
    counts: ReadonlyMap<string, number>,
    total: number,
    registry: GeographyRegistry,
    preferredCountry: string | undefined,
  ): void {
    const name = (code: string) => geographyLabel('country', code, registry);
    const codes = [...counts.keys()]
      .filter((code) => code !== '?')
      .sort((a, b) => {
        if (a === preferredCountry && b !== preferredCountry) return -1;
        if (b === preferredCountry && a !== preferredCountry) return 1;
        return compareCountryCodes(a, b, name);
      });
    // The remote keeps its place while the list is rebuilt.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
      '.geography-countries button[data-code]',
    )?.dataset.code;
    const english = codes.filter((code) => englishTier(code) < 2 || code === preferredCountry);
    const others = codes.filter((code) => !english.includes(code));
    const heading = (text: string) => {
      const node = document.createElement('p');
      node.className = 'geography-countries-group';
      node.textContent = text;
      return node;
    };
    const item = (code: string) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.code = code;
      button.setAttribute('role', 'checkbox');
      button.setAttribute('aria-checked', String(chosen.includes(code)));
      button.textContent = `${code === '?' ? 'Unknown' : name(code)} (${counts.get(code) ?? 0})`;
      return button;
    };
    countryList.replaceChildren(
      ...(english.length ? [heading('English-speaking'), ...english.map(item)] : []),
      ...(others.length
        ? [heading(english.length ? 'Other countries' : 'Countries'), ...others.map(item)]
        : []),
      ...(counts.has('?') ? [item('?')] : []),
    );
    allCountries.textContent = `All countries (${total})`;
    allCountries.setAttribute('aria-pressed', String(chosen.length === 0));
    if (focused !== undefined)
      countryList.querySelector<HTMLElement>(`button[data-code="${CSS.escape(focused)}"]`)?.focus();
  }
  function render(
    field: Field,
    counts: ReadonlyMap<string, number>,
    total: number,
    registry: GeographyRegistry,
    preferredCountry: string | undefined,
  ): void {
    {
      if (filter[field] !== undefined && !counts.has(filter[field] === null ? '?' : filter[field]!))
        delete filter[field];
      const select = selects.get(field)!;
      select.replaceChildren();
      const values = [
        '',
        ...[...counts.keys()]
          .filter((value) => value !== '?')
          .sort((a, b) => {
            if (field === 'country') {
              if (a === preferredCountry && b !== preferredCountry) return -1;
              if (b === preferredCountry && a !== preferredCountry) return 1;
              return compareCountryCodes(a, b, (code) => geographyLabel(field, code, registry));
            }
            const x = geographyLabel(field, a, registry).toLowerCase(),
              y = geographyLabel(field, b, registry).toLowerCase();
            return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
          }),
        '?',
      ];
      for (const value of values) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = `${value === '' ? (field === 'country' ? 'All countries' : 'All') : value === '?' ? 'Unknown' : geographyLabel(field, value, registry)} (${value === '' ? total : (counts.get(value) ?? 0)})`;
        option.selected = value === (filter[field] === null ? '?' : (filter[field] ?? ''));
        select.append(option);
      }
    }
  }
  update();
  return {
    update,
    /** A library switch starts from all countries in source order. */
    reset(): void {
      if (disposed) return;
      filter = {};
      chosen = [];
      sort.value = 'source';
      update();
    },
    dispose() {
      disposed = true;
      allCountries.removeEventListener('click', resetCountries);
      countryList.removeEventListener('click', toggleCountry);
      wrapper.remove();
    },
  };
}
