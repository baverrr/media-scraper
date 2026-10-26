// HTTP API, M3U/XMLTV feeds and the HLS proxy. Kept separate from server.js so tests can run it
// with a fake resolver.
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { buildM3u, buildXmltv, sportsChannel, SPORTS_ID } from './guide.js';
import { createSigner } from './sign.js';
import { isHls, isMaster, rewriteMaster, rewriteMedia, chosenVariantUrl, renditionUrls, proxyExtension } from './hls.js';

// Upstream answers that usually mean the signed URL or session expired: re-resolve once.
const EXPIRED = new Set([401, 403, 404, 410]);

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Concurrency limit with priorities: lower numbers run first (0 = a station airing a local game),
// FIFO within a priority.
export function semaphore(limit) {
  let active = 0;
  let seq = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn, priority = 1) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject, priority, seq: seq++ }); next(); });
}

// Resolutions per station: reused until the configured TTL or the URL's own token expiry
// (whichever is first), shared between concurrent requests, and failures are remembered briefly
// so a player retrying in a loop doesn't relaunch the browser every second. A due refresh runs in
// the background while the previous stream keeps being served (until its token really expires),
// so playback doesn't stall for the browser every TTL; only a forced re-resolve (upstream said the
// URL expired) makes requests wait.
export class ResolutionCache {
  constructor({ resolve, ttlMs = 30 * 60_000, failureMs = 60_000, concurrency = 2, now = Date.now }) {
    this.resolveFn = resolve;
    this.ttlMs = ttlMs;
    this.failureMs = failureMs;
    this.now = now;
    this.limit = semaphore(concurrency);
    this.entries = new Map();
  }

  // The token expiry read from the URL, unless it's already past: the URL was just found working,
  // so a past value is something else (an event timestamp in an `e=` parameter, say). Trusting it
  // would re-resolve every 30 s, with nothing playable to serve meanwhile.
  knownExpiry(value) {
    return value.expiresAt && value.expiresAt > this.now() ? value.expiresAt : null;
  }

  expiryFor(value) {
    const now = this.now();
    let until = now + this.ttlMs;
    const exp = this.knownExpiry(value);
    if (exp) until = Math.min(until, Math.max(now + 30_000, exp - 120_000));
    return until;
  }

  // Until when a resolution can still be played: its token's expiry, or without a known expiry
  // one more TTL past the refresh time (an upstream 401/403 forces a re-resolve before that).
  usableUntil(value, until) {
    const exp = this.knownExpiry(value);
    return exp ? exp - 15_000 : until + this.ttlMs;
  }

  get(station, { force = false, priority = 1 } = {}) {
    const now = this.now();
    const entry = this.entries.get(station.id);
    const stale = !force && entry?.value && entry.usable > now ? entry.value : null;
    if (entry?.pending) return stale ? Promise.resolve(stale) : entry.pending;
    if (!force && entry && entry.until > now) {
      return entry.error && !entry.value ? Promise.reject(entry.error) : Promise.resolve(entry.value);
    }
    // Only store the outcome if this resolution is still the current one: a station edited (and
    // invalidated) mid-resolve mustn't get the old page's stream cached for the whole TTL.
    const current = () => this.entries.get(station.id)?.pending === pending;
    const pending = this.limit(() => this.resolveFn(station), priority).then(
      value => {
        const until = this.expiryFor(value);
        if (current()) this.entries.set(station.id, { value, until, usable: this.usableUntil(value, until) });
        return value;
      },
      error => {
        if (current()) {
          // A failed background refresh keeps the previous stream while it's still playable. A
          // failed forced one doesn't: upstream just rejected that stream, and serving it again
          // would re-force (and relaunch the browser) on every player poll instead of backing off.
          const keep = !force && entry?.value && entry.usable > this.now();
          this.entries.set(station.id, keep
            ? { value: entry.value, usable: entry.usable, error, until: this.now() + this.failureMs }
            : { error, until: this.now() + this.failureMs });
        }
        throw error;
      },
    );
    this.entries.set(station.id, { ...entry, pending });
    if (stale) {
      pending.catch(() => {}); // reported through status(); callers got the previous stream
      return Promise.resolve(stale);
    }
    return pending;
  }

  // A usable resolution without waiting, including the previous one while a refresh runs, so
  // segment requests don't stall for the browser.
  peek(id) {
    const e = this.entries.get(id);
    return e && e.value && e.usable > this.now() ? e.value : null;
  }

  invalidate(id) {
    if (id === undefined) this.entries.clear();
    else this.entries.delete(id);
  }

  status(id) {
    const e = this.entries.get(id);
    if (!e) return { state: 'idle' };
    if (e.pending) return { state: 'resolving' };
    if (e.error && !e.value) return { state: 'failed', error: e.error.message, retryAt: new Date(e.until).toISOString() };
    return {
      state: e.until > this.now() ? 'ready' : 'stale',
      via: e.value.via,
      type: e.value.type,
      resolvedAt: e.value.resolvedAt ? new Date(e.value.resolvedAt).toISOString() : null,
      refreshAt: new Date(e.until).toISOString(),
      ...(e.error ? { refreshError: e.error.message } : {}),
    };
  }
}

export function createApp({ store, resolver, sports = null, config = {}, log = console, fetchImpl = fetch, now = Date.now }) {
  const maxHeight = config.maxHeight ?? 1080;
  const apiKey = config.apiKey || '';
  const signer = createSigner();
  const cache = new ResolutionCache({
    resolve: station => resolver.resolve(station),
    ttlMs: (config.ttlMinutes ?? 30) * 60_000,
    failureMs: (config.failureSeconds ?? 60) * 1000,
    concurrency: config.concurrency ?? 2,
  });
  // ffmpeg reloads the variant playlist every few seconds; the master behind it rarely changes.
  const masters = new Map();
  // Stations airing a local game, from the last sports check: they resolve ahead of the rest.
  let sportsIds = new Set();

  const sportsOn = () => !!sports && store.sports.enabled && store.sports.teams.length > 0;

  // Games on enabled stations around now. Schedule problems never break the playlist or guide.
  async function sportsState(hours = 168) {
    if (!sportsOn()) return { onAir: [], games: [] };
    try {
      const t = now();
      const [onAir, games] = await Promise.all([
        sports.onAirNow(store.enabled()),
        sports.between(store.enabled(), t - 3_600_000, t + hours * 3_600_000),
      ]);
      sportsIds = new Set(onAir.map(g => g.station.id));
      return { onAir, games };
    } catch (e) {
      log.warn?.(`sports schedule unavailable: ${e.message}`);
      return { onAir: [], games: [] };
    }
  }

  const priorityOf = station => (sportsIds.has(station.id) ? 0 : 1);

  // Stations airing a local game first (in game order), then the rest as configured. The Local
  // Sports channel leads when sports are on.
  async function orderedStations() {
    const { onAir } = await sportsState();
    // A station airing two games at once (overlapping games on a shared alias, a doubleheader)
    // is still one channel.
    const first = [...new Set(onAir.map(g => g.station))];
    const rest = store.enabled().filter(s => !first.includes(s));
    return [...(sportsOn() ? [sportsChannel(store.sports)] : []), ...first, ...rest];
  }

  // Keeps streams for stations airing (or about to air) a local game resolved, so tuning in is
  // instant. Called every minute by the server.
  async function warmSports() {
    const { onAir } = await sportsState();
    // get() answers at once while the resolution is fresh, and refreshes a due one in the
    // background, so the stream stays current through the game.
    const stations = [...new Set(onAir.map(g => g.station))];
    await Promise.all(stations.map(station => cache.get(station, { priority: 0 }).catch(() => {})));
    return stations.map(s => s.id);
  }

  const baseUrl = req => (config.publicUrl || `http://${req.headers.host || `127.0.0.1:${config.port ?? 8899}`}`).replace(/\/$/, '');

  function stationOr404(id, { requireEnabled = true } = {}) {
    const s = store.get(id);
    if (!s || (requireEnabled && !s.enabled)) throw new HttpError(404, `unknown station "${id}"`);
    return s;
  }

  async function getMaster(station, resolution) {
    const hit = masters.get(station.id);
    if (hit && hit.source === resolution.url && hit.until > Date.now()) return hit;
    const res = await fetchImpl(resolution.url, { headers: resolution.headers, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    const entry = { ok: res.ok && isHls(text), status: res.status, text, url: res.url || resolution.url, source: resolution.url, until: Date.now() + 20_000 };
    if (entry.ok) masters.set(station.id, entry);
    return entry;
  }

  // Current playlist for the station's root manifest, chosen variant, or n-th rendition.
  async function loadPlaylist(station, which, attempt = 0) {
    const resolution = await cache.get(station, { force: attempt > 0, priority: priorityOf(station) });
    if (resolution.type !== 'hls') return { redirect: resolution.url };
    let url = resolution.url;
    if (which.kind !== 'root') {
      const master = await getMaster(station, resolution);
      if (!master.ok) {
        masters.delete(station.id);
        if (attempt === 0) return loadPlaylist(station, which, 1);
        throw new HttpError(502, `upstream master playlist HTTP ${master.status}`);
      }
      url = which.kind === 'variant'
        ? chosenVariantUrl(master.text, master.url, maxHeight)
        : renditionUrls(master.text, master.url)[which.n];
      if (!url) throw new HttpError(404, 'no such playlist');
    }
    const res = await fetchImpl(url, { headers: resolution.headers, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok || !isHls(text)) {
      if (attempt === 0 && (EXPIRED.has(res.status) || res.ok)) {
        masters.delete(station.id);
        log.info?.(`[${station.id}] upstream ${res.ok ? 'returned a non-playlist' : `HTTP ${res.status}`}, re-resolving`);
        return loadPlaylist(station, which, 1);
      }
      throw new HttpError(502, `upstream ${res.ok ? 'returned a non-playlist' : `HTTP ${res.status}`}`);
    }
    return { text, url: res.url || url };
  }

  // <station dir>/s/<signature>/<base64url of the upstream URL>.<ext>: everything in the path,
  // ending in a media extension, because ffmpeg rejects segment URLs that don't.
  const segmentUrl = (id, dir) => (abs, kind) => `${dir}s/${signer.sign(id, abs)}/${Buffer.from(abs).toString('base64url')}.${proxyExtension(abs, kind)}`;

  // Links between the sidecar's playlists are relative to the playlist they're in, so they keep
  // working behind a reverse proxy that serves the sidecar under a path (PUBLIC_URL with a path).
  // Station playlists live in /hls/<id>/: the root is /stream/<id>.m3u8, the chosen variant
  // /hls/<id>/v.m3u8, renditions /hls/<id>/r/<n>.m3u8.
  const stationDir = (id, which) => (which.kind === 'root' ? `../hls/${id}/` : which.kind === 'rendition' ? '../' : '');

  async function servePlaylist(req, res, station, which) {
    const pl = await loadPlaylist(station, which);
    if (pl.redirect) {
      res.writeHead(302, { location: pl.redirect, 'cache-control': 'no-store' });
      return res.end();
    }
    const dir = stationDir(encodeURIComponent(station.id), which);
    const body = which.kind === 'root' && isMaster(pl.text)
      ? rewriteMaster(pl.text, { maxHeight, variantUrl: `${dir}v.m3u8`, renditionUrl: n => `${dir}r/${n}.m3u8` })
      : rewriteMedia(pl.text, pl.url, segmentUrl(station.id, dir));
    send(res, 200, body, 'application/vnd.apple.mpegurl');
  }

  async function serveSegment(req, res, station, u, s) {
    if (!u || !signer.verify(station.id, u, s)) throw new HttpError(403, 'bad signature');
    const resolution = cache.peek(station.id) || await cache.get(station, { priority: priorityOf(station) });
    const ctl = new AbortController();
    res.on('close', () => ctl.abort());
    // Pass Range through: byte-range playlists (EXT-X-BYTERANGE) cut every segment out of one file.
    const range = req.headers.range;
    const up = await fetchImpl(u, { headers: range ? { ...resolution.headers, range } : resolution.headers, redirect: 'follow', signal: ctl.signal });
    const headers = { 'content-type': up.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'no-store' };
    for (const h of ['content-length', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(up.status, headers);
    if (!up.body || req.method === 'HEAD') {
      await up.body?.cancel().catch(() => {}); // don't leave the upstream connection open
      return res.end();
    }
    await pipeline(Readable.fromWeb(up.body), res).catch(() => {});
  }

  function authorized(req) {
    if (!apiKey) return true;
    const given = Buffer.from(String(req.headers['x-api-key'] || ''));
    const want = Buffer.from(apiKey);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  async function readJson(req, limit = 1_000_000) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'body too large');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
  }

  function send(res, status, body, type = 'application/json') {
    const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
    res.end(payload);
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    const method = req.method;
    let m;

    if (method === 'GET' && p === '/health') return send(res, 200, { ok: true, stations: store.enabled().length });
    if (method === 'GET' && p === '/playlist.m3u') return send(res, 200, buildM3u(await orderedStations(), baseUrl(req)), 'audio/x-mpegurl');
    if (method === 'GET' && p === '/guide.xml') {
      const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 168, 1), 336);
      const { games } = await sportsState(hours);
      const channels = [...(sportsOn() ? [sportsChannel(store.sports)] : []), ...store.enabled()];
      return send(res, 200, buildXmltv(channels, { hours, games, now: now() }), 'application/xml');
    }

    // Local Sports: the station airing a local game right now (the earliest-started one).
    if ((m = p.match(/^\/stream\/local-sports(?:\.m3u8)?$/)) && (method === 'GET' || method === 'HEAD')) {
      if (!sportsOn()) throw new HttpError(404, 'local sports are turned off');
      const { onAir } = await sportsState();
      if (!onAir.length) throw new HttpError(503, 'No local game is on the air right now');
      log.info?.(`[${SPORTS_ID}] -> ${onAir[0].station.id} (${onAir[0].event.shortTitle})`);
      return servePlaylist(req, res, onAir[0].station, { kind: 'root' });
    }

    if ((m = p.match(/^\/stream\/([^/]+?)(?:\.m3u8)?$/)) && (method === 'GET' || method === 'HEAD')) {
      return servePlaylist(req, res, stationOr404(decodeURIComponent(m[1])), { kind: 'root' });
    }
    if ((m = p.match(/^\/hls\/([^/]+)\/v\.m3u8$/)) && method === 'GET') {
      return servePlaylist(req, res, stationOr404(decodeURIComponent(m[1])), { kind: 'variant' });
    }
    if ((m = p.match(/^\/hls\/([^/]+)\/r\/(\d+)\.m3u8$/)) && method === 'GET') {
      return servePlaylist(req, res, stationOr404(decodeURIComponent(m[1])), { kind: 'rendition', n: Number(m[2]) });
    }
    if ((m = p.match(/^\/hls\/([^/]+)\/s\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\.[a-z0-9]{1,8}$/)) && (method === 'GET' || method === 'HEAD')) {
      return serveSegment(req, res, stationOr404(decodeURIComponent(m[1])), Buffer.from(m[3], 'base64url').toString(), m[2]);
    }

    if (method === 'GET' && p === '/api/stations') return send(res, 200, store.stations);
    if (method === 'GET' && p === '/api/sports') {
      const { onAir, games } = await sportsState(7 * 24);
      const view = g => ({ station: g.station.id, title: g.event.title, team: g.event.team, league: g.event.league, start: new Date(g.event.start).toISOString(), state: g.event.state, broadcasts: g.event.broadcasts });
      return send(res, 200, { ...store.sports, active: sportsOn(), onAir: onAir.map(view), upcoming: games.map(view) });
    }
    if (method === 'GET' && p === '/api/stations/defaults') return send(res, 200, await store.defaults());
    if (method === 'GET' && p === '/api/status') {
      return send(res, 200, store.stations.map(s => ({ id: s.id, name: s.name, enabled: s.enabled, ...cache.status(s.id) })));
    }

    if (p.startsWith('/api/') && !authorized(req)) throw new HttpError(401, 'missing or wrong X-Api-Key');

    if (method === 'PUT' && p === '/api/stations') {
      const before = new Map(store.stations.map(s => [s.id, JSON.stringify(s)]));
      let saved;
      try { saved = await store.save(await readJson(req)); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, e.message); }
      for (const s of saved) if (before.get(s.id) !== JSON.stringify(s)) { cache.invalidate(s.id); masters.delete(s.id); }
      for (const id of before.keys()) if (!store.get(id)) { cache.invalidate(id); masters.delete(id); }
      log.info?.(`stations updated: ${saved.length} (${saved.filter(s => s.enabled).length} enabled)`);
      return send(res, 200, saved);
    }
    if (method === 'PUT' && p === '/api/sports') {
      let saved;
      try { saved = await store.saveSports(await readJson(req)); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, e.message); }
      sports?.setTeams(saved.teams);
      log.info?.(`sports updated: ${saved.enabled ? 'on' : 'off'}, ${saved.teams.length} teams, channel ${saved.channel}`);
      return send(res, 200, saved);
    }
    if ((m = p.match(/^\/api\/stations\/([^/]+)\/test$/)) && method === 'POST') {
      const station = stationOr404(decodeURIComponent(m[1]), { requireEnabled: false });
      try {
        const r = await cache.get(station, { force: true });
        return send(res, 200, {
          ok: true, id: station.id, via: r.via, type: r.type, url: r.url, tookMs: r.tookMs,
          expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
        });
      } catch (e) {
        return send(res, 200, { ok: false, id: station.id, error: e.message, details: e.details });
      }
    }

    throw new HttpError(404, 'not found');
  }

  async function handler(req, res) {
    try {
      await route(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : (e.details ? 502 : 500);
      if (status >= 500) log.warn?.(`${req.method} ${req.url}: ${e.message}`);
      if (!res.headersSent) send(res, status, { error: e.message, details: e.details });
      else res.destroy();
    }
  }

  return { handler, cache, warmSports };
}
