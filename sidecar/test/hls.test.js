import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  proxyExtension, isDrm, isHls, isLivePlaylist, parseVariants, pickVariant, chosenVariantUrl, renditionUrls,
  rewriteMaster, rewriteMedia, expiryFromUrl,
} from '../src/hls.js';

const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"',
  'v360.m3u8?token=a',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"',
  'v1080.m3u8?token=a',
  '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160,AUDIO="aud"',
  'v2160.m3u8?token=a',
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframes.m3u8"',
].join('\n');

test('recognises playlists, including with a byte-order mark', () => {
  assert.ok(isHls('#EXTM3U\n'));
  assert.ok(isHls('\uFEFF#EXTM3U\n'));
  assert.ok(!isHls('<html>'));
});

test('live vs VOD media playlists', () => {
  assert.equal(isLivePlaylist('#EXTM3U\n#EXTINF:4,\na.ts\n'), true);
  assert.equal(isLivePlaylist('#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n'), false);
  assert.equal(isLivePlaylist('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n'), false);
});

test('picks the tallest variant that fits, else the smallest', () => {
  const variants = parseVariants(MASTER);
  assert.equal(variants.length, 3);
  assert.equal(pickVariant(variants, 1080).height, 1080);
  assert.equal(pickVariant(variants, 720).height, 360);
  assert.equal(pickVariant(variants, 100).height, 360);
  assert.equal(chosenVariantUrl(MASTER, 'https://cdn.example/live/master.m3u8', 1080), 'https://cdn.example/live/v1080.m3u8?token=a');
});

test('master rewrite keeps one variant with stable sidecar URLs', () => {
  const out = rewriteMaster(MASTER, { maxHeight: 1080, variantUrl: '/hls/k/v.m3u8', renditionUrl: n => `/hls/k/r/${n}.m3u8` });
  assert.match(out, /RESOLUTION=1920x1080/);
  assert.doesNotMatch(out, /640x360|3840x2160|I-FRAME/);
  assert.match(out, /\n\/hls\/k\/v\.m3u8(\n|$)/);
  assert.match(out, /URI="\/hls\/k\/r\/0\.m3u8"/);
  assert.deepEqual(renditionUrls(MASTER, 'https://cdn.example/live/master.m3u8'), ['https://cdn.example/live/audio/en.m3u8']);
});

test('media rewrite proxies segments, keys and init sections', () => {
  const media = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="../keys/k1"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4,',
    'seg1.ts?sig=x',
    '#EXT-X-RENDITION-REPORT:URI="../v360.m3u8",LAST-MSN=9',
  ].join('\n');
  const out = rewriteMedia(media, 'https://cdn.example/live/v/', (abs, kind) => `P(${kind}:${abs})`);
  assert.match(out, /URI="P\(key:https:\/\/cdn\.example\/live\/keys\/k1\)"/);
  assert.match(out, /URI="P\(map:https:\/\/cdn\.example\/live\/v\/init\.mp4\)"/);
  assert.match(out, /^P\(segment:https:\/\/cdn\.example\/live\/v\/seg1\.ts\?sig=x\)$/m);
  assert.doesNotMatch(out, /RENDITION-REPORT/);
});

test('reads expiry from common signed-URL formats', () => {
  assert.equal(expiryFromUrl('https://a/x.m3u8?exp=1800000000'), 1800000000000);
  assert.equal(expiryFromUrl('https://a/x.m3u8?expires=1800000000123'), 1800000000123);
  assert.equal(expiryFromUrl('https://a/x.m3u8?hdnts=st=1~exp=1800000001~acl=*'), 1800000001000);
  assert.equal(expiryFromUrl('https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1800000002/ei/x/index.m3u8'), 1800000002000);
  assert.equal(expiryFromUrl('https://a/x.m3u8?e=5'), null); // too small to be a timestamp
  assert.equal(expiryFromUrl('https://a/x.m3u8'), null);
});

test('master rewrite drops vendor and media-playlist tags (ffmpeg rejects them in a master)', () => {
  const uplynk = '#EXTM3U\n#EXT-X-VERSION:5\n#EXT-UPLYNK-LIVE\n#EXT-X-START:TIME-OFFSET=0.00\n#EXT-X-INDEPENDENT-SEGMENTS\n#UPLYNK-MEDIA0:1920x1080x29\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080\nhi.m3u8\n';
  const out = rewriteMaster(uplynk, { variantUrl: '/v', renditionUrl: n => `/r/${n}` });
  assert.equal(out, '#EXTM3U\n#EXT-X-VERSION:5\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080\n/v\n');
});

test('proxy URLs end in a media extension', () => {
  assert.equal(proxyExtension('https://a/x/seg-1.TS?t=1'), 'ts');
  assert.equal(proxyExtension('https://a/x/chunk.m4s'), 'm4s');
  assert.equal(proxyExtension('https://cf.cdn.uplynk.com/ause1/slices/3bd/abc/def'), 'ts');
  assert.equal(proxyExtension('https://a/check2?b=1', 'key'), 'key');
  assert.equal(proxyExtension('https://a/init', 'map'), 'mp4');
});

test('DRM is detected; AES-128 with a key URL is not DRM', () => {
  assert.ok(isDrm('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://drmtoday?x",KEYFORMAT="com.apple.streamingkeydelivery"\n'));
  assert.ok(isDrm('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="data:x"\n'));
  assert.ok(isDrm('<MPD><Period><AdaptationSet><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/></AdaptationSet></Period></MPD>'));
  assert.ok(!isDrm('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://k/check?b=1"\n#EXTINF:2,\na.ts\n'));
});

test('non-http key URIs are left alone', () => {
  const out = rewriteMedia('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AA"\n#EXTINF:2,\na.ts\n', 'https://c/v/', (a, k) => `P(${k}:${a})`);
  assert.match(out, /URI="skd:\/\/x"/);
  assert.match(out, /URI="data:text\/plain;base64,AA"/);
  assert.match(out, /^P\(segment:https:\/\/c\/v\/a\.ts\)$/m);
});

test('reads Wowza and Edgecast token expiries', () => {
  assert.equal(expiryFromUrl('https://wz/a.m3u8?wowzatokenstarttime=1&wowzatokenendtime=1800000000&wowzatokenhash=h'), 1_800_000_000_000);
  assert.equal(expiryFromUrl('https://ec/a.m3u8?ec_expire=1800000000&ec_hash=h'), 1_800_000_000_000);
});

test('expiry: a past value does not hide a real one when now is given', () => {
  const url = 'https://a/x.m3u8?e=1600000000&exp=1800000000';
  assert.equal(expiryFromUrl(url), 1_600_000_000_000); // without now: the earliest
  assert.equal(expiryFromUrl(url, 1_700_000_000_000), 1_800_000_000_000);
  assert.equal(expiryFromUrl('https://a/x.m3u8?e=1600000000', 1_700_000_000_000), null);
});
