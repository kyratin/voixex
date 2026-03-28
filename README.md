# VoIP MVP (Client + Server)

This repository now includes:

- `backend`: Control plane (REST + WS) and media plane (UDP mixer) with SQLite persistence.
- `primer_front`: Next.js client UI integrated with backend APIs and real-time WS events.
- `voice-client`: Desktop-side voice engine module (UDP encrypted media transport interface).
- `desktop-client`: Electron shell with IPC bridge to native voice service.
- `docker-compose.yml`: One-command local run for backend + frontend.

## Current Model

- Server-authoritative state for profile, room membership, mute/deafen/speaking.
- Nickname is persisted on backend per `serverId + clientId`.
- Persistent text chat history stored on backend with pagination.
- Voice quality telemetry is exposed in desktop UI (`ping/jitter p99 and p999`, packet loss).
- Desktop app exposes audio device selection (`input/output`) via Electron IPC.

## Run with Docker Compose

Create `.env` (or copy from `.env.example`) and set superuser password:

```bash
cp .env.example .env
# edit SUPERUSER_PASSWORD
```

```bash
docker compose up --build
```

Services:

- Frontend: `http://localhost:3000`
- Backend HTTP/WS: `http://localhost:18080`
- Backend UDP media: `localhost:50010/udp`

## Run Desktop Client (Phase 1)

```bash
cd voice-client && npm install && npm run build
cd ../desktop-client && npm install && npm run build && npm run start
```

Desktop client opens your UI in Electron and exposes `window.electronVoice` bridge for connect/join/mute/deafen actions.

## Build Binary (Desktop)

From `desktop-client`:

```bash
npm install
npm run build
npm run pack
```

For installer artifacts:

```bash
npm run dist
```

Expected outputs are created under `desktop-client/release/`:
- Linux: `AppImage`, `deb`
- Windows: NSIS installer (`Voixex-<version>-win-x64.exe`)

## Windows Build And Run

Preferred (native Windows host):

```powershell
cd <repo>\voice-client
npm install
npm run build

cd ..\desktop-client
npm install
npm run build
npm run dist:win
```

Artifact:
- `desktop-client/release/Voixex-<version>-win-x64.exe`

Optional (from WSL/Linux via Docker builder image with Wine — same as a native Windows build, but dependencies run inside the container):

```bash
# From repository root. Builds voice-client, installs primer_front deps (for prepare:ui / Next export), then desktop + NSIS.
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

Files created in the container are written to the mounted repo; they may be owned by `root` on the host — run `sudo chown -R "$USER" desktop-client/node_modules primer_front/node_modules voice-client/node_modules` if local `npm install` then fails with permission errors.

## Windows Troubleshooting

- If microphone/headphones list is empty, allow microphone access in Windows privacy settings and restart the app.
- If call quality is unstable, allow app traffic in Windows Firewall for both TCP/UDP.
- If no output is heard, set a default playback device in Windows Sound settings, then reopen app settings and reapply output device.
- If running UI from WSL path, prefer launching installed `.exe` directly on Windows host filesystem.

## Screen share (desktop)

- Screen capture is encoded as WebM (MediaRecorder) and sent over the **same WebSocket** as chat/roster (`screen_chunk` messages with base64 payloads). The server **retransmits** chunks to other members of the **same voice channel** (no separate streaming server process).
- The client must register sharing with `set_screen_share` **before** `MediaRecorder` starts emitting chunks; otherwise the server drops early chunks (`share_inactive_or_room_mismatch` in logs when `SCREEN_LOG=1`).
- Rebuild the embedded UI (`desktop-client`: `npm run prepare:ui`) after changing `primer_front` so the desktop bundle includes the latest client logic.

## Backend environment (screen / WebSocket)

See `.env.example`. Notable variables:

| Variable | Purpose |
|----------|---------|
| `SCREEN_LOG` | Set to `1` to log `screen_chunk` drops (with reason), relay samples, and `set_screen_share` (useful on VPS: `docker logs -f <container>`). |
| `WS_MAX_PAYLOAD_BYTES` | Max WebSocket frame size (default ~12MB) for large screen blobs. |
| `SCREEN_WS_MAX_BASE64_CHARS` | Max base64 length per `screen_chunk` message. |
| `SCREEN_WS_MAX_PER_SEC` | Rate limit per client (messages/sec). |

`docker-compose.yml` passes `SCREEN_LOG` from the host environment (`SCREEN_LOG=${SCREEN_LOG:-0}`).

## Production API URL

The desktop UI builds the API base as `http://<host>:<port>` (default port `18080`). Point **host** at your server IP or DNS name and ensure that TCP port reaches the backend (e.g. `http://203.0.113.10:18080`). HTTPS/WSS in front of the app requires a reverse proxy with WebSocket upgrade and large enough proxy buffers for screen frames; this repo does not ship that nginx config.

## Implemented API

- `POST /v1/servers` - create server with password
- `POST /v1/servers/:serverId/join` - password auth and issue `authToken` + `mediaToken` + persisted profile
- `GET /v1/servers/:serverId/me` - read persisted profile
- `PATCH /v1/servers/:serverId/me` - update persisted nickname
- `POST /v1/servers/:serverId/rooms` - create `voice` or `text` room
- `GET /v1/servers/:serverId/rooms` - list rooms
- `GET /v1/servers/:serverId/channels/:channelId/messages?limit=&cursor=` - chat history pagination
- `POST /v1/servers/:serverId/channels/:channelId/messages` - append chat message
- `GET /v1/ws?token=...` - WS events for rooms/roster/member/chat updates; also carries `screen_chunk` / `set_screen_share` for desktop screen share.

## Media Protocol (MVP)

- UDP packets use a fixed binary header with sequence and timestamp.
- Payload is encrypted with AEAD (`aes-256-gcm`) using key material derived from `mediaToken`.
- Replay protection: monotonically increasing `seq` checks.
- Simple anti-flood: packet rate limit per client per second.
- Room mixer: accepts PCM16 frames and broadcasts one mixed stream per room every 20ms.

## Validation Checklist

1. Create server in UI and copy generated server ID.
2. Join server with password from one or more clients (unique local `clientId`).
3. Confirm nickname persistence: reconnect with same `clientId` and verify same server profile name.
4. Open/create text channel, send message, reconnect, verify history is preserved.
5. Join voice room, toggle mute/deafen, verify roster and speaking indicators update from server events.
6. In desktop client settings, select input/output devices and apply.
7. In `Voice Connected` stats panel check packet loss and `ping/jitter` p99/p999 values.
8. Two desktop clients in the same voice channel: start screen share on one; the other should receive video (if not, enable `SCREEN_LOG=1` on the backend and inspect `screen_chunk` / `set_screen_share` lines in container logs).
