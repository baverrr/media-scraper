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

## What it detects

| Source | Details |
| --- | --- |
| `<video>` / `<audio>` | Including open shadow DOM and same-origin iframes. Live when `duration === Infinity` or the seekable range extends past the duration. Players fed a MediaStream (`srcObject`: WebRTC, camera, canvas capture) are reported as `mediastream` and always live. |
| Stream URLs | HLS (`.m3u8`), DASH (`.mpd`), Smooth Streaming, FLV, HDS, RTMP, RTSP, SRT, media WebSockets — from network requests, `<source>` tags, attributes, inline scripts and JSON (handles `\/` and `\uXXXX` escaping). WebSockets in scripts are kept only when they look like media (`.flv`/`.ts`/`.mp4`, or `/live/`, `/stream/`, `/media/` paths). |
| Embeds | YouTube, Twitch, Kick, Vimeo, Facebook, Dailymotion, Rumble, Streamable, Wistia, Brightcove, JW Player, Mux, Livestream, IBM Video, Restream, Owncast — with the video/channel ID. |
| Player libraries | video.js, JW Player, Plyr, Flowplayer, hls.js, dash.js, Shaka Player, Clappr. |

Results are deduplicated by URL; each item lists every method that found it in `foundBy`. HLS variant playlists are folded into their master playlist (listed in its `variants`) rather than reported separately.

### Network capture

As soon as the script loads, it starts a `PerformanceObserver` that records stream requests. Browsers keep only 250 entries in the resource timing buffer, and a live page re-fetches its playlist every few seconds, so `performance.getEntries()` alone stops showing new manifests quickly; the observer keeps receiving them. Same-origin iframes are observed from the first scan that finds them.

### Pairing players with manifests

MSE players (hls.js, dash.js, Shaka) play a `blob:` URL, so the `<video>` itself doesn't say what it's playing. When the script loads, it hooks `Hls.prototype`, `shaka.Player.prototype` and the `dashjs.MediaPlayer` factory to capture instances created or loaded from then on. Each MSE element is then linked to its own instance's manifest (`manifest`, `library`) and inherits its live status.

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

`watch()` hooks `fetch`, `XMLHttpRequest`, `WebSocket` and resource timing in the page and in every same-origin iframe, including iframes added or reloaded later. It also observes DOM changes in open shadow roots and iframe documents. Rescans run at most every 500 ms, so a page that changes constantly (live chat) can't hold them off. `unwatch()` restores everything it replaced.

## Limitations

- Cross-origin iframes can't be inspected; only their `src` is reported.
- Closed shadow roots are invisible.
- Live probing is subject to CORS; blocked items keep `live: null` and get a `probeError`.
- `watch()` only sees requests made after it starts, so call it before the player loads.
- Player instances created before the script loads, or from a library bundled into the site's code instead of exposed as `window.Hls` / `shaka` / `dashjs`, can't be captured, so their MSE elements are paired only when the guess is unambiguous.
