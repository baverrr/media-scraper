// Finds a station's live stream: opens its page in headless Chromium with media-scraper.js
// loaded before the page's own scripts, records every manifest the page requests (with the
// headers it sent), presses play if nothing loads, then probes the candidates from Node and
// keeps the best live one. Pages that only embed YouTube/Twitch/etc. fall back to yt-dlp.
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { probeManifest } from './probe.js';
import { AD_RE, manifestTypeOf, mergeCandidates, pickBest, pickHeaders } from './pick.js';
import { expiryFromUrl } from './hls.js';

const run = promisify(execFile);

const PLAY_SELECTORS = [
  '.vjs-big-play-button',
  '.jw-display-icon-display',
  '.jw-icon-playback',
  'button[aria-label*="play" i]',
  '[role="button"][aria-label*="play" i]',
  '[class*="play-button" i]',
  '[class*="PlayButton"]',
  '[data-testid*="play" i]',
];

const EMBED_PROVIDERS = /youtube|twitch|kick|vimeo|dailymotion|facebook|rumble/i;

export class ResolveError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

function cookieHeader(cookies, url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  const matching = cookies.filter(c => {
    const d = c.domain.replace(/^\./, '');
    return host === d || host.endsWith('.' + d);
  });
  return matching.length ? matching.map(c => `${c.name}=${c.value}`).join('; ') : null;
}

export class Resolver {
  constructor({ scraperPath, ytDlp = 'yt-dlp', maxHeight = 1080, pageTimeoutMs = 45_000, waitMs = 20_000, channel = 'chrome', log = console } = {}) {
    this.scraperPath = scraperPath;
    this.channel = channel;
    this.ytDlp = ytDlp;
    this.maxHeight = maxHeight;
    this.pageTimeoutMs = pageTimeoutMs;
    this.waitMs = waitMs;
    this.log = log;
    this.browserPromise = null;
    this.scraperSource = null;
  }

  async browser() {
    if (!this.browserPromise) {
      const options = { args: ['--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled', '--mute-audio'] };
      // Prefer Google Chrome (has H.264/AAC); fall back to the bundled Chromium where it's missing.
      const launch = this.channel
        ? chromium.launch({ ...options, channel: this.channel }).catch(e => {
          this.log.warn?.(`browser channel "${this.channel}" unavailable (${e.message.split('\n')[0]}); using bundled Chromium`);
          return chromium.launch(options);
        })
        : chromium.launch(options);
      this.browserPromise = launch.then(b => {
        b.on('disconnected', () => { this.browserPromise = null; });
        return b;
      }, err => { this.browserPromise = null; throw err; });
    }
    return this.browserPromise;
  }

  async userAgent(browser) {
    // A regular desktop Chrome UA: some players refuse "HeadlessChrome".
    const major = (browser.version().match(/^(\d+)/) || [])[1] || '140';
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }

  async close() {
    if (this.browserPromise) {
      const b = await this.browserPromise.catch(() => null);
      this.browserPromise = null;
      await b?.close().catch(() => {});
    }
  }

  async resolve(station) {
    if (station.streamUrl) return this.resolveManual(station);
    if (!this.scraperSource) this.scraperSource = await readFile(this.scraperPath, 'utf8');
    const started = Date.now();
    const browser = await this.browser();
    const ua = await this.userAgent(browser);
    const context = await browser.newContext({
      userAgent: ua,
      locale: 'en-US',
      timezoneId: 'America/Denver',
      viewport: { width: 1280, height: 720 },
    });
    const found = [];
    const embeds = [];
    try {
      await context.addInitScript({ content: 'Object.defineProperty(navigator, "webdriver", { get: () => undefined });' });
      // Runs in every frame, cross-origin player iframes included, before the page's scripts.
      await context.addInitScript({ content: this.scraperSource });

      context.on('response', async res => {
        try {
          const url = res.url();
          const type = manifestTypeOf(url, res.headers()['content-type'] || '');
          if (!type || AD_RE.test(url)) return;
          found.push({ url, type, sources: ['network'], headers: pickHeaders(await res.request().allHeaders()) });
        } catch { /* page closed */ }
      });

      const page = await context.newPage();
      await page.goto(station.url, { waitUntil: 'domcontentloaded', timeout: this.pageTimeoutMs });

      // Wait for the player to request a manifest; nudge it with a play click if it doesn't.
      const deadline = Date.now() + this.waitMs;
      let clickedAt = 0;
      let firstSeen = 0;
      while (Date.now() < deadline) {
        await page.waitForTimeout(1000);
        if (found.length && !firstSeen) firstSeen = Date.now();
        if (firstSeen && Date.now() - firstSeen > 3000) break; // give master/variant requests a moment
        if (!found.length && !clickedAt && Date.now() - started > 7000) {
          clickedAt = Date.now();
          await this.pressPlay(page);
        }
      }

      for (const frame of page.frames()) {
        let items = [];
        try {
          items = await frame.evaluate(() => (window.MediaScraper
            ? window.MediaScraper.scan({ quiet: true, probe: false }).then(window.MediaScraper.toJSON)
            : []));
        } catch { continue; }
        for (const i of items) {
          if (i.manifest) found.push({ url: i.manifest, type: manifestTypeOf(i.manifest), sources: ['scan'], paired: true });
          if ((i.type === 'hls' || i.type === 'dash') && i.url && /^https?:/.test(i.url)) {
            found.push({ url: i.url, type: i.type, sources: [i.foundBy?.includes('network') ? 'network' : 'scan'] });
          }
          if (i.kind === 'embed' && i.url) embeds.push({ provider: i.provider, url: i.url, id: i.id });
        }
      }

      const cookies = await context.cookies();
      const candidates = mergeCandidates(found.filter(c => !AD_RE.test(c.url))).slice(0, 30);
      for (const c of candidates) {
        const headers = { 'user-agent': ua, referer: station.url, ...(c.headers || {}) };
        const cookie = cookieHeader(cookies, c.url);
        if (cookie && !headers.cookie) headers.cookie = cookie;
        c.headers = headers;
        c.probe = await probeManifest(c.url, headers, { maxHeight: this.maxHeight });
      }

      const best = pickBest(candidates);
      if (best) {
        const url = best.probe.finalUrl || best.url;
        return {
          url,
          type: best.type || (best.probe.dash ? 'dash' : 'hls'),
          headers: best.headers,
          via: 'page',
          expiresAt: expiryFromUrl(url),
          resolvedAt: Date.now(),
          tookMs: Date.now() - started,
        };
      }

      for (const e of embeds) {
        if (!this.ytDlp || !EMBED_PROVIDERS.test(e.provider || '')) continue;
        const viaYtDlp = await this.fromYtDlp(e.url).catch(() => null);
        if (viaYtDlp) return { ...viaYtDlp, via: `yt-dlp (${e.provider})`, resolvedAt: Date.now(), tookMs: Date.now() - started };
      }

      const drmOnly = candidates.length > 0 && candidates.some(c => c.probe?.drm) && !candidates.some(c => c.probe?.ok);
      throw new ResolveError(drmOnly ? 'The station\'s stream is DRM-protected; Jellyfin can\'t play it' : 'No live stream found on the page', {
        candidates: candidates.map(c => ({ url: c.url, sources: c.sources, paired: !!c.paired, probe: c.probe })),
        embeds,
        tookMs: Date.now() - started,
      });
    } finally {
      await context.close().catch(() => {});
    }
  }

  // A station with a manual stream URL: use it directly when it's a live manifest, otherwise let
  // yt-dlp resolve it (a page it has an extractor for). No browser involved.
  async resolveManual(station) {
    const started = Date.now();
    const headers = {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      referer: station.url,
    };
    const probe = await probeManifest(station.streamUrl, headers, { maxHeight: this.maxHeight });
    if (probe.ok && probe.live) {
      const url = probe.finalUrl || station.streamUrl;
      return { url, type: probe.dash ? 'dash' : 'hls', headers, via: 'manual URL', expiresAt: expiryFromUrl(url), resolvedAt: Date.now(), tookMs: Date.now() - started };
    }
    if (this.ytDlp) {
      const viaYtDlp = await this.fromYtDlp(station.streamUrl).catch(() => null);
      if (viaYtDlp) return { ...viaYtDlp, via: 'manual URL (yt-dlp)', resolvedAt: Date.now(), tookMs: Date.now() - started };
    }
    throw new ResolveError(`Manual stream URL is not a live stream: ${probe.ok ? 'not live' : probe.error}`, { probe, tookMs: Date.now() - started });
  }

  async pressPlay(page) {
    for (const frame of page.frames()) {
      for (const sel of PLAY_SELECTORS) {
        try {
          const el = await frame.$(sel);
          if (el && await el.isVisible()) { await el.click({ timeout: 2000 }); return true; }
        } catch { /* detached, covered, cross-origin */ }
      }
      try {
        await frame.evaluate(() => {
          for (const v of document.querySelectorAll('video')) { v.muted = true; v.play().catch(() => {}); }
        });
      } catch { /* ignore */ }
    }
    return false;
  }

  // yt-dlp prints the media URL; for YouTube live that's a muxed HLS playlist.
  async fromYtDlp(url) {
    const { stdout } = await run(this.ytDlp, [
      '-g', '--no-playlist', '--no-warnings',
      '-f', `b[protocol^=m3u8][height<=${this.maxHeight}]/b[protocol^=m3u8]/b`,
      url,
    ], { timeout: 60_000 });
    const manifest = stdout.split(/\r?\n/).find(l => /^https?:/.test(l));
    if (!manifest) return null;
    const headers = {};
    const probe = await probeManifest(manifest, headers, { maxHeight: this.maxHeight });
    if (!probe.ok || probe.live !== true) return null;
    return { url: probe.finalUrl || manifest, type: 'hls', headers, expiresAt: expiryFromUrl(manifest) };
  }
}
