// Fewer bot checks: the visit store, the per-site cooldown after a bot check, how the app uses
// them around a (fake) resolver, and the real resolver coming back to a page as the same visitor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { VisitorStore, SiteCooldown, siteOf, trimState } from '../src/visits.js';
import { Resolver } from '../src/resolver.js';
import { createApp } from '../src/app.js';
import { StationStore } from '../src/stations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRAPER = [path.join(here, '..', 'media-scraper.js'), path.join(here, '..', '..', 'media-scraper.js')].find(p => existsSync(p));
let dir;
before(async () => { dir = await mkdtemp(path.join(tmpdir(), 'lb-visits-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

const botCheck = () => Object.assign(new Error('bot check'), { details: { reason: 'bot-check' } });
const noStream = () => Object.assign(new Error('No live stream found on the page'), { details: { reason: 'no-stream' } });

test('siteOf: the host without www., or null', () => {
  assert.equal(siteOf('https://www.Station.example/live'), 'station.example');
  assert.equal(siteOf('https://live.station.example/x'), 'live.station.example');
  assert.equal(siteOf('not a url'), null);
});

test('trimState: keeps cookies, drops site storage past the size limit', () => {
  const cookies = [{ name: 'a', value: '1', domain: 'station.example', path: '/' }];
  assert.deepEqual(trimState({ cookies, origins: [{ origin: 'https://station.example', localStorage: [] }] }).origins.length, 1);
  const huge = [{ origin: 'https://station.example', localStorage: [{ name: 'ads', value: 'x'.repeat(600_000) }] }];
  assert.deepEqual(trimState({ cookies, origins: huge }), { cookies, origins: [] });
  assert.equal(trimState(null), null);
  assert.equal(trimState({ origins: [] }), null);
  assert.equal(trimState({ cookies: [{ name: 'a', value: 1 }] }), null); // not a cookie the browser would take
});

test('visits: survive a restart, readable only by the owner, forgotten after a month unused', async () => {
  let t = Date.UTC(2026, 9, 1);
  const data = path.join(dir, 'store');
  const a = await new VisitorStore({ dataDir: data, now: () => t }).load();
  const state = { cookies: [{ name: 'visitor', value: 'v1', domain: 'station.example', path: '/' }], origins: [] };
  await a.save('kxyz', state);
  assert.deepEqual(a.get('kxyz'), state);
  assert.equal((await stat(path.join(data, 'visitors.json'))).mode & 0o777, 0o600);

  const b = await new VisitorStore({ dataDir: data, now: () => t }).load();
  assert.deepEqual(b.get('kxyz'), state);
  t += 31 * 86_400_000;
  assert.equal(b.get('kxyz'), null);
  assert.equal((await new VisitorStore({ dataDir: data, now: () => t }).load()).get('kxyz'), null);

  await b.save('kxyz', state);
  await b.forget('kxyz');
  assert.equal(b.get('kxyz'), null);
  assert.doesNotMatch(await readFile(path.join(data, 'visitors.json'), 'utf8'), /v1/);
});

test('visits: a damaged file is set aside, not fatal, also when it is valid JSON of the wrong shape', async () => {
  for (const [name, body] of [['damaged', '{ nope'], ['null', 'null']]) {
    const data = path.join(dir, name);
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, 'visitors.json'), body);
    const warnings = [];
    const s = await new VisitorStore({ dataDir: data, log: { warn: m => warnings.push(m) } }).load();
    assert.equal(s.get('any'), null);
    assert.ok(!existsSync(path.join(data, 'visitors.json')), name);
    assert.match(warnings.join(), /was damaged; moved it to/);
  }
});

test('visits: expired ones leave the file at the next write, and removed stations\' go', async () => {
  let t = Date.UTC(2026, 9, 1);
  const data = path.join(dir, 'prune');
  const state = v => ({ cookies: [{ name: 'visitor', value: v, domain: 'station.example', path: '/' }], origins: [] });
  const s = await new VisitorStore({ dataDir: data, now: () => t }).load();
  await s.save('old', state('old-cookie'));
  t += 31 * 86_400_000;
  await s.save('new', state('new-cookie'));
  const file = () => readFile(path.join(data, 'visitors.json'), 'utf8');
  assert.doesNotMatch(await file(), /old-cookie/); // never read again, still not kept
  assert.match(await file(), /new-cookie/);

  await s.save('gone', state('gone-cookie'));
  await s.keepOnly(['new']);
  assert.equal(s.get('gone'), null);
  assert.doesNotMatch(await file(), /gone-cookie/);
  assert.match(await file(), /new-cookie/);
});

test('cooldown: 15 minutes after a bot check, doubling up to 6 hours, reset by a page that loads', () => {
  let t = 0;
  const c = new SiteCooldown({ now: () => t });
  const site = 'station.example';
  assert.equal(c.waitingUntil(site, 'a'), 0);
  assert.equal(c.challenged(site), 15 * 60_000);
  assert.equal(c.waitingUntil(site, 'a'), 15 * 60_000);
  assert.equal(c.waitingUntil('other.example', 'a'), 0); // per site
  // A second station running into the same bot check meanwhile doesn't make the wait longer.
  assert.equal(c.challenged(site), 15 * 60_000);
  let expected = 15 * 60_000;
  for (const minutes of [30, 60, 120, 240, 360, 360]) {
    t = c.waitingUntil(site, 'a');
    assert.equal(c.waitingUntil(site, 'a'), 0);
    expected = t + minutes * 60_000;
    assert.equal(c.challenged(site), expected);
  }
  c.passed(site);
  assert.equal(c.waitingUntil(site, 'a'), 0);
  assert.equal(c.challenged(site), t + 15 * 60_000); // counting starts over
  // So it does after a long quiet spell.
  t += 15 * 60_000;
  c.challenged(site);
  t += 30 * 60_000 + 6 * 3_600_000 + 1;
  assert.equal(c.challenged(site), t + 15 * 60_000);
});

test('cooldown: Test now\'s allowance is for its station, lets one attempt through, and lapses', () => {
  let t = 0;
  const c = new SiteCooldown({ now: () => t });
  const site = 'station.example';
  c.challenged(site);
  c.allow(site, 'a', t + 60_000);
  assert.notEqual(c.waitingUntil(site, 'b'), 0); // another station on the site can't take it
  assert.equal(c.waitingUntil(site, 'a'), 0);
  assert.notEqual(c.waitingUntil(site, 'a'), 0); // used up
  // A bot check on the attempt it let through does make the wait longer.
  assert.equal(c.challenged(site), t + 30 * 60_000);
  c.allow(site, 'a', t + 60_000);
  t += 2 * 60_000;
  assert.notEqual(c.waitingUntil(site, 'a'), 0); // lapsed
  c.allow('never.example', 'a', t + 60_000); // no cooldown, nothing to allow
  assert.equal(c.waitingUntil('never.example', 'a'), 0);
});

async function marketStore(name, stations) {
  const marketsDir = path.join(dir, `markets-${name}`);
  await mkdir(marketsDir, { recursive: true });
  await writeFile(path.join(marketsDir, 't.json'), JSON.stringify({ name: 'T', stations }));
  return new StationStore({ dataDir: path.join(dir, `data-${name}`), marketsDir, market: 't' }).load();
}

test('app: after a bot check the site is left alone (other stations on it too) until the cooldown or Test now', async () => {
  const store = await marketStore('cooldown', [
    { id: 'a', name: 'A', url: 'https://www.station.example/live' },
    { id: 'b', name: 'B', url: 'https://station.example/other-live' },
    { id: 'c', name: 'C', url: 'https://elsewhere.example/live' },
    { id: 'm', name: 'M', url: 'https://station.example/live', streamUrl: 'https://cdn.example/m.m3u8' },
  ]);
  const calls = [];
  let answer = botCheck;
  const resolver = { async resolve(station) { calls.push(station.id); throw answer(); } };
  let t = Date.UTC(2026, 9, 31, 12);
  const app = createApp({ store, resolver, config: { apiKey: 'secret', failureSeconds: 0 }, log: {}, now: () => t });
  const server = http.createServer(app.handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const testNow = id => fetch(`http://127.0.0.1:${server.address().port}/api/stations/${id}/test`, { method: 'POST', headers: { 'x-api-key': 'secret' } }).then(r => r.json());
  try {
    await assert.rejects(app.cache.get(store.get('a')), e => /bot check; trying the site again in 15 minutes/.test(e.message)
      && e.details.retryAt === new Date(t + 15 * 60_000).toISOString());
    assert.deepEqual(calls, ['a']);

    // The same site, through either station, waits without opening the page.
    t += 60_000;
    await assert.rejects(app.cache.get(store.get('a')), /leaving it alone for 14 minutes more/);
    assert.equal(app.cache.status('a').retryAt, new Date(t + 14 * 60_000).toISOString());
    // Tuning in meanwhile plays the slate rather than an error, still without opening the page.
    const port = server.address().port;
    const tune = await fetch(`http://127.0.0.1:${port}/stream/a.m3u8`);
    assert.equal(tune.status, 200);
    assert.match(await tune.text(), /#EXTM3U/);
    await assert.rejects(app.cache.get(store.get('b')), e => e.details.cooldown && e.details.reason === 'bot-check');
    // Another site, and a manual stream URL, don't.
    await assert.rejects(app.cache.get(store.get('c')), /bot check/);
    await assert.rejects(app.cache.get(store.get('m')), /bot check/);
    assert.deepEqual(calls, ['a', 'c', 'm']);

    // Test now tries once at once; another bot check doubles the wait.
    const tested = await testNow('b');
    assert.equal(tested.ok, false);
    assert.deepEqual(calls, ['a', 'c', 'm', 'b']);
    t += 16 * 60_000;
    await assert.rejects(app.cache.get(store.get('a')), /leaving it alone for 14 minutes more/);
    assert.equal(calls.length, 4);

    // A failure that isn't about the page (a timeout) neither ends the wait nor makes it longer.
    t += 15 * 60_000;
    answer = () => new Error('page.goto: Timeout 45000ms exceeded');
    await assert.rejects(app.cache.get(store.get('a')), /Timeout/);
    answer = botCheck;
    await assert.rejects(app.cache.get(store.get('a')), /trying the site again in 60 minutes/);
    t += 60 * 60_000;
    calls.length = 4;

    // After the wait the site is tried again, and a page that loads, even without a stream,
    // ends the run of bot checks: the next one waits 15 minutes again.
    answer = noStream;
    await assert.rejects(app.cache.get(store.get('a')), /No live stream/);
    t += 60_000;
    answer = botCheck;
    await assert.rejects(app.cache.get(store.get('b')), /trying the site again in 15 minutes/);
    assert.deepEqual(calls.slice(4), ['a', 'b']);
  } finally {
    server.close();
  }
});

test('app: stations without a sign-in get their last visit; signed-in ones use their session instead', async () => {
  const store = await marketStore('visit', [{ id: 'a', name: 'A', url: 'https://station.example/live' }]);
  const visitors = await new VisitorStore({ dataDir: path.join(dir, 'visit-store') }).load();
  const seen = [];
  const resolver = {
    async resolve(station, login, visit) {
      seen.push({ login: !!login, state: visit?.state ?? null });
      await visit?.save({ cookies: [{ name: 'visitor', value: `v${seen.length}`, domain: 'station.example', path: '/' }], origins: [] });
      return { url: 'https://cdn.example/a.m3u8', type: 'hls', headers: {} };
    },
  };
  const app = createApp({ store, resolver, visitors, log: {} });
  await app.cache.get(store.get('a'), { force: true });
  await app.cache.get(store.get('a'), { force: true });
  assert.equal(seen[0].state, null);
  assert.equal(seen[1].state.cookies[0].value, 'v1');
  assert.equal(visitors.get('a').cookies[0].value, 'v2');

  const signedIn = createApp({ store, resolver, visitors, logins: { get: () => ({ username: 'u', password: 'p' }) }, log: {} });
  assert.ok(await signedIn.cache.get(store.get('a'), { force: true }));
  assert.equal(seen.at(-1).login, true);
  assert.equal(seen.at(-1).state, null);
});

test('app: a station sync drops removed stations\' visits, and an empty list keeps them', async () => {
  const store = await marketStore('sync', [{ id: 'a', name: 'A', url: 'https://station.example/live' }, { id: 'b', name: 'B', url: 'https://other.example/live' }]);
  const visitors = await new VisitorStore({ dataDir: path.join(dir, 'sync-store') }).load();
  const state = { cookies: [{ name: 'v', value: '1', domain: 'station.example', path: '/' }], origins: [] };
  await visitors.save('a', state);
  await visitors.save('b', state);
  const app = createApp({ store, resolver: { resolve: async () => { throw new Error('unused'); } }, visitors, config: { apiKey: 'secret' }, log: {} });
  const server = http.createServer(app.handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const put = body => fetch(`http://127.0.0.1:${server.address().port}/api/stations`, { method: 'PUT', headers: { 'x-api-key': 'secret' }, body: JSON.stringify(body) });
  try {
    assert.equal((await put([])).status, 200);
    assert.ok(visitors.get('a') && visitors.get('b'));
    assert.equal((await put([{ id: 'a', name: 'A', url: 'https://station.example/live' }])).status, 200);
    assert.ok(visitors.get('a'));
    assert.equal(visitors.get('b'), null);
  } finally {
    server.close();
  }
});

// A site that gives each new visitor a cookie and streams to everyone, or answers with a bot
// check while `challenge` is set.
test('resolver: comes back to a page as the same visitor, and forgets the visit after a bot check', { timeout: 180_000 }, async t => {
  let usable = true;
  try { await (await chromium.launch()).close(); } catch { usable = false; }
  if (!usable) { t.skip('no browser installed'); return; }

  let visitors = 0, challenge = false, offAir = false;
  const cookiesSeen = [];
  const site = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const cookie = req.headers.cookie || '';
    if (u.pathname === '/live') {
      cookiesSeen.push(cookie);
      if (challenge) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<title>Just a moment</title><p>Verify you are human</p>'); }
      const headers = { 'content-type': 'text/html' };
      if (!/visitor=/.test(cookie)) headers['set-cookie'] = `visitor=v${++visitors}; Path=/; Max-Age=86400`;
      res.writeHead(200, headers);
      if (offAir) return res.end('<!doctype html><h1>Live</h1><p>Our next newscast starts at 5 PM.</p>');
      return res.end('<!doctype html><h1>Live</h1><video></video><script>fetch("/live/stream.m3u8")</script>');
    }
    if (u.pathname === '/live/stream.m3u8') {
      const seq = Math.floor(Date.now() / 4000);
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:${seq}\n#EXTINF:4,\nseg${seq}.ts\n#EXTINF:4,\nseg${seq + 1}.ts\n`);
    }
    if (/^\/live\/seg\d+\.ts$/.test(u.pathname)) { res.writeHead(200, { 'content-type': 'video/mp2t' }); return res.end(Buffer.alloc(1880, 0x47)); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const siteUrl = `http://127.0.0.1:${site.address().port}`;
  const store = await marketStore('real', [{ id: 'real', name: 'Real TV', url: `${siteUrl}/live` }]);
  const visitStore = await new VisitorStore({ dataDir: path.join(dir, 'real-visits') }).load();
  const warnings = [];
  const resolver = new Resolver({ scraperPath: SCRAPER, ytDlp: '', waitMs: 8000, log: { warn: m => warnings.push(m) } });
  const app = createApp({ store, resolver, visitors: visitStore, config: { apiKey: 'secret' }, log: {} });
  try {
    assert.equal((await app.cache.get(store.get('real'), { force: true })).type, 'hls');
    assert.equal(cookiesSeen[0], '');
    assert.equal(visitStore.get('real').cookies.find(c => c.name === 'visitor').value, 'v1');

    await app.cache.get(store.get('real'), { force: true });
    assert.match(cookiesSeen[1], /visitor=v1/);
    assert.equal(visitors, 1); // the same visitor, not a new one

    // Off the air, the page still loaded: the visit is kept.
    offAir = true;
    await assert.rejects(app.cache.get(store.get('real'), { force: true }), /No live stream/);
    assert.match(cookiesSeen[2], /visitor=v1/);
    assert.equal(visitStore.get('real').cookies.find(c => c.name === 'visitor').value, 'v1');
    offAir = false;

    // A saved visit the browser won't take is dropped, not the station.
    await visitStore.save('real', { cookies: [{ name: 'visitor', value: 'v1', domain: '127.0.0.1', path: '/', sameSite: 'Sometimes' }], origins: [] });
    assert.equal((await app.cache.get(store.get('real'), { force: true })).type, 'hls');
    assert.match(warnings.join(), /saved visit can't be used/);
    assert.equal(visitors, 2);
    assert.equal(visitStore.get('real').cookies.find(c => c.name === 'visitor').value, 'v2');

    challenge = true;
    await assert.rejects(app.cache.get(store.get('real'), { force: true }), /bot check/);
    assert.equal(visitStore.get('real'), null);
  } finally {
    await resolver.close();
    site.close();
  }
});
