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
import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const MAX_STATE_BYTES = 512_000; // ad scripts can fill localStorage; past this only cookies are kept
const VISIT_TTL_MS = 30 * 86_400_000; // a station's visit is forgotten after a month unused

// The site a station's page is on, for the cooldown: its host without "www.".
export function siteOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null; } catch { return null; }
}

// A Playwright storageState small enough to keep: all of it, or only its cookies.
export function trimState(state) {
  if (!state || !Array.isArray(state.cookies)) return null;
  if (!state.cookies.every(c => c && typeof c.name === 'string' && typeof c.value === 'string' && typeof c.domain === 'string' && typeof c.path === 'string')) return null;
  const full = { cookies: state.cookies, origins: Array.isArray(state.origins) ? state.origins : [] };
  return Buffer.byteLength(JSON.stringify(full)) <= MAX_STATE_BYTES ? full : { cookies: state.cookies, origins: [] };
}

export class VisitorStore {
  constructor({ dataDir, now = Date.now, log = {} }) {
    this.file = path.join(dataDir, 'visitors.json');
    this.dataDir = dataDir;
    this.now = now;
    this.log = log;
    this.entries = new Map(); // id -> { state, savedAt }
    this.writing = Promise.resolve();
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
        const aside = `${this.file}.damaged-${Date.now()}`;
        await rename(this.file, aside).then(
          () => this.log.warn?.(`visits: ${this.file} was damaged; moved it to ${aside}`),
          r => this.log.warn?.(`visits: ${this.file} was damaged, and moving it aside failed (${r.message}); it's replaced at the next save`),
        );
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

  // Written this way round so a savedAt that isn't a number (a hand-edited file) counts as expired.
  expired(entry) {
    return !(this.now() - (entry?.savedAt || 0) < VISIT_TTL_MS);
  }

  // One write at a time, as in LoginStore. Visits past the month are left out, so the file
  // doesn't keep ones that are never read again.
  persist() {
    const write = async () => {
      for (const [id, e] of this.entries) if (this.expired(e)) this.entries.delete(id);
      const stations = Object.fromEntries(this.entries);
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, stations }) + '\n', { mode: 0o600 });
      await rename(tmp, this.file);
      await chmod(this.file, 0o600).catch(() => {});
    };
    const done = this.writing.then(write, write);
    this.writing = done.catch(() => {});
    return done;
  }

  get(id) {
    const e = this.entries.get(id);
    return e && !this.expired(e) ? e.state : null;
  }

  async save(id, state) {
    const trimmed = trimState(state);
    if (!trimmed) return;
    this.entries.set(id, { state: trimmed, savedAt: this.now() });
    await this.persist();
  }

  async forget(id) {
    if (this.entries.delete(id)) await this.persist();
  }

  // Drops the visits of stations no longer in the list.
  async keepOnly(ids) {
    const keep = new Set(ids);
    const before = this.entries.size;
    for (const id of [...this.entries.keys()]) if (!keep.has(id)) this.entries.delete(id);
    if (this.entries.size < before) await this.persist();
  }
}

// Per site: how many bot checks in a row, and until when to leave it alone.
export class SiteCooldown {
  constructor({ firstMs = 15 * 60_000, maxMs = 6 * 3_600_000, now = Date.now } = {}) {
    this.firstMs = firstMs;
    this.maxMs = maxMs;
    this.now = now;
    this.sites = new Map(); // site -> { checks, until, allowed: Map(station id -> until), allowedUsed? }
  }

  // Until when (ms) to leave the site alone, or 0 to go ahead. Test now's allowance is for its
  // own station, and used up by the attempt it lets through.
  waitingUntil(site, id) {
    const s = site && this.sites.get(site);
    if (!s || s.until <= this.now()) return 0;
    if (s.allowed.get(id) > this.now()) {
      s.allowed.delete(id);
      s.allowedUsed = true;
      return 0;
    }
    return s.until;
  }

  // The site showed a bot check: wait, longer each time in a row. Two stations on the site that
  // ran into the same one (a tune-in and the warm-up, say) count once: while the site is already
  // being left alone, only an attempt Test now let through makes the wait longer.
  // Returns until when.
  challenged(site) {
    if (!site) return 0;
    const s = this.sites.get(site);
    if (s && s.until > this.now() && !s.allowedUsed) return s.until;
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
}
