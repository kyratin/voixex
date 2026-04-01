#!/usr/bin/env bash
# Build Windows (.exe NSIS), macOS arm64 (.zip), and Linux (AppImage/deb)
# using the official builder image.
# Prereq: docker pull electronuserland/builder:wine
#
# From repo root:
#   ./desktop-client/scripts/docker-electron-build.sh
#   npm run dist:docker --prefix desktop-client
#
# Если после сборки в Docker папки принадлежат root и npm падает с EACCES — скрипт
# сам выставит владельца node_modules/release на вашего пользователя (через контейнер).
#
# В документации иногда пишут docker run … bash -c '…' — троеточие не команда; используйте
# этот скрипт или полные команды из README пакета.
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

# Восстановить права после docker run от root (иначе npm на хосте: EACCES).
fix_repo_ownership() {
  local uid gid
  uid="$(id -u)"
  gid="$(id -g)"
  echo "==> Выравниваем владельца repo-каталогов на uid=$uid (после сборок от root в Docker)…"
  docker run --rm --user 0:0 \
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

if [[ "$DO_CHOWN" == true ]]; then
  fix_repo_ownership
fi

if [[ "$SKIP_PREPARE" != true ]]; then
  echo "==> voice-client: npm ci && npm run build"
  (cd "$REPO_ROOT/voice-client" && npm ci && npm run build)
  echo "==> desktop-client: npm install && npm run build && npm run prepare:ui"
  (cd "$REPO_ROOT/desktop-client" && npm install && npm run build && npm run prepare:ui)
fi

echo "==> electron-builder (mac arm64 zip + linux + win nsis) в electronuserland/builder:wine"
docker run --rm -i \
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
npx electron-builder --win nsis --publish never
EOF

if [[ "$DO_CHOWN" == true ]]; then
  fix_repo_ownership
fi

echo "==> Готово. Артефакты: $REPO_ROOT/desktop-client/release/"
