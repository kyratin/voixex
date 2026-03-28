#!/usr/bin/env bash
# Build the backend image locally (or in CI) and push to a registry.
# On the VPS run ONLY: docker compose pull && docker compose up -d
# Do not run `docker build` on a small VPS — it overloads CPU/RAM and can take the host down.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${TAG:-latest}"
# GitLab Container Registry for this project (enable Registry in GitLab project settings).
DEFAULT_IMAGE="registry.gitlab.com/superkokkon/voixex/voip-backend"
IMAGE="${IMAGE:-${DEFAULT_IMAGE}:${TAG}}"

echo "Building: $IMAGE"
docker build -t "$IMAGE" "$ROOT/backend"

echo "Pushing: $IMAGE"
docker push "$IMAGE"

echo
echo "On kyratin.ru (after SSH is up), in the directory with docker-compose.yml and .env:"
echo "  export VOIP_BACKEND_IMAGE=$IMAGE   # or put in .env"
echo "  docker compose pull"
echo "  docker compose up -d"
echo
echo "Login once from your PC if needed:"
echo "  docker login registry.gitlab.com"
