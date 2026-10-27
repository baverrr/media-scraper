// End-to-end through the HTTP app: a fake "CDN" server serves a live master playlist whose
// signed URLs expire, and a fake resolver stands in for the browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, ResolutionCache, semaphore, slatePlaylist, SLATE_SECONDS } from '../src/app.js';
import { StationStore } from '../src/stations.js';

let cdn, sidecar, cdnUrl, sideUrl, dataDir, app;
let token = 'good';
let resolveCount = 0;
const seenHeaders = [];

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

before(async () => {
  cdn = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seenHeaders.push(req.headers);
    if (req.headers.referer !== 'https://station.example/live') { res.writeHead(403); return res.end(); }
    if (u.searchParams.get('t') !== token) { res.writeHead(403); return res.end('expired'); }
    if (u.pathname === '/master.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\nlow.m3u8?t=${token}\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1280x720\nhigh.m3u8?t=${token}\n`);
    }
    if (u.pathname === '/high.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg-${token}-1.ts?t=${token}\n`);
    }
    if (u.pathname.startsWith('/seg-')) {
      const r = (req.headers.range || '').match(/^bytes=(\d+)-(\d+)$/);
      if (r) {
        res.writeHead(206, { 'content-type': 'video/mp2t', 'content-range': `bytes ${r[1]}-${r[2]}/6`, 'accept-ranges': 'bytes' });
        return res.end('TSDATA'.slice(Number(r[1]), Number(r[2]) + 1));
      }
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return res.end('TSDATA');
    }
    res.writeHead(404); res.end();
  });
  cdnUrl = await listen(cdn);

  dataDir = await mkdtemp(path.join(tmpdir(), 'lb-test-'));
  const marketsDir = path.join(dataDir, 'markets');
  await mkdir(marketsDir);
  await writeFile(path.join(marketsDir, 'test.json'), JSON.stringify({
    name: 'Test Market',
    teams: [],
    stations: [
      { id: 'test', callSign: 'KTST', name: 'Test 9', channel: '9.1', url: 'https://station.example/live' },
      { id: 'off', name: 'Off', url: 'https://station.example/off', enabled: false },
    ],
  }));
  const store = new StationStore({ dataDir: path.join(dataDir, 'data'), marketsDir, market: 'test' });
  await store.load();
  const resolver = {
    async resolve(station) {
      resolveCount++;
      if (station.id !== 'test') throw Object.assign(new Error('No live stream found on the page'), { details: { candidates: [] } });
      return { url: `${cdnUrl}/master.m3u8?t=${token}`, type: 'hls', headers: { referer: 'https://station.example/live' }, via: 'page', tookMs: 5 };
    },
  };
  app = createApp({ store, resolver, config: { apiKey: 'secret', maxHeight: 1080 }, log: {} });
  sidecar = http.createServer(app.handler);
  sideUrl = await listen(sidecar);
});

after(async () => {
  cdn.close();
  sidecar.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('playlist and guide list enabled stations only', async () => {
  const m3u = await (await fetch(`${sideUrl}/playlist.m3u`)).text();
  assert.match(m3u, new RegExp(`${sideUrl}/stream/test\\.m3u8`));
  assert.doesNotMatch(m3u, /stream\/off/);
  const xml = await (await fetch(`${sideUrl}/guide.xml?hours=2`)).text();
  assert.match(xml, /<channel id="test">/);
});

test('stream: master reduced to one variant behind stable URLs, segments proxied with headers', async () => {
  const master = await (await fetch(`${sideUrl}/stream/test.m3u8`)).text();
  assert.match(master, /RESOLUTION=1280x720/);
  assert.doesNotMatch(master, /640x360/);
  assert.match(master, /^\.\.\/hls\/test\/v\.m3u8$/m);

  const media = await (await fetch(`${sideUrl}/hls/test/v.m3u8`)).text();
  const seg = media.split('\n').find(l => l.startsWith('s/'));
  assert.ok(seg, media);
  const segRes = await fetch(`${sideUrl}/hls/test/${seg}`);
  assert.equal(segRes.status, 200);
  assert.equal(await segRes.text(), 'TSDATA');
  assert.ok(seenHeaders.every(h => h.referer === 'https://station.example/live'));
});

test('expired token: the variant URL stays the same and the stream is re-resolved', async () => {
  const before = resolveCount;
  token = 'rotated'; // old signed URLs now get 403
  const media = await (await fetch(`${sideUrl}/hls/test/v.m3u8`)).text();
  assert.match(Buffer.from(media.match(/(?:^|\/)s\/[^/]+\/([^.]+)\./m)[1], 'base64url').toString(), /seg-rotated-1\.ts/);
  assert.equal(resolveCount, before + 1);
});

test('segment signatures are required', async () => {
  const res = await fetch(`${sideUrl}/hls/test/s/forged/${Buffer.from('http://169.254.169.254/').toString('base64url')}.ts`);
  assert.equal(res.status, 403);
});

test('station changes need the API key and invalidate cached resolutions', async () => {
  const body = JSON.stringify([{ id: 'test', name: 'Renamed', url: 'https://station.example/live' }]);
  assert.equal((await fetch(`${sideUrl}/api/stations`, { method: 'PUT', body })).status, 401);
  const ok = await fetch(`${sideUrl}/api/stations`, { method: 'PUT', body, headers: { 'x-api-key': 'secret' } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json())[0].name, 'Renamed');
  assert.equal(app.cache.status('test').state, 'idle');
  const bad = await fetch(`${sideUrl}/api/stations`, { method: 'PUT', body: '[{"id":"x"}]', headers: { 'x-api-key': 'secret' } });
  assert.equal(bad.status, 400);
});

test('test endpoint reports failures with details instead of erroring', async () => {
  await fetch(`${sideUrl}/api/stations`, {
    method: 'PUT',
    headers: { 'x-api-key': 'secret' },
    body: JSON.stringify([{ id: 'test', url: 'https://station.example/live' }, { id: 'dead', url: 'https://station.example/dead' }]),
  });
  const r = await (await fetch(`${sideUrl}/api/stations/dead/test`, { method: 'POST', headers: { 'x-api-key': 'secret' } })).json();
  assert.equal(r.ok, false);
  assert.match(r.error, /No live stream/);
  // Tuning in plays the slate; the status still says why.
  assert.match(await (await fetch(`${sideUrl}/stream/dead.m3u8`)).text(), /\.\.\/slate\/\d+\.ts/);
  const status = await (await fetch(`${sideUrl}/api/status`)).json();
  assert.match(status.find(x => x.id === 'dead').error, /No live stream/);
});

test('resolution cache: shares in-flight work, honours token expiry, remembers failures', async () => {
  let now = 1_000_000;
  let calls = 0;
  const cache = new ResolutionCache({
    now: () => now,
    ttlMs: 30 * 60_000,
    failureMs: 60_000,
    resolve: async s => { calls++; if (s.id === 'bad') throw new Error('nope'); return { url: 'u', expiresAt: now + 10 * 60_000 }; },
  });
  const st = { id: 'a' };
  await Promise.all([cache.get(st), cache.get(st), cache.get(st)]);
  assert.equal(calls, 1);
  now += 7 * 60_000; // before expiry minus the 2 min margin
  await cache.get(st);
  assert.equal(calls, 1);
  now += 2 * 60_000; // inside the margin
  await cache.get(st);
  assert.equal(calls, 2);
  await assert.rejects(cache.get({ id: 'bad' }));
  await assert.rejects(cache.get({ id: 'bad' }));
  assert.equal(calls, 3);
});

test('priority semaphore runs local-sports work first', async () => {
  const limit = semaphore(1);
  const order = [];
  let release;
  const blocker = limit(() => new Promise(r => { release = r; }));
  const jobs = [
    limit(async () => order.push('news-1'), 1),
    limit(async () => order.push('news-2'), 1),
    limit(async () => order.push('game'), 0),
  ];
  release();
  await Promise.all([blocker, ...jobs]);
  assert.deepEqual(order, ['game', 'news-1', 'news-2']);
});

test('segment proxy passes Range through for byte-range playlists', async () => {
  const media = await (await fetch(`${sideUrl}/hls/test/v.m3u8`)).text();
  const seg = media.split('\n').find(l => l.startsWith('s/'));
  const res = await fetch(`${sideUrl}/hls/test/${seg}`, { headers: { range: 'bytes=0-1' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 0-1/6');
  assert.equal(await res.text(), 'TS');
});

test('defaults endpoint returns the bundled market', async () => {
  const res = await fetch(`${sideUrl}/api/stations/defaults`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.market, 'test');
  assert.deepEqual(body.stations.map(s => s.id), ['test', 'off']);
});

test('cache: a resolution invalidated mid-flight is not stored', async () => {
  let finish;
  const cache = new ResolutionCache({ resolve: () => new Promise(r => { finish = r; }) });
  const p = cache.get({ id: 'a' });
  await new Promise(r => setImmediate(r));
  cache.invalidate('a'); // the station was edited while its old page was resolving
  finish({ url: 'https://old.example/a.m3u8', type: 'hls' });
  await p;
  assert.equal(cache.peek('a'), null);
  assert.equal(cache.status('a').state, 'idle');
});

test('cache: the previous resolution stays usable while a refresh runs', async () => {
  let n = 0;
  const finishers = [];
  const cache = new ResolutionCache({ resolve: () => new Promise(r => { n++; finishers.push(r); }) });
  const first = cache.get({ id: 'a' });
  await new Promise(r => setImmediate(r));
  finishers[0]({ url: 'https://cdn.example/1.m3u8', type: 'hls' });
  await first;
  const refresh = cache.get({ id: 'a' }, { force: true });
  await new Promise(r => setImmediate(r));
  assert.equal(cache.peek('a')?.url, 'https://cdn.example/1.m3u8');
  finishers[1]({ url: 'https://cdn.example/2.m3u8', type: 'hls' });
  await refresh;
  assert.equal(cache.peek('a')?.url, 'https://cdn.example/2.m3u8');
  assert.equal(n, 2);
});

test('playlist links are relative, so a path prefix in front of the sidecar keeps working', async () => {
  // Resolve each link against the URL a client behind a /tv prefix would have used.
  const base = 'https://proxy.example/tv/stream/test.m3u8';
  const master = await (await fetch(`${sideUrl}/stream/test.m3u8`)).text();
  const variant = new URL(master.split('\n').find(l => l && !l.startsWith('#')), base);
  assert.equal(variant.href, 'https://proxy.example/tv/hls/test/v.m3u8');
  const media = await (await fetch(`${sideUrl}/hls/test/v.m3u8`)).text();
  const seg = new URL(media.split('\n').find(l => l && !l.startsWith('#')), variant);
  assert.match(seg.pathname, /^\/tv\/hls\/test\/s\/[\w-]+\/[\w-]+\.ts$/);
  // The same segment path, without the prefix, is what the sidecar serves.
  assert.equal((await fetch(sideUrl + seg.pathname.slice(3))).status, 200);
});

test('cache: a due refresh runs in the background while the previous stream keeps playing', async () => {
  let t = 0;
  const finishers = [];
  const cache = new ResolutionCache({ ttlMs: 60_000, now: () => t, resolve: () => new Promise(r => finishers.push(r)) });
  const first = cache.get({ id: 'a' });
  await new Promise(r => setImmediate(r));
  finishers[0]({ url: 'https://cdn.example/1.m3u8', type: 'hls' });
  await first;
  t = 61_000; // past the TTL: due for a refresh
  assert.equal((await cache.get({ id: 'a' })).url, 'https://cdn.example/1.m3u8'); // answered without waiting
  await new Promise(r => setImmediate(r));
  assert.equal(finishers.length, 2);
  assert.equal((await cache.get({ id: 'a' })).url, 'https://cdn.example/1.m3u8'); // still, while it runs
  finishers[1]({ url: 'https://cdn.example/2.m3u8', type: 'hls' });
  await new Promise(r => setImmediate(r));
  assert.equal((await cache.get({ id: 'a' })).url, 'https://cdn.example/2.m3u8');
});

test('cache: a failed background refresh keeps the playable stream, a forced one waits', async () => {
  let t = 0;
  let fail = false;
  const cache = new ResolutionCache({ ttlMs: 60_000, now: () => t, resolve: async () => {
    if (fail) throw new Error('page changed');
    return { url: 'https://cdn.example/1.m3u8', type: 'hls', expiresAt: 10 * 60_000 };
  } });
  await cache.get({ id: 'a' });
  t = 61_000;
  fail = true;
  assert.equal((await cache.get({ id: 'a' })).url, 'https://cdn.example/1.m3u8');
  await new Promise(r => setImmediate(r));
  assert.equal(cache.peek('a')?.url, 'https://cdn.example/1.m3u8');
  assert.equal(cache.status('a').refreshError, 'page changed');
  await assert.rejects(cache.get({ id: 'a' }, { force: true }), /page changed/);
  t = 10 * 60_000; // the token expired: nothing playable is left
  assert.equal(cache.peek('a'), null);
});

test('cache: an expiry already past when resolved is ignored (the URL just worked)', async () => {
  let t = Date.UTC(2026, 9, 26);
  let n = 0;
  const cache = new ResolutionCache({ ttlMs: 30 * 60_000, now: () => t, resolve: async () => { n++; return { url: 'https://cdn/x.m3u8?e=1700000000', type: 'hls', expiresAt: 1_700_000_000_000 }; } });
  await cache.get({ id: 'a' });
  t += 5 * 60_000;
  await cache.get({ id: 'a' });
  assert.equal(n, 1); // not re-resolved every 30 s
  assert.equal(cache.peek('a')?.url, 'https://cdn/x.m3u8?e=1700000000');
});

test('cache: after a failed forced re-resolve, the rejected stream is not served again', async () => {
  let t = 0;
  let fail = false;
  let n = 0;
  const cache = new ResolutionCache({ ttlMs: 60_000, failureMs: 60_000, now: () => t, resolve: async () => {
    n++;
    if (fail) throw new Error('page changed');
    return { url: 'https://cdn.example/1.m3u8', type: 'hls' };
  } });
  await cache.get({ id: 'a' });
  fail = true; // upstream now answers 403, and the page no longer resolves
  await assert.rejects(cache.get({ id: 'a' }, { force: true }), /page changed/);
  // The player's next polls get the remembered failure, without a new resolve each time.
  for (let i = 0; i < 3; i++) await assert.rejects(cache.get({ id: 'a' }), /page changed/);
  assert.equal(n, 2);
  assert.equal(cache.peek('a'), null);
  assert.equal(cache.status('a').state, 'failed');
});

test('cache: a failed Test (keepOnFailure) leaves a playing stream alone', async () => {
  let fail = false;
  const cache = new ResolutionCache({ resolve: async () => {
    if (fail) throw new Error('bot check');
    return { url: 'https://cdn.example/1.m3u8', type: 'hls' };
  } });
  await cache.get({ id: 'a' });
  fail = true;
  await assert.rejects(cache.get({ id: 'a' }, { force: true, keepOnFailure: true }), /bot check/);
  assert.equal(cache.peek('a')?.url, 'https://cdn.example/1.m3u8');
  assert.equal((await cache.get({ id: 'a' })).url, 'https://cdn.example/1.m3u8');
});

test('a station with nothing to play gets the looping slate, an upstream failure still errors', async () => {
  const marketsDir = path.join(dataDir, 'markets');
  const store = new StationStore({ dataDir: path.join(dataDir, 'slate-data'), marketsDir, market: 'test' });
  await store.load();
  let mode = 'empty';
  const resolver = {
    async resolve() {
      if (mode === 'empty') throw Object.assign(new Error('No live stream found on the page'), { details: { candidates: [] } });
      return { url: `${cdnUrl}/master.m3u8?t=wrong`, type: 'hls', headers: { referer: 'https://station.example/live' }, via: 'page' };
    },
  };
  const t = 1_800_000_000_000;
  const local = createApp({ store, resolver, config: { failureSeconds: 0 }, log: {}, now: () => t });
  const server = http.createServer(local.handler);
  const url = await listen(server);
  try {
    let res = await fetch(`${url}/stream/test.m3u8`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, slatePlaylist(t, n => `../slate/${n}.ts`));
    const seq = Math.floor(t / (SLATE_SECONDS * 1000));
    assert.match(text, new RegExp(`#EXT-X-MEDIA-SEQUENCE:${seq}\\n`));
    assert.equal(text.match(/#EXT-X-DISCONTINUITY\n/g).length, 3);
    // The relative segment URL resolves to the slate clip.
    res = await fetch(new URL(`../slate/${seq}.ts`, `${url}/stream/test.m3u8`));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'video/mp2t');
    assert.ok((await res.arrayBuffer()).byteLength > 10_000);
    // A stream that was found but that upstream refuses is an error, not the slate.
    mode = 'found';
    local.cache.invalidate();
    res = await fetch(`${url}/stream/test.m3u8`);
    assert.equal(res.status, 502);
  } finally {
    server.close();
  }
});

test('slate playlist moves on with the clock', () => {
  const a = slatePlaylist(0, n => `${n}.ts`);
  const b = slatePlaylist(SLATE_SECONDS * 1000, n => `${n}.ts`);
  assert.match(a, /#EXT-X-MEDIA-SEQUENCE:0\n/);
  assert.match(b, /#EXT-X-MEDIA-SEQUENCE:1\n/);
  assert.deepEqual(b.match(/^\d+\.ts$/gm), ['1.ts', '2.ts', '3.ts']);
  assert.doesNotMatch(a, /ENDLIST/);
});
