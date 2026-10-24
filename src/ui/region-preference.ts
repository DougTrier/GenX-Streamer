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
  regionFromIpResponse,
  regionFromPostalResponse,
  postalServiceCountry,
  type PreferredRegion,
} from '../location/region';
import { validateGeographyShape } from '../catalog/geography';
import countries from '../location/countries.json';
import { orderCountries } from '../location/country-order';

export function mountRegionPreference(
  container: HTMLElement,
  host: {
    read(): PreferredRegion | undefined;
    save(region: PreferredRegion | undefined, signal: AbortSignal): Promise<boolean>;
    fetch(url: string, signal: AbortSignal): Promise<string>;
  },
) {
  const heading = document.createElement('h3');
  heading.textContent = 'Your region';
  const explanation = document.createElement('p');
  explanation.textContent =
    'Process local channels and guides first. Leave blank to scan all regions without a preference.';
  const field = (name: string, maxLength: number) => {
    const label = document.createElement('label');
    label.textContent = name;
    const input = document.createElement('input');
    input.maxLength = maxLength;
    label.append(input);
    return { label, input };
  };
  const countryLabel = document.createElement('label');
  countryLabel.textContent = 'Country';
  const countrySelect = document.createElement('select');
  countrySelect.setAttribute('aria-label', 'Region country');
  const country = { label: countryLabel, input: countrySelect };
  countrySelect.append(new Option('Choose country', ''));
  for (const entry of orderCountries(countries))
    countrySelect.append(new Option(entry.name, entry.code));
  countryLabel.append(countrySelect);
  const postal = field('ZIP / postal code', 32);
  postal.input.autocomplete = 'postal-code';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const button = (name: string, action: () => void) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = name;
    node.addEventListener('click', action);
    actions.append(node);
    return node;
  };
  let controller: AbortController | null = null,
    work: Promise<void> | null = null,
    closed = false;
  const run = (action: (signal: AbortSignal) => Promise<void>) => {
    if (closed || work) return;
    status.textContent = 'Checking region…';
    const owned = new AbortController();
    controller = owned;
    const timer = setTimeout(() => owned.abort(), 10000);
    for (const control of [save, suggest, clear, country.input, postal.input])
      control.disabled = true;
    const task = action(owned.signal)
      .catch(() => {
        if (!closed)
          status.textContent =
            'Location could not be saved. Check the country and postal code, or try again.';
      })
      .finally(() => {
        clearTimeout(timer);
        if (work === task) {
          work = null;
          controller = null;
        }
        if (!closed) {
          for (const control of [save, suggest, clear, country.input, postal.input])
            control.disabled = false;
          if (!status.textContent?.startsWith('Location could not')) update();
        }
      });
    work = task;
  };
  const save = button('Save region', () =>
    run(async (signal) => {
      const code = country.input.value.trim().toUpperCase();
      validateGeographyShape({ country: code });
      const zip = postal.input.value.trim();
      const region = zip
        ? regionFromPostalResponse(
            await host.fetch(
              `https://api.zippopotam.us/${encodeURIComponent(postalServiceCountry(code))}/${encodeURIComponent(zip)}`,
              signal,
            ),
            code,
            zip,
          )
        : { country: code, origin: 'manual' as const };
      signal.throwIfAborted();
      if (!(await host.save(region, signal))) throw new Error('Not saved');
      update();
    }),
  );
  const suggest = button('Suggest region from IP', () =>
    run(async (signal) => {
      const region = regionFromIpResponse(await host.fetch('https://ipapi.co/json/', signal));
      signal.throwIfAborted();
      if (host.read()?.origin === 'manual') {
        status.textContent = 'Your saved region takes priority. Clear it to use an IP suggestion.';
        return;
      }
      if (!(await host.save(region, signal))) throw new Error('Not saved');
      update();
    }),
  );
  const clear = button('Clear region', () =>
    run(async (signal) => {
      if (!(await host.save(undefined, signal))) throw new Error('Not saved');
      update();
    }),
  );
  function update() {
    if (closed || work) return;
    const region = host.read();
    country.input.value = region?.country ?? '';
    postal.input.value = region?.postal ?? '';
    status.textContent = region
      ? `${region.country}${region.state ? ` · ${region.state}` : ''} first${region.origin === 'ip' ? ' (approximate IP location)' : ''}. Other channels remain available.`
      : 'No region selected.';
  }
  container.append(heading, explanation, country.label, postal.label, actions, status);
  update();
  const suspend = async () => {
    controller?.abort();
    if (work) await work;
  };
  return {
    update,
    suspend,
    async dispose() {
      closed = true;
      await suspend();
      container.replaceChildren();
    },
  };
}
