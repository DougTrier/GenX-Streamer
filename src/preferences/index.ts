import { validateChannelCategoryOverrides, type ChannelCategoryOverride } from './channel-category';
export {
  effectiveChannelCategory,
  createChannelCategoryResolver,
  validateChannelCategoryOverrides,
  type ChannelCategoryOverride,
} from './channel-category';
import type { Source } from '../catalog/parser';
import { validateSource } from '../catalog/codec';
import { boundedUtf8Text } from '../platform/bounded-text';
import {
  defaultProviderRegistry,
  validateChannelProviders,
  validateGuideProviders,
  type ReviewedChannelProvider,
} from '../discovery/provider-registry';
import type { ReviewedGuideProvider } from '../guide/discovery';
import { validateGeographyShape } from '../catalog/geography';
import { migrateRefreshCadence, type RefreshCadence } from '../catalog/refresh-cadence';

export interface PreferredRegion {
  country: string;
  state?: string;
  postal?: string;
  origin: 'manual' | 'ip';
}

export interface Preferences {
  schemaVersion: 1;
  favorites: string[];
  removedChannels: string[];
  volume: number;
  muted: boolean;
  contentLibrary?: 'live' | 'genxtra';
  panelWidth: number;
  channelCategoryOverrides?: ChannelCategoryOverride[];
  sources: Source[];
  automaticSourceRefresh: boolean;
  automaticGuideUpdates?: boolean;
  sourceRefreshCadence?: RefreshCadence;
  sourceRefreshAttemptAt: number;
  voiceSearchConsent?: boolean;
  reviewedChannelProviders?: ReviewedChannelProvider[];
  reviewedGuideProviders?: ReviewedGuideProvider[];
  preferredRegion?: PreferredRegion;
}
/** First-run layout only; callers inject the viewport without coupling preferences to the DOM. */
export function defaultPanelWidthForViewport(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0)
    throw new Error('Invalid viewport width.');
  return Math.max(240, Math.min(600, Math.round(viewportWidth * 0.365)));
}

export const defaultPreferences = (panelWidth = 360): Preferences => ({
  schemaVersion: 1,
  favorites: [],
  removedChannels: [],
  volume: 0.8,
  muted: false,
  contentLibrary: 'live',
  panelWidth,
  sources: [],
  automaticSourceRefresh: false,
  automaticGuideUpdates: true,
  sourceRefreshCadence: 'off',
  sourceRefreshAttemptAt: 0,
  voiceSearchConsent: false,
  ...defaultProviderRegistryFields(),
});
/** Missing fields describe fresh/legacy configuration, never permission to discover a bundled directory. */
function defaultProviderRegistryFields() {
  const { reviewedChannelProviders, reviewedGuideProviders } = defaultProviderRegistry();
  return { reviewedChannelProviders, reviewedGuideProviders };
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const bounded = (v: unknown, max: number): v is string =>
  boundedUtf8Text(v, max, true) && v.length > 0;

/** Imports validate the entire record; a partial or corrupt record never replaces valid settings. */
export function validatePreferences(input: unknown): Preferences {
  if (!record(input) || input.schemaVersion !== 1)
    throw new Error('Unsupported or invalid preferences schema.');
  const contentLibrary = input.contentLibrary === undefined ? 'live' : input.contentLibrary;
  if (contentLibrary !== 'live' && contentLibrary !== 'genxtra')
    throw new Error('Invalid saved content library.');
  if (
    !Array.isArray(input.favorites) ||
    input.favorites.length > 100_000 ||
    !input.favorites.every((v) => bounded(v, 16_384))
  )
    throw new Error('Invalid favorites.');
  if (new Set(input.favorites).size !== input.favorites.length)
    throw new Error('Favorites contain duplicate identities.');
  const removed = input.removedChannels ?? [];
  if (
    !Array.isArray(removed) ||
    removed.length > 100_000 ||
    !removed.every((v) => bounded(v, 16_384)) ||
    new Set(removed).size !== removed.length
  )
    throw new Error('Invalid removed channel identities.');
  if (
    typeof input.volume !== 'number' ||
    !Number.isFinite(input.volume) ||
    input.volume < 0 ||
    input.volume > 1 ||
    typeof input.muted !== 'boolean'
  )
    throw new Error('Invalid audio preferences.');
  if (
    typeof input.panelWidth !== 'number' ||
    !Number.isFinite(input.panelWidth) ||
    input.panelWidth < 220 ||
    input.panelWidth > 600
  )
    throw new Error('Invalid panel width.');
  const sourceRefreshCadence = migrateRefreshCadence(
    input.sourceRefreshCadence,
    input.automaticSourceRefresh,
  );
  const automaticSourceRefresh = sourceRefreshCadence !== 'off';
  const automaticGuideUpdates =
    input.automaticGuideUpdates === undefined ? true : input.automaticGuideUpdates;
  if (typeof automaticGuideUpdates !== 'boolean')
    throw new Error('Invalid automatic guide update preference.');
  const voiceSearchConsent = input.voiceSearchConsent ?? false;
  if (typeof voiceSearchConsent !== 'boolean') throw new Error('Invalid voice search consent.');
  const sourceRefreshAttemptAt =
    input.sourceRefreshAttemptAt === undefined ? 0 : input.sourceRefreshAttemptAt;
  if (
    typeof automaticSourceRefresh !== 'boolean' ||
    typeof sourceRefreshAttemptAt !== 'number' ||
    !Number.isSafeInteger(sourceRefreshAttemptAt) ||
    sourceRefreshAttemptAt < 0 ||
    sourceRefreshAttemptAt > 8_640_000_000_000_000
  )
    throw new Error('Invalid automatic source refresh preferences.');
  if (!Array.isArray(input.sources) || input.sources.length > 100)
    throw new Error('Invalid playlist sources.');
  const ids = new Set<string>();
  const sources = input.sources.map((source: unknown): Source => {
    const validated = validateSource(source);
    if (ids.has(validated.id)) throw new Error('Duplicate source identity.');
    ids.add(validated.id);
    return validated;
  });
  const providerDefaults = defaultProviderRegistryFields();
  const reviewedChannelProviders =
    input.reviewedChannelProviders === undefined
      ? providerDefaults.reviewedChannelProviders
      : validateChannelProviders(input.reviewedChannelProviders);
  const reviewedGuideProviders =
    input.reviewedGuideProviders === undefined
      ? providerDefaults.reviewedGuideProviders
      : validateGuideProviders(input.reviewedGuideProviders);
  let preferredRegion: PreferredRegion | undefined;
  if (input.preferredRegion !== undefined) {
    const value = input.preferredRegion;
    if (
      !record(value) ||
      Object.keys(value).some((key) => !['country', 'state', 'postal', 'origin'].includes(key)) ||
      !['manual', 'ip'].includes(value.origin as string)
    )
      throw new Error('Invalid preferred region.');
    const shape = validateGeographyShape({
      country: value.country,
      ...(value.state !== undefined ? { state: value.state } : {}),
    });
    if (!shape.country) throw new Error('Preferred region requires a country.');
    if (
      value.postal !== undefined &&
      (!boundedUtf8Text(value.postal, 32) ||
        [...value.postal].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ))
    )
      throw new Error('Preferred region postal code is invalid.');
    preferredRegion = {
      country: shape.country,
      ...(shape.state !== undefined ? { state: shape.state } : {}),
      ...(value.postal !== undefined ? { postal: value.postal as string } : {}),
      origin: value.origin as PreferredRegion['origin'],
    };
  }
  const channelCategoryOverrides =
    input.channelCategoryOverrides === undefined
      ? undefined
      : validateChannelCategoryOverrides(input.channelCategoryOverrides);
  return {
    schemaVersion: 1,
    ...(channelCategoryOverrides === undefined ? {} : { channelCategoryOverrides }),
    favorites: [...input.favorites] as string[],
    removedChannels: [...removed] as string[],
    volume: input.volume,
    muted: input.muted,
    contentLibrary,
    panelWidth: input.panelWidth,
    sources,
    automaticSourceRefresh,
    automaticGuideUpdates,
    sourceRefreshCadence,
    sourceRefreshAttemptAt,
    voiceSearchConsent,
    reviewedChannelProviders,
    reviewedGuideProviders,
    ...(preferredRegion !== undefined ? { preferredRegion } : {}),
  };
}
export function importPreferences(text: string): Preferences {
  if (new TextEncoder().encode(text).byteLength > 20 * 1024 * 1024)
    throw new Error('Preferences export exceeds 20 MiB.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Preferences export is invalid JSON.');
  }
  return validatePreferences(value);
}
export const exportPreferences = (value: Preferences): string =>
  JSON.stringify(validatePreferences(value), null, 2);

export interface AtomicPreferencesAdapter {
  read(): Promise<unknown | null>;
  /** Resolves after durable atomic publication; rejection must leave the last valid revision recoverable. */
  write(value: Preferences): Promise<void>;
}
export class SerializedPreferencesStore {
  private current: Preferences;
  // Defaults alone do not prove that a preference record exists in storage.
  private durableBaselineKnown = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private adapter: AtomicPreferencesAdapter,
    private readonly initialPanelWidth = 360,
  ) {
    this.current = validatePreferences(defaultPreferences(initialPanelWidth));
  }
  snapshot(): Preferences {
    return validatePreferences(this.current);
  }
  async load(): Promise<Preferences> {
    return this.enqueue(async () => {
      this.durableBaselineKnown = false;
      const value = await this.adapter.read();
      this.current =
        value === null ? defaultPreferences(this.initialPanelWidth) : validatePreferences(value);
      this.durableBaselineKnown = value !== null;
      return this.snapshot();
    });
  }
  /** Serialize native targeted writes with full settings edits; reload only after acknowledgment. */
  mutateExternally(commit: () => Promise<void>): Promise<Preferences> {
    return this.enqueue(async () => {
      this.durableBaselineKnown = false;
      await commit();
      const value = await this.adapter.read();
      this.current =
        value === null ? defaultPreferences(this.initialPanelWidth) : validatePreferences(value);
      this.durableBaselineKnown = value !== null;
      return this.snapshot();
    });
  }
  update(
    mutate: (draft: Preferences) => void,
    guard?: () => Promise<boolean>,
  ): Promise<Preferences> {
    return this.enqueue(async () => {
      if (guard && !(await guard()))
        throw new DOMException('Settings action is no longer authorized.', 'AbortError');
      const draft = this.snapshot();
      mutate(draft);
      const next = validatePreferences(draft);
      // Admission still runs for equal edits, and this comparison occurs only
      // after the original queued durable operation has actually settled.
      if (this.durableBaselineKnown && JSON.stringify(next) === JSON.stringify(this.snapshot()))
        return this.snapshot();
      await this.adapter.write(next);
      this.current = next;
      this.durableBaselineKnown = true;
      return this.snapshot();
    });
  }
  replace(value: unknown): Promise<Preferences> {
    const next = validatePreferences(value);
    return this.update((draft) => Object.assign(draft, next));
  }
  /** Publishes the in-memory revision only after the caller's paired durable transaction. */
  replaceAtomically(
    value: unknown,
    commit: (next: Preferences) => Promise<void>,
  ): Promise<Preferences> {
    const next = validatePreferences(value);
    return this.enqueue(async () => {
      this.durableBaselineKnown = false;
      await commit(next);
      this.current = next;
      this.durableBaselineKnown = true;
      return this.snapshot();
    });
  }
  settledSnapshot(): Promise<Preferences> {
    return this.enqueue(async () => this.snapshot());
  }
  /** Bounded source authority snapshot; does not clone favorites or unrelated user choices. */
  settledSources(): Promise<readonly Source[]> {
    return this.enqueue(async () => this.current.sources.map((source) => validateSource(source)));
  }
  /** Adopt ONLY source changes already durably committed by the native catalog owner.
   * Queued user edits remain authoritative; this performs no adapter write or full snapshot. */
  adoptAcknowledgedSources(
    upserts: readonly Source[],
    expectedSources: readonly Source[],
    guard: () => boolean,
  ): Promise<readonly Source[]> {
    if (upserts.length > 100 || expectedSources.length > 100)
      return Promise.reject(new Error('Acknowledged sources exceed their bound.'));
    const changes = upserts.map((source) => validateSource(source));
    const expected = expectedSources.map((source) => validateSource(source));
    if (
      new Set(changes.map((source) => source.id)).size !== changes.length ||
      new Set(expected.map((source) => source.id)).size !== expected.length
    )
      return Promise.reject(new Error('Acknowledged source identities are invalid.'));
    return this.enqueue(async () => {
      const same = (a: Source, b: Source) =>
        a.id === b.id &&
        a.name === b.name &&
        a.kind === b.kind &&
        a.location === b.location &&
        (a.allowHttp === true) === (b.allowHttp === true) &&
        a.contentKind === b.contentKind &&
        a.mediaMime === b.mediaMime;
      if (
        !guard() ||
        this.current.sources.length !== expected.length ||
        this.current.sources.some((source, index) => !same(source, expected[index]!))
      )
        throw new Error('Source choices changed before publication adoption.');
      const merged = new Map(this.current.sources.map((source) => [source.id, source]));
      for (const source of changes) merged.set(source.id, source);
      if (merged.size > 100) throw new Error('Acknowledged sources exceed their bound.');
      const sources = [...merged.values()];
      this.current = { ...this.current, sources };
      return sources.map((source) => validateSource(source));
    });
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
