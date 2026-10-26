// HLS playlist helpers: parsing master playlists, picking one quality, rewriting URIs so every
// request goes back through the sidecar, and reading expiry times out of signed URLs.

export const HLS_RE = /^\uFEFF?\s*#EXTM3U/;

export function isHls(text) {
  return HLS_RE.test(text);
}

// FairPlay / Widevine / PlayReady: only the official players can decrypt these. (AES-128 with a
// plain key URL is not DRM and plays fine.)
export function isDrm(text) {
  return /METHOD=SAMPLE-AES/i.test(text)
    || /KEYFORMAT="(com\.apple\.streamingkeydelivery|urn:uuid:)/i.test(text)
    || /URI="skd:/i.test(text)
    || /<ContentProtection\b/i.test(text);
}

export function isMaster(text) {
  return /#EXT-X-STREAM-INF/i.test(text);
}

// A media playlist is live while it has no ENDLIST and isn't declared VOD.
export function isLivePlaylist(text) {
  return !/#EXT-X-ENDLIST/i.test(text) && !/#EXT-X-PLAYLIST-TYPE:VOD/i.test(text);
}

// Attribute lists look like KEY=VALUE,KEY="quoted,value",...
export function parseAttributes(list) {
  const attrs = {};
  for (const m of list.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    attrs[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  }
  return attrs;
}

export function parseVariants(text) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXT-X-STREAM-INF:(.*)$/i);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
    if (j >= lines.length) break;
    const attrs = parseAttributes(m[1]);
    const res = (attrs.RESOLUTION || '').match(/^(\d+)x(\d+)$/);
    variants.push({
      infoLine: i,
      uriLine: j,
      uri: lines[j].trim(),
      attrs,
      bandwidth: Number(attrs['AVERAGE-BANDWIDTH'] || attrs.BANDWIDTH) || 0,
      height: res ? Number(res[2]) : null,
    });
    i = j;
  }
  return variants;
}

// Best quality that fits under maxHeight; variants without a resolution only win when nothing
// else qualifies. Falls back to the smallest variant when all are too tall.
export function pickVariant(variants, maxHeight = 1080) {
  if (!variants.length) return null;
  const video = variants.filter(v => v.height !== null);
  const fitting = video.filter(v => v.height <= maxHeight);
  const pool = fitting.length ? fitting : (video.length ? [] : variants);
  if (pool.length) return [...pool].sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth)[0];
  return [...video].sort((a, b) => a.height - b.height || a.bandwidth - b.bandwidth)[0];
}

// Absolute URL of the variant pickVariant() chooses, or null.
export function chosenVariantUrl(text, baseUrl, maxHeight = 1080) {
  const v = pickVariant(parseVariants(text), maxHeight);
  return v ? new URL(v.uri, baseUrl).href : null;
}

// Absolute URIs of the master playlist's EXT-X-MEDIA renditions (audio, subtitles), in order.
export function renditionUrls(text, baseUrl) {
  const urls = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^#EXT-X-MEDIA:/i.test(line)) continue;
    const m = line.match(/URI="([^"]*)"/);
    if (m) urls.push(new URL(m[1], baseUrl).href);
  }
  return urls;
}

// Tags a master playlist may carry. Anything else is dropped: ffmpeg 7 refuses a master that also
// has media-playlist tags (Uplynk's masters carry #EXT-X-START and vendor #UPLYNK-* lines).
const MASTER_TAGS = /^#(EXTM3U|EXT-X-VERSION|EXT-X-INDEPENDENT-SEGMENTS|EXT-X-MEDIA|EXT-X-STREAM-INF|EXT-X-SESSION-DATA)(:|$)/i;

// Master playlist reduced to the chosen variant, with its URI replaced by `variantUrl` and the
// n-th rendition URI by `renditionUrl(n)`. These are stable sidecar URLs, so a re-resolved
// (re-signed) upstream stream doesn't change what ffmpeg keeps reloading. I-frame playlists
// and non-master tags are dropped.
export function rewriteMaster(text, { maxHeight = 1080, variantUrl, renditionUrl }) {
  const lines = text.split(/\r?\n/);
  const variants = parseVariants(text);
  const chosen = pickVariant(variants, maxHeight);
  const drop = new Set();
  for (const v of variants) {
    if (v !== chosen) { drop.add(v.infoLine); drop.add(v.uriLine); }
  }
  let rendition = 0;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (drop.has(i)) continue;
    const line = lines[i];
    if (line.startsWith('#') && !MASTER_TAGS.test(line)) continue;
    // Session keys and session data files are optional hints; their URIs are relative to the
    // upstream master, so kept as they are they'd point at the sidecar. (Media playlists carry
    // the keys players actually use.)
    if (/^#EXT-X-SESSION-DATA:/i.test(line) && /URI="/.test(line)) continue;
    if (/^#EXT-X-MEDIA:/i.test(line) && /URI="/.test(line)) {
      const n = rendition++;
      out.push(line.replace(/URI="[^"]*"/, `URI="${renditionUrl(n)}"`));
      continue;
    }
    if (chosen && i === chosen.uriLine) { out.push(variantUrl); continue; }
    out.push(line);
  }
  return out.join('\n');
}

// Media playlist with segment, key, init-section and partial-segment URIs passed through
// mediaUrl(absoluteUrl, kind), kind being 'segment', 'key' or 'map'. Low-latency rendition
// reports point at other playlists; ffmpeg doesn't use them, so they're dropped rather than
// proxied.
export function rewriteMedia(text, baseUrl, mediaUrl) {
  const abs = uri => new URL(uri, baseUrl).href;
  // Only http(s) resources go through the proxy; key formats like skd: or data: stay as they are.
  const map = (uri, kind) => {
    const a = abs(uri);
    return /^https?:/i.test(a) ? mediaUrl(a, kind) : uri;
  };
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) { out.push(line); continue; }
    if (line.startsWith('#')) {
      if (/^#EXT-X-RENDITION-REPORT:/i.test(line)) continue;
      const kind = /^#EXT-X-(SESSION-)?KEY:/i.test(line) ? 'key' : /^#EXT-X-MAP:/i.test(line) ? 'map' : 'segment';
      out.push(line.replace(/URI="([^"]*)"/g, (_, uri) => `URI="${map(uri, kind)}"`));
      continue;
    }
    out.push(map(line.trim(), 'segment'));
  }
  return out.join('\n');
}

// Expiry of a signed URL, in epoch milliseconds, from common CDN conventions: `exp=` / `expires=`
// query parameters (seconds or milliseconds) and Akamai `hdnts=...~exp=...` tokens.
export function expiryFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const values = [];
  for (const [k, v] of u.searchParams) {
    if (/^(exp|expires|expiry|expire|e)$/i.test(k)) values.push(v);
    if (/^(hdnts|hdnea|__token__)$/i.test(k)) {
      const m = v.match(/(?:^|~)exp=(\d+)/);
      if (m) values.push(m[1]);
    }
  }
  for (const m of u.pathname.matchAll(/(?:^|[/~,])exp=(\d+)/g)) values.push(m[1]);
  // YouTube puts it in the path: .../expire/1730000000/...
  for (const m of u.pathname.matchAll(/\/expire\/(\d+)(?:\/|$)/g)) values.push(m[1]);
  const times = values
    .map(v => Number(v))
    .filter(n => Number.isFinite(n) && n > 1e9)
    .map(n => (n < 1e12 ? n * 1000 : n));
  return times.length ? Math.min(...times) : null;
}

// File extension for a proxied URL. ffmpeg only accepts HLS segment URLs ending in a media
// extension, so the proxy path ends with the upstream one, or a sensible default.
const MEDIA_EXT = /\.(ts|aac|ac3|ec3|eac3|mp3|m4s|mp4|m4a|m4v|cmfv|cmfa|vtt|webvtt)$/i;
export function proxyExtension(url, kind = 'segment') {
  let pathname = '';
  try { pathname = new URL(url).pathname; } catch { /* not a URL */ }
  const m = pathname.match(MEDIA_EXT);
  if (m) return m[1].toLowerCase();
  return kind === 'key' ? 'key' : kind === 'map' ? 'mp4' : 'ts';
}
