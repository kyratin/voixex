# Voixex

<p align="center">
  <strong>Voixex</strong> — voice and text channels with a Discord-like layout: <strong>Electron</strong> desktop app, <strong>Next.js</strong> web UI, and a <strong>Fastify + WebSocket + UDP mixer</strong> server.
</p>

<p align="center">
  <img src="voixex.png" alt="Voixex app preview" width="780" />
</p>

<p align="center">
  <em>Example: desktop client connected to a server.</em>
</p>

<p align="center">
  <a href="https://github.com/kyratin/voixex"><strong>github.com/kyratin/voixex</strong></a> — source code, issues, contributions (MIT)
</p>

---

This branch is **`windows`** — the client line used for Windows-focused releases. It contains `primer_front`, `desktop-client`, and `voice-client`.

| Path | Description |
|------|-------------|
| [`primer_front/`](primer_front) | Next.js UI; static export is copied into `desktop-client/ui` for Electron |
| [`desktop-client/`](desktop-client) | Electron shell, IPC, screen capture, installers |
| [`voice-client/`](voice-client) | UDP voice engine (`file:` dependency of the desktop app) |

**Desktop app version** — the `version` field in [`desktop-client/package.json`](desktop-client/package.json).

**Backend** (REST, WebSocket, UDP mixer, SQLite) lives on the **`server`** branch. In the app, connect to your API at `http://<host>:<port>` (typically `18080`).

---

## Latest updates

- Client **`0.2.16`** builds published.
- Docker build script now generates **macOS arm64**, **Linux (AppImage/deb)**, and **Windows NSIS** installers.
- Presence lists are now stable and sorted alphabetically (no reordering when someone starts speaking).
- Voice path updates include IPC optimization and playback DSP tuning options.

---

## Requirements

- **Node.js** 20+ (22 recommended)
- **npm**
- A running **backend** (local or VPS) for full functionality

---

## Quick start (desktop, dev)

```bash
cd voice-client && npm install && npm run build
cd ../desktop-client && npm install && npm run build && npm start
```

Set API URL and server password (if needed) in the app.

---

## Web UI (optional)

Requires a running backend.

```bash
cp .env.example .env
# adjust NEXT_PUBLIC_API_BASE if needed
docker compose up --build
```

Open **http://localhost:3000**. Electron uses bundled files from `desktop-client/ui`.

---

## Building installers

From [`desktop-client/`](desktop-client):

| Command | Output |
|---------|--------|
| `npm run dist` | Current OS |
| `npm run dist:win` | Windows NSIS |
| `npm run dist:linux` | Linux AppImage / deb |
| `npm run dist:mac:zip` | macOS zip for current architecture |
| `npm run dist:docker` | **macOS arm64 zip + Linux + Windows NSIS** via Docker |

Cross-build from repo root:

```bash
docker pull electronuserland/builder:wine
./desktop-client/scripts/docker-electron-build.sh
```

Artifacts are written to `desktop-client/release/`.

---

## Features (client)

- Voice over UDP with stats (loss, ping, jitter)
- Text channels and attachments
- Screen sharing over WebSocket (`screen_chunk`; server relay required)
- Device settings and DSP controls
- Per-participant voice levels in a voice channel

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| Empty mic list | OS microphone permission; restart app |
| No audio / dropouts | Firewall (TCP API + UDP media); `PUBLIC_UDP_HOST` on server |
| Metallic/robotic voice through server | Update backend to image `kyratinkokko/voixex:0.1.13` or newer |
| `npm install` EACCES after Docker build | Re-run `docker-electron-build.sh` (it fixes ownership) |

---

## Backend

Deploy backend from the **`server`** branch (Docker image `kyratinkokko/voixex`).
