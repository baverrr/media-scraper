// Fewer bot checks, by behaving more like a person's browser than a fresh headless one does:
//
// - It comes back as the same visitor. Each station's cookies and site storage are kept after its
//   page loads (DATA_DIR/visitors.json), so the next resolve isn't a first visit, which is what
//   bot managers challenge most. A page that answered with a bot check drops them.
// - It doesn't reload a page that just asked "are you a robot?". After a bot check the site is
//   left alone for 15 minutes, doubling with each one in a row up to 6 hours, rather than being
//   reloaded every time a player retries; a page that loads resets that. Test now tries once
//   regardless.
//
// Neither solves a bot check or tries to get past one: a site that shows one still fails until it
// stops showing it.
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { JsonFile } from './jsonfile.js';

const MAX_STATE_BYTES = 512_000; // ad scripts can fill localStorage; past this only cookies are kept
const VISIT_TTL_MS = 30 * 86_400_000; // a station's visit is forgotten after a month unused
const UNCHANGED_SAVE_MS = 86_400_000; // a visit that came back the same is written again only daily

// The site a station's page is on, for the cooldown: its host without "www.".
export function siteOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null; } catch { return null; }
}

// A Playwright storageState small enough to keep: all of it, or only its cookies.
export function trimState(state) {
  if (!state || !Array.isArray(state.cookies)) return null;
  if (!state.cookies.every(c => c && typeof c.name === 'string' && typeof c.value === 'string' && typeof c.domain === 'string' && typeof c.path === 'string')) return null;
  const full = { cookies: state.cookies, origins: Array.isArray(state.origins) ? state.origins : [] };
  if (!full.origins.length) return full;
  return Buffer.byteLength(JSON.stringify(full)) <= MAX_STATE_BYTES ? full : { cookies: state.cookies, origins: [] };
}

export class VisitorStore {
  constructor({ dataDir, now = Date.now, log = {} }) {
    this.file = path.join(dataDir, 'visitors.json');
    this.dataDir = dataDir;
    this.now = now;
    this.log = log;
    this.entries = new Map(); // id -> { state, savedAt }
    // id -> how many times its visit was forgotten, so a resolve that began before that can't
    // save the visit back when it ends.
    this.forgotten = new Map();
    this.opened = new Set(); // stations whose visit was opened since they were last in the list
    this.json = new JsonFile(this.file, () => {
      for (const [id, e] of this.entries) if (this.expired(e)) this.entries.delete(id);
      return JSON.stringify({ version: 1, stations: Object.fromEntries(this.entries) }) + '\n';
    });
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    // Never keep the sidecar from starting over this file: without it, the next visits are first
    // visits again.
    let saved = {};
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') throw new SyntaxError('not a JSON object');
      saved = parsed.stations && typeof parsed.stations === 'object' ? parsed.stations : {};
    } catch (e) {
      if (e.code === 'ENOENT') { /* no visits yet */ } else if (e instanceof SyntaxError) {
        await this.json.setAside(this.log, 'visits');
      } else this.log.warn?.(`visits: can't read ${this.file} (${e.message}); starting without saved visits`);
    }
    let dropped = false;
    for (const [id, entry] of Object.entries(saved)) {
      const state = trimState(entry?.state);
      if (state && !this.expired(entry)) this.entries.set(id, { state, savedAt: entry.savedAt });
      else dropped = true;
    }
    if (dropped) await this.persist().catch(e => this.log.warn?.(`visits: couldn't drop old visits from ${this.file}: ${e.message}`));
    return this;
  }

  // A savedAt that isn't a number (a hand-edited file) counts as expired.
  expired(entry) {
    return !(Number.isFinite(entry?.savedAt) && this.now() - entry.savedAt < VISIT_TTL_MS);
  }

  // Visits past the month are left out, so the file doesn't keep ones that are never read again.
  persist() {
    return this.json.write();
  }

  // A station's visit for one resolve: its state, and saving or forgetting it at the end. The save
  // is skipped if the visit was forgotten meanwhile (the station got a sign-in or was removed).
  open(id) {
    let times = this.forgotten.get(id) || 0;
    this.opened.add(id);
    return {
      state: this.get(id),
      save: state => ((this.forgotten.get(id) || 0) === times ? this.save(id, state) : Promise.resolve()),
      // The resolve's own forgetting (a visit the browser won't take) doesn't stop its own save.
      forget: () => { const p = this.forget(id); times = this.forgotten.get(id); return p; },
    };
  }

  get(id) {
    const e = this.entries.get(id);
    return e && !this.expired(e) ? e.state : null;
  }

  // The file is rewritten only when the visit changed, or daily so its month starts over.
  async save(id, state) {
    const trimmed = trimState(state);
    if (!trimmed) return;
    const old = this.entries.get(id);
    const t = this.now();
    if (old && t - old.savedAt < UNCHANGED_SAVE_MS && JSON.stringify(old.state) === JSON.stringify(trimmed)) return;
    this.entries.set(id, { state: trimmed, savedAt: t });
    await this.persist();
  }

  async forget(id) {
    this.forgotten.set(id, (this.forgotten.get(id) || 0) + 1);
    if (this.entries.delete(id)) await this.persist();
  }

  // Drops the visits of stations no longer in the list, including any being made right now.
  async keepOnly(ids) {
    const keep = new Set(ids);
    let dropped = false;
    for (const id of new Set([...this.entries.keys(), ...this.opened])) {
      if (keep.has(id)) continue;
      this.opened.delete(id);
      this.forgotten.set(id, (this.forgotten.get(id) || 0) + 1);
      dropped = this.entries.delete(id) || dropped;
    }
    if (dropped) await this.persist();
  }
}

// Per site: how many bot checks in a row, and until when to leave it alone.
export class SiteCooldown {
  constructor({ firstMs = 15 * 60_000, maxMs = 6 * 3_600_000, now = Date.now } = {}) {
    this.firstMs = firstMs;
    this.maxMs = maxMs;
    this.now = now;
    this.sites = new Map(); // site -> { checks, until, allowed: Map(station id -> until) }
  }

  // Whether an attempt for station `id` may open the site now: { until } (ms) to leave it alone,
  // 0 to go ahead, and whether Test now's allowance let it through. That allowance is for its own
  // station, and used up by the attempt it lets through.
  admit(site, id) {
    const s = site && this.sites.get(site);
    if (!s || s.until <= this.now()) return { until: 0, allowed: false };
    if (s.allowed.get(id) > this.now()) {
      s.allowed.delete(id);
      return { until: 0, allowed: true };
    }
    return { until: s.until, allowed: false };
  }

  waitingUntil(site, id) {
    return this.admit(site, id).until;
  }

  // Until when the site is left alone (0: it isn't), without using up an allowance.
  until(site) {
    const s = site && this.sites.get(site);
    return s && s.until > this.now() ? s.until : 0;
  }

  // The site showed a bot check: wait, longer each time in a row. Two stations on the site that
  // ran into the same one (a tune-in and the warm-up, say) count once: while the site is already
  // being left alone, only the attempt Test now let through (`allowed`) makes the wait longer.
  // Returns until when.
  challenged(site, { allowed = false } = {}) {
    if (!site) return 0;
    const s = this.sites.get(site);
    if (s && s.until > this.now() && !allowed) return s.until;
    // A bot check long after the last wait ended is a new run of them, not the next in a row.
    const checks = (s && this.now() - s.until < this.maxMs ? s.checks : 0) + 1;
    const until = this.now() + Math.min(this.firstMs * 2 ** (checks - 1), this.maxMs);
    this.sites.set(site, { checks, until, allowed: new Map() });
    return until;
  }

  // The site's page loaded (with or without a stream): no more waiting.
  passed(site) {
    if (site) this.sites.delete(site);
  }

  // Test now: one attempt for station `id` despite the cooldown, until `until` (ms).
  allow(site, id, until) {
    const s = site && this.sites.get(site);
    if (s) s.allowed.set(id, until);
  }

  // Test now is over: an allowance its attempt didn't use (it joined one already running) lapses,
  // so it can't let a later tune-in through.
  revoke(site, id) {
    const s = site && this.sites.get(site);
    if (s) s.allowed.delete(id);
  }
}
