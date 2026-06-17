#!/usr/bin/env bash
# Default desktop release: Windows NSIS (x64) + macOS DMG (host arch).
# Run from repo: npm run dist --prefix desktop-client
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DESKTOP_ROOT"

echo "==> prepare:ui (Next export → desktop-client/ui)"
npm run prepare:ui

OS="$(uname -s)"
case "$OS" in
  Darwin)
    ARCH="$(uname -m)"
    MAC_ARCH="arm64"
    if [[ "$ARCH" == "x86_64" ]]; then
      MAC_ARCH="x64"
    fi
    echo "==> electron-builder: win nsis x64"
    npx electron-builder --win nsis --x64 --publish never
    echo "==> electron-builder: mac dmg $MAC_ARCH"
    npx electron-builder --mac dmg --"$MAC_ARCH" --publish never
    ;;
  Linux)
    echo "==> electron-builder: win nsis x64 (DMG requires macOS host)"
    npx electron-builder --win nsis --x64 --publish never
    ;;
  MINGW* | MSYS* | CYGWIN*)
    echo "==> electron-builder: win nsis x64 only (on Windows host)"
    npx electron-builder --win nsis --x64 --publish never
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

echo "==> Release artifacts in $DESKTOP_ROOT/release/"
ls -lh "$DESKTOP_ROOT/release"/Voixex-*-win-x64.exe "$DESKTOP_ROOT/release"/Voixex-*-mac-*.dmg 2>/dev/null | tail -4 || ls -lh "$DESKTOP_ROOT/release"/ 2>/dev/null || true
