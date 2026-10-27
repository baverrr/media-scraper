# Privacy policy

Local Broadcast is software you run yourself: a Jellyfin plugin and a sidecar container on your own server. This policy covers the plugin, the sidecar image, and `media-scraper.js`.

**In short:** the project collects nothing. There is no telemetry, no analytics, no account, and no server run by the project. Your settings stay on your server. The sidecar does visit TV station websites and a sports-schedule service on your behalf, and those sites can see your server's IP address, as they would if you visited them yourself.

## What is stored, and where

Everything is stored on the machine where you run it:

| What | Where | Notes |
| --- | --- | --- |
| Plugin settings: sidecar URL, API key, stations, local teams, coverage area | Jellyfin's plugin configuration folder (`plugins/configurations/Jellyfin.Plugin.LocalBroadcast.xml`) | Readable by Jellyfin administrators. |
| Your location for the coverage area, if you enter one | The same plugin settings file | Optional. Used only to work out distances inside Jellyfin. It is never sent to the sidecar or anywhere else. |
| A fingerprint of the last station list sent to the sidecar | `plugins/Jellyfin.Plugin.LocalBroadcast/last-pushed-stations.txt` | A SHA-256 hash, so the guide can refresh after a restart. |
| Station list and sports settings as the sidecar received them | The sidecar's data volume (`stations.json`, `sports.json`) | |
| Station sign-ins you save: email, password, and the site's session cookies | The sidecar's data volume (`logins.json`) | Encrypted with AES-256-GCM, with the key from `LOGIN_KEY` or `login.key`. Never stored by Jellyfin, never shown again, and sent only to the station's own site when signing in. Removed with **Remove sign-in** or when the station is deleted. |
| Resolved stream URLs | Sidecar memory only | Gone when the container restarts. |
| Logs | The sidecar's container log and Jellyfin's log | Station ids, station page URLs, errors and timings. Nothing about who is watching. |

### "Use this device's location"

The button asks your browser for its location, which the browser only shares after you allow it. The location fills in the latitude and longitude fields on the settings page, and is saved only when you press **Save coverage area**. You can type a location instead, or leave it empty to use the market's center.

## Who the software talks to

- **The Jellyfin plugin** talks only to your sidecar (the URL you set), and to Jellyfin itself.
- **The sidecar** connects to:
  - **TV station websites** in your station list. It opens each station's live page in a headless browser, the same way a viewer's browser would. That means the page's own scripts run, including any third-party ads, analytics or video players on it. Those services can see your server's IP address and set cookies. Each page is opened in a fresh browser session that is closed afterwards, so cookies are not kept between visits.
  - **Video hosts and CDNs** serving those stations' streams, including Google's ad-insertion service (`dai.google.com`) for stations that use it.
  - **ESPN's public site API** (`site.api.espn.com`), for your local teams' schedules and TV listings. The request contains the league and team, nothing about you.
  - **Video sites supported by yt-dlp** (such as YouTube), only for stations whose stream URL points to one.
- **Installing and updating** downloads the plugin catalog, the plugin and the sidecar image from GitHub (GitHub Pages, GitHub Releases and GitHub Container Registry). [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement) covers those downloads.

Each of these services has its own privacy policy. The project has no control over them and receives nothing from them.

## media-scraper.js

The script runs entirely in the page you load it into. It sends nothing anywhere. With live probing on, it fetches the stream manifests it finds on that page, from the servers that host them.

## Changes

Changes to this policy are made in this file, so its history in the repository shows every change.

## Questions

Open an issue in this repository. Please don't include personal information.
