#!/usr/bin/env bash
# Downloads Twemoji 72×72 PNGs for Vite (src/assets) and Electron-safe public/.
# Default: latest master (includes Unicode 17 emoji e.g. U+1FAEA DISTORTED FACE).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_SRC="$ROOT/src/assets/twemoji/72x72"
DEST_PUBLIC="$ROOT/public/twemoji/72x72"
# Pin a tag with TWEMOJI_VERSION=15.1.0, or leave empty for master
VER="${TWEMOJI_VERSION:-}"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

if [[ -n "$VER" ]]; then
  echo "Fetching twemoji v$VER…"
  curl -fsSL "https://github.com/jdecked/twemoji/archive/refs/tags/v${VER}.tar.gz" -o "$TMP/twemoji.tgz"
  tar -xzf "$TMP/twemoji.tgz" -C "$TMP"
  SRC="$TMP/twemoji-${VER}/assets/72x72"
else
  echo "Fetching twemoji master (latest emoji)…"
  curl -fsSL "https://github.com/jdecked/twemoji/archive/refs/heads/master.tar.gz" -o "$TMP/twemoji.tgz"
  tar -xzf "$TMP/twemoji.tgz" -C "$TMP"
  SRC="$TMP/twemoji-main/assets/72x72"
fi

rm -rf "$ROOT/src/assets/twemoji" "$ROOT/public/twemoji"
mkdir -p "$DEST_SRC" "$DEST_PUBLIC"
cp -R "$SRC/." "$DEST_SRC/"
cp -R "$SRC/." "$DEST_PUBLIC/"
COUNT="$(ls "$DEST_PUBLIC" | wc -l | tr -d ' ')"
echo "Installed $COUNT Twemoji PNGs → src/assets/twemoji/72x72 and public/twemoji/72x72"
bash "$ROOT/scripts/generate-twemoji-index.sh"
