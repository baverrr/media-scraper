# Build from the repository root so media-scraper.js is in the context:
#   docker build -f sidecar/Dockerfile -t local-broadcast-sidecar .
# The base image's bundled Chromium matches the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.64.0-noble

ARG TARGETARCH
# "latest", or a release tag such as 2026.10.01. yt-dlp needs frequent updates for YouTube, so
# rebuild the image now and then.
ARG YTDLP_VERSION=latest

# yt-dlp's standalone build (no Python needed), verified against the release's SHA2-256SUMS.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    case "${TARGETARCH:-amd64}" in \
      amd64) asset=yt-dlp_linux ;; \
      arm64) asset=yt-dlp_linux_aarch64 ;; \
      *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; \
    esac; \
    if [ "$YTDLP_VERSION" = latest ]; then base=https://github.com/yt-dlp/yt-dlp/releases/latest/download; \
    else base="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}"; fi; \
    cd /tmp; \
    curl -fsSLo "$asset" "$base/$asset"; \
    curl -fsSLo SHA2-256SUMS "$base/SHA2-256SUMS"; \
    grep " ${asset}\$" SHA2-256SUMS | sha256sum -c -; \
    install -m 0755 "$asset" /usr/local/bin/yt-dlp; \
    rm -f "$asset" SHA2-256SUMS; \
    yt-dlp --version

WORKDIR /app
COPY sidecar/package.json sidecar/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Google Chrome next to the bundled Chromium: Chromium has no H.264/AAC, and many station players
# check for those codecs before they request a stream. Chrome is only built for amd64; on other
# architectures the sidecar falls back to Chromium.
RUN if [ "${TARGETARCH:-amd64}" = amd64 ]; then npx playwright install --with-deps chrome && rm -rf /var/lib/apt/lists/*; fi
COPY sidecar/src ./src
COPY sidecar/markets ./markets
COPY sidecar/assets ./assets
COPY media-scraper.js ./

RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser

ENV NODE_ENV=production \
    PORT=8899 \
    DATA_DIR=/data \
    SCRAPER_PATH=/app/media-scraper.js
EXPOSE 8899
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.js"]
