# Media Scraper

A single, dependency-free browser script that finds media players and streams on any web page and tells you which ones are live.

## Usage

### DevTools console / bookmarklet / userscript

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

### Puppeteer / Playwright

```js
await page.addScriptTag({ path: 'media-scraper.js' });
const results = await page.evaluate(() => MediaScraper.scan().then(MediaScraper.toJSON));
```

`toJSON` strips the DOM node references so the results serialize cleanly.

### Loading early (recommended for MSE players)

To pair hls.js, dash.js and Shaka players with their manifests, the script has to run before the page creates them. Load it before the page's own scripts:

- **Userscript:** `// @run-at document-start`
- **Puppeteer:** `await page.evaluateOnNewDocument(fs.readFileSync('media-scraper.js', 'utf8'))`
- **Playwright:** `await page.addInitScript({ path: 'media-scraper.js' })`

Loaded this way, it hooks each library the moment the library assigns itself to `window`.

## What it detects

| Source | Details |
| --- | --- |
| `<video>` / `<audio>` | Including open shadow DOM and same-origin iframes. Live when `duration === Infinity` or the seekable range extends past the duration. Players fed a MediaStream (`srcObject`: WebRTC, camera, canvas capture) are reported as `mediastream` and always live. |
| Stream URLs | HLS (`.m3u8`), DASH (`.mpd`), Smooth Streaming, FLV, HDS, RTMP, RTSP, SRT, media WebSockets — from network requests, `<source>` tags, attributes, inline scripts and JSON (handles `\/` and `\uXXXX` escaping, and relative paths such as `"/live/index.m3u8"`). WebSockets in scripts are kept only when they look like media (`.flv`/`.ts`/`.mp4`, or `/live/`, `/stream/`, `/media/` paths). |
| Embeds | YouTube, Twitch, Kick, Vimeo, Facebook, Dailymotion, Rumble, Streamable, Wistia, Brightcove, JW Player, Mux, Livestream, IBM Video, Restream, Owncast — with the video/channel ID. |
| Player libraries | video.js, JW Player, Plyr, Flowplayer, hls.js, dash.js, Shaka Player, Clappr. |

Results are deduplicated by URL; each item lists every method that found it in `foundBy`. HLS variant playlists are folded into their master playlist (listed in its `variants`) rather than reported separately.

Before comparing URLs, parameters that change on every request are dropped: low-latency HLS directives (`_HLS_msn`, `_HLS_part`, …) and cache-busters (`_`, `t`, `ts`, `cb`, `rnd`, …) when their value is a timestamp or random number. A playlist polled once a second is one result, not hundreds. Other parameters, such as signed tokens, are kept exactly as they were.

### Network capture

As soon as the script loads, it starts a `PerformanceObserver` that records stream requests. Browsers keep only 250 entries in the resource timing buffer, and a live page re-fetches its playlist every few seconds, so `performance.getEntries()` alone stops showing new manifests quickly; the observer keeps receiving them. It keeps the 500 most recently active streams. Same-origin iframes are observed from the first scan that finds them.

### Pairing players with manifests

MSE players (hls.js, dash.js, Shaka) play a `blob:` URL, so the `<video>` itself doesn't say what it's playing. The script hooks `Hls.prototype`, `shaka.Player.prototype` and the `dashjs.MediaPlayer` factory to capture instances created or loaded from then on. If the libraries don't exist yet because the script was [loaded early](#loading-early-recommended-for-mse-players), it hooks each one as soon as it's assigned to `window`. Each MSE element is then linked to its own instance's manifest (`manifest`, `library`) and inherits its live status.

Without a captured instance, the script only guesses when it's unambiguous — one unpaired MSE element and one live manifest — and marks the guess with `manifestGuessed: true`.

### Live probing

With `probe` on (the default), HLS and DASH manifests whose status is unknown are fetched:

- **HLS** — live if the media playlist has no `#EXT-X-ENDLIST` and isn't `PLAYLIST-TYPE:VOD`. For a master playlist, the first variant is checked.
- **DASH** — live if the MPD has `type="dynamic"`.

Requests go out with cookies first (for token-gated streams), then without (for CDNs that send `Access-Control-Allow-Origin: *`).

## Result fields

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

## Watch mode

`watch()` hooks `fetch`, `XMLHttpRequest`, `WebSocket` and resource timing in the page and in every same-origin iframe, including iframes added or reloaded later. It also observes DOM changes in open shadow roots and iframe documents.

- **Manifests without an extension** (`/api/stream/123`) are recognised from the response's content type (`application/vnd.apple.mpegurl`, `application/dash+xml`, …). Only the headers are read, so the page's own use of the response is unaffected. Later `scan()` calls include them too.
- **WebRTC players started later** are caught through the media `loadstart` event, since setting `srcObject` changes no attribute.
- **Rescans** run at most every 500 ms, so a page that changes constantly (live chat) can't hold them off. They skip reading every `window` property and only re-read inline scripts whose text changed, so they stay cheap on large pages.

`unwatch()` restores everything it replaced.

## Limitations

- Cross-origin iframes can't be inspected; only their `src` is reported.
- Closed shadow roots are invisible.
- Live probing is subject to CORS; blocked items keep `live: null` and get a `probeError`.
- `watch()` only sees requests made after it starts, so call it before the player loads.
- Player instances created before the script loads, or from a library bundled into the site's code instead of exposed as `window.Hls` / `shaka` / `dashjs`, can't be captured, so their MSE elements are paired only when the guess is unambiguous.
- Manifests without a file extension are recognised only by `watch()`, from requests made after it starts; `scan()` alone can't see response content types.
- When loaded early, the script briefly defines `Hls`, `shaka` and `dashjs` on `window` (returning `undefined`) until the real libraries arrive, so a page that tests `'Hls' in window` rather than `window.Hls` could misread it.
