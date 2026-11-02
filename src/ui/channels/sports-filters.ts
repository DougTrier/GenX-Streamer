// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { leagues, sports, type SportsFacet, type SportsScope } from '../../search/sports';

/** Native selects remain the canonical controls; the existing TV select owner enhances them. */
export function mountSportsFilters(container: HTMLElement, changed: (facet: SportsFacet) => void) {
  const doc = container.ownerDocument;
  container.classList.add('sports-filters');
  const controls = doc.createElement('div');
  controls.className = 'sports-filter-controls';
  const sportLabel = doc.createElement('label');
  sportLabel.textContent = 'Sport';
  const sport = doc.createElement('select');
  sport.setAttribute('aria-label', 'Sport');
  const leagueLabel = doc.createElement('label');
  leagueLabel.textContent = 'League';
  const league = doc.createElement('select');
  league.setAttribute('aria-label', 'League');
  const option = (value: string, label: string) => {
    const node = doc.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
  };
  sport.append(option('', 'All Sports'), ...sports.map((entry) => option(entry.id, entry.label)));
  sportLabel.append(sport);
  leagueLabel.append(league);
  controls.append(sportLabel, leagueLabel);
  const status = doc.createElement('p');
  status.className = 'sports-inclusion-status';
  status.setAttribute('role', 'status');
  status.title =
    'Only matching PPV entries are included. Saved schedules may be incomplete or stale; a match does not establish that an event is live.';
  container.replaceChildren(controls, status);
  let active = false;
  let scope: SportsScope | undefined;
  const value = (): SportsFacet => ({
    ...(sport.value ? { sport: sport.value } : {}),
    ...(league.value ? { league: league.value } : {}),
  });
  const present = () => {
    controls.hidden = !active;
    status.hidden = scope?.includePpv !== true;
    status.textContent = status.hidden
      ? ''
      : 'Matching PPV included · saved schedules, next 7 days';
    container.hidden = !active && status.hidden;
  };
  const updateLeagues = () => {
    const choices = leagues.filter((entry) => entry.sportId === sport.value);
    league.replaceChildren(
      option('', 'All Leagues'),
      ...choices.map((entry) => option(entry.id, entry.label)),
    );
    leagueLabel.hidden = choices.length === 0;
  };
  const sportChanged = () => {
    updateLeagues();
    changed(value());
  };
  const leagueChanged = () => changed(value());
  sport.addEventListener('change', sportChanged);
  league.addEventListener('change', leagueChanged);
  updateLeagues();
  present();
  return {
    value,
    setFacet(facet: SportsFacet) {
      sport.value =
        facet.sport ?? leagues.find((entry) => entry.id === facet.league)?.sportId ?? '';
      updateLeagues();
      league.value = facet.league ?? '';
    },
    setActive(next: boolean) {
      active = next;
      present();
    },
    presentScope(next: SportsScope | undefined) {
      scope = next;
      present();
    },
    dispose() {
      sport.removeEventListener('change', sportChanged);
      league.removeEventListener('change', leagueChanged);
    },
  };
}
