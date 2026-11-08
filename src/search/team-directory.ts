// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import vocabulary from '../../config/sports-vocabulary.json';
import type { FavoriteTeam } from '../preferences/favorite-teams';

const prepSports = [
  ['football', 'American Football'],
  ['boys-basketball', 'Boys Basketball'],
  ['girls-basketball', 'Girls Basketball'],
  ['girls-volleyball', 'Girls Volleyball'],
  ['boys-soccer', 'Boys Soccer'],
  ['girls-soccer', 'Girls Soccer'],
  ['baseball', 'Baseball'],
  ['softball', 'Softball'],
  ['wrestling', 'Wrestling'],
] as const;
const collegeSports = [
  ['football', 'American Football'],
  ['mens-basketball', 'Men’s Basketball'],
  ['womens-basketball', 'Women’s Basketball'],
  ['womens-volleyball', 'Women’s Volleyball'],
  ['baseball', 'Baseball'],
  ['softball', 'Softball'],
] as const;
const schools = [
  {
    id: 'college-illinois',
    name: 'Illinois Fighting Illini',
    location: 'Champaign, IL',
    aliases: ['University of Illinois', 'Illinois', 'UIUC'],
    league: 'Big Ten',
  },
  {
    id: 'college-illinois-state',
    name: 'Illinois State Redbirds',
    location: 'Normal, IL',
    aliases: ['Illinois State University', 'Illinois State', 'ISU'],
    league: 'Missouri Valley Conference',
  },
  {
    id: 'high-school-pekin-dragons',
    name: 'Pekin Dragons',
    location: 'Pekin, IL',
    aliases: ['Pekin', 'Pekin High School', 'Pekin Community High School'],
    nfhs: 'pekin-high-school-pekin-il',
  },
  {
    id: 'high-school-dunlap-eagles',
    name: 'Dunlap Eagles',
    location: 'Dunlap, IL',
    aliases: ['Dunlap', 'Dunlap High School'],
    nfhs: 'dunlap-high-school-dunlap-il',
  },
  {
    id: 'high-school-morton-potters',
    name: 'Morton Potters',
    location: 'Morton, IL',
    aliases: ['Morton', 'Morton High School', 'Morton High School - Morton'],
    nfhs: 'morton-high-school-morton-morton-il',
  },
  {
    id: 'high-school-canton-little-giants',
    name: 'Canton Little Giants',
    location: 'Canton, IL',
    aliases: ['Canton', 'Canton High School'],
    nfhs: 'canton-high-school-canton-il',
  },
  {
    id: 'high-school-east-peoria-raiders',
    name: 'East Peoria Raiders',
    location: 'East Peoria, IL',
    aliases: ['East Peoria', 'East Peoria High School', 'East Peoria Community High School'],
    nfhs: 'east-peoria-high-school-east-peoria-il',
  },
  {
    id: 'high-school-limestone-rockets',
    name: 'Limestone Rockets',
    location: 'Bartonville, IL',
    aliases: ['Limestone', 'Limestone Community High School', 'Bartonville (Limestone)'],
    nfhs: 'limestone-community-high-school-bartonville-il',
  },
  {
    id: 'high-school-metamora-redbirds',
    name: 'Metamora Redbirds',
    location: 'Metamora, IL',
    aliases: ['Metamora', 'Metamora High School', 'Metamora Township High School'],
    nfhs: 'metamora-high-school-metamora-il',
  },
  {
    id: 'high-school-washington-panthers',
    name: 'Washington Panthers',
    location: 'Washington, IL',
    aliases: [
      'Washington',
      'Washington High School',
      'Washington Community High School',
      'WHS - Washington',
    ],
    nfhs: 'washington-high-school-washington-il',
  },
] as const;
const schoolTeams = new Map(
  [...new Map([...prepSports, ...collegeSports])].flatMap(([id, sport]) =>
    schools.flatMap((school) => {
      const choices = 'nfhs' in school ? prepSports : collegeSports;
      if (!choices.some(([choice]) => choice === id)) return [];
      const team: FavoriteTeam = {
        id: `${school.id}-${id}`,
        name: school.name,
        sport,
        location: school.location,
        level: 'nfhs' in school ? 'High school' : 'College',
        ...('league' in school
          ? {
              league:
                school.id === 'college-illinois-state' && id === 'football'
                  ? 'Missouri Valley Football Conference'
                  : school.league,
            }
          : { league: 'Mid-Illini Conference' }),
      };
      return [[team.id, { school, team }] as const];
    }),
  ),
);

export function favoriteSchool(team: FavoriteTeam) {
  return (
    schoolTeams.get(team.id)?.school ??
    schools.find(
      (school) =>
        teamSearchKey(school.location) === teamSearchKey(team.location) &&
        [school.name, ...school.aliases].some(
          (name) => teamSearchKey(name) === teamSearchKey(team.name),
        ),
    )
  );
}

// Local starter directory. Keep these identities independent of the classifier's
// match confidence and of any schedule or playback availability.
const regionalTeams: readonly FavoriteTeam[] = [
  // https://www.mlb.com/schedule/team-by-team
  {
    id: 'mlb-chicago-cubs',
    name: 'Chicago Cubs',
    sport: 'Baseball',
    location: 'Chicago, IL',
    league: 'MLB',
    level: 'Pro',
  },
  {
    id: 'mlb-chicago-white-sox',
    name: 'Chicago White Sox',
    sport: 'Baseball',
    location: 'Chicago, IL',
    league: 'MLB',
    level: 'Pro',
  },
  {
    id: 'mlb-st-louis-cardinals',
    name: 'St. Louis Cardinals',
    sport: 'Baseball',
    location: 'St. Louis, MO',
    league: 'MLB',
    level: 'Pro',
  },
  // https://www.nba.com/team/1610612741/bulls
  {
    id: 'nba-chicago-bulls',
    name: 'Chicago Bulls',
    sport: 'Basketball',
    location: 'Chicago, IL',
    league: 'NBA',
    level: 'Pro',
  },
  // https://www.nhl.com/blackhawks/
  {
    id: 'nhl-chicago-blackhawks',
    name: 'Chicago Blackhawks',
    sport: 'Hockey',
    location: 'Chicago, IL',
    league: 'NHL',
    level: 'Pro',
  },
  // https://hawkeyesports.com/sports/football/schedule
  {
    id: 'college-iowa-football',
    name: 'Iowa Hawkeyes',
    sport: 'American Football',
    location: 'Iowa City, IA',
    league: 'Big Ten',
    level: 'College',
  },
  // https://nusports.com/sports/football/schedule
  {
    id: 'college-northwestern-football',
    name: 'Northwestern Wildcats',
    sport: 'American Football',
    location: 'Evanston, IL',
    league: 'Big Ten',
    level: 'College',
  },
  // https://bradleybraves.com/coverage
  {
    id: 'college-bradley-mens-basketball',
    name: 'Bradley Braves',
    sport: 'Men’s Basketball',
    location: 'Peoria, IL',
    league: 'Missouri Valley Conference',
    level: 'College',
  },
  {
    id: 'college-bradley-womens-basketball',
    name: 'Bradley Braves',
    sport: 'Women’s Basketball',
    location: 'Peoria, IL',
    league: 'Missouri Valley Conference',
    level: 'College',
  },
  // https://peoriacitysoccer.com/about/
  {
    id: 'usl2-peoria-city',
    name: 'Peoria City',
    sport: 'Soccer',
    location: 'Peoria, IL',
    league: 'USL League Two',
    level: 'Pre-professional',
  },
  // https://www.chicagohouseac.com/mens-schedule
  {
    id: 'mwpl-chicago-house-ac',
    name: 'Chicago House AC',
    sport: 'Men’s Soccer',
    location: 'Chicagoland, IL',
    league: 'Midwest Premier League',
    level: 'Semi-pro',
  },
];

const directory: readonly FavoriteTeam[] = [
  ...vocabulary.teams
    .filter(({ leagueId }) => leagueId === 'nfl')
    .map(({ id, label }) => ({
      id,
      name: label,
      sport: 'American Football',
      location: label.slice(0, label.lastIndexOf(' ')),
      league: 'NFL',
      level: 'Pro',
    })),
  ...regionalTeams,
  ...Array.from(schoolTeams.values(), ({ team }) => team),
];

export function teamSearchKey(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\p{M}'’]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function findTeams(query: string, saved: readonly FavoriteTeam[]): FavoriteTeam[] {
  const key = teamSearchKey(query);
  if (!key) return [];
  const words = key.split(' ');
  const candidates = new Map([...directory, ...saved].map((team) => [team.id, team]));
  return [...candidates.values()]
    .flatMap((team) => {
      const names = [team.name, ...(favoriteSchool(team)?.aliases ?? [])].map(teamSearchKey);
      const school = favoriteSchool(team);
      const association = school && 'nfhs' in school ? 'Mid-Illini Conference IHSA' : '';
      const location = team.location.replace(/,\s*IL$/iu, ', Illinois');
      const terms = [
        ...names,
        teamSearchKey(
          [team.sport, team.location, location, team.league, team.level, association].join(' '),
        ),
      ]
        .join(' ')
        .split(' ');
      return words.every((word) => terms.some((term) => term.startsWith(word)))
        ? [
            {
              team,
              priority: names.some((name) => name === key || name.startsWith(`${key} `)) ? 0 : 1,
            },
          ]
        : [];
    })
    .sort((left, right) => left.priority - right.priority)
    .slice(0, 24)
    .map(({ team }) => team);
}

interface IllinoisSchool {
  id: string;
  label: string;
  city: string;
  conference: string;
}

export const ILLINOIS_CONFERENCE_DIRECTORY = 'https://www.ihsa.org/data/school/conf.htm';

export function readIllinoisSchools(html: string): IllinoisSchool[] {
  const template = document.createElement('template');
  template.innerHTML = html;
  const found = new Map<string, IllinoisSchool>();
  const bytes = new TextEncoder();
  for (const heading of template.content.querySelectorAll('h2')) {
    const conference = heading.textContent.trim();
    if (!conference || bytes.encode(conference).length > 160) continue;
    let members = false;
    for (let row = heading.nextElementSibling; row?.tagName === 'P'; row = row.nextElementSibling) {
      if (row.querySelector('b')?.textContent.trim() === 'Member Schools') members = true;
      if (!members) continue;
      for (const link of row.querySelectorAll('a')) {
        const id = /^\/data\/school\/schools\/(\d{4})\.htm$/u.exec(
          link.getAttribute('href') ?? '',
        )?.[1];
        const label = link.textContent.trim();
        const city = label.split(' (')[0]!;
        if (
          id &&
          bytes.encode(label).length <= 150 &&
          city &&
          ![...(label + conference)].some((character) => character < ' ' || character === '\x7f')
        )
          found.set(`${id}:${conference}`, { id, label, city, conference });
      }
    }
  }
  if (!found.size) throw new Error('Illinois school directory is unavailable.');
  return [...found.values()];
}

export function findIllinoisTeams(
  query: string,
  schools: readonly IllinoisSchool[],
): FavoriteTeam[] {
  const words = teamSearchKey(query).split(' ');
  if (!words[0]) return [];
  const found = new Map<string, FavoriteTeam>();
  for (const [id, sport] of prepSports) {
    for (const school of schools) {
      const teamId = `high-school-ihsa-${school.id}-${id}`;
      const terms = teamSearchKey(
        `${school.label} ${school.conference} ${sport} high school conference IHSA Illinois IL`,
      ).split(' ');
      if (found.has(teamId) || !words.every((word) => terms.some((term) => term.startsWith(word))))
        continue;
      found.set(teamId, {
        id: teamId,
        name: school.label,
        sport,
        location: `${school.city}, IL`,
        level: 'High school',
        league: school.conference,
      });
      if (found.size === 24) return [...found.values()];
    }
  }
  return [...found.values()];
}
