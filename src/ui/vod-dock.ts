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

/** Presentation follows the selected playback mode and existing capability owners. */
export function installVODDock(
  app: HTMLElement,
  canRestoreFocus: () => boolean = () => true,
): {
  render(onDemand: boolean): void;
  dispose(): void;
} {
  const dock = app.querySelector<HTMLElement>('.dock')!;
  const actions = dock.querySelector<HTMLElement>('.channel-actions')!;
  const quality = dock.querySelector<HTMLElement>('#video-quality')!;
  const captions = dock.querySelector<HTMLButtonElement>('#captions-button')!;
  let onDemand = false;
  let disposed = false;
  const visible = (element: HTMLElement) =>
    !element.closest('[hidden], [inert]') &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== 'hidden';
  const hidden = (element: HTMLElement, value: boolean) => {
    if (element.hidden !== value) element.hidden = value;
  };
  const refresh = () => {
    if (disposed) return;
    const focused = document.activeElement;
    hidden(actions, onDemand);
    const qualityButton = quality.querySelector<HTMLButtonElement>('.video-quality-button');
    hidden(quality, onDemand && (!qualityButton || qualityButton.disabled));
    hidden(captions, onDemand && captions.disabled);
    if (
      focused instanceof HTMLElement &&
      dock.contains(focused) &&
      !visible(focused) &&
      !document.hidden &&
      !app.closest('[inert]') &&
      canRestoreFocus()
    ) {
      for (const id of ['pause-button', 'mute-button', 'fullscreen-button', 'vod-rewind']) {
        const target = dock.querySelector<HTMLButtonElement>(`#${id}`);
        if (target && !target.disabled && visible(target)) {
          target.focus({ preventScroll: true });
          break;
        }
      }
    }
  };
  // Capability discovery can arrive after selection. Observe the actual
  // controls rather than assuming every MP4 lacks captions/audio/renditions.
  // Only real changes count: the player rewrites the same text and flags
  // several times a second while a channel plays, and each refresh measures
  // the focused control, which forced a full layout on the Sansui TV and made
  // every remote press lag (October 19, 2026).
  const observer = new MutationObserver((records) => {
    if (
      records.some((record) =>
        record.type === 'attributes'
          ? (record.target as Element).getAttribute(record.attributeName!) !== record.oldValue
          : [...record.addedNodes, ...record.removedNodes].some(
              (node) => node.nodeType === Node.ELEMENT_NODE,
            ),
      )
    )
      refresh();
  });
  observer.observe(dock, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['disabled', 'hidden'],
  });
  return {
    render(value) {
      if (disposed) return;
      onDemand = value;
      app.dataset.playMode = value ? 'on-demand' : 'live';
      refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      delete app.dataset.playMode;
      hidden(actions, false);
      hidden(quality, false);
      hidden(captions, false);
    },
  };
}
