// End-to-end through the HTTP app: a fake "CDN" server serves a live master playlist whose
// signed URLs expire, and a fake resolver stands in for the browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, ResolutionCache, semaphore } from '../src/app.js';
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
  assert.match(master, /^\/hls\/test\/v\.m3u8$/m);

  const media = await (await fetch(`${sideUrl}/hls/test/v.m3u8`)).text();
  const seg = media.split('\n').find(l => l.startsWith('/hls/test/s/'));
  assert.ok(seg, media);
  const segRes = await fetch(`${sideUrl}${seg}`);
  assert.equal(segRes.status, 200);
  assert.equal(await segRes.text(), 'TSDATA');
  assert.ok(seenHeaders.every(h => h.referer === 'https://station.example/live'));
});

test('expired token: the variant URL stays the same and the stream is re-resolved', async () => {
  const before = resolveCount;
  token = 'rotated'; // old signed URLs now get 403
  const media = await (await fetch(`${sideUrl}/hls/test/v.m3u8`)).text();
  assert.match(Buffer.from(media.match(/\/s\/[^/]+\/([^.]+)\./)[1], 'base64url').toString(), /seg-rotated-1\.ts/);
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
  const s = await (await fetch(`${sideUrl}/stream/dead.m3u8`)).json();
  assert.match(s.error, /No live stream/);
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
