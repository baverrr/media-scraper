// Checks a manifest from Node with the headers the browser used: reachable, really a manifest,
// and live (HLS without ENDLIST / DASH type="dynamic"). Master playlists are judged by the
// variant the proxy would play.
import { isHls, isMaster, isLivePlaylist, isDrm, parseVariants, pickVariant } from './hls.js';

const DRM = { ok: false, drm: true, error: 'DRM-protected stream (only the official players can decrypt it)' };

export async function probeManifest(url, headers = {}, { timeoutMs = 10_000, maxHeight = 1080, fetchImpl = fetch } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal, redirect: 'follow' });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const finalUrl = res.url || url;
    if (isHls(text)) {
      if (isDrm(text)) return { ...DRM, status: res.status };
      if (!isMaster(text)) return { ok: true, master: false, live: isLivePlaylist(text), finalUrl };
      const variant = pickVariant(parseVariants(text), maxHeight);
      if (!variant) return { ok: false, status: res.status, error: 'master playlist has no variants' };
      const vres = await fetchImpl(new URL(variant.uri, finalUrl).href, { headers, signal, redirect: 'follow' });
      const vtext = await vres.text();
      if (!vres.ok) return { ok: false, status: vres.status, error: `variant HTTP ${vres.status}` };
      if (!isHls(vtext)) return { ok: false, status: vres.status, error: 'variant is not a playlist' };
      if (isDrm(vtext)) return { ...DRM, status: vres.status };
      return { ok: true, master: true, live: isLivePlaylist(vtext), finalUrl, height: variant.height };
    }
    if (/<MPD[\s>]/i.test(text)) {
      if (isDrm(text)) return { ...DRM, status: res.status };
      return { ok: true, master: true, dash: true, live: /type\s*=\s*["']dynamic["']/i.test(text), finalUrl };
    }
    return { ok: false, status: res.status, error: 'not a manifest' };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  }
}
