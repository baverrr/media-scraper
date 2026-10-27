# Security policy

## Supported versions

Only the latest release of the plugin and of the sidecar image gets fixes. Update both to the latest release before reporting.

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use **Report a vulnerability** on this repository's **Security** tab. If that button isn't there, open an issue asking for a private contact, without any details of the problem.

Include what you found, how to reproduce it, and which versions you tested. You'll get an answer when the report has been looked at. Fixes ship in a new release, with credit if you'd like it.

## Running it safely

- **Keep the sidecar private.** By default it listens on `127.0.0.1:8899` only. Jellyfin re-serves the streams to your clients, so the sidecar never needs to be reachable from your network or the internet.
- **Set an API key.** Changes to stations and sports settings need the `X-Api-Key` header. Generate a long random key (the README's install step does), keep `sidecar/.env` readable only by you (`chmod 600`), and don't commit it.
- **The stream proxy only serves what it resolved.** Segment URLs are signed with a per-start HMAC key, so the proxy can't be used to fetch arbitrary URLs.
- **The headless browser visits station websites** listed in your settings. Only add stations whose sites you trust as much as you would visiting them in your own browser.
