#!/usr/bin/env bash
# Build Voixex desktop artifacts:
#   - macOS arm64 .zip + Linux AppImage/deb via electronuserland/builder:wine (Docker)
#   - Windows NSIS .exe: on macOS host (native rcedit); in Docker only on native linux/amd64
#
# DMG: npm run dist:mac on macOS (dmgbuilder unstable in Linux container).
# Prereq: docker pull electronuserland/builder:wine
#
#   npm run dist:docker --prefix desktop-client
#
# Опции:
#   --skip-prepare   Пропустить voice + desktop build + prepare:ui на хосте.
#   --no-chown       Не менять владельца каталогов (если chown не нужен).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_ROOT/.." && pwd)"
SKIP_PREPARE=false
DO_CHOWN=true

while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-prepare) SKIP_PREPARE=true; shift ;;
    --no-chown) DO_CHOWN=false; shift ;;
    -h | --help)
      echo "Usage: $0 [--skip-prepare] [--no-chown]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

fix_repo_ownership() {
  local uid gid
  uid="$(id -u)"
  gid="$(id -g)"
  echo "==> Выравниваем владельца repo-каталогов на uid=$uid (после сборок от root в Docker)…"
  docker run --rm --user 0:0 --platform linux/amd64 \
    -v "$REPO_ROOT:/repo" \
    electronuserland/builder:wine \
    bash -c 'for d in \
      /repo/desktop-client/node_modules \
      /repo/desktop-client/release \
      /repo/desktop-client/ui \
      /repo/voice-client/node_modules \
      /repo/primer_front/node_modules \
      /repo/primer_front/.next \
      /repo/primer_front/out; do
      if [[ -e "$d" ]]; then chown -R '"$uid"':'"$gid"' "$d"; fi
    done'
}

verify_win_installer() {
  local exe
  exe="$(ls -1 "$DESKTOP_ROOT"/release/Voixex-*-win-x64.exe 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -z "$exe" ]]; then
    echo "ERROR: Windows installer not found in $DESKTOP_ROOT/release/" >&2
    return 1
  fi
  local size
  size="$(wc -c <"$exe" | tr -d ' ')"
  # Broken Docker/Wine builds leave a stub ~300–400 KB; a real NSIS is tens of MB.
  if [[ "$size" -lt 50000000 ]]; then
    echo "ERROR: $exe is only ${size} bytes (corrupt stub). Remove it and rebuild." >&2
    return 1
  fi
  echo "==> Windows OK: $(basename "$exe") ($(numfmt --to=iec "$size" 2>/dev/null || echo "${size} B"))"
}

build_win_on_host() {
  echo "==> Windows NSIS на хосте (macOS: native rcedit, без Wine/QEMU)…"
  (cd "$DESKTOP_ROOT" && npm run dist:win:only)
  verify_win_installer
}

build_win_in_docker() {
  echo "==> Windows NSIS в Docker (linux/amd64 + Wine)…"
  docker run --rm -i --platform linux/amd64 \
    --tmpfs /root/.cache:rw,exec,size=2G \
    -v "$REPO_ROOT:/repo" \
    -w /repo/desktop-client \
    electronuserland/builder:wine \
    bash -c 'set -euo pipefail
npx electron-builder --win nsis --x64 --publish never'
  if ! verify_win_installer; then
    echo "WARN: Docker+Wine Windows build failed or produced a stub installer." >&2
    echo "      On Apple Silicon Mac use host build (this script does that automatically)." >&2
    echo "      On CI use a native windows-2022 runner or linux/amd64 without QEMU." >&2
    return 1
  fi
}

if [[ "$DO_CHOWN" == true ]]; then
  fix_repo_ownership
fi

if [[ "$SKIP_PREPARE" != true ]]; then
  echo "==> voice-client: npm ci && npm run build"
  (cd "$REPO_ROOT/voice-client" && npm ci && npm run build)
  echo "==> desktop-client: npm install && npm run build && npm run prepare:ui"
  (cd "$DESKTOP_ROOT" && npm install && npm run build && npm run prepare:ui)
fi

echo "==> electron-builder (mac arm64 zip + linux) в electronuserland/builder:wine"
docker run --rm -i --platform linux/amd64 \
  --tmpfs /root/.cache:rw,exec,size=2G \
  -v "$REPO_ROOT:/repo" \
  -w /repo/desktop-client \
  electronuserland/builder:wine \
  bash -s <<'EOF'
set -e
DMG_JS="node_modules/dmg-builder/out/dmg.js"
if [[ -f "$DMG_JS" ]]; then
  sed -i 's|const dmgLicense_1 = require("./dmgLicense");|let dmgLicense_1; try { dmgLicense_1 = require("./dmgLicense"); } catch(e) { dmgLicense_1 = { addLicenseToDmg: async () => null }; }|' "$DMG_JS" 2>/dev/null || true
fi
npx electron-builder --mac zip --arm64 --publish never
npx electron-builder --linux AppImage deb --x64 --publish never
EOF

if [[ "$DO_CHOWN" == true ]]; then
  fix_repo_ownership
fi

# Wine+rcedit under QEMU (Docker Desktop on Apple Silicon) crashes with anon_mmap_fixed.
# electron-builder uses native app-builder rcedit on darwin — build Windows on the host.
if [[ "$(uname -s)" == "Darwin" ]]; then
  build_win_on_host
else
  build_win_in_docker
fi

echo "==> Готово. Артефакты: $DESKTOP_ROOT/release/"
