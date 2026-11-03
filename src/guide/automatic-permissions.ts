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

import type { GuideSource } from './native';
import { GUIDE_SOURCE_LIMIT } from './limits';
import { boundedUtf8Text } from '../platform/bounded-text';

export interface AutomaticGuidePermission {
  readonly status: 'configured' | 'unconfigured' | 'ambiguous';
  readonly location: string;
  readonly allowHttp: boolean;
  readonly source: Readonly<GuideSource> | null;
}
const refused = (): never => {
  throw new Error('Automatic program guide permission is invalid.');
};
const preflightRefusals = new WeakSet<object>();
function changed(kind: 'configuration' | 'permission'): DOMException {
  const error = new DOMException(`Program guide ${kind} changed.`, 'AbortError');
  preflightRefusals.add(error);
  return error;
}
/** Use only when a configuration check refuses entry before starting a writer. */
export function automaticGuideConfigurationChanged(): DOMException {
  return changed('configuration');
}
/** Identity proof from this metadata-only producer, never inferred from an error message. */
export function isAutomaticGuidePermissionRefusal(error: unknown): error is DOMException {
  return typeof error === 'object' && error !== null && preflightRefusals.has(error);
}
function locationUrl(location: unknown): URL {
  if (
    !boundedUtf8Text(location, 16_384) ||
    !/^https?:\/\//i.test(location) ||
    /[\s\\\p{Cc}]/u.test(location)
  )
    return refused();
  const url = new URL(location);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  )
    return refused();
  return url;
}
/** A bounded metadata-only snapshot. Exact URL grants never come from playlist permissions. */
export function createAutomaticGuidePermissions(sources: readonly GuideSource[]) {
  if (!Array.isArray(sources) || sources.length > GUIDE_SOURCE_LIMIT) return refused();
  const identities = new Set<string>(),
    urls = new Map<string, Readonly<GuideSource>>();
  const ambiguous = new Set<string>();
  for (const raw of sources) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refused();
    const keys = ['id', 'name', 'location', 'kind', 'allowHttp', 'revision', 'updatedMs'] as const;
    if (
      Reflect.ownKeys(raw).length !== keys.length ||
      keys.some((key) => {
        const field = Object.getOwnPropertyDescriptor(raw, key);
        return !field || !('value' in field);
      })
    )
      return refused();
    if (
      !boundedUtf8Text(raw.id, 256) ||
      !raw.id.trim() ||
      /\p{Cc}/u.test(raw.id) ||
      identities.has(raw.id) ||
      !boundedUtf8Text(raw.name, 512) ||
      !raw.name.trim() ||
      !boundedUtf8Text(raw.location, 16_384) ||
      !['url', 'file'].includes(raw.kind) ||
      typeof raw.allowHttp !== 'boolean' ||
      !Number.isSafeInteger(raw.revision) ||
      raw.revision < 1 ||
      !(
        raw.updatedMs === null ||
        (Number.isSafeInteger(raw.updatedMs) && Math.abs(raw.updatedMs) <= 8_640_000_000_000_000)
      )
    )
      return refused();
    identities.add(raw.id);
    if (raw.kind !== 'url') continue;
    locationUrl(raw.location);
    const source = Object.freeze({
      id: raw.id,
      name: raw.name,
      location: raw.location,
      kind: raw.kind,
      allowHttp: raw.allowHttp,
      revision: raw.revision,
      updatedMs: raw.updatedMs,
    });
    if (urls.has(source.location)) ambiguous.add(source.location);
    else urls.set(source.location, source);
  }
  return Object.freeze({
    forLocation(location: string): AutomaticGuidePermission {
      locationUrl(location);
      if (ambiguous.has(location))
        return Object.freeze({ status: 'ambiguous', location, allowHttp: false, source: null });
      const source = urls.get(location) ?? null;
      return Object.freeze({
        status: source ? 'configured' : 'unconfigured',
        location,
        allowHttp: source?.allowHttp === true,
        source,
      });
    },
  });
}

export interface AutomaticGuidePermissionGateway<T> {
  sources(): Promise<GuideSource[]>;
  previewSource(sourceId: string, signal: AbortSignal): Promise<T>;
  /** Memory-only proposal; no descriptor save before successful explicit publication. */
  previewProposedSource(location: string, name: string, signal: AbortSignal): Promise<T>;
}
/** Actual reads/preview settle before cancellation is reported; no stale snapshot can regrant HTTP. */
export async function previewPermittedAutomaticGuide<T>(
  captured: AutomaticGuidePermission,
  name: string,
  gateway: AutomaticGuidePermissionGateway<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const fresh = createAutomaticGuidePermissions(await gateway.sources()).forLocation(
    captured.location,
  );
  signal.throwIfAborted();
  if (captured.status === 'ambiguous' || fresh.status === 'ambiguous') return refused();
  if (
    captured.source &&
    (!fresh.source || fresh.source.id !== captured.source.id || fresh.source.kind !== 'url')
  )
    throw changed('configuration');
  if (
    locationUrl(captured.location).protocol === 'http:' &&
    (!captured.allowHttp || !fresh.allowHttp || !fresh.source)
  )
    throw changed('permission');
  if (fresh.source) return gateway.previewSource(fresh.source.id, signal);
  if (locationUrl(captured.location).protocol !== 'https:') return refused();
  return gateway.previewProposedSource(captured.location, name, signal);
}
