/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { validateHistoryIds } from '../playback/watch-history';

/** Exact watched identities, captured from one live tab/account before Guide paging. */
export interface GuideHistoryScope {
  ids: readonly string[];
  hideAdult: boolean;
}

export function captureGuideHistory(value: GuideHistoryScope): GuideHistoryScope {
  if (!value || typeof value.hideAdult !== 'boolean')
    throw new Error('The watched guide scope is invalid.');
  return { ids: validateHistoryIds(value.ids), hideAdult: value.hideAdult };
}
