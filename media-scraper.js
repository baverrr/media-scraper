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
 *     live detection via duration === Infinity / growing seekable range
 *   - HLS (.m3u8), DASH (.mpd), FLV, RTMP/RTSP/WebRTC-ish URLs from network resource
 *     timings, <source> tags, attributes, inline scripts and JSON blobs
 *   - Embedded third-party players (YouTube, Twitch, Kick, Vimeo, Facebook, etc.)
 *   - Player library instances (video.js, JW Player, hls.js, dash.js, Shaka, Clappr, Plyr, Flowplayer)
 *
 * Limitations: cross-origin iframes can't be inspected (only their src is reported), closed
 * shadow roots are invisible, and manifest probing is subject to CORS.
 */
(function (global) {
  'use strict';

  const STREAM_RE = /(?:https?:)?\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd|flv|f4m|ism\/manifest)(?:\?[^\s"'<>\\]*)?|(?:rtmps?|rtsp|srt|wss?):\/\/[^\s"'<>\\]+/gi;
  const STREAM_EXT_RE = /\.(m3u8|mpd|flv|f4m)(\?|#|$)|\/manifest(\(|\?|$)|^(rtmps?|rtsp|srt):/i;
  // WebSockets that look like media (FLV/TS/MP4 over ws, /live/ or /stream/ paths), not chat or analytics.
  const MEDIA_WS_RE = /^wss?:\/\/[^?#]*(?:\.(?:flv|ts|mp4|m4s|h264|mjpe?g)(?:[?#]|$)|\/(?:live|stream|streams|media|video|play)(?:[/?#]|$))/i;
  const HLS_RE = /^\uFEFF?\s*#EXTM3U/;
  const MPD_RE = /<MPD[\s>]/i;

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

  // ---------- helpers ----------

  function abs(url, base) {
    try { return new URL(url, base || location.href).href; } catch { return null; }
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
      out.push({
        kind: el.tagName.toLowerCase(),
        source: 'element',
        url: sources[0] || null,
        alternates: sources.slice(1),
        type: sources[0] ? typeOf(sources[0]) : 'none',
        live: live ? true : (!mse && el.duration > 0 && Number.isFinite(el.duration) ? false : null),
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
    const out = [];
    const entries = [];
    for (const r of roots()) {
      const win = r.defaultView;
      try { if (win && win.performance) entries.push(...win.performance.getEntriesByType('resource')); } catch {}
    }
    for (const e of entries) {
      if (STREAM_EXT_RE.test(e.name)) {
        out.push({ kind: 'stream', source: 'network', url: e.name, type: typeOf(e.name), live: null });
      }
    }
    return out;
  }

  function collectFromMarkup() {
    const out = [];
    const texts = [];
    for (const r of roots()) {
      for (const s of r.querySelectorAll('script:not([src]), script[type="application/json"], script[type="application/ld+json"]')) {
        texts.push(s.textContent);
      }
      for (const el of r.querySelectorAll('*')) {
        for (const a of el.attributes) {
          if (a.value.length > 8 && /m3u8|mpd|rtmp|\.flv|manifest/i.test(a.value)) texts.push(a.value);
        }
      }
    }
    for (const t of texts) {
      // Undo JSON/JS escaping (\/, \u0026, ...) so query strings like stream tokens stay intact.
      const unescaped = t.replace(/\\\//g, '/')
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&amp;/g, '&');
      for (const m of unescaped.matchAll(STREAM_RE)) {
        const url = abs(m[0].startsWith('//') ? location.protocol + m[0] : m[0]);
        if (url) out.push({ kind: 'stream', source: 'markup', url, type: typeOf(url), live: null });
      }
    }
    return out;
  }

  function collectLibraries() {
    const out = [];
    const w = global;
    const push = (lib, url, extra = {}) =>
      out.push({ kind: 'player', source: 'library', library: lib, url: url || null, type: url ? typeOf(url) : 'unknown', live: null, ...extra });

    try {
      if (w.videojs && w.videojs.getPlayers) {
        for (const p of Object.values(w.videojs.getPlayers())) {
          if (!p) continue;
          const live = p.liveTracker ? p.liveTracker.isLive() : p.duration() === Infinity;
          push('video.js', p.currentSrc(), { live, element: describe(p.el && p.el()) });
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
          });
        }
      }
    } catch {}

    try {
      for (const p of (w.Plyr && w.Plyr.instances) || []) push('Plyr', p.source, { element: describe(p.elements && p.elements.container) });
    } catch {}

    try {
      if (w.flowplayer && w.flowplayer.instances) {
        for (const p of w.flowplayer.instances) push('Flowplayer', p.video && p.video.src, { live: !!(p.live || (p.video && p.video.live)) });
      }
    } catch {}

    // hls.js / dash.js / Shaka / Clappr instances usually aren't registered globally; scan window
    // properties and media-element expandos for objects that look like them.
    const looksHls = o => o && typeof o === 'object' && typeof o.loadSource === 'function' && 'url' in o;
    const looksDash = o => o && typeof o === 'object' && typeof o.getSource === 'function' && typeof o.isDynamic === 'function';
    const looksShaka = o => o && typeof o === 'object' && typeof o.getAssetUri === 'function' && typeof o.isLive === 'function';
    const looksClappr = o => o && typeof o === 'object' && o.options && typeof o.getPlugin === 'function' && 'core' in o;
    const candidates = new Set();
    try { for (const k of Object.keys(w)) { try { candidates.add(w[k]); } catch {} } } catch {}
    for (const v of queryAll('video, audio')) {
      for (const k of Object.keys(v)) { try { candidates.add(v[k]); } catch {} }
    }
    for (const o of candidates) {
      try {
        if (looksHls(o)) push('hls.js', o.url, { live: o.levels && o.levels[o.currentLevel] && o.levels[o.currentLevel].details ? o.levels[o.currentLevel].details.live : null });
        else if (looksDash(o)) push('dash.js', o.getSource && String(o.getSource()), { live: o.isDynamic() });
        else if (looksShaka(o)) push('Shaka', o.getAssetUri(), { live: o.isLive() });
        else if (looksClappr(o)) push('Clappr', o.options.source, {});
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
      const key = it.url ? it.url.replace(/#.*$/, '') : it.source + ':' + (it.element || Math.random());
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
    const { probe: doProbe = true, liveOnly = false, quiet = false, record = true } = opts;
    let items = dedupe([
      ...collectMediaElements(),
      ...collectLibraries(),
      ...collectEmbeds(),
      ...collectNetwork(),
      ...collectFromMarkup(),
    ]);

    if (doProbe) await Promise.all(items.filter(i => i.live === null).map(i => probe(i)));

    // An MSE blob element plus a probed manifest is the common live setup: carry live status over.
    const liveManifest = items.find(i => (i.type === 'hls' || i.type === 'dash') && i.live === true);
    for (const i of items) {
      if (i.type === 'mse-blob' && i.live === null && liveManifest) {
        i.live = true;
        i.manifest = liveManifest.url;
      }
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
    const seen = new Set(last.map(i => i.url));
    const report = (url, via) => {
      const full = abs(url);
      if (!full || seen.has(full)) return;
      if (!STREAM_EXT_RE.test(full) && !(via === 'websocket' && MEDIA_WS_RE.test(full))) return;
      seen.add(full);
      const item = { kind: 'stream', source: via, url: full, type: typeOf(full), live: null, foundBy: [via] };
      probe(item).finally(() => callback(item));
    };

    const origFetch = global.fetch;
    const origOpen = XMLHttpRequest.prototype.open;
    const origWS = global.WebSocket;
    global.fetch = function (input, init) {
      // input may be a string, a URL object, or a Request.
      try { report(input && typeof input === 'object' && 'url' in input ? input.url : String(input), 'fetch'); } catch {}
      return origFetch.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open = function (method, url) {
      try { report(String(url), 'xhr'); } catch {}
      return origOpen.apply(this, arguments);
    };
    // A Proxy keeps WebSocket.OPEN etc., the prototype and instanceof working for the page.
    global.WebSocket = new Proxy(origWS, {
      construct(target, args, newTarget) {
        try { report(String(args[0]), 'websocket'); } catch {}
        return Reflect.construct(target, args, newTarget === global.WebSocket ? target : newTarget);
      },
    });

    const po = new PerformanceObserver(list => list.getEntries().forEach(e => report(e.name, 'network')));
    po.observe({ type: 'resource', buffered: false });

    // Throttle, not debounce: pages with live chat change constantly, so a debounce never fires.
    let pending = false;
    const mo = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(async () => {
        pending = false;
        if (!watching) return;
        for (const item of await scan({ quiet: true, probe: false, record: false })) {
          if (item.url && !seen.has(item.url)) { seen.add(item.url); callback(item); }
        }
      }, 500);
    });
    mo.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

    watching = { origFetch, origOpen, origWS, po, mo };
    console.log('[MediaScraper] watching for new streams... call MediaScraper.unwatch() to stop');
  }

  function unwatch() {
    if (!watching) return;
    global.fetch = watching.origFetch;
    XMLHttpRequest.prototype.open = watching.origOpen;
    global.WebSocket = watching.origWS;
    watching.po.disconnect();
    watching.mo.disconnect();
    watching = null;
  }

  function copy(items = last) {
    const json = JSON.stringify(items.map(({ node, ...rest }) => rest), null, 2);
    if (typeof global.copy === 'function') global.copy(json); // DevTools helper
    else navigator.clipboard.writeText(json).catch(() => console.log(json));
    return json;
  }

  // Strip DOM nodes so results survive page.evaluate() serialization.
  function toJSON(items = last) {
    return items.map(({ node, ...rest }) => rest);
  }

  global.MediaScraper = { scan, watch, unwatch, copy, toJSON, get results() { return last; } };
})(typeof window !== 'undefined' ? window : globalThis);
