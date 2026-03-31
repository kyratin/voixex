#!/usr/bin/env bash
# Build the backend image locally (or in CI) and push to a registry.
# On the VPS run ONLY: docker compose pull && docker compose up -d
# Do not run `docker build` on a small VPS — it overloads CPU/RAM and can take the host down.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${TAG:-latest}"
# Docker Hub: https://hub.docker.com/r/kyratinkokko/voixex
DEFAULT_IMAGE="kyratinkokko/voixex"
IMAGE="${IMAGE:-${DEFAULT_IMAGE}:${TAG}}"

echo "Building: $IMAGE"
docker build -t "$IMAGE" "$ROOT/backend"

echo "Pushing: $IMAGE"
docker push "$IMAGE"

# Pin :latest to the same digest as the version tag (not when building only "latest").
if [[ "$TAG" != "latest" ]]; then
  LATEST_IMAGE="${DEFAULT_IMAGE}:latest"
  echo "Tagging and pushing: $LATEST_IMAGE (same as $TAG)"
  docker tag "$IMAGE" "$LATEST_IMAGE"
  docker push "$LATEST_IMAGE"
fi

echo
echo "Example (pin version):  TAG=0.1.9 $0"
echo "On the VPS, in the directory with docker-compose.yml and .env:"
echo "  export VOIP_BACKEND_IMAGE=$IMAGE   # or put in .env"
echo "  docker compose pull"
echo "  docker compose up -d"
echo
echo "Login once if needed:"
echo "  docker login"
