// Local sports: which station is airing a local team's game right now (or is about to).
// Schedules and TV broadcasts come from ESPN's public site API, one request per team, cached.
// A broadcast matches a station by network ("CBS" -> the CBS affiliate), call sign, name, or the
// station's sportsAliases (e.g. "Altitude" for a station that simulcasts Altitude games).

export const LEAGUES = {
  nfl: { path: 'football/nfl', hours: 3.5 },
  ncaaf: { path: 'football/college-football', hours: 3.75 },
  nba: { path: 'basketball/nba', hours: 2.5 },
  wnba: { path: 'basketball/wnba', hours: 2.25 },
  ncaam: { path: 'basketball/mens-college-basketball', hours: 2.25 },
  ncaaw: { path: 'basketball/womens-college-basketball', hours: 2.25 },
  nhl: { path: 'hockey/nhl', hours: 2.75 },
  mlb: { path: 'baseball/mlb', hours: 3.25 },
  mls: { path: 'soccer/usa.1', hours: 2 },
  nwsl: { path: 'soccer/usa.nwsl', hours: 2 },
};

// How long before the scheduled start a station counts as airing the game (pre-game show,
// and time for the sidecar to have the stream ready).
export const LEAD_MS = 15 * 60_000;

export function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function stationAliases(station) {
  return [station.network, station.callSign, station.name, ...(station.sportsAliases || [])]
    .map(normalize)
    .filter(Boolean);
}

// Over-the-air broadcasts only: cable, streaming and subscription packages can't be on a
// station's stream.
export function broadcastNames(competition) {
  return (competition?.broadcasts || [])
    .filter(b => !b.type || /^tv$/i.test(b.type.shortName || ''))
    .flatMap(b => [b.media?.shortName, b.media?.name, ...(b.names || [])])
    .filter(Boolean);
}

export function parseSchedule(json, team) {
  const league = LEAGUES[team.league];
  const out = [];
  for (const e of json?.events || []) {
    const c = e.competitions?.[0];
    const start = Date.parse(e.date);
    if (!c || !Number.isFinite(start)) continue;
    const state = c.status?.type?.state || e.status?.type?.state || 'pre';
    out.push({
      id: `${team.league}:${e.id}`,
      league: team.league,
      team: team.name || json.team?.displayName || team.team,
      title: e.name || e.shortName || 'Game',
      shortTitle: e.shortName || e.name || 'Game',
      start,
      end: start + (league?.hours ?? 3) * 3_600_000,
      state, // pre | in | post
      broadcasts: broadcastNames(c),
    });
  }
  return out;
}

// How long a game ESPN says is in progress may run past its estimated end (overtime, extra
// innings, weather delays). Bounded, so a schedule cached as "in" (ESPN unreachable since) doesn't
// keep a finished game on the air for good.
export const OVERRUN_MS = 3 * 3_600_000;

export function isOnAir(event, now) {
  if (event.state === 'post') return false;
  if (event.state === 'in') return now >= event.start - LEAD_MS && now < event.end + OVERRUN_MS;
  return now >= event.start - LEAD_MS && now < event.end;
}

// Events on the given stations, as [{ event, station }], soonest first. Each event goes to the
// first station (in list order) that matches one of its broadcasts.
export function matchEvents(events, stations) {
  const pairs = [];
  const seen = new Set();
  for (const event of [...events].sort((a, b) => a.start - b.start)) {
    if (seen.has(event.id)) continue; // same game from both teams' schedules
    const names = event.broadcasts.map(normalize);
    const station = stations.find(s => stationAliases(s).some(a => names.includes(a)));
    if (!station) continue;
    seen.add(event.id);
    pairs.push({ event, station });
  }
  return pairs;
}

export class SportsSchedule {
  constructor({ teams = [], fetchImpl = fetch, ttlMs = 30 * 60_000, now = Date.now, log = {} } = {}) {
    this.teams = teams;
    this.fetchImpl = fetchImpl;
    this.ttlMs = ttlMs;
    this.now = now;
    this.log = log;
    this.cache = null; // { at, events }
    this.pending = null;
    this.generation = 0;
  }

  // A fetch still running for the old teams finishes, but its result is discarded.
  setTeams(teams) {
    this.teams = teams;
    this.cache = null;
    this.pending = null;
    this.generation++;
  }

  async events() {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.events;
    if (this.pending) return this.pending;
    const generation = this.generation;
    const teams = this.teams;
    const pending = (async () => {
      const results = await Promise.all(teams.map(async team => {
        const league = LEAGUES[team.league];
        if (!league) return [];
        const url = `https://site.api.espn.com/apis/site/v2/sports/${league.path}/teams/${encodeURIComponent(team.team)}/schedule`;
        try {
          const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return parseSchedule(await res.json(), team);
        } catch (e) {
          this.log.warn?.(`sports: ${team.name || team.team} schedule unavailable: ${e.message}`);
          // Keep the previous events for this team rather than dropping its games.
          return (this.cache?.events || []).filter(ev => ev.league === team.league && ev.team === (team.name || team.team));
        }
      }));
      const events = results.flat();
      if (generation !== this.generation) return this.events(); // teams changed meanwhile
      this.cache = { at: this.now(), events };
      return events;
    })().finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }

  // Games within [from, to) on enabled stations, matched to their station.
  async between(stations, from, to) {
    const events = (await this.events()).filter(e => e.end > from && e.start - LEAD_MS < to && e.state !== 'post');
    return matchEvents(events, stations);
  }

  // Games on the air now, soonest-started first.
  async onAirNow(stations) {
    const now = this.now();
    return matchEvents((await this.events()).filter(e => isOnAir(e, now)), stations);
  }
}
