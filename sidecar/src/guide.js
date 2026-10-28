// M3U playlist and XMLTV guide for Jellyfin's M3U tuner and XMLTV listings provider.

import { LEAD_MS } from './sports.js';

export const SPORTS_ID = 'local-sports';

function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// M3U attribute values can't contain double quotes or line breaks.
function attr(value) {
  return String(value ?? '').replace(/["\r\n]/g, ' ').trim();
}

export function displayName(station) {
  return station.callSign && station.name && station.name !== station.callSign
    ? `${station.name} (${station.callSign})`
    : station.name || station.callSign || station.id;
}

// The virtual channel that always plays whichever station is airing a local game.
export function sportsChannel(sports) {
  return { id: SPORTS_ID, name: 'Local Sports', callSign: '', channel: sports?.channel || '1.1', network: 'Sports', logo: null };
}

export function buildM3u(stations, baseUrl, group = 'Local Broadcast') {
  const lines = ['#EXTM3U'];
  for (const s of stations) {
    const tags = [
      `tvg-id="${attr(s.id)}"`,
      `tvg-name="${attr(displayName(s))}"`,
      s.channel ? `tvg-chno="${attr(s.channel)}"` : null,
      s.logo ? `tvg-logo="${attr(s.logo)}"` : null,
      `group-title="${attr(s.id === SPORTS_ID ? 'Local Sports' : group)}"`,
    ].filter(Boolean);
    lines.push(`#EXTINF:-1 ${tags.join(' ')},${attr(displayName(s))}`);
    lines.push(`${baseUrl}/stream/${encodeURIComponent(s.id)}.m3u8`);
  }
  return lines.join('\n') + '\n';
}

// XMLTV timestamps: YYYYMMDDhhmmss +0000
function xmltvTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
}

// Non-overlapping slots: earlier games win, later ones start when the previous ends.
function nonOverlapping(slots) {
  const out = [];
  for (const s of [...slots].sort((a, b) => a.start - b.start)) {
    const start = out.length ? Math.max(s.start, out[out.length - 1].stop) : s.start;
    if (start < s.stop) out.push({ ...s, start });
  }
  return out;
}

// Placeholder blocks aligned to `block`, covering [from, to) except where `taken` slots are.
function fill(taken, from, to, block, make) {
  const out = [];
  let t = from;
  for (const slot of [...taken, { start: to, stop: to }]) {
    while (t < slot.start) {
      const next = Math.min(Math.floor(t / block) * block + block, slot.start);
      out.push(make(t, next));
      t = next;
    }
    t = Math.max(t, slot.stop);
  }
  return out;
}

function programme(channelId, p) {
  return [
    `  <programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.stop)}" channel="${xml(channelId)}">`,
    `    <title lang="en">${xml(p.title)}</title>`,
    p.subTitle ? `    <sub-title lang="en">${xml(p.subTitle)}</sub-title>` : null,
    `    <desc lang="en">${xml(p.desc)}</desc>`,
    ...p.categories.map(c => `    <category lang="en">${xml(c)}</category>`),
    p.live ? '    <live />' : null,
    '  </programme>',
  ].filter(Boolean);
}

function gameSlot(game, forSportsChannel) {
  const where = displayName(game.station);
  return {
    // Local Sports switches to the station LEAD_MS before the start (pre-game), so its guide does
    // too; otherwise it says "No local game on the air" while showing one.
    start: forSportsChannel ? game.event.start - LEAD_MS : game.event.start,
    stop: game.event.end,
    title: game.event.title,
    subTitle: forSportsChannel ? `On ${where}` : game.event.team,
    desc: `${game.event.team}, live on ${where}'s over-the-air broadcast. The station's web stream may show its own `
      + 'programming instead when the network or league does not allow the game online.',
    categories: ['Sports', 'Sports event'],
    live: true,
  };
}

// The offset of `timeZone` from UTC at `ms`, in ms.
function zoneOffset(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(ms / 1000) * 1000;
}

// UTC ms of a wall-clock time in `timeZone`. A time repeated when clocks go back is the first one; a
// time skipped when they go forward lands an hour later (02:30 on the spring-forward day is 03:30).
export function zonedTime(y, m, d, hh, mm, timeZone) {
  const wall = Date.UTC(y, m, d, hh, mm);
  const offsets = [...new Set([zoneOffset(wall - 86_400_000, timeZone), zoneOffset(wall + 86_400_000, timeZone)])];
  const fits = offsets.map(o => wall - o).filter(t => t + zoneOffset(t, timeZone) === wall);
  // In a gap neither offset fits: the earlier (pre-change) one puts it after the gap.
  return fits.length ? Math.min(...fits) : wall - Math.min(...offsets);
}

// A station's newscasts (normalizeSchedule) as slots in [from, to), in `timeZone`.
export function newscastSlots(station, from, to, timeZone) {
  if (!station.schedule?.length) return [];
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' });
  const seen = new Set();
  const out = [];
  for (let t = from - 86_400_000; t < to + 86_400_000; t += 21_600_000) { // every 6 h: no day missed across DST
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value]));
    const key = `${p.year}-${p.month}-${p.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const day = p.weekday.toLowerCase().slice(0, 3);
    for (const b of station.schedule || []) {
      if (!b.days.includes(day)) continue;
      const [sh, sm] = b.start.split(':').map(Number);
      const [eh, em] = b.end.split(':').map(Number);
      const start = zonedTime(+p.year, p.month - 1, +p.day, sh, sm, timeZone);
      // At least its listed length: a block inside the spring-forward gap moves an hour later whole.
      const minutes = (eh * 60 + em - (sh * 60 + sm) + 1440) % 1440;
      const stop = Math.max(zonedTime(+p.year, p.month - 1, +p.day + (b.end <= b.start ? 1 : 0), eh, em, timeZone), start + minutes * 60_000);
      if (stop > from && start < to) {
        out.push({ start, stop, title: b.title, desc: `Live on ${displayName(station)}'s web stream.`, categories: ['News'], live: true });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// `slots` with the time `taken` cut out of them (split where a taken slot is in the middle).
function without(slots, taken) {
  let out = slots;
  for (const t of taken) {
    out = out.flatMap(s => (t.stop <= s.start || t.start >= s.stop ? [s]
      : [{ ...s, stop: t.start }, { ...s, start: t.stop }].filter(p => p.start < p.stop)));
  }
  return out;
}

// Placeholder schedule: back-to-back "Live: <station>" blocks aligned to the hour, starting one
// block before now so the current block always exists. Local games (`games`: [{ event, station }])
// replace the blocks on their station and fill the Local Sports channel when it's in the list.
// A station with a newscast schedule shows its newscasts at their times, and "Not streaming" between
// them (in `timeZone`, the market's).
export function buildXmltv(stations, { now = Date.now(), hours = 48, blockMinutes = 60, games = [], timeZone } = {}) {
  const block = blockMinutes * 60_000;
  const start = Math.floor(now / block) * block - block;
  const end = now + hours * 3_600_000;
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="local-broadcast-sidecar">'];
  for (const s of stations) {
    out.push(`  <channel id="${xml(s.id)}">`);
    out.push(`    <display-name>${xml(displayName(s))}</display-name>`);
    if (s.channel) out.push(`    <display-name>${xml(s.channel)}</display-name>`);
    if (s.logo) out.push(`    <icon src="${xml(s.logo)}" />`);
    out.push('  </channel>');
  }
  const inWindow = games.filter(g => g.event.end > start && g.event.start < end);
  for (const s of stations) {
    const isSports = s.id === SPORTS_ID;
    const gameSlots = nonOverlapping(inWindow.filter(g => isSports || g.station.id === s.id).map(g => gameSlot(g, isSports)));
    // Newscasts give way to a game on the same station: cut around it.
    const newscasts = isSports ? [] : without(newscastSlots(s, start, end, timeZone), gameSlots);
    const own = nonOverlapping([...gameSlots, ...newscasts])
      .map(p => ({ ...p, start: Math.max(p.start, start), stop: Math.min(p.stop, end) }))
      .filter(p => p.start < p.stop);
    const scheduled = !isSports && s.schedule?.length > 0;
    const placeholder = (a, b) => (isSports
      ? { start: a, stop: b, title: 'No local game on the air', desc: 'Local teams\' games appear here while a station is broadcasting them.', categories: ['Sports'], live: false }
      : scheduled ? {
        start: a,
        stop: b,
        title: 'Not streaming',
        desc: `${s.name || s.callSign || s.id} streams only during its newscasts.`,
        categories: ['News'],
        live: false,
      } : {
        start: a,
        stop: b,
        title: `Live: ${s.name || s.callSign || s.id}`,
        desc: [s.network, s.callSign, 'live stream from the station\'s website'].filter(Boolean).join(' - '),
        categories: ['News'],
        live: true,
      });
    const all = [...own, ...fill(own, start, end, block, placeholder)].sort((a, b) => a.start - b.start);
    for (const p of all) out.push(...programme(s.id, p));
  }
  out.push('</tv>');
  return out.join('\n') + '\n';
}
