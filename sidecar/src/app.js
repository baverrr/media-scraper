// HTTP API, M3U/XMLTV feeds and the HLS proxy. Kept separate from server.js so tests can run it
// with a fake resolver.
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { buildM3u, buildXmltv, sportsChannel, SPORTS_ID } from './guide.js';
import { createSigner } from './sign.js';
import { normalizeLogin } from './logins.js';
import { isHls, isMaster, rewriteMaster, rewriteMedia, chosenVariantUrl, renditionUrls, proxyExtension } from './hls.js';
import { loopPlaylist, loopSegment, offAirClips, OFF_AIR_SECONDS } from './slate.js';

// "Nothing is streaming right now": a 6-second clip (assets/slate.svg encoded with ffmpeg) played in
// a loop on a station whose page has no stream at the moment, such as one that streams only during
// its newscasts, so tuning in shows why instead of a playback error.
export const SLATE_SECONDS = 6;
const SLATE_PATH = new URL('../assets/slate.ts', import.meta.url);

// A live playlist that repeats the slate. The sequence follows the clock, so every reload moves on
// by the segments that have played; each repeat's timestamps carry on from the last (slate.js).
export const slatePlaylist = (now, segmentUrl) => loopPlaylist(now, SLATE_SECONDS, segmentUrl);

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

  // keepOnFailure: a forced resolve whose failure shouldn't take down a stream that's playing
  // (the settings page's Test button), unlike a re-resolve because upstream rejected the URL.
  get(station, { force = false, priority = 1, keepOnFailure = false } = {}) {
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
          const keep = (!force || keepOnFailure) && entry?.value && entry.usable > this.now();
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

// logins: the LoginStore holding stations' sign-ins (optional).
export function createApp({ store, resolver, sports = null, logins = null, config = {}, log = console, fetchImpl = fetch, now = Date.now }) {
  const maxHeight = config.maxHeight ?? 1080;
  const apiKey = config.apiKey || '';
  const signer = createSigner();

  // What the resolver gets for a station with a saved sign-in: the account, its session, and
  // callbacks that store how signing in went, for this account only (one saved meanwhile replaces
  // it, and the old one's outcome is dropped).
  const SIGN_IN_GAP_MS = 10 * 60_000;
  const lastSignIn = new Map();
  function loginFor(station) {
    const entry = logins?.get(station.id);
    if (!entry) return null;
    return {
      username: entry.username,
      password: entry.password,
      session: entry.session,
      // A session signed in within the last 6 hours: a page without a stream is more likely off the
      // air than signed out, so it isn't a reason to sign in again.
      sessionFresh: () => !!entry.signedInAt && now() - Date.parse(entry.signedInAt) < 6 * 3_600_000,
      retrying: () => !!entry.retry && entry.retry > now(),
      // Why not to sign in now, or null: a failed sign-in waits until it's saved again or tested,
      // and signing in happens at most every 10 minutes, so a player retrying can't lock the
      // account or have the site email a code each time.
      mayAttempt: () => {
        if (!logins.current(station.id, entry)) return 'the sign-in was changed meanwhile';
        const retry = !!entry.retry && entry.retry > now();
        entry.retry = 0;
        if (entry.error && !retry) return `the last sign-in failed (${entry.error}); save the sign-in again or use Test now to try again`;
        const last = lastSignIn.get(station.id);
        if (!retry && last && now() - last < SIGN_IN_GAP_MS) return 'tried to sign in less than 10 minutes ago; waiting before trying again';
        lastSignIn.set(station.id, now());
        return null;
      },
      signedIn: session => logins.signedIn(station.id, session, entry),
      saveSession: session => logins.saveSession(station.id, session, entry),
      forgetSession: () => logins.forgetSession(station.id, entry),
      failed: message => logins.failed(station.id, message, entry),
    };
  }

  const cache = new ResolutionCache({
    resolve: station => resolver.resolve(station, loginFor(station)),
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

  let slate = null;
  // One clip, looped; the same array each time, so slate.js counts its packets once.
  const slateClips = () => (slate ??= [readFileSync(config.slatePath || SLATE_PATH)]);

  async function servePlaylist(req, res, station, which) {
    let pl;
    try {
      pl = await loadPlaylist(station, which);
    } catch (e) {
      // The station's page had nothing to play (a resolver failure, not an upstream error on a
      // stream that was found, nor a failed sign-in, which needs fixing): play the slate.
      // Retuning tries the page again once the failure has been remembered for its minute.
      if (which.kind !== 'root' || e instanceof HttpError || !e.details || e.details.signIn || config.slate === false) throw e;
      log.info?.(`[${station.id}] nothing to play (${e.message}); playing the slate`);
      return send(res, 200, slatePlaylist(now(), n => `../slate/${n}.ts`), 'application/vnd.apple.mpegurl');
    }
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

    // Local Sports: the station airing a local game right now (the earliest-started one), or the
    // off-air slate, so tuning in between games plays a picture instead of failing.
    if ((m = p.match(/^\/stream\/local-sports(?:\.m3u8)?$/)) && (method === 'GET' || method === 'HEAD')) {
      if (!sportsOn()) throw new HttpError(404, 'local sports are turned off');
      const { onAir } = await sportsState();
      if (!onAir.length) return send(res, 200, loopPlaylist(now(), OFF_AIR_SECONDS, n => `../off-air/${n}.ts`), 'application/vnd.apple.mpegurl');
      log.info?.(`[${SPORTS_ID}] -> ${onAir[0].station.id} (${onAir[0].event.shortTitle})`);
      return servePlaylist(req, res, onAir[0].station, { kind: 'root' });
    }
    if ((m = p.match(/^\/off-air\/(\d{1,15})\.ts$/)) && (method === 'GET' || method === 'HEAD')) {
      const body = loopSegment(offAirClips(), OFF_AIR_SECONDS, Number(m[1]));
      res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': body.length, 'cache-control': 'public, max-age=86400' });
      return res.end(method === 'HEAD' ? undefined : body);
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

    if ((m = p.match(/^\/slate\/(\d{1,15})\.ts$/)) && (method === 'GET' || method === 'HEAD')) {
      const body = loopSegment(slateClips(), SLATE_SECONDS, Number(m[1]));
      res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': body.length, 'cache-control': 'public, max-age=86400' });
      return res.end(method === 'HEAD' ? undefined : body);
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
      // A deleted station's sign-in goes with it. An empty list (a fresh or broken plugin config)
      // never clears them all.
      if (logins && saved.length) {
        for (const id of [...logins.entries.keys()]) if (!store.get(id)) await logins.remove(id);
      }
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
    // Sign-ins: write-only. The email shows in the status; the password and session never leave.
    if (method === 'GET' && p === '/api/logins') {
      return send(res, 200, store.stations.filter(s => logins?.get(s.id)).map(s => ({ id: s.id, ...logins.status(s.id) })));
    }
    if ((m = p.match(/^\/api\/stations\/([^/]+)\/login$/)) && (method === 'PUT' || method === 'DELETE')) {
      if (!logins) throw new HttpError(404, 'sign-ins are not available');
      const id = decodeURIComponent(m[1]).toLowerCase();
      let status;
      if (method === 'PUT') {
        stationOr404(id, { requireEnabled: false });
        try { status = await logins.set(id, await readJson(req, 10_000)); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, e.message); }
        lastSignIn.delete(id);
        log.info?.(`[${id}] sign-in saved`);
      } else {
        await logins.remove(id);
        status = logins.status(id);
        log.info?.(`[${id}] sign-in removed`);
      }
      cache.invalidate(id);
      masters.delete(id);
      return send(res, 200, { id, ...status });
    }

    // Creates the account on the station's site with the email and password the person chose, and
    // saves it as the station's sign-in. acceptTerms says the person accepted the site's terms.
    if ((m = p.match(/^\/api\/stations\/([^/]+)\/signup$/)) && method === 'POST') {
      if (!logins || !resolver.signUp) throw new HttpError(404, 'sign-ins are not available');
      const station = stationOr404(decodeURIComponent(m[1]), { requireEnabled: false });
      let raw, account;
      try {
        raw = await readJson(req, 10_000);
        account = normalizeLogin(raw);
      } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, e.message); }
      let r;
      try {
        r = await resolver.signUp(station, { ...account, acceptTerms: raw.acceptTerms === true });
      } catch (e) {
        return send(res, 200, { ok: false, id: station.id, error: e.message });
      }
      // The account exists now; saving it here failing doesn't undo that.
      try {
        await logins.set(station.id, account);
        if (!r.confirmEmail) await logins.signedIn(station.id, r.session);
      } catch (e) {
        log.warn?.(`[${station.id}] account created, but saving the sign-in failed: ${e.message}`);
        return send(res, 200, { ok: true, id: station.id, confirmEmail: r.confirmEmail, configured: false, error: `The account was created, but saving the sign-in failed (${e.message}); save it with Save sign-in.` });
      }
      lastSignIn.delete(station.id);
      cache.invalidate(station.id);
      return send(res, 200, { ok: true, id: station.id, confirmEmail: r.confirmEmail, ...logins.status(station.id) });
    }

    if ((m = p.match(/^\/api\/stations\/([^/]+)\/test$/)) && method === 'POST') {
      const station = stationOr404(decodeURIComponent(m[1]), { requireEnabled: false });
      try {
        // Test now is how a person tries a failed sign-in again.
        logins?.allowRetry(station.id, now() + 3 * 60_000);
        // A failed test (an ad slate, a bot check) leaves a stream that's playing alone.
        const r = await cache.get(station, { force: true, keepOnFailure: true });
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
      const status = e instanceof HttpError ? e.status : e instanceof URIError ? 400 : (e.details ? 502 : 500);
      if (status >= 500) log.warn?.(`${req.method} ${req.url}: ${e.message}`);
      if (!res.headersSent) send(res, status, { error: e.message, details: e.details });
      else res.destroy();
    }
  }

  return { handler, cache, warmSports };
}
