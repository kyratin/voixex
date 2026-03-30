# Voixex — desktop & web client

Client-side repo (typical Git branches: **`macos`**, **`windows`**, **`linux`** — keep them in sync via merge from `macos` when releasing).

| Path | Role |
|------|------|
| `primer_front` | Next.js UI (static export → `desktop-client/ui` for Electron) |
| `desktop-client` | Electron shell, IPC, screen capture, installers |
| `voice-client` | UDP voice engine (`file:` dependency of `desktop-client`) |

**Desktop app version** is in `desktop-client/package.json` (`version` field).

**Backend** (REST, WebSocket, UDP mixer, SQLite) lives in the **`server`** branch — build/deploy the Docker image from there. Point the app at your API: `http://<host>:<port>` (default `18080` in the connect panel).

## Quick start (desktop)

```bash
cd voice-client && npm install && npm run build
cd ../desktop-client && npm install && npm run build && npm run start
```

## Optional: run Next dev server only

Requires a **running backend** (`NEXT_PUBLIC_API_BASE`).

```bash
cp .env.example .env   # set NEXT_PUBLIC_API_BASE if needed
docker compose up --build
```

Then open `http://localhost:3000` (web); Electron loads the bundled `desktop-client/ui` build.

## Build installers

From `desktop-client`:

```bash
npm run dist        # current OS
npm run dist:win    # Windows NSIS (native or Docker, see below)
npm run dist:linux  # Linux AppImage/deb
npm run dist:docker # Win NSIS + macOS zip via electronuserland/builder:wine (recommended from Linux/WSL)
```

**Docker (Windows + macOS zip)** — from repo root:

```bash
docker pull electronuserland/builder:wine
./desktop-client/scripts/docker-electron-build.sh
# or: cd desktop-client && npm run dist:docker
```

The script fixes host `node_modules` ownership when needed, runs `voice-client` + `prepare:ui`, then packages inside the Wine image. Installers land in `desktop-client/release/` (gitignored).

Legacy one-liner-style `docker run … electronuserland/builder:wine` is superseded by the script above.

After changing `primer_front`, refresh the embedded UI:

```bash
cd desktop-client && npm run prepare:ui
```

## Server switch while in voice

If you are **in a voice channel** and select **another server** in the sidebar, the app shows a **confirmation**: the voice session will end and the client will **fully reconnect** to the selected server.

## Screen share (desktop)

- Video uses the **same WebSocket** as chat (`screen_chunk`). The **server** must relay; use the backend from the `server` branch / deployment.
- Call `set_screen_share` **before** `MediaRecorder` starts, or the server drops the first chunks.

## Troubleshooting

- Empty mic/device list: OS privacy → microphone; restart the app.
- Poor voice quality: firewall allows app TCP/UDP.
- No audio output: set default playback device, then re-select in app settings.
- `npm install` EACCES under `desktop-client/node_modules`: often root-owned files after Docker builds — run `docker-electron-build.sh` (it runs `chown`) or `sudo chown -R "$USER:$USER" desktop-client/node_modules`.

## Validation (client)

1. Connect to a running backend (host + port in the app).
2. Join a voice channel from two clients; mute/deafen and screen share as needed.
3. Check voice stats (loss, ping, jitter).
