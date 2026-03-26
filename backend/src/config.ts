export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 8080),
  udpHost: process.env.UDP_HOST ?? "0.0.0.0",
  udpPort: Number(process.env.UDP_PORT ?? 50000),
  publicUdpHost: process.env.PUBLIC_UDP_HOST ?? "localhost",
  tokenSecret: process.env.TOKEN_SECRET ?? "change-me-dev-secret",
  superuserPassword: process.env.SUPERUSER_PASSWORD ?? "change-me-superuser",
  dbPath: process.env.DB_PATH ?? "./data/voip.sqlite",
  mediaRateLimitPerSec: Number(process.env.MEDIA_RATE_LIMIT_PER_SEC ?? 100)
}
