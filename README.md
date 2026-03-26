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
- Windows: `nsis` installer (`Kyratin VoIP-<version>-win-x64.exe`)

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
- `desktop-client/release/Kyratin VoIP-0.1.0-win-x64.exe`

Optional (from WSL/Linux via Docker builder image with wine):

```bash
docker run --rm \
  -v "$PWD":/project \
  -w /project/desktop-client \
  -v "$HOME/.cache/electron":/root/.cache/electron \
  -v "$HOME/.cache/electron-builder":/root/.cache/electron-builder \
  electronuserland/builder:wine \
  /bin/bash -lc "npm install && npm run build && npm run dist:win"
```

## Windows Troubleshooting

- If microphone/headphones list is empty, allow microphone access in Windows privacy settings and restart the app.
- If call quality is unstable, allow app traffic in Windows Firewall for both TCP/UDP.
- If no output is heard, set a default playback device in Windows Sound settings, then reopen app settings and reapply output device.
- If running UI from WSL path, prefer launching installed `.exe` directly on Windows host filesystem.

## Implemented API

- `POST /v1/servers` - create server with password
- `POST /v1/servers/:serverId/join` - password auth and issue `authToken` + `mediaToken` + persisted profile
- `GET /v1/servers/:serverId/me` - read persisted profile
- `PATCH /v1/servers/:serverId/me` - update persisted nickname
- `POST /v1/servers/:serverId/rooms` - create `voice` or `text` room
- `GET /v1/servers/:serverId/rooms` - list rooms
- `GET /v1/servers/:serverId/channels/:channelId/messages?limit=&cursor=` - chat history pagination
- `POST /v1/servers/:serverId/channels/:channelId/messages` - append chat message
- `GET /v1/ws?token=...` - WS events for rooms/roster/member/chat updates

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
