// Choosing the station's live stream among everything a page loaded: ads, previews, VOD clips,
// quality variants and the real feed all show up as candidates.

export const AD_RE = /livestream-update-needed|update-needed|\/slate\/|doubleclick|googlesyndication|imasdk|pubads|g\.doubleclick|freewheel|fwmrm|springserve|spotx|adsrvr|amazon-adsystem|innovid|tremorhub|serving-sys|\/ads?\/|[?&]ad(?:s|_?id)?=|preroll|pre-roll/i;
const MANIFEST_RE = /\.(m3u8|mpd)(\?|#|$)/i;

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
  if (AD_RE.test(c.url)) return -Infinity;
  let score = 0;
  if (c.paired) score += 4;
  if (c.probe.master) score += 2;
  if (c.sources && c.sources.includes('network')) score += 1;
  if (c.type === 'hls') score += 1; // ffmpeg handles HLS live best; DASH live is less reliable
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
