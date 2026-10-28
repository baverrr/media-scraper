// Stations and sports settings: DATA_DIR/stations.json and DATA_DIR/sports.json when present
// (written by the Jellyfin plugin), otherwise the defaults of the configured market
// (markets/<id>.json: its stations and local teams).
import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { LEAGUES } from './sports.js';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const text = v => (v === undefined || v === null ? '' : String(v).trim());

function httpUrl(value, what) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${what} is not a valid URL`); }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`${what} must be http(s)`);
  return url.href;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_GROUPS = { daily: DAYS, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'], weekends: ['sat', 'sun'] };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// A station's newscasts, for one that streams only during them: [{ days, start, end, title }], times
// "HH:MM" in the market's time zone (an end before the start runs past midnight). The guide shows
// them instead of hour-long "Live" blocks.
// Invalid blocks are dropped (`strict` throws instead, for checking market files), so one mistyped
// time doesn't reject every station's settings.
export function normalizeSchedule(raw, id, { strict = false } = {}) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    if (strict) throw new Error(`station ${id}: schedule must be a list`);
    return [];
  }
  return raw.flatMap((b, i) => {
    try { return [scheduleBlock(b, i, id)]; } catch (e) { if (strict) throw e; return []; }
  });
}

function scheduleBlock(b, i, id) {
  const what = `station ${id}: schedule ${i + 1}`;
  // "mon", "Monday", "weekdays"...
  const days = (Array.isArray(b?.days) ? b.days : text(b?.days).split(','))
    .map(d => text(d).toLowerCase())
    .flatMap(d => DAY_GROUPS[d] || [d.slice(0, 3)]);
  if (!days.length || days.some(d => !DAYS.includes(d))) throw new Error(`${what}: days must be mon..sun, weekdays, weekends or daily`);
  const start = text(b?.start);
  const end = text(b?.end);
  if (!HHMM.test(start) || !HHMM.test(end) || start === end) throw new Error(`${what}: start and end must be different HH:MM times`);
  return { days: DAYS.filter(d => days.includes(d)), start, end, title: text(b?.title) || 'Newscast' };
}

export function normalizeStation(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('station must be an object');
  const id = text(raw.id).toLowerCase();
  if (!ID_RE.test(id)) throw new Error(`invalid station id "${raw.id}" (lowercase letters, digits, - and _)`);
  if (id === 'local-sports') throw new Error('station id "local-sports" is reserved');
  const url = httpUrl(text(raw.url), `station ${id}: url`);
  const streamUrl = text(raw.streamUrl);
  const signInUrl = text(raw.signInUrl);
  const signUpUrl = text(raw.signUpUrl);
  const logo = text(raw.logo);
  const aliases = Array.isArray(raw.sportsAliases) ? raw.sportsAliases : text(raw.sportsAliases).split(',');
  return {
    id,
    callSign: text(raw.callSign),
    name: text(raw.name) || text(raw.callSign) || id,
    channel: text(raw.channel),
    network: text(raw.network),
    url,
    // Optional: a stream to use instead of scraping the page (a manifest URL, or any page
    // yt-dlp supports). The page URL still serves as the Referer.
    streamUrl: streamUrl ? httpUrl(streamUrl, `station ${id}: streamUrl`) : null,
    // Optional: where the site's sign-in form is, for a station that streams only to signed-in
    // accounts (the account itself is saved separately, encrypted; see logins.js).
    signInUrl: signInUrl ? httpUrl(signInUrl, `station ${id}: signInUrl`) : null,
    // Optional: where to create an account, for "Create the account for me".
    signUpUrl: signUpUrl ? httpUrl(signUpUrl, `station ${id}: signUpUrl`) : null,
    logo: logo || null,
    sportsAliases: aliases.map(text).filter(Boolean),
    schedule: normalizeSchedule(raw.schedule, id),
    // Keep this station's stream resolved in the background, so tuning in is instant.
    keepReady: raw.keepReady === true,
    // Why a station is disabled, shown in the plugin settings.
    note: text(raw.note) || null,
    enabled: raw.enabled !== false,
  };
}

export function normalizeStations(list) {
  if (!Array.isArray(list)) throw new Error('expected an array of stations');
  const seen = new Set();
  return list.map(normalizeStation).filter(s => {
    if (seen.has(s.id)) throw new Error(`duplicate station id "${s.id}"`);
    seen.add(s.id);
    return true;
  });
}

export function normalizeSports(raw = {}) {
  const teams = (Array.isArray(raw.teams) ? raw.teams : []).map((t, i) => {
    const league = text(t?.league).toLowerCase();
    const team = text(t?.team);
    if (!LEAGUES[league]) throw new Error(`team ${i + 1}: unknown league "${t?.league}" (one of ${Object.keys(LEAGUES).join(', ')})`);
    if (!/^[A-Za-z0-9-]{1,32}$/.test(team)) throw new Error(`team ${i + 1}: team must be an ESPN team id or abbreviation`);
    return { league, team, name: text(t?.name) || team };
  });
  // The time zone of the plugin's first market, for newscast times; one Node doesn't know is dropped.
  let timezone = text(raw.timezone) || null;
  try { if (timezone) new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { timezone = null; }
  return {
    enabled: raw.enabled !== false,
    channel: text(raw.channel) || '1.1',
    teams,
    timezone,
  };
}

export async function listMarkets(dir) {
  const out = [];
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.json')).sort()) {
    const m = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    out.push({ id: path.basename(file, '.json'), name: m.name, stations: (m.stations || []).length, teams: (m.teams || []).length });
  }
  return out;
}

export async function loadMarket(dir, id) {
  if (!ID_RE.test(String(id))) throw new Error(`invalid market id "${id}"`);
  const m = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8'));
  // A market file's schedules are checked strictly: a mistake there should fail, not vanish.
  for (const s of m.stations || []) normalizeSchedule(s.schedule, s.id, { strict: true });
  return {
    id,
    name: m.name || id,
    timezone: m.timezone || null,
    stations: normalizeStations(m.stations || []),
    sports: normalizeSports({ enabled: true, channel: m.sportsChannel, teams: m.teams || [] }),
  };
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, file);
}

export class StationStore {
  constructor({ dataDir, marketsDir, market = 'denver' }) {
    this.dataDir = dataDir;
    this.marketsDir = marketsDir;
    this.market = market;
    this.stationsFile = path.join(dataDir, 'stations.json');
    this.sportsFile = path.join(dataDir, 'sports.json');
    this.stations = [];
    this.sports = normalizeSports();
  }

  // The market's defaults are only needed while the plugin hasn't saved its own stations or
  // sports settings, so an unknown MARKET only fails startup then, and says which ones exist.
  async marketDefaults() {
    try {
      return await loadMarket(this.marketsDir, this.market);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const ids = (await readdir(this.marketsDir)).filter(f => f.endsWith('.json')).map(f => path.basename(f, '.json'));
      throw new Error(`unknown market "${this.market}" (MARKET); available: ${ids.join(', ')}`);
    }
  }

  async load() {
    try {
      this.stations = normalizeStations(JSON.parse(await readFile(this.stationsFile, 'utf8')));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.stations = (await this.marketDefaults()).stations;
    }
    try {
      this.sports = normalizeSports(JSON.parse(await readFile(this.sportsFile, 'utf8')));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.sports = (await this.marketDefaults()).sports;
    }
    return this;
  }

  async save(list) {
    const stations = normalizeStations(list);
    await writeJson(this.stationsFile, stations);
    this.stations = stations;
    return stations;
  }

  async saveSports(raw) {
    const sports = normalizeSports(raw);
    await writeJson(this.sportsFile, sports);
    this.sports = sports;
    return sports;
  }

  // The configured market's bundled stations and teams, as the sidecar starts with them.
  async defaults() {
    const market = await this.marketDefaults();
    return { market: market.id, name: market.name, timezone: market.timezone, stations: market.stations, sports: market.sports };
  }

  get(id) {
    return this.stations.find(s => s.id === id) || null;
  }

  enabled() {
    return this.stations.filter(s => s.enabled);
  }
}
