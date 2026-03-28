# Voixex — backend (`server` branch)

This branch contains **only the server**: REST API, WebSocket, UDP voice mixer, SQLite persistence, Docker image.

Client apps (Electron, Next UI, `voice-client`) live in the **`windows`** branch.

## Layout

| Path | Role |
|------|------|
| `backend/` | Node.js (Fastify) control plane + media UDP |
| `docker-compose.yml` | Local/production stack: **backend container only** |
| `scripts/build-push-backend.sh` | Build/push Docker image from `backend/` (run on a dev machine, not a tiny VPS) |

## Run locally

```bash
cp .env.example .env
# edit TOKEN_SECRET, SUPERUSER_PASSWORD, etc.

docker compose up --build
```

- HTTP + WebSocket: `http://localhost:18080`
- UDP media: `localhost:50010/udp`

## Deploy (VPS)

Build and push the image from your PC or CI, then on the host:

```bash
docker compose pull && docker compose up -d
```

See `scripts/build-push-backend.sh` for a registry push example.

## Environment (screen / WebSocket)

| Variable | Purpose |
|----------|---------|
| `SCREEN_LOG` | `1` — log `screen_chunk` drops and relay samples (debugging). |
| `WS_MAX_PAYLOAD_BYTES` | Max WebSocket frame size (large screen blobs). |
| `SCREEN_WS_MAX_BASE64_CHARS` | Max base64 length per `screen_chunk`. |
| `SCREEN_WS_MAX_PER_SEC` | Rate limit per client (messages/sec). |

Full list: `backend/src/config.ts` and `.env.example`.

## API (summary)

- `POST /v1/servers`, `POST /v1/join`, `GET/PATCH /v1/servers/:id/me`
- Rooms, messages, attachments, `GET /v1/ws?token=...` (includes `screen_chunk` / `set_screen_share` for desktop clients)

## Media (UDP)

Encrypted PCM16 frames, replay protection, per-client rate limits, room mixer (~20 ms).
