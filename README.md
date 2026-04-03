# Voixex — backend

<p align="center">
  <strong>Voixex backend</strong> — REST API, WebSocket signaling/chat, UDP voice mixer, SQLite storage, and attachment uploads.
</p>

<p align="center">
  <img src="voixex.png" alt="Voixex app preview" width="780" />
</p>

<p align="center">
  <em>Client UI preview; this branch contains server code only.</em>
</p>

---

This branch is **`server`** and contains **backend only**.

| Path | Description |
|------|-------------|
| [`backend/`](backend) | Node.js + Fastify API, WebSocket, UDP media, SQLite |
| [`docker-compose.yml`](docker-compose.yml) | Runs backend container and persists `/data` |
| [`scripts/build-push-backend.sh`](scripts/build-push-backend.sh) | Build and push backend image |

Client code (`desktop-client`, `primer_front`, `voice-client`) lives on `macos` / `windows` / `linux` branches.

## Latest updates

- Backend image **`kyratinkokko/voixex:0.1.13`** published.
- Fixed Opus decode path to preserve PCM16 bytes (removes metallic/electronic distortion in relayed voice).
- Per-listener peer volume remains active for both multi-user rooms and 1-on-1 calls.

---

## Quick start (Docker)

```bash
cp .env.example .env
# Set TOKEN_SECRET, SUPERUSER_PASSWORD, PUBLIC_UDP_HOST for VPS

docker compose up -d
```

Default endpoints:

| Service | Default |
|---------|---------|
| HTTP + WebSocket | `http://localhost:18080` (`HTTP_PORT` -> container 8080) |
| UDP voice | host `UDP_PORT` (default `50000`) |

Set **`PUBLIC_UDP_HOST`** to your public IP/DNS in production. Clients must reach this address for voice over UDP.

---

## Run from source

```bash
cd backend
npm ci
npm run build
npm start
```

For development:

```bash
cd backend
npm run dev
```

---

## Build and push image

Avoid heavy Docker builds on weak VPS hosts; build locally or in CI:

```bash
TAG=0.1.13 ./scripts/build-push-backend.sh
```

Then deploy:

```bash
docker compose pull
docker compose up -d
```

Override image at deploy time:

```bash
VOIP_BACKEND_IMAGE=kyratinkokko/voixex:0.1.13 docker compose up -d
```

---

## Environment variables

See full list in [`backend/src/config.ts`](backend/src/config.ts). Common ones:

- `PORT` — backend HTTP port inside container
- `UDP_PORT` — UDP media port
- `PUBLIC_UDP_HOST` — externally reachable host for client UDP traffic
- `TOKEN_SECRET` — JWT/session signing secret
- `SUPERUSER_PASSWORD` — superuser password
- `DB_PATH` — SQLite path (in Docker: `/data/voip.sqlite`)
- `UPLOAD_DIR` — attachment storage
- `SCREEN_LOG` — set `1` for screen relay debug logs

---

## Protocol overview

- REST endpoints for servers/channels/messages/profiles
- WebSocket at `GET /v1/ws?token=...` for chat, presence, and `screen_chunk`
- UDP binary media frames (PCM16 and Opus when supported)

Event `set_peer_volume` applies per-listener participant volume on the server mixer.

---

## Related branches

- `macos` — primary client branch
- `windows` — Windows client branch
- `linux` — Linux client branch

Docker image: [`kyratinkokko/voixex`](https://hub.docker.com/r/kyratinkokko/voixex)
