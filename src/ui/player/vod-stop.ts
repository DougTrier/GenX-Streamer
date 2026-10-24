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

import { restoreRemoteFocus } from '../shell/remote-navigation';

/** The existing archive owner performs Stop and captures the resume bookmark. */
export function mountVODStop(
  button: HTMLButtonElement,
  host: {
    stop(): Promise<void>;
    changed(): void;
    run(work: Promise<void>): void;
    focusFallback(): void;
    canRestoreFocus?(): boolean;
  },
) {
  let visible = false,
    available = false,
    closed = false;
  let pending: Promise<void> | null = null;
  const doc = button.ownerDocument;
  let handoff: HTMLElement | null = null,
    selectedTitle: HTMLElement | null = null,
    selectedIdentity: string | null = null,
    ownsHandoff = false,
    transferring = false,
    handoffQueued = false;
  const focusMoved = (event: FocusEvent) => {
    if (ownsHandoff && !transferring && event.target !== handoff) ownsHandoff = false;
  };
  const pointerMoved = (event: PointerEvent) => {
    if (ownsHandoff && event.target instanceof Node && !handoff?.contains(event.target))
      ownsHandoff = false;
  };
  const focusLost = (event: FocusEvent) => {
    if (!ownsHandoff || event.target !== handoff || transferring || handoffQueued) return;
    const expected = handoff;
    handoffQueued = true;
    // Visibility-triggered blur can precede joined native Stop by seconds.
    // Let a real focusin/user action win before repairing that orphaned handoff.
    queueMicrotask(() => {
      handoffQueued = false;
      if (handoff === expected) restoreHandoff();
    });
  };
  doc.addEventListener('focusin', focusMoved);
  doc.addEventListener('focusout', focusLost);
  doc.addEventListener('pointerdown', pointerMoved, true);
  const eligible = (node: HTMLElement | null): node is HTMLElement => {
    if (
      !node?.isConnected ||
      node.matches(':disabled,[aria-disabled="true"]') ||
      node.closest('[hidden],[inert]') ||
      !node.checkVisibility({ visibilityProperty: true }) ||
      !node.getClientRects().length
    )
      return false;
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement)
      if (
        ancestor instanceof HTMLDetailsElement &&
        !ancestor.open &&
        !ancestor.querySelector(':scope > summary')?.contains(node)
      )
        return false;
    return true;
  };
  function restoreHandoff(): void {
    if (
      !ownsHandoff ||
      !handoff ||
      closed ||
      !visible ||
      doc.hidden ||
      host.canRestoreFocus?.() === false ||
      button.closest('[inert]') ||
      eligible(handoff) ||
      (doc.activeElement !== handoff && doc.activeElement !== doc.body) ||
      [...doc.querySelectorAll<HTMLElement>('dialog[open],[aria-modal="true"]')].some((node) =>
        node.checkVisibility({ visibilityProperty: true }),
      )
    )
      return;
    const title = doc.querySelector<HTMLElement>('.gx-archive-title-button[aria-current="true"]');
    if (
      !title ||
      (selectedIdentity !== null
        ? title.dataset.archiveRef !== selectedIdentity
        : title !== selectedTitle)
    )
      return;
    // Only the current selected card is ours; never jump to an unrelated result.
    const targets = [
      ...(title
        ?.closest('.gx-archive-result-row')
        ?.querySelectorAll<HTMLElement>('.gx-archive-file-button') ?? []),
      title,
    ];
    const target = targets.find(eligible);
    if (target && restoreRemoteFocus(target)) {
      // Reveal only this result-list owner; never scrollIntoView the workspace/header.
      const list = target.closest<HTMLElement>('.gx-archive-results');
      if (list) {
        const viewport = list.getBoundingClientRect(),
          box = target.getBoundingClientRect();
        const top = Math.max(0, viewport.top + list.clientTop) + 4;
        const bottom =
          Math.min(
            doc.defaultView!.innerHeight,
            viewport.top + list.clientTop + list.clientHeight,
          ) - 4;
        if (bottom > top) {
          if (box.top < top || box.height > bottom - top) list.scrollTop += box.top - top;
          else if (box.bottom > bottom) list.scrollTop += box.bottom - bottom;
        }
      }
    }
  }
  function render(show = visible, canStop = available): void {
    visible = show;
    available = canStop;
    const disabled = closed || !available || pending !== null;
    if (
      (!visible || disabled) &&
      button.ownerDocument.activeElement === button &&
      !button.ownerDocument.hidden &&
      !button.closest('[hidden],[inert]') &&
      button.getClientRects().length > 0 &&
      host.canRestoreFocus?.() !== false
    ) {
      transferring = true;
      try {
        host.focusFallback();
      } finally {
        transferring = false;
      }
      if (pending) {
        handoff =
          doc.activeElement instanceof HTMLElement && doc.activeElement !== button
            ? doc.activeElement
            : null;
        ownsHandoff = eligible(handoff);
      }
    }
    button.hidden = !visible;
    button.disabled = disabled;
    button.setAttribute('aria-busy', String(pending !== null));
  }
  const stop = () => {
    if (closed || !visible || !available || pending) return;
    selectedTitle = doc.querySelector<HTMLElement>('.gx-archive-title-button[aria-current="true"]');
    selectedIdentity = selectedTitle?.dataset.archiveRef ?? null;
    const work = Promise.resolve()
      .then(() => host.stop())
      .finally(() => {
        if (pending === work) pending = null;
        try {
          if (!closed) {
            host.changed();
            render();
            restoreHandoff();
          }
        } finally {
          ownsHandoff = false;
          handoff = null;
          selectedTitle = null;
          selectedIdentity = null;
        }
      });
    pending = work;
    render();
    host.run(work);
  };
  button.addEventListener('click', stop);
  render();
  return {
    render,
    async dispose(): Promise<void> {
      closed = true;
      ownsHandoff = false;
      doc.removeEventListener('focusin', focusMoved);
      doc.removeEventListener('focusout', focusLost);
      doc.removeEventListener('pointerdown', pointerMoved, true);
      button.removeEventListener('click', stop);
      render();
      await pending;
    },
  };
}
