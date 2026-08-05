#!/usr/bin/env bash
# Sign Electron / Planetar so macOS UNUserNotificationCenter allows banners.
# Requires a free self-signed codesigning cert in Keychain (see below).
#
# Create cert once (Keychain Access):
#   1. Keychain Access → Certificate Assistant → Create a Certificate…
#   2. Name: Planetar Dev
#   3. Identity Type: Self Signed Root
#   4. Certificate Type: Code Signing
#   5. Let me override defaults → Validity 825 days → Continue → Create
#   6. Trust: double-click cert → Trust → Code Signing → Always Trust
#
# Usage:
#   bash scripts/sign-mac-for-notifications.sh
#   SIGN_IDENTITY="My Cert Name" bash scripts/sign-mac-for-notifications.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IDENTITY="${SIGN_IDENTITY:-Planetar Dev}"

if ! security find-identity -v -p codesigning | grep -F "$IDENTITY" >/dev/null; then
  echo "No codesigning identity named \"$IDENTITY\"."
  echo "Create it in Keychain Access (Certificate Type: Code Signing), then re-run."
  echo
  echo "Current identities:"
  security find-identity -v -p codesigning || true
  exit 1
fi

sign_app() {
  local app="$1"
  if [[ ! -d "$app" ]]; then
    echo "skip (missing): $app"
    return 0
  fi
  echo "Signing: $app"
  codesign --force --deep --sign "$IDENTITY" "$app"
  codesign --verify --deep --strict "$app"
  echo "OK: $app"
}

sign_app "$ROOT/node_modules/electron/dist/Electron.app"
sign_app "$ROOT/release/mac-arm64/Planetar.app"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$LSREGISTER" ]]; then
  [[ -d "$ROOT/release/mac-arm64/Planetar.app" ]] && "$LSREGISTER" -f "$ROOT/release/mac-arm64/Planetar.app" || true
  [[ -d "$ROOT/node_modules/electron/dist/Electron.app" ]] && "$LSREGISTER" -f "$ROOT/node_modules/electron/dist/Electron.app" || true
fi

echo
echo "Done. Quit Planetar/Electron completely, reopen, toggle notifications again."
echo "Then check System Settings → Notifications for Planetar / Electron."
