// Choosing the station's live stream among everything a page loaded: ads, previews, VOD clips,
// quality variants and the real feed all show up as candidates.

export const AD_RE = /livestream-update-needed|update-needed|\/slate\/|doubleclick|googlesyndication|imasdk|pubads|g\.doubleclick|freewheel|fwmrm|springserve|spotx|adsrvr|amazon-adsystem|innovid|tremorhub|serving-sys|\/ads?\/|[?&]ad(?:s|_?id)?=|preroll|pre-roll/i;
const MANIFEST_RE = /\.(m3u8|mpd)(\?|#|$)/i;

// Google DAI (server-side ad insertion) live streams: the programme itself, with ads stitched in,
// served from ad hostnames. Gray Television's station players use them. Not ads.
const DAI_STREAM_RE = /^https:\/\/(?:pubads\.g\.doubleclick\.net|dai\.google\.com)\/(?:ssai|linear)\//i;

export function isAd(url) {
  return AD_RE.test(url) && !DAI_STREAM_RE.test(url);
}

// DAI answers the same stream requests on dai.google.com as on pubads.g.doubleclick.net, which
// DNS ad blockers (AdGuard, Pi-hole) block; use the host that isn't blocked.
export const DAI_BLOCKED_HOST_RE = /^https:\/\/pubads\.g\.doubleclick\.net\/(ssai|linear)\//i;
export function unblockedStreamUrl(url) {
  return String(url).replace(DAI_BLOCKED_HOST_RE, 'https://dai.google.com/$1/');
}

export function manifestTypeOf(url, contentType = '') {
  if (/mpegurl/i.test(contentType) || /\.m3u8(\?|#|$)/i.test(url)) return 'hls';
  if (/dash\+xml/i.test(contentType) || /\.mpd(\?|#|$)/i.test(url)) return 'dash';
  return null;
}

export function isManifestUrl(url) {
  return MANIFEST_RE.test(url);
}

// Score probed candidates; higher is better. Only live, reachable manifests are eligible.
//   paired:  the page's own <video> is playing it (media-scraper paired the MSE element)
//   master:  a master playlist (lets the sidecar pick the quality)
//   network: actually requested by the page, not just mentioned in markup
export function scoreCandidate(c) {
  if (!c.probe || !c.probe.ok || c.probe.live !== true) return -Infinity;
  if (isAd(c.url)) return -Infinity;
  let score = 0;
  // Live HLS the page actually used (its player's, or requested) beats DASH: only HLS goes through
  // the proxy (with the page's headers, re-resolving behind stable URLs); DASH is a bare redirect,
  // without the Referer or cookies the CDN may want, and ffmpeg handles DASH live less reliably.
  // A live .m3u8 merely mentioned in the markup (a promo, a radar loop) doesn't get this.
  const used = c.paired || (c.sources && c.sources.includes('network'));
  if (!c.probe.dash && c.type !== 'dash' && used) score += 8;
  if (c.paired) score += 4;
  if (c.probe.master) score += 2;
  if (c.sources && c.sources.includes('network')) score += 1;
  return score;
}

export function pickBest(candidates) {
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const s = scoreCandidate(c);
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return best;
}

// Merge candidates for the same URL (found by network capture and by the scan, say).
export function mergeCandidates(list) {
  const map = new Map();
  for (const c of list) {
    const prev = map.get(c.url);
    if (!prev) { map.set(c.url, { ...c, sources: [...(c.sources || [])] }); continue; }
    for (const s of c.sources || []) if (!prev.sources.includes(s)) prev.sources.push(s);
    prev.paired = prev.paired || c.paired;
    prev.headers = prev.headers || c.headers;
    prev.type = prev.type || c.type;
  }
  return [...map.values()];
}

// Request headers worth replaying upstream; the rest (sec-ch-*, accept-*) are browser noise.
const KEEP_HEADERS = /^(referer|origin|user-agent|cookie|authorization|x-(?!client-data)[\w-]+)$/i;

export function pickHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (KEEP_HEADERS.test(k) && v) out[k.toLowerCase()] = v;
  return out;
}
