# Voixex

<p align="center">
  <img src="trace.svg" alt="Voixex logo" width="180" />
</p>

<p align="center">
  <strong>Voixex</strong> — voice and text channels with a Discord-like layout: <strong>Electron</strong> desktop app, <strong>Next.js</strong> web UI, and a <strong>Fastify + WebSocket + UDP mixer</strong> server.
</p>

<p align="center">
  <img src="voixex.png" alt="Voixex app preview" width="780" />
</p>

<p align="center">
  <em>Example: desktop client connected to a server.</em>
</p>

---

This branch is **`macos`** — the main client line. It contains `primer_front`, `desktop-client`, and `voice-client`.

| Path | Description |
|------|-------------|
| [`primer_front/`](primer_front) | Next.js UI; static export is copied into `desktop-client/ui` for Electron |
| [`desktop-client/`](desktop-client) | Electron shell, IPC, screen capture, installers |
| [`voice-client/`](voice-client) | UDP voice engine (`file:` dependency of the desktop app) |

**Desktop app version** — the `version` field in [`desktop-client/package.json`](desktop-client/package.json).

**Backend** (REST, WebSocket, UDP mixer, SQLite) lives on the **`server`** branch (or a fork that only tracks the API). In the app, connect to your API at `http://<host>:<port>` (often port **18080** in the connect panel).

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

Set the API URL (and server password if required) in the app.

---

## Web UI (optional)

Requires a running backend. [`NEXT_PUBLIC_API_BASE`](.env.example) is the API base URL **as seen by the browser** (not an internal Docker hostname if you open the UI from another machine).

```bash
cp .env.example .env
# adjust NEXT_PUBLIC_API_BASE if needed

docker compose up --build
```

Open **http://localhost:3000**. Electron uses the bundled build under `desktop-client/ui`, not this dev server.

---

## Building installers

From [`desktop-client/`](desktop-client):

| Command | Output |
|---------|--------|
| `npm run dist` | Current OS |
| `npm run dist:win` | Windows NSIS |
| `npm run dist:linux` | Linux AppImage / deb |
| `npm run dist:docker` | **Windows NSIS + macOS zip** via Docker (from Linux/WSL) |

Cross-build Windows + macOS from the repo root:

```bash
docker pull electronuserland/builder:wine
./desktop-client/scripts/docker-electron-build.sh
```

Artifacts go to `desktop-client/release/` (usually gitignored).

After changing [`primer_front/`](primer_front), refresh the embedded UI:

```bash
cd desktop-client && npm run prepare:ui
```

---

## Client branches

- **`macos`** — primary development branch for the client.
- **`windows`** — Windows-focused releases; merge from `macos` when you cut a release.
- **`linux`** — Linux client when present.

Server code is **not** in these branches; use **`server`**.

---

## Features (client)

- Voice over UDP with stats (loss, ping, jitter)
- Text channels and attachments
- Screen sharing over WebSocket (`screen_chunk`; server must relay)
- Device settings, OS noise suppression, noise gate, Opus uplink (when the server supports it)
- Per-participant voice levels in a voice channel (stored locally; server applies a weighted downlink mix)

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| Empty mic list | OS microphone permission; restart the app |
| No audio / dropouts | Firewall (TCP to API + UDP to media port); **`PUBLIC_UDP_HOST`** on the server |
| `npm install` permission errors after Docker builds | Run `docker-electron-build.sh` (it fixes ownership) or `sudo chown -R "$USER:$USER" desktop-client/node_modules` |
| Switching servers while in voice | Voice session ends; client reconnects to the selected server |

---

## Backend

Deploy and configure the server from the **`server`** branch (Docker image `kyratinkokko/voixex` on Docker Hub).

---

## Publishing to GitHub

Add a GitHub remote and push the branches you need (`macos`, `windows`, `server`, `linux`, …). Add a **LICENSE** and **SECURITY.md** if you open the repo publicly.
