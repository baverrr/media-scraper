# Media Scraper

Two things live here:

- **[Local Broadcast for Jellyfin](#local-broadcast-for-jellyfin)**: your local TV stations' free web streams in Jellyfin's Live TV, with stations airing local sports first.
- **[media-scraper.js](#media-scraperjs)**: the dependency-free browser script it's built on, which finds media players and streams on any web page and tells you which are live.

## Local Broadcast for Jellyfin

Many local TV stations stream live for free on their own websites, but those players need a real browser and their stream URLs carry tokens that expire within minutes or hours. Local Broadcast has two parts:

| Part | What it does |
| --- | --- |
| **Sidecar** (`sidecar/`, Docker image) | Opens each station's live page in headless Chrome with `media-scraper.js` loaded first, finds the live HLS stream, and serves it to Jellyfin through a small proxy that re-resolves expired tokens behind stable URLs. Also serves an M3U playlist and an XMLTV guide. |
| **Jellyfin plugin** (`Jellyfin.Plugin.LocalBroadcast/`) | Settings page for stations and local teams, pushes them to the sidecar, and adds the sidecar to Live TV as an M3U tuner with an XMLTV guide, so there's nothing to configure under Live TV yourself. |

### Local sports first

Give the plugin your local teams (the Denver market comes with the Broncos, Nuggets, Avalanche, Rockies, Rapids, Denver Summit FC, CU, CSU and Air Force). The sidecar reads each team's schedule and TV listings from ESPN's public API and matches over-the-air broadcasts to your stations by network (a CBS game is on the CBS affiliate), call sign, name or the station's *sports aliases*. While a game is on (from 15 minutes before the start):

- the **Local Sports** channel (number 1.1 by default) plays whichever station is airing the game;
- that station moves to the top of the playlist and its stream resolves ahead of every other station, pre-fetched shortly before the start so tuning in is instant;
- the guide shows the game (category *Sports*, so it appears in Jellyfin's Sports row) on that station and on Local Sports, refreshed whenever the schedule changes.

Honest caveat: stations' web streams often show their own news programming instead of network games, because networks and leagues rarely allow games on station websites. The guide description says so.

### What works (Denver market)

The Denver market file lists 19 stations. These 6 play in Jellyfin (tested with Jellyfin 12.2's ffmpeg):

| Station | Channel | Network |
| --- | --- | --- |
| KCNC CBS Colorado | 4.1 | CBS |
| KOAA News5 (Colorado Springs / Pueblo) | 5.1 | NBC |
| KMGH Denver7 | 7.1 | ABC |
| KUSA 9NEWS | 9.1 | NBC |
| KDEN Telemundo Denver | 25.1 | Telemundo |
| KRMT Daystar | 41.1 | Daystar |

The other 13 are listed but disabled, each with a note in the settings page:

| Why | Stations |
| --- | --- |
| Site shows a bot check (Nexstar) | KWGN CW2, KDVR FOX31 |
| Web stream is DRM-protected | KRMA Rocky Mountain PBS, KBDI PBS12 |
| Streams only in the network's app | KCEC Univision, KTFD UniMas, KPXC ION |
| No live stream on the website | KCDO The Spot, KTVD My20, KRDO 13, KPJR TBN, KETD Estrella TV |
| Station player fails in headless browsers | KKTV 11 |

The sidecar does not get around bot checks, DRM or sign-ins. A disabled station can be turned on by pasting a **stream URL** you're allowed to use (a non-expiring `.m3u8`, or a page yt-dlp supports, such as the station's YouTube live) into its settings.

### Install

1. **Run the sidecar** next to Jellyfin:

   ```bash
   export LOCAL_BROADCAST_API_KEY=$(openssl rand -hex 24)
   docker compose -f sidecar/compose.yaml up -d
   ```

   It listens on `127.0.0.1:8899` (Jellyfin re-serves the streams to your clients, so it needn't be reachable from elsewhere). With Jellyfin in a bridge-network container instead of host networking, put both on one Docker network and use `http://local-broadcast:8899`.

2. **Install the plugin**: in Jellyfin, Dashboard > Plugins > Repositories, add

   ```
   https://baverrr.github.io/media-scraper/manifest.json
   ```

   then install **Local Broadcast** from the catalog and restart Jellyfin. (Needs Jellyfin 12.2.)

3. **Configure**: Dashboard > Plugins > Local Broadcast: set the sidecar URL and the API key, pick your market, and save. The plugin adds the *Local Broadcast* tuner and guide; channels appear in Live TV after the guide refresh it queues.

Use **Test now** on a station to see exactly what the sidecar finds (or why not): offline, DRM, bot check, no live manifest, embedded YouTube player, and so on.

### Other markets

Markets are JSON files in [`sidecar/markets/`](sidecar/markets/): stations (id, call sign, name, channel, network, live page URL, optional `streamUrl`, `sportsAliases`, `note`, `enabled`) and local teams (`league` plus ESPN's team abbreviation or id, from the team's ESPN page URL). Add a file for your area, run the station tests from the settings page, and send a pull request. The plugin bundles every market file at build time.

### Sidecar configuration

| Variable | Default | |
| --- | --- | --- |
| `API_KEY` | none | Required for changes from the plugin (`X-Api-Key`). |
| `MARKET` | `denver` | Defaults until the plugin sends its own stations and teams. |
| `MAX_HEIGHT` | `1080` | Highest quality picked from a station's variants. |
| `RESOLVE_TTL_MINUTES` | `30` | How long a found stream is reused (shorter when its token expires sooner). |
| `MAX_CONCURRENT_RESOLVES` | `2` | Browser pages at once; local-sports stations jump the queue. |
| `BROWSER_CHANNEL` | `chrome` | `chrome` has H.264/AAC (many players need them); empty uses bundled Chromium. |
| `PUBLIC_URL` | from the request | Base URL written into the M3U. |

HTTP API: `GET /playlist.m3u`, `GET /guide.xml`, `GET /stream/<id>.m3u8` (`local-sports` included), `GET /api/status`, `GET /api/sports`, `GET /api/stations`; with the API key: `PUT /api/stations`, `PUT /api/sports`, `POST /api/stations/<id>/test`. Proxied segment URLs are HMAC-signed, so the proxy can't be used to fetch arbitrary URLs.

### Development

```bash
(cd sidecar && npm ci && npx playwright install chromium && npm test)
docker run --rm -v "$PWD":/src -w /src mcr.microsoft.com/dotnet/sdk:10.0 dotnet test Jellyfin.Plugin.LocalBroadcast.Tests
docker build -f sidecar/Dockerfile -t local-broadcast-sidecar .
```

The sidecar tests include `media-scraper.js` in a real browser (`sidecar/test/scraper.test.js`); they're skipped when Playwright has no browser installed.

CI (`.github/workflows/ci.yml`) runs both test suites on every push and pull request, publishes the sidecar image to `ghcr.io/<owner>/local-broadcast-sidecar` (`:edge` from main), and on a `vX.Y.Z` tag matching `version` in `build.yaml` publishes the image (`:X.Y.Z`, `:latest`), a GitHub release with the plugin zip, and the plugin repository manifest on GitHub Pages. Installing from GitHub needs the repository, its Pages site and the container package to be public. `scripts/publish-repo.sh <dir>` publishes to a self-hosted plugin repository folder instead.

## media-scraper.js

A single, dependency-free browser script that finds media players and streams on any web page and tells you which ones are live.

### Usage

#### DevTools console / bookmarklet / userscript

Paste `media-scraper.js` into the console (or load it as a bookmarklet or userscript), then:

```js
await MediaScraper.scan()                     // prints a table, returns results (live first)
await MediaScraper.scan({ liveOnly: true })   // only live items
await MediaScraper.scan({ probe: false })     // don't fetch manifests to check live status
MediaScraper.watch(item => console.log(item)) // report new streams as the page requests them
MediaScraper.unwatch()
MediaScraper.copy()                           // copy last results as JSON
MediaScraper.results                          // last results
```

#### Puppeteer / Playwright

```js
await page.addScriptTag({ path: 'media-scraper.js' });
const results = await page.evaluate(() => MediaScraper.scan().then(MediaScraper.toJSON));
```

`toJSON` strips the DOM node references so the results serialize cleanly.

#### Loading early (recommended for MSE players)

To pair hls.js, dash.js and Shaka players with their manifests, the script has to run before the page creates them. Load it before the page's own scripts:

- **Userscript:** `// @run-at document-start`
- **Puppeteer:** `await page.evaluateOnNewDocument(fs.readFileSync('media-scraper.js', 'utf8'))`
- **Playwright:** `await page.addInitScript({ path: 'media-scraper.js' })`

Loaded this way, it hooks each library the moment the library assigns itself to `window`.

### What it detects

| Source | Details |
| --- | --- |
| `<video>` / `<audio>` | Including shadow DOM (closed roots too, when [loaded early](#loading-early-recommended-for-mse-players)) and same-origin iframes. Live when `duration === Infinity` or the seekable range extends past the duration. Players fed a MediaStream (`srcObject`: WebRTC, camera, canvas capture) are reported as `mediastream` and always live. |
| Stream URLs | HLS (`.m3u8`), DASH (`.mpd`), Smooth Streaming, FLV, HDS, RTMP, RTSP, SRT, media WebSockets — from network requests, `<source>` tags, attributes, inline scripts and JSON (handles `\/` and `\uXXXX` escaping, and relative paths such as `"/live/index.m3u8"`). WebSockets in scripts are kept only when they look like media (`.flv`/`.ts`/`.mp4`, or `/live/`, `/stream/`, `/media/` paths). |
| Embeds | YouTube, Twitch, Kick, Vimeo, Facebook, Dailymotion, Rumble, Streamable, Wistia, Brightcove, JW Player, Mux, Livestream, IBM Video, Restream, Owncast — with the video/channel ID. Lazy-loaded iframes are read from `data-src`. |
| Player libraries | video.js, JW Player, Plyr, Flowplayer, hls.js, dash.js, Shaka Player, Clappr — in the page and in same-origin iframes. |

Smooth Streaming URLs (`.ism/Manifest`) are typed `smooth`, or `hls` / `dash` for Azure Media Services' `Manifest(format=m3u8-aapl)` / `(format=mpd-…)`.

Results are deduplicated by URL (players without a URL, such as WebRTC, by element); each item lists every method that found it in `foundBy`. HLS variant playlists are folded into their master playlist (listed in its `variants`) rather than reported separately.

Before comparing URLs, parameters that change on every request are dropped: low-latency HLS directives (`_HLS_msn`, `_HLS_part`, …) and cache-busters (`_`, `t`, `ts`, `cb`, `rnd`, …) when their value is a timestamp or random number. A playlist polled once a second is one result, not hundreds. Other parameters, such as signed tokens, are kept exactly as they were.

#### Network capture

As soon as the script loads, it starts a `PerformanceObserver` that records stream requests. Browsers keep only 250 entries in the resource timing buffer, and a live page re-fetches its playlist every few seconds, so `performance.getEntries()` alone stops showing new manifests quickly; the observer keeps receiving them. It keeps the 500 most recently active streams. Same-origin iframes are observed from the first scan that finds them. In Chrome 129 and later, which report each response's content type in resource timing, manifests whose URL has no extension (`/api/stream/123`) are recognised here too.

#### Pairing players with manifests

MSE players (hls.js, dash.js, Shaka) play a `blob:` URL, so the `<video>` itself doesn't say what it's playing. The script hooks `Hls.prototype`, `shaka.Player.prototype` and the `dashjs.MediaPlayer` factory to capture instances created or loaded from then on. If the libraries don't exist yet because the script was [loaded early](#loading-early-recommended-for-mse-players), it hooks each one as soon as it's assigned to `window`. Each MSE element is then linked to its own instance's manifest (`manifest`, `library`) and inherits its live status.

Without a captured instance, the script only guesses when it's unambiguous — one unpaired MSE element and one live manifest, or with `probe: false`, one manifest not known to be VOD — and marks the guess with `manifestGuessed: true`.

Loading the script a second time (a pasted copy on top of a userscript, say) keeps what the first copy's hooks captured.

#### Live probing

With `probe` on (the default), HLS and DASH manifests whose status is unknown are fetched:

- **HLS** — live if the media playlist has no `#EXT-X-ENDLIST` and isn't `PLAYLIST-TYPE:VOD`. For a master playlist, the first variant is checked (resolved against the master's URL after redirects).
- **DASH** — live if the MPD has `type="dynamic"`.
- **Smooth Streaming** — live if the manifest has `IsLive="TRUE"`.

At most six manifests are fetched at a time.

Requests go out with cookies first (for token-gated streams), then without (for CDNs that send `Access-Control-Allow-Origin: *`).

### Result fields

| Field | Meaning |
| --- | --- |
| `live` | `true`, `false`, or `null` (unknown) |
| `kind` | `video`, `audio`, `embed`, `stream`, `player` |
| `type` | `hls`, `dash`, `mse-blob`, `mediastream`, `progressive`, `embed`, `rtmp`, `websocket`, … |
| `url` | Primary media URL |
| `provider` / `library` | Embed provider, or the player library (on MSE elements: the one driving it) |
| `manifest` | For MSE elements: the manifest being played; `manifestGuessed: true` if it was inferred |
| `foundBy` | Detection methods that found this item |
| `element` | Short CSS-ish description of the element |
| `playing`, `muted`, `size`, `visible`, `duration`, `tracks` | Media element state (`duration` is the string `"Infinity"` in JSON output) |
| `streamTracks` | For `mediastream` players: each track's `kind`, `label` and `state` |
| `variants` | HLS variant streams (after probing) |
| `probeError` | Why probing failed (`HTTP 403`, `not a manifest`, `timeout`, `blocked (CORS?)`) |

### Watch mode

`watch()` hooks `fetch`, `XMLHttpRequest`, `WebSocket` and resource timing in the page and in every same-origin iframe, including iframes added or navigated later. When it starts, it reports what's already on the page and wasn't in the last `scan()`'s results, including streams requested since the script loaded. It also observes DOM changes in open shadow roots and iframe documents.

- **Manifests without an extension** (`/api/stream/123`) are recognised from the response's content type (`application/vnd.apple.mpegurl`, `application/dash+xml`, …). Only the headers are read, so the page's own use of the response is unaffected. Later `scan()` calls include them too.
- **WebRTC players started later** are caught through the media `loadstart` event, since setting `srcObject` changes no attribute.
- **Rescans** run at most every 500 ms, so a page that changes constantly (live chat) can't hold them off. They skip reading every `window` property and only re-read inline scripts whose text changed, so they stay cheap on large pages.

`unwatch()` restores everything it replaced.

### Limitations

- Cross-origin iframes can't be inspected; only their `src` is reported.
- Closed shadow roots are seen only when the script is loaded early, before they're created.
- Live probing is subject to CORS; blocked items keep `live: null` and get a `probeError`.
- Player instances created before the script loads, or from a library bundled into the site's code instead of exposed as `window.Hls` / `shaka` / `dashjs`, can't be captured, so their MSE elements are paired only when the guess is unambiguous.
- Manifests without a file extension are recognised by `scan()` only in browsers whose resource timing reports content types (Chrome 129+); elsewhere only `watch()` sees them, from its `fetch`/XHR hooks.
- When loaded early, the script briefly defines `Hls`, `shaka` and `dashjs` on `window` (returning `undefined`) until the real libraries arrive, so a page that tests `'Hls' in window` rather than `window.Hls` could misread it.
