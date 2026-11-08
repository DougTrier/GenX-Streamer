// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { boundedUtf8Text } from '../platform/bounded-text';

export interface FavoriteTeam {
  id: string;
  name: string;
  sport: string;
  location: string;
  level?: string;
  league?: string;
  scheduleUrl?: string;
  broadcasterUrl?: string;
}

export const MAX_FAVORITE_TEAMS = 128;

function teamText(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    !boundedUtf8Text(value, max) ||
    [...value].some((char) => char < ' ' || char === '\x7f')
  )
    throw new Error('Check the team details.');
  return value.trim();
}

export function validateFavoriteTeams(value: unknown): FavoriteTeam[] {
  if (!Array.isArray(value) || value.length > MAX_FAVORITE_TEAMS)
    throw new Error(`Save up to ${MAX_FAVORITE_TEAMS} favorite teams.`);
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (key) =>
          ![
            'id',
            'name',
            'sport',
            'location',
            'level',
            'league',
            'scheduleUrl',
            'broadcasterUrl',
          ].includes(key),
      )
    )
      throw new Error('Check the team details.');
    const row = item as Record<string, unknown>;
    const id = teamText(row.id, 128);
    if (id !== row.id || !/^[a-z0-9-]+$/u.test(id) || ids.has(id))
      throw new Error('Invalid or duplicate team ID.');
    ids.add(id);
    const team: FavoriteTeam = {
      id,
      name: teamText(row.name, 160),
      sport: teamText(row.sport, 160),
      location: teamText(row.location, 160),
    };
    for (const field of ['level', 'league'] as const)
      if (row[field] !== undefined) team[field] = teamText(row[field], 160);
    for (const field of ['scheduleUrl', 'broadcasterUrl'] as const) {
      if (row[field] === undefined) continue;
      const url = teamText(row[field], 2048);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error('Enter a valid HTTPS schedule link.');
      }
      if (
        !/^https:\/\//iu.test(url) ||
        /[\s\\#]|%(?![0-9a-f]{2})/iu.test(url) ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password
      )
        throw new Error('Enter a public HTTPS schedule link without sign-in details.');
      team[field] = url;
    }
    return team;
  });
}
