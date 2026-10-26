#!/bin/bash
# Starts the embedded LiveKit SFU next to the Voixex backend, then the backend itself.
# The backend mints LiveKit tokens (LIVEKIT_API_KEY/SECRET) and hands clients LIVEKIT_URL.
#
#   LIVEKIT_EMBEDDED     true|false  default: true, unless LIVEKIT_URL points at an external SFU
#   LIVEKIT_PUBLIC_URL   URL clients use to reach LiveKit signalling
#                        default: ws://$PUBLIC_UDP_HOST:$LIVEKIT_PORT
#                        behind HTTPS, proxy /livekit -> :7880 and set wss://your.host/livekit
#   LIVEKIT_NODE_IP      public IP announced in WebRTC ICE candidates (default: discovered via STUN)
#   LIVEKIT_API_KEY      default: voixex
#   LIVEKIT_API_SECRET   default: generated once and kept in $DATA_DIR/livekit-api-secret
#   LIVEKIT_PORT / LIVEKIT_RTC_TCP_PORT / LIVEKIT_RTC_UDP_PORT   default 7880 / 7881 / 7882
set -euo pipefail

lower() { printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'; }

embedded="$(lower "${LIVEKIT_EMBEDDED:-}")"
if [[ -z "$embedded" ]]; then
  # An explicit LIVEKIT_URL means "use that SFU", so don't start a second one.
  [[ -n "${LIVEKIT_URL:-}" ]] && embedded=false || embedded=true
fi
case "$embedded" in
  0|false|no|off)
    exec "$@"
    ;;
esac

DATA_DIR="${DATA_DIR:-/data}"
LK_PORT="${LIVEKIT_PORT:-7880}"
LK_TCP="${LIVEKIT_RTC_TCP_PORT:-7881}"
LK_UDP="${LIVEKIT_RTC_UDP_PORT:-7882}"
LK_KEY="${LIVEKIT_API_KEY:-voixex}"

mkdir -p "$DATA_DIR"
if [[ -z "${LIVEKIT_API_SECRET:-}" ]]; then
  secret_file="$DATA_DIR/livekit-api-secret"
  if [[ ! -s "$secret_file" ]]; then
    umask 077
    node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))" > "$secret_file"
  fi
  LIVEKIT_API_SECRET="$(cat "$secret_file")"
fi

cfg="$(mktemp /tmp/livekit.XXXXXX.yaml)"
{
  echo "port: $LK_PORT"
  echo "rtc:"
  echo "  tcp_port: $LK_TCP"
  echo "  udp_port: $LK_UDP"
  if [[ -n "${LIVEKIT_NODE_IP:-}" ]]; then
    echo "  use_external_ip: false"
    echo "  node_ip: ${LIVEKIT_NODE_IP}"
  else
    echo "  use_external_ip: true"
  fi
  echo "keys:"
  echo "  ${LK_KEY}: ${LIVEKIT_API_SECRET}"
  echo "logging:"
  echo "  level: ${LIVEKIT_LOG_LEVEL:-info}"
} > "$cfg"
chmod 600 "$cfg"

export LIVEKIT_API_KEY="$LK_KEY"
export LIVEKIT_API_SECRET
export LIVEKIT_URL="${LIVEKIT_PUBLIC_URL:-ws://${PUBLIC_UDP_HOST:-localhost}:${LK_PORT}}"

# LiveKit also reads UDP_PORT, NODE_IP, REDIS_* ... from the environment, and those override the
# config file. The backend's own UDP_PORT (voice mixer, 50000) must not leak into the SFU,
# so it gets a clean environment and only the generated config.
env -i PATH="$PATH" HOME="${HOME:-/tmp}" livekit-server --config "$cfg" &
lk_pid=$!
"$@" &
app_pid=$!

stop() { kill -TERM "$lk_pid" "$app_pid" 2>/dev/null || true; }
trap stop TERM INT

# Either process dying takes the container down so the orchestrator restarts both together.
set +e
wait -n "$lk_pid" "$app_pid"
status=$?
stop
wait
exit "$status"
