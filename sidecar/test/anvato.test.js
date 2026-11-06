import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AnvatoSources, anvatoManifests, anvatoRequestUrl, anvatoSource, isAnvatoHost, parseAnvato } from '../src/anvato.js';
import { Resolver } from '../src/resolver.js';

const SOURCE = { host: 'tkx.mp.lura.live', videoId: 'abcDEF123', key: 'publicKey12345678' };
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\nhttps://cdn.mp.lura.live/play/1/rendition.m3u8?track=video-0\n';
const LIVE = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:6,\nseg100.ts\n';
const VOD = `${LIVE}#EXT-X-ENDLIST\n`;
const jsonp = urls => `anvatoVideoJSONLoaded(${JSON.stringify({ def_callsign: 'KTST', published_urls: urls.map(u => ({ embed_url: u })) })})`;

// A fetch that answers from a table of URL prefixes, and records what was asked.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers || {} });
    const hit = Object.entries(routes).find(([prefix]) => String(url).startsWith(prefix));
    if (!hit) return new Response('not found', { status: 404 });
    const [status, body] = typeof hit[1] === 'string' ? [200, hit[1]] : hit[1];
    return new Response(body, { status });
  };
  return { impl, calls };
}

const station = { id: 'ktst', url: 'https://station.example/live/' };

test('anvatoSource reads the video ID and access key, from Anvato hosts only', () => {
  assert.deepEqual(anvatoSource('https://tkx.mp.lura.live/rest/v2/mcp/video/abcDEF123?anvack=publicKey12345678&ads.x=1'), SOURCE);
  assert.deepEqual(anvatoSource('https://tkx.api.anvato.net/rest/v2/mcp/video/abcDEF123?anvack=publicKey12345678')?.host, 'tkx.api.anvato.net');
  assert.equal(anvatoSource('https://lura.live.evil.example/rest/v2/mcp/video/abcDEF123?anvack=publicKey12345678'), null);
  assert.equal(anvatoSource('http://tkx.mp.lura.live/rest/v2/mcp/video/abcDEF123?anvack=publicKey12345678'), null);
  assert.equal(anvatoSource('https://tkx.mp.lura.live/rest/v2/mcp/video/abcDEF123'), null);
  assert.equal(anvatoSource('https://tkx.mp.lura.live/rest/v2/mcp/video/abc/../x?anvack=publicKey12345678'), null);
  assert.equal(anvatoSource('not a url'), null);
  assert.ok(isAnvatoHost('https://dcs4-live.mp.lura.live/server/play/x/manifest.m3u8'));
  assert.ok(!isAnvatoHost('https://cdn.example/manifest.m3u8'));
});

test('the request sends only the video ID and access key', () => {
  assert.equal(anvatoRequestUrl(SOURCE), 'https://tkx.mp.lura.live/rest/v2/mcp/video/abcDEF123?anvack=publicKey12345678');
});

test('parseAnvato reads JSONP and JSON; anvatoManifests keeps https HLS URLs', () => {
  const data = parseAnvato(jsonp(['https://a.mp.lura.live/m.m3u8?x=1', 'http://b/m.m3u8', 'https://c/clip.mp4', 'https://a.mp.lura.live/m.m3u8?x=1']));
  assert.equal(data.def_callsign, 'KTST');
  assert.deepEqual(anvatoManifests(data), ['https://a.mp.lura.live/m.m3u8?x=1']);
  assert.deepEqual(parseAnvato('{"a":1}'), { a: 1 });
  assert.equal(parseAnvato('<html>blocked</html>'), null);
  assert.deepEqual(anvatoManifests(null), []);
});

test('fast path: a learned source answers without the browser', async () => {
  const anvato = new AnvatoSources({ log: {} });
  await anvato.remember(station.url, [SOURCE]);
  const { impl, calls } = fakeFetch({
    'https://tkx.mp.lura.live/rest/v2/mcp/video/': jsonp(['https://dcs.mp.lura.live/server/play/1/manifest.m3u8?encp=t']),
    'https://dcs.mp.lura.live/server/play/1/manifest.m3u8': MASTER,
    'https://cdn.mp.lura.live/play/1/rendition.m3u8': LIVE,
  });
  const resolver = new Resolver({ scraperPath: '/nonexistent', ytDlp: '', anvato, fetchImpl: impl, log: {} });
  resolver.resolvePage = () => assert.fail('the page should not be opened');
  const r = await resolver.resolve(station);
  assert.equal(r.via, 'anvato');
  assert.equal(r.type, 'hls');
  assert.equal(r.url, 'https://dcs.mp.lura.live/server/play/1/manifest.m3u8?encp=t');
  assert.equal(r.headers.referer, station.url);
  assert.equal(calls[0].url, anvatoRequestUrl(SOURCE));
  assert.equal(calls[0].headers.cookie, undefined);
});

test('fast path: a stream that is not live is forgotten and the page is opened', async () => {
  const anvato = new AnvatoSources({ log: {} });
  await anvato.remember(station.url, [SOURCE]);
  const { impl } = fakeFetch({
    'https://tkx.mp.lura.live/rest/v2/mcp/video/': jsonp(['https://dcs.mp.lura.live/clip.m3u8']),
    'https://dcs.mp.lura.live/clip.m3u8': VOD,
  });
  const resolver = new Resolver({ scraperPath: '/nonexistent', ytDlp: '', anvato, fetchImpl: impl, log: {} });
  resolver.resolvePage = async () => ({ via: 'page' });
  assert.equal((await resolver.resolve(station)).via, 'page');
  assert.deepEqual(anvato.get(station.url), []);
});

test('fast path: an HTTP error from Anvato falls back to the page', async () => {
  const anvato = new AnvatoSources({ log: {} });
  await anvato.remember(station.url, [SOURCE]);
  const { impl } = fakeFetch({ 'https://tkx.mp.lura.live/': [403, 'denied'] });
  const resolver = new Resolver({ scraperPath: '/nonexistent', ytDlp: '', anvato, fetchImpl: impl, log: {} });
  resolver.resolvePage = async () => ({ via: 'page' });
  assert.equal((await resolver.resolve(station)).via, 'page');
});

test('fast path is skipped for signed-in stations, unknown stations and when off', async () => {
  const anvato = new AnvatoSources({ log: {} });
  await anvato.remember(station.url, [SOURCE]);
  const { impl, calls } = fakeFetch({});
  const resolver = new Resolver({ scraperPath: '/nonexistent', ytDlp: '', anvato, fetchImpl: impl, log: {} });
  resolver.resolvePage = async () => ({ via: 'page' });
  assert.equal((await resolver.resolve(station, { username: 'u', password: 'p' })).via, 'page');
  assert.equal((await resolver.resolve({ id: 'other', url: 'https://x.example/' })).via, 'page');
  assert.equal(calls.length, 0);

  const off = new Resolver({ scraperPath: '/nonexistent', ytDlp: '', anvato: false, fetchImpl: impl, log: {} });
  off.resolvePage = async () => ({ via: 'page' });
  assert.equal((await off.resolve(station)).via, 'page');
  assert.equal(calls.length, 0);
});

test('AnvatoSources keeps the newest first, at most three, and survives a restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anvato-'));
  try {
    const file = path.join(dir, 'anvato.json');
    const a = await new AnvatoSources({ file, log: {} }).load();
    const s = n => ({ ...SOURCE, videoId: `video${n}` });
    await a.remember('k', [s(1)]);
    await a.remember('k', [s(2), s(3)]);
    await a.remember('k', [s(4), s(1)]);
    assert.deepEqual(a.get('k').map(x => x.videoId), ['video4', 'video1', 'video2']);
    const b = await new AnvatoSources({ file, log: {} }).load();
    assert.deepEqual(b.get('k').map(x => x.videoId), ['video4', 'video1', 'video2']);
    await b.forget('k', s(1));
    assert.deepEqual(b.get('k').map(x => x.videoId), ['video4', 'video2']);
    assert.ok(!(await readFile(file, 'utf8')).includes('video1'));

    // A stored host that isn't Anvato's is dropped on load.
    await writeFile(file, JSON.stringify({ k: [{ ...SOURCE, host: 'evil.example' }, s(5)] }));
    const c = await new AnvatoSources({ file, log: {} }).load();
    assert.deepEqual(c.get('k').map(x => x.videoId), ['video5']);

    // A damaged file is set aside, not fatal.
    await writeFile(file, '{oops');
    const d = await new AnvatoSources({ file, log: {} }).load();
    assert.deepEqual(d.get('k'), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('learning keeps only the Anvato video whose answer is the stream the page played', async () => {
  const anvato = new AnvatoSources({ log: {} });
  const clip = { ...SOURCE, videoId: 'clipVideo1' };
  const other = { ...SOURCE, videoId: 'otherLive1' };
  const { impl } = fakeFetch({
    [anvatoRequestUrl(SOURCE)]: jsonp(['https://dcs.mp.lura.live/server/play/LIVE1/manifest.m3u8?encp=a']),
    [anvatoRequestUrl(clip)]: jsonp(['https://dcs.mp.lura.live/clips/9/master.m3u8']),
    [anvatoRequestUrl(other)]: jsonp(['https://dcs.mp.lura.live/server/play/LIVE2/manifest.m3u8?encp=b']),
  });
  const resolver = new Resolver({ scraperPath: '/nonexistent', ytDlp: '', anvato, fetchImpl: impl, log: {} });
  await resolver.learnAnvato(station, [clip, other, SOURCE], 'https://dcs4-live.mp.lura.live/server/play/LIVE1/manifest.m3u8?encp=z&anvauth=x');
  assert.deepEqual(anvato.get(station.url), [SOURCE]);

  await resolver.learnAnvato({ ...station, url: 'https://other.example/' }, [clip], 'https://dcs.mp.lura.live/server/play/LIVE1/manifest.m3u8');
  assert.deepEqual(anvato.get('https://other.example/'), []);
});

test('a Resolver made without an anvato option gets an in-memory store', () => {
  const resolver = new Resolver({ scraperPath: '/nonexistent', ytDlp: '', log: {} });
  assert.ok(resolver.anvato instanceof AnvatoSources);
  assert.equal(new Resolver({ scraperPath: '/nonexistent', anvato: false }).anvato, null);
});
