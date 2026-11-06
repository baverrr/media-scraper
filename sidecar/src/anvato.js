// A fast path for stations whose player is Anvato (Lura): Nexstar's stations and others. The
// player asks Anvato's video API for the live stream, with the video ID and the player's public
// access key ("anvack") in the URL. Once a page resolve has seen that request, the same call over
// plain HTTP answers with a fresh stream URL in a fraction of a second, with no browser.
//
// Only the video ID and access key are sent: none of the player's ad parameters, cookies or
// device IDs.
import { readFile } from 'node:fs/promises';
import { JsonFile } from './jsonfile.js';

// Anvato's API hosts. A request to any other host is never recorded, so a page can't point the
// fast path somewhere else.
const ANVATO_HOST_RE = /(^|\.)(lura\.live|anvato\.net)$/i;
const VIDEO_PATH_RE = /^\/rest\/v2\/mcp\/video\/([A-Za-z0-9_-]{4,64})$/;
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

// The Anvato video request in a URL the page loaded, as { host, videoId, key }, or null.
export function anvatoSource(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || !ANVATO_HOST_RE.test(u.hostname)) return null;
  const id = u.pathname.match(VIDEO_PATH_RE)?.[1];
  const key = u.searchParams.get('anvack');
  if (!id || !key || !KEY_RE.test(key)) return null;
  return { host: u.hostname.toLowerCase(), videoId: id, key };
}

export function isAnvatoHost(url) {
  try { return ANVATO_HOST_RE.test(new URL(url).hostname); } catch { return false; }
}

export function anvatoRequestUrl({ host, videoId, key }) {
  return `https://${host}/rest/v2/mcp/video/${encodeURIComponent(videoId)}?anvack=${encodeURIComponent(key)}`;
}

// Anvato answers JSONP: anvatoVideoJSONLoaded({...}). Plain JSON is accepted too.
export function parseAnvato(text) {
  const s = String(text || '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

// The HLS manifest URLs in an Anvato answer, best first.
export function anvatoManifests(data) {
  const urls = (Array.isArray(data?.published_urls) ? data.published_urls : [])
    .map(p => p?.embed_url)
    .filter(u => typeof u === 'string' && /^https:\/\//i.test(u) && /\.m3u8(\?|$)/i.test(u));
  return [...new Set(urls)];
}

// The Anvato requests seen on each station page (keyed by the page's URL, so a station whose
// page changes learns again), newest first and at most MAX_SOURCES, kept in
// anvato.json in the data directory so the fast path works from the first resolve after a restart.
// Without a file (tests), they're kept in memory only.
const MAX_SOURCES = 3;

export class AnvatoSources {
  constructor({ file = null, log = console } = {}) {
    this.log = log;
    this.byStation = new Map();
    this.json = file ? new JsonFile(file, () => JSON.stringify(Object.fromEntries(this.byStation), null, 2)) : null;
  }

  async load() {
    if (!this.json) return this;
    let text;
    try { text = await readFile(this.json.file, 'utf8'); } catch { return this; }
    try {
      for (const [id, list] of Object.entries(JSON.parse(text))) {
        const sources = (Array.isArray(list) ? list : []).map(s => s && anvatoSource(anvatoRequestUrl(s))).filter(Boolean);
        if (sources.length) this.byStation.set(id, sources.slice(0, MAX_SOURCES));
      }
    } catch {
      await this.json.setAside(this.log, 'Anvato fast path');
    }
    return this;
  }

  get(id) {
    return this.byStation.get(id) || [];
  }

  // Puts the sources first (most recent use first), dropping repeats and the oldest past the limit.
  async remember(id, sources) {
    const key = s => `${s.host}/${s.videoId}/${s.key}`;
    const seen = new Set();
    const merged = [...sources, ...this.get(id)].filter(s => !seen.has(key(s)) && seen.add(key(s))).slice(0, MAX_SOURCES);
    const before = JSON.stringify(this.get(id));
    if (JSON.stringify(merged) === before) return;
    this.byStation.set(id, merged);
    await this.save();
  }

  async forget(id, source = null) {
    const keep = source ? this.get(id).filter(s => s.videoId !== source.videoId || s.key !== source.key || s.host !== source.host) : [];
    if (keep.length === this.get(id).length) return;
    if (keep.length) this.byStation.set(id, keep); else this.byStation.delete(id);
    await this.save();
  }

  async save() {
    if (!this.json) return;
    try { await this.json.write(); } catch (e) { this.log.warn?.(`Anvato fast path: couldn't save ${this.json.file}: ${e.message}`); }
  }
}

// Asks Anvato for the stream. Returns the manifest URLs (possibly none); throws on a network or
// HTTP error.
export async function fetchAnvato(source, { userAgent, referer, timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  const headers = { 'user-agent': userAgent, ...(referer ? { referer } : {}) };
  const res = await fetchImpl(anvatoRequestUrl(source), { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`Anvato HTTP ${res.status}`);
  return anvatoManifests(parseAnvato(await res.text()));
}
