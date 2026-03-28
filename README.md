# VoIP Server Branch

This branch contains the backend-only VoIP server package for VPS deployment.

## Includes

- `backend`: Fastify control plane + WebSocket events + UDP media mixer.
- `docker-compose.yml`: production-oriented compose that pulls a prebuilt image.
- `.env.example`: required runtime environment variables.

## Important: do not build the image on the VPS

Building on a small VPS (`docker build ./backend`) loads CPU/RAM heavily and can **freeze or crash the machine**. Always **build and push** the image from your PC or CI, then on the server run **`docker compose pull`** only.

1. On your machine (with Docker): `./scripts/build-push-backend.sh`  
   (requires `docker login registry.gitlab.com` once — enable **Container Registry** on the GitLab project).
2. On the VPS: only `docker compose pull` and `docker compose up -d` — **no** `docker build`.

## Quick Install on VPS

```bash
git clone <your-repo-url> voip-server
cd voip-server
git checkout server
cp .env.example .env
# edit .env values (minimum: TOKEN_SECRET, SUPERUSER_PASSWORD, PUBLIC_UDP_HOST)
# optional: VOIP_BACKEND_IMAGE=registry.gitlab.com/superkokkon/voixex/voip-backend:latest
docker compose pull
docker compose up -d
```

You only need `docker-compose.yml`, `.env`, and optionally this README — **not** a `docker build` context on the server.

Ports (default):

- HTTP/WS: `18080/tcp`
- UDP media: `50010/udp`

## Environment

- `VOIP_BACKEND_IMAGE`: container image tag to pull (default `registry.gitlab.com/superkokkon/voixex/voip-backend:latest`).
- `TOKEN_SECRET`: required signing secret for auth/media tokens.
- `SUPERUSER_PASSWORD`: required password to grant the `admin` role on join.
- `PUBLIC_UDP_HOST`: public VPS IP/domain clients should use for UDP.
- `BACKEND_HTTP_PORT`: external HTTP/WS port.
- `BACKEND_UDP_PORT`: external UDP media port.
- `MEDIA_RATE_LIMIT_PER_SEC`: UDP packets per client per second (default `6000`; keep high enough for screen-share relay).
- `UPLOAD_MAX_MB` / uploads path: chat attachments stored under `UPLOAD_DIR` inside the data volume (`/data/uploads` in compose).

## Superuser / Admin

- Client joins using normal server password.
- If client also sends `superuserPassword` equal to `SUPERUSER_PASSWORD`, backend grants built-in `admin` role.
- Only `admin` users can access server settings operations (channels/roles management).

## Build and Publish Your Own Image

From repository root (same as `./scripts/build-push-backend.sh`):

```bash
chmod +x ./scripts/build-push-backend.sh
./scripts/build-push-backend.sh
# or: IMAGE=your-registry.example/voip-backend:1.2.3 ./scripts/build-push-backend.sh
```

Then on the VPS, set in `.env`:

```env
VOIP_BACKEND_IMAGE=registry.gitlab.com/superkokkon/voixex/voip-backend:latest
```

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
