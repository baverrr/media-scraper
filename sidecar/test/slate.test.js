import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loopPlaylist, loopSegment, shiftTs, offAirClips, OFF_AIR_SECONDS, OFF_AIR_SEGMENTS } from '../src/slate.js';
import { SLATE_SECONDS } from '../src/app.js';

const stationClip = readFileSync(new URL('../assets/slate.ts', import.meta.url));

// First PTS and PCR in an MPEG-TS buffer, on the 90 kHz clock.
function first(buf) {
  let pts, pcr;
  for (let p = 0; p + 188 <= buf.length && (pts === undefined || pcr === undefined); p += 188) {
    const afc = buf[p + 3] >> 4 & 3;
    let o = p + 4;
    if (afc & 2) {
      if (pcr === undefined && buf[o] > 0 && buf[o + 1] & 0x10) pcr = buf[o + 2] * 2 ** 25 + (buf[o + 3] << 17 | buf[o + 4] << 9 | buf[o + 5] << 1 | buf[o + 6] >> 7);
      o += 1 + buf[o];
    }
    if (pts === undefined && buf[p + 1] & 0x40 && buf[o] === 0 && buf[o + 1] === 0 && buf[o + 2] === 1 && buf[o + 7] & 0x80) {
      pts = (buf[o + 9] >> 1 & 7) * 2 ** 30 + (buf[o + 10] << 22 | (buf[o + 11] >> 1) << 15 | buf[o + 12] << 7 | buf[o + 13] >> 1);
    }
  }
  return { pts, pcr };
}

test('loop playlist slides along the clock with ever-increasing segment numbers and no discontinuities', () => {
  const pl = loopPlaylist(78 * 6000 + 1500, 6, n => `s/${n}.ts`);
  assert.match(pl, /#EXT-X-MEDIA-SEQUENCE:78\n/);
  assert.match(pl, /#EXT-X-TARGETDURATION:6\n/);
  assert.deepEqual([...pl.matchAll(/^s\/(\d+)\.ts$/gm)].map(x => Number(x[1])), [78, 79, 80]);
  assert.doesNotMatch(pl, /DISCONTINUITY|ENDLIST/);
});

test('shiftTs moves every PTS and PCR and leaves the rest alone', () => {
  const add = 12_345 * 90_000;
  const out = shiftTs(stationClip, add);
  assert.equal(out.length, stationClip.length);
  assert.equal(first(out).pts - first(stationClip).pts, add);
  assert.equal(first(out).pcr - first(stationClip).pcr, add);
  assert.ok(shiftTs(stationClip, 0).equals(stationClip));
  // the input buffer is untouched
  assert.deepEqual(first(stationClip), first(Buffer.from(stationClip)));
});

test('station slate: each repeat of the one clip carries the clock on by the clip length', () => {
  const step = SLATE_SECONDS * 90_000;
  const a = first(loopSegment([stationClip], SLATE_SECONDS, 41));
  const b = first(loopSegment([stationClip], SLATE_SECONDS, 42));
  assert.equal(b.pts - a.pts, step);
  assert.equal(b.pcr - a.pcr, step);
});

test('Local Sports card: ten segments loop with the clock carried on one minute per pass', () => {
  const clips = offAirClips();
  assert.equal(clips.length, OFF_AIR_SEGMENTS);
  const pass = OFF_AIR_SEGMENTS * OFF_AIR_SECONDS * 90_000;
  const seg = i => first(loopSegment(clips, OFF_AIR_SECONDS, i));
  assert.equal(seg(3 + 5 * OFF_AIR_SEGMENTS).pts - seg(3).pts, 5 * pass);
  assert.equal(seg(3 + 5 * OFF_AIR_SEGMENTS).pcr - seg(3).pcr, 5 * pass);
  // the last segment of a pass runs straight on into the first of the next
  const end = seg(OFF_AIR_SEGMENTS - 1).pts, next = seg(OFF_AIR_SEGMENTS).pts;
  assert.ok(next > end && next - end <= (OFF_AIR_SECONDS + 1) * 90_000);
});

test('loop segments stay exact for very large segment numbers', () => {
  const clips = offAirClips();
  // the offset comes round again after 2^27 passes (one pass is 5,400,000 ticks = 2^6 x 84,375)
  assert.ok(loopSegment(clips, OFF_AIR_SECONDS, 4).equals(loopSegment(clips, OFF_AIR_SECONDS, 4 + OFF_AIR_SEGMENTS * 2 ** 27)));
  // and after 2^28 repeats of the 6-second station clip (540,000 ticks = 2^5 x 16,875)
  assert.ok(loopSegment([stationClip], SLATE_SECONDS, 7).equals(loopSegment([stationClip], SLATE_SECONDS, 7 + 2 ** 28)));
  for (const i of [999_999_999_999_999, 2 ** 52]) assert.equal(loopSegment(clips, OFF_AIR_SECONDS, i)[0], 0x47);
});
