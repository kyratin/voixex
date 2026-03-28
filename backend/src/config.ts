export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 8080),
  udpHost: process.env.UDP_HOST ?? "0.0.0.0",
  udpPort: Number(process.env.UDP_PORT ?? 50000),
  publicUdpHost: process.env.PUBLIC_UDP_HOST ?? "localhost",
  tokenSecret: process.env.TOKEN_SECRET ?? "change-me-dev-secret",
  superuserPassword: process.env.SUPERUSER_PASSWORD ?? "change-me-superuser",
  dbPath: process.env.DB_PATH ?? "./data/voip.sqlite",
  mediaRateLimitPerSec: Number(process.env.MEDIA_RATE_LIMIT_PER_SEC ?? 6000),
  uploadDir: process.env.UPLOAD_DIR ?? "/data/uploads",
  uploadMaxMb: Number(process.env.UPLOAD_MAX_MB ?? 50),
  screenMaxFps: Number(process.env.SCREEN_MAX_FPS ?? 5),
  screenMaxChunkBytes: Number(process.env.SCREEN_MAX_CHUNK_BYTES ?? 1200),
  /** Max base64 length for one WS screen blob (≈6MB binary). */
  screenWsMaxBase64Chars: Number(process.env.SCREEN_WS_MAX_BASE64_CHARS ?? 8_000_000),
  /** Max screen_chunk WS messages per second per client (anti-abuse). */
  screenWsMaxPerSec: Number(process.env.SCREEN_WS_MAX_PER_SEC ?? 40),
  /** WebSocket max frame size for large screen blobs (bytes). */
  wsMaxPayloadBytes: Number(process.env.WS_MAX_PAYLOAD_BYTES ?? 12 * 1024 * 1024),
  /** Set `SCREEN_LOG=1` to log screen_chunk drops, relay stats (sampled), and set_screen_share. */
  screenLog: process.env.SCREEN_LOG === "1" || process.env.SCREEN_LOG === "true"
}
