// M3U playlist and XMLTV guide for Jellyfin's M3U tuner and XMLTV listings provider.

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
    start: game.event.start,
    stop: game.event.end,
    title: game.event.title,
    subTitle: forSportsChannel ? `On ${where}` : game.event.team,
    desc: `${game.event.team}, live on ${where}'s over-the-air broadcast. The station's web stream may show its own `
      + 'programming instead when the network or league does not allow the game online.',
    categories: ['Sports', 'Sports event'],
    live: true,
  };
}

// Placeholder schedule: back-to-back "Live: <station>" blocks aligned to the hour, starting one
// block before now so the current block always exists. Local games (`games`: [{ event, station }])
// replace the blocks on their station and fill the Local Sports channel when it's in the list.
export function buildXmltv(stations, { now = Date.now(), hours = 48, blockMinutes = 60, games = [] } = {}) {
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
    const own = nonOverlapping(inWindow.filter(g => isSports || g.station.id === s.id).map(g => gameSlot(g, isSports)))
      .map(p => ({ ...p, start: Math.max(p.start, start), stop: Math.min(p.stop, end) }))
      .filter(p => p.start < p.stop);
    const placeholder = (a, b) => (isSports
      ? { start: a, stop: b, title: 'No local game on the air', desc: 'Local teams\' games appear here while a station is broadcasting them.', categories: ['Sports'], live: false }
      : {
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
