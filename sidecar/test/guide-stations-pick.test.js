import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildM3u, buildXmltv } from '../src/guide.js';
import { normalizeStations, normalizeSports, loadMarket, StationStore } from '../src/stations.js';
import { pickBest, mergeCandidates, scoreCandidate, pickHeaders, isAd, unblockedStreamUrl } from '../src/pick.js';

const stations = [
  { id: 'kusa', callSign: 'KUSA', name: '9NEWS', channel: '9.1', network: 'NBC', url: 'https://www.9news.com/watch', logo: 'https://x/l.png', enabled: true },
  { id: 'kdvr', callSign: 'KDVR', name: 'FOX31 "Denver" & more', channel: '31.1', url: 'https://kdvr.com/live/', enabled: true },
];

test('M3U lists each station with tvg tags and a sidecar stream URL', () => {
  const m3u = buildM3u(stations, 'http://127.0.0.1:8899');
  assert.match(m3u, /^#EXTM3U\n/);
  assert.match(m3u, /tvg-id="kusa" tvg-name="9NEWS \(KUSA\)" tvg-chno="9.1" tvg-logo="https:\/\/x\/l.png"/);
  assert.match(m3u, /\nhttp:\/\/127\.0\.0\.1:8899\/stream\/kusa\.m3u8\n/);
  assert.doesNotMatch(m3u, /tvg-name="FOX31 "Denver/); // quotes stripped from attributes
  assert.doesNotMatch(m3u, /tvg-id="kdvr"[^\n]*tvg-logo/); // no logo, none listed
  // Local Sports has the sidecar's own logo.
  const sports = buildM3u([{ id: 'local-sports', name: 'Local Sports', channel: '1.1', logo: null }], 'http://127.0.0.1:8899');
  assert.match(sports, /tvg-logo="http:\/\/127\.0\.0\.1:8899\/logo\/local-sports\.png"/);
});

test('XMLTV has a channel per station and hour blocks covering now', () => {
  const now = Date.UTC(2026, 9, 26, 18, 30);
  const xml = buildXmltv(stations, { now, hours: 3 });
  assert.match(xml, /<channel id="kusa">/);
  assert.match(xml, /FOX31 &quot;Denver&quot; &amp; more/);
  assert.match(xml, /start="20261026170000 \+0000" stop="20261026180000 \+0000" channel="kusa"/);
  assert.match(xml, /start="20261026180000 \+0000" stop="20261026190000 \+0000" channel="kusa"/);
  assert.equal((xml.match(/channel="kusa"/g) || []).length, 5); // 17:00..21:00 starts: one block back, 3 h ahead + current
});

test('station validation', () => {
  const [s] = normalizeStations([{ id: 'KUSA', url: 'https://www.9news.com/watch' }]);
  assert.equal(s.id, 'kusa');
  assert.equal(s.name, 'kusa');
  assert.equal(s.enabled, true);
  assert.throws(() => normalizeStations([{ id: 'bad id', url: 'https://x' }]), /invalid station id/);
  assert.throws(() => normalizeStations([{ id: 'a', url: 'ftp://x' }]), /http/);
  assert.throws(() => normalizeStations([{ id: 'a', url: 'https://x' }, { id: 'a', url: 'https://y' }]), /duplicate/);
});

test('bundled Denver market is valid: at least 15 stations, local teams', async () => {
  const market = await loadMarket(fileURLToPath(new URL('../markets', import.meta.url)), 'denver');
  assert.ok(market.stations.length >= 15, `${market.stations.length} stations`);
  assert.ok(market.stations.every(s => s.callSign && s.channel && s.url));
  assert.ok(market.sports.teams.some(t => t.league === 'nfl' && t.team === 'den'));
});

test('station extras: manual stream URL and sports aliases', () => {
  const [s] = normalizeStations([{ id: 'ktvd', url: 'https://a/b', streamUrl: 'https://cdn/x.m3u8', sportsAliases: 'Altitude, Altitude 2 ,' }]);
  assert.equal(s.streamUrl, 'https://cdn/x.m3u8');
  assert.deepEqual(s.sportsAliases, ['Altitude', 'Altitude 2']);
  assert.throws(() => normalizeStations([{ id: 'x', url: 'https://a', streamUrl: 'file:///etc/passwd' }]), /streamUrl must be http/);
  assert.throws(() => normalizeStations([{ id: 'local-sports', url: 'https://a' }]), /reserved/);
});

test('sports settings validation', () => {
  const s = normalizeSports({ teams: [{ league: 'NFL', team: 'den', name: 'Broncos' }] });
  assert.deepEqual(s, { enabled: true, channel: '1.1', teams: [{ league: 'nfl', team: 'den', name: 'Broncos' }], timezone: null });
  assert.equal(normalizeSports({ timezone: 'America/Chicago' }).timezone, 'America/Chicago');
  assert.equal(normalizeSports({ timezone: 'Not/AZone' }).timezone, null);
  assert.throws(() => normalizeSports({ teams: [{ league: 'cricket', team: 'x' }] }), /unknown league/);
  assert.throws(() => normalizeSports({ teams: [{ league: 'nfl', team: '../x' }] }), /ESPN team id/);
});

test('candidate choice prefers the paired live master, never ads or VOD', () => {
  const live = { ok: true, live: true, master: true };
  const candidates = mergeCandidates([
    { url: 'https://ads.example/pubads/pre.m3u8', sources: ['network'], probe: live },
    { url: 'https://cdn/vod.m3u8', sources: ['network'], probe: { ok: true, live: false } },
    { url: 'https://cdn/live/master.m3u8', type: 'hls', sources: ['network'], probe: live },
    { url: 'https://cdn/live/master.m3u8', type: 'hls', sources: ['scan'], paired: true },
    { url: 'https://cdn/other/master.m3u8', type: 'hls', sources: ['network'], probe: live },
    { url: 'https://cdn/broken.m3u8', sources: ['network'], probe: { ok: false } },
  ]);
  assert.equal(candidates.length, 5);
  assert.equal(pickBest(candidates).url, 'https://cdn/live/master.m3u8');
  assert.equal(scoreCandidate(candidates[0]), -Infinity);
  assert.equal(pickBest([{ url: 'https://cdn/vod.m3u8', probe: { ok: true, live: false } }]), null);
});

test('only replayable request headers are kept', () => {
  assert.deepEqual(
    pickHeaders({ Referer: 'https://a', 'user-agent': 'UA', cookie: 'c=1', 'sec-ch-ua': 'x', accept: '*/*', 'x-player-token': 't', 'x-client-data': 'z' }),
    { referer: 'https://a', 'user-agent': 'UA', cookie: 'c=1', 'x-player-token': 't' },
  );
});

test('pick: a live HLS stream beats a paired DASH one (DASH is only redirected, without headers)', () => {
  const dash = { url: 'https://cdn/live/manifest.mpd', type: 'dash', paired: true, sources: ['network'], probe: { ok: true, live: true, master: true, dash: true } };
  const hls = { url: 'https://cdn/live/master.m3u8', type: 'hls', sources: ['network'], probe: { ok: true, live: true, master: false } };
  assert.equal(pickBest([dash, hls]).url, hls.url);
  // An HLS stream only mentioned in the markup (a promo) doesn't beat the page's own DASH player.
  const promo = { ...hls, url: 'https://cdn/promo/loop.m3u8', sources: ['scan'] };
  assert.equal(pickBest([dash, promo]).url, dash.url);
  assert.equal(pickBest([dash]).url, dash.url); // still used when it's all there is
});

test('stations: an unknown market only matters while there are no saved settings', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'lb-market-'));
  const marketsDir = fileURLToPath(new URL('../markets', import.meta.url));
  try {
    await assert.rejects(new StationStore({ dataDir: dir, marketsDir, market: 'denvr' }).load(), /unknown market "denvr".*available: .*denver/);
    await writeFile(path.join(dir, 'stations.json'), JSON.stringify([{ id: 'kusa', name: '9NEWS', url: 'https://www.9news.com/watch' }]));
    await writeFile(path.join(dir, 'sports.json'), JSON.stringify({ enabled: false, teams: [] }));
    const store = await new StationStore({ dataDir: dir, marketsDir, market: 'denvr' }).load();
    assert.deepEqual(store.stations.map(s => s.id), ['kusa']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pick: Google DAI live streams are the programme, not ads, and avoid the ad-blocked host', () => {
  const dai = 'https://pubads.g.doubleclick.net/ssai/event/UKvg2XfoRHGpLJry_jnc-Q/master.m3u8?ContentId=x';
  assert.equal(isAd(dai), false);
  assert.equal(isAd('https://dai.google.com/linear/hls/pa/event/abc/stream/def/master.m3u8'), false);
  assert.equal(isAd('https://pubads.g.doubleclick.net/gampad/ads?iu=/123/preroll'), true);
  assert.equal(isAd('https://cdn.example/ads/preroll.m3u8'), true);
  assert.equal(unblockedStreamUrl(dai), 'https://dai.google.com/ssai/event/UKvg2XfoRHGpLJry_jnc-Q/master.m3u8?ContentId=x');
  assert.equal(unblockedStreamUrl('https://cdn.example/live.m3u8'), 'https://cdn.example/live.m3u8');
  const best = pickBest([{ url: unblockedStreamUrl(dai), type: 'hls', sources: ['network'], probe: { ok: true, live: true, master: true } }]);
  assert.ok(best);
});

test('bot-check pages are named as such; ordinary pages mentioning a CAPTCHA are not', async () => {
  const { isBotCheck } = await import('../src/resolver.js');
  assert.equal(isBotCheck(403, 'Access to this page has been denied Before we continue... Press & Hold to confirm you are a human (and not a bot).'), true);
  assert.equal(isBotCheck(200, 'Just a moment... Checking your browser before accessing the site.'), true);
  assert.equal(isBotCheck(200, `Contact us (this form uses reCAPTCHA). ${'News story. '.repeat(200)}`), false);
  assert.equal(isBotCheck(404, 'Page not found'), false);
});

test('newscast schedules: validated, and shown at their local times with "Not streaming" between', async () => {
  const { normalizeStation, normalizeSchedule } = await import('../src/stations.js');
  const { buildXmltv } = await import('../src/guide.js');
  assert.throws(() => normalizeSchedule([{ days: ['someday'], start: '17:00', end: '17:30' }], 'x', { strict: true }), /days must be/);
  assert.throws(() => normalizeSchedule([{ days: 'daily', start: '5pm', end: '17:30' }], 'x', { strict: true }), /HH:MM/);
  const s = normalizeStation({
    id: 'news', name: 'News 5', url: 'https://x.example/',
    schedule: [{ days: 'weekdays', start: '17:00', end: '17:30', title: 'News at 5' }, { days: ['Saturday'], start: '23:30', end: '00:05', title: 'Late news' }],
  });
  assert.deepEqual(s.schedule[0].days, ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.deepEqual(s.schedule[1].days, ['sat']);
  // Wednesday 2026-10-28 12:00 in Denver (18:00 UTC, MDT is UTC-6); the guide covers two days.
  const now = Date.UTC(2026, 9, 28, 18, 0);
  const xml = buildXmltv([s], { now, hours: 96, timeZone: 'America/Denver' });
  // 17:00 MDT = 23:00 UTC on the 28th; 17:00 MST (after the DST change on Nov 1) would be 00:00 UTC.
  assert.match(xml, /start="20261028230000 \+0000" stop="20261028233000 \+0000" channel="news">\n    <title lang="en">News at 5</);
  // Saturday 23:30-00:05 MDT runs past midnight: 05:30-06:05 UTC on Sunday.
  assert.match(xml, /start="20261101053000 \+0000" stop="20261101060500 \+0000" channel="news">\n    <title lang="en">Late news</);
  assert.match(xml, /<title lang="en">Not streaming<\/title>/);
  assert.doesNotMatch(xml, /Live: News 5/);
  // Days after the DST change: 17:00 MST is midnight UTC.
  const later = buildXmltv([s], { now: Date.UTC(2026, 10, 2, 18, 0), hours: 24, timeZone: 'America/Denver' });
  assert.match(later, /start="20261103000000 \+0000" stop="20261103003000 \+0000"/);
  // A station without a schedule keeps its hour-long "Live" blocks.
  assert.match(buildXmltv([normalizeStation({ id: 'plain', name: 'Plain', url: 'https://x.example/' })], { now, hours: 2 }), /Live: Plain/);
});

test('newscast schedules: a local game on the station replaces the newscast it overlaps', async () => {
  const { normalizeStation } = await import('../src/stations.js');
  const { buildXmltv } = await import('../src/guide.js');
  const s = normalizeStation({ id: 'news', name: 'News 5', url: 'https://x.example/', schedule: [{ days: 'daily', start: '17:00', end: '17:30', title: 'News at 5' }] });
  const now = Date.UTC(2026, 9, 28, 18, 0);
  const game = { station: s, event: { start: Date.UTC(2026, 9, 28, 22, 0), end: Date.UTC(2026, 9, 29, 1, 0), title: 'Big Game', team: 'Home Team' } };
  const xml = buildXmltv([s], { now, hours: 12, timeZone: 'America/Denver', games: [game] });
  assert.match(xml, /Big Game/);
  assert.doesNotMatch(xml, /start="20261028230000 \+0000"[^>]*>\n    <title lang="en">News at 5/);
});

test('newscast times: DST gaps land after the gap, games cut newscasts, bad blocks and zones don\'t break anything', async () => {
  const { normalizeStation, normalizeSchedule } = await import('../src/stations.js');
  const { buildXmltv, zonedTime } = await import('../src/guide.js');
  // 2027-03-14 02:30 doesn't exist in Denver: 03:30 MDT (09:30 UTC). 2026-11-01 01:30 happens twice: the first (07:30 UTC).
  assert.equal(new Date(zonedTime(2027, 2, 14, 2, 30, 'America/Denver')).toISOString(), '2027-03-14T09:30:00.000Z');
  assert.equal(new Date(zonedTime(2027, 2, 14, 1, 30, 'America/Denver')).toISOString(), '2027-03-14T08:30:00.000Z');
  assert.equal(new Date(zonedTime(2026, 10, 1, 1, 30, 'America/Denver')).toISOString(), '2026-11-01T07:30:00.000Z');
  assert.equal(new Date(zonedTime(2026, 6, 4, 17, 0, 'America/Denver')).toISOString(), '2026-07-04T23:00:00.000Z');

  // A newscast entirely inside the gap (02:30-03:30) keeps its hour: 03:30-04:30 MDT.
  const early = normalizeStation({ id: 'early', name: 'Early', url: 'https://x.example/', schedule: [{ days: ['sun'], start: '02:30', end: '03:30', title: 'Overnight' }] });
  assert.match(buildXmltv([early], { now: Date.UTC(2027, 2, 14, 6), hours: 6, timeZone: 'America/Denver' }), /start="20270314093000 \+0000" stop="20270314103000 \+0000" channel="early">\n    <title lang="en">Overnight/);

  // A game at 17:15 cuts a 17:00-18:00 newscast to 17:00-17:15.
  const s = normalizeStation({ id: 'news', name: 'News', url: 'https://x.example/', schedule: [{ days: 'daily', start: '17:00', end: '18:00', title: 'News hour' }] });
  const game = { station: s, event: { start: Date.UTC(2026, 9, 28, 23, 15), end: Date.UTC(2026, 9, 29, 2, 0), title: 'Game', team: 'Team' } };
  const xml = buildXmltv([s], { now: Date.UTC(2026, 9, 28, 18), hours: 12, timeZone: 'America/Denver', games: [game] });
  assert.match(xml, /start="20261028230000 \+0000" stop="20261028231500 \+0000" channel="news">\n    <title lang="en">News hour/);

  // One bad block is dropped, not the whole station; a market file is checked strictly.
  assert.equal(normalizeStation({ id: 'x', url: 'https://x.example/', schedule: [{ days: 'daily', start: '6:00', end: '07:00' }, { days: 'daily', start: '18:00', end: '18:30' }] }).schedule.length, 1);
  assert.throws(() => normalizeSchedule([{ days: 'daily', start: '6:00', end: '07:00' }], 'x', { strict: true }), /HH:MM/);

  // A station without a schedule never touches the time zone, so an unknown one can't break the guide.
  assert.match(buildXmltv([normalizeStation({ id: 'plain', name: 'Plain', url: 'https://x.example/' })], { hours: 2, timeZone: 'Not/AZone' }), /Live: Plain/);
});

test('bundled market: logos for every station, and schedules that pass the strict check', async () => {
  const { readFile } = await import('node:fs/promises');
  const { normalizeSchedule } = await import('../src/stations.js');
  const m = JSON.parse(await readFile(new URL('../markets/denver.json', import.meta.url), 'utf8'));
  for (const s of m.stations) {
    assert.match(s.logo || '', /^https:\/\//, `${s.id} logo`);
    assert.equal(normalizeSchedule(s.schedule, s.id, { strict: true }).length, (s.schedule || []).length);
  }
  assert.ok(m.stations.find(s => s.id === 'koat').schedule.length > 0);
});

test('guide time zone: TZ wins, else the plugin\'s market, else the market file\'s', async () => {
  const http = await import('node:http');
  const { createApp } = await import('../src/app.js');
  const { normalizeStation } = await import('../src/stations.js');
  const station = normalizeStation({ id: 'news', name: 'News', url: 'https://x.example/', schedule: [{ days: 'daily', start: '17:00', end: '17:30', title: 'News at 5' }] });
  const store = { stations: [station], sports: { enabled: false, teams: [], timezone: 'America/New_York' }, enabled: () => [station], get: () => station };
  const guide = async config => {
    const app = createApp({ store, resolver: { resolve: async () => { throw new Error('unused'); } }, config, log: {}, now: () => Date.UTC(2026, 9, 28, 18) });
    const server = http.createServer(app.handler);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try { return await (await fetch(`http://127.0.0.1:${server.address().port}/guide.xml?hours=12`)).text(); } finally { server.close(); }
  };
  // 17:00 New York (EDT) = 21:00 UTC; 17:00 Denver (MDT) = 23:00 UTC.
  assert.match(await guide({ timezone: 'America/Denver' }), /start="20261028210000 \+0000"[^>]*>\n    <title lang="en">News at 5/);
  assert.match(await guide({ timezone: 'America/Denver', timezoneFromEnv: true }), /start="20261028230000 \+0000"[^>]*>\n    <title lang="en">News at 5/);
});
