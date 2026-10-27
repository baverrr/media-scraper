import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSchedule, matchEvents, isOnAir, SportsSchedule, LEAD_MS, OVERRUN_MS } from '../src/sports.js';
import { buildXmltv, sportsChannel } from '../src/guide.js';
import { createApp } from '../src/app.js';
import { StationStore } from '../src/stations.js';

const T0 = Date.UTC(2026, 10, 1, 21, 25); // KC @ DEN kick-off

// Trimmed from ESPN's team schedule response.
const BRONCOS = {
  team: { displayName: 'Denver Broncos' },
  events: [
    {
      id: '401', date: new Date(T0).toISOString(), name: 'Kansas City Chiefs at Denver Broncos', shortName: 'KC @ DEN',
      competitions: [{ status: { type: { state: 'pre' } }, broadcasts: [
        { type: { shortName: 'TV' }, market: { type: 'National' }, media: { shortName: 'CBS' } },
        { type: { shortName: 'Streaming' }, market: { type: 'National' }, media: { shortName: 'Paramount+' } },
      ] }],
    },
    {
      id: '402', date: new Date(T0 + 7 * 864e5).toISOString(), name: 'Denver Broncos at Carolina Panthers', shortName: 'DEN @ CAR',
      competitions: [{ status: { type: { state: 'pre' } }, broadcasts: [{ type: { shortName: 'TV' }, media: { shortName: 'FOX' } }] }],
    },
  ],
};
const NUGGETS = {
  events: [{
    id: '501', date: new Date(T0 + 30 * 60_000).toISOString(), name: 'Golden State Warriors at Denver Nuggets', shortName: 'GS @ DEN',
    competitions: [{ status: { type: { state: 'pre' } }, broadcasts: [
      { type: { shortName: 'TV' }, market: { type: 'Home' }, media: { shortName: 'Altitude Sports' } },
      { type: { shortName: 'Subscription Package' }, media: { shortName: 'NBA League Pass' } },
    ] }],
  }],
};

const STATIONS = [
  { id: 'kusa', callSign: 'KUSA', name: '9NEWS', network: 'NBC', channel: '9.1', enabled: true },
  { id: 'kcnc', callSign: 'KCNC', name: 'CBS Colorado', network: 'CBS', channel: '4.1', enabled: true },
  { id: 'ktvd', callSign: 'KTVD', name: 'My20', network: 'MyNetworkTV', channel: '20.1', sportsAliases: ['Altitude Sports'], enabled: true },
];

test('parses games with over-the-air broadcasts only', () => {
  const [game] = parseSchedule(BRONCOS, { league: 'nfl', team: 'den', name: 'Denver Broncos' });
  assert.equal(game.title, 'Kansas City Chiefs at Denver Broncos');
  assert.deepEqual(game.broadcasts, ['CBS']);
  assert.equal(game.end - game.start, 3.5 * 3_600_000);
});

test('games match stations by network, call sign or alias', () => {
  const events = [
    ...parseSchedule(BRONCOS, { league: 'nfl', team: 'den', name: 'Denver Broncos' }),
    ...parseSchedule(NUGGETS, { league: 'nba', team: 'den', name: 'Denver Nuggets' }),
  ];
  const pairs = matchEvents(events, STATIONS);
  assert.deepEqual(pairs.map(p => [p.event.shortTitle, p.station.id]), [['KC @ DEN', 'kcnc'], ['GS @ DEN', 'ktvd'], ['DEN @ CAR', undefined].slice(0, 0)].filter(x => x.length));
  // FOX game: no FOX station configured, so it isn't matched.
  assert.ok(!pairs.some(p => p.event.shortTitle === 'DEN @ CAR'));
});

test('on the air from shortly before kick-off until the game ends', () => {
  const [game] = parseSchedule(BRONCOS, { league: 'nfl', team: 'den' });
  assert.equal(isOnAir(game, T0 - LEAD_MS - 1), false);
  assert.equal(isOnAir(game, T0 - LEAD_MS), true);
  assert.equal(isOnAir(game, T0 + 3 * 3_600_000), true);
  assert.equal(isOnAir({ ...game, state: 'post' }, T0 + 60_000), false);
  assert.equal(isOnAir({ ...game, state: 'in' }, T0 + 5 * 3_600_000), true);
});

test('guide: the game replaces the placeholder on its station and fills Local Sports', () => {
  const events = parseSchedule(BRONCOS, { league: 'nfl', team: 'den', name: 'Denver Broncos' });
  const games = matchEvents(events, STATIONS);
  const xml = buildXmltv([sportsChannel({ channel: '1.1' }), ...STATIONS], { now: T0, hours: 6, games });
  const kcnc = xml.split('<programme').filter(p => p.includes('channel="kcnc"'));
  assert.ok(kcnc.some(p => p.includes('Kansas City Chiefs at Denver Broncos') && p.includes('<category lang="en">Sports</category>')));
  assert.ok(!kcnc.some(p => p.includes('start="20261101210000') && p.includes('Live: CBS Colorado') && p.includes('stop="20261101220000')), 'placeholder overlapping the game is clipped');
  const sports = xml.split('<programme').filter(p => p.includes('channel="local-sports"'));
  assert.ok(sports.some(p => p.includes('Kansas City Chiefs at Denver Broncos') && p.includes('On CBS Colorado (KCNC)')));
  assert.ok(sports.some(p => p.includes('No local game on the air')));
  // Local Sports plays the station from 15 minutes before kick-off (21:25 UTC), and says so.
  assert.ok(sports.some(p => p.includes('start="20261101211000 +0000"') && p.includes('Kansas City Chiefs at Denver Broncos')), 'Local Sports slot starts with the pre-game');
  // No overlaps on any channel.
  for (const ch of ['kcnc', 'local-sports', 'kusa']) {
    const spans = [...xml.matchAll(new RegExp(`start="(\\d+) \\+0000" stop="(\\d+) \\+0000" channel="${ch}"`, 'g'))].map(m => [m[1], m[2]]);
    for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] >= spans[i - 1][1], `${ch} overlap at ${spans[i][0]}`);
  }
});

test('schedule fetches each team once per TTL and keeps old games when ESPN fails', async () => {
  let now = T0 - 3_600_000;
  let calls = 0;
  let fail = false;
  const schedule = new SportsSchedule({
    teams: [{ league: 'nfl', team: 'den', name: 'Denver Broncos' }],
    now: () => now,
    fetchImpl: async () => { calls++; if (fail) throw new Error('down'); return { ok: true, json: async () => BRONCOS }; },
  });
  assert.equal((await schedule.events()).length, 2);
  await schedule.events();
  assert.equal(calls, 1);
  now += 31 * 60_000;
  fail = true;
  assert.equal((await schedule.events()).length, 2);
  now = T0;
  assert.deepEqual((await schedule.onAirNow(STATIONS)).map(p => p.station.id), ['kcnc']);
});

test('schedule: a failed fetch is retried after a minute, backing off, not after the whole TTL', async () => {
  let now = T0;
  let calls = 0;
  let fail = true;
  const schedule = new SportsSchedule({
    teams: [{ league: 'nfl', team: 'den', name: 'Denver Broncos' }],
    now: () => now,
    fetchImpl: async () => { calls++; if (fail) throw new Error('fetch failed'); return { ok: true, json: async () => BRONCOS }; },
  });
  assert.equal((await schedule.events()).length, 0); // the network was down at start-up
  now += 30_000;
  await schedule.events();
  assert.equal(calls, 1);
  now += 31_000;
  await schedule.events();
  assert.equal(calls, 2); // retried after a minute
  now += 61_000;
  await schedule.events();
  assert.equal(calls, 2); // the second failure waits two minutes
  now += 60_000;
  fail = false;
  assert.equal((await schedule.events()).length, 2);
  assert.equal(calls, 3);
  now += 10 * 60_000;
  await schedule.events();
  assert.equal(calls, 3); // back to the normal TTL once it works
});

test('app: Local Sports channel leads the playlist and plays the station airing the game', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lb-sports-'));
  const cdn = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n${req.url.slice(1)}-seg.ts\n`);
  });
  await new Promise(r => cdn.listen(0, '127.0.0.1', r));
  const cdnUrl = `http://127.0.0.1:${cdn.address().port}`;
  try {
    await mkdir(path.join(dir, 'markets'));
    await writeFile(path.join(dir, 'markets', 'den.json'), JSON.stringify({
      name: 'Denver', sportsChannel: '1.1',
      teams: [{ league: 'nfl', team: 'den', name: 'Denver Broncos' }],
      stations: STATIONS.map(s => ({ ...s, url: `https://${s.id}.example/live` })),
    }));
    const store = await new StationStore({ dataDir: path.join(dir, 'data'), marketsDir: path.join(dir, 'markets'), market: 'den' }).load();
    let now = T0 - 2 * 3_600_000;
    const sports = new SportsSchedule({ teams: store.sports.teams, now: () => now, fetchImpl: async () => ({ ok: true, json: async () => BRONCOS }) });
    const resolved = [];
    const resolver = { async resolve(s) { resolved.push(s.id); return { url: `${cdnUrl}/${s.id}`, type: 'hls', headers: {}, via: 'page' }; } };
    const app = createApp({ store, resolver, sports, now: () => now, log: {} });
    const server = http.createServer(app.handler);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      // Before the game: Local Sports first, stations in configured order, nothing to play.
      let m3u = await (await fetch(`${base}/playlist.m3u`)).text();
      assert.deepEqual([...m3u.matchAll(/tvg-id="([^"]+)"/g)].map(x => x[1]), ['local-sports', 'kusa', 'kcnc', 'ktvd']);
      assert.equal((await fetch(`${base}/stream/local-sports.m3u8`)).status, 503);

      // Kick-off: CBS Colorado moves to the front, Local Sports plays it, warm-up pre-resolves it.
      now = T0 - 5 * 60_000;
      m3u = await (await fetch(`${base}/playlist.m3u`)).text();
      assert.deepEqual([...m3u.matchAll(/tvg-id="([^"]+)"/g)].map(x => x[1]), ['local-sports', 'kcnc', 'kusa', 'ktvd']);
      assert.deepEqual(await app.warmSports(), ['kcnc']);
      assert.deepEqual(resolved, ['kcnc']);
      const playlist = await (await fetch(`${base}/stream/local-sports.m3u8`)).text();
      assert.match(playlist, /\/hls\/kcnc\/s\/[\w-]+\/[\w-]+\.ts$/m);

      const api = await (await fetch(`${base}/api/sports`)).json();
      assert.equal(api.onAir[0].station, 'kcnc');
    } finally {
      server.close();
    }
  } finally {
    cdn.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('schedule: changing teams mid-fetch discards the old teams\' games', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const fetched = [];
  const schedule = new SportsSchedule({
    teams: [{ league: 'nfl', team: 'den', name: 'Broncos' }],
    fetchImpl: async url => {
      fetched.push(url);
      if (url.includes('football/nfl')) await gate;
      return { ok: true, json: async () => (url.includes('football/nfl') ? BRONCOS : { events: [] }) };
    },
  });
  const first = schedule.events();
  schedule.setTeams([{ league: 'nba', team: 'den', name: 'Nuggets' }]);
  release();
  assert.deepEqual(await first, []); // re-fetched for the new teams, not the Broncos' games
  assert.deepEqual(await schedule.events(), []);
  assert.ok(fetched.some(u => u.includes('basketball/nba')));
});

test('a game cached as in progress goes off the air once it has overrun by a lot', () => {
  const ev = { state: 'in', start: 0, end: 3 * 3_600_000 };
  assert.equal(isOnAir(ev, ev.end + 60 * 60_000), true); // overtime
  assert.equal(isOnAir(ev, ev.end + OVERRUN_MS), false); // ESPN unreachable since: stale
});

test('app: a station airing two games at once is still one channel', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lb-sports-'));
  try {
    await mkdir(path.join(dir, 'markets'));
    await writeFile(path.join(dir, 'markets', 'den.json'), JSON.stringify({
      name: 'Denver', teams: [{ league: 'nba', team: 'den' }, { league: 'nhl', team: 'col' }],
      stations: STATIONS.map(s => ({ ...s, url: `https://${s.id}.example/live` })),
    }));
    const store = await new StationStore({ dataDir: path.join(dir, 'data'), marketsDir: path.join(dir, 'markets'), market: 'den' }).load();
    const kcnc = store.get('kcnc');
    const game = id => ({ station: kcnc, event: { id, title: id, team: id, start: 0, end: 1, broadcasts: [] } });
    const sports = { onAirNow: async () => [game('nba:1'), game('nhl:2')], between: async () => [], setTeams() {} };
    const resolved = [];
    const app = createApp({ store, resolver: { async resolve(s) { resolved.push(s.id); return { url: 'https://x/y.m3u8', type: 'hls', headers: {} }; } }, sports, log: {} });
    const server = http.createServer(app.handler);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      const m3u = await (await fetch(`http://127.0.0.1:${server.address().port}/playlist.m3u`)).text();
      assert.deepEqual([...m3u.matchAll(/tvg-id="([^"]+)"/g)].map(x => x[1]), ['local-sports', 'kcnc', 'kusa', 'ktvd']);
      assert.deepEqual(await app.warmSports(), ['kcnc']);
      assert.deepEqual(resolved, ['kcnc']);
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('denver market: network games go to the Denver station before neighboring markets', async () => {
  const { loadMarket } = await import('../src/stations.js');
  const m = await loadMarket(new URL('../markets', import.meta.url).pathname.replace(/%20/g, ' '), 'denver');
  const enabled = m.stations.filter(s => s.enabled);
  const game = net => ({ id: `nfl:${net}`, start: 0, end: 1, state: 'pre', broadcasts: [net] });
  const on = net => matchEvents([game(net)], enabled)[0]?.station.id;
  assert.equal(on('NBC'), 'kusa');
  assert.equal(on('ABC'), 'kmgh');
  assert.equal(on('CBS'), 'kcnc');
  // Every station is still in the list, and channel ids are unique.
  assert.equal(new Set(m.stations.map(s => s.id)).size, m.stations.length);
});
