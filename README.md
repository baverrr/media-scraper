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
| `<video>` / `<audio>` | Including open shadow DOM and same-origin iframes. Live when `duration === Infinity` or the seekable range extends past the duration. |
| Stream URLs | HLS (`.m3u8`), DASH (`.mpd`), Smooth Streaming, FLV, HDS, RTMP, RTSP, SRT, WebSocket — from network resource timings, `<source>` tags, attributes, inline scripts and JSON (handles `\/` escaping). |
| Embeds | YouTube, Twitch, Kick, Vimeo, Facebook, Dailymotion, Rumble, Streamable, Wistia, Brightcove, JW Player, Mux, Livestream, IBM Video, Restream, Owncast — with the video/channel ID. |
| Player libraries | video.js, JW Player, Plyr, Flowplayer, hls.js, dash.js, Shaka Player, Clappr. |

Results are deduplicated by URL; each item lists every method that found it in `foundBy`.

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
| `type` | `hls`, `dash`, `mse-blob`, `progressive`, `embed`, `rtmp`, … |
| `url` | Primary media URL |
| `provider` / `library` | Embed provider or player library name |
| `foundBy` | Detection methods that found this item |
| `element` | Short CSS-ish description of the element |
| `playing`, `muted`, `size`, `visible`, `duration`, `tracks` | Media element state |
| `variants` | HLS variant streams (after probing) |
| `probeError` | Why probing failed (`timeout`, `blocked (CORS?)`) |

## Limitations

- Cross-origin iframes can't be inspected; only their `src` is reported.
- Closed shadow roots are invisible.
- Live probing is subject to CORS; blocked items keep `live: null` and get a `probeError`.
- `watch()` only sees requests made after it starts, so call it before the player loads.
