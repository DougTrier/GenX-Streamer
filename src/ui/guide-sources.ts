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

import { GUIDE_SOURCE_LIMIT } from '../guide/limits';
import { mappedGuideResultText } from '../application/mapped-guide-schedule';
import { type createGuidePresentation } from './guide-presentation';
import { type createGuideView } from './guide-view';
import { type createGuideReload } from './guide-reload';
import { type GuideCatalogChannel, type GuideHost } from './guide-model';
import { type GuideChannelCursor, type GuideCursor, type GuidePreview } from '../guide/native';

/** What this part reads from, and writes back to, mountGuide. */
export interface GuideSourcesEnvironment {
  readonly button: (label: string, action: () => void) => HTMLButtonElement;
  readonly run: ReturnType<typeof createGuidePresentation>['run'];
  readonly sourceName: { wrapper: HTMLLabelElement; field: HTMLInputElement };
  readonly discard: ReturnType<typeof createGuideView>['discard'];
  readonly host: GuideHost;
  selectedFile: { name: string; location: string } | null;
  readonly sourceUrl: { wrapper: HTMLLabelElement; field: HTMLInputElement };
  readonly grant: { wrapper: HTMLLabelElement; field: HTMLInputElement };
  readonly acceptPreview: ReturnType<typeof createGuideView>['acceptPreview'];
  readonly showPreview: ReturnType<typeof createGuideView>['showPreview'];
  readonly reload: ReturnType<typeof createGuideReload>['reload'];
  readonly status: HTMLElement;
  advancedMode: boolean;
  readonly automaticMessage: ReturnType<typeof createGuidePresentation>['automaticMessage'];
  readonly disposed: boolean;
  readonly foreground: boolean;
  readonly automaticResult: ReturnType<typeof createGuidePresentation>['automaticResult'];
  readonly discoveryRows: HTMLUListElement;
  readonly busy: boolean;
  readonly manualSource: HTMLDetailsElement;
  readonly setView: ReturnType<typeof createGuideView>['setView'];
  readonly text: (tag: string, value: string) => HTMLElement;
  readonly sourceTask: HTMLDivElement & { value: string; disabled: boolean };
  browsed: GuideCatalogChannel | null;
  readonly chosen: ReturnType<typeof createGuideView>['chosen'];
  readonly mapSearch: { wrapper: HTMLLabelElement; field: HTMLInputElement };
  preview: GuidePreview | null;
  afterId: GuideChannelCursor | null;
  readonly lookupChannels: ReturnType<typeof createGuideReload>['lookupChannels'];
  readonly nextId: GuideChannelCursor | null;
  readonly mapSource: HTMLSelectElement;
  readonly mapChannel: HTMLSelectElement;
  committing: boolean;
  readonly suspending: boolean;
  readonly actionController: AbortController | null;
  readonly controls: ReturnType<typeof createGuideView>['controls'];
  cursor: GuideCursor | null;
  readonly managedSource: HTMLSelectElement;
  readonly sourceAction: HTMLSelectElement;
}

/**
 * The guide's source actions: loading and picking a guide, finding guides
 * online, saving, mapping channels and managing sources. Part of mountGuide.
 */
export function createGuideSources(env: GuideSourcesEnvironment) {
  const load = env.button('Save source and preview', () =>
    env.run(async (signal) => {
      if (!env.sourceName.field.value.trim()) throw new Error('Name required');
      await env.discard();
      const result = await env.host.preview(
        {
          name: env.sourceName.field.value.trim(),
          location: env.selectedFile?.location ?? env.sourceUrl.field.value.trim(),
          kind: env.selectedFile ? 'file' : 'url',
          allowHttp: env.grant.field.checked,
        },
        signal,
      );
      await env.acceptPreview(result, signal);
      env.showPreview();
      env.reload();
    }),
  );
  const pick = env.button('Choose XMLTV file', () =>
    env.run(async (signal) => {
      env.selectedFile = (await env.host.pickFile?.(signal)) ?? null;
      if (env.selectedFile) {
        env.sourceName.field.value = env.selectedFile.name;
        env.sourceUrl.field.value = '';
        env.status.textContent = 'Guide file selected. Preview it before saving schedule data.';
      }
    }),
  );
  pick.hidden = !env.host.pickFile;
  const findGuides = env.button('Find program guides', () =>
    env.run(async (signal) => {
      if (!env.advancedMode && env.host.buildForChannels) {
        env.automaticMessage('Finding program guides…', true);
        const result = await env.host.buildForChannels(signal);
        signal.throwIfAborted();
        if (env.disposed || !env.foreground) return;
        env.automaticResult(result);
        env.reload();
        return;
      }
      const result = await env.host.discover!(signal);
      signal.throwIfAborted();
      if (env.disposed || !env.foreground) return;
      if (result.candidates.length > GUIDE_SOURCE_LIMIT || result.outcomes.length > 100)
        throw new Error('Guide discovery limit');
      env.discoveryRows.replaceChildren();
      for (const candidate of result.candidates) {
        const row = document.createElement('li');
        row.append(
          env.button(`${candidate.name} · ${candidate.playlistNames.join(', ')}`, () => {
            if (env.disposed || env.busy || !env.foreground) return;
            env.selectedFile = null;
            env.sourceName.field.value = candidate.name;
            env.sourceUrl.field.value = candidate.location;
            env.grant.field.checked = false;
            env.manualSource.open = true;
            env.status.textContent = candidate.requiresHttpPermission
              ? 'Guide link selected. This link requires your explicit HTTP permission before preview.'
              : 'Guide link selected. Preview it, review the counts, then save its programs.';
            if (!env.advancedMode && !candidate.requiresHttpPermission) load.click();
            else {
              env.advancedMode = true;
              env.setView('sources');
              env.sourceName.field.focus();
            }
          }),
        );
        if (candidate.limitations) row.append(env.text('p', candidate.limitations));
        env.discoveryRows.append(row);
      }
      const failed = result.outcomes.filter((outcome) => outcome.status === 'failed').length;
      env.status.textContent = result.candidates.length
        ? `${result.candidates.length} possible program guides found.${failed ? ` ${failed} playlists could not be checked.` : ''} Choose one to preview.`
        : `Your saved playlists did not include a program-guide link.${failed ? ` ${failed} playlists could not be checked.` : ''} You can add a guide link or file below.`;
    }),
  );
  const findEmpty = env.button('Find program guides', () => {
    if (!env.advancedMode && env.host.buildForChannels) {
      findGuides.click();
      return;
    }
    env.sourceTask.value = 'add';
    env.setView('sources');
    findGuides.click();
  });
  findEmpty.hidden = true;
  const mapEmpty = env.button('Map guide', () => {
    env.browsed = env.chosen();
    env.mapSearch.field.value = env.browsed?.name.slice(0, 256) ?? '';
    env.setView('mapping');
    env.reload();
  });
  mapEmpty.hidden = true;
  const returnGuide = env.button('Go back to Guide', () => {
    env.advancedMode = false;
    env.setView('channel');
    env.reload();
  });
  returnGuide.hidden = true;
  findGuides.hidden = !env.host.discover && !env.host.buildForChannels;
  const save = env.button('Save reviewed schedule', () =>
    env.run(async (signal) => {
      if (!env.preview) return;
      const receipt = await env.host.commitPreview(env.preview.ticket, signal);
      if (receipt.committed !== true) throw new Error('Missing receipt');
      env.preview = null;
      env.showPreview();
      env.status.textContent =
        receipt.matched !== undefined && receipt.unmatched !== undefined
          ? `Programs saved. ${receipt.matched} channels connected; ${receipt.unmatched} still need a guide.`
          : 'Reviewed guide schedule saved.';
      env.reload();
    }, true),
  );
  const discardButton = env.button('Discard schedule preview', () =>
    env.run(async () => {
      await env.discard();
      env.status.textContent = 'Schedule preview discarded. Saved source configuration retained.';
    }),
  );
  const lookup = env.button('Find guide channels', () => {
    env.afterId = null;
    env.lookupChannels();
  });
  const lookupNext = env.button('More guide channels', () => {
    env.afterId = env.nextId;
    env.lookupChannels();
  });
  const mapSave = env.button('Map selected channel', () =>
    env.run(async (signal) => {
      const channel = env.browsed ?? env.host.selectedChannel();
      if (!channel || !env.mapSource.value || !env.mapChannel.value)
        throw new Error('Mapping missing');
      const mapping = Object.freeze({
        catalogSourceId: channel.sourceId,
        appChannelId: channel.id,
        guideSourceId: env.mapSource.value,
        xmltvChannelId: env.mapChannel.value,
      });
      let mappingSaved = false;
      try {
        if (env.host.mapAndHydrate) {
          const result = await env.host.mapAndHydrate(mapping, signal, () => {
            mappingSaved = true;
            env.committing = false;
            env.automaticMessage('Guide connection saved. Checking its schedule…', true);
            if (env.disposed || env.suspending || !env.foreground) env.actionController?.abort();
            env.controls();
          });
          if (!env.disposed && env.foreground && !signal.aborted)
            env.automaticMessage(mappedGuideResultText(result));
        } else {
          await env.host.setMapping(mapping, signal);
          mappingSaved = true;
          env.status.textContent = 'Program guide connected.';
        }
      } catch (failure) {
        if (mappingSaved && !env.disposed && env.foreground)
          env.automaticMessage(
            'Guide connection saved. Schedule cleanup could not be confirmed. Retry closing.',
          );
        throw failure;
      } finally {
        if (mappingSaved) {
          env.cursor = null;
          if (!env.disposed && env.foreground && !signal.aborted) {
            if (!env.advancedMode) env.setView('channel');
            env.reload();
          }
        }
      }
    }, true),
  );
  const manageAction = env.button('Run source action', () =>
    env.run(async (signal) => {
      if (!env.managedSource.value) throw new Error('Source missing');
      if (env.sourceAction.value === 'remove') {
        await env.host.removeSource(env.managedSource.value, signal);
        env.status.textContent = 'Guide source removed. Catalog channels retained.';
        env.reload();
      } else {
        await env.discard();
        await env.acceptPreview(
          await env.host.preview({ sourceId: env.managedSource.value }, signal),
          signal,
        );
        env.showPreview();
      }
    }, env.sourceAction.value === 'remove'),
  );
  return {
    discardButton,
    findEmpty,
    findGuides,
    load,
    lookup,
    lookupNext,
    manageAction,
    mapEmpty,
    mapSave,
    pick,
    returnGuide,
    save,
  };
}
