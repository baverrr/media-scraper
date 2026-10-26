import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildM3u, buildXmltv } from '../src/guide.js';
import { normalizeStations, normalizeSports, loadMarket } from '../src/stations.js';
import { pickBest, mergeCandidates, scoreCandidate, pickHeaders } from '../src/pick.js';

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
  assert.deepEqual(s, { enabled: true, channel: '1.1', teams: [{ league: 'nfl', team: 'den', name: 'Broncos' }] });
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
