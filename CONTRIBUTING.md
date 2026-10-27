# Contributing

Thanks for helping. The most useful contribution is a **market file** for your area, so people near you get working stations out of the box.

## Adding a market

Markets are JSON files in [`sidecar/markets/`](sidecar/markets/). The file name is the market id (lowercase letters, digits, `-` and `_`).

```json
{
  "name": "Springfield, ST",
  "timezone": "America/Chicago",
  "sportsChannel": "1.1",
  "center": { "city": "Springfield, ST", "latitude": 39.80, "longitude": -89.64 },
  "teams": [
    { "league": "nfl", "team": "abc", "name": "Springfield Football Club" }
  ],
  "stations": [
    {
      "id": "wxyz",
      "callSign": "WXYZ",
      "name": "Channel 7",
      "channel": "7.1",
      "network": "ABC",
      "city": "Springfield, ST",
      "latitude": 39.80,
      "longitude": -89.64,
      "url": "https://www.example-station.com/live",
      "enabled": true
    }
  ]
}
```

- **Stations:** the station's own live-stream page as `url`. Use the city of license for `city` and its coordinates for the coverage area. List the market's own stations first: a local game goes to the first station carrying its network.
- **Disabled stations:** keep stations that don't work in the list with `"enabled": false` and a `note` saying why (DRM, app only, no stream on the site). People can see why, and turn them on if that changes.
- **Teams:** `league` is one of `nfl`, `nba`, `wnba`, `nhl`, `mlb`, `mls`, `nwsl`, `ncaaf`, `ncaam`, `ncaaw`. `team` is ESPN's abbreviation or id, from the team's ESPN page URL (`/nfl/team/_/name/abc`, or `/college-football/team/_/id/123`).
- **Test every station** with **Test now** on the plugin's settings page before marking it enabled, and play it in Jellyfin once.

## Ground rules

- Only free streams that stations publish on their own websites. No sign-ins, no paid services.
- No code that gets around DRM, bot checks, CAPTCHAs or geographic restrictions. If a station blocks automated access, leave it disabled with a note.

## Code changes

```bash
(cd sidecar && npm ci && npx playwright install chromium && npm test)
docker run --rm -v "$PWD":/src -w /src mcr.microsoft.com/dotnet/sdk:10.0 dotnet test Jellyfin.Plugin.LocalBroadcast.Tests
```

Both suites run in CI on every pull request. Add a test with each fix: one that fails without it.

## Releases

A maintainer bumps `version` and `changelog` in `build.yaml`, merges to `main`, and pushes a matching `vX.Y.Z` tag. CI publishes the image, the release and the plugin catalog.
