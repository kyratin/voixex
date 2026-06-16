#!/usr/bin/env bash
# Deploy kyratinkokko/voixex:latest on VPS (run as root in /opt/voixex-server).
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/voixex-server}"
cd "$DEPLOY_DIR"

if [[ ! -f .env ]]; then
  TOKEN_SECRET="$(openssl rand -hex 32)"
  SUPERUSER_PASSWORD="$(openssl rand -base64 24 | tr -d '\n')"
  cat > .env <<EOF
PUBLIC_UDP_HOST=skopeo-ai.ru
TOKEN_SECRET=${TOKEN_SECRET}
SUPERUSER_PASSWORD=${SUPERUSER_PASSWORD}
EOF
  chmod 600 .env
  echo "Created .env (save SUPERUSER_PASSWORD from file if needed)"
fi

cat > docker-compose.yml <<'YAML'
services:
  voixex:
    image: kyratinkokko/voixex:latest
    pull_policy: always
    restart: unless-stopped
    ports:
      - "127.0.0.1:18080:8080"
      - "50000:50000/udp"
      - "50000:50000/tcp"
    env_file: .env
    environment:
      HOST: "0.0.0.0"
      PORT: "8080"
      UDP_HOST: "0.0.0.0"
      UDP_PORT: "50000"
      DB_PATH: /data/voip.sqlite
      UPLOAD_DIR: /data/uploads
      TLS_ENABLED: "false"
    volumes:
      - voixex-data:/data

volumes:
  voixex-data:
YAML

docker compose pull
docker compose up -d
docker compose ps

echo "--- health ---"
curl -fsS http://127.0.0.1:18080/health
echo

NGINX_CONF="/etc/nginx/sites-available/skopeo-main.conf"
if [[ -f "$NGINX_CONF" ]] && ! grep -q 'location ^~ /v1/' "$NGINX_CONF"; then
  python3 <<'PY'
from pathlib import Path
path = Path("/etc/nginx/sites-available/skopeo-main.conf")
text = path.read_text()
if "location ^~ /v1/" in text:
    print("nginx: voixex blocks already present")
    raise SystemExit(0)
needle = "    # Serve frontend pages/assets via Next.js\n    location / {"
if needle not in text:
    raise SystemExit("nginx: insert point not found — add /v1/ and /health proxy manually")
insert = """    # Voixex API + WebSocket
    location ^~ /v1/ {
        proxy_pass http://127.0.0.1:18080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
    location = /health {
        proxy_pass http://127.0.0.1:18080/health;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Serve frontend pages/assets via Next.js
    location / {"""
path.write_text(text.replace(needle, insert, 1))
print("nginx: voixex proxy blocks added")
PY
  nginx -t
  systemctl reload nginx
  echo "nginx reloaded"
fi

echo "Done. Test: curl -sS https://skopeo-ai.ru/health"
