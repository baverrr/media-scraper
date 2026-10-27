// Looping slates: live HLS streams of a still card, played instead of a playback error.
// - "Nothing is streaming right now" on a station whose page has no stream at the moment (assets/slate.ts,
//   one 6-second clip, from assets/slate.svg).
// - "No local game on the air" on the Local Sports channel between games (assets/off-air/<n>.ts, one minute cut into
//   ten 6-second segments with continuous timestamps, see assets/off-air/README.md).
// The playlist slides a short window along the clock and numbers segments without end. Segment i is clip
// i % clips.length with its timestamps moved on by one full pass of the clips per repeat, so the stream's
// clock never goes back: a jump back (each repeat starting its timestamps over) makes Jellyfin's ffmpeg stall,
// discontinuity tags or not.
import { readFileSync } from 'node:fs';

const WINDOW = 3;
const WRAP = 2 ** 33; // PTS, DTS and PCR base are 33-bit

// A live media playlist for the time `nowMs`, of segments `seconds` long. `segmentUrl(i)` gives the
// address of segment i.
export function loopPlaylist(nowMs, seconds, segmentUrl) {
  // The window ends WINDOW segments past now and starts as far before it, so a player that starts
  // WINDOW from the end begins now, and one that falls behind has that long before its segments expire.
  const now = Math.floor(nowMs / 1000 / seconds);
  const seq = Math.max(0, now - WINDOW);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${seconds}`, `#EXT-X-MEDIA-SEQUENCE:${seq}`];
  for (let i = seq; i < now + WINDOW; i++) lines.push(`#EXTINF:${seconds}.000,`, segmentUrl(i));
  return lines.join('\n') + '\n';
}

// 33-bit timestamp in the 5-byte PTS/DTS layout at buf[o], moved on by `add` ticks.
function shiftTimestamp(buf, o, add) {
  const t = (buf[o] >> 1 & 0x07) * 2 ** 30 + (buf[o + 1] << 22 | (buf[o + 2] >> 1) << 15 | buf[o + 3] << 7 | buf[o + 4] >> 1);
  const v = (t + add) % WRAP;
  buf[o] = (buf[o] & 0xf1) | (Math.floor(v / 2 ** 30) & 0x07) << 1;
  buf[o + 1] = Math.floor(v / 2 ** 22) & 0xff;
  buf[o + 2] = (Math.floor(v / 2 ** 15) & 0x7f) << 1 | 1;
  buf[o + 3] = Math.floor(v / 2 ** 7) & 0xff;
  buf[o + 4] = (v & 0x7f) << 1 | 1;
}

// PCR at buf[o] (33-bit base, 6 reserved bits, 9-bit extension), base moved on by `add` ticks.
function shiftPcr(buf, o, add) {
  const base = buf[o] * 2 ** 25 + (buf[o + 1] << 17 | buf[o + 2] << 9 | buf[o + 3] << 1 | buf[o + 4] >> 7);
  const v = (base + add) % WRAP;
  buf[o] = Math.floor(v / 2 ** 25) & 0xff;
  buf[o + 1] = Math.floor(v / 2 ** 17) & 0xff;
  buf[o + 2] = Math.floor(v / 2 ** 9) & 0xff;
  buf[o + 3] = Math.floor(v / 2) & 0xff;
  buf[o + 4] = (v & 1) << 7 | (buf[o + 4] & 0x7f);
}

// Copy of an MPEG-TS buffer with every PCR, PTS and DTS moved on by `add` ticks (90 kHz), and each
// PID's continuity counter moved on by ccAdd[pid] (so a repeat carries on from the last pass instead
// of starting the counters over, which players report as corrupt packets).
export function shiftTs(src, add, ccAdd = null) {
  const buf = Buffer.from(src);
  if (!add && !ccAdd) return buf;
  for (let p = 0; p + 188 <= buf.length; p += 188) {
    if (buf[p] !== 0x47) continue;
    const start = buf[p + 1] & 0x40;
    const afc = buf[p + 3] >> 4 & 0x3;
    const pid = (buf[p + 1] & 0x1f) << 8 | buf[p + 2];
    if (ccAdd?.[pid] && afc & 0x1) buf[p + 3] = (buf[p + 3] & 0xf0) | ((buf[p + 3] & 0x0f) + ccAdd[pid]) % 16;
    let o = p + 4;
    if (afc & 0x2) { // adaptation field
      const len = buf[o];
      if (len > 0 && buf[o + 1] & 0x10) shiftPcr(buf, o + 2, add);
      o += 1 + len;
    }
    // PES header: 00 00 01, stream id, length, flags, flags (PTS/DTS), header length, timestamps
    if (start && afc & 0x1 && o + 14 <= p + 188 && buf[o] === 0 && buf[o + 1] === 0 && buf[o + 2] === 1) {
      const flags = buf[o + 7] >> 6;
      if (flags & 0x2) shiftTimestamp(buf, o + 9, add);
      if (flags === 0x3) shiftTimestamp(buf, o + 14, add);
    }
  }
  return buf;
}

// gcd(n, 2^33) for a positive integer n.
function gcdPow2(n) {
  let g = 1;
  while (n % 2 === 0 && g < WRAP) { n /= 2; g *= 2; }
  return g;
}

// Segment i (any i >= 0) of a loop of `clips` (MPEG-TS buffers, `seconds` long each, timestamps continuous
// from one to the next): clip i % clips.length, moved on by one pass of all clips per repeat.
export function loopSegment(clips, seconds, i) {
  const pass = clips.length * seconds * 90_000;
  // The offset comes round again after WRAP / gcd(pass, WRAP) repeats; reducing the repeat count by that
  // first keeps the product exact for any i.
  const loops = Math.floor(i / clips.length);
  const repeats = loops % (WRAP / gcdPow2(pass));
  const perPass = payloadPackets(clips);
  const ccAdd = {};
  for (const [pid, n] of Object.entries(perPass)) ccAdd[pid] = (loops % 16) * n % 16;
  return shiftTs(clips[i % clips.length], repeats * pass % WRAP, ccAdd);
}

// Packets carrying a payload, per PID, in one pass of the clips: how far each continuity counter
// moves per pass.
const counted = new WeakMap();
function payloadPackets(clips) {
  if (counted.has(clips)) return counted.get(clips);
  const n = {};
  for (const clip of clips) {
    for (let p = 0; p + 188 <= clip.length; p += 188) {
      if (clip[p] !== 0x47 || !(clip[p + 3] >> 4 & 0x1)) continue;
      const pid = (clip[p + 1] & 0x1f) << 8 | clip[p + 2];
      n[pid] = (n[pid] || 0) + 1;
    }
  }
  counted.set(clips, n);
  return n;
}

// The Local Sports off-air card: ten 6-second segments.
export const OFF_AIR_SECONDS = 6;
export const OFF_AIR_SEGMENTS = 10;
let offAir = null;
export const offAirClips = () => (offAir ??= Array.from({ length: OFF_AIR_SEGMENTS },
  (_, n) => readFileSync(new URL(`../assets/off-air/${n}.ts`, import.meta.url))));
