# Voixex — backend (`server` branch)

REST API, WebSocket signaling, UDP voice mixer, SQLite — **Fastify** + **better-sqlite3**.  
Desktop and web clients live on branches **`windows`**, **`linux`**, **`macos`** (and GitHub mirror).

## Layout

| Path | Description |
|------|-------------|
| [`backend/`](backend) | Server source, `Dockerfile`, npm package |
| [`scripts/build-push-backend.sh`](scripts/build-push-backend.sh) | Build and push Docker image (run on a dev machine or CI, not on a tiny VPS) |

## Quick start (development)

```bash
cd backend && npm install && npm run dev
```

Default HTTP port **8080** (set `PORT`). UDP voice default **50000**.

## Docker

From repository root (this branch):

```bash
cp .env.example .env
# edit TOKEN_SECRET, SUPERUSER_PASSWORD, PUBLIC_UDP_HOST for production
docker compose up --build -d
```

HTTP is exposed on **`18080`** → container `8080` by default (see `HTTP_PORT` in `.env`).

### HTTPS inside the container (optional)

Set in `.env`:

- `TLS_ENABLED=true` (alias: `HTTPS=true`)
- `TLS_CERT_PATH` — PEM full chain
- `TLS_KEY_PATH` — PEM private key

The server then listens with TLS on the same `PORT` (still `8080` in the container). Map the host port you need, e.g. `443:8080` or `18081:8080`. Mount certificate files into the container and point the paths at them — see comments in [`.env.example`](.env.example).

Prebuilt images: **`kyratinkokko/voixex`** on Docker Hub — pin a version tag for production.

### WebRTC / LiveKit (built in)

The image bundles a [LiveKit](https://livekit.io) SFU, so voice and screen share in **WebRTC (LiveKit)** mode work without extra services. `docker-entrypoint.sh` starts it next to the backend, generates the API secret once (kept in `/data/livekit-api-secret`) and passes the same key to the backend, which issues the client tokens. If either process exits the container stops, so the orchestrator restarts both.

Open these ports in addition to HTTP and `50000`:

| Port | Purpose |
|------|---------|
| `7880/tcp` | LiveKit signalling (ws/http) |
| `7881/tcp` | WebRTC over TCP (fallback) |
| `7882/udp` | WebRTC media |

Set these for a real deployment (see [`.env.example`](.env.example)):

- `LIVEKIT_NODE_IP` — public IP announced in ICE candidates. Without it LiveKit uses STUN, which reports the wrong address behind NAT or a load balancer.
- `LIVEKIT_PUBLIC_URL` — what clients connect to. Browsers and the desktop app on HTTPS need `wss://`, so put a reverse proxy in front: route `/livekit` to port `7880` (strip the prefix) and use `wss://your.domain/livekit`.

To use your own SFU set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`; the embedded one is then not started. `LIVEKIT_EMBEDDED=false` turns it off explicitly.

## Requirements

- **Node.js** 22+ (for local dev)
- **Docker** + Compose (for container deploy)

## License

MIT — see [LICENSE](LICENSE).
