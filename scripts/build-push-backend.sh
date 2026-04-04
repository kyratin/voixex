#!/usr/bin/env bash
# Build the backend image locally (or in CI) and push to a registry.
# On the VPS run ONLY: docker compose pull && docker compose up -d
# Do not run `docker build` on a small VPS — it overloads CPU/RAM and can take the host down.
#
# Default: multi-arch manifest (linux/amd64 + linux/arm64) via buildx so VPS amd64 and ARM hosts work.
# Override: PLATFORMS=linux/amd64 only  OR  BUILDX_MULTI=0 for legacy single-arch `docker build` (host CPU only).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${TAG:-latest}"
# Docker Hub: https://hub.docker.com/r/kyratinkokko/voixex
DEFAULT_IMAGE="kyratinkokko/voixex"
IMAGE="${IMAGE:-${DEFAULT_IMAGE}:${TAG}}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDX_MULTI="${BUILDX_MULTI:-1}"

if [[ "$BUILDX_MULTI" == "1" ]]; then
  echo "Building (buildx) platforms=$PLATFORMS: $IMAGE"
  if ! docker buildx version >/dev/null 2>&1; then
    echo "docker buildx not available; set BUILDX_MULTI=0 for plain docker build" >&2
    exit 1
  fi
  TAG_ARGS=( -t "$IMAGE" )
  if [[ "$TAG" != "latest" ]]; then
    TAG_ARGS+=( -t "${DEFAULT_IMAGE}:latest" )
  fi
  docker buildx build \
    --platform "$PLATFORMS" \
    "${TAG_ARGS[@]}" \
    --push \
    "$ROOT/backend"
  echo "Pushed multi-arch manifest: $IMAGE"
else
  echo "Building (single-arch, host platform only): $IMAGE"
  docker build -t "$IMAGE" "$ROOT/backend"
  echo "Pushing: $IMAGE"
  docker push "$IMAGE"
  if [[ "$TAG" != "latest" ]]; then
    LATEST_IMAGE="${DEFAULT_IMAGE}:latest"
    echo "Tagging and pushing: $LATEST_IMAGE (same as $TAG)"
    docker tag "$IMAGE" "$LATEST_IMAGE"
    docker push "$LATEST_IMAGE"
  fi
fi

echo
echo "Example (pin version):  TAG=0.1.9 $0"
echo "AMD64-only (faster on Apple Silicon):  PLATFORMS=linux/amd64 $0"
echo "On the VPS, in the directory with docker-compose.yml and .env:"
echo "  export VOIP_BACKEND_IMAGE=$IMAGE   # or put in .env"
echo "  docker compose pull"
echo "  docker compose up -d"
echo
echo "Login once if needed:"
echo "  docker login"
