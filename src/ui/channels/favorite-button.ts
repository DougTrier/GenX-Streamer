// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0

export function renderFavoriteButton(
  button: HTMLButtonElement,
  favorite: boolean,
  pending: boolean,
): void {
  const row = button.dataset.channelAction === 'favorite';
  const label = row ? (favorite ? '★' : '☆') : favorite ? '★ Favorited' : '☆ Favorite';
  button.setAttribute('aria-pressed', String(favorite));
  if (pending) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
  if (button.textContent !== label) button.textContent = label;
}
