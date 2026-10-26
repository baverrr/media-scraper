/*
 * media-scraper.js — find live (and other) media players on any page.
 *
 * Usage:
 *   - Paste into the DevTools console, or load as a bookmarklet / userscript.
 *   - Puppeteer/Playwright: await page.addScriptTag({ path: 'media-scraper.js' });
 *                           const r = await page.evaluate(() => MediaScraper.scan().then(MediaScraper.toJSON));
 *
 *   await MediaScraper.scan()                 // one-shot scan, prints a table, returns results
 *   await MediaScraper.scan({ probe: false }) // skip fetching manifests to check live status
 *   MediaScraper.watch(cb)                    // hook fetch/XHR + DOM, report new streams as they appear
 *   MediaScraper.unwatch()
 *   MediaScraper.copy()                       // copy last results as JSON to the clipboard
 *
 * What it finds:
 *   - <video>/<audio> elements (incl. open shadow DOM and same-origin iframes), with
 *     live detection via duration === Infinity / growing seekable range, and WebRTC /
 *     MediaStream players (srcObject)
 *   - HLS (.m3u8), DASH (.mpd), FLV, RTMP/RTSP/media WebSocket URLs from network requests
 *     (observed continuously, so a full resource timing buffer doesn't hide them),
 *     <source> tags, attributes, inline scripts and JSON blobs
 *   - Embedded third-party players (YouTube, Twitch, Kick, Vimeo, Facebook, etc.)
 *   - Player library instances (video.js, JW Player, hls.js, dash.js, Shaka, Clappr, Plyr, Flowplayer);
 *     hls.js, dash.js and Shaka are hooked on load so each MSE <video> is paired with its manifest
 *
 * Limitations: cross-origin iframes can't be inspected (only their src is reported), closed
 * shadow roots are invisible, manifest probing is subject to CORS, and player instances
 * created before this script loads (or from a bundled, non-global library) can't be paired.
 */
(function (global) {
  'use strict';

  const STREAM_RE = /(?:https?:)?\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd|flv|f4m|ism\/manifest)(?:\?[^\s"'<>\\]*)?|(?:rtmps?|rtsp|srt|wss?):\/\/[^\s"'<>\\]+/gi;
  const STREAM_EXT_RE = /\.(m3u8|mpd|flv|f4m)(\?|#|$)|\/manifest(\(|\?|$)|^(rtmps?|rtsp|srt):/i;
  // WebSockets that look like media (FLV/TS/MP4 over ws, /live/ or /stream/ paths), not chat or analytics.
  const MEDIA_WS_RE = /^wss?:\/\/[^?#]*(?:\.(?:flv|ts|mp4|m4s|h264|mjpe?g)(?:[?#]|$)|\/(?:live|stream|streams|media|video|play)(?:[/?#]|$))/i;
  const HLS_RE = /^\uFEFF?\s*#EXTM3U/;
  const MPD_RE = /<MPD[\s>]/i;
  // Quoted relative paths to a manifest ("/live/index.m3u8", "../a.mpd", "index.m3u8?x=1").
  const REL_STREAM_RE = /["'`]((?:\.{1,2}\/|\/(?!\/))?[\w\-.~%/]*\.(?:m3u8|mpd)(?:\?[^\s"'`<>\\]*)?)["'`]/gi;
  // Response content types that identify a manifest when the URL has no telling extension.
  const MANIFEST_TYPES = [
    { re: /mpegurl/i, type: 'hls' },
    { re: /dash\+xml/i, type: 'dash' },
    { re: /vnd\.ms-sstr\+xml/i, type: 'smooth' },
    { re: /x-flv/i, type: 'flv' },
  ];
  // Query parameters that change on every request: LL-HLS delivery directives, and cache-busters
  // when they hold a timestamp or random number (so a `t=` token is left alone).
  const VOLATILE_PARAM_RE = /^_HLS_/i;
  const CACHE_BUST_PARAM_RE = /^(?:_|t|ts|time|timestamp|cb|cachebust|cachebuster|nocache|r|rnd|rand|random)$/i;
  const CACHE_BUST_VALUE_RE = /^(?:\d{6,}|0?\.\d+)$/;
  const NETWORK_LIMIT = 500;

  const EMBEDS = [
    { name: 'YouTube',     re: /youtube(?:-nocookie)?\.com\/embed\/live_stream\?(?:[^#]*&)?channel=([\w-]+)|youtube(?:-nocookie)?\.com\/(?:embed|live)\/([\w-]+)|youtu\.be\/([\w-]+)/i },
    { name: 'Twitch',      re: /(?:player|clips)\.twitch\.tv\/(?:embed)?\?(?:[^#]*&)?(?:channel|video|clip)=([\w-]+)|twitch\.tv\/embed\/([\w-]+)/i },
    { name: 'Kick',        re: /player\.kick\.com\/([\w-]+)/i },
    { name: 'Vimeo',       re: /player\.vimeo\.com\/video\/(\d+)|vimeo\.com\/event\/(\d+)/i },
    { name: 'Facebook',    re: /facebook\.com\/plugins\/video\.php/i },
    { name: 'Dailymotion', re: /dailymotion\.com\/(?:embed\/)?video\/([\w]+)|geo\.dailymotion\.com\/player/i },
    { name: 'Rumble',      re: /rumble\.com\/embed\/([\w]+)/i },
    { name: 'Streamable',  re: /streamable\.com\/[eo]\/([\w]+)/i },
    { name: 'Wistia',      re: /fast\.wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/([\w]+)/i },
    { name: 'Brightcove',  re: /players\.brightcove\.net\//i },
    { name: 'JW Player',   re: /(?:cdn|content)\.jwplayer\.com\/players\//i },
    { name: 'Mux',         re: /stream\.mux\.com|player\.mux\.com/i },
    { name: 'Livestream',  re: /livestream\.com\/accounts\/\d+\/events/i },
    { name: 'IBM Video',   re: /(?:ustream\.tv|video\.ibm\.com)\/embed/i },
    { name: 'Restream',    re: /player\.restream\.io/i },
    { name: 'Owncast',     re: /^https?:\/\/[^/]+\/embed\/video\/?(?:[?#]|$)/i },
  ];

  let last = [];
  let watching = null;

  // Player instances captured by hooking library prototypes/factories (see hookLibraries).
  const captured = new Set();
  // Stream requests seen by a PerformanceObserver (or by watch()'s content-type check), keyed by
  // streamKey(). Unlike performance.getEntries(), an observer keeps receiving entries after the
  // 250-entry resource timing buffer fills, which live pages do quickly by re-fetching their
  // playlist every few seconds. Capped at NETWORK_LIMIT, oldest first out.
  const networkSeen = new Map();
  const observedWindows = new WeakSet();

  // ---------- helpers ----------

  function abs(url, base) {
    try { return new URL(url, base || location.href).href; } catch { return null; }
  }

  // The URL minus its fragment and any per-request parameters, so a playlist polled as
  // `?_HLS_msn=812&_HLS_part=3` or `?_=1730000000000` is one stream, not hundreds. The rest of
  // the query is kept byte-for-byte, so signed tokens still work when the URL is fetched.
  function streamKey(url) {
    if (!url) return url;
    const noHash = String(url).replace(/#.*$/, '');
    const q = noHash.indexOf('?');
    if (q < 0) return noHash;
    const kept = noHash.slice(q + 1).split('&').filter(pair => {
      if (!pair) return false;
      const [k, v = ''] = pair.split('=');
      let key = k, val = v;
      try { key = decodeURIComponent(k); val = decodeURIComponent(v); } catch {}
      return !(VOLATILE_PARAM_RE.test(key) || (CACHE_BUST_PARAM_RE.test(key) && CACHE_BUST_VALUE_RE.test(val)));
    });
    return noHash.slice(0, q) + (kept.length ? '?' + kept.join('&') : '');
  }

  function rememberNetwork(url, type) {
    const key = streamKey(url);
    if (!key) return;
    networkSeen.delete(key); // re-insert so recently active streams survive the cap
    networkSeen.set(key, { url: key, type: type || typeOf(key) });
    if (networkSeen.size > NETWORK_LIMIT) networkSeen.delete(networkSeen.keys().next().value);
  }

  function manifestType(contentType) {
    const m = contentType && MANIFEST_TYPES.find(t => t.re.test(contentType));
    return m ? m.type : null;
  }

  function typeOf(url) {
    const u = String(url).toLowerCase();
    if (u.startsWith('blob:')) return 'mse-blob';
    if (/\.m3u8(\?|#|$)/.test(u)) return 'hls';
    if (/\.mpd(\?|#|$)/.test(u)) return 'dash';
    if (/\/manifest(\(|\?|$)/.test(u)) return 'smooth';
    if (/\.flv(\?|#|$)/.test(u)) return 'flv';
    if (/\.f4m(\?|#|$)/.test(u)) return 'hds';
    if (/^rtmps?:/.test(u)) return 'rtmp';
    if (/^rtsp:/.test(u)) return 'rtsp';
    if (/^srt:/.test(u)) return 'srt';
    if (/^wss?:/.test(u)) return 'websocket';
    if (/\.(mp4|webm|mkv|mov|m4v)(\?|#|$)/.test(u)) return 'progressive';
    if (/\.(mp3|aac|m4a|ogg|opus|wav|flac)(\?|#|$)/.test(u)) return 'audio';
    return 'unknown';
  }

  // Walk the document, open shadow roots, and same-origin iframes.
  function* roots(doc = document, seen = new Set()) {
    if (!doc || seen.has(doc)) return;
    seen.add(doc);
    yield doc;
    // Shadow roots have no createTreeWalker of their own; use the owning document's.
    const walker = (doc.ownerDocument || doc).createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (el.shadowRoot) yield* roots(el.shadowRoot, seen);
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let inner = null;
        try { inner = el.contentDocument; } catch { /* cross-origin */ }
        if (inner) yield* roots(inner, seen);
      }
    }
  }

  function queryAll(selector) {
    const out = [];
    for (const r of roots()) out.push(...r.querySelectorAll(selector));
    return out;
  }

  function describe(el) {
    if (!el || !el.tagName) return '';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (typeof el.className === 'string' && el.className.trim()) {
      s += '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.');
    }
    return s;
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  function windowsOf() {
    const out = [];
    for (const r of roots()) if (r.defaultView) out.push(r.defaultView);
    return out;
  }

  // Wrap a method so every instance that calls it is captured. Idempotent per function.
  function captureOn(obj, method, onCall = inst => captured.add(inst)) {
    const orig = obj && obj[method];
    if (typeof orig !== 'function' || orig.__msHook) return;
    const wrapped = function () { try { onCall(this); } catch {} return orig.apply(this, arguments); };
    Object.defineProperty(wrapped, '__msHook', { value: true });
    obj[method] = wrapped;
  }

  // hls.js, dash.js and Shaka instances are rarely reachable from window or the <video>, so hook
  // the libraries to catch instances created or (re)loaded from now on.
  function hookLibraries(win) {
    try {
      if (win.Hls && win.Hls.prototype) {
        captureOn(win.Hls.prototype, 'loadSource');
        captureOn(win.Hls.prototype, 'attachMedia');
        captureOn(win.Hls.prototype, 'destroy', inst => captured.delete(inst));
      }
    } catch {}
    try {
      if (win.shaka && win.shaka.Player && win.shaka.Player.prototype) {
        captureOn(win.shaka.Player.prototype, 'load');
        captureOn(win.shaka.Player.prototype, 'attach');
        captureOn(win.shaka.Player.prototype, 'destroy', inst => captured.delete(inst));
      }
    } catch {}
    try {
      // dash.js players come from a factory: dashjs.MediaPlayer().create().
      const dash = win.dashjs;
      if (dash && typeof dash.MediaPlayer === 'function' && !dash.MediaPlayer.__msHook) {
        const origFactory = dash.MediaPlayer;
        const factory = function () {
          const f = origFactory.apply(this, arguments);
          const create = f && f.create;
          if (typeof create === 'function') {
            f.create = function () { const p = create.apply(this, arguments); captured.add(p); return p; };
          }
          return f;
        };
        Object.assign(factory, origFactory);
        Object.defineProperty(factory, '__msHook', { value: true });
        dash.MediaPlayer = factory;
      }
    } catch {}
  }

  // When the script runs before the libraries load (a userscript at document-start, Puppeteer's
  // evaluateOnNewDocument), hook each library the moment its UMD build assigns it to window.
  // Only used while the document is still loading: until assigned, `'Hls' in window` is true.
  function trapLibraries(win) {
    for (const name of ['Hls', 'shaka', 'dashjs']) {
      try {
        if (Object.getOwnPropertyDescriptor(win, name)) continue; // already defined
        Object.defineProperty(win, name, {
          configurable: true,
          enumerable: false,
          get() { return undefined; },
          set(value) {
            // Turn back into a plain property, then hook. Hook again on the next tick too, for
            // namespaces like `shaka` whose members are filled in after it's assigned.
            Object.defineProperty(win, name, { value, writable: true, configurable: true, enumerable: true });
            hookLibraries(win);
            win.setTimeout(() => hookLibraries(win), 0);
          },
        });
      } catch {}
    }
  }

  function observeNetwork(win) {
    if (!win || observedWindows.has(win)) return;
    observedWindows.add(win);
    try {
      const po = new win.PerformanceObserver(list => {
        for (const e of list.getEntries()) if (STREAM_EXT_RE.test(e.name)) rememberNetwork(e.name);
      });
      po.observe({ type: 'resource', buffered: true });
    } catch {}
  }

  // ---------- collectors ----------

  function collectMediaElements() {
    const out = [];
    for (const el of queryAll('video, audio')) {
      const sources = [el.currentSrc, el.src, ...[...el.querySelectorAll('source')].map(s => s.src)]
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i);
      let seekableEnd = null;
      try { if (el.seekable.length) seekableEnd = el.seekable.end(el.seekable.length - 1); } catch {}
      const live = el.duration === Infinity ||
        (seekableEnd !== null && Number.isFinite(el.duration) && seekableEnd > el.duration + 1);
      // MSE players (hls.js, dash.js, …) often give live streams a finite, growing duration,
      // so a finite duration only means VOD for direct sources.
      const mse = String(sources[0] || '').startsWith('blob:');
      // srcObject players have no URL: a MediaStream (WebRTC, camera, canvas capture) is always
      // live; a MediaSource set directly (Safari) is an MSE player like a blob: URL.
      const obj = el.srcObject;
      const stream = obj && typeof obj.getTracks === 'function' ? obj : null;
      let type = sources[0] ? typeOf(sources[0]) : 'none';
      if (stream) type = 'mediastream';
      else if (obj) type = 'mse-blob';
      out.push({
        kind: el.tagName.toLowerCase(),
        source: 'element',
        url: sources[0] || null,
        alternates: sources.slice(1),
        type,
        live: live || stream ? true : (!mse && !obj && el.duration > 0 && Number.isFinite(el.duration) ? false : null),
        streamTracks: stream ? stream.getTracks().map(t => ({ kind: t.kind, label: t.label, state: t.readyState })) : undefined,
        playing: !el.paused && !el.ended && el.readyState > 2,
        muted: el.muted,
        size: el.videoWidth ? `${el.videoWidth}x${el.videoHeight}` : null,
        visible: isVisible(el),
        duration: el.duration,
        element: describe(el),
        tracks: [...el.querySelectorAll('track')].map(t => ({ kind: t.kind, lang: t.srclang, src: t.src })),
        node: el,
      });
    }
    return out;
  }

  function collectEmbeds() {
    const out = [];
    for (const el of queryAll('iframe, embed, object')) {
      const src = el.src || el.data || el.getAttribute('data-src') || '';
      if (!src) continue;
      for (const e of EMBEDS) {
        const m = src.match(e.re);
        if (!m) continue;
        out.push({
          kind: 'embed',
          source: 'iframe',
          provider: e.name,
          id: m.slice(1).find(Boolean) || null,
          url: abs(src),
          type: 'embed',
          live: /\/live|live_stream|channel=|event\//i.test(src) ? true : null,
          visible: isVisible(el),
          element: describe(el),
          node: el,
        });
        break;
      }
    }
    return out;
  }

  function collectNetwork() {
    for (const win of windowsOf()) {
      observeNetwork(win); // start observing same-origin iframes found since the last scan
      try {
        for (const e of win.performance.getEntriesByType('resource')) {
          if (STREAM_EXT_RE.test(e.name) && !networkSeen.has(streamKey(e.name))) rememberNetwork(e.name);
        }
      } catch {}
    }
    return [...networkSeen.values()].map(({ url, type }) => ({ kind: 'stream', source: 'network', url, type, live: null }));
  }

  function streamsInText(text, base) {
    const urls = [];
    // Undo JSON/JS escaping (\/ and \uXXXX) so query strings like stream tokens stay intact.
    const unescaped = text.replace(/\\\//g, '/')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&amp;/g, '&');
    for (const m of unescaped.matchAll(STREAM_RE)) {
      const url = abs(m[0].startsWith('//') ? location.protocol + m[0] : m[0], base);
      // Scripts are full of chat/analytics sockets; keep only ones that look like media.
      if (url && /^wss?:/i.test(url) && !MEDIA_WS_RE.test(url)) continue;
      if (url) urls.push(url);
    }
    for (const m of unescaped.matchAll(REL_STREAM_RE)) {
      const url = abs(m[1], base);
      if (url) urls.push(url);
    }
    return urls;
  }

  // Inline scripts can be megabytes of JSON; remember what each one contained so watch()'s
  // frequent rescans only re-read scripts whose text changed.
  const scriptCache = new WeakMap();

  function collectFromMarkup() {
    const out = [];
    const add = url => out.push({ kind: 'stream', source: 'markup', url, type: typeOf(url), live: null });
    for (const r of roots()) {
      const base = (r.ownerDocument || r).baseURI;
      for (const s of r.querySelectorAll('script:not([src]), script[type="application/json"], script[type="application/ld+json"]')) {
        const text = s.textContent;
        let cached = scriptCache.get(s);
        if (!cached || cached.text !== text) {
          cached = { text, urls: streamsInText(text, base) };
          scriptCache.set(s, cached);
        }
        cached.urls.forEach(add);
      }
      for (const el of r.querySelectorAll('*')) {
        for (const a of el.attributes) {
          // Quote the value so a bare relative path (data-src="/live/index.m3u8") matches too.
          if (a.value.length > 8 && /m3u8|mpd|rtmp|\.flv|manifest/i.test(a.value)) streamsInText(`"${a.value}"`, base).forEach(add);
        }
      }
    }
    return out;
  }

  // quick: skip reading every window property (watch() rescans); captured instances still count.
  function collectLibraries(quick = false) {
    const out = [];
    const w = global;
    // `media` is the <video>/<audio> the player drives; scan() uses it to pair MSE elements with
    // their manifest.
    const push = (lib, url, extra = {}) =>
      out.push({ kind: 'player', source: 'library', library: lib, url: url || null, type: url ? typeOf(url) : 'unknown', live: null, ...extra });
    const mediaIn = el => (el && el.querySelector ? el.querySelector('video, audio') : null);

    try {
      if (w.videojs && w.videojs.getPlayers) {
        for (const p of Object.values(w.videojs.getPlayers())) {
          if (!p) continue;
          const live = p.liveTracker ? p.liveTracker.isLive() : p.duration() === Infinity;
          push('video.js', p.currentSrc(), { live, element: describe(p.el && p.el()), media: mediaIn(p.el && p.el()) });
        }
      }
    } catch {}

    try {
      if (typeof w.jwplayer === 'function') {
        for (let i = 0; i < 20; i++) {
          const p = w.jwplayer(i);
          if (!p || !p.getPlaylistItem) break;
          const item = p.getPlaylistItem() || {};
          push('JW Player', item.file || (item.sources && item.sources[0] && item.sources[0].file), {
            live: p.getDuration && p.getDuration() === Infinity ? true : null,
            title: item.title,
            media: mediaIn(p.getContainer && p.getContainer()),
          });
        }
      }
    } catch {}

    try {
      for (const p of (w.Plyr && w.Plyr.instances) || []) {
        push('Plyr', p.source, { element: describe(p.elements && p.elements.container), media: p.media || null });
      }
    } catch {}

    try {
      if (w.flowplayer && w.flowplayer.instances) {
        for (const p of w.flowplayer.instances) push('Flowplayer', p.video && p.video.src, { live: !!(p.live || (p.video && p.video.live)) });
      }
    } catch {}

    // hls.js / dash.js / Shaka / Clappr instances usually aren't registered globally: use the ones
    // captured by hookLibraries(), plus window properties and media-element expandos that look like them.
    const looksHls = o => o && typeof o === 'object' && typeof o.loadSource === 'function' && 'url' in o;
    const looksDash = o => o && typeof o === 'object' && typeof o.getSource === 'function' && typeof o.isDynamic === 'function';
    const looksShaka = o => o && typeof o === 'object' && typeof o.getAssetUri === 'function' && typeof o.isLive === 'function';
    const looksClappr = o => o && typeof o === 'object' && o.options && typeof o.getPlugin === 'function' && 'core' in o;
    const candidates = new Set(captured);
    if (!quick) try { for (const k of Object.keys(w)) { try { candidates.add(w[k]); } catch {} } } catch {}
    for (const v of queryAll('video, audio')) {
      for (const k of Object.keys(v)) { try { candidates.add(v[k]); } catch {} }
    }
    const tryGet = fn => { try { return fn(); } catch { return null; } };
    for (const o of candidates) {
      try {
        if (looksHls(o)) {
          if (!o.url && !o.media) continue; // created but never used, or destroyed
          const lvl = o.levels && o.levels[o.currentLevel];
          push('hls.js', o.url, { live: lvl && lvl.details ? lvl.details.live : null, media: o.media || null });
        } else if (looksDash(o)) {
          push('dash.js', tryGet(() => String(o.getSource())), { live: tryGet(() => o.isDynamic()), media: tryGet(() => o.getVideoElement()) });
        } else if (looksShaka(o)) {
          push('Shaka', o.getAssetUri(), { live: o.isLive(), media: tryGet(() => o.getMediaElement()) });
        } else if (looksClappr(o)) {
          push('Clappr', o.options.source, { media: mediaIn(tryGet(() => o.core.el)) });
        }
      } catch {}
    }
    return out;
  }

  // ---------- live probing ----------

  // Try with cookies first (token-gated streams), then without: CDNs that answer with
  // `Access-Control-Allow-Origin: *` reject credentialed requests.
  async function get(url, signal) {
    try { return await fetch(url, { signal, credentials: 'include' }); }
    catch (e) { if (e.name === 'AbortError') throw e; return fetch(url, { signal, credentials: 'omit' }); }
  }

  async function probe(item, timeoutMs = 4000) {
    if (!item.url || !/^https?:/.test(item.url)) return;
    if (item.type !== 'hls' && item.type !== 'dash') return;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await get(item.url, ctl.signal);
      const text = await res.text();
      item.status = res.status;
      // Error pages (expired tokens, 403/404) have no ENDLIST either; don't read them as live.
      if (!res.ok) { item.probeError = `HTTP ${res.status}`; return; }
      if (!(item.type === 'hls' ? HLS_RE : MPD_RE).test(text)) { item.probeError = 'not a manifest'; return; }
      if (item.type === 'hls') {
        if (/#EXT-X-STREAM-INF/i.test(text)) {
          // Master playlist: probe the first variant to decide live vs VOD.
          item.variants = [...text.matchAll(/#EXT-X-STREAM-INF:([^\n]*)\n([^\n#][^\n]*)/gi)].map(m => ({
            info: m[1].trim(),
            url: abs(m[2].trim(), item.url),
          }));
          if (item.variants[0]) {
            const vr = await get(item.variants[0].url, ctl.signal);
            const v = await vr.text();
            if (!vr.ok) item.probeError = `variant HTTP ${vr.status}`;
            else if (!HLS_RE.test(v)) item.probeError = 'variant not a manifest';
            else item.live = !/#EXT-X-ENDLIST/i.test(v) && !/#EXT-X-PLAYLIST-TYPE:VOD/i.test(v);
          }
        } else {
          item.live = !/#EXT-X-ENDLIST/i.test(text) && !/#EXT-X-PLAYLIST-TYPE:VOD/i.test(text);
        }
      } else {
        item.live = /type\s*=\s*["']dynamic["']/i.test(text);
      }
    } catch (e) {
      item.probeError = e.name === 'AbortError' ? 'timeout' : 'blocked (CORS?)';
    } finally {
      clearTimeout(t);
    }
  }

  // ---------- main ----------

  function dedupe(items) {
    const map = new Map();
    for (const it of items) {
      const key = it.url ? streamKey(it.url) : it.source + ':' + (it.element || Math.random());
      const prev = map.get(key);
      if (!prev) { map.set(key, { ...it, foundBy: [it.source] }); continue; }
      if (!prev.foundBy.includes(it.source)) prev.foundBy.push(it.source);
      // Prefer the richer record (element/library > embed > network/markup).
      for (const [k, v] of Object.entries(it)) {
        if (prev[k] === undefined || prev[k] === null) prev[k] = v;
      }
      if (it.live === true) prev.live = true;
    }
    return [...map.values()];
  }

  async function scan(opts = {}) {
    const { probe: doProbe = true, liveOnly = false, quiet = false, record = true, quick = false } = opts;
    for (const win of windowsOf()) { hookLibraries(win); observeNetwork(win); }
    let items = dedupe([
      ...collectMediaElements(),
      ...collectLibraries(quick),
      ...collectEmbeds(),
      ...collectNetwork(),
      ...collectFromMarkup(),
    ]);

    if (doProbe) await Promise.all(items.filter(i => i.live === null).map(i => probe(i)));

    // Fold HLS variant playlists into their master instead of listing each quality separately.
    const variantOf = new Map();
    for (const m of items) for (const v of m.variants || []) variantOf.set(streamKey(v.url), m);
    items = items.filter(i => {
      const master = variantOf.get(streamKey(i.url));
      if (!master || i === master) return true;
      if (i.foundBy.some(s => s === 'element' || s === 'library')) return true;
      for (const s of i.foundBy) if (!master.foundBy.includes(s)) master.foundBy.push(s);
      return false;
    });

    // MSE players play a blob:, so link each to the manifest of the library instance driving it.
    const mseEls = items.filter(i => i.node && i.type === 'mse-blob');
    const players = items.filter(i => i.media);
    const claimed = new Set();
    for (const el of mseEls) {
      const p = players.find(x => x.media === el.node);
      if (!p) continue;
      el.library = p.library;
      if (p.url) { el.manifest = p.url; claimed.add(p.url); }
      if (el.live === null && typeof p.live === 'boolean') el.live = p.live;
    }
    // Without a captured instance, only guess when it's unambiguous: one unpaired MSE element and
    // one unclaimed live manifest.
    const unpaired = mseEls.filter(i => !i.manifest);
    const liveManifests = items.filter(i => (i.type === 'hls' || i.type === 'dash') && i.live === true && !claimed.has(i.url));
    if (unpaired.length === 1 && liveManifests.length === 1 && unpaired[0].live === null) {
      unpaired[0].live = true;
      unpaired[0].manifest = liveManifests[0].url;
      unpaired[0].manifestGuessed = true;
    }

    if (liveOnly) items = items.filter(i => i.live === true);
    items.sort((a, b) => (b.live === true) - (a.live === true) || (b.playing === true) - (a.playing === true));
    if (record) last = items;

    if (!quiet) {
      console.log(`%c[MediaScraper] ${items.length} media item(s), ${items.filter(i => i.live === true).length} live`,
        'color:#e91e63;font-weight:bold');
      console.table(items.map(i => ({
        live: i.live === true ? 'LIVE' : i.live === false ? 'vod' : '?',
        kind: i.kind,
        type: i.type,
        provider: i.provider || i.library || '',
        url: i.url,
        foundBy: i.foundBy.join(','),
        element: i.element || '',
      })));
    }
    return items;
  }

  // ---------- watch mode ----------

  function watch(callback = item => console.log('[MediaScraper] new stream:', item)) {
    if (watching) return;
    // Keyed by streamKey(), so a playlist polled with changing parameters is reported once.
    const seen = new Set();
    // Players without a URL (srcObject: WebRTC, camera) are tracked by element instead.
    const seenNodes = new WeakSet();
    const isNew = item => (item.url ? !seen.has(streamKey(item.url)) : !!item.node && item.kind !== 'embed' && item.type !== 'none' && !seenNodes.has(item.node));
    // Known HLS variant playlists count as seen, so a master's qualities aren't reported one by one.
    const markSeen = item => {
      if (item.url) seen.add(streamKey(item.url));
      else if (item.node) seenNodes.add(item.node);
      for (const v of item.variants || []) seen.add(streamKey(v.url));
    };
    last.forEach(markSeen);
    // typeHint comes from a response's content type, for manifests whose URL has no extension.
    const report = (url, via, base, typeHint) => {
      const full = abs(url, base);
      if (!full) return;
      const key = streamKey(full);
      if (seen.has(key)) return;
      if (!typeHint && !STREAM_EXT_RE.test(full) && !(via === 'websocket' && MEDIA_WS_RE.test(full))) return;
      seen.add(key);
      if (typeHint) rememberNetwork(key, typeHint); // so later scan() calls include it too
      const item = { kind: 'stream', source: via, url: key, type: typeHint || typeOf(key), live: null, foundBy: [via] };
      probe(item).finally(() => { markSeen(item); callback(item); });
    };

    const restores = [];
    const hookedWindows = new WeakSet();
    const observedRoots = new WeakSet();
    const iframesWithListener = new WeakSet();

    // Hook fetch/XHR/WebSocket/resource timing in one window (the page or a same-origin iframe).
    function hookWindow(win) {
      if (hookedWindows.has(win)) return;
      hookedWindows.add(win);
      const base = () => { try { return win.location.href; } catch { return undefined; } };
      try {
        const origFetch = win.fetch;
        win.fetch = function (input, init) {
          // input may be a string, a URL object, or a Request.
          try { report(input && typeof input === 'object' && 'url' in input ? input.url : String(input), 'fetch', base()); } catch {}
          const p = origFetch.apply(this, arguments);
          // Check the response type too, for manifests served from URLs without an extension.
          // Only headers are read, so the page's own use of the body is unaffected.
          p.then(res => {
            try { const t = manifestType(res.headers.get('content-type')); if (t) report(res.url, 'fetch', base(), t); } catch {}
          }, () => {});
          return p;
        };
        restores.push(() => { win.fetch = origFetch; });
      } catch {}
      try {
        const proto = win.XMLHttpRequest.prototype;
        const origOpen = proto.open;
        const listening = new WeakSet();
        const onHeaders = function () {
          if (this.readyState !== 2) return; // HEADERS_RECEIVED
          try { const t = manifestType(this.getResponseHeader('content-type')); if (t) report(this.responseURL, 'xhr', base(), t); } catch {}
        };
        proto.open = function (method, url) {
          try { report(String(url), 'xhr', base()); } catch {}
          if (!listening.has(this)) { listening.add(this); this.addEventListener('readystatechange', onHeaders); }
          return origOpen.apply(this, arguments);
        };
        restores.push(() => { proto.open = origOpen; });
      } catch {}
      try {
        const origWS = win.WebSocket;
        // A Proxy keeps WebSocket.OPEN etc., the prototype and instanceof working for the page.
        const proxy = new Proxy(origWS, {
          construct(target, args, newTarget) {
            try { report(String(args[0]), 'websocket', base()); } catch {}
            return Reflect.construct(target, args, newTarget === proxy ? target : newTarget);
          },
        });
        win.WebSocket = proxy;
        restores.push(() => { win.WebSocket = origWS; });
      } catch {}
      try {
        const po = new win.PerformanceObserver(list => list.getEntries().forEach(e => report(e.name, 'network')));
        po.observe({ type: 'resource', buffered: false });
        restores.push(() => po.disconnect());
      } catch {}
    }

    // Throttle, not debounce: pages with live chat change constantly, so a debounce never fires.
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      setTimeout(async () => {
        pending = false;
        if (!watching) return;
        attachAll();
        for (const item of await scan({ quiet: true, probe: false, record: false, quick: true })) {
          if (isNew(item)) { markSeen(item); callback(item); }
        }
      }, 500);
    };
    const mo = new MutationObserver(schedule);
    restores.push(() => mo.disconnect());

    // Extend coverage to shadow roots and same-origin iframes that exist now; called again on every
    // rescan so ones added later are picked up too.
    function attachAll() {
      for (const r of roots()) {
        if (!observedRoots.has(r)) {
          observedRoots.add(r);
          mo.observe(r, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
          // Setting video.srcObject (WebRTC) changes no attribute, but every new source fires
          // loadstart. Media events don't bubble or cross shadow roots, so capture on each root.
          r.addEventListener('loadstart', schedule, true);
          restores.push(() => r.removeEventListener('loadstart', schedule, true));
        }
        if (r.defaultView) { hookWindow(r.defaultView); hookLibraries(r.defaultView); }
        // An iframe's document is replaced when it loads, so rescan (and re-hook) on load.
        for (const f of r.querySelectorAll('iframe, frame')) {
          if (iframesWithListener.has(f)) continue;
          iframesWithListener.add(f);
          f.addEventListener('load', schedule);
          restores.push(() => f.removeEventListener('load', schedule));
        }
      }
    }

    watching = { restores };
    attachAll();
    console.log('[MediaScraper] watching for new streams... call MediaScraper.unwatch() to stop');
  }

  function unwatch() {
    if (!watching) return;
    for (const restore of watching.restores.reverse()) { try { restore(); } catch {} }
    watching = null;
  }

  function copy(items = last) {
    const json = JSON.stringify(toJSON(items), null, 2);
    if (typeof global.copy === 'function') global.copy(json); // DevTools helper
    else navigator.clipboard.writeText(json).catch(() => console.log(json));
    return json;
  }

  // Strip DOM nodes so results survive page.evaluate() serialization, and keep an infinite
  // duration (the clearest live signal) instead of letting JSON turn it into null.
  function toJSON(items = last) {
    return items.map(({ node, media, ...rest }) => (
      rest.duration === Infinity ? { ...rest, duration: 'Infinity' } : rest
    ));
  }

  // Start capturing as soon as the script loads, so instances and requests made before the first
  // scan() are seen.
  hookLibraries(global);
  if (global.document && global.document.readyState === 'loading') trapLibraries(global);
  observeNetwork(global);

  global.MediaScraper = { scan, watch, unwatch, copy, toJSON, get results() { return last; } };
})(typeof window !== 'undefined' ? window : globalThis);
