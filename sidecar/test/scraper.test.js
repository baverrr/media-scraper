// media-scraper.js in a real browser, against pages served locally. Skipped when no browser is
// installed (npx playwright install chromium); the sidecar image has one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const scraperPath = [path.join(here, '..', 'media-scraper.js'), path.join(here, '..', '..', 'media-scraper.js')].find(p => existsSync(p));
const scraper = readFileSync(scraperPath, 'utf8');

const MEDIA = 'video/mp2t';
const live = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:6,\nseg100.ts\n';
const vod = live + '#EXT-X-ENDLIST\n';
// A comment and a blank line between the tag and its URI are allowed.
const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n## low\n\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nhigh/index.m3u8\n';

const html = body => `<!doctype html><meta charset="utf-8"><body>${body}</body>`;
const routes = {
  '/live.m3u8': ['application/vnd.apple.mpegurl', live],
  '/vod.m3u8': ['application/vnd.apple.mpegurl', vod],
  '/moved/master.m3u8': ['application/vnd.apple.mpegurl', master],
  '/moved/low/index.m3u8': ['application/vnd.apple.mpegurl', live],
  '/moved/high/index.m3u8': ['application/vnd.apple.mpegurl', live],
  '/api/stream/7': ['application/vnd.apple.mpegurl', live],
  '/manifest': ['application/manifest+json', '{"name":"app"}'],
  '/seg100.ts': [MEDIA, ''],
  '/blank': ['text/html', html('')],
  '/frame-a': ['text/html', html('<script>fetch("/a.m3u8")</script>')],
  '/frame-b': ['text/html', html('<script>fetch("/b.m3u8")</script>')],
  '/a.m3u8': ['application/vnd.apple.mpegurl', live],
  // First variant gone: the master's probe can't tell, its live variant can.
  '/fold/master.m3u8': ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\ngone.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nhigh.m3u8\n'],
  '/fold/high.m3u8': ['application/vnd.apple.mpegurl', live],
  '/w/master.m3u8': ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nhigh.m3u8\n'],
  '/w/low.m3u8': ['application/vnd.apple.mpegurl', live],
  '/w/high.m3u8': ['application/vnd.apple.mpegurl', live],
  '/b.m3u8': ['application/vnd.apple.mpegurl', live],
};

let server, origin, browser;

before(async () => {
  try { browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined }); }
  catch { browser = null; return; }
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/master.m3u8') { res.writeHead(302, { location: '/moved/master.m3u8' }); return res.end(); }
    const route = routes[url.pathname];
    if (!route) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': route[0], 'access-control-allow-origin': '*' });
    res.end(route[1]);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await browser?.close();
  server?.close();
});

// Opens `body` as a page (served from the test origin), with the scraper loaded early unless
// early is false.
async function open(t, body, { early = true } = {}) {
  if (!browser) { t.skip('no browser installed'); return null; }
  const page = await browser.newPage();
  t.after(() => page.close());
  if (early) await page.addInitScript({ content: scraper });
  await page.route(`${origin}/page`, route => route.fulfill({ contentType: 'text/html', body: html(body) }));
  await page.goto(`${origin}/page`, { waitUntil: 'domcontentloaded' });
  return page;
}

const scan = (page, opts = {}) => page.evaluate(o => MediaScraper.scan({ quiet: true, ...o }).then(MediaScraper.toJSON), opts);

test('two URL-less players stay two items', async t => {
  const page = await open(t, `<canvas id=c></canvas><video id=a></video><video id=b></video><video></video><video></video>
    <script>
      const s = document.getElementById('c').captureStream();
      a.srcObject = s; b.srcObject = s.clone();
    </script>`);
  if (!page) return;
  const items = await scan(page, { probe: false });
  assert.equal(items.filter(i => i.type === 'mediastream').length, 2);
  assert.equal(items.filter(i => i.type === 'none').length, 2);
});

test('finds media in closed shadow roots when loaded early', async t => {
  const page = await open(t, `<div id=host></div>
    <script>host.attachShadow({ mode: 'closed' }).innerHTML = '<video src="/vod.m3u8"></video>';</script>`);
  if (!page) return;
  const items = await scan(page, { probe: false });
  assert.ok(items.some(i => i.kind === 'video' && i.url === `${origin}/vod.m3u8`), JSON.stringify(items));
  // The hook keeps looking native.
  assert.match(await page.evaluate(() => String(Element.prototype.attachShadow)), /\[native code\]/);
});

test('lazy-loaded embeds are read from data-src', async t => {
  const page = await open(t, `<iframe src="about:blank" data-src="https://www.youtube.com/embed/live_stream?channel=UC123"></iframe>`);
  if (!page) return;
  const [embed] = (await scan(page, { probe: false })).filter(i => i.kind === 'embed');
  assert.equal(embed?.provider, 'YouTube');
  assert.equal(embed.id, 'UC123');
  assert.equal(embed.live, true);
});

test('probes masters after redirects, skipping comments before the URI', async t => {
  const page = await open(t, `<script>fetch('/master.m3u8'); fetch('/vod.m3u8')</script>`);
  if (!page) return;
  await page.waitForTimeout(300);
  const items = await scan(page);
  const m = items.find(i => i.url === `${origin}/master.m3u8`);
  assert.equal(m.live, true, JSON.stringify(m));
  assert.deepEqual(m.variants.map(v => v.url), [`${origin}/moved/low/index.m3u8`, `${origin}/moved/high/index.m3u8`]);
  assert.equal(items.find(i => i.url === `${origin}/vod.m3u8`).live, false);
});

test('Smooth types: web app manifests are ignored, Azure format= URLs are typed', async t => {
  const page = await open(t, `<link rel=manifest href="/manifest">
    <script>var cfg = { src: "https://cdn.example/v.ism/Manifest(format=m3u8-aapl)", s: "https://cdn.example/v.ism/Manifest" }</script>`);
  if (!page) return;
  await page.waitForTimeout(300);
  const items = await scan(page, { probe: false });
  assert.ok(!items.some(i => i.url === `${origin}/manifest`));
  assert.equal(items.find(i => i.url.endsWith('(format=m3u8-aapl)'))?.type, 'hls');
  assert.equal(items.find(i => i.url.endsWith('.ism/Manifest'))?.type, 'smooth');
});

test('scan() recognises extensionless manifests by content type', async t => {
  const page = await open(t, `<script>fetch('/api/stream/7')</script>`);
  if (!page) return;
  await page.waitForTimeout(300);
  const hasContentType = await page.evaluate(() => 'contentType' in PerformanceResourceTiming.prototype);
  if (!hasContentType) { t.skip('browser has no PerformanceResourceTiming.contentType'); return; }
  const item = (await scan(page)).find(i => i.url === `${origin}/api/stream/7`);
  assert.equal(item?.type, 'hls');
  assert.equal(item.live, true);
});

test('pairs an MSE element with its hls.js instance, even after the script is loaded again', async t => {
  const page = await open(t, `<video id=v></video>
    <script>
      window.Hls = class Hls {
        constructor() { this.url = null; this.media = null; this.levels = []; this.currentLevel = -1; }
        loadSource(u) { this.url = u; }
        attachMedia(m) { this.media = m; m.src = URL.createObjectURL(new MediaSource()); }
        destroy() {}
      };
      const h = new Hls(); h.loadSource(location.origin + '/live.m3u8'); h.attachMedia(v);
    </script>`);
  if (!page) return;
  await page.addScriptTag({ content: scraper }); // a second copy, as when pasted after a userscript
  const v = (await scan(page, { probe: false })).find(i => i.kind === 'video');
  assert.equal(v.type, 'mse-blob');
  assert.equal(v.library, 'hls.js');
  assert.equal(v.manifest, `${origin}/live.m3u8`);
  assert.ok(!v.manifestGuessed);
});

test('guesses the manifest of a lone MSE element without probing', async t => {
  const page = await open(t, `<video id=v></video>
    <script>v.src = URL.createObjectURL(new MediaSource()); fetch('/live.m3u8');</script>`);
  if (!page) return;
  await page.waitForTimeout(300);
  const v = (await scan(page, { probe: false })).find(i => i.kind === 'video');
  assert.equal(v.manifest, `${origin}/live.m3u8`);
  assert.equal(v.manifestGuessed, true);
});

test('watch() keeps reporting from an iframe after it navigates, and unwatch() restores it', async t => {
  const page = await open(t, `<iframe id=f src="/blank"></iframe>`);
  if (!page) return;
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.reported = []; MediaScraper.watch(i => window.reported.push(i.url)); });
  await page.waitForTimeout(700);
  await page.evaluate(() => { f.src = '/frame-a'; });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { f.src = '/frame-b'; });
  await page.waitForTimeout(1200);
  const reported = await page.evaluate(() => window.reported);
  assert.ok(reported.includes(`${origin}/a.m3u8`), JSON.stringify(reported));
  assert.ok(reported.includes(`${origin}/b.m3u8`), JSON.stringify(reported));
  const restored = await page.evaluate(() => {
    MediaScraper.unwatch();
    const w = document.getElementById('f').contentWindow;
    return String(w.fetch).includes('[native code]');
  });
  assert.equal(restored, true);
});

test('watch() reports streams requested before it started', async t => {
  const page = await open(t, `<script>fetch('/live.m3u8')</script>`);
  if (!page) return;
  await page.waitForTimeout(300);
  const reported = await page.evaluate(() => new Promise(resolve => {
    const got = [];
    MediaScraper.watch(i => got.push(i.url));
    setTimeout(() => { MediaScraper.unwatch(); resolve(got); }, 1000);
  }));
  assert.ok(reported.includes(`${origin}/live.m3u8`), JSON.stringify(reported));
});

test('markup: streams passed to a player page are unwrapped; lookalike extensions are not streams', async t => {
  const page = await open(t, `<script>var c = {
    a: "https://player.example/embed?src=https://cdn.example/live/a.m3u8",
    b: "https://player.example/embed?autoplay=1&url=https%3A%2F%2Fcdn.example%2Flive%2Fb.m3u8%3Ftoken%3Dx",
    poster: "https://cdn.example/thumb.m3u8.jpg",
  }</script>`);
  if (!page) return;
  const urls = (await scan(page, { probe: false })).map(i => i.url);
  assert.ok(urls.includes('https://cdn.example/live/a.m3u8'), JSON.stringify(urls));
  assert.ok(urls.includes('https://cdn.example/live/b.m3u8?token=x'), JSON.stringify(urls));
  assert.ok(!urls.some(u => u.startsWith('https://player.example/')), JSON.stringify(urls));
  assert.ok(!urls.some(u => u.includes('thumb')), JSON.stringify(urls));
});

test('markup: a manifest whose query carries a URL is kept; code fragments are not manifests', async t => {
  const page = await open(t, `<script>var c = {
    ssai: "https://cdn.example/live/master.m3u8?token=abc&ref=https%3A%2F%2Fstation.example%2Fwatch-live",
  };
  function isHls(u) { return u.indexOf(".m3u8") > 0; }
  function src(id) { return "https://cdn.example/live/" + id + ".m3u8"; }
  var split = '/l' + 'ive.mpd';
  </script>`);
  if (!page) return;
  const urls = (await scan(page, { probe: false })).map(i => i.url);
  assert.ok(urls.includes('https://cdn.example/live/master.m3u8?token=abc&ref=https%3A%2F%2Fstation.example%2Fwatch-live'), JSON.stringify(urls));
  assert.ok(!urls.some(u => u.includes('station.example/watch-live') && !u.includes('.m3u8')), JSON.stringify(urls));
  assert.ok(!urls.some(u => /\/\.m3u8$|\/ive\.mpd$/.test(u)), JSON.stringify(urls));
});

test('embeds: live only from the path or a channel player, not from a query value', async t => {
  const page = await open(t, `
    <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?origin=https://livestream.station.example"></iframe>
    <iframe src="https://player.twitch.tv/?channel=station&parent=x"></iframe>
    <iframe src="https://livestream.com/accounts/1/events/2/player"></iframe>`);
  if (!page) return;
  const embeds = (await scan(page, { probe: false })).filter(i => i.kind === 'embed');
  assert.equal(embeds.find(e => e.provider === 'YouTube').live, null);
  assert.equal(embeds.find(e => e.provider === 'Twitch').live, true);
  assert.equal(embeds.find(e => e.provider === 'Livestream').live, true);
});

test('fold: a live variant makes its master live when the first variant is gone', async t => {
  const page = await open(t, `<script>fetch('/fold/master.m3u8'); fetch('/fold/high.m3u8')</script>`);
  if (!page) return;
  await page.waitForTimeout(300);
  const items = (await scan(page)).filter(i => i.url.includes('/fold/'));
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.equal(items[0].live, true);
});

test('watch(): a master and the variant the player loads are one report', async t => {
  const page = await open(t, '');
  if (!page) return;
  const reported = await page.evaluate(() => new Promise(resolve => {
    const got = [];
    MediaScraper.watch(i => got.push(i.url.replace(location.origin, '')));
    fetch('/w/master.m3u8').then(() => fetch('/w/high.m3u8'));
    setTimeout(() => { MediaScraper.unwatch(); resolve(got); }, 1500);
  }));
  assert.deepEqual(reported, ['/w/master.m3u8']);
});

test('unwatch(): saved references stop reporting, and page wrappers added later stay', async t => {
  const page = await open(t, '');
  if (!page) return;
  const r = await page.evaluate(async () => {
    const got = [];
    MediaScraper.watch(i => got.push(i.url));
    const saved = window.fetch;
    const pageWrapper = function (...a) { return saved.apply(this, a); };
    window.fetch = pageWrapper; // e.g. an error-reporting library, installed after watch()
    MediaScraper.unwatch();
    await saved('/a.m3u8');
    await new Promise(res => setTimeout(res, 800));
    return { got, kept: window.fetch === pageWrapper };
  });
  assert.deepEqual(r.got, []);
  assert.equal(r.kept, true);
});

test('dash.js used in the same script that defines it is still captured', async t => {
  // Mimics dash.js: assign an empty namespace, fill in the factory, then app code uses it.
  const page = await open(t, `<video id=v></video><script>
    window.dashjs = {};
    dashjs.MediaPlayer = function () {
      return { create() {
        let src = null, el = null;
        return {
          initialize(e, s) { el = e; src = s; e.src = URL.createObjectURL(new MediaSource()); },
          getSource() { return src; }, isDynamic() { return true; }, getVideoElement() { return el; },
        };
      } };
    };
    dashjs.MediaPlayer().create().initialize(v, location.origin + '/live.mpd');
  </script>`);
  if (!page) return;
  const v = (await scan(page, { probe: false })).find(i => i.kind === 'video');
  assert.equal(v.library, 'dash.js');
  assert.equal(v.manifest, `${origin}/live.mpd`);
  assert.ok(!v.manifestGuessed);
});
