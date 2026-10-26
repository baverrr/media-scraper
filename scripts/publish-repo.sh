#!/usr/bin/env bash
# Build the plugin and add the version in build.yaml to a Jellyfin plugin repository folder
# (manifest.json + zips) that you serve yourself. Jellyfin reads the manifest over HTTP, so the
# folder must be served at BASE_URL.
#
# Usage: scripts/publish-repo.sh <repo-dir> [base-url]
#   base-url defaults to http://127.0.0.1:8096/web/plugin-repo
#
# Not needed when installing from GitHub (see README): tagged releases publish there.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO_DIR=$(realpath "${1:?usage: $0 <repo-dir> [base-url]}")
BASE_URL=${2:-http://127.0.0.1:8096/web/plugin-repo}
BASE_URL=${BASE_URL%/}

VERSION=$(sed -n 's/^version: "\(.*\)"$/\1/p' "$ROOT/build.yaml")
SLUG=local-broadcast
ZIP_NAME="${SLUG}_${VERSION}.zip"
ZIP_PATH="$REPO_DIR/$SLUG/$ZIP_NAME"

if [[ -e "$ZIP_PATH" ]]; then
    echo "Version $VERSION is already published ($ZIP_PATH). Bump version in build.yaml." >&2
    exit 1
fi

echo "Building $VERSION..."
rm -rf "$ROOT/dist"
# Run as the caller so build output stays owned by them; HOME=/tmp gives dotnet a writable home.
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    -v "$ROOT":/src -w /src/Jellyfin.Plugin.LocalBroadcast \
    mcr.microsoft.com/dotnet/sdk:10.0 \
    dotnet publish -c Release -o /src/dist -p:Version="$VERSION" -p:AssemblyVersion="$VERSION" \
    -p:FileVersion="$VERSION" --nologo -v quiet

mkdir -p "$REPO_DIR/$SLUG"
(cd "$ROOT/dist" && zip -q -X "$ZIP_PATH" Jellyfin.Plugin.LocalBroadcast.dll)
python3 -I "$ROOT/scripts/manifest.py" "$ROOT/build.yaml" "$REPO_DIR/manifest.json" "$ZIP_PATH" "$BASE_URL/$SLUG/$ZIP_NAME"
