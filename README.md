# Voixex — desktop & web client (`windows` branch)

This branch contains **only client-side** code:

| Path | Role |
|------|------|
| `primer_front` | Next.js UI (exported static bundle for Electron `prepare:ui`) |
| `desktop-client` | Electron shell, IPC, screen capture, installers |
| `voice-client` | UDP voice engine (used as `file:` dependency from `desktop-client`) |

**Backend (REST, WebSocket, UDP mixer, SQLite)** lives in the **`server`** branch — build and deploy the Docker image from there, or use a published image. Point the app at your API: `http://<host>:<port>` (default port `18080` in the connect panel).

## Quick start (desktop)

```bash
cd voice-client && npm install && npm run build
cd ../desktop-client && npm install && npm run build && npm run start
```

## Optional: run Next dev server only

Requires a **running backend** elsewhere (`NEXT_PUBLIC_API_BASE`).

```bash
cp .env.example .env   # set NEXT_PUBLIC_API_BASE if needed
docker compose up --build
```

Then open `http://localhost:3000` (web); the Electron app usually loads the bundled `desktop-client/ui` build.

## Build installers

From `desktop-client`:

```bash
npm run dist        # current OS
npm run dist:win    # Windows NSIS (native Windows or see below)
npm run dist:linux  # Linux AppImage/deb
```

**Windows build from Linux/WSL** (Wine image):

```bash
docker run --rm \
  -e CI=false \
  -v "$PWD":/project \
  -w /project \
  -v "$HOME/.cache/electron":/root/.cache/electron \
  -v "$HOME/.cache/electron-builder":/root/.cache/electron-builder \
  electronuserland/builder:wine \
  /bin/bash -lc 'set -euo pipefail
    cd /project/voice-client && npm install && npm run build
    cd /project/primer_front && npm install
    cd /project/desktop-client && npm install && npm run build && npm run dist:win'
```

After changing `primer_front`, refresh the embedded UI:

```bash
cd desktop-client && npm run prepare:ui
```

## Screen share (desktop)

- Video goes over the **same WebSocket** as chat (`screen_chunk`). The **server** must relay; use the backend from the `server` branch / deployment.
- Call `set_screen_share` **before** `MediaRecorder` starts, or the server drops the first chunks.

## Troubleshooting

- Empty mic/device list: Windows privacy → microphone; restart the app.
- Poor voice quality: firewall allows app TCP/UDP.
- No audio output: set default playback device, then re-select device in app settings.

## Validation (client)

1. Connect to a running backend (host + port in the app).
2. Join a voice channel from two clients; mute/deafen and screen share as needed.
3. Check `Voice Connected` stats (loss, ping, jitter).
