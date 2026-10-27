// Entry point: configuration from the environment, then the HTTP server.
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StationStore } from './stations.js';
import { Resolver } from './resolver.js';
import { createApp } from './app.js';
import { SportsSchedule } from './sports.js';
import { LoginStore, parseKey } from './logins.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

// media-scraper.js is copied next to the app in the image; in the repo it's two levels up.
const scraperPath = env.SCRAPER_PATH
  || [path.join(here, '..', 'media-scraper.js'), path.join(here, '..', '..', 'media-scraper.js')].find(p => existsSync(p));

const config = {
  port: num(env.PORT, 8899),
  host: env.HOST || '0.0.0.0',
  dataDir: env.DATA_DIR || path.join(here, '..', 'data'),
  apiKey: env.API_KEY || '',
  publicUrl: env.PUBLIC_URL || '',
  maxHeight: num(env.MAX_HEIGHT, 1080),
  ttlMinutes: num(env.RESOLVE_TTL_MINUTES, 30),
  failureSeconds: num(env.FAILURE_RETRY_SECONDS, 60),
  concurrency: num(env.MAX_CONCURRENT_RESOLVES, 2),
  ytDlp: env.YTDLP === undefined ? 'yt-dlp' : env.YTDLP,
  browserChannel: env.BROWSER_CHANNEL === undefined ? 'chrome' : env.BROWSER_CHANNEL,
  // Bundled defaults (stations + local teams) until the Jellyfin plugin sends its own.
  market: (env.MARKET || 'denver').toLowerCase(),
};

const log = {
  info: msg => console.log(`${new Date().toISOString()} ${msg}`),
  warn: msg => console.warn(`${new Date().toISOString()} WARN ${msg}`),
};

if (!scraperPath) {
  console.error('media-scraper.js not found; set SCRAPER_PATH');
  process.exit(1);
}

const store = new StationStore({ dataDir: config.dataDir, marketsDir: path.join(here, '..', 'markets'), market: config.market });
await store.load();
const sports = new SportsSchedule({ teams: store.sports.teams, log });
const logins = await new LoginStore({ dataDir: config.dataDir, key: parseKey(env.LOGIN_KEY), log }).load();

// The browser's time zone: TZ, else the market's (markets/<id>.json "timezone").
const timezoneId = env.TZ || (await store.marketDefaults().catch(() => null))?.timezone || undefined;
const resolver = new Resolver({ scraperPath, ytDlp: config.ytDlp, maxHeight: config.maxHeight, channel: config.browserChannel, timezoneId, log });
const app = createApp({ store, resolver, sports, logins, config, log });
const resolve = app.cache.resolveFn;
app.cache.resolveFn = async station => {
  log.info(`[${station.id}] resolving ${station.url}`);
  try {
    const r = await resolve(station);
    log.info(`[${station.id}] found ${r.type} via ${r.via} in ${r.tookMs} ms`);
    return r;
  } catch (e) {
    log.warn(`[${station.id}] ${e.message}`);
    throw e;
  }
};

const server = http.createServer(app.handler);
// Players fetch a segment every few seconds on one connection; Node's default 5 s idle timeout
// closes it between requests, and ffmpeg logs each close as an error.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// Keep streams for stations airing local games resolved ahead of time.
const warmer = setInterval(() => { app.warmSports().catch(e => log.warn(`sports warm-up: ${e.message}`)); }, 60_000);
warmer.unref();
server.listen(config.port, config.host, () => {
  log.info(`local-broadcast sidecar on ${config.host}:${config.port}, ${store.enabled().length} stations enabled (market ${config.market}), sports ${store.sports.enabled ? `on (${store.sports.teams.length} teams)` : 'off'}${config.apiKey ? '' : ' (no API_KEY set: station changes are unauthenticated)'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    clearInterval(warmer);
    server.close();
    await resolver.close();
    process.exit(0);
  });
}
