// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import type { TeamGamesResult } from '../../application/guide/team-games';
import type { CatalogRow } from '../../platform/catalog-query';
import {
  MAX_FAVORITE_TEAMS,
  validateFavoriteTeams,
  type FavoriteTeam,
} from '../../preferences/favorite-teams';
import { findTeams, teamSearchKey } from '../../search/team-directory';
import { matchupKey } from '../../search/team-web-search';
import { matchesSportsFacet, sportsFacts } from '../../search/sports';

interface FavoriteTeamsHost {
  read(): readonly FavoriteTeam[];
  location(): string;
  update(change: (current: FavoriteTeam[]) => FavoriteTeam[]): Promise<boolean>;
  openSettings(): void;
  lookupIllinois?(query: string, signal: AbortSignal): Promise<FavoriteTeam[]>;
  discover(
    team: FavoriteTeam,
    signal: AbortSignal,
    includeChannels: boolean,
  ): Promise<TeamGamesResult>;
  channelName(channel: Pick<CatalogRow, 'id' | 'sourceId'>): string | undefined;
  tune(channel: Pick<CatalogRow, 'id' | 'sourceId'>): void;
  watch(url: string, title: string): void;
}

const details = (team: FavoriteTeam) =>
  [team.sport, team.location, team.level, team.league].filter(Boolean).join(' · ');
const fields = [
  'name',
  'sport',
  'location',
  'level',
  'league',
  'scheduleUrl',
  'broadcasterUrl',
] as const;
const gameTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function mountFavoriteTeams(
  panel: HTMLElement,
  sports: HTMLElement,
  host: FavoriteTeamsHost,
) {
  const doc = panel.ownerDocument;
  panel.innerHTML = `
    <h3>Favorite Teams</h3>
    <p>Search by school or team name, city, conference, or sport. GenX checks the Illinois high school directory when the included teams don’t match.</p>
    <div class="dialog-actions">
      <button type="button" data-add-team>Add team manually</button>
      <button type="button" data-view-teams>View My Teams</button>
    </div>
    <label>Search teams <input type="search" autocomplete="off" maxlength="160"
      placeholder="Team, sport, league or city"></label>
    <p data-team-results-summary role="status"></p>
    <ul class="team-list" data-team-results aria-label="Team search results"></ul>
    <form hidden>
      <h4 data-editor-title>Add team manually</h4>
      <label>Team, school or club name <input name="name" maxlength="160" required></label>
      <label>Sport <input name="sport" maxlength="160" required></label>
      <label>City or region <input name="location" maxlength="160" required></label>
      <label>Competition level <input name="level" maxlength="160"
        placeholder="Pro, college, semi-pro, high school or other"></label>
      <label>League or conference <input name="league" maxlength="160"></label>
      <label>Official schedule URL (optional) <input name="scheduleUrl" type="url"
        maxlength="2048" placeholder="https://"></label>
      <label>Official station or broadcaster listings URL (optional) <input name="broadcasterUrl"
        type="url" maxlength="2048" placeholder="https://"></label>
      <div class="dialog-actions">
        <button type="submit" class="primary">Save team</button>
        <button type="button" data-cancel-team>Cancel</button>
      </div>
    </form>
    <p data-team-status role="status"></p>
    <h4>Followed teams</h4>
    <ul class="team-list" data-saved-teams aria-label="Followed teams"></ul>`;
  const dialog = doc.createElement('dialog');
  dialog.className = 'my-teams-dialog';
  dialog.setAttribute('aria-label', 'My Teams');
  dialog.innerHTML = `
    <div class="dialog-head"><h2>My Teams</h2><button type="button" data-find-all-games>Find all games</button><button type="button" aria-label="Close My Teams">×</button></div>
    <div class="dialog-body">
      <p>Find games in the guide and official listings. When needed, web search uses the team's name, sport and city.</p>
      <p data-empty-teams>Follow a team in Favorite Teams to see it here.</p>
      <ul class="team-list" aria-label="My followed teams"></ul>
    </div>
    <div class="dialog-actions"><button type="button" data-manage-teams>Manage Favorite Teams</button></div>`;
  // Mount beside Settings so TV Back and focus restoration use the normal modal owner.
  panel.closest('dialog')!.after(dialog);
  const entry = doc.createElement('button');
  entry.type = 'button';
  entry.className = 'my-teams-entry';
  entry.textContent = 'My Teams';
  entry.setAttribute('aria-pressed', 'false');
  entry.setAttribute('aria-controls', 'my-teams-browse');
  sports.append(entry);
  const browseResults = doc.createElement('section');
  browseResults.id = 'my-teams-browse';
  browseResults.className = 'my-teams-browse';
  browseResults.setAttribute('aria-label', 'My Teams results');
  browseResults.hidden = true;
  browseResults.tabIndex = 0;
  const browseHead = doc.createElement('div');
  browseHead.className = 'my-teams-browse-head';
  const browseTitle = doc.createElement('h3');
  browseTitle.textContent = 'My Teams';
  browseHead.append(
    browseTitle,
    action('Back to channels', () => {
      closeBrowse();
      const control = entry.checkVisibility() ? entry : doc.getElementById('phone-filter-button');
      control?.focus({ preventScroll: true });
    }),
  );
  browseResults.append(browseHead);
  doc.getElementById('channel-list')!.before(browseResults);
  const search = panel.querySelector<HTMLInputElement>('input[type="search"]')!;
  const results = panel.querySelector<HTMLUListElement>('[data-team-results]')!;
  const summary = panel.querySelector<HTMLElement>('[data-team-results-summary]')!;
  const saved = panel.querySelector<HTMLUListElement>('[data-saved-teams]')!;
  const status = panel.querySelector<HTMLElement>('[data-team-status]')!;
  const findAll = dialog.querySelector<HTMLButtonElement>('[data-find-all-games]')!;
  const myTeams = dialog.querySelector<HTMLUListElement>('.dialog-body > .team-list')!;
  const add = panel.querySelector<HTMLButtonElement>('[data-add-team]')!;
  const form = panel.querySelector('form')!;
  const field = (name: Exclude<keyof FavoriteTeam, 'id'>) =>
    form.elements.namedItem(name) as HTMLInputElement;
  let editing: FavoriteTeam | undefined;
  let editorOpener: HTMLButtonElement | undefined;
  let busy = false;
  let schoolLookup: AbortController | undefined;
  let schoolTimer: ReturnType<typeof setTimeout> | undefined;
  let schoolMatches: FavoriteTeam[] = [];
  let schoolSearchStatus = '';
  const pendingFollows = new Set<string>();
  let lookup: AbortController | undefined;
  let lookupButton: HTMLButtonElement | undefined;
  const gameResults = doc.createElement('section');
  const gameStatus = doc.createElement('p');
  const games = doc.createElement('ul');
  const channelResults = doc.createElement('ul');
  gameResults.className = 'team-game-results';
  gameStatus.setAttribute('role', 'status');
  games.setAttribute('aria-label', 'Games found');
  channelResults.setAttribute('aria-label', 'Matching Free TV channels');
  channelResults.hidden = true;
  gameResults.append(gameStatus, channelResults, games);

  function closeBrowse(): boolean {
    if (browseResults.hidden) return false;
    if (lookupButton === entry) lookup?.abort();
    browseResults.hidden = true;
    entry.setAttribute('aria-pressed', 'false');
    if (gameResults.parentElement === browseResults) gameResults.remove();
    return true;
  }

  const closeBeforePlayback = () => {
    closeBrowse();
    if (dialog.open) dialog.close();
    panel.closest('dialog')?.close();
  };

  function row(team: FavoriteTeam): HTMLLIElement {
    const item = doc.createElement('li');
    const title = doc.createElement('strong');
    const subtitle = doc.createElement('span');
    title.textContent = team.name;
    subtitle.textContent = details(team);
    item.append(title, subtitle);
    return item;
  }

  function action(label: string, activate: (button: HTMLButtonElement) => void): HTMLButtonElement {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => activate(button));
    return button;
  }

  async function findGames(
    teams: readonly FavoriteTeam[],
    button: HTMLButtonElement,
  ): Promise<void> {
    const inline = button === entry;
    if (!teams.length && !inline) return;
    if (lookup) {
      if (button === findAll && findAll.getAttribute('aria-busy') === 'true') {
        lookup.abort();
        gameStatus.textContent = 'Search stopped.';
      }
      return;
    }
    const request = new AbortController();
    lookup = request;
    lookupButton = button;
    const all = inline || button === findAll;
    button.setAttribute('aria-busy', 'true');
    if (!inline) button.setAttribute('aria-expanded', 'true');
    const previous = gameResults.closest('li')?.querySelector('button') ?? findAll;
    if (previous && previous !== button) previous.setAttribute('aria-expanded', 'false');
    if (inline) {
      entry.setAttribute('aria-pressed', 'true');
      browseResults.hidden = false;
      browseResults.append(gameResults);
    } else if (all) {
      button.textContent = 'Stop search';
      myTeams.before(gameResults);
    } else button.parentElement!.append(gameResults);
    games.replaceChildren();
    channelResults.replaceChildren();
    channelResults.hidden = true;
    let completed = 0;
    let unavailable = false;
    let webUnavailable = false;
    const found = new Map<string, TeamGamesResult['games'][number]>();
    const items = new Map<string, HTMLLIElement>();
    const channelKeys = new Set<string>();
    const owned = () => !request.signal.aborted && (inline ? !browseResults.hidden : dialog.open);
    const present = () => {
      const count = found.size;
      const progress = all
        ? `Checking teams… ${completed} of ${teams.length}.`
        : `Checking listings for ${teams[0]!.name}…`;
      gameStatus.textContent = [
        !teams.length
          ? 'Follow teams in Settings, or choose a sport that includes a followed team.'
          : '',
        completed < teams.length ? progress : '',
        count
          ? `${count} ${count === 1 ? 'game' : 'games'} found.`
          : teams.length && completed === teams.length && !channelKeys.size
            ? 'No matching channels or games found in the sources checked.'
            : '',
        channelKeys.size
          ? `${channelKeys.size} matching Free TV ${channelKeys.size === 1 ? 'channel' : 'channels'} found.`
          : '',
        completed === teams.length && unavailable ? 'Some listings could not be checked.' : '',
        completed === teams.length && webUnavailable
          ? 'Web search was unavailable for some teams.'
          : '',
      ]
        .filter(Boolean)
        .join(' ');
    };
    const render = (
      key: string,
      game: TeamGamesResult['games'][number],
      listings: TeamGamesResult['games'][number]['listings'],
    ) => {
      let item = items.get(key);
      if (!item) {
        item = doc.createElement('li');
        const title = doc.createElement('strong');
        const time = doc.createElement('span');
        title.textContent = game.title;
        time.textContent = gameTime.format(game.startMs);
        item.append(title, time);
        item.dataset.gameTime = String(game.startMs);
        items.set(key, item);
        const later = [...games.children].find(
          (node) => Number((node as HTMLElement).dataset.gameTime) > game.startMs,
        );
        games.insertBefore(item, later ?? null);
      }
      for (const listing of listings) {
        const source = doc.createElement('span');
        const channel = listing.guideChannel;
        const channelName = channel ? host.channelName(channel) : undefined;
        const origin = channel ? `${listing.source} (Free TV)` : listing.source;
        source.textContent = channelName ? `${origin} · ${channelName}` : origin;
        item.append(source);
        if (
          inline &&
          channel &&
          channelName &&
          game.startMs <= Date.now() &&
          (channel.stopMs ?? game.startMs) > Date.now()
        ) {
          item.append(
            action(`Tune ${channelName}`, () => {
              closeBeforePlayback();
              host.tune(channel);
            }),
          );
        }
        if (!listing.watchUrl) continue;
        const url = listing.watchUrl;
        const watch = action('Open game in Web Viewer', () => {
          closeBeforePlayback();
          host.watch(url, game.title);
        });
        watch.setAttribute('aria-label', `Open ${game.title} in Web Viewer via ${listing.source}`);
        item.append(watch);
      }
    };
    let cursor = 0;
    const worker = async () => {
      while (owned() && cursor < teams.length) {
        const team = teams[cursor++]!;
        try {
          const result = await host.discover(team, request.signal, inline);
          if (!owned()) return;
          unavailable ||= result.unavailable > 0;
          webUnavailable ||= result.webSearch === 'unavailable';
          for (const channel of result.channels ?? []) {
            const key = JSON.stringify([channel.sourceId, channel.id]);
            if (channelKeys.has(key) || !host.channelName(channel)) continue;
            channelKeys.add(key);
            const item = doc.createElement('li');
            item.append(
              action(`Tune ${channel.name}`, () => {
                closeBeforePlayback();
                host.tune(channel);
              }),
            );
            channelResults.append(item);
            channelResults.hidden = false;
          }
          for (const game of result.games) {
            const key = `${game.startMs}:${matchupKey(game.title) ?? teamSearchKey(game.title)}`;
            const existing = found.get(key) ?? { ...game, listings: [] };
            const additions = game.listings.filter(
              (listing) =>
                !existing.listings.some(
                  (item) =>
                    item.source === listing.source &&
                    item.watchUrl === listing.watchUrl &&
                    item.guideChannel?.id === listing.guideChannel?.id &&
                    item.guideChannel?.sourceId === listing.guideChannel?.sourceId,
                ),
            );
            existing.listings.push(...additions);
            found.set(key, existing);
            render(key, existing, additions);
          }
        } catch {
          unavailable = true;
        }
        completed++;
        if (owned()) present();
      }
    };
    present();
    try {
      await Promise.all(Array.from({ length: Math.min(3, teams.length) }, worker));
    } finally {
      button.removeAttribute('aria-busy');
      if (button === findAll) button.textContent = 'Find all games';
      lookup = undefined;
      lookupButton = undefined;
    }
  }

  async function commit(
    change: (current: FavoriteTeam[]) => FavoriteTeam[],
    message: string,
  ): Promise<boolean> {
    if (busy) return false;
    busy = true;
    status.textContent = 'Saving…';
    try {
      const ok = await host.update(change);
      status.textContent = ok ? message : 'Teams could not be saved. Try again.';
      return ok;
    } catch {
      status.textContent = 'Teams could not be saved. Try again.';
      return false;
    } finally {
      busy = false;
    }
  }

  function showEditor(opener: HTMLButtonElement, team?: FavoriteTeam): void {
    if (busy) return;
    editing = team;
    editorOpener = opener;
    const directoryTeam = !!team && !team.id.startsWith('manual-');
    form.querySelector('[data-editor-title]')!.textContent = team
      ? 'Edit team'
      : 'Add team manually';
    for (const name of fields) {
      field(name).value = team?.[name] ?? (name === 'location' ? host.location() : '');
      field(name).readOnly = directoryTeam && name !== 'scheduleUrl' && name !== 'broadcasterUrl';
    }
    form.hidden = false;
    status.textContent = '';
    field(directoryTeam ? 'scheduleUrl' : 'name').focus();
  }

  function hideEditor(): void {
    form.hidden = true;
    editing = undefined;
    if (editorOpener?.isConnected && editorOpener.checkVisibility()) editorOpener.focus();
    editorOpener = undefined;
  }

  function refreshSearch(teams = host.read()): void {
    const included = findTeams(search.value, teams);
    const found = [
      ...new Map([...schoolMatches, ...included].map((team) => [team.id, team])).values(),
    ].slice(0, 24);
    summary.textContent = !search.value.trim()
      ? 'Search by name, sport, league or place.'
      : found.length === 24
        ? 'Showing 24 matches. Add a school name or sport to narrow your search.'
        : found.length
          ? `${found.length} ${found.length === 1 ? 'match' : 'matches'}`
          : schoolSearchStatus || 'No directory matches. You can add the team manually.';
    results.replaceChildren(
      ...found.map((team) => {
        const item = row(team);
        const follow = action('Follow', async () => {
          if (pendingFollows.has(team.id) || host.read().some(({ id }) => id === team.id)) return;
          if (host.read().length + pendingFollows.size >= MAX_FAVORITE_TEAMS) {
            status.textContent = `Save up to ${MAX_FAVORITE_TEAMS} favorite teams.`;
            return;
          }
          pendingFollows.add(team.id);
          presentFollowButtons();
          let ok = false;
          try {
            ok = await host.update((current) =>
              current.some(({ id }) => id === team.id) ? current : [...current, team],
            );
          } catch {
            // The button becomes available again when the save fails.
          } finally {
            pendingFollows.delete(team.id);
            presentFollowButtons();
          }
          status.textContent = ok
            ? `Following ${team.name}.`
            : `${team.name} could not be saved. Try again.`;
          if (ok) refresh(false);
        });
        follow.dataset.followTeam = team.id;
        follow.dataset.teamLabel = `${team.name} · ${details(team)}`;
        item.append(follow);
        return item;
      }),
    );
    presentFollowButtons();
  }

  function stopSchoolSearch(): void {
    clearTimeout(schoolTimer);
    schoolLookup?.abort();
    schoolLookup = undefined;
  }

  function searchTeams(): void {
    stopSchoolSearch();
    schoolMatches = [];
    schoolSearchStatus = '';
    const query = search.value.trim();
    const lookup = host.lookupIllinois;
    if (lookup && teamSearchKey(query).length >= 3 && !findTeams(query, []).length) {
      const request = new AbortController();
      schoolLookup = request;
      schoolSearchStatus = 'Checking the Illinois high school directory…';
      schoolTimer = setTimeout(() => {
        void lookup(query, request.signal).then(
          (matches) => {
            if (request.signal.aborted) return;
            schoolMatches = matches;
            schoolSearchStatus = 'No Illinois school matches. Try a school name or city.';
            refreshSearch();
          },
          () => {
            if (request.signal.aborted) return;
            schoolSearchStatus =
              'The Illinois school directory is unavailable. Try again or add the team manually.';
            refreshSearch();
          },
        );
      }, 300);
    }
    refreshSearch();
  }

  function presentFollowButtons(): void {
    const followed = new Set(host.read().map(({ id }) => id));
    for (const button of results.querySelectorAll<HTMLButtonElement>('[data-follow-team]')) {
      const pending = pendingFollows.has(button.dataset.followTeam!);
      const saved = followed.has(button.dataset.followTeam!);
      const label = pending ? 'Following…' : saved ? 'Following' : 'Follow';
      button.textContent = label;
      button.setAttribute('aria-label', `${label} ${button.dataset.teamLabel}`);
      button.setAttribute('aria-disabled', String(pending || saved));
      button.setAttribute('aria-busy', String(pending));
    }
  }

  function focusSaved(id?: string, operation = 'edit'): void {
    const item = [...saved.children].find((node) => (node as HTMLElement).dataset.teamId === id);
    const button =
      item?.querySelector<HTMLButtonElement>(`button[data-team-action="${operation}"]:enabled`) ??
      item?.querySelector<HTMLButtonElement>('button[data-team-action="edit"]');
    if (panel.checkVisibility()) (button ?? add).focus({ preventScroll: false });
  }

  function refresh(searchResults = true): void {
    const teams = host.read();
    if (searchResults) refreshSearch(teams);
    findAll.disabled = teams.length === 0;
    saved.replaceChildren(
      ...teams.map((team, index) => {
        const item = row(team);
        item.dataset.teamId = team.id;
        const controls = doc.createElement('div');
        controls.className = 'team-actions';
        const move = (step: -1 | 1) => {
          const operation = step === -1 ? 'up' : 'down';
          const button = action(step === -1 ? 'Move up' : 'Move down', async () => {
            if (
              await commit((current) => {
                const from = current.findIndex(({ id }) => id === team.id);
                const to = from + step;
                if (from < 0 || to < 0 || to >= current.length) return current;
                [current[from], current[to]] = [current[to]!, current[from]!];
                return current;
              }, 'Team order saved.')
            ) {
              refresh();
              focusSaved(team.id, operation);
            }
          });
          button.dataset.teamAction = operation;
          button.disabled = step === -1 ? index === 0 : index === teams.length - 1;
          button.setAttribute('aria-label', `${button.textContent} ${team.name}`);
          return button;
        };
        const edit = action('Edit', (button) => showEditor(button, team));
        edit.dataset.teamAction = 'edit';
        edit.setAttribute('aria-label', `Edit ${team.name} · ${details(team)}`);
        const remove = action('Remove', async () => {
          if (
            await commit(
              (current) => current.filter(({ id }) => id !== team.id),
              `Stopped following ${team.name}.`,
            )
          ) {
            if (editing?.id === team.id) hideEditor();
            refresh();
            focusSaved(host.read()[Math.min(index, host.read().length - 1)]?.id);
          }
        });
        remove.setAttribute('aria-label', `Remove ${team.name} · ${details(team)}`);
        controls.append(move(-1), move(1), edit, remove);
        item.append(controls);
        return item;
      }),
    );
    if (dialog.open) return;
    myTeams.replaceChildren(
      ...teams.map((team) => {
        const item = row(team);
        const find = action('Find games', (button) => void findGames([team], button));
        find.setAttribute('aria-label', `Find games for ${team.name} · ${team.sport}`);
        find.setAttribute('aria-expanded', 'false');
        item.append(find);
        return item;
      }),
    );
    dialog.querySelector<HTMLElement>('[data-empty-teams]')!.hidden = teams.length > 0;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      if (busy) return;
      const previous = editing;
      const values = Object.fromEntries(
        fields.flatMap((name) => {
          const value = field(name).value.trim();
          return field(name).required || value ? [[name, value]] : [];
        }),
      );
      let team: FavoriteTeam;
      try {
        [team] = validateFavoriteTeams([
          { id: previous?.id ?? `manual-${crypto.randomUUID()}`, ...values },
        ]) as [FavoriteTeam];
        const identity = (candidate: FavoriteTeam) =>
          [candidate.name, candidate.sport, candidate.location, candidate.level, candidate.league]
            .map((value) => teamSearchKey(value ?? ''))
            .join('|');
        if (host.read().some((item) => item.id !== team.id && identity(item) === identity(team))) {
          status.textContent = 'You already follow this team.';
          return;
        }
        if (!previous && host.read().length >= MAX_FAVORITE_TEAMS) {
          status.textContent = `Save up to ${MAX_FAVORITE_TEAMS} favorite teams.`;
          return;
        }
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Check the team details.';
        return;
      }
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      submit.textContent = 'Saving…';
      submit.setAttribute('aria-busy', 'true');
      const saved = await commit(
        (current) =>
          previous
            ? current.map((item) => (item.id === team.id ? team : item))
            : [...current, team],
        previous ? 'Team updated.' : `Following ${team.name}.`,
      );
      submit.textContent = 'Save team';
      submit.removeAttribute('aria-busy');
      if (saved) {
        hideEditor();
        refresh();
        focusSaved(team.id);
      }
    })();
  });
  const open = () => {
    closeBrowse();
    refresh();
    dialog.showModal();
  };
  add.addEventListener('click', () => showEditor(add));
  search.addEventListener('input', searchTeams);
  panel.querySelector('[data-cancel-team]')!.addEventListener('click', () => {
    if (!busy) hideEditor();
  });
  panel.querySelector('[data-view-teams]')!.addEventListener('click', open);
  entry.addEventListener('click', () => {
    if (!browseResults.hidden) {
      closeBrowse();
      return;
    }
    const facet = {
      sport: sports.querySelector<HTMLSelectElement>('[aria-label="Sport"]')?.value || undefined,
      league: sports.querySelector<HTMLSelectElement>('[aria-label="League"]')?.value || undefined,
    };
    const teams = host
      .read()
      .filter((team) => matchesSportsFacet(sportsFacts([team.sport, team.league ?? '']), facet));
    entry.closest('dialog')?.close();
    void findGames(teams, entry);
  });
  sports.addEventListener('change', closeBrowse);
  for (const id of [
    'live-tv-button',
    'paid-tv-button',
    'genxtra-button',
    'guide-button',
    'local-button',
  ])
    doc.getElementById(id)?.addEventListener('click', closeBrowse, { capture: true });
  findAll.addEventListener('click', () => void findGames(host.read(), findAll));
  dialog
    .querySelector('[aria-label="Close My Teams"]')!
    .addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (lookupButton === entry || gameResults.parentElement === browseResults) return;
    lookup?.abort();
    gameResults.remove();
    games.replaceChildren();
  });
  dialog.querySelector('[data-manage-teams]')!.addEventListener('click', () => {
    dialog.close();
    host.openSettings();
    refresh();
  });
  panel.closest('dialog')!.addEventListener('close', () => {
    hideEditor();
    stopSchoolSearch();
    schoolSearchStatus = '';
  });
  doc.querySelector('[data-settings-section="favorite-teams"]')?.addEventListener('click', () => {
    searchTeams();
    refresh(false);
  });
  refresh();
  return {
    closeBrowse,
    back() {
      if (!closeBrowse()) return false;
      const control = entry.checkVisibility() ? entry : doc.getElementById('phone-filter-button');
      control?.focus({ preventScroll: true });
      return true;
    },
  };
}
