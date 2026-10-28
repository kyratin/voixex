# Voixex — server (🐳 Docker image)

> **This is the `server` branch: the backend, shipped as the Docker image [`kyratinkokko/voixex`](https://hub.docker.com/r/kyratinkokko/voixex).**
> The app for Windows, macOS, Linux and Android lives on the **[`client`](https://github.com/kyratin/voixex/tree/client)** branch.

One container runs everything a Voixex server needs:

- **API + WebSocket** (Fastify): accounts, channels, chat, attachments, presence, roles
- **Voice media** in its own worker thread: Opus mixer with jitter buffer, redundancy and loss concealment over **UDP**, **TCP** or **WebSocket**
- **LiveKit SFU** (built in) for WebRTC voice and screen sharing
- **SQLite** database and uploads in `/data`

---

## Branches

| Branch | What it is | Get it |
|--------|------------|--------|
| **`server`** (this one) | Backend source + `Dockerfile` | `docker pull kyratinkokko/voixex` |
| **[`client`](https://github.com/kyratin/voixex/tree/client)** | App for Windows · macOS · Linux · Android | [GitHub Releases](https://github.com/kyratin/voixex/releases) |

Older lines (`server-auth`, `server-livekit`) are kept as tags `archive/<name>`.

---

## Image tags

| Tag | Meaning |
|-----|---------|
| `latest` | Newest stable build |
| `0.6.2`, `0.5.0`, … | Fixed versions = `version` in [`backend/package.json`](backend/package.json). Pin one in production. |

Published images are **linux/amd64**.

---

## Run with Docker Compose

```bash
git clone -b server https://github.com/kyratin/voixex.git voixex-server
cd voixex-server
cp .env.example .env
# set TOKEN_SECRET, SUPERUSER_PASSWORD, PUBLIC_UDP_HOST (and LiveKit vars below)
docker compose up -d
```

[`docker-compose.yml`](docker-compose.yml) builds from `backend/`; to use the prebuilt image replace `build:` with `image: kyratinkokko/voixex:<tag>`.

### Or a single `docker run`

```bash
docker run -d --name voixex --restart unless-stopped \
  -p 18080:8080 -p 50000:50000/udp -p 50000:50000/tcp \
  -p 7880:7880 -p 7881:7881/tcp -p 7882:7882/udp \
  -e TOKEN_SECRET=<long-random> -e SUPERUSER_PASSWORD=<password> \
  -e PUBLIC_UDP_HOST=<public host or IP> \
  -e LIVEKIT_NODE_IP=<public IP> \
  -e DB_PATH=/data/voip.sqlite -v voixex-data:/data \
  kyratinkokko/voixex:latest
```

In the app: **Add server** → `your-host:18080` → server password → nick → protection level.
The **first** registration on an empty server sets the server password that everyone else then uses to join.

---

## Ports

| Port | Purpose |
|------|---------|
| `8080/tcp` (host `18080`) | HTTP API + WebSocket, media over WebSocket (`/v1/media/ws`) |
| `50000/udp` + `50000/tcp` | Voice media (UDP preferred, TCP fallback) |
| `7880/tcp` | LiveKit signalling |
| `7881/tcp` | WebRTC over TCP |
| `7882/udp` | WebRTC media |

---

## Configuration

All options with comments are in [`.env.example`](.env.example). The important ones:

| Variable | Description |
|----------|-------------|
| `TOKEN_SECRET` | **Required.** Long random secret for session tokens. |
| `SUPERUSER_PASSWORD` | **Required.** Root password: entered at login, it gives admin rights. |
| `PUBLIC_UDP_HOST` | Host or IP clients use for voice media. |
| `LIVEKIT_NODE_IP` | Public IP announced for WebRTC (otherwise STUN guesses, wrong behind NAT/LB). |
| `LIVEKIT_PUBLIC_URL` | What clients connect to for LiveKit. Behind HTTPS: proxy `/livekit` → `7880` and set `wss://your.domain/livekit`. |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Use an external SFU instead of the built-in one. `LIVEKIT_EMBEDDED=false` disables it. |
| `TLS_ENABLED`, `TLS_CERT_PATH`, `TLS_KEY_PATH` | Serve HTTPS/WSS directly from the container (or terminate TLS in a reverse proxy). |
| `DB_PATH` | SQLite file. **Set `/data/voip.sqlite` with `docker run`**: the image default `./data/voip.sqlite` lives inside the container and is lost when it is recreated (`docker-compose.yml` already sets it). |
| `UPLOAD_DIR` | Attachments, default `/data/uploads`. Keep `/data` on a volume. |

The LiveKit API secret is generated once into `/data/livekit-api-secret`.

---

## HTTPS and Kubernetes

The app shows the server as secure only over HTTPS, so production servers should sit behind TLS:

- **Reverse proxy / Ingress** (Traefik, nginx, Caddy): route the domain to `8080` and `/livekit` (prefix stripped) to `7880`; set `LIVEKIT_PUBLIC_URL=wss://<domain>/livekit`.
- UDP `50000`, `7882` and TCP `7881` can't go through an HTTP proxy — expose them directly (NodePort/hostPort or a LoadBalancer) and set `PUBLIC_UDP_HOST` / `LIVEKIT_NODE_IP` to that address.
- Run **one replica** with a persistent volume on `/data` (SQLite); use the `Recreate` update strategy.
- Back up `/data/voip.sqlite` before upgrades.

---

## Development

```bash
cd backend
npm install
npm run dev        # HTTP on 8080, voice on 50000
```

Requires **Node.js 22+**. The LiveKit SFU is not started in dev; point `LIVEKIT_URL` at one if you need WebRTC.

### Building and publishing the image

```bash
docker buildx build --platform linux/amd64 -t kyratinkokko/voixex:<version> -t kyratinkokko/voixex:latest --push backend
```

Always build for the server's architecture (`linux/amd64`): an image built on Apple Silicon without `--platform` is arm64 and won't start on amd64 nodes. [`scripts/build-push-backend.sh`](scripts/build-push-backend.sh) does the same (multi-arch by default).

---

## License

MIT — see [LICENSE](LICENSE).
