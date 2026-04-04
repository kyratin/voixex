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

Prebuilt images: **`kyratinkokko/voixex`** on Docker Hub — pin a version tag for production.

## Requirements

- **Node.js** 22+ (for local dev)
- **Docker** + Compose (for container deploy)

## License

MIT — see [LICENSE](LICENSE).
